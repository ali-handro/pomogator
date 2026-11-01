'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  nativeImage,
  session,
  shell,
  desktopCapturer,
  net,
  clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { PROVIDERS, providerConfig, resolveBaseUrl, streamChat, visionModel } = require('./providers');
const { sttConfig, transcribe } = require('./stt');
const localStt = require('./localStt');
const { startWheelHook, stopWheelHook } = require('./wheel-hook');
const { createHotkeys } = require('./hotkeys');
const { createScreenshotService } = require('./screenshot');
const { createMeetingStore } = require('./meeting-store');
const license = require('./license');
const { buildMessages } = require('./prompt');

const APP_ROOT = path.join(__dirname, '..');
const isDev = process.argv.includes('--dev');

let overlayWin = null;
let settingsWin = null;
let trainerWin = null;
let meetingWin = null;
let quizWin = null;
let tray = null;
let isQuitting = false;
let activeAbort = null;
let sttAbort = null;

/** Коды, при которых имеет смысл повторить запрос (лимит или временный сбой). */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      return reject(err);
    }

    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  provider: 'cloudflare',
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  cloudflareAccount: '',
  keys: {},
  style: 'concise', // concise | star | technical
  language: 'ru',
  answerWords: 45,
  opacity: 0.94,
  clickThrough: true,
  startHidden: false,
  hideFromCapture: true, // всегда включено, оставлено для совместимости
  audioSource: 'mic', // mic | system
  overlayDisplay: 0,
  overlayWidth: 980,
  overlayHeight: 232,
  overlayPos: null,
  resume: '',
  job: '',
  contextPrompt: '',
  /* распознавание речи */
  sttProvider: 'cloudflare',
  sttModel: '@cf/deepgram/nova-3',
  localSttModel: 'base',
  autoAnswer: true,
  listen: true,
  silenceMs: 450,
  /* лицензия и тариф */
  license: null,
  trialStartedAt: 0,
  usage: null,
  purchaseUrl: '',
  hotkeys: {
    toggle: 'Control+Shift+Space',
    interactive: 'Control+Shift+E',
    answer: 'Control+Shift+A',
    regenerate: 'Control+Shift+R',
    clear: 'Control+Shift+X',
    listen: 'Control+Space',
    settings: 'Control+Shift+S',
    capture: 'Alt+C',
    review: 'Alt+R',
    historyPrev: 'Control+Shift+Left',
    historyNext: 'Control+Shift+Right',
    historyLatest: 'Control+Shift+Down',
  },
};

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(parsed.hotkeys || {}) },
    };

    settings.keys = { ...(settings.keys || {}) };
    if (parsed.apiKey && !settings.keys.groq) settings.keys.groq = parsed.apiKey;
    if (!settings.provider) settings.provider = DEFAULT_SETTINGS.provider;

    // Старое значение из ранних версий: горячая клавиша скриншота была
    // заготовкой и нигде не настраивалась — переводим на актуальную.
    if (!settings.hotkeys.capture || settings.hotkeys.capture === 'Control+Shift+H') {
      settings.hotkeys.capture = DEFAULT_SETTINGS.hotkeys.capture;
    }

    // Одноразовый переход со старой комбинации паузы на Ctrl+Space.
    if (!settings.hotkeysVersion) {
      if (settings.hotkeys.listen === 'Control+Shift+M') {
        settings.hotkeys.listen = 'Control+Space';
      }
      settings.hotkeysVersion = 2;
    }
    delete settings.hotkeys.demo;

    // Mistral закрыл API на бесплатном плане — уводим таких пользователей на Cloudflare.
    if (settings.provider === 'mistral' && !settings.keys.mistral) {
      settings.provider = 'cloudflare';
      settings.model = DEFAULT_SETTINGS.model;
    }
    if (settings.provider === 'cloudflare' && !settings.model) {
      settings.model = DEFAULT_SETTINGS.model;
    }
    if (!settings.sttProvider || settings.sttProvider === 'mistral') {
      settings.sttProvider = DEFAULT_SETTINGS.sttProvider;
      settings.sttModel = DEFAULT_SETTINGS.sttModel;
    }

    settings.cloudflareAccount = normalizeAccountId(settings.cloudflareAccount);

    // Пробный период начинается с первого запуска и длится TRIAL_DAYS дней.
    if (!settings.trialStartedAt) {
      settings.trialStartedAt = Date.now();
      persist();
    }
  } catch {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.trialStartedAt = Date.now();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] save failed:', err);
  }
}

/** Не хватает ключа или Account ID — нужно показать настройки. */
function needsSetup() {
  const provider = providerConfig(settings.provider);
  if (!provider.noKey && !(settings.keys && settings.keys[settings.provider])) return true;
  if (provider.needsAccount && !settings.cloudflareAccount) return true;
  return false;
}

/**
 * Из панели Cloudflare часто копируют не сам ID, а адрес вида
 * dash.cloudflare.com/<id>/home. Оставляем только 32 hex-символа.
 */
function normalizeAccountId(value) {
  const text = String(value || '').trim();
  const match = text.match(/[0-9a-f]{32}/i);
  return match ? match[0].toLowerCase() : text;
}

/* ------------------------------------------------------------------ */
/*  Сервисы                                                            */
/* ------------------------------------------------------------------ */

const hotkeys = createHotkeys({
  getSettings: () => settings,
  onStatus: (status) => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('hotkeys:status', status);
    }
  },
  actions: {
    toggleOverlay,
    toggleInteractive,
    createSettings,
    listen: () => sendToOverlay('action:listen'),
    answer: () => sendToOverlay('action:answer'),
    regenerate: () => sendToOverlay('action:regenerate'),
    clear: () => sendToOverlay('action:clear'),
    capture: () => sendToOverlay('action:capture'),
    review: () => sendToOverlay('action:review'),
    history: (action) => sendToOverlay(`action:${action}`),
  },
});

const screenshots = createScreenshotService({
  getSettings: () => settings,
  sendToOverlay,
  streamChat,
  providerConfig,
  visionModel,
});

