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
  hotkeys: { listen: 'Control+Space' },
  resume: '',
  job: '',
  contextPrompt: '',
  localSttModel: 'base',
};

let displays = [];
let saveTimer = null;
let toastTimer = null;
let lastHotkeyStatus = { failed: [] };

let appConfig = { donateUrl: '', feedbackUrl: '' };

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

function renderSupport() {
  const donate = $('donateBtn');
  const feedback = $('feedbackBtn');
  const hint = $('supportHint');

  if (donate) {
    donate.disabled = !appConfig.donateUrl;
    donate.onclick = () => {
      if (appConfig.donateUrl) window.api.openExternal(appConfig.donateUrl);
    };
  }

  if (feedback) {
    feedback.disabled = !appConfig.feedbackUrl;
    feedback.onclick = () => {
      if (appConfig.feedbackUrl) window.api.openExternal(appConfig.feedbackUrl);
    };
  }

  if (hint) {
    hint.textContent = appConfig.feedbackUrl
      ? 'Ошибки и предложения — в Telegram. Донат не даёт дополнительных функций.'
      : 'Приложение бесплатное. Ссылки ещё не настроены.';
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
  if (localModel) localModel.value = settings.localSttModel === 'small' ? 'small' : 'base';

  syncAllSelects();

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
      lastSaved = snapshot(settings);
      settings.keys = settings.keys || {};
      displays = await window.api.getDisplays();

      const info = await window.api.appInfo();
      $('version').textContent = `v${info.version}`;
      appConfig = {
        donateUrl: info.donateUrl || '',
        feedbackUrl: info.feedbackUrl || '',
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
}

window.addEventListener('DOMContentLoaded', boot);
