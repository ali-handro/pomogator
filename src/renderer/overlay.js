'use strict';

const DEFAULT_SETTINGS = {
  provider: 'cloudflare',
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  cloudflareAccount: '',
  keys: {},
  style: 'concise',
  language: 'ru',
  answerWords: 45,
  clickThrough: true,
  audioSource: 'mic',
  overlayWidth: 980,
  overlayHeight: 232,
  hotkeys: { listen: 'Control+Space' },
};


const el = {
  card: document.getElementById('card'),
  statusText: document.getElementById('statusText'),
  latency: document.getElementById('latency'),
  question: document.getElementById('question'),
  hint: document.getElementById('hint'),
  answerText: document.getElementById('answerText'),
  answer: document.querySelector('.answer'),
  level: document.getElementById('level'),
  modelLabel: document.getElementById('modelLabel'),
  keysHint: document.getElementById('keysHint'),
  questionInput: document.getElementById('questionInput'),
  btnSource: document.getElementById('btnSource'),
  btnMic: document.getElementById('btnMic'),
  btnHistPrev: document.getElementById('btnHistPrev'),
  btnHistNext: document.getElementById('btnHistNext'),
  btnHistLatest: document.getElementById('btnHistLatest'),
  btnJumpLatest: document.getElementById('btnJumpLatest'),
  btnCapture: document.getElementById('btnCapture'),
  btnReview: document.getElementById('btnReview'),
  btnCopy: document.getElementById('btnCopy'),
  toast: document.getElementById('toast'),
  cloudBalance: document.getElementById('cloudBalance'),
  cloudSep: document.getElementById('cloudSep'),
  histCount: document.getElementById('histCount'),
  btnRegen: document.getElementById('btnRegen'),
  btnClear: document.getElementById('btnClear'),
  btnSettings: document.getElementById('btnSettings'),
  btnHide: document.getElementById('btnHide'),
};

const hasApi = typeof window.api !== 'undefined';

let settings = { ...DEFAULT_SETTINGS };
let state = 'idle';
let lastQuestion = '';
let askStartedAt = 0;

/* ------------------------------------------------------------------ */
/*  История ответов                                                    */
/* ------------------------------------------------------------------ */

const MAX_HISTORY = 40;
const answerHistory = [];
let historyIndex = -1;
let activeEntry = null;
let answerPinned = true;

/* ------------------------------------------------------------------ */
/*  Состояние                                                          */
/* ------------------------------------------------------------------ */

const STATE_TEXT = {
  idle: 'Готов',
  listening: 'Слушаю',
  hearing: 'Слышу речь',
  thinking: 'Думаю…',
  streaming: 'Отвечаю…',
  error: 'Ошибка',
};

function setState(next, text) {
  state = next;
  document.body.dataset.state = next;
  el.statusText.textContent = text || STATE_TEXT[next] || next;
  renderHistoryControls();
}

function setQuestion(text) {
  scheduleRegionUpdate();
  if (!text) {
    el.question.hidden = true;
    el.question.textContent = '';
    return;
  }
  el.question.hidden = false;
  el.question.textContent = text;
}

function clearAnswer() {
  document.body.classList.remove('has-answer');
  el.answerText.textContent = '';
  el.answerText.scrollTop = 0;
  answerPinned = true;
  el.latency.hidden = true;
  scheduleRegionUpdate();
}

function showAnswer(text) {
  document.body.classList.add('has-answer');
  el.answerText.textContent = text;
  answerPinned = true;
  el.answerText.scrollTop = 0;
  scheduleRegionUpdate();
}

function appendAnswer(text) {
  document.body.classList.add('has-answer');
  const pinned = answerPinned;

  el.answerText.textContent += text;

  // Пока пользователь не отлистал вверх, держим свежий текст внизу.
  if (pinned) el.answerText.scrollTop = el.answerText.scrollHeight;

  scheduleRegionUpdate();
}

/* ------------------------------------------------------------------ */
/*  Перемотка по прошлым ответам                                       */
/* ------------------------------------------------------------------ */

function renderHistoryControls() {
  scheduleRegionUpdate();

  if (!el.histCount || !el.btnHistPrev || !el.btnHistNext) return;

  const total = answerHistory.length;
  el.histCount.textContent = total ? `${historyIndex + 1}/${total}` : '0/0';

  el.btnHistPrev.disabled = historyIndex <= 0;
  el.btnHistNext.disabled = historyIndex < 0 || historyIndex >= total - 1;
  if (el.btnHistLatest) el.btnHistLatest.disabled = !total || historyIndex >= total - 1;

  const browsing = total > 0 && historyIndex < total - 1;
  document.body.classList.toggle('browsing', browsing);
  if (el.btnJumpLatest) el.btnJumpLatest.disabled = !browsing;
}

/* Область текста ответа: пока курсор над ней, главный процесс перехватывает
   колесо мыши (в режиме суфлёра окно иначе сквозное для мыши). */
let regionFrame = 0;