const meetings = createMeetingStore({
  getSettings: () => settings,
  streamChat,
  providerConfig,
});

/* ------------------------------------------------------------------ */
/*  Окна                                                               */
/* ------------------------------------------------------------------ */

function displayForOverlay() {
  const displays = screen.getAllDisplays();
  const index = Math.min(Math.max(Number(settings.overlayDisplay) || 0, 0), displays.length - 1);
  return displays[index] || screen.getPrimaryDisplay();
}

function overlayBounds() {
  const pos = settings.overlayPos;
  const display =
    pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ? screen.getDisplayNearestPoint({ x: Math.round(pos.x), y: Math.round(pos.y) })
      : displayForOverlay();
  const area = display.workArea;

  const width = Math.min(
    1600,
    Math.max(560, Number(settings.overlayWidth) || 980),
    Math.max(560, area.width - 40)
  );
  const height = Math.min(
    520,
    Math.max(160, Number(settings.overlayHeight) || 232),
    Math.max(160, area.height - 80)
  );

  // Пользователь мог перетащить окно — держимся за это место,
  // но не даём уехать за пределы экранов.
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    return {
      width,
      height,
      x: Math.min(Math.max(Math.round(pos.x), area.x), area.x + area.width - width),
      y: Math.min(Math.max(Math.round(pos.y), area.y), area.y + area.height - height),
    };
  }

  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 10,
  };
}

let movingProgrammatically = false;
let resizingProgrammatically = false;
let customResizing = false;
let customResize = null;
let moveTimer = null;
let resizeTimer = null;

const RESIZE_MIN_WIDTH = 560;
const RESIZE_MIN_HEIGHT = 160;
const RESIZE_MAX_WIDTH = 1600;
const RESIZE_MAX_HEIGHT = 520;

function clampResizeBounds(bounds) {
  const rawX = Math.round(Number(bounds.x) || 0);
  const rawY = Math.round(Number(bounds.y) || 0);
  const display = screen.getDisplayNearestPoint({ x: rawX, y: rawY });
  const area = display.workArea;

  const width = Math.min(
    RESIZE_MAX_WIDTH,
    Math.max(RESIZE_MIN_WIDTH, Math.round(Number(bounds.width) || RESIZE_MIN_WIDTH)),
    area.width
  );
  const height = Math.min(
    RESIZE_MAX_HEIGHT,
    Math.max(RESIZE_MIN_HEIGHT, Math.round(Number(bounds.height) || RESIZE_MIN_HEIGHT)),
    area.height
  );

  return {
    x: Math.min(Math.max(rawX, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rawY, area.y), area.y + area.height - height),
    width,
    height,
  };
}

function startCustomResize(dir) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  stopCustomResize(false);

  const allowed = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
  if (!allowed.has(dir)) return;

  customResizing = true;
  overlayWin.setIgnoreMouseEvents(false);
  customResize = { dir, startBounds: overlayWin.getBounds() };
}

function applyCustomResize(delta) {
  if (!customResize || !overlayWin || overlayWin.isDestroyed()) return;

  const dx = Math.round(Number(delta && delta.dx) || 0);
  const dy = Math.round(Number(delta && delta.dy) || 0);
  const dir = customResize.dir;
  const start = customResize.startBounds;

  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (dir.includes('e')) width += dx;
  if (dir.includes('s')) height += dy;
  if (dir.includes('w')) {
    width -= dx;
    x += dx;
  }
  if (dir.includes('n')) {
    height -= dy;
    y += dy;
  }

  if (width < RESIZE_MIN_WIDTH) {
    if (dir.includes('w')) x += width - RESIZE_MIN_WIDTH;
    width = RESIZE_MIN_WIDTH;
  }
  if (width > RESIZE_MAX_WIDTH) {
    if (dir.includes('w')) x += width - RESIZE_MAX_WIDTH;
    width = RESIZE_MAX_WIDTH;
  }
  if (height < RESIZE_MIN_HEIGHT) {
    if (dir.includes('n')) y += height - RESIZE_MIN_HEIGHT;
    height = RESIZE_MIN_HEIGHT;
  }
  if (height > RESIZE_MAX_HEIGHT) {
    if (dir.includes('n')) y += height - RESIZE_MAX_HEIGHT;
    height = RESIZE_MAX_HEIGHT;
  }

  overlayWin.setBounds(clampResizeBounds({ x, y, width, height }));
}

function stopCustomResize(persistNow) {
  customResizing = false;
  customResize = null;

  if (!persistNow || !overlayWin || overlayWin.isDestroyed()) return;

  const b = overlayWin.getBounds();
  settings.overlayWidth = Math.min(RESIZE_MAX_WIDTH, Math.max(RESIZE_MIN_WIDTH, b.width));
  settings.overlayHeight = Math.min(RESIZE_MAX_HEIGHT, Math.max(RESIZE_MIN_HEIGHT, b.height));
  settings.overlayPos = { x: b.x, y: b.y };
  persist();
  broadcastSettings();
}

function applyOverlayBounds() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  movingProgrammatically = true;
  resizingProgrammatically = true;
  overlayWin.setBounds(overlayBounds());
  setTimeout(() => {
    movingProgrammatically = false;
    resizingProgrammatically = false;
  }, 250);
}

