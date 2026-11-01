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

module.exports = { get, ensure, credit, debit, list };
