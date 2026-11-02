'use strict';

const { db } = require('./db');
const { HttpError, now, id, rub } = require('./util');

function get(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}

function ensure(userId) {
  const wallet = get(userId);
  if (wallet) return wallet;
  db.prepare(
    'INSERT INTO wallets (user_id, balance_kopecks, trial_seconds_left) VALUES (?, 0, 0)'
  ).run(userId);
  return get(userId);
}

function addTransaction(userId, type, amountKopecks, comment, meta) {
  db.prepare(
    `INSERT INTO transactions (id, user_id, type, amount_kopecks, comment, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id(),
    userId,
    type,
    amountKopecks,
    comment || null,
    meta ? JSON.stringify(meta) : null,
    now()
  );
}

function credit(userId, amountKopecks, type, comment, meta) {
  const amount = Math.round(Number(amountKopecks) || 0);
  if (amount <= 0) throw new HttpError(400, 'Сумма должна быть больше нуля');

  ensure(userId);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE wallets SET balance_kopecks = balance_kopecks + ? WHERE user_id = ?').run(
      amount,
      userId
    );
    addTransaction(userId, type || 'topup', amount, comment, meta);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ok: true, balanceKopecks: get(userId).balance_kopecks };
}

function debit(userId, amountKopecks, type, comment, meta) {
  const amount = Math.round(Number(amountKopecks) || 0);
  if (amount <= 0) throw new HttpError(400, 'Сумма должна быть больше нуля');

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        'UPDATE wallets SET balance_kopecks = balance_kopecks - ? WHERE user_id = ? AND balance_kopecks >= ?'
      )
      .run(amount, userId, amount);

    if (!result.changes) {
      db.exec('ROLLBACK');
      throw new HttpError(402, 'Недостаточно средств');
    }

    addTransaction(userId, type || 'usage', -amount, comment, meta);
    db.exec('COMMIT');
  } catch (err) {
    if (!(err instanceof HttpError)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* уже откатили */
      }
    }
    throw err;
  }

  return { ok: true, balanceKopecks: get(userId).balance_kopecks };
}

function list(userId, limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));

  return db
    .prepare(
      `SELECT id, type, amount_kopecks, comment, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, safeLimit)
    .map((row) => ({
      id: row.id,
      type: row.type,
      amountKopecks: row.amount_kopecks,
      amountRub: rub(row.amount_kopecks),
      comment: row.comment,
      createdAt: row.created_at,
    }));
}

/* ---------- ставки и списание за минуты ---------- */

const RATES = {
  interview: 44900, // копеек в час
  meeting: 15000,
};

function ratePerHour(kind) {
  return RATES[kind === 'meeting' ? 'meeting' : 'interview'];
}

function costForSeconds(kind, seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  return Math.ceil((safe * ratePerHour(kind)) / 3600);
}

function remainingSeconds(userId, kind) {
  const wallet = ensure(userId);
  const paid = Math.floor((wallet.balance_kopecks * 3600) / ratePerHour(kind));
  return wallet.trial_seconds_left + paid;
}

/**
 * Списывает секунды: сначала пробные, потом деньги. Всё одной транзакцией,
 * чтобы баланс не ушёл в минус при параллельных запросах.
 */
function chargeSeconds(userId, kind, seconds, deviceId) {
  const wallet = ensure(userId);
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));

  if (!total) {
    return {
      ok: true,
      charged: 0,
      trialUsed: 0,
      costKopecks: 0,
      balanceKopecks: wallet.balance_kopecks,
      trialSecondsLeft: wallet.trial_seconds_left,
    };
  }

  const trialUsed = Math.min(wallet.trial_seconds_left, total);
  const paidSeconds = total - trialUsed;
  const cost = costForSeconds(kind, paidSeconds);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (trialUsed > 0) {
      db.prepare(
        'UPDATE wallets SET trial_seconds_left = trial_seconds_left - ? WHERE user_id = ?'
      ).run(trialUsed, userId);
    }

    if (cost > 0) {
      const result = db
        .prepare(
          'UPDATE wallets SET balance_kopecks = balance_kopecks - ? WHERE user_id = ? AND balance_kopecks >= ?'
        )
        .run(cost, userId, cost);

      if (!result.changes) {
        db.exec('ROLLBACK');
        throw new HttpError(402, 'Недостаточно средств');
      }
    }

    db.prepare(
      `INSERT INTO usage_events (id, user_id, device_id, kind, seconds, cost_kopecks, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id(), userId, deviceId || null, kind, total, cost, null, now());

    db.exec('COMMIT');
  } catch (err) {
    if (!(err instanceof HttpError)) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* уже откатили */
      }
    }
    throw err;
  }

  const after = get(userId);

  return {
    ok: true,
    charged: total,
    trialUsed,
    costKopecks: cost,
    balanceKopecks: after.balance_kopecks,
    trialSecondsLeft: after.trial_seconds_left,
  };
}

module.exports = {
  get,
  ensure,
  credit,
  debit,
  list,
  RATES,
  ratePerHour,
  costForSeconds,
  remainingSeconds,
  chargeSeconds,
};
