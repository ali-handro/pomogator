'use strict';

const hasApi = typeof window.api !== 'undefined';

const FALLBACK_PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare Workers AI',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    note: 'Бесплатно: 10 000 нейронов в день',
    needsAccount: true,
  },
};

let settings = {
  provider: 'cloudflare',
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  cloudflareAccount: '',
  keys: {},
  style: 'concise',
  language: 'ru',
  answerWords: 45,
  autoAnswer: true,
  silenceMs: 450,
  audioSource: 'mic',
  opacity: 0.94,
  clickThrough: true,
  startHidden: false,
  overlayDisplay: 0,
  overlayWidth: 980,
  overlayHeight: 232,
  hotkeys: { listen: 'Control+Space' },
  resume: '',
  job: '',
  contextPrompt: '',
  sttProvider: 'cloudflare',
  sttModel: '@cf/deepgram/nova-3',
  localSttModel: 'base',
};

let providers = FALLBACK_PROVIDERS;
let displays = [];
let saveTimer = null;
let toastTimer = null;
let lastHotkeyStatus = { failed: [] };

const $ = (id) => document.getElementById(id);

function providerInfo() {
  return (
    providers[settings.provider] || {
      label: '',
      models: [],
      defaultModel: '',
      keyUrl: '',
      note: '',
      noKey: false,
    }
  );
}

function renderProviders() {
  const select = $('provider');
  select.innerHTML = '';

  for (const [id, info] of Object.entries(providers)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = info.label;
    select.appendChild(option);
  }

  if (!providers[settings.provider]) {
    settings.provider = Object.keys(providers)[0] || 'cloudflare';
  }
  select.value = settings.provider;
}

function renderModels() {
  const info = providerInfo();
  const select = $('model');
  const models = info.models || [];

  select.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  if (!models.includes(settings.model)) {
    settings.model = info.defaultModel || models[0] || '';
  }
  select.value = settings.model;

  $('providerNote').textContent = info.note || '';

  const accountField = $('accountField');
  if (accountField) accountField.hidden = !info.needsAccount;
  const accountInput = $('cloudflareAccount');
  if (accountInput) {
    accountInput.value = settings.cloudflareAccount || '';
  }

  const link = $('getKey');
  if (info.noKey) {
    link.textContent = 'локальный запуск';
    link.style.visibility = 'hidden';
  } else {
    link.textContent = 'получить ключ →';
    link.style.visibility = 'visible';
  }
}

function renderKey() {
  const info = providerInfo();
  const input = $('apiKey');

  if (info.noKey) {
    input.value = '';
    input.disabled = true;
    input.placeholder = 'ключ не нужен';
    return;
  }

  input.disabled = false;
  input.placeholder = 'вставьте ключ';
  input.value = (settings.keys && settings.keys[settings.provider]) || '';
}

function rangeLabel(key) {
  const out = $(`${key}Value`);
  if (!out) return;
  const raw = Number(settings[key]);
  const value = Number.isFinite(raw) ? raw : 0;

  if (key === 'answerWords') out.textContent = `${value} слов`;
  else if (key === 'silenceMs') out.textContent = `${value} мс`;
  else if (key === 'opacity') out.textContent = `${Math.round(value * 100)}%`;
  else if (key === 'overlayWidth' || key === 'overlayHeight') out.textContent = `${value} px`;
  else out.textContent = String(value);
}

function fillSimpleFields() {
  document.querySelectorAll('[data-key]').forEach((input) => {
    const key = input.dataset.key;
    const value = settings[key];

    if (input.type === 'checkbox') {
      input.checked = value !== false;
    } else {
      input.value = value == null ? '' : value;
    }

    if (input.type === 'range') rangeLabel(key);
  });
}

function renderDisplays() {
  const select = $('overlayDisplay');
  if (!select) return;

  select.innerHTML = '';

  const items = displays.length ? displays : [{ index: 0, label: 'Основной экран' }];

  for (const display of items) {
    const option = document.createElement('option');
    option.value = String(display.index);
    option.textContent = display.label;
    select.appendChild(option);
  }

  const current = String(Number(settings.overlayDisplay) || 0);
  const known = items.some((display) => String(display.index) === current);
  select.value = known ? current : '0';
}

function formatAccelerator(accelerator) {
  const map = {
    Control: 'Ctrl',
    Super: 'Win',
    Return: 'Enter',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
  };
  return String(accelerator || '')
    .split('+')
    .filter(Boolean)
    .map((part) => map[part] || part)
    .join('+');
}