function createOverlay() {
  const bounds = overlayBounds();

  overlayWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minWidth: 560,
    minHeight: 160,
    maxWidth: 1600,
    maxHeight: 520,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setMenuBarVisibility(false);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  overlayWin.once('ready-to-show', () => {
    if (!settings.startHidden) overlayWin.showInactive();
    applyClickThrough();
    applyCaptureProtection();
    console.log('[overlay] visible', overlayWin.isVisible(), 'bounds', JSON.stringify(overlayWin.getBounds()));
    if (isDev) {
      console.log('[overlay] bounds', JSON.stringify(overlayWin.getBounds()));
      console.log('[overlay] workArea', JSON.stringify(screen.getPrimaryDisplay().workArea));
    }
  });

  // Запоминаем, куда пользователь перетащил окно.
  overlayWin.on('moved', () => {
    if (movingProgrammatically) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      const b = overlayWin.getBounds();
      settings.overlayPos = { x: b.x, y: b.y };
      persist();
    }, 400);
  });

  // Пользователь потянул за край — запоминаем новый размер.
  overlayWin.on('resize', () => {
    if (resizingProgrammatically || customResizing) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      const b = overlayWin.getBounds();
      settings.overlayWidth = Math.min(1600, Math.max(560, b.width));
      settings.overlayHeight = Math.min(520, Math.max(160, b.height));
      settings.overlayPos = { x: b.x, y: b.y };
      persist();
      broadcastSettings();
    }, 400);
  });

  overlayWin.on('hide', () => {
    hoveringHeader = false;
    hotkeys.setAnswerKeysBound(false);
  });

  overlayWin.on('closed', () => {
    stopCustomResize(false);
    hotkeys.setAnswerKeysBound(false);
    overlayWin = null;
  });

  overlayWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  overlayWin.webContents.on('console-message', (_event, level, message) => {
    if (isDev || level >= 2) console.log(`[overlay] ${message}`);
  });
}

/**
 * Пока открыты настройки, оверлей не должен быть поверх всех: два окна
 * верхнего уровня дерутся за z-порядок, и настройки мерцают при перетаскивании.
 */
function lowerOverlayForSettings(lower) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (lower) overlayWin.setAlwaysOnTop(false);
  else overlayWin.setAlwaysOnTop(true, 'screen-saver');
}

/** Есть ли открытое вспомогательное окно (настройки, тренажёр). */
function auxWindowOpen() {
  return (
    (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) ||
    (trainerWin && !trainerWin.isDestroyed() && trainerWin.isVisible()) ||
    (meetingWin && !meetingWin.isDestroyed() && meetingWin.isVisible()) ||
    (quizWin && !quizWin.isDestroyed() && quizWin.isVisible())
  );
}

function syncOverlayTop() {
  lowerOverlayForSettings(auxWindowOpen());
}

function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = 620;
  const height = Math.min(820, work.height - 80);

  settingsWin = new BrowserWindow({
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    minWidth: 640,
    minHeight: 600,
    // Два окна поверх всех (оверлей + настройки) на Windows дерутся за
    // z-порядок и окно настроек мерцает при перетаскивании. Настройки
    // обычные, а оверлей на время настройки опускаем.
    alwaysOnTop: false,
    title: 'Помогатор — настройки',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  syncOverlayTop();

  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[settings] load failed', code, desc);
  });

  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    settingsWin.moveTop();
    settingsWin.focus();
    app.focus({ steal: true });
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
    syncOverlayTop();
  });

  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Тренажёр собеседования: отдельное окно с вопросами, таймером и опорными
 * пунктами. Ничего не записывает и никуда не отправляет.
 */
