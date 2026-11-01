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
let capturingHotkey = false;
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

function renderListenKeysRow() {
  const row = $('listenKeysRow');
  if (!row) return;

  const accelerator = (settings.hotkeys && settings.hotkeys.listen) || 'Control+Space';
  row.innerHTML = '';

  for (const part of formatAccelerator(accelerator).split('+')) {
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    row.appendChild(kbd);
  }

  const label = document.createElement('span');
  label.className = 'key-label';
  label.textContent = 'пауза / слушать';
  row.appendChild(label);

  const icon = document.createElement('span');
  icon.className = 'key-icon';
  icon.title = 'Кнопка ⏸ / ▶ в шапке';
  icon.textContent = '⏸';
  row.appendChild(icon);
}

function renderListenHotkey() {
  const input = $('listenHotkey');
  if (!input || capturingHotkey) return;

  const accelerator = (settings.hotkeys && settings.hotkeys.listen) || 'Control+Space';
  input.value = formatAccelerator(accelerator);
  input.classList.remove('capturing');
  renderListenKeysRow();
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

function endHotkeyCapture() {
  capturingHotkey = false;
  renderListenHotkey();
  renderHotkeyStatus(lastHotkeyStatus);
}

function beginHotkeyCapture() {
  capturingHotkey = true;
  const input = $('listenHotkey');
  input.value = 'Нажмите комбинацию…';
  input.classList.add('capturing');
  input.focus();
  $('listenHotkeyStatus').textContent = '';
}

function bindHotkeyField() {
  const input = $('listenHotkey');
  const status = $('listenHotkeyStatus');

  input.addEventListener('click', beginHotkeyCapture);

  input.addEventListener('keydown', (event) => {
    if (!capturingHotkey) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      endHotkeyCapture();
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      settings.hotkeys = { ...(settings.hotkeys || {}), listen: 'Control+Space' };
      endHotkeyCapture();
      scheduleSave();
      return;
    }

    const key = keyFromEvent(event);
    if (!key) return; // нажали только модификатор

    const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
    if (!hasModifier && !/^F\d+$/.test(key)) {
      status.textContent = 'Добавьте Ctrl, Alt или Win — иначе комбинация перехватит обычный ввод.';
      return;
    }

    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');
    parts.push(key);

    settings.hotkeys = { ...(settings.hotkeys || {}), listen: parts.join('+') };
    endHotkeyCapture();
    scheduleSave();
  });

  input.addEventListener('blur', () => {
    if (capturingHotkey) endHotkeyCapture();
  });

  $('listenHotkeyReset').addEventListener('click', () => {
    settings.hotkeys = { ...(settings.hotkeys || {}), listen: 'Control+Space' };
    endHotkeyCapture();
    scheduleSave();
  });
}

function renderHotkeyKbds(rowId, accelerator) {
  const row = $(rowId);
  if (!row || !accelerator) return;

  const label = row.querySelector('.key-label');
  row.querySelectorAll('kbd').forEach((kbd) => kbd.remove());

  for (const part of formatAccelerator(accelerator).split('+')) {
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    row.insertBefore(kbd, label);
  }
}

function renderHotkeyStatus(status) {
  const out = $('listenHotkeyStatus');
  if (!out) return;

  lastHotkeyStatus = status || { failed: [] };

  // Скриншот и код-ревью могут переехать на резервную комбинацию,
  // если основную заняла другая программа — показываем фактическую.
  renderHotkeyKbds('captureKeysRow', lastHotkeyStatus.capture);
  renderHotkeyKbds('reviewKeysRow', lastHotkeyStatus.review);
  const listen = (settings.hotkeys && settings.hotkeys.listen) || 'Control+Space';
  const failed = lastHotkeyStatus.failed || [];
  const busy = failed.find((item) => item.accelerator === listen);

  if (busy) {
    const fallback =
      listen !== 'Control+Shift+M' ? ' Пока работает резервная Ctrl+Shift+M.' : '';
    out.textContent = `Не удалось занять ${formatAccelerator(listen)} — система уже использует её.${fallback}`;
    out.classList.add('warn');
  } else {
    out.textContent =
      listen === 'Control+Space'
        ? 'Нажмите на поле и введите комбинацию. Ctrl+Space — по умолчанию.'
        : `Сейчас: ${formatAccelerator(listen)}. Нажмите на поле, чтобы сменить.`;
    out.classList.remove('warn');
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
  renderListenHotkey();
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

  bindHotkeyField();

  $('trainerBtn').addEventListener('click', () => {
    if (hasApi) window.api.openTrainer();
  });

  $('meetingBtn').addEventListener('click', () => {
    if (hasApi) window.api.openMeeting();
  });

  $('quizBtn').addEventListener('click', () => {
    if (hasApi) window.api.openQuiz();
  });

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
        if (!capturingHotkey) renderListenHotkey();
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
