'use strict';

const hasApi = typeof window.api !== 'undefined';

let settings = {
  provider: 'opencode',
  model: 'glm-5.3-flash',
  cloudflareAccount: '',
  ai: {
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    accountId: '',
    model: 'glm-5.3-flash',
  },
  stt: {
    mode: 'api',
    format: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run',
    accountId: '',
    model: '@cf/openai/whisper-large-v3-turbo',
    language: 'ru',
  },
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
  overlayFontScale: 1,
  hotkeys: { listen: 'Control+Space' },
  resume: '',
  job: '',
  contextPrompt: '',
  terms: '',
  localSttModel: 'base',
  localSttGpu: false,
};

let displays = [];
let saveTimer = null;
let toastTimer = null;
let lastHotkeyStatus = { failed: [] };

let appConfig = { donateUrl: '', supportEmail: 'softpuff@ya.ru', helpUrl: '' };
let autoUpdateSupported = false;
let autoUpdateReady = false;
let availableUpdate = null;

const LOCAL_MODEL_IDS = ['base', 'small', 'medium', 'large'];

function localModelId(value) {
  return LOCAL_MODEL_IDS.includes(value) ? value : 'base';
}

const $ = (id) => document.getElementById(id);

const AI_MODEL_PRESETS = [
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
  'qwen3.8-flash',
  'mimo-v2.6-flash',
  'kimi-k3',
];

const STT_MODEL_PRESETS = {
  cloudflare: ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper', '@cf/deepgram/nova-3'],
  openai: [
    'whisper-1',
    'whisper-large-v3',
    'whisper-large-v3-turbo',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'voxtral-mini-latest',
  ],
};

let aiModelsCache = [];
let sttModelsCache = [];

const SETUP_PROVIDERS = [
  {
    id: 'opencode',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    models: ['glm-5.3-flash', 'deepseek-v4.1-flash', 'qwen3.8-flash', 'kimi-k3'],
    key: true,
    account: false,
    stt: 'none',
    note: 'Ключ: opencode.ai/console',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    models: [
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/openai/gpt-oss-120b',
      '@cf/qwen/qwen3.8-27b',
    ],
    key: true,
    account: true,
    stt: 'cloudflare',
    note: 'Ключ и Account ID: dash.cloudflare.com',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
    key: true,
    account: false,
    stt: 'groq',
    note: 'Ключ: console.groq.com/keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    key: true,
    account: false,
    stt: 'none',
    note: 'Ключ: platform.deepseek.com',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma3:4b'],
    key: false,
    account: false,
    stt: 'none',
    note: 'Локально, без ключа. Модель должна быть скачана в Ollama.',
  },
];

let setupProvider = SETUP_PROVIDERS[0];
let setupBusy = false;

function fillModelSelect(select, current, list) {
  if (!select) return;

  const values = [...new Set([current, ...(list || [])].filter(Boolean))];
  select.innerHTML = '';

  for (const id of values) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    select.appendChild(option);
  }

  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Другая модель…';
  select.appendChild(custom);

  const hasCurrent = current && values.includes(current);
  select.value = hasCurrent ? current : '__custom__';

  syncSelect(select);
}

function syncModelInput(select, input) {
  if (!select || !input) return;
  input.hidden = select.value !== '__custom__';
}

function renderAi() {
  const ai = settings.ai || {};

  if ($('aiBaseUrl')) $('aiBaseUrl').value = ai.baseUrl || '';
  if ($('aiKey')) $('aiKey').value = (settings.keys && settings.keys.ai) || '';
  if ($('aiAccountId')) $('aiAccountId').value = ai.accountId || '';

  fillModelSelect(
    $('aiModelSelect'),
    ai.model,
    aiModelsCache.length ? aiModelsCache : AI_MODEL_PRESETS
  );
  syncModelInput($('aiModelSelect'), $('aiModel'));
  if ($('aiModel')) $('aiModel').value = ai.model || '';
}

