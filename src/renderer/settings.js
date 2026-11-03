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
  cloudMode: false,
};

let displays = [];
let saveTimer = null;
let toastTimer = null;
let lastHotkeyStatus = { failed: [] };

let appConfig = { donateUrl: '', topupUrl: '', supportContact: '' };
let topupAmount = 500;

const TOPUP_PLANS = [
  { amount: 300, bonus: 0 },
  { amount: 500, bonus: 0 },
  { amount: 1000, bonus: 10 },
  { amount: 2000, bonus: 15 },
  { amount: 5000, bonus: 20 },
];

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

/* ---------- аккаунт ---------- */

let accountState = null;
let accountOffline = false;

function renderDevices() {
  const box = $('accountDevices');
  if (!box) return;

  box.innerHTML = '';

  const profile = accountState && accountState.profile;
  const devices = (profile && profile.devices) || [];
  if (!devices.length) return;

  const title = document.createElement('div');
  title.className = 'devices-title';
  title.textContent = 'Устройства';
  box.appendChild(title);

  const currentId = profile.device && profile.device.id;

  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'device-row';

    const name = document.createElement('span');
    name.textContent = device.name + (device.id === currentId ? ' · это' : '');

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'device-remove';
    remove.textContent = 'Отвязать';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const result = await window.api.accountRemoveDevice(device.id);
        if (result && result.ok && result.state) {
          accountState = result.state;
          renderAccountState();
        }
      } catch (err) {
        console.error('[account] remove device', err);
      } finally {
        remove.disabled = false;
      }
    });

    row.append(name, remove);
    box.appendChild(row);
  }
}