function pushAnswerRegion() {
  regionFrame = 0;
  if (!hasApi || !window.api.setAnswerRegion) return;

  const hasAnswer = document.body.classList.contains('has-answer');
  if (!hasAnswer) {
    window.api.setAnswerRegion(null);
    return;
  }

  const rects = [(el.answer || el.answerText).getBoundingClientRect()];
  if (el.btnJumpLatest && document.body.classList.contains('browsing')) {
    rects.push(el.btnJumpLatest.getBoundingClientRect());
  }

  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));

  if (right - left < 2 || bottom - top < 2) {
    window.api.setAnswerRegion(null);
    return;
  }

  window.api.setAnswerRegion({
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
    navigable: true,
  });
}

function scheduleRegionUpdate() {
  if (regionFrame) return;
  regionFrame = requestAnimationFrame(pushAnswerRegion);
}

function renderEntry(entry) {
  clearAnswer();
  if (!entry) {
    setQuestion('');
    return;
  }

  lastQuestion = entry.question || '';
  setQuestion(entry.question ? `— ${entry.question}` : '');

  if (entry.answer) showAnswer(entry.answer);

  if (entry.latency) {
    el.latency.hidden = false;
    el.latency.textContent = entry.latency;
  }
}

function restoreStatus(entry, force = false) {
  if (entry && entry.state === 'error' && entry.error) {
    setState('error', entry.error);
    return;
  }
  if (force || (state !== 'thinking' && state !== 'streaming')) resumeState();
}

function showHistory(index) {
  if (!answerHistory.length) return;

  historyIndex = Math.max(0, Math.min(answerHistory.length - 1, index));
  const entry = answerHistory[historyIndex];
  renderEntry(entry);
  restoreStatus(entry);
  renderHistoryControls();
}

function prevAnswer() {
  showHistory(historyIndex - 1);
}

function nextAnswer() {
  showHistory(historyIndex + 1);
}

function latestAnswer() {
  if (!answerHistory.length) return;
  showHistory(answerHistory.length - 1);
}

/* Колесо мыши и стрелки работают только над текстом ответа. */
const WHEEL_STEP = 40;
const SCROLL_STEP = 80;
let wheelAccum = 0;
let wheelLockUntil = 0;
// Глобальный хук в главном процессе уже перелистнул — не дублируем.
let wheelSuppressUntil = 0;

/** Прокрутить текст ответа. false — прокручивать нечего, можно листать историю. */
function scrollAnswerBy(delta) {
  const box = el.answerText;
  if (!el.answerText || box.scrollHeight <= box.clientHeight + 1) return false;

  const before = box.scrollTop;
  box.scrollTop = before + delta;
  if (box.scrollTop === before) return false;

  answerPinned = box.scrollHeight - box.scrollTop - box.clientHeight < 12;
  scheduleRegionUpdate();
  return true;
}

function onAnswerWheel(event) {
  event.preventDefault();

  if (Date.now() < wheelSuppressUntil) return;

  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  const delta = event.deltaY * scale;

  // Сначала листаем длинный ответ, и только на краю — историю.
  if (scrollAnswerBy(delta)) {
    wheelAccum = 0;
    if (hasApi && window.api.noteWheelHandled) window.api.noteWheelHandled();
    return;
  }

  if (!answerHistory.length) return;

  const now = performance.now();
  if (now < wheelLockUntil) return;

  wheelAccum += delta;
  if (Math.abs(wheelAccum) < WHEEL_STEP) return;

  const direction = wheelAccum < 0 ? -1 : 1;
  wheelAccum = 0;
  wheelLockUntil = now + 150;

  // Сообщаем главному процессу, что колесо уже обработано здесь.
  if (hasApi && window.api.noteWheelHandled) window.api.noteWheelHandled();

  if (direction < 0) prevAnswer();
  else nextAnswer();
}

function onAnswerKeydown(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (!answerHistory.length) return;

  const target = event.target;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (!el.answer.matches(':hover')) return;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    prevAnswer();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    nextAnswer();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    latestAnswer();
  }
}

function clearCurrent() {
  const displayed = answerHistory[historyIndex] || null;

  // Останавливаем генерацию, только если чистим именно текущий (живой) ответ.
  const aborted = !!(activeEntry && displayed === activeEntry);
  if (aborted) {
    if (hasApi) window.api.abort();
    activeEntry = null;
  }

  if (historyIndex >= 0 && historyIndex < answerHistory.length) {
    answerHistory.splice(historyIndex, 1);
  }

  lastQuestion = '';

  if (!answerHistory.length) {
    historyIndex = -1;
    clearAnswer();
    setQuestion('');
    restoreStatus(null, aborted);
  } else {
    historyIndex = Math.max(0, Math.min(historyIndex, answerHistory.length - 1));
    const entry = answerHistory[historyIndex];
    renderEntry(entry);
    restoreStatus(entry, aborted);
  }

  renderHistoryControls();
}

/* ------------------------------------------------------------------ */
/*  Запрос к модели                                                    */
/* ------------------------------------------------------------------ */

function viewingPast() {
  return answerHistory.length > 0 && historyIndex < answerHistory.length - 1;
}

/**
 * Новый ответ. Если пользователь вручную ушёл в прошлые ответы, автоответ
 * (распознанная речь) пишется в историю, но не переключает то, что он читает.
 * Вопрос, введённый вручную или перегенерация, всегда показывается сразу.
 */