function rangeLabel(key) {
  const out = $(`${key}Value`);
  if (!out) return;
  const raw = Number(settings[key]);
  const value = Number.isFinite(raw) ? raw : 0;

  if (key === 'answerWords') out.textContent = `${value} слов`;
  else if (key === 'silenceMs') out.textContent = `${value} мс`;
  else if (key === 'opacity') out.textContent = `${Math.round(value * 100)}%`;
  else if (key === 'overlayFontScale') out.textContent = `${Math.round(value * 100)}%`;
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
    row.dataset.label = item.label;

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

function activeFallback(key) {
  const status = lastHotkeyStatus || {};

  if (key === 'review' && status.review && status.review !== hotkeyValue('review')) {
    return status.review;
  }

  if (key === 'capture' && status.capture && status.capture !== hotkeyValue('capture')) {
    return status.capture;
  }

  return '';
}

function applyHotkeyStatus() {
  const failed = (lastHotkeyStatus && lastHotkeyStatus.failed) || [];

  document.querySelectorAll('#hotkeysList .key-row').forEach((row) => {
    const key = row.dataset.key;
    const accelerator = hotkeyValue(key);
    const busy = failed.some((item) => item.accelerator === accelerator);
    const fallback = busy ? activeFallback(key) : '';

    row.classList.toggle('busy', busy);

    const label = row.querySelector('.key-label');
    if (label) {
      const base = row.dataset.label || label.textContent;
      label.textContent = fallback ? `${base} → ${formatAccelerator(fallback)}` : base;
    }

    row.title = busy
      ? fallback
        ? `Комбинация занята. Работает резервная: ${formatAccelerator(fallback)}`
        : 'Комбинация занята другой программой. Назначьте другую.'
      : '';
  });
}

function renderHotkeyStatus(status) {
  lastHotkeyStatus = status || { failed: [] };
  applyHotkeyStatus();
}

/* ---------- быстрая настройка ---------- */

function renderSetupProviders() {
  const box = $('setupProviders');
  if (!box) return;

  box.innerHTML = '';

  for (const preset of SETUP_PROVIDERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'amount';
    button.textContent = preset.name;
    if (preset.id === setupProvider.id) button.classList.add('active');
    button.addEventListener('click', () => applySetupProvider(preset));
    box.appendChild(button);
  }
}

function setupModelValue() {
  const select = $('setupModel');
  if (select && select.value === '__custom__') return $('setupModelInput').value.trim();
  return select ? select.value : '';
}

function setSetupModel(value) {
  const select = $('setupModel');
  const input = $('setupModelInput');
  if (!select || !input) return;

  select.innerHTML = '';
  const values = setupProvider.models || [];

  for (const model of values) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = values.length ? 'Другая модель…' : 'Ввести модель';
  select.appendChild(custom);

  const known = values.includes(value);
  select.value = known ? value : '__custom__';
  input.hidden = known;
  input.value = known ? '' : value || '';
  if (window.syncSelect) window.syncSelect(select);
  if (!known) input.focus();
}

function applySetupProvider(preset) {
  setupProvider = preset;

  renderSetupProviders();

  const accountRow = $('setupAccountRow');
  if (accountRow) accountRow.hidden = !preset.account;

  const keyRow = $('setupKeyRow');
  if (keyRow) keyRow.hidden = !preset.key;

  const sttRow = $('setupSttRow');
  if (sttRow) sttRow.hidden = !preset.stt || preset.stt === 'none';

  const sttCheckbox = $('setupStt');
  if (sttCheckbox) sttCheckbox.checked = true;

  const sttLabel = sttRow && sttRow.querySelector('span');
  if (sttLabel && preset.stt !== 'none') {
    sttLabel.textContent =
      preset.stt === 'cloudflare'
        ? 'Настроить распознавание через Cloudflare этим же ключом'
        : 'Настроить распознавание через Groq этим же ключом';
  }

  // Подставляем текущие значения, если они относятся к этому провайдеру.
  const currentAi = settings.ai || {};
  const same = currentAi.baseUrl === preset.baseUrl;

  if ($('setupKey')) $('setupKey').value = same ? (settings.keys && settings.keys.ai) || '' : '';
  if ($('setupAccount')) $('setupAccount').value = same ? currentAi.accountId || '' : '';

  const model = same ? currentAi.model || '' : preset.models[0] || '';
  setSetupModel(model);

  if ($('setupHint')) $('setupHint').textContent = preset.note || '';
}

function openSetup() {
  const modal = $('setupModal');
  if (!modal) return;

  const currentBase = String((settings.ai && settings.ai.baseUrl) || '');
  const matched = SETUP_PROVIDERS.find((preset) => preset.baseUrl === currentBase);

  applySetupProvider(matched || SETUP_PROVIDERS[0]);
  modal.hidden = false;

  setTimeout(() => {
    if ($('setupKey') && !$('setupKeyRow').hidden) $('setupKey').focus();
  }, 60);
}

function closeSetup() {
  if ($('setupModal')) $('setupModal').hidden = true;
}

async function applySetup() {
  if (setupBusy) return;

  const hint = $('setupHint');
  const button = $('setupApply');
  const key = ($('setupKey') ? $('setupKey').value : '').trim();
  const accountId = ($('setupAccount') ? $('setupAccount').value : '').trim();
  const model = setupModelValue();

  const fail = (message) => {
    if (hint) hint.textContent = message;
  };

  if (setupProvider.account && !accountId) return fail('Укажите Account ID.');
  if (setupProvider.key && !key) return fail('Вставьте API-ключ.');
  if (!model) return fail('Выберите или введите модель.');

  setupBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Проверяю…';
  }
  if (hint) hint.textContent = 'Сохраняю и проверяю подключение…';

  try {
    const ai = {
      baseUrl: setupProvider.baseUrl,
      accountId: setupProvider.account ? accountId : '',
      model,
    };

    const keys = { ...(settings.keys || {}), ai: key };

    const patch = { ai, keys };

    const wantStt = !$('setupSttRow').hidden && $('setupStt').checked;

    if (wantStt && setupProvider.stt === 'cloudflare') {
      patch.stt = {
        mode: 'api',
        format: 'cloudflare',
        baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run',
        accountId,
        model: '@cf/openai/whisper-large-v3-turbo',
        language: 'ru',
      };
      keys.stt = key;
    } else if (wantStt && setupProvider.stt === 'groq') {
      patch.stt = {
        mode: 'api',
        format: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        accountId: '',
        model: 'whisper-large-v3-turbo',
        language: 'ru',
      };
      keys.stt = key;
    } else if (!(settings.keys && settings.keys.stt)) {
      // Провайдер не умеет распознавание — оставляем рабочий локальный режим.
      patch.stt = { ...(settings.stt || {}), mode: 'local' };
    }

    settings = await window.api.saveSettings(patch);

    const result = await window.api.testConnection();
    if (!result || !result.ok) {
      fail((result && result.error) || 'Модель не ответила. Проверьте ключ и модель.');
      return;
    }

    if (hint) hint.textContent = 'Готово — модель отвечает.';
    closeSetup();
    fill();
  } catch (err) {
    fail(err.message);
  } finally {
    setupBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Проверить и сохранить';
    }
  }
}

