'use strict';

const http = require('http');
const crypto = require('crypto');

const { db } = require('./db');
const { HttpError, sendJson, readJson, clientIp, rub } = require('./util');
const auth = require('./auth');
const wallet = require('./wallet');
const ai = require('./ai');
const live = require('./live');
const admin = require('./admin');
const { ADMIN_HTML } = require('./admin-page');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

/* ---------- проверка конфигурации ---------- */

function checkConfig() {
  const production = process.env.NODE_ENV === 'production';
  const secret = String(process.env.AUTH_SECRET || '');
  const testCode = String(process.env.TEST_LOGIN_CODE || '').trim();

  if (production && testCode) {
    console.error('[api] ОПАСНО: TEST_LOGIN_CODE задан в production. Уберите переменную.');
    process.exit(1);
  }

  if (production && (secret.length < 32 || secret === 'dev-secret-change-me')) {
    console.error('[api] ОПАСНО: AUTH_SECRET должен быть не короче 32 символов.');
    process.exit(1);
  }

  if (testCode) {
    console.warn(`[api] ТЕСТОВЫЙ РЕЖИМ: вход по коду ${testCode}. Только для локальных тестов.`);
  }

  if (!production && secret.length < 32) {
    console.warn('[api] AUTH_SECRET короткий — допустимо только для локального теста.');
  }
}

checkConfig();

/* ---------- чат: защита от злоупотреблений ---------- */

const chatHits = new Map();

function allowChat(userId) {
  const at = Date.now();
  const list = (chatHits.get(userId) || []).filter((time) => at - time < 60 * 1000);

  if (list.length >= 40) return false;

  list.push(at);
  chatHits.set(userId, list);
  return true;
}

const routes = [];

function route(method, pattern, handler, options = {}) {
  const keys = [];
  const source = pattern.replace(/:[a-zA-Z]+/g, (match) => {
    keys.push(match.slice(1));
    return '([^/]+)';
  });

  routes.push({
    method,
    regexp: new RegExp(`^${source}$`),
    keys,
    handler,
    options,
  });
}

/* ---------- служебное ---------- */

route('GET', '/health', async () => ({
  ok: true,
  service: 'pomogator-api',
  uptime: Math.round(process.uptime()),
}));

/* ---------- вход ---------- */

route('POST', '/auth/request', async ({ body, req }) =>
  auth.requestCode(body.email, clientIp(req))
);

route('POST', '/auth/verify', async ({ body, req }) =>
  auth.verifyCode(body.email, body.code, {
    name: body.deviceName,
    fingerprint: body.fingerprint,
    ip: clientIp(req),
  })
);

route(
  'POST',
  '/auth/logout',
  async ({ session }) => {
    auth.revokeSession(session.tokenHash);
    return { ok: true };
  },
  { auth: true }
);

/* ---------- кабинет ---------- */

route(
  'GET',
  '/me',
  async ({ user, device }) => auth.profile(user, device),
  { auth: true }
);

route(
  'GET',
  '/me/transactions',
  async ({ user, query }) => ({
    ok: true,
    items: wallet.list(user.id, query.get('limit')),
  }),
  { auth: true }
);

route(
  'DELETE',
  '/devices/:id',
  async ({ user, params }) => auth.removeDevice(user.id, params.id),
  { auth: true }
);

/* ---------- облако: распознавание и ответы ---------- */

route(
  'GET',
  '/ai/quote',
  async ({ user, query }) => {
    const kind = query.get('kind') === 'meeting' ? 'meeting' : 'interview';
    const current = wallet.ensure(user.id);

    return {
      ok: true,
      kind,
      ratePerHourRub: wallet.ratePerHour(kind) / 100,
      remainingSeconds: wallet.remainingSeconds(user.id, kind),
      balanceRub: rub(current.balance_kopecks),
      trialSecondsLeft: current.trial_seconds_left,
    };
  },
  { auth: true }
);

route(
  'POST',
  '/session/start',
  async ({ user, device, body }) => {
    const kind = body.kind === 'meeting' ? 'meeting' : 'interview';

    if (wallet.remainingSeconds(user.id, kind) <= 0) {
      throw new HttpError(402, 'Недостаточно средств. Пополните баланс.');
    }

    const sessionId = live.start(user.id, device && device.id, kind);

    return {
      ok: true,
      sessionId,
      kind,
      ratePerHourRub: wallet.ratePerHour(kind) / 100,
      remainingSeconds: wallet.remainingSeconds(user.id, kind),
    };
  },
  { auth: true }
);