function createTrainer() {
  if (trainerWin && !trainerWin.isDestroyed()) {
    trainerWin.show();
    trainerWin.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(760, work.width - 80);
  const height = Math.min(700, work.height - 80);

  trainerWin = new BrowserWindow({
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    minWidth: 560,
    minHeight: 520,
    alwaysOnTop: false,
    title: 'Помогатор — тренажёр',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  syncOverlayTop();
  trainerWin.loadFile(path.join(__dirname, 'renderer', 'trainer.html'));

  trainerWin.once('ready-to-show', () => {
    if (!trainerWin || trainerWin.isDestroyed()) return;
    trainerWin.show();
    trainerWin.focus();
  });

  trainerWin.on('closed', () => {
    trainerWin = null;
    syncOverlayTop();
  });

  trainerWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Запись встречи: два канала (микрофон — вы, звук системы — собеседник),
 * живой транскрипт и сохранение расшифровки. Аудио не хранится.
 */
function createMeeting() {
  if (meetingWin && !meetingWin.isDestroyed()) {
    meetingWin.show();
    meetingWin.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(880, work.width - 80);
  const height = Math.min(700, work.height - 80);

  meetingWin = new BrowserWindow({
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    minWidth: 620,
    minHeight: 520,
    alwaysOnTop: false,
    title: 'Помогатор — запись встречи',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  syncOverlayTop();
  meetingWin.loadFile(path.join(__dirname, 'renderer', 'meeting.html'));

  meetingWin.once('ready-to-show', () => {
    if (!meetingWin || meetingWin.isDestroyed()) return;
    meetingWin.show();
    meetingWin.focus();
  });

  meetingWin.on('closed', () => {
    meetingWin = null;
    syncOverlayTop();
  });

  meetingWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Тесты: вопросы с вариантами ответов, объяснением и счётом. */
function createQuiz() {
  if (quizWin && !quizWin.isDestroyed()) {
    quizWin.show();
    quizWin.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(820, work.width - 80);
  const height = Math.min(720, work.height - 80);

  quizWin = new BrowserWindow({
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    minWidth: 600,
    minHeight: 540,
    alwaysOnTop: false,
    title: 'Помогатор — тесты',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  syncOverlayTop();
  quizWin.loadFile(path.join(__dirname, 'renderer', 'quiz.html'));

  quizWin.once('ready-to-show', () => {
    if (!quizWin || quizWin.isDestroyed()) return;
    quizWin.show();
    quizWin.focus();
  });

  quizWin.on('closed', () => {
    quizWin = null;
    syncOverlayTop();
  });

  quizWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function toggleOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) {
    createOverlay();
    return;
  }
  if (overlayWin.isVisible()) {
    overlayWin.hide();
  } else {
    overlayWin.showInactive();
    applyClickThrough();
  }
}

function applyClickThrough() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const through = !!settings.clickThrough;
  overlayWin.setIgnoreMouseEvents(through, { forward: true });
  hoveringHeader = false;
  hotkeys.setAnswerKeysBound(false);
  // В режиме кликов окно должно получать фокус, иначе его нельзя перетащить
  // и не работает ручной ввод вопроса.
  overlayWin.setFocusable(!through);
  overlayWin.webContents.send('overlay:click-through', through);
}

/**
 * В режиме суфлёра окно «сквозное» для мыши. Чтобы кнопки в верхней панели
 * нажимались, а окно можно было тянуть за край, следим за курсором:
 * над панелью или у границы — перехватываем мышь.
 */
const OVERLAY_HEADER_DIP = 46;
const OVERLAY_EDGE_DIP = 12;
let hoverTimer = null;
let hoveringHeader = false;

// Прямоугольник текста ответа в координатах окна. Пока курсор над ним,
// окно перехватывает мышь, чтобы работало колесо перемотки ответов.
let answerRegion = null;

function cursorInAnswerRegion() {
  if (!overlayWin || overlayWin.isDestroyed() || !answerRegion) return false;
  const b = overlayWin.getBounds();
  const p = screen.getCursorScreenPoint();
  return (
    p.x >= b.x + answerRegion.x &&
    p.x <= b.x + answerRegion.x + answerRegion.width &&
    p.y >= b.y + answerRegion.y &&
    p.y <= b.y + answerRegion.y + answerRegion.height
  );
}

/** Колесо листает историю только над текстом ответа и не во время выделения. */
function wheelActive() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return false;
  if (screenshots.isOpen()) return false;
  return cursorInAnswerRegion();
}

function startWheel() {
  startWheelHook({
    isActive: wheelActive,
    onStep: (direction) => {
      sendToOverlay(`action:${direction < 0 ? 'history-prev' : 'history-next'}`);
      // Renderer мог получить то же колесо — гасим повтор.
      sendToOverlay('overlay:wheel-consumed');
    },
  });
}

/** Открыто и в фокусе ли вспомогательное окно (настройки, тренажёр). */
function auxFocused() {
  return (
    (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && settingsWin.isFocused()) ||
    (trainerWin && !trainerWin.isDestroyed() && trainerWin.isVisible() && trainerWin.isFocused()) ||
    (meetingWin && !meetingWin.isDestroyed() && meetingWin.isVisible() && meetingWin.isFocused()) ||
    (quizWin && !quizWin.isDestroyed() && quizWin.isVisible() && quizWin.isFocused())
  );
}

function startHoverWatch() {
  if (hoverTimer) return;

  hoverTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
    if (customResizing) return;

    // Пока пользователь работает с настройками, не трогаем перехват мыши:
    // переключения прозрачности на ходу заставляют окна перерисовываться.
    // Как только настройки теряют фокус (вернулись в приложение), всё работает.
    if (auxFocused()) {
      hotkeys.setAnswerKeysBound(false);
      if (hoveringHeader) {
        hoveringHeader = false;
        overlayWin.setIgnoreMouseEvents(true, { forward: true });
      }
      return;
    }

    if (!settings.clickThrough) {
      hoveringHeader = false;
      // В режиме кликов окно и так принимает мышь, но стрелки над текстом
      // всё равно перехватываем глобально — окно может быть не в фокусе.
      const bounds = overlayWin.getBounds();
      const point = screen.getCursorScreenPoint();
      const insideWindow =
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height;
      const overAnswer = !!(
        insideWindow &&
        answerRegion &&
        point.x >= bounds.x + answerRegion.x &&
        point.x <= bounds.x + answerRegion.x + answerRegion.width &&
        point.y >= bounds.y + answerRegion.y &&
        point.y <= bounds.y + answerRegion.y + answerRegion.height
      );
      hotkeys.setAnswerKeysBound(overAnswer);
      return;
    }

    const b = overlayWin.getBounds();
    const p = screen.getCursorScreenPoint();
    const insideWindow =
      p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    const inHeader =
      p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + OVERLAY_HEADER_DIP;
    const nearEdge =
      insideWindow &&
      (p.x - b.x <= OVERLAY_EDGE_DIP ||
        b.x + b.width - p.x <= OVERLAY_EDGE_DIP ||
        p.y - b.y <= OVERLAY_EDGE_DIP ||
        b.y + b.height - p.y <= OVERLAY_EDGE_DIP);
    const inAnswer = !!(
      insideWindow &&
      answerRegion &&
      p.x >= b.x + answerRegion.x &&
      p.x <= b.x + answerRegion.x + answerRegion.width &&
      p.y >= b.y + answerRegion.y &&
      p.y <= b.y + answerRegion.y + answerRegion.height
    );
    const inside = inHeader || nearEdge || inAnswer;

    // В режиме суфлёра окно не в фокусе, поэтому стрелки над текстом
    // перехватываем глобально, пока курсор там.
    hotkeys.setAnswerKeysBound(inAnswer);

    if (inside !== hoveringHeader) {
      hoveringHeader = inside;
      overlayWin.setIgnoreMouseEvents(!inside, { forward: true });
    }
  }, 40);
}

/**
 * Оверлей никогда не попадает в захват экрана (Windows 10 2004+).
 * Включено всегда: пользователь не должен вспоминать про галочку.
 */
function applyCaptureProtection() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    overlayWin.setContentProtection(true);
  } catch (err) {
    console.warn('[overlay] content protection failed:', err.message);
  }
}

/**
 * Звук системы (созвон в браузере, видео, плеер) берём через loopback:
 * getDisplayMedia в рендерере получает экран + системный звук, видео сразу
 * отбрасываем. Без этого обработчика Chromium показал бы окно выбора экрана.
 */
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source =
          sources.find((item) => String(item.display_id) === primaryId) || sources[0];

        if (!source) {
          callback({});
          return;
        }

        callback({ video: source, audio: 'loopback' });
      } catch (err) {
        console.warn('[capture] display media failed:', err.message);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function toggleInteractive() {
  settings.clickThrough = !settings.clickThrough;
  persist();
  applyClickThrough();
  broadcastSettings();
}

function moveOverlayToDisplay(index) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return;
  const count = displays.length;
  settings.overlayDisplay = ((Number(index) || 0) % count + count) % count;
  settings.overlayPos = null;
  persist();
  applyOverlayBounds();
  broadcastSettings();
}

function cycleOverlayDisplay() {
  moveOverlayToDisplay((Number(settings.overlayDisplay) || 0) + 1);
}

function reposition() {
  applyOverlayBounds();
}

function onDisplaysChanged() {
  // Монитор отключили — индекс мог стать невалидным, окно возвращаем в кадр.
  reposition();
  refreshTrayMenu();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('displays:changed');
  }
}

function broadcastSettings() {
  sendToOverlay('settings:changed', settings);
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:changed', settings);
  }
}

/* ------------------------------------------------------------------ */
/*  Трей                                                               */
/* ------------------------------------------------------------------ */

function trayIcon() {
  const png = path.join(APP_ROOT, 'assets', 'tray.png');
  if (fs.existsSync(png)) return nativeImage.createFromPath(png);
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const multipleDisplays = screen.getAllDisplays().length > 1;

  return Menu.buildFromTemplate([
    { label: 'Показать / скрыть', click: toggleOverlay },
    { type: 'separator' },
    ...(multipleDisplays
      ? [{ label: 'Переместить на другой экран', click: cycleOverlayDisplay }]
      : []),
    { type: 'separator' },
    { label: 'Тренажёр собеседования…', click: createTrainer },
    { label: 'Тесты…', click: createQuiz },
    { label: 'Запись встречи…', click: createMeeting },
    { label: 'Настройки…', click: createSettings },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Помогатор');
  refreshTrayMenu();
  tray.on('click', toggleOverlay);
}

function sendToOverlay(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ */
/*  Прогрев соединений                                                 */
/* ------------------------------------------------------------------ */

/** Тихий WAV на 16 кГц — нужен только чтобы разбудить воркер Whisper. */
function silentWav(ms = 320, rate = 16000) {
  const frames = Math.round((rate * ms) / 1000);
  const buffer = Buffer.alloc(44 + frames * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);

  return buffer;
}

/**
 * Первый запрос после запуска всегда медленнее: TLS, HTTP/2 и «холодный»
 * воркер модели. Греем заранее, чтобы первый же вопрос не ждал лишнюю секунду.
 */
function warmUp() {
  const providerId = settings.provider || 'cloudflare';
  const provider = providerConfig(providerId);
  const apiKey = provider.noKey ? '' : (settings.keys && settings.keys[providerId]) || '';

  if (providerId === 'opencode' && apiKey) {
    net
      .fetch(`${resolveBaseUrl(provider, settings.cloudflareAccount)}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'Pomogator/0.1.0 (overlay assistant)',
        },
      })
      .catch(() => {});
  }

  // Локальный движок держит модель в памяти: поднимаем заранее, чтобы первый
  // вопрос не ждал ещё и загрузку модели.
  if (settings.sttProvider === 'local') {
    localStt.ensureServer(settings.localSttModel).catch(() => {});
    return;
  }

  const sttProvider = settings.sttProvider || 'cloudflare';
  const sttKey = (settings.keys && settings.keys[sttProvider]) || '';
  if (sttProvider === 'cloudflare' && sttKey && settings.cloudflareAccount) {
    transcribe({
      providerId: 'cloudflare',
      apiKey: sttKey,
      accountId: settings.cloudflareAccount,
      model: settings.sttModel,
      audio: silentWav(),
      language: 'ru',
      initialPrompt: '',
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/*  Горячие клавиши                                                    */
/* ------------------------------------------------------------------ */

/*  Распознавание речи: резервная модель                               */
/* ------------------------------------------------------------------ */

// Если основная модель отвалится посреди разговора (квота, сбой, снятие
// с поддержки), работаем на резервной в том же аккаунте: Whisper тратит
// в 10 раз меньше нейронов и переживает лимиты Nova.
const STT_FALLBACK = {
  '@cf/deepgram/nova-3': '@cf/openai/whisper-large-v3-turbo',
  '@cf/openai/whisper-large-v3-turbo': '@cf/openai/whisper',
};

let sttActiveModel = '';

function sttModelLabel(model) {
  if (model === '@cf/deepgram/nova-3') return 'Nova';
  if (model === '@cf/openai/whisper-large-v3-turbo') return 'Whisper';
  if (model === '@cf/openai/whisper') return 'Whisper v3';
  return String(model || '');
}

function runStt(model, audio, signal) {
  const sttId = settings.sttProvider === 'local' ? 'cloudflare' : settings.sttProvider || 'cloudflare';
  const cfg = sttConfig(sttId);
  const keyId = cfg.keyProvider || sttId;
  const apiKey = (settings.keys && settings.keys[keyId]) || '';

  return transcribe({
    providerId: sttId,
    apiKey,
    accountId: settings.cloudflareAccount || '',
    model,
    audio,
    language: settings.language === 'en' ? 'en' : 'ru',
    initialPrompt: settings.contextPrompt,
    signal,
  });
}

/** Облачная цепочка: основная модель → резервная, с одним повтором. */
async function cloudTranscribe(audio, controller, startModel) {
  const sttId = settings.sttProvider === 'local' ? 'cloudflare' : settings.sttProvider || 'cloudflare';
  const cfg = sttConfig(sttId);
  const keyId = cfg.keyProvider || sttId;
  const apiKey = (settings.keys && settings.keys[keyId]) || '';

  if (!apiKey) throw new Error(`Нет ключа для распознавания (${cfg.label})`);
  if (cfg.needsAccount && !settings.cloudflareAccount) {
    throw new Error('Не указан Account ID Cloudflare');
  }

  const primary = startModel;
  const fallback = STT_FALLBACK[primary];

  try {
    return { ok: true, text: await runStt(primary, audio, controller.signal), model: primary };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    if (!fallback) return { ok: false, error: err.message };
  }

  // Одна повторная попытка: чаще всего это сетевой сбой, а не отказ модели.
  try {
    await delay(350, controller.signal);
  } catch {
    return { ok: false, aborted: true };
  }

  try {
    return { ok: true, text: await runStt(primary, audio, controller.signal), model: primary };
  } catch (retryErr) {
    if (retryErr.name === 'AbortError') return { ok: false, aborted: true };

    sttActiveModel = fallback;
    console.warn('[stt] переключаюсь на резерв:', fallback, retryErr.message);
    sendToOverlay('stt:notice', `Распознавание переключилось на ${sttModelLabel(fallback)}`);

    try {
      return { ok: true, text: await runStt(fallback, audio, controller.signal), model: fallback };
    } catch (finalErr) {
      if (finalErr.name === 'AbortError') return { ok: false, aborted: true };
      return { ok: false, error: finalErr.message };
    }
  }
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('license:status', () => license.describe(settings));

  ipcMain.handle('license:activate', (_event, key) => {
    const result = license.verifyKey(key);
    if (!result.ok) return result;

    settings.license = {
      plan: result.plan,
      exp: result.exp,
      id: result.id,
      key: String(key || '').trim(),
      activatedAt: Date.now(),
    };
    persist();

    return { ok: true, state: license.describe(settings) };
  });

  ipcMain.handle('settings:save', (_event, patch) => {
    const prevHotkeys = JSON.stringify(settings.hotkeys);
    const prevDisplay = Number(settings.overlayDisplay) || 0;
    const prevClickThrough = !!settings.clickThrough;
    const prevWidth = Number(settings.overlayWidth) || 980;
    const prevHeight = Number(settings.overlayHeight) || 232;
    const prevSttModel = settings.sttModel;
    const prevSttProvider = settings.sttProvider;
    const prevLocalModel = settings.localSttModel;

    // Позицию окна знает только главный процесс — не даём рендереру её затереть.
    const incoming = { ...(patch || {}) };
    delete incoming.overlayPos;
    delete incoming.license;
    delete incoming.trialStartedAt;
    delete incoming.usage;

    settings = {
      ...settings,
      ...incoming,
      hotkeys: { ...settings.hotkeys, ...(incoming.hotkeys || {}) },
    };
    settings.overlayDisplay = Math.max(0, Number(settings.overlayDisplay) || 0);
    settings.overlayWidth = Math.min(1600, Math.max(560, Number(settings.overlayWidth) || 980));
    settings.overlayHeight = Math.min(520, Math.max(160, Number(settings.overlayHeight) || 232));
    settings.opacity = Math.min(1, Math.max(0.3, Number(settings.opacity) || 0.94));
    settings.audioSource = settings.audioSource === 'system' ? 'system' : 'mic';
    settings.cloudflareAccount = normalizeAccountId(settings.cloudflareAccount);
    if (settings.keys) {
      settings.keys = Object.fromEntries(
        Object.entries(settings.keys).map(([id, key]) => [
          id,
          String(key || '')
            .trim()
            .replace(/^Bearer\s+/i, ''),
        ])
      );
    }
    persist();
    if (JSON.stringify(settings.hotkeys) !== prevHotkeys) hotkeys.register();
    // Сменили модель распознавания — снова пробуем её, а не резервную.
    if (settings.sttModel !== prevSttModel) sttActiveModel = '';
    // Сменили локальную модель или источник — перезапустим движок лениво.
    if (
      settings.sttProvider !== prevSttProvider ||
      settings.localSttModel !== prevLocalModel
    ) {
      localStt.stopServer();
    }
    broadcastSettings();
    if (prevClickThrough !== !!settings.clickThrough) applyClickThrough();
    if (
      prevDisplay !== (Number(settings.overlayDisplay) || 0) ||
      prevWidth !== settings.overlayWidth ||
      prevHeight !== settings.overlayHeight
    ) {
      if (prevDisplay !== (Number(settings.overlayDisplay) || 0)) settings.overlayPos = null;
      applyOverlayBounds();
    }
    refreshTrayMenu();
    return settings;
  });

  ipcMain.handle('hotkeys:get-status', () => hotkeys.getStatus());

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('displays:get', () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => ({
      index,
      label: `Экран ${index + 1} — ${display.size.width}×${display.size.height}${
        display.id === primaryId ? ' (основной)' : ''
      }`,
      primary: display.id === primaryId,
      width: display.size.width,
      height: display.size.height,
    }));
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('providers:get', () => PROVIDERS);

  ipcMain.handle('llm:test', async () => {
    const providerId = settings.provider || 'cloudflare';
    const provider = providerConfig(providerId);
    const apiKey = provider.noKey ? '' : (settings.keys && settings.keys[providerId]) || '';
    const accountId = settings.cloudflareAccount || '';

    if (!provider.noKey && !apiKey) return { ok: false, error: 'Не заполнен API-ключ' };
    if (provider.needsAccount && !accountId) return { ok: false, error: 'Не заполнен Account ID' };

    try {
      let text = '';
      await streamChat({
        providerId,
        apiKey,
        accountId,
        model: settings.model,
        messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        maxTokens: 300,
        temperature: 0,
        signal: AbortSignal.timeout(25000),
        onDelta: (delta) => {
          text += delta;
        },
      });
      return { ok: true, text: text.trim().slice(0, 120) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('llm:ask', async (_event, payload) => {
    const question = String((payload && payload.question) || '').trim();
    if (!question) return { ok: false, error: 'Пустой вопрос' };

    const providerId = settings.provider || 'cloudflare';
    const provider = providerConfig(providerId);
    const apiKey = provider.noKey ? '' : (settings.keys && settings.keys[providerId]) || '';
    const accountId = settings.cloudflareAccount || '';

    if (!provider.noKey && !apiKey) {
      const message = `Нет ключа для ${provider.label}. Откройте настройки.`;
      sendToOverlay('llm:error', message);
      return { ok: false, error: message };
    }

    if (provider.needsAccount && !accountId) {
      const message = 'Не указан Account ID Cloudflare. Откройте настройки.';
      sendToOverlay('llm:error', message);
      return { ok: false, error: message };
    }

    const quota = license.consume(settings, 'answers');
    if (!quota.ok) {
      sendToOverlay('llm:error', quota.error);
      return { ok: false, error: quota.error, quota: true };
    }
    persist();

    if (activeAbort) activeAbort.abort();
    const controller = new AbortController();
    activeAbort = controller;

    sendToOverlay('llm:start');

    try {
      for (let attempt = 1; ; attempt++) {
        let received = false;
        try {
          await streamChat({
            providerId,
            apiKey,
            accountId,
            model: settings.model,
            messages: buildMessages({ question, settings }),
            maxTokens: 400,
            temperature: 0.4,
            signal: controller.signal,
            onDelta: (text) => {
              received = true;
              sendToOverlay('llm:delta', text);
            },
          });
          sendToOverlay('llm:done');
          return { ok: true };
        } catch (err) {
          if (err.name === 'AbortError') return { ok: false, aborted: true };

          // Повторяем только один раз и только если поток ещё не начался:
          // иначе в оверлее останется половина ответа.
          const retryable = !received && attempt === 1 && RETRYABLE.has(err.status);
          if (!retryable) {
            sendToOverlay('llm:error', err.message);
            return { ok: false, error: err.message };
          }

          const wait = err.retryAfter ? Math.min(err.retryAfter * 1000, 3000) : 1500;
          await delay(wait, controller.signal);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      sendToOverlay('llm:error', err.message);
      return { ok: false, error: err.message };
    } finally {
      if (activeAbort === controller) activeAbort = null;
    }
  });

  ipcMain.on('llm:abort', () => {
    if (activeAbort) activeAbort.abort();
    activeAbort = null;
  });

  // Выделение области на снимке экрана
  ipcMain.on('capture:select', (_event, rect) => screenshots.select(rect));
  ipcMain.on('capture:cancel', () => screenshots.cancel());

  ipcMain.handle('vision:capture', async (_event, payload) => {
    const mode = payload && payload.mode === 'review' ? 'review' : 'solve';

    const quota = license.consume(settings, 'screenshots');
    if (!quota.ok) {
      sendToOverlay('llm:error', quota.error);
      return { ok: false, error: quota.error, quota: true };
    }
    persist();

    if (activeAbort) activeAbort.abort();
    const controller = new AbortController();
    activeAbort = controller;

    sendToOverlay('llm:start');
    try {
      const result = await screenshots.captureAndSolve(controller, mode);
      if (result.cancelled) return { ok: false, cancelled: true };

      sendToOverlay('llm:done');
      return { ok: true };
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      sendToOverlay('llm:error', err.message);
      return { ok: false, error: err.message };
    } finally {
      if (activeAbort === controller) activeAbort = null;
    }
  });

  ipcMain.handle('stt:transcribe', async (_event, payload) => {
    const audio = payload && payload.audio;
    if (!audio || !audio.byteLength) return { ok: false, error: 'Пустое аудио' };

    // Запись встреч может попросить конкретный движок, не меняя настройки суфлёра.
    const override = payload && payload.override;
    if (override && override.provider === 'local') {
      try {
        const text = await localStt.transcribe(audio, override.model);
        return { ok: true, text, model: 'local' };
      } catch (err) {
        if (err.name === 'AbortError') return { ok: false, aborted: true };
        return { ok: false, error: err.message };
      }
    }

    if (sttAbort) sttAbort.abort();
    const controller = new AbortController();
    sttAbort = controller;

    try {
      if (override && override.model) {
        return await cloudTranscribe(audio, controller, override.model);
      }

      if (settings.sttProvider === 'local') {
        try {
          const text = await localStt.transcribe(audio, settings.localSttModel);
          return { ok: true, text, model: 'local' };
        } catch (err) {
          if (err.name === 'AbortError') return { ok: false, aborted: true };
          console.warn('[stt] локальное распознавание не сработало:', err.message);
          sendToOverlay(
            'stt:notice',
            'Локальное распознавание не сработало — слушаю через облако'
          );
          return await cloudTranscribe(
            audio,
            controller,
            '@cf/openai/whisper-large-v3-turbo'
          );
        }
      }

      return await cloudTranscribe(audio, controller, sttActiveModel || settings.sttModel);
    } finally {
      if (sttAbort === controller) sttAbort = null;
    }
  });

  ipcMain.handle('localStt:status', () => localStt.status(settings));

  ipcMain.handle('localStt:download', async (event, payload) => {
    const size = payload && payload.model === 'small' ? 'small' : 'base';
    const send = (data) => {
      const target = event.sender;
      if (target && !target.isDestroyed()) target.send('localStt:progress', data);
      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents !== target) {
        settingsWin.webContents.send('localStt:progress', data);
      }
    };

    const result = await localStt.download({ size, onProgress: send });
    // Новая модель подхватится при следующем запросе.
    if (result.ok) localStt.stopServer();
    return result;
  });

  ipcMain.handle('localStt:cancel', () => {
    localStt.cancelDownload();
    return { ok: true };
  });

  // Проверка распознавания перед «боем»: короткий тихий фрагмент через тот же
  // путь, что и настоящие вопросы.
  ipcMain.handle('stt:test', async () => {
    if (settings.sttProvider === 'local') {
      const size = settings.localSttModel === 'small' ? 'small' : 'base';
      const started = Date.now();
      try {
        await localStt.transcribe(silentWav(400), size);
        return { ok: true, model: 'local', label: `Локально (${size})`, ms: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    const sttId = settings.sttProvider || 'cloudflare';
    const cfg = sttConfig(sttId);
    const keyId = cfg.keyProvider || sttId;
    const apiKey = (settings.keys && settings.keys[keyId]) || '';
    if (!apiKey) return { ok: false, error: 'Нет ключа для распознавания' };

    const models = [sttActiveModel || settings.sttModel];
    if (STT_FALLBACK[models[0]]) models.push(STT_FALLBACK[models[0]]);

    const results = [];
    for (const model of models) {
      const started = Date.now();
      try {
        await runStt(model, silentWav(400), AbortSignal.timeout(15000));
        results.push({ model, ms: Date.now() - started, ok: true });
        break;
      } catch (err) {
        results.push({ model, ms: Date.now() - started, ok: false, error: err.message });
      }
    }

    const working = results.find((item) => item.ok);
    return working
      ? { ok: true, model: working.model, label: sttModelLabel(working.model), ms: working.ms, results }
      : { ok: false, error: results[results.length - 1]?.error || 'Не удалось', results };
  });

  ipcMain.on('overlay:set-click-through', (_event, value) => {
    settings.clickThrough = !!value;
    persist();
    applyClickThrough();
  });

  // (перехват мыши над верхней панелью делает startHoverWatch)
  ipcMain.on('overlay:hide', () => {
    hotkeys.setAnswerKeysBound(false);
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  });

  // Область текста ответа для перехвата колеса мыши в режиме суфлёра.
  ipcMain.on('overlay:answer-region', (_event, region) => {
    if (
      !region ||
      !region.navigable ||
      !(region.width > 0) ||
      !(region.height > 0) ||
      !Number.isFinite(region.x) ||
      !Number.isFinite(region.y)
    ) {
      answerRegion = null;
      return;
    }
    answerRegion = {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    };
  });

  // Колесо уже обработано в renderer — главному процессу листать не нужно.
  // Перетаскивание размера: главный процесс сам следит за курсором,
  // потому что нативный ресайз прозрачного frameless-окна на Windows не работает.
  ipcMain.on('overlay:resize-start', (_event, dir) => {
    startCustomResize(String(dir || ''));
  });
  ipcMain.on('overlay:resize-move', (_event, delta) => {
    applyCustomResize(delta);
  });
  ipcMain.on('overlay:resize-end', () => {
    stopCustomResize(true);
  });

  ipcMain.on('settings:open', createSettings);
  ipcMain.on('trainer:open', createTrainer);
  ipcMain.on('quiz:open', createQuiz);
  ipcMain.on('meeting:open', createMeeting);

  // Пока идёт запись встречи, суфлёр не слушает микрофон.
  ipcMain.on('meeting:recording', (_event, value) => {
    sendToOverlay('meeting:recording', !!value);
  });

  ipcMain.handle('meeting:save', (_event, payload) => meetings.save(payload));
  ipcMain.handle('meeting:summary', (_event, payload) => meetings.summarize(payload));
  ipcMain.handle('meeting:export', (_event, payload) => meetings.exportMarkdown(payload));
  ipcMain.handle('meetings:list', () => meetings.list());
  ipcMain.handle('meetings:read', (_event, name) => meetings.read(name));
  ipcMain.handle('meetings:remove', (_event, name) => meetings.remove(name));

  ipcMain.on('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.on('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

/* ------------------------------------------------------------------ */
/*  Жизненный цикл                                                     */
/* ------------------------------------------------------------------ */

// Микрофон должен работать без клика по окну: оверлей неактивен по умолчанию.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.showInactive();
    } else {
      createOverlay();
    }
  });

/**
 * Приложение переименовано из Suflyor: переносим настройки, локальные модели
 * и записи встреч из старой папки, чтобы ничего не пропало.
 */
function migrateLegacyData() {
  try {
    const target = app.getPath('userData');
    const legacy = path.join(app.getPath('appData'), 'Suflyor');

    if (!fs.existsSync(legacy)) return;

    fs.mkdirSync(target, { recursive: true });

    // Настройки и модели — только если своих ещё нет.
    if (!fs.existsSync(path.join(target, 'settings.json'))) {
      for (const name of ['settings.json', 'whisper']) {
        const from = path.join(legacy, name);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(target, name), { recursive: true });
      }
      console.log('[migrate] настройки перенесены из Suflyor');
    }

    // Встречи добавляем к своим, не затирая уже записанные.
    const legacyMeetings = path.join(legacy, 'meetings');
    if (fs.existsSync(legacyMeetings)) {
      const targetMeetings = path.join(target, 'meetings');
      fs.mkdirSync(targetMeetings, { recursive: true });

      for (const name of fs.readdirSync(legacyMeetings)) {
        const to = path.join(targetMeetings, name);
        if (fs.existsSync(to)) continue;
        fs.copyFileSync(path.join(legacyMeetings, name), to);
      }
    }
  } catch (err) {
    console.warn('[migrate]', err.message);
  }
}

app.whenReady().then(() => {
    app.setAppUserModelId('com.pomogator.app');
    migrateLegacyData();
    loadSettings();

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(
        permission === 'media' ||
          permission === 'audioCapture' ||
          permission === 'display-capture'
      );
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return (
        permission === 'media' ||
        permission === 'audioCapture' ||
        permission === 'display-capture'
      );
    });

    setupDisplayMedia();
    registerIpc();
    createOverlay();
    createTray();
    hotkeys.register();
    startHoverWatch();
    startWheel();

    // Прогрев не должен мешать старту — даём окну подняться.
    setTimeout(warmUp, 1500);

    // Без ключа приложение бесполезно — сразу открываем настройки,
    // чтобы не искать иконку в трее.
    const setup = needsSetup();
    if (setup || process.argv.includes('--settings')) {
      console.log('[boot] opening settings');
      setTimeout(createSettings, setup ? 1200 : 0);
    }

    screen.on('display-metrics-changed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
  });

  // Приложение живёт в трее, даже когда все окна закрыты.
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopWheelHook();
    localStt.stopServer();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}

module.exports = { isQuitting };

// Только для отладки в dev-режиме (--inspect).
if (isDev) {
  global.__pomogator = {
    screen,
    globalShortcut,
    get overlayWin() {
      return overlayWin;
    },
    get answerRegion() {
      return answerRegion;
    },
    get settings() {
      return settings;
    },
    get hotkeys() {
      return hotkeys.getStatus();
    },
    screenshots,
    warmUp,
  };
}