function addCheckRow(label, state, text) {
  const box = $('checkAllResults');
  if (!box) return;

  const row = document.createElement('div');
  row.className = `check-row ${state}`;

  const mark = document.createElement('span');
  mark.className = 'check-mark';
  mark.textContent = state === 'ok' ? '✓' : state === 'warn' ? '!' : '×';

  const body = document.createElement('span');
  const title = document.createElement('b');
  title.textContent = `${label}: `;
  body.append(title, document.createTextNode(text));

  row.append(mark, body);
  box.appendChild(row);
}

async function testMicLevel() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const data = new Float32Array(analyser.fftSize);
  let peak = 0;
  const started = performance.now();

  while (performance.now() - started < 1200) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    analyser.getFloatTimeDomainData(data);
    for (const value of data) peak = Math.max(peak, Math.abs(value));
  }

  stream.getTracks().forEach((track) => track.stop());
  await ctx.close();
  return peak;
}

async function testSystemAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  const tracks = stream.getAudioTracks();
  const hasAudio = tracks.length > 0;
  stream.getTracks().forEach((track) => track.stop());
  return hasAudio;
}

async function checkAll() {
  const button = $('checkAllBtn');
  const hint = $('checkAllHint');
  const results = $('checkAllResults');
  if (!hasApi || !button) return;

  button.disabled = true;
  button.textContent = 'Проверяю…';
  if (hint) hint.textContent = 'Это может занять до минуты.';
  if (results) results.innerHTML = '';

  let ok = 0;
  let total = 0;

  try {
    const model = await window.api.testConnection();
    total += 1;
    if (model && model.ok) {
      ok += 1;
      addCheckRow('Модель', 'ok', 'отвечает');
    } else {
      addCheckRow('Модель', 'err', (model && model.error) || 'не отвечает');
    }

    const stt = await window.api.testStt();
    total += 1;
    if (stt && stt.ok) {
      ok += 1;
      addCheckRow('Распознавание', 'ok', `${stt.label}, ${stt.ms} мс`);
    } else {
      addCheckRow('Распознавание', 'err', (stt && stt.error) || 'не работает');
    }

    if (settings.stt && settings.stt.mode === 'local') {
      const status = await window.api.localSttStatus();
      const model = (status.models || []).find(
        (item) => item.id === localModelId(settings.localSttModel)
      );
      total += 1;
      if (status.engine && model && model.ready) {
        ok += 1;
        addCheckRow('Локальная модель', 'ok', 'готова');
      } else {
        addCheckRow('Локальная модель', 'warn', 'движок или модель не скачаны');
      }
    }

    try {
      const peak = await testMicLevel();
      total += 1;
      if (peak > 0.004) {
        ok += 1;
        addCheckRow('Микрофон', 'ok', 'слышит звук');
      } else {
        addCheckRow('Микрофон', 'warn', 'тишина — проверьте устройство');
      }
    } catch (err) {
      total += 1;
      addCheckRow('Микрофон', 'err', err.message || 'нет доступа');
    }

    try {
      const hasSystemAudio = await testSystemAudio();
      total += 1;
      if (hasSystemAudio) {
        ok += 1;
        addCheckRow('Звук системы', 'ok', 'захватывается');
      } else {
        addCheckRow('Звук системы', 'warn', 'нет аудиодорожки');
      }
    } catch (err) {
      total += 1;
      addCheckRow('Звук системы', 'warn', err.message || 'недоступен');
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Проверить всё';
    if (hint) hint.textContent = `Готово: ${ok} из ${total} без ошибок.`;
  }
}

function setUpdateButton(state, label) {
  const button = $('checkUpdatesBtn');
  if (!button) return;

  button.classList.toggle('update-ready', state === 'ready');
  button.disabled = state === 'busy';
  button.textContent = label;
}

function handleUpdateStatus(status) {
  if (!status) return;

  const hint = $('updateHint');

  switch (status.state) {
    case 'checking':
      setUpdateButton('busy', 'Проверяю…');
      if (hint) hint.textContent = 'Проверяю обновление…';
      break;
    case 'available':
      autoUpdateReady = false;
      setUpdateButton('busy', `Скачиваю ${status.version}…`);
      if (hint) hint.textContent = `Доступна версия ${status.version}, скачиваю…`;
      break;
    case 'downloading':
      autoUpdateReady = false;
      setUpdateButton('busy', `Скачиваю… ${status.percent || 0}%`);
      if (hint) hint.textContent = `Скачиваю обновление… ${status.percent || 0}%`;
      break;
    case 'ready':
      autoUpdateReady = true;
      availableUpdate = null;
      setUpdateButton('ready', 'Установить обновление');
      if (hint) hint.textContent = `Обновление ${status.version} готово.`;
      break;
    case 'none':
      autoUpdateReady = false;
      availableUpdate = null;
      setUpdateButton('idle', 'Проверить обновления');
      if (hint) hint.textContent = 'У вас последняя версия.';
      break;
    case 'error':
      autoUpdateReady = false;
      setUpdateButton('idle', 'Проверить обновления');
      if (hint) hint.textContent = status.message || 'Не удалось проверить обновление.';
      break;
    default:
      break;
  }
}

async function initAutoUpdate() {
  if (!window.api.autoUpdateStatus) return false;

  try {
    const result = await window.api.autoUpdateStatus();
    if (result && result.supported) {
      autoUpdateSupported = true;
      handleUpdateStatus(result.status);
      return true;
    }
  } catch {
    /* автообновление недоступно */
  }

  return false;
}

async function checkUpdates({ silent = false } = {}) {
  const hint = $('updateHint');
  if (!hasApi || !window.api.checkUpdates) return;

  if (!silent) {
    setUpdateButton('busy', 'Проверяю…');
    if (hint) hint.textContent = 'Проверяю обновления…';
  }

  try {
    // Установленная версия обновляется сама; portable проверяет JSON.
    const auto = window.api.autoUpdateCheck ? await window.api.autoUpdateCheck() : null;

    if (auto && auto.supported) {
      autoUpdateSupported = true;
      if (!auto.ok) {
        setUpdateButton('idle', 'Проверить обновления');
        if (hint) hint.textContent = auto.error || 'Не удалось проверить обновление.';
      }
      return;
    }

    const result = await window.api.checkUpdates();

    if (result && result.skipped) {
      setUpdateButton('idle', 'Проверить обновления');
      if (!silent && hint) hint.textContent = 'Обновления пока не настроены.';
    } else if (result && result.update) {
      availableUpdate = result.update;
      autoUpdateReady = false;
      setUpdateButton('ready', 'Установить обновление');
      if (hint) hint.textContent = `Доступна версия ${result.update.version}.`;
    } else {
      availableUpdate = null;
      setUpdateButton('idle', 'Проверить обновления');
      if (!silent) {
        if (hint) hint.textContent = 'У вас последняя версия.';
      }
    }
  } catch (err) {
    setUpdateButton('idle', 'Проверить обновления');
    if (hint) hint.textContent = err.message || 'Не удалось проверить обновления.';
  }
}

async function onUpdateButton() {
  if (autoUpdateReady) {
    const hint = $('updateHint');
    setUpdateButton('busy', 'Устанавливаю…');
    try {
      const result = await window.api.autoUpdateInstall();
      if (!result || !result.ok) {
        setUpdateButton('ready', 'Установить обновление');
        if (hint) hint.textContent = 'Не удалось запустить установку.';
      }
    } catch (err) {
      setUpdateButton('ready', 'Установить обновление');
      if (hint) hint.textContent = err.message;
    }
    return;
  }

  if (availableUpdate && availableUpdate.url) {
    window.api.openExternal(availableUpdate.url);
    if ($('updateHint')) {
      $('updateHint').textContent = 'Открыл страницу загрузки. Замените файл приложения.';
    }
    return;
  }

  await checkUpdates();
}

async function copyDiagnostics() {
  const hint = $('updateHint');
  const button = $('copyDiagnosticsBtn');
  if (!hasApi || !window.api.copyDiagnostics) return;

  if (button) button.disabled = true;
  if (hint) hint.textContent = 'Собираю диагностику…';

  try {
    const result = await window.api.copyDiagnostics();
    const email = appConfig.supportEmail || 'softpuff@ya.ru';
    if (hint) {
      hint.textContent =
        result && result.ok
          ? `Диагностика скопирована. Вставьте её в письмо на ${email} — ключи в неё не попадают.`
          : 'Не удалось собрать диагностику.';
    }
  } catch (err) {
    if (hint) hint.textContent = err.message || 'Не удалось собрать диагностику.';
  } finally {
    if (button) button.disabled = false;
  }
}

function renderSupport() {
  const donate = $('donateBtn');
  const hint = $('supportHint');

  if (donate) {
    donate.disabled = !appConfig.donateUrl;
    donate.onclick = () => {
      if (appConfig.donateUrl) window.api.openExternal(appConfig.donateUrl);
    };
  }

  const email = $('feedbackEmail');
  if (email) {
    email.textContent = appConfig.supportEmail || 'softpuff@ya.ru';
    email.onclick = () => {
      if (appConfig.supportEmail) {
        window.api.openExternal(`mailto:${appConfig.supportEmail}`);
      }
    };
  }

  if (hint) {
    hint.textContent = 'Донат не даёт дополнительных функций. Ошибки и предложения — на почту внизу окна.';
  }
}

function fill() {
  renderAi();
  renderDisplays();
  renderStt();
  fillSimpleFields();
  renderHotkeys();
  renderSupport();
  syncAllSelects();
}

function renderStt() {
  const stt = settings.stt || {};
  const mode = stt.mode === 'local' ? 'local' : 'api';

  const select = $('sttMode');
  if (select) select.value = mode;

  if ($('sttFormat')) $('sttFormat').value = stt.format === 'cloudflare' ? 'cloudflare' : 'openai';
  if ($('sttBaseUrl')) $('sttBaseUrl').value = stt.baseUrl || '';
  if ($('sttAccountId')) $('sttAccountId').value = stt.accountId || '';
  if ($('sttKey')) $('sttKey').value = (settings.keys && settings.keys.stt) || '';

  const sttPresets = STT_MODEL_PRESETS[stt.format === 'cloudflare' ? 'cloudflare' : 'openai'] || [];
  fillModelSelect(
    $('sttModelSelect'),
    stt.model,
    sttModelsCache.length ? sttModelsCache : sttPresets
  );
  syncModelInput($('sttModelSelect'), $('sttModelInput'));
  if ($('sttModelInput')) $('sttModelInput').value = stt.model || '';

  if ($('sttLanguage')) $('sttLanguage').value = stt.language || 'ru';

  const modeField = $('sttModeField');
  if (modeField) modeField.hidden = false;

  const local = mode === 'local';

  const apiBlock = $('sttApiBlock');
  if (apiBlock) apiBlock.hidden = local;

  const localBlock = $('sttLocalBlock');
  if (localBlock) localBlock.hidden = !local;

  const localModel = $('localSttModel');
  if (localModel) localModel.value = localModelId(settings.localSttModel);

  const localGpu = $('localSttGpu');
  if (localGpu) localGpu.checked = !!settings.localSttGpu;

  syncAllSelects();

  if (local) {
    refreshLocalStatus();
    refreshGpuInfo();
  }
}

async function refreshGpuInfo() {
  const hint = $('localSttGpuHint');
  const checkbox = $('localSttGpu');
  if (!hint || !checkbox || !hasApi || !window.api.localSttGpuInfo) return;

  try {
    const info = await window.api.localSttGpuInfo();

    if (info && info.available) {
      checkbox.disabled = false;
      hint.textContent = `Найдено: ${info.name}. Движок CUDA скачается один раз (~685 МБ).`;
      return;
    }

    checkbox.disabled = true;
    hint.textContent = 'NVIDIA не найден — будет использоваться CPU.';

    if (settings.localSttGpu) {
      settings.localSttGpu = false;
      checkbox.checked = false;
      scheduleSave();
    }
  } catch {
    hint.textContent = 'Не удалось проверить видеокарту.';
  }
}

async function refreshLocalStatus() {
  const out = $('localSttStatusText');
  const btn = $('localSttDownloadBtn');
  if (!out || !btn || !hasApi) return;

  try {
    const status = await window.api.localSttStatus();
    const size = localModelId(settings.localSttModel);
    const gpu = !!settings.localSttGpu;
    const model = (status.models || []).find((item) => item.id === size);
    const ready = status.engine && model && model.ready;
    const engineLabel = gpu ? 'GPU' : 'CPU';

    if (ready) {
      out.className = 'test-result ok';
      out.textContent = `Готово: движок ${engineLabel} и модель ${size}`;
      btn.textContent = 'Перекачать';
    } else {
      out.className = 'test-result';
      out.textContent = status.engine
        ? `Движок ${engineLabel} скачан, нужна модель ${size}`
        : `Движок ${engineLabel} не скачан`;
      btn.textContent = 'Скачать движок и модель';
    }
    btn.disabled = false;
  } catch (err) {
    console.error('[localStt]', err);
  }
}

let lastSaved = null;

function snapshot(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function buildPatch() {
  const base = lastSaved || {};
  const patch = {};

  for (const key of Object.keys(settings)) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(base[key])) {
      patch[key] = settings[key];
    }
  }

  return patch;
}