async function ask(question, options = {}) {
  if (!hasApi) {
    el.hint.textContent = 'Нет доступа к API. Откройте настройки и проверьте ключ.';
    return;
  }
  if (!question) return;

  const manual = !!options.manual;
  const keepView = !manual && viewingPast();

  // Если прошлый ответ ещё писался, сохраняем то, что успело прийти.
  if (activeEntry && activeEntry.state === 'pending') {
    activeEntry.state = 'done';
    activeEntry = null;
  }

  if (!keepView) {
    clearAnswer();
    lastQuestion = question;
  }

  const entry = { question, answer: '', latency: '', state: 'pending', error: '' };
  answerHistory.push(entry);

  if (answerHistory.length > MAX_HISTORY) {
    answerHistory.shift();
    if (keepView) {
      const removedShown = historyIndex === 0;
      historyIndex = Math.max(0, historyIndex - 1);
      if (removedShown) renderEntry(answerHistory[historyIndex]);
    }
  }

  activeEntry = entry;

  if (!keepView) {
    historyIndex = answerHistory.length - 1;
    setQuestion(`— ${question}`);
  }

  renderHistoryControls();
  setState('thinking');
  askStartedAt = performance.now();

  try {
    const result = await window.api.ask(question);
    if (!result || result.ok || result.aborted) return;
    if (answerHistory[historyIndex] === entry) {
      setState('error', result.error || 'Не удалось получить ответ');
    }
  } catch (err) {
    if (answerHistory[historyIndex] === entry) setState('error', err.message);
  }
}

