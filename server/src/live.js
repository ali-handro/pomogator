'use strict';

const { db } = require('./db');
const { HttpError, now, id } = require('./util');

/**
 * Живые сессии: клиент открывает сессию с режимом, сервер запоминает ставку.
 * Клиент не может прислать другой kind в запросе на распознавание.
 */

const TTL_MS = 15 * 60 * 1000;

function start(userId, deviceId, kind) {
  const sessionId = id();

  db.prepare(
    `INSERT INTO live_sessions (id, user_id, device_id, kind, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, userId, deviceId || null, kind, now(), now());

  return sessionId;
}

/** Проверяет сессию и продлевает её. Возвращает строку из БД. */
function touch(userId, sessionId) {
  const row = db
    .prepare('SELECT * FROM live_sessions WHERE id = ? AND user_id = ?')
    .get(String(sessionId || ''), userId);

  if (!row) throw new HttpError(404, 'Сессия не найдена');
  if (row.ended_at) throw new HttpError(409, 'Сессия завершена');
  if (now() - row.last_seen_at > TTL_MS) throw new HttpError(410, 'Сессия истекла');

  db.prepare('UPDATE live_sessions SET last_seen_at = ? WHERE id = ?').run(now(), row.id);

  return row;
}

function stop(userId, sessionId) {
  db.prepare('UPDATE live_sessions SET ended_at = ? WHERE id = ? AND user_id = ?').run(
    now(),
    String(sessionId || ''),
    userId
  );

  return { ok: true };
}

module.exports = { start, touch, stop, TTL_MS };