function scheduleSave() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(async () => {
    if (!hasApi) return;

    const patch = buildPatch();
    if (!Object.keys(patch).length) return;

    try {
      settings = await window.api.saveSettings(patch);
      lastSaved = snapshot(settings);
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
  $('aiBaseUrl').addEventListener('input', () => {
    settings.ai = { ...(settings.ai || {}), baseUrl: $('aiBaseUrl').value.trim() };
    scheduleSave();
  });

  $('aiAccountId').addEventListener('input', () => {
    settings.ai = { ...(settings.ai || {}), accountId: $('aiAccountId').value.trim() };
    scheduleSave();
  });

  $('aiKey').addEventListener('input', () => {
    settings.keys = { ...(settings.keys || {}), ai: $('aiKey').value.trim() };
    scheduleSave();
  });

  $('aiModel').addEventListener('input', () => {
    settings.ai = { ...(settings.ai || {}), model: $('aiModel').value.trim() };
    scheduleSave();
  });

  $('aiModelSelect').addEventListener('change', () => {
    const select = $('aiModelSelect');
    const value = select.value;

    if (value === '__custom__') {
      syncModelInput(select, $('aiModel'));
      if ($('aiModel')) $('aiModel').focus();
      return;
    }

    settings.ai = { ...(settings.ai || {}), model: value };
    syncModelInput(select, $('aiModel'));
    if ($('aiModel')) $('aiModel').value = value;
    scheduleSave();
  });

  $('aiModelsRefresh').addEventListener('click', async () => {
    const btn = $('aiModelsRefresh');
    const status = $('aiModelsStatus');

    btn.disabled = true;
    btn.textContent = 'загружаю…';
    if (status) status.textContent = '';

    try {
      const result = await window.api.listModels('ai');

      if (result && result.ok) {
        aiModelsCache = result.models || [];
        if (status) status.textContent = `Доступно моделей: ${aiModelsCache.length}`;
      } else if (status) {
        const message = (result && result.error) || '';
        status.textContent =
          message.includes('404')
            ? 'Сервер не отдаёт список моделей — выберите готовую или впишите вручную'
            : message || 'Не удалось получить список';
      }

      renderAi();
      syncAllSelects();
    } finally {
      btn.disabled = false;
      btn.textContent = 'получить список';
    }
  });

  $('overlayDisplay').addEventListener('change', () => {
    settings.overlayDisplay = Number($('overlayDisplay').value) || 0;
    scheduleSave();
  });

  $('audioSource').addEventListener('change', () => {
    settings.audioSource = $('audioSource').value === 'system' ? 'system' : 'mic';
    scheduleSave();
  });

  $('sttMode').addEventListener('change', () => {
    const value = $('sttMode').value;
    settings.stt = {
      ...(settings.stt || {}),
      mode: value === 'local' ? 'local' : 'api',
    };
    renderStt();
    scheduleSave();
  });

  $('sttFormat').addEventListener('change', () => {
    settings.stt = {
      ...(settings.stt || {}),
      format: $('sttFormat').value === 'cloudflare' ? 'cloudflare' : 'openai',
    };
    sttModelsCache = [];
    renderStt();
    scheduleSave();
  });

  $('sttBaseUrl').addEventListener('input', () => {
    settings.stt = { ...(settings.stt || {}), baseUrl: $('sttBaseUrl').value.trim() };
    scheduleSave();
  });

  $('sttAccountId').addEventListener('input', () => {
    settings.stt = { ...(settings.stt || {}), accountId: $('sttAccountId').value.trim() };
    scheduleSave();
  });

  $('sttKey').addEventListener('input', () => {
    settings.keys = { ...(settings.keys || {}), stt: $('sttKey').value.trim() };
    scheduleSave();
  });

  $('sttModelInput').addEventListener('input', () => {
    settings.stt = { ...(settings.stt || {}), model: $('sttModelInput').value.trim() };
    scheduleSave();
  });

  $('sttModelSelect').addEventListener('change', () => {
    const select = $('sttModelSelect');
    const value = select.value;

    if (value === '__custom__') {
      syncModelInput(select, $('sttModelInput'));
      if ($('sttModelInput')) $('sttModelInput').focus();
      return;
    }

    settings.stt = { ...(settings.stt || {}), model: value };
    syncModelInput(select, $('sttModelInput'));
    if ($('sttModelInput')) $('sttModelInput').value = value;
    scheduleSave();
  });

  $('sttModelsRefresh').addEventListener('click', async () => {
    const btn = $('sttModelsRefresh');
    const status = $('sttModelsStatus');

    btn.disabled = true;
    btn.textContent = 'загружаю…';
    if (status) status.textContent = '';

    try {
      const result = await window.api.listModels('stt');

      if (result && result.ok) {
        sttModelsCache = result.models || [];
        if (status) status.textContent = `Доступно моделей: ${sttModelsCache.length}`;
      } else if (status) {
        const message = (result && result.error) || '';
        status.textContent =
          message.includes('404')
            ? 'Сервер не отдаёт список моделей — выберите готовую или впишите вручную'
            : message || 'Не удалось получить список';
      }

      renderStt();
      syncAllSelects();
    } finally {
      btn.disabled = false;
      btn.textContent = 'получить список';
    }
  });

  $('sttLanguage').addEventListener('change', () => {
    settings.stt = { ...(settings.stt || {}), language: $('sttLanguage').value };
    scheduleSave();
  });

  $('localSttModel').addEventListener('change', () => {
    settings.localSttModel = localModelId($('localSttModel').value);
    refreshLocalStatus();
    scheduleSave();
  });

  $('localSttGpu').addEventListener('change', () => {
    settings.localSttGpu = $('localSttGpu').checked;
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

    const size = localModelId(settings.localSttModel);

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

  $('toggleAiKey').addEventListener('click', () => {
    const input = $('aiKey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleAiKey').textContent = hidden ? '🙈' : '👁';
  });

  $('toggleSttKey').addEventListener('click', () => {
    const input = $('sttKey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleSttKey').textContent = hidden ? '🙈' : '👁';
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

      if (hasApi) {
        const patch = buildPatch();
        if (Object.keys(patch).length) {
          settings = await window.api.saveSettings(patch);
          lastSaved = snapshot(settings);
        }
      }

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

  $('interviewBtn').addEventListener('click', () => {
    if (hasApi) window.api.openOverlay();
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

  const quickSetupBtn = $('quickSetupBtn');
  if (quickSetupBtn) quickSetupBtn.addEventListener('click', openSetup);

  const setupCloseBtn = $('setupClose');
  if (setupCloseBtn) setupCloseBtn.addEventListener('click', closeSetup);

  const setupApplyBtn = $('setupApply');
  if (setupApplyBtn) setupApplyBtn.addEventListener('click', applySetup);

  const setupModal = $('setupModal');
  if (setupModal) {
    setupModal.addEventListener('click', (event) => {
      if (event.target === setupModal) closeSetup();
    });
  }

  const setupModel = $('setupModel');
  if (setupModel) {
    setupModel.addEventListener('change', () => {
      const custom = setupModel.value === '__custom__';
      $('setupModelInput').hidden = !custom;
      if (window.syncSelect) window.syncSelect(setupModel);
      if (custom) $('setupModelInput').focus();
    });
  }

  const helpBtn = $('helpBtn');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      if (appConfig.helpUrl) window.api.openExternal(appConfig.helpUrl);
    });
  }

  const checkUpdatesBtn = $('checkUpdatesBtn');
  if (checkUpdatesBtn) checkUpdatesBtn.addEventListener('click', onUpdateButton);

  if (window.api.onUpdateStatus) window.api.onUpdateStatus(handleUpdateStatus);

  const copyDiagnosticsBtn = $('copyDiagnosticsBtn');
  if (copyDiagnosticsBtn) copyDiagnosticsBtn.addEventListener('click', copyDiagnostics);

  const checkAllBtn = $('checkAllBtn');
  if (checkAllBtn) checkAllBtn.addEventListener('click', checkAll);

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
    if (event.key === 'Escape' && $('setupModal') && !$('setupModal').hidden) {
      closeSetup();
      return;
    }

    if (event.key === 'Escape' && !capturingHotkey) window.close();
  });
}

async function boot() {
  if (hasApi) {
    try {
      settings = await window.api.getSettings();
      lastSaved = snapshot(settings);
      settings.keys = settings.keys || {};
      displays = await window.api.getDisplays();

      const info = await window.api.appInfo();
      $('version').textContent = `v${info.version}`;
      appConfig = {
        donateUrl: info.donateUrl || '',
        supportEmail: info.supportEmail || 'softpuff@ya.ru',
        helpUrl: info.helpUrl || 'https://ali-handro.github.io/pomogator/#faq',
      };

      window.api.onDisplaysChanged(async () => {
        displays = await window.api.getDisplays();
        renderDisplays();
      });

      window.api.onSettingsChanged((next) => {
        const active = document.activeElement;
        const editing =
          active &&
          (active.dataset.key ||
            [
              'aiBaseUrl',
              'aiAccountId',
              'aiKey',
              'aiModel',
              'sttBaseUrl',
              'sttAccountId',
              'sttKey',
              'sttModelInput',
              'sttMode',
              'sttFormat',
              'sttLanguage',
            ].includes(active.id));
        settings = next;
        lastSaved = snapshot(next);
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

  enhanceSelects();
  fill();
  bind();
  initAutoUpdate().then(() => checkUpdates({ silent: true }));

  const ai = settings.ai || {};
  if (!ai.baseUrl || !ai.model) {
    setTimeout(openSetup, 250);
  }
}

window.addEventListener('DOMContentLoaded', boot);
