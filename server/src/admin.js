'use strict';

const { db } = require('./db');
const { HttpError, rub, normEmail } = require('./util');
const wallet = require('./wallet');

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '');

function requireAdmin(req) {
  if (!ADMIN_TOKEN) throw new HttpError(503, 'ADMIN_TOKEN не настроен на сервере');

  const given = String(req.headers['x-admin-token'] || '');
  if (given !== ADMIN_TOKEN) throw new HttpError(403, 'Нет доступа');
}

function listUsers(query) {
  const search = `%${String(query || '').trim().toLowerCase()}%`;

  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.status, u.created_at,
              w.balance_kopecks, w.trial_seconds_left
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE lower(u.email) LIKE ?
       ORDER BY u.created_at DESC
       LIMIT 100`
    )
    .all(search);

  return {
    ok: true,
    items: rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      balanceKopecks: row.balance_kopecks || 0,
      balanceRub: rub(row.balance_kopecks || 0),
      trialMinutesLeft: Math.ceil((row.trial_seconds_left || 0) / 60),
    })),
  };
}

function credit(body) {
  const email = normEmail(body && body.email);
  const amountRub = Number(body && body.amountRub);

  if (!email) throw new HttpError(400, 'Укажите email');
  if (!Number.isFinite(amountRub) || amountRub <= 0) {
    throw new HttpError(400, 'Сумма должна быть больше нуля');
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new HttpError(404, 'Пользователь не найден');

  const kopecks = Math.round(amountRub * 100);
  const result = wallet.credit(
    user.id,
    kopecks,
    'admin_adjust',
    String((body && body.comment) || 'Ручное зачисление')
  );

  return { ok: true, email, balanceRub: rub(result.balanceKopecks) };
}

function setStatus(body) {
  const email = normEmail(body && body.email);
  const status = body && body.status === 'blocked' ? 'blocked' : 'active';

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new HttpError(404, 'Пользователь не найден');

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
  if (status === 'blocked') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  return { ok: true, email, status };
}

function stats() {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const active = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").get().n;
  const balances = db.prepare('SELECT COALESCE(SUM(balance_kopecks), 0) AS s FROM wallets').get().s;
  const topups = db
    .prepare("SELECT COALESCE(SUM(amount_kopecks), 0) AS s FROM transactions WHERE amount_kopecks > 0")
    .get().s;

  return {
    ok: true,
    users,
    active,
    balancesRub: rub(balances),
    topupsRub: rub(topups),
  };
}

module.exports = { requireAdmin, listUsers, credit, setStatus, stats };