async function solveScreenshot(mode = 'solve') {
  if (!hasApi) return;

  const review = mode === 'review';
  const entry = {
    question: review ? '🔍 Код-ревью со скриншота' : '📷 Задача со скриншота',
    answer: '',
    latency: '',
    state: 'pending',
    error: '',
  };

  answerHistory.push(entry);
  if (answerHistory.length > MAX_HISTORY) answerHistory.shift();

  activeEntry = entry;
  historyIndex = answerHistory.length - 1;
  lastQuestion = '';
  renderEntry(entry);
  renderHistoryControls();
  setState('thinking', 'Смотрю экран…');
  askStartedAt = performance.now();

  try {
    const result = await window.api.captureSolve(mode);
    if (!result) return;

    if (result.cancelled) {
      // Выделение отменили — убираем пустую запись из истории.
      const at = answerHistory.indexOf(entry);
      if (at !== -1) answerHistory.splice(at, 1);

      activeEntry = null;
      historyIndex = Math.min(historyIndex, answerHistory.length - 1);

      if (historyIndex >= 0) {
        renderEntry(answerHistory[historyIndex]);
        restoreStatus(answerHistory[historyIndex], true);
      } else {
        clearAnswer();
        setQuestion('');
        resumeState();
      }
      renderHistoryControls();
      return;
    }

    if (!result.ok && !result.aborted) {
      if (answerHistory[historyIndex] === entry) setState('error', result.error || 'Не удалось');
    }
  } catch (err) {
    if (answerHistory[historyIndex] === entry) setState('error', err.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Копирование ответа                                                 */
/* ------------------------------------------------------------------ */

let toastTimer = 0;

function showToast(text) {
  if (!el.toast) return;

  el.toast.textContent = text;
  el.toast.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 1600);
}

async function copyAnswer() {
  const text = el.answerText.textContent.trim();

  if (!text) {
    showToast('Пока нечего копировать');
    return;
  }

  try {
    await window.api.copyText(text);
    showToast('Скопировано');
  } catch (err) {
    console.error('[copy]', err);
    showToast('Не удалось скопировать');
  }
}

/* ------------------------------------------------------------------ */
/*  Микрофон и распознавание речи                                      */
/* ------------------------------------------------------------------ */

const SAMPLE_RATE = 16000;
const VAD_THRESHOLD = 0.010;
const MAX_VAD_THRESHOLD = 0.024;
const PRE_ROLL_CHUNKS = 4; // ~500 мс до начала фразы
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 15000;
// Пауза, после которой фраза считается законченной. Чем короче, тем быстрее
// приходит ответ, но слишком короткая обрывает человека на середине мысли.
const SILENCE_MS = 450;

const stt = {
  ctx: null,
  stream: null,
  proc: null,
  source: null, // mic | system
  rate: 0,
  threshold: VAD_THRESHOLD,
  noiseFloor: 0.004,
  listening: true,
  pausedByUser: false,
  meetingPaused: false,
  inSpeech: false,
  lastVoiceAt: 0,
  tailChunks: 0,
  preRoll: [],
  segment: [],
  segmentMs: 0,
  queue: [],
  busy: false,
};

function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function encodeWav(chunks, srcRate, dstRate) {
  let frames = 0;
  for (const chunk of chunks) frames += chunk.length;

  const flat = new Float32Array(frames);
  let position = 0;
  for (const chunk of chunks) {
    flat.set(chunk, position);
    position += chunk.length;
  }

  // Приводим к 16 кГц: столько достаточно для речи и втрое меньше трафика.
  // Усреднение по окну заодно работает как простой фильтр от наложения частот.
  const outFrames = Math.max(1, Math.round((frames * dstRate) / srcRate));
  const ratio = frames / outFrames;
  const samples = new Float32Array(outFrames);

  for (let i = 0; i < outFrames; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(frames, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += flat[j];
    samples[i] = sum / (end - start);
  }

  const buffer = new ArrayBuffer(44 + outFrames * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + outFrames * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, dstRate, true);
  view.setUint32(28, dstRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, outFrames * 2, true);

  let offset = 44;
  for (let i = 0; i < outFrames; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function finishSegment() {
  let chunks = stt.segment;
  const ms = stt.segmentMs;
  const tail = stt.tailChunks || 0;

  stt.segment = [];
  stt.segmentMs = 0;
  stt.tailChunks = 0;
  stt.inSpeech = false;
  stt.preRoll = [];

  if (ms < MIN_SPEECH_MS || !chunks.length) {
    if (state === 'hearing') resumeState();
    return;
  }

  // Отрезаем «хвост» тишины: Whisper всё равно его отбрасывает, а платим
  // за каждый лишний кусок временем распознавания.
  if (tail > 1 && chunks.length > tail + 1) {
    chunks = chunks.slice(0, chunks.length - (tail - 1));
  }

  stt.queue.push(encodeWav(chunks, stt.rate || SAMPLE_RATE, SAMPLE_RATE));
  drainQueue();
}

/* Микрофон слышит и самого пользователя. Если распознанный текст почти
   дословно совпадает с тем, что сейчас на экране, это чтение ответа, а не
   новый вопрос — не запускаем по нему генерацию. */
function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, 4));
}

function looksLikeReading(text) {
  const spoken = wordsOf(text);
  if (spoken.length < 4) return false;

  const shown = wordsOf(el.answerText.textContent);
  if (shown.length < 4) return false;

  // Ищем достаточно длинный дословный фрагмент: при чтении вслух он
  // совпадает с текстом ответа, у нового вопроса такого совпадения нет.
  let best = 0;
  for (let i = 0; i < shown.length; i++) {
    for (let j = 0; j < spoken.length; j++) {
      let run = 0;
      while (
        i + run < shown.length &&
        j + run < spoken.length &&
        shown[i + run] === spoken[j + run]
      ) {
        run += 1;
      }
      if (run > best) best = run;
    }
  }

  return best >= 4;
}

let skippedTimer = 0;
let sttNoticeTimer = 0;

/* Whisper на тишине и шуме любит «додумывать» титры и подписи. Такие
   фразы не вопрос — не тратим на них модель. */
const STT_NOISE = [
  'субтитр',
  'продолжение следует',
  'спасибо за просмотр',
  'подписывайтесь',
  'ставьте лайк',
  'amara.org',
  'dimatorzok',
  'редактор субтитров',
  'корректор',
  'продолжение в следующей',
  'subtítulos',
  'subtitulos',
  'gracias por ver',
  'suscríbete',
  'suscribete',
  'suscribirte',
  'dale like',
  'comparte el video',
  'no olvides suscribirte',
  'hasta la próxima',
  'hasta la proxima',
];

function isSttNoise(text) {
  const low = String(text || '').toLowerCase();
  return STT_NOISE.some((fragment) => low.includes(fragment));
}

/**
 * Whisper на шуме иногда отвечает на другом языке — чаще всего испанским.
 * Отбрасываем только явно испанский текст: английские технические вопросы
 * и термины (Docker, Java, API) не трогаем.
 */
function isForeignText(text) {
  const value = String(text || '').trim();
  if (value.length < 8) return false;

  const cyrillic = (value.match(/[а-яё]/gi) || []).length;
  if (cyrillic > 0) return false;

  const latin = (value.match(/[a-z]/gi) || []).length;
  if (!latin) return false;

  // Явные признаки испанского: перевёрнутые знаки и «ñ».
  if (/[¿¡ñ]/i.test(value)) return true;

  const spanish =
    /\b(el|la|los|las|del|que|una|es|por|con|para|como|pero|más|este|esta|esto|muy|también|porque|cuando|donde|hay|puede|todo|nada|gracias|hola|usted|ustedes|nosotros|ellos|ella|tiene|tienen|hacer|ahora|bien|mal|suscríbete|subtítulos)\b/gi;

  const hits = (value.match(spanish) || []).length;
  if (hits >= 3) return true;

  // Длинная фраза без единого русского слова и без английских
  // терминов-вопросов — почти наверняка галлюцинация.
  const englishQuestion =
    /\b(what|why|how|when|where|which|who|is|are|does|do|can|could|would|should|the|and|with|between)\b/gi;
  const englishHits = (value.match(englishQuestion) || []).length;

  return value.length > 40 && hits >= 2 && englishHits < 2;
}

// Одна и та же фраза, услышанная дважды подряд, — почти всегда эхо.
let lastSpokenText = '';
let lastSpokenAt = 0;

function flashSkipped() {
  setState(stt.listening ? 'listening' : 'idle', 'Пропустил чтение');
  clearTimeout(skippedTimer);
  skippedTimer = setTimeout(() => {
    if (el.statusText.textContent === 'Пропустил чтение') resumeState();
  }, 1600);
}

async function drainQueue() {
  if (stt.busy) return;
  if (!stt.queue.length) {
    if (state === 'hearing') resumeState();
    return;
  }
  if (!hasApi) {
    stt.queue = [];
    return;
  }

  stt.busy = true;
  const audio = stt.queue.shift();
  setState('thinking', 'Распознаю…');

  try {
    const result = await window.api.transcribe(audio);
    if (!result || !result.ok) {
      if (result && result.error) {
        console.warn('[stt]', result.error);
        el.hint.textContent = result.error;
      }
      if (state === 'thinking') resumeState();
      return;
    }

    const text = String(result.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;

    const words = text.split(' ').filter(Boolean).length;
    // Совсем короткие обрывки («да», «ну») — шум. Однословный вопрос
    // («Почему?») уже пропускаем дальше.
    if (words < 2 && text.length < 4) {
      el.hint.textContent = `Услышал: «${text}»`;
      resumeState();
      return;
    }

    if (isSttNoise(text)) {
      console.log('[stt] шум/титры, пропускаю:', text);
      el.hint.textContent = `Пропустил шум: «${text}»`;
      resumeState();
      return;
    }

    const sttLanguage = (settings.stt && settings.stt.language) || settings.language || 'ru';
    if (sttLanguage === 'ru' && isForeignText(text)) {
      console.log('[stt] не русский текст, пропускаю:', text);
      el.hint.textContent = `Пропустил чужой язык: «${text.slice(0, 60)}»`;
      resumeState();
      return;
    }

    const now = Date.now();
    if (text.toLowerCase() === lastSpokenText && now - lastSpokenAt < 8000) {
      console.log('[stt] повтор той же фразы, пропускаю');
      resumeState();
      return;
    }

    if (settings.autoAnswer !== false) {
      if (looksLikeReading(text)) {
        console.log('[stt] похоже на чтение ответа, пропускаю');
        flashSkipped();
        return;
      }
      lastSpokenText = text.toLowerCase();
      lastSpokenAt = now;
      ask(text);
    } else {
      // Автоответ выключен: показываем распознанное и кладём его в поле ввода,
      // чтобы отправить в модель можно было Enter или Ctrl+Shift+A.
      lastQuestion = text;
      setQuestion(`— ${text}`);
      el.questionInput.value = text;
      resumeState();
    }
  } catch (err) {
    console.error('[stt]', err);
    setState('error', err.message);
  } finally {
    stt.busy = false;
    if (stt.queue.length) drainQueue();
    else if (state === 'thinking') resumeState();
  }
}

function stopCapture() {
  if (stt.proc) {
    stt.proc.onaudioprocess = null;
    try {
      stt.proc.disconnect();
    } catch {
      /* уже отключён */
    }
  }
  if (stt.stream) {
    for (const track of stt.stream.getTracks()) track.stop();
  }
  if (stt.ctx) {
    try {
      stt.ctx.close();
    } catch {
      /* уже закрыт */
    }
  }

  stt.proc = null;
  stt.stream = null;
  stt.ctx = null;
  stt.rate = 0;
  stt.source = null;
  stt.inSpeech = false;
  stt.segment = [];
  stt.segmentMs = 0;
  stt.tailChunks = 0;
  stt.preRoll = [];
}

async function openStream(source) {
  if (source === 'system') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Захват звука системы не поддерживается');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    // Видео не нужно — оставляем только системный звук.
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }

    if (!stream.getAudioTracks().length) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('Система не отдала звук');
    }

    return stream;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Микрофон недоступен');
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function startCapture(source) {
  const wanted = source === 'system' ? 'system' : 'mic';
  if (stt.source === wanted && stt.ctx) return;

  stopCapture();
  stt.source = wanted;

  let stream;
  try {
    stream = await openStream(wanted);
  } catch (err) {
    console.error('[capture]', err);
    stt.source = null;

    if (wanted === 'system') {
      // Не получилось взять звук системы — не оставляем пользователя без суфлёра.
      el.hint.textContent = 'Не удалось взять звук системы — слушаю микрофон.';
      await startCapture('mic');
      return;
    }

    setState('error', 'Нет доступа к микрофону');
    el.hint.textContent =
      'Разрешите доступ: Параметры Windows → Конфиденциальность → Микрофон.';
    return;
  }

  try {
    stt.stream = stream;
    stt.ctx = new AudioContext();
    stt.rate = stt.ctx.sampleRate;
    stt.threshold = wanted === 'system' ? 0.008 : VAD_THRESHOLD;
    stt.noiseFloor = 0.004;
    if (stt.ctx.state === 'suspended') await stt.ctx.resume();

    const audioSource = stt.ctx.createMediaStreamSource(stt.stream);
    stt.proc = stt.ctx.createScriptProcessor(2048, 1, 1);

    stt.proc.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(input.length);
      chunk.set(input);
      onAudio(chunk);
    };

    audioSource.connect(stt.proc);
    stt.proc.connect(stt.ctx.destination);

    if (state !== 'thinking' && state !== 'streaming') resumeState();
  } catch (err) {
    console.error('[capture]', err);
    stopCapture();
    setState('error', 'Не удалось открыть аудио');
  }
}

/** Перезапускает захват только если источник действительно изменился. */
let captureChain = Promise.resolve();

function ensureSource() {
  const wanted = settings.audioSource === 'system' ? 'system' : 'mic';
  captureChain = captureChain
    .then(() => startCapture(wanted))
    .catch((err) => console.error('[capture]', err));
  return captureChain;
}

function onAudio(chunk) {
  const rms = rmsOf(chunk);
  const level = Math.min(1, rms * 9);
  el.level.style.setProperty('--lvl', level.toFixed(3));

  stt.peak = Math.max(stt.peak || 0, rms);
  const now = performance.now();
  if (now - (stt.lastLog || 0) > 3000) {
    stt.lastLog = now;
    console.log(`[audio:${stt.source}] peak rms ${stt.peak.toFixed(4)} rate ${stt.rate}`);
    stt.peak = 0;
  }

  if (!stt.listening) return;

  const chunkMs = (chunk.length / (stt.rate || SAMPLE_RATE)) * 1000;

  // Порог подстраивается под фон: тихую речь не теряем, а шум не считаем
  // началом фразы. Фон обновляем только на явной тишине.
  const baseThreshold = stt.threshold || VAD_THRESHOLD;
  if (!stt.inSpeech && rms < baseThreshold * 0.8) {
    const floor = Number(stt.noiseFloor) || 0.004;
    stt.noiseFloor = Math.min(baseThreshold * 1.6, floor * 0.95 + rms * 0.05);
  }

  const adaptive = Math.max(
    baseThreshold,
    Math.min(MAX_VAD_THRESHOLD, (Number(stt.noiseFloor) || 0.004) * 2.2)
  );
  const voiced = rms > adaptive;

  if (voiced) {
    if (!stt.inSpeech) {
      stt.inSpeech = true;
      stt.segment = stt.preRoll.slice();
      stt.segmentMs = stt.segment.length * chunkMs;
      stt.preRoll = [];
      if (state === 'listening' || state === 'idle') setState('hearing');
    }
    stt.lastVoiceAt = now;
    stt.tailChunks = 0;
    stt.segment.push(chunk);
    stt.segmentMs += chunkMs;

    if (stt.segmentMs >= MAX_UTTERANCE_MS) finishSegment();
    return;
  }

  if (stt.inSpeech) {
    stt.tailChunks = (stt.tailChunks || 0) + 1;
    stt.segment.push(chunk);
    stt.segmentMs += chunkMs;
    if (now - stt.lastVoiceAt > (Number(settings.silenceMs) || SILENCE_MS)) finishSegment();
    return;
  }

  stt.preRoll.push(chunk);
  if (stt.preRoll.length > PRE_ROLL_CHUNKS) stt.preRoll.shift();
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

function pauseHotkey() {
  return formatAccelerator(settings.hotkeys && settings.hotkeys.listen) || 'Ctrl+Space';
}

function renderMicButton() {
  const listening = stt.listening;
  el.btnMic.textContent = listening ? '▶' : '⏸';
  el.btnMic.title = `${listening ? 'Пауза' : 'Слушать'} (${pauseHotkey()})`;
  el.btnMic.classList.toggle('mic-live', listening);
  el.btnMic.classList.toggle('mic-paused', !listening);
}

function setListening(value, byUser = true) {
  stt.listening = !!value;
  if (byUser) stt.pausedByUser = !stt.listening;
  stt.inSpeech = false;
  stt.segment = [];
  stt.segmentMs = 0;
  stt.tailChunks = 0;
  stt.preRoll = [];
  document.body.dataset.listening = String(stt.listening);
  renderMicButton();

  if (!stt.listening) setState('idle', 'Пауза');
  else if (state === 'idle') setState('listening');
}

/** Вернуть «спокойное» состояние: слушаю или пауза. */
function resumeState() {
  if (!stt.listening) setState('idle', 'Пауза');
  else setState('listening');
}

/* ------------------------------------------------------------------ */
/*  Настройки и события                                                */
/* ------------------------------------------------------------------ */

function renderSourceButton() {
  const source = stt.source || (settings.audioSource === 'system' ? 'system' : 'mic');
  const system = source === 'system';
  el.btnSource.textContent = system ? '🎧' : '🎤';
  el.btnSource.title = system
    ? 'Источник: звук системы (браузер, созвон). Нажмите — переключить на микрофон'
    : 'Источник: микрофон. Нажмите — переключить на звук системы';
  el.btnSource.classList.toggle('active', system);
}

function applySettings() {
  const model = String((settings.ai && settings.ai.model) || '').split('/').pop() || '';
  el.modelLabel.textContent =
    model.replace(/-instruct.*$/, '').replace(/-fp8.*$/, '') || 'модель не выбрана';
  document.body.dataset.interactive = String(!settings.clickThrough);

  const alpha = Math.min(1, Math.max(0.3, Number(settings.opacity) || 0.94));
  document.documentElement.style.setProperty('--panel-alpha', String(alpha));
  renderSourceButton();
  renderMicButton();

  el.keysHint.textContent = settings.clickThrough
    ? `${pauseHotkey()} — пауза · Ctrl+Shift+Space — скрыть`
    : `Клик-режим · Ctrl+Shift+E — выключить · ${pauseHotkey()} — пауза`;

  const configured =
    !!(settings.ai && settings.ai.baseUrl && settings.ai.model) || !!settings.cloudMode;

  if (state === 'error') return;

  if (!configured) {
    el.hint.textContent =
      'Не настроено подключение. Трей → «Настройки» → укажите адрес API и модель.';
    if (stt.listening) setListening(false, false);
  } else {
    el.hint.textContent =
      stt.source === 'system'
        ? 'Слушаю звук системы: созвон в браузере, видео, плеер. Вопрос появится здесь.'
        : 'Слушаю микрофон. Задайте вопрос — ответ появится здесь.';
    if (!stt.listening && !stt.pausedByUser) setListening(true, false);
  }
}

/* ---------- баланс облака ---------- */

let cloudBalanceAt = 0;

async function refreshCloudBalance() {
  const box = el.cloudBalance;
  const sep = el.cloudSep;
  if (!box || !sep || !hasApi || !window.api.accountQuote) return;

  if (!settings.cloudMode) {
    box.hidden = true;
    sep.hidden = true;
    return;
  }

  try {
    const status = await window.api.accountStatus();
    if (!status || !status.loggedIn) {
      box.hidden = true;
      sep.hidden = true;
      return;
    }
  } catch {
    box.hidden = true;
    sep.hidden = true;
    return;
  }

  try {
    const quote = await window.api.accountQuote('interview');

    if (!quote || !quote.ok) {
      box.hidden = true;
      sep.hidden = true;
      return;
    }

    const minutes = Math.max(0, Math.floor(quote.remainingSeconds / 60));

    box.textContent = `облако: ${minutes} мин`;
    box.classList.toggle('low', minutes < 5);
    box.hidden = false;
    sep.hidden = false;
    cloudBalanceAt = Date.now();
  } catch {
    box.hidden = true;
    sep.hidden = true;
  }
}

function scheduleCloudBalance() {
  if (Date.now() - cloudBalanceAt < 30000) return;
  refreshCloudBalance();
}

async function toggleSource() {
  const next = stt.source === 'system' ? 'mic' : 'system';
  settings.audioSource = next;
  applySettings();
  await ensureSource();
  renderSourceButton();

  if (hasApi) {
    try {
      settings = await window.api.saveSettings({ audioSource: next });
    } catch (err) {
      console.error('[settings]', err);
    }
  }

  applySettings();
}

function bindResizeHandles() {
  let resizeState = null;

  const finish = () => {
    if (!resizeState) return;
    resizeState = null;
    if (hasApi) window.api.resizeEnd();
  };

  document.querySelectorAll('.rz').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || resizeState) return;
      event.preventDefault();
      event.stopPropagation();

      resizeState = {
        dir: handle.dataset.dir,
        startX: event.screenX,
        startY: event.screenY,
      };

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        // не критично — размер всё равно ведёт главный процесс
      }

      if (hasApi) window.api.resizeStart(resizeState.dir);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!resizeState) return;
      event.preventDefault();
      if (!hasApi) return;

      window.api.resizeMove({
        dx: event.screenX - resizeState.startX,
        dy: event.screenY - resizeState.startY,
      });
    });
  });

  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  window.addEventListener('blur', finish);
}

