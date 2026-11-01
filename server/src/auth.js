'use strict';

const crypto = require('crypto');

const { db } = require('./db');
const { HttpError, now, id, sha256, normEmail, isEmail, rub } = require('./util');
const mail = require('./mail');

const MAX_DEVICES = Number(process.env.MAX_DEVICES) || 2;
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const TRIAL_SECONDS = Number(process.env.TRIAL_SECONDS) || 1200;
const CODE_TTL_MS = 10 * 60 * 1000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';

const emailHits = new Map();
const ipHits = new Map();

function hit(map, key, windowMs, limit) {
  const at = now();
  const list = (map.get(key) || []).filter((time) => at - time < windowMs);
  if (list.length >= limit) return false;
  list.push(at);
  map.set(key, list);
  return true;
}

function codeHash(code) {
  return sha256(`${code}:${AUTH_SECRET}`);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    blocked: !!device.blocked,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
  };
}

async function requestCode(rawEmail, ip) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw new HttpError(400, 'Введите корректный email');

  if (!hit(emailHits, email, 60 * 1000, 1)) {
    throw new HttpError(429, 'Код уже отправлен. Подождите минуту.');
  }

  if (!hit(ipHits, ip || 'unknown', 60 * 60 * 1000, 10)) {
    throw new HttpError(429, 'Слишком много запросов. Попробуйте позже.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = now() + CODE_TTL_MS;

  db.prepare(
    `INSERT INTO auth_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       created_at = excluded.created_at`
  ).run(email, codeHash(code), expiresAt, now());

  await mail.sendCode(email, code);

  return { ok: true, message: 'Код отправлен на почту', ttlSeconds: CODE_TTL_MS / 1000 };
}

function upsertDevice(userId, info) {
  const fingerprint = String(info.fingerprint || '').trim().slice(0, 200);
  const name = String(info.name || 'Устройство').trim().slice(0, 80) || 'Устройство';

  if (fingerprint) {
    const existing = db
      .prepare('SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?')
      .get(userId, fingerprint);

    if (existing) {
      if (existing.blocked) throw new HttpError(403, 'Устройство заблокировано');
      db.prepare('UPDATE devices SET last_seen_at = ?, name = ? WHERE id = ?').run(
        now(),
        name,
        existing.id
      );
      return db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.id);
    }
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(userId).n;
  if (count >= MAX_DEVICES) {
    throw new HttpError(
      409,
      `Лимит устройств: ${MAX_DEVICES}. Отвяжите старое устройство в кабинете.`
    );
  }

  const deviceId = id();
  db.prepare(
    `INSERT INTO devices (id, user_id, name, fingerprint, created_at, last_seen_at, blocked)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(deviceId, userId, name, fingerprint, now(), now());

  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
}

function verifyCode(rawEmail, rawCode, info = {}) {
  const email = normEmail(rawEmail);
  const code = String(rawCode || '').trim();

  if (!isEmail(email)) throw new HttpError(400, 'Введите корректный email');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Код — 6 цифр');

  const row = db.prepare('SELECT * FROM auth_codes WHERE email = ?').get(email);
  if (!row) throw new HttpError(400, 'Код не найден. Запросите новый.');
  if (row.expires_at < now()) throw new HttpError(400, 'Код истёк. Запросите новый.');
  if (row.attempts >= 5) {
    throw new HttpError(429, 'Слишком много попыток. Запросите новый код.');
  }

  if (codeHash(code) !== row.code_hash) {
    db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    throw new HttpError(400, 'Неверный код');
  }

  db.prepare('DELETE FROM auth_codes WHERE email = ?').run(email);

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    const userId = id();
    db.prepare(
      'INSERT INTO users (id, email, email_verified, role, status, created_at) VALUES (?, ?, 1, ?, ?, ?)'
    ).run(userId, email, 'user', 'active', now());
    db.prepare(
      'INSERT INTO wallets (user_id, balance_kopecks, trial_seconds_left) VALUES (?, 0, ?)'
    ).run(userId, TRIAL_SECONDS);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  } else {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  }

  if (user.status !== 'active') throw new HttpError(403, 'Аккаунт заблокирован');

  const device = upsertDevice(user.id, info);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const expiresAt = now() + SESSION_DAYS * 86400000;

  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tokenHash, user.id, device.id, now(), expiresAt, now());

  return {
    ok: true,
    token,
    expiresAt,
    user: publicUser(user),
    device: publicDevice(device),
  };
}

function requireSession(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Нужен вход');

  const tokenHash = sha256(token);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.user_id, s.device_id, s.expires_at,
              u.id AS u_id, u.email, u.role, u.status, u.created_at AS u_created
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) throw new HttpError(401, 'Сессия не найдена');
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    throw new HttpError(401, 'Сессия истекла');
  }
  if (row.status !== 'active') throw new HttpError(403, 'Аккаунт заблокирован');

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), tokenHash);

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(row.device_id);
  if (device && device.blocked) throw new HttpError(403, 'Устройство заблокировано');

  return {
    session: {
      tokenHash: row.token_hash,
      userId: row.user_id,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
    },
    user: {
      id: row.u_id,
      email: row.email,
      role: row.role,
      status: row.status,
      created_at: row.u_created,
    },
    device,
  };
}

function profile(user, device) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id);
  const devices = db
    .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
    .all(user.id);

  return {
    ok: true,
    user: publicUser(user),
    wallet: {
      balanceKopecks: wallet.balance_kopecks,
      balanceRub: rub(wallet.balance_kopecks),
      trialSecondsLeft: wallet.trial_seconds_left,
      trialMinutesLeft: Math.ceil(wallet.trial_seconds_left / 60),
    },
    device: device ? publicDevice(device) : null,
    devices: devices.map(publicDevice),
  };
}

function removeDevice(userId, deviceId) {
  const device = db
    .prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?')
    .get(deviceId, userId);

  if (!device) throw new HttpError(404, 'Устройство не найдено');

  db.prepare('DELETE FROM sessions WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);

  return { ok: true };
}

function revokeSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

module.exports = {
  requestCode,
  verifyCode,
  requireSession,
  profile,
  removeDevice,
  revokeSession,
  publicUser,
  publicDevice,
};