/* ---------- Горячие клавиши ---------- */

const HOTKEY_DEFAULTS = {
  toggle: 'Control+Shift+Space',
  interactive: 'Control+Shift+E',
  answer: 'Control+Shift+A',
  regenerate: 'Control+Shift+R',
  clear: 'Control+Shift+X',
  historyPrev: 'Control+Shift+Left',
  historyNext: 'Control+Shift+Right',
  historyLatest: 'Control+Shift+Down',
  capture: 'Alt+C',
  review: 'Alt+R',
  listen: 'Control+Space',
  settings: 'Control+Shift+S',
};

const HOTKEY_ITEMS = [
  { key: 'toggle', label: 'показать / скрыть', icon: '✕', title: 'Кнопка ✕ в шапке' },
  { key: 'interactive', label: 'режим кликов и перетаскивания', icon: '🖱', title: 'Курсор' },
  { key: 'answer', label: 'ответить сейчас', icon: '⏎', title: 'Ручной ввод' },
  { key: 'regenerate', label: 'перегенерировать', icon: '↻', title: 'Кнопка ↻ в шапке' },
  { key: 'clear', label: 'очистить', icon: '⌫', title: 'Кнопка ⌫ в шапке' },
  { key: 'historyPrev', label: 'прошлый ответ', icon: '‹', title: 'Кнопка ‹ в шапке' },
  { key: 'historyNext', label: 'следующий ответ', icon: '›', title: 'Кнопка › в шапке' },
  {
    key: 'historyLatest',
    label: 'к актуальному ответу',
    icon: '»',
    title: 'Кнопка » в шапке и справа от текста',
  },
  { key: 'capture', label: 'решить задачу со скриншота', icon: '📷', title: 'Кнопка 📷 в шапке' },
  { key: 'review', label: 'код-ревью по скриншоту', icon: '🔍', title: 'Кнопка 🔍 в шапке' },
  { key: 'listen', label: 'пауза / слушать', icon: '⏸', title: 'Кнопка ⏸ / ▶ в шапке' },
  { key: 'settings', label: 'настройки', icon: '⚙', title: 'Кнопка ⚙ в шапке' },
];

let capturingHotkey = null;

function hotkeyValue(key) {
  return (settings.hotkeys && settings.hotkeys[key]) || HOTKEY_DEFAULTS[key] || '';
}

function keyFromEvent(event) {
  const code = event.code || '';

  if (code === 'Space') return 'Space';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;

  const map = {
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Backquote: '`',
  };

  return map[code] || '';
}

function renderHotkeys() {
  const list = $('hotkeysList');
  if (!list) return;

  list.innerHTML = '';

  for (const item of HOTKEY_ITEMS) {
    const row = document.createElement('div');
    row.className = 'key-row';
    row.dataset.key = item.key;

    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = item.label;

    const field = document.createElement('button');
    field.type = 'button';
    field.className = 'hotkey-chip';
    field.dataset.key = item.key;
    field.textContent =
      capturingHotkey === item.key
        ? 'Нажмите комбинацию…'
        : formatAccelerator(hotkeyValue(item.key));
    if (capturingHotkey === item.key) field.classList.add('capturing');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'key-reset';
    reset.textContent = '↺';
    reset.title = `Сбросить на ${formatAccelerator(HOTKEY_DEFAULTS[item.key])}`;
    reset.addEventListener('click', () => {
      settings.hotkeys = { ...(settings.hotkeys || {}), [item.key]: HOTKEY_DEFAULTS[item.key] };
      endHotkeyCapture();
      scheduleSave();
    });

    const icon = document.createElement('span');
    icon.className = 'key-icon';
    icon.textContent = item.icon;
    icon.title = item.title;

    row.append(label, field, reset, icon);
    list.appendChild(row);

    field.addEventListener('click', () => beginHotkeyCapture(item.key, field));
    field.addEventListener('keydown', (event) => onHotkeyKeydown(event, item.key, field));
    field.addEventListener('blur', () => {
      if (capturingHotkey === item.key) endHotkeyCapture();
    });
  }

  applyHotkeyStatus();
}

function beginHotkeyCapture(key, field) {
  capturingHotkey = key;
  field.textContent = 'Нажмите комбинацию…';
  field.classList.add('capturing');
  field.focus();
}