function bindUi() {
  el.btnMic.addEventListener('click', () => setListening(!stt.listening));
  el.btnSource.addEventListener('click', toggleSource);
  el.btnHistPrev.addEventListener('click', prevAnswer);
  el.btnHistNext.addEventListener('click', nextAnswer);
  if (el.btnHistLatest) el.btnHistLatest.addEventListener('click', latestAnswer);
  if (el.btnJumpLatest) el.btnJumpLatest.addEventListener('click', latestAnswer);

  (el.answer || el.answerText).addEventListener('wheel', onAnswerWheel, { passive: false });
  el.answerText.addEventListener(
    'scroll',
    () => {
      answerPinned =
        el.answerText.scrollHeight - el.answerText.scrollTop - el.answerText.clientHeight < 12;
    },
    { passive: true }
  );
  document.addEventListener('keydown', onAnswerKeydown);
  window.addEventListener('resize', scheduleRegionUpdate);
  el.btnRegen.addEventListener('click', () => {
    if (lastQuestion) ask(lastQuestion, { manual: true });
  });
  if (el.btnCapture) el.btnCapture.addEventListener('click', () => solveScreenshot('solve'));
  if (el.btnReview) el.btnReview.addEventListener('click', () => solveScreenshot('review'));

  // Греем захват экрана, пока курсор идёт к кнопке: окно выделения
  // появится почти сразу.
  for (const button of [el.btnCapture, el.btnReview]) {
    if (!button) continue;
    button.addEventListener('pointerenter', () => {
      if (typeof window.api.captureWarmup === 'function') window.api.captureWarmup();
    });
  }
  if (el.btnCopy) el.btnCopy.addEventListener('click', copyAnswer);
  el.btnClear.addEventListener('click', clearCurrent);
  el.btnHide.addEventListener('click', () => {
    if (hasApi) window.api.hideOverlay();
  });
  el.btnSettings.addEventListener('click', () => {
    if (hasApi) window.api.openSettings();
  });

  el.questionInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const value = el.questionInput.value.trim();
    if (!value) return;
    el.questionInput.value = '';
    ask(value, { manual: true });
  });

  bindResizeHandles();
}

