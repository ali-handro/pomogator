'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

/**
 * Аккаунт Помогатора: вход по коду на почту, токен сессии, профиль и баланс.
 *
 * Токен хранится в отдельном файле account.json и шифруется через safeStorage
 * (на Windows это DPAPI). В settings.json токен не попадает.
 */

const DEFAULT_API = 'https://api.pomogator.ru';
const REQUEST_TIMEOUT_MS = 15000;

function createAccount({ getSettings, onChanged }) {
  let state = {
    token: '',
    email: '',
    deviceId: '',
    expiresAt: 0,
    profile: null,
  };

  function accountFile() {
    return path.join(app.getPath('userData'), 'account.json');
  }

  function apiBase() {
    const settings = getSettings() || {};
    const base = process.env.POMOGATOR_API || settings.apiBase || DEFAULT_API;
    return String(base).replace(/\/+$/, '');
  }

  function fingerprint() {
    return crypto
      .createHash('sha256')
      .update(`${os.hostname()}|${os.userInfo().username}|pomogator-device`)
      .digest('hex')
      .slice(0, 40);
  }

  function deviceName() {
    return os.hostname() || 'Этот компьютер';
  }

  function encrypt(text) {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: true, value: safeStorage.encryptString(text).toString('base64') };
    }
    return { enc: false, value: Buffer.from(text, 'utf8').toString('base64') };
  }

  function decrypt(record) {
    if (!record || !record.value) return '';
    const buffer = Buffer.from(record.value, 'base64');

    if (!record.enc) return buffer.toString('utf8');

    try {
      return safeStorage.decryptString(buffer);
    } catch {
      return '';
    }
  }

  function load() {
    try {
      const raw = fs.readFileSync(accountFile(), 'utf8');
      const data = JSON.parse(raw);

      state.email = String(data.email || '');
      state.deviceId = String(data.deviceId || '');
      state.expiresAt = Number(data.expiresAt) || 0;
      state.token = decrypt(data.token);

      if (!state.token || (state.expiresAt && state.expiresAt < Date.now())) {
        state.token = '';
        state.profile = null;
      }
    } catch {
      state = { token: '', email: '', deviceId: '', expiresAt: 0, profile: null };
    }
  }

  function save() {
    try {
      const data = {
        email: state.email,
        deviceId: state.deviceId,
        expiresAt: state.expiresAt,
        token: state.token ? encrypt(state.token) : null,
      };

      fs.writeFileSync(accountFile(), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[account] не удалось сохранить:', err.message);
    }
  }

  function clear() {
    state = { token: '', email: '', deviceId: '', expiresAt: 0, profile: null };

    try {
      fs.rmSync(accountFile(), { force: true });
    } catch {
      /* файла уже нет */
    }
  }

  function status() {
    return {
      loggedIn: !!state.token,
      email: state.email,
      deviceName: deviceName(),
      expiresAt: state.expiresAt,
      apiBase: apiBase(),
      profile: state.profile,
    };
  }

  function notify() {
    if (onChanged) onChanged(status());
  }

  async function request(pathname, options = {}) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = `Bearer ${state.token}`;

    let response;
    try {
      response = await fetch(`${apiBase()}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Нет связи с сервером. Проверьте интернет.');
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 && state.token) {
        clear();
        notify();
      }
      throw new Error(data.error || `Ошибка сервера (${response.status})`);
    }

    return data;
  }

  async function requestCode(email) {
    return request('/auth/request', {
      method: 'POST',
      body: { email: String(email || '').trim() },
    });
  }

  async function verify(email, code) {
    const data = await request('/auth/verify', {
      method: 'POST',
      body: {
        email: String(email || '').trim(),
        code: String(code || '').trim(),
        deviceName: deviceName(),
        fingerprint: fingerprint(),
      },
    });

    state.token = data.token;
    state.email = data.user.email;
    state.deviceId = data.device.id;
    state.expiresAt = data.expiresAt;
    state.profile = null;
    save();

    await refresh();
    return status();
  }

  async function refresh() {
    if (!state.token) return status();

    const data = await request('/me');
    state.profile = data;
    state.email = data.user.email;
    save();
    notify();

    return status();
  }

  async function logout() {
    if (state.token) {
      try {
        await request('/auth/logout', { method: 'POST' });
      } catch {
        /* даже если сервер недоступен, выходим локально */
      }
    }

    clear();
    notify();
    return status();
  }

  async function removeDevice(id) {
    await request(`/devices/${encodeURIComponent(String(id || ''))}`, { method: 'DELETE' });
    await refresh();
    return status();
  }

  /* ---------- облако ---------- */

  function normalizeKind(kind) {
    return kind === 'meeting' ? 'meeting' : 'interview';
  }

  async function transcribe(wav, kind, language) {
    const audio = Buffer.from(wav).toString('base64');

    return request('/ai/transcribe', {
      method: 'POST',
      timeoutMs: 45000,
      body: {
        kind: normalizeKind(kind),
        audio,
        language: language || 'ru',
      },
    });
  }

  async function chat(messages, kind, maxTokens) {
    return request('/ai/chat', {
      method: 'POST',
      timeoutMs: 60000,
      body: {
        kind: normalizeKind(kind),
        messages,
        maxTokens: maxTokens || 400,
      },
    });
  }

  async function quote(kind) {
    return request(`/ai/quote?kind=${normalizeKind(kind)}`, { timeoutMs: 15000 });
  }

  return {
    load,
    status,
    requestCode,
    verify,
    refresh,
    logout,
    removeDevice,
    transcribe,
    chat,
    quote,
    deviceName,
  };
}

module.exports = { createAccount };