function endHotkeyCapture() {
  capturingHotkey = null;
  renderHotkeys();
}

function onHotkeyKeydown(event, key, field) {
  if (capturingHotkey !== key) return;

  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    endHotkeyCapture();
    return;
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    settings.hotkeys = { ...(settings.hotkeys || {}), [key]: HOTKEY_DEFAULTS[key] };
    endHotkeyCapture();
    scheduleSave();
    return;
  }

  const part = keyFromEvent(event);
  if (!part) return;

  const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
  if (!hasModifier && !/^F\d+$/.test(part)) {
    field.textContent = 'Нужен Ctrl, Alt или Win';
    return;
  }

  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  parts.push(part);

  settings.hotkeys = { ...(settings.hotkeys || {}), [key]: parts.join('+') };
  endHotkeyCapture();
  scheduleSave();
}

function applyHotkeyStatus() {
  const failed = (lastHotkeyStatus && lastHotkeyStatus.failed) || [];

  document.querySelectorAll('#hotkeysList .key-row').forEach((row) => {
    const key = row.dataset.key;
    const accelerator = hotkeyValue(key);
    const busy = failed.some((item) => item.accelerator === accelerator);

    row.classList.toggle('busy', busy);
    row.title = busy ? 'Комбинация занята другой программой' : '';
  });
}

function renderHotkeyStatus(status) {
  lastHotkeyStatus = status || { failed: [] };
  applyHotkeyStatus();
}

/* ---------- тариф и лицензия ---------- */

function formatUntil(ms) {
  return ms ? new Date(ms).toLocaleDateString('ru-RU') : '';
}

function setLicenseStatus(text, kind) {
  const el = $('licenseStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind ? `hint ${kind}` : 'hint';
}

async function renderPlan() {
  if (!hasApi || !window.api.licenseStatus) return;

  let state;
  try {
    state = await window.api.licenseStatus();
  } catch {
    return;
  }
  if (!state) return;

  const name = $('planName');
  const note = $('planNote');
  const usage = $('planUsage');
  const buy = $('planBuy');
  if (!name || !note || !usage) return;

  name.className = 'plan-name';

  if (state.plan === 'free') {
    name.textContent = 'Бесплатно';
    note.textContent = 'Полная версия снимает дневные лимиты.';
  } else if (state.plan === 'trial') {
    name.textContent = 'Пробный период';
    name.classList.add('trial');
    note.textContent = `Осталось ${state.daysLeft} дн. — доступно всё без ограничений.`;
  } else {
    name.textContent = state.label;
    name.classList.add('paid');
    note.textContent = state.exp
      ? `Действует до ${formatUntil(state.exp)} · ${state.daysLeft} дн.`
      : 'Бессрочная лицензия';
  }

  if (state.paid) {
    usage.innerHTML = '<b>Без ограничений</b> — ответы, скриншоты и встречи.';
  } else {
    usage.innerHTML =
      `Ответы сегодня: <b>${state.remaining.answers}</b> из ${state.limits.answersPerDay}` +
      ` · Скриншоты: <b>${state.remaining.screenshots}</b> из ${state.limits.screenshotsPerDay}`;
  }

  const url = String(settings.purchaseUrl || '').trim();
  if (buy) {
    buy.hidden = !url;
    buy.onclick = () => window.api.openExternal(url);
  }
}

async function activateLicense() {
  if (!hasApi || !window.api.licenseActivate) return;

  const input = $('licenseKey');
  const key = input ? input.value.trim() : '';

  if (!key) {
    setLicenseStatus('Вставьте ключ активации', 'err');
    return;
  }

  try {
    const result = await window.api.licenseActivate(key);

    if (result && result.ok) {
      if (input) input.value = '';
      setLicenseStatus(`Готово: тариф «${result.state.label}»`, 'ok');
      await renderPlan();
    } else {
      setLicenseStatus((result && result.error) || 'Не удалось активировать ключ', 'err');
    }
  } catch (err) {
    setLicenseStatus(`Ошибка: ${err.message}`, 'err');
  }
}

function fill() {
  renderProviders();
  renderModels();
  renderKey();
  renderDisplays();
  renderSttModel();
  renderSttSource();
  fillSimpleFields();
  renderHotkeys();
  renderPlan();
}

function renderSttModel() {
  const select = $('sttModel');
  if (!select) return;
  const current = String(settings.sttModel || '');
  select.value = /^@cf\/deepgram\//.test(current)
    ? '@cf/deepgram/nova-3'
    : '@cf/openai/whisper-large-v3-turbo';
}

function renderSttSource() {
  const local = settings.sttProvider === 'local';
  const source = $('sttSource');
  if (source) source.value = local ? 'local' : 'cloudflare';

  const cloudBlock = $('sttCloudBlock');
  if (cloudBlock) cloudBlock.hidden = local;

  const localBlock = $('sttLocalBlock');
  if (localBlock) localBlock.hidden = !local;

  const localModel = $('localSttModel');
  if (localModel) localModel.value = settings.localSttModel === 'small' ? 'small' : 'base';

  if (local) refreshLocalStatus();
}

async function refreshLocalStatus() {
  const out = $('localSttStatusText');
  const btn = $('localSttDownloadBtn');
  if (!out || !btn || !hasApi) return;

  try {
    const status = await window.api.localSttStatus();
    const size = settings.localSttModel === 'small' ? 'small' : 'base';
    const model = (status.models || []).find((item) => item.id === size);
    const ready = status.engine && model && model.ready;

    if (ready) {
      out.className = 'test-result ok';
      out.textContent = `Готово: движок и модель ${size}`;
      btn.textContent = 'Перекачать';
    } else {
      out.className = 'test-result';
      out.textContent = status.engine
        ? `Движок скачан, нужна модель ${size}`
        : 'Движок не скачан';
      btn.textContent = 'Скачать движок и модель';
    }
    btn.disabled = false;
  } catch (err) {
    console.error('[localStt]', err);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!hasApi) return;
    try {
      settings = await window.api.saveSettings(settings);
      showToast();
    } catch (err) {
      console.error('[settings] save failed', err);
    }
  }, 300);
}