function bindIpc() {
  if (!hasApi) return;

  window.api.onSettingsChanged((next) => {
    settings = next;
    applySettings();
    ensureSource();
    refreshCloudBalance();
  });

  if (window.api.onCloudUsage) {
    window.api.onCloudUsage(() => scheduleCloudBalance());
  }

  window.api.onClickThrough((value) => {
    document.body.dataset.interactive = String(!value);
  });

  // Главный процесс обработал колесо глобальным хуком — не листаем второй раз.
  if (window.api.onWheelConsumed) {
    window.api.onWheelConsumed(() => {
      wheelSuppressUntil = Date.now() + 250;
    });
  }

  // Главный процесс сам переключился на резервную модель распознавания.
  window.api.onSttNotice((text) => {
    el.hint.textContent = text;
    clearTimeout(sttNoticeTimer);
    sttNoticeTimer = setTimeout(() => {
      if (el.hint.textContent === text) applySettings();
    }, 6000);
  });

  // Пока идёт запись встречи, суфлёр не слушает микрофон.
  window.api.onMeetingRecording((value) => {
    if (value) {
      stt.meetingPaused = stt.listening;
      if (stt.listening) setListening(false, false);
    } else if (stt.meetingPaused) {
      stt.meetingPaused = false;
      if (!stt.pausedByUser) setListening(true, false);
    }
  });

  window.api.onLlmStart(() => setState('streaming'));
  window.api.onLlmDelta((text) => {
    if (!activeEntry || activeEntry.state !== 'pending') return;
    activeEntry.answer += text;
    if (answerHistory[historyIndex] === activeEntry) appendAnswer(text);
  });
  window.api.onLlmDone(() => {
    const displayed = activeEntry && answerHistory[historyIndex] === activeEntry;

    let latency = '';
    if (askStartedAt) {
      const seconds = (performance.now() - askStartedAt) / 1000;
      latency = `${seconds.toFixed(1)} с`;
    }

    if (activeEntry) {
      activeEntry.state = 'done';
      activeEntry.latency = latency || activeEntry.latency;
    }

    if (displayed && latency) {
      el.latency.hidden = false;
      el.latency.textContent = latency;
    }

    activeEntry = null;

    const current = answerHistory[historyIndex];
    restoreStatus(current, true);

    renderHistoryControls();
  });
  window.api.onLlmError((message) => {
    const displayed = activeEntry && answerHistory[historyIndex] === activeEntry;

    if (activeEntry) {
      activeEntry.state = 'error';
      activeEntry.error = message;
    }

    if (displayed) {
      setState('error', message);
    }

    activeEntry = null;

    const current = answerHistory[historyIndex];
    restoreStatus(current, true);

    renderHistoryControls();
  });

  window.api.onAction('answer', () => {
    const typed = el.questionInput.value.trim();
    if (!typed) return;
    el.questionInput.value = '';
    ask(typed, { manual: true });
  });
  window.api.onAction('regenerate', () => {
    if (lastQuestion) ask(lastQuestion, { manual: true });
  });
  window.api.onAction('clear', () => clearCurrent());
  window.api.onAction('capture', () => solveScreenshot('solve'));
  window.api.onAction('review', () => solveScreenshot('review'));
  window.api.onAction('listen', () => setListening(!stt.listening));
  window.api.onAction('history-prev', prevAnswer);
  window.api.onAction('history-next', nextAnswer);
  window.api.onAction('history-latest', latestAnswer);
  window.api.onAction('scroll-up', () => {
    if (!scrollAnswerBy(-SCROLL_STEP)) prevAnswer();
  });
  window.api.onAction('scroll-down', () => {
    if (!scrollAnswerBy(SCROLL_STEP)) nextAnswer();
  });
}

async function boot() {
  bindUi();
  bindIpc();

  if (hasApi) {
    try {
      settings = await window.api.getSettings();
    } catch (err) {
      console.error('[settings]', err);
    }
  }

  // Оверлей стартует на паузе: прослушивание включает сам пользователь.
  stt.pausedByUser = true;
  setListening(false, true);

  applySettings();
  await ensureSource();
  setListening(false, true);
  applySettings();

  refreshCloudBalance();
  setInterval(refreshCloudBalance, 60000);

  if (!hasApi) {
    el.hint.textContent = 'Это предпросмотр без доступа к API.';
  }
}

window.addEventListener('DOMContentLoaded', boot);

// Удобно дергать из DevTools.
window.__pomogator = {
  setState,
  get state() {
    return state;
  },
};
