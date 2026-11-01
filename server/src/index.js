'use strict';

const http = require('http');

const { db } = require('./db');
const { HttpError, sendJson, readJson, clientIp } = require('./util');
const auth = require('./auth');
const wallet = require('./wallet');
const admin = require('./admin');
const { ADMIN_HTML } = require('./admin-page');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
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
        ctx.body = await readJson(req);
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