function renderAccountState() {
  const guest = $('accountGuest');
  const user = $('accountUser');
  if (!guest || !user) return;

  const loggedIn = !!(accountState && accountState.loggedIn);

  guest.hidden = loggedIn;
  user.hidden = !loggedIn;

  const title = $('accountTitle');
  if (title) title.textContent = loggedIn ? 'Аккаунт и баланс' : 'Облако Помогатора';

  if (!loggedIn) return;

  $('accountEmail').textContent = accountState.email || '';

  const profile = accountState.profile;
  const wallet = profile && profile.wallet;

  if (wallet) {
    const balance = Number(wallet.balanceRub || 0);
    const trial = Number(wallet.trialMinutesLeft || 0);
    const trialTotal = Number(wallet.trialMinutesTotal || 0) || 20;

    $('accountNote').textContent =
      trial > 0
        ? `Пробные минуты: ${trial} из ${trialTotal}`
        : `Пробные минуты израсходованы (${trialTotal} мин)`;

    $('accountUsage').innerHTML =
      `Баланс: <b>${balance.toFixed(2)} ₽</b> · пробные: <b>${trial}</b> из ${trialTotal} мин`;

    if (accountOffline) {
      const stamp = accountState.profileAt
        ? new Date(accountState.profileAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';

      $('accountNote').textContent += stamp
        ? ` · нет связи, данные на ${stamp}`
        : ' · нет связи';
    }
  } else {
    $('accountNote').textContent = accountOffline ? 'Нет связи с сервером' : 'Профиль не загружен';
    $('accountUsage').textContent = accountOffline
      ? 'Баланс и минуты появятся после подключения'
      : '';
  }

  renderDevices();

  const cloudBox = $('cloudMode');
  if (cloudBox) cloudBox.checked = !!settings.cloudMode;

  const connectionCard = $('connectionCard');
  if (connectionCard) connectionCard.hidden = loggedIn && !!settings.cloudMode;

  refreshCloudQuote();
  renderStt();
}

async function refreshCloudQuote() {
  const hint = $('cloudHint');
  const price = $('priceLine');
  if (!hint || !hasApi || !window.api.accountQuote) return;

  const wallet = accountState && accountState.profile && accountState.profile.wallet;

  const setPrice = (interviewRate, meetingRate) => {
    if (!price) return;

    if (!settings.cloudMode) {
      price.hidden = true;
      return;
    }

    const perMinute = (rate) =>
      (Number(rate || 0) / 60).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');

    price.textContent =
      `Тариф: собеседование ${interviewRate} ₽/час (${perMinute(interviewRate)} ₽/мин)` +
      ` · встречи ${meetingRate} ₽/час (${perMinute(meetingRate)} ₽/мин)`;
    price.hidden = false;
  };

  try {
    const [interview, meeting] = await Promise.all([
      window.api.accountQuote('interview'),
      window.api.accountQuote('meeting'),
    ]);

    const interviewRate = interview && interview.ok ? interview.ratePerHourRub : 449;
    const meetingRate = meeting && meeting.ok ? meeting.ratePerHourRub : 150;

    setPrice(interviewRate, meetingRate);

    if (interview && interview.ok && meeting && meeting.ok) {
      hint.textContent =
        `Осталось: собеседование ${Math.floor(interview.remainingSeconds / 60)} мин` +
        ` · встречи ${Math.floor(meeting.remainingSeconds / 60)} мин`;
      return;
    }
  } catch {
    setPrice(449, 150);
  }

  if (wallet) {
    const balance = Number(wallet.balanceRub || 0);
    const trial = Number(wallet.trialMinutesLeft || 0);
    const interviewMin = Math.floor(trial + (balance * 60) / 449);
    const meetingMin = Math.floor(trial + (balance * 60) / 150);

    hint.textContent =
      `Нет связи. По последним данным: собеседование ${interviewMin} мин` +
      ` · встречи ${meetingMin} мин`;
  } else {
    hint.textContent = 'Нет связи с сервером';
  }
}

async function renderAccount() {
  if (!hasApi || !window.api.accountStatus) return;

  try {
    accountState = await window.api.accountStatus();
  } catch {
    accountState = null;
  }

  renderAccountState();

  if (accountState && accountState.loggedIn) {
    try {
      const result = await window.api.accountRefresh();
      if (result && result.state) accountState = result.state;
      accountOffline = !(result && result.ok);
    } catch {
      accountOffline = true;
    }

    renderAccountState();
  } else {
    accountOffline = false;
  }
}

async function logoutAccount() {
  if (!hasApi || !window.api.accountLogout) return;

  try {
    const result = await window.api.accountLogout();
    if (result && result.state) accountState = result.state;
  } catch (err) {
    console.error('[account] logout', err);
  }

  renderAccountState();
}

function renderSupport() {
  const donate = $('donateBtn');
  const hint = $('supportHint');
  if (!donate) return;

  donate.disabled = !appConfig.donateUrl;
  donate.onclick = () => {
    if (appConfig.donateUrl) window.api.openExternal(appConfig.donateUrl);
  };

  if (!hint) return;

  if (!appConfig.donateUrl && !appConfig.topupUrl) {
    hint.textContent = 'Ссылки на донаты и оплату ещё не настроены.';
  } else if (!appConfig.topupUrl) {
    hint.textContent = 'Пополнение пока вручную — через поддержку.';
  } else {
    hint.textContent = '';
  }
}

function currentTopupPlan() {
  return TOPUP_PLANS.find((plan) => plan.amount === topupAmount) || TOPUP_PLANS[1];
}

function renderTopupPlans() {
  const box = $('topupAmounts');
  if (!box) return;

  box.innerHTML = '';

  for (const plan of TOPUP_PLANS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'amount';
    button.textContent = plan.bonus ? `${plan.amount} ₽ +${plan.bonus}%` : `${plan.amount} ₽`;
    if (plan.amount === topupAmount) button.classList.add('active');

    button.addEventListener('click', () => {
      topupAmount = plan.amount;
      renderTopupPlans();
      renderTopupSummary();
    });

    box.appendChild(button);
  }
}

function renderTopupSummary() {
  const box = $('topupSummary');
  if (!box) return;

  const plan = currentTopupPlan();
  const credited = Math.round(plan.amount * (1 + plan.bonus / 100));
  const minutes = Math.floor((credited / 449) * 60);

  box.innerHTML = `На балансе: <b>${credited} ₽</b> · это ≈ ${minutes} мин собеседования`;
}

function openTopup() {
  const modal = $('topupModal');
  if (!modal) return;

  if (!accountState || !accountState.loggedIn) {
    if (hasApi) window.api.openLogin();
    return;
  }

  modal.hidden = false;
  renderTopupPlans();
  renderTopupSummary();

  const hint = $('topupHint');
  if (hint) {
    hint.textContent = appConfig.topupUrl
      ? ''
      : 'Онлайн-оплата пока не подключена. Напишите в поддержку — зачислим вручную.';
  }
}

function closeTopup() {
  const modal = $('topupModal');
  if (modal) modal.hidden = true;
}

function payTopup() {
  const hint = $('topupHint');

  if (appConfig.topupUrl) {
    window.api.openExternal(appConfig.topupUrl);
    if (hint) hint.textContent = 'Открыл страницу оплаты в браузере. После оплаты баланс обновится.';
    return;
  }

  if (hint) {
    hint.textContent = appConfig.supportContact
      ? `Онлайн-оплата пока не подключена. Напишите: ${appConfig.supportContact}`
      : 'Онлайн-оплата пока не подключена.';
  }
}

function fill() {
  renderAi();
  renderDisplays();
  renderStt();
  fillSimpleFields();
  renderHotkeys();
  renderAccount();
  renderSupport();
  syncAllSelects();
}

function renderStt() {
  const stt = settings.stt || {};
  const cloudAvailable = !!settings.cloudMode && !!(accountState && accountState.loggedIn);

  let mode = stt.mode === 'local' ? 'local' : stt.mode === 'cloud' ? 'cloud' : 'api';
  if (mode === 'cloud' && !cloudAvailable) mode = 'api';

  const select = $('sttMode');
  if (select) {
    const cloudOption = Array.from(select.options).find((option) => option.value === 'cloud');
    if (cloudOption) cloudOption.disabled = !cloudAvailable;
  }
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

  const cloud = mode === 'cloud';
  const local = mode === 'local';

  const note = $('sttCloudNote');
  if (note) note.hidden = !cloud;

  const apiBlock = $('sttApiBlock');
  if (apiBlock) apiBlock.hidden = cloud || local;

  const localBlock = $('sttLocalBlock');
  if (localBlock) localBlock.hidden = cloud || !local;

  const testRow = $('sttTestRow');
  if (testRow) testRow.hidden = cloud;

  const hint = $('sttHint');
  if (hint) hint.hidden = cloud;

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
      mode: value === 'local' ? 'local' : value === 'cloud' ? 'cloud' : 'api',
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

  const accountLoginBtn = $('accountLogin');
  if (accountLoginBtn) {
    accountLoginBtn.addEventListener('click', () => {
      if (hasApi) window.api.openLogin();
    });
  }

  const accountLogoutBtn = $('accountLogout');
  if (accountLogoutBtn) accountLogoutBtn.addEventListener('click', logoutAccount);

  const cloudModeBox = $('cloudMode');
  if (cloudModeBox) {
    cloudModeBox.addEventListener('change', async () => {
      settings.cloudMode = cloudModeBox.checked;

      if (hasApi) {
        try {
          await window.api.saveSettings({ cloudMode: settings.cloudMode });
        } catch (err) {
          console.error('[settings] cloud mode', err);
        }
      }

      renderAccountState();
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

  $('topupBtn').addEventListener('click', openTopup);
  $('topupClose').addEventListener('click', closeTopup);
  $('topupPay').addEventListener('click', payTopup);
  $('topupModal').addEventListener('click', (event) => {
    if (event.target === $('topupModal')) closeTopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('topupModal').hidden) {
      closeTopup();
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
        topupUrl: info.topupUrl || '',
        supportContact: info.supportContact || '',
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

      window.api.onAccountChanged((state) => {
        accountState = state;
        renderAccountState();
        if (state && state.loggedIn && !state.profile) renderAccount();
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

  window.addEventListener('focus', () => {
    if (accountState && accountState.loggedIn) renderAccount();
  });
}

window.addEventListener('DOMContentLoaded', boot);