function showToast() {
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
}

function bind() {
  $('provider').addEventListener('change', () => {
    settings.provider = $('provider').value;
    settings.model = providerInfo().defaultModel || '';
    renderModels();
    renderKey();
    scheduleSave();
  });

  $('model').addEventListener('change', () => {
    settings.model = $('model').value;
    scheduleSave();
  });

  $('apiKey').addEventListener('input', () => {
    settings.keys = { ...(settings.keys || {}), [settings.provider]: $('apiKey').value.trim() };
    scheduleSave();
  });

  $('cloudflareAccount').addEventListener('input', () => {
    settings.cloudflareAccount = $('cloudflareAccount').value.trim();
    scheduleSave();
  });

  $('overlayDisplay').addEventListener('change', () => {
    settings.overlayDisplay = Number($('overlayDisplay').value) || 0;
    scheduleSave();
  });

  $('audioSource').addEventListener('change', () => {
    settings.audioSource = $('audioSource').value === 'system' ? 'system' : 'mic';
    scheduleSave();
  });

  $('sttModel').addEventListener('change', () => {
    settings.sttModel = $('sttModel').value;
    scheduleSave();
  });

  $('sttSource').addEventListener('change', () => {
    settings.sttProvider = $('sttSource').value === 'local' ? 'local' : 'cloudflare';
    renderSttSource();
    scheduleSave();
  });

  $('localSttModel').addEventListener('change', () => {
    settings.localSttModel = $('localSttModel').value === 'small' ? 'small' : 'base';
    refreshLocalStatus();
    scheduleSave();
  });

  $('localSttDownloadBtn').addEventListener('click', async () => {
    if (!hasApi) return;

    const btn = $('localSttDownloadBtn');
    const out = $('localSttStatusText');
    const wrap = $('localSttBarWrap');
    const bar = $('localSttBar');

    btn.disabled = true;
    out.className = 'test-result';
    out.textContent = 'Скачиваю…';
    wrap.hidden = false;
    bar.style.width = '0%';

    const size = settings.localSttModel === 'small' ? 'small' : 'base';

    try {
      const result = await window.api.localSttDownload(size);
      if (result && result.ok) {
        out.className = 'test-result ok';
        out.textContent = 'Готово — можно проверять';
      } else {
        out.className = 'test-result err';
        out.textContent = (result && result.error) || 'Не удалось скачать';
      }
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = err.message;
    } finally {
      wrap.hidden = true;
      btn.disabled = false;
      refreshLocalStatus();
    }
  });

  if (hasApi) {
    window.api.onLocalSttProgress((data) => {
      const wrap = $('localSttBarWrap');
      const bar = $('localSttBar');
      const out = $('localSttStatusText');
      if (!wrap || !bar || !out) return;

      if (data.stage === 'done') {
        wrap.hidden = true;
        return;
      }

      if (data.stage === 'unpack') {
        wrap.hidden = false;
        bar.style.width = '100%';
        out.textContent = 'Распаковываю движок…';
        return;
      }

      const label = data.stage === 'engine' ? 'Скачиваю движок' : 'Скачиваю модель';
      const pct = data.total ? Math.round((data.received / data.total) * 100) : 0;
      wrap.hidden = false;
      bar.style.width = `${pct}%`;
      out.textContent = data.total ? `${label}… ${pct}%` : `${label}…`;
    });
  }

  $('accountHelp').addEventListener('click', (event) => {
    event.preventDefault();
    if (hasApi) window.api.openExternal('https://dash.cloudflare.com/');
  });

  document.querySelectorAll('[data-key]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;

      if (input.type === 'checkbox') {
        settings[key] = input.checked;
      } else if (input.type === 'range') {
        settings[key] = Number(input.value);
        rangeLabel(key);
      } else {
        settings[key] = input.value;
      }

      scheduleSave();
    });
  });

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleKey').textContent = hidden ? '🙈' : '👁';
  });

  $('getKey').addEventListener('click', (event) => {
    event.preventDefault();
    const info = providerInfo();
    if (hasApi && info.keyUrl) window.api.openExternal(info.keyUrl);
  });

  $('testBtn').addEventListener('click', async () => {
    const btn = $('testBtn');
    const out = $('testResult');

    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    out.className = 'test-result';
    out.textContent = '';

    try {
      // Сохраняем введённое сразу, чтобы проверка видела свежие ключи.
      clearTimeout(saveTimer);
      if (hasApi) settings = await window.api.saveSettings(settings);

      const result = await window.api.testConnection();
      if (result && result.ok) {
        out.className = 'test-result ok';
        out.textContent = `Работает: «${result.text || 'ок'}»`;
      } else {
        out.className = 'test-result err';
        out.textContent = (result && result.error) || 'Не удалось подключиться';
      }
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Проверить подключение';
    }
  });

  $('trainerBtn').addEventListener('click', () => {
    if (hasApi) window.api.openTrainer();
  });

  $('meetingBtn').addEventListener('click', () => {
    if (hasApi) window.api.openMeeting();
  });

  $('quizBtn').addEventListener('click', () => {
    if (hasApi) window.api.openQuiz();
  });

  const licenseActivateBtn = $('licenseActivate');
  if (licenseActivateBtn) licenseActivateBtn.addEventListener('click', activateLicense);

  const licenseKeyInput = $('licenseKey');
  if (licenseKeyInput) {
    licenseKeyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') activateLicense();
    });
  }

  $('sttTestBtn').addEventListener('click', async () => {
    const btn = $('sttTestBtn');
    const out = $('sttTestResult');

    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    out.className = 'test-result';
    out.textContent = '';

    try {
      const result = await window.api.testStt();
      if (result && result.ok) {
        out.className = 'test-result ok';
        out.textContent = `Работает: ${result.label}, ${result.ms} мс`;
      } else {
        out.className = 'test-result err';
        out.textContent = (result && result.error) || 'Не удалось распознать';
      }
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Проверить распознавание';
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !capturingHotkey) window.close();
  });
}

async function boot() {
  if (hasApi) {
    try {
      settings = await window.api.getSettings();
      settings.keys = settings.keys || {};
      providers = await window.api.getProviders();
      displays = await window.api.getDisplays();

      const info = await window.api.appInfo();
      $('version').textContent = `v${info.version}`;

      window.api.onDisplaysChanged(async () => {
        displays = await window.api.getDisplays();
        renderDisplays();
      });

      window.api.onSettingsChanged((next) => {
        const active = document.activeElement;
        const editing = active && active.dataset && active.dataset.key;
        settings = next;
        settings.keys = settings.keys || {};
        renderHotkeys();
        if (!editing && !capturingHotkey) fill();
      });

      window.api.onHotkeysStatus((status) => renderHotkeyStatus(status));

      try {
        const status = await window.api.getHotkeysStatus();
        renderHotkeyStatus(status);
      } catch (err) {
        console.error('[settings] hotkeys status failed', err);
      }
    } catch (err) {
      console.error('[settings] load failed', err);
    }
  }

  fill();
  bind();
}

window.addEventListener('DOMContentLoaded', boot);