route(
  'POST',
  '/session/stop',
  async ({ user, body }) => live.stop(user.id, body.sessionId),
  { auth: true }
);

route(
  'POST',
  '/ai/transcribe',
  async ({ user, body }) => {
    const sessionId = String(body.sessionId || '');
    if (!sessionId) throw new HttpError(400, 'Нужна активная сессия');

    // Режим и ставку берём из сессии, а не из запроса клиента.
    const liveSession = live.touch(user.id, sessionId);
    const kind = liveSession.kind;

    const audio = Buffer.from(String(body.audio || ''), 'base64');
    if (!audio.length) throw new HttpError(400, 'Пустое аудио');

    const seconds = ai.wavSeconds(audio);
    if (!seconds) throw new HttpError(400, 'Некорректный WAV');

    if (wallet.remainingSeconds(user.id, kind) <= 0) {
      throw new HttpError(402, 'Недостаточно средств. Пополните баланс.');
    }

    const text = await ai.transcribe(audio, {
      language: body.language || 'ru',
      prompt: String(body.prompt || '').slice(0, 700),
    });
    const charge = wallet.chargeSeconds(user.id, kind, seconds, liveSession.device_id);

    return {
      ok: true,
      text,
      seconds: charge.charged,
      costKopecks: charge.costKopecks,
      balanceKopecks: charge.balanceKopecks,
      trialSecondsLeft: charge.trialSecondsLeft,
    };
  },
  { auth: true, bodyLimit: 4 * 1024 * 1024 }
);

route(
  'POST',
  '/ai/chat',
  async ({ user, body }) => {
    // Ответы входят в оплаченные минуты: без баланса и пробных не работают.
    if (wallet.remainingSeconds(user.id, 'interview') <= 0) {
      throw new HttpError(402, 'Недостаточно средств. Пополните баланс.');
    }

    if (!allowChat(user.id)) {
      throw new HttpError(429, 'Слишком много запросов. Подождите минуту.');
    }

    const messages = ai.cleanMessages(body.messages);
    if (!messages.length) throw new HttpError(400, 'Пустой запрос');

    const text = await ai.chat(messages, { maxTokens: body.maxTokens });
    return { ok: true, text };
  },
  { auth: true, bodyLimit: 4 * 1024 * 1024 }
);

/* ---------- админка ---------- */

route('GET', '/admin/api/users', async ({ query }) => admin.listUsers(query.get('q')), {
  admin: true,
});

route('POST', '/admin/api/credit', async ({ body }) => admin.credit(body), { admin: true });

route('POST', '/admin/api/status', async ({ body }) => admin.setStatus(body), { admin: true });

route('GET', '/admin/api/stats', async () => admin.stats(), { admin: true });

/* ---------- сервер ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
    const nonce = crypto.randomBytes(16).toString('base64');

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:`,
    });

    res.end(ADMIN_HTML.replace(/__NONCE__/g, nonce));
    return;
  }

  for (const item of routes) {
    if (item.method !== req.method) continue;

    const match = item.regexp.exec(path);
    if (!match) continue;

    try {
      if (item.options.admin) admin.requireAdmin(req);

      const ctx = {
        req,
        res,
        query: url.searchParams,
        params: {},
        body: {},
      };

      item.keys.forEach((key, index) => {
        ctx.params[key] = decodeURIComponent(match[index + 1]);
      });

      if (req.method !== 'GET' && req.method !== 'DELETE') {
        ctx.body = await readJson(req, item.options.bodyLimit || 64 * 1024);
      }

      if (item.options.auth) {
        const session = auth.requireSession(req);
        ctx.user = session.user;
        ctx.session = session.session;
        ctx.device = session.device;
      }

      const result = await item.handler(ctx);
      if (!res.writableEnded) sendJson(res, 200, result);
      return;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[api]', err);

      if (!res.writableEnded) {
        sendJson(res, status, {
          ok: false,
          error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message,
        });
      }
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: 'Не найдено' });
});

server.listen(PORT, HOST, () => {
  console.log(`[api] http://${HOST}:${PORT}`);
  console.log(`[api] админка: http://localhost:${PORT}/admin`);
  console.log(`[api] пользователей в базе: ${db.prepare('SELECT COUNT(*) AS n FROM users').get().n}`);
});

function shutdown() {
  console.log('[api] остановка');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
