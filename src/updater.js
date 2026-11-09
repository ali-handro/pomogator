'use strict';

const { app, net, shell, Notification } = require('electron');
const appConfig = require('./config');

/**
 * Проверка обновлений по статическому JSON. Сервер не нужен: файл можно
 * положить на GitHub Pages или в релизы.
 *
 * Формат updatesUrl:
 *   { "version": "0.27.0", "url": "https://.../Pomogator-Setup-0.27.0.exe", "notes": "..." }
 */
function parts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((value) => Number.parseInt(value, 10) || 0);
}

function isNewer(remote, current) {
  const a = parts(remote);
  const b = parts(current);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }

  return false;
}

async function checkForUpdates() {
  const url = String(appConfig.updatesUrl || '').trim();
  if (!url) return { ok: true, skipped: true };

  const response = await net.fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  const version = String(data && data.version ? data.version : '').trim();
  if (!version) throw new Error('В файле обновлений нет поля version');

  if (!isNewer(version, app.getVersion())) return { ok: true, update: null };

  return {
    ok: true,
    update: {
      version,
      url: String(data.url || ''),
      notes: String(data.notes || ''),
    },
  };
}

async function checkAndNotify() {
  try {
    const result = await checkForUpdates();
    if (!result.update) return;

    const notification = new Notification({
      title: 'Помогатор',
      body: `Доступна версия ${result.update.version}. Нажмите, чтобы скачать.`,
    });

    notification.on('click', () => {
      if (result.update.url) shell.openExternal(result.update.url);
    });

    notification.show();
  } catch (err) {
    console.warn('[update] check failed:', err.message);
  }
}

module.exports = { checkForUpdates, checkAndNotify, isNewer };
