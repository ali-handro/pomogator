'use strict';

const $ = (id) => document.getElementById(id);

let email = '';
let busy = false;

function setStatus(text, kind) {
  const el = $('status');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind ? `status ${kind}` : 'status';
}

function setBusy(value) {
  busy = value;
  for (const id of ['sendCode', 'verify', 'back']) {
    const el = $(id);
    if (el) el.disabled = value;
  }
}

async function sendCode() {
  if (busy) return;

  const value = $('email').value.trim();
  if (!value) {
    setStatus('Введите почту', 'err');
    return;
  }

  setBusy(true);
  setStatus('Отправляю код…');

  try {
    const result = await window.api.accountRequestCode(value);

    if (!result || !result.ok) {
      setStatus((result && result.error) || 'Не удалось отправить код', 'err');
      return;
    }

    email = value;
    $('sentTo').textContent = email;
    $('stepEmail').hidden = true;
    $('stepCode').hidden = false;
    $('code').value = '';
    $('code').focus();
    setStatus('Код отправлен. Проверьте почту.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function verify() {
  if (busy) return;

  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    setStatus('Код — 6 цифр', 'err');
    return;
  }

  setBusy(true);
  setStatus('Проверяю код…');

  try {
    const result = await window.api.accountVerify(email, code);

    if (!result || !result.ok) {
      setStatus((result && result.error) || 'Не удалось войти', 'err');
      return;
    }

    setStatus('Готово. Окно закроется.', 'ok');
    setTimeout(() => window.close(), 600);
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    setBusy(false);
  }
}

function backToEmail() {
  $('stepCode').hidden = true;
  $('stepEmail').hidden = false;
  $('email').focus();
  setStatus('');
}

function boot() {
  if (window.api && window.api.accountStatus) {
    window.api
      .accountStatus()
      .then((state) => {
        if (state && state.deviceName) {
          $('deviceName').textContent = `Устройство: ${state.deviceName}`;
        }
      })
      .catch(() => {});
  }

  $('sendCode').addEventListener('click', sendCode);
  $('verify').addEventListener('click', verify);
  $('back').addEventListener('click', backToEmail);

  $('email').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendCode();
  });

  $('code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') verify();
  });

  $('email').focus();
}

window.addEventListener('DOMContentLoaded', boot);
