'use strict';

const $ = (id) => document.getElementById(id);

const OUT_RATE = 16000;
const MAX_SEGMENT_MS = 15000;
const SILENCE_MS = 650;
const PRE_ROLL_CHUNKS = 3;

const state = {
  running: false,
  startedAt: 0,
  elapsed: 0,
  timerId: 0,
  entries: [],
  summary: '',
  ctx: null,
  streams: [],
  channels: null,
  loadedFile: null,
};

/* ------------------------------------------------------------------ */
/*  Аудио                                                              */
/* ------------------------------------------------------------------ */

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

function makeChannel(speaker, threshold, levelId) {
  return {
    speaker,
    threshold,
    levelId,
    preRoll: [],
    segment: [],
    segmentMs: 0,
    inSpeech: false,
    lastVoiceAt: 0,
    startAt: 0,
    lastText: '',
    queue: [],
    busy: false,
  };
}

function updateLevel(channel, rms) {
  const el = $(channel.levelId);
  if (!el) return;
  el.style.width = `${Math.min(100, Math.round(rms * 900))}%`;
}

function onAudio(channel, chunk) {
  const rms = rmsOf(chunk);
  updateLevel(channel, rms);

  const chunkMs = (chunk.length / state.ctx.sampleRate) * 1000;
  const voiced = rms > channel.threshold;

  if (voiced) {
    if (!channel.inSpeech) {
      channel.inSpeech = true;
      channel.segment = channel.preRoll.slice();
      channel.segmentMs = channel.segment.length * chunkMs;
      channel.preRoll = [];
      channel.startAt = Math.max(0, state.elapsed - channel.segmentMs / 1000);
    }
    channel.lastVoiceAt = performance.now();
    channel.segment.push(chunk);
    channel.segmentMs += chunkMs;
    if (channel.segmentMs >= MAX_SEGMENT_MS) flush(channel);
    return;
  }

  if (channel.inSpeech) {
    channel.segment.push(chunk);
    channel.segmentMs += chunkMs;
    if (performance.now() - channel.lastVoiceAt > SILENCE_MS) flush(channel);
    return;
  }

  channel.preRoll.push(chunk);
  if (channel.preRoll.length > PRE_ROLL_CHUNKS) channel.preRoll.shift();
}

function flush(channel) {
  const chunks = channel.segment;
  const ms = channel.segmentMs;
  const startAt = channel.startAt;

  channel.segment = [];
  channel.segmentMs = 0;
  channel.inSpeech = false;
  channel.preRoll = [];

  if (ms < 400 || !chunks.length) return;

  channel.queue.push({ wav: encodeWav(chunks, state.ctx.sampleRate, OUT_RATE), startAt });
  drain(channel);
}

function engineOverride() {
  if ($('engine').value === 'local') return { provider: 'local', model: 'base', kind: 'meeting' };
  return { model: '@cf/openai/whisper-large-v3-turbo', kind: 'meeting' };
}

async function drain(channel) {
  if (channel.busy) return;

  const item = channel.queue.shift();
  if (!item) return;

  channel.busy = true;

  try {
    const result = await window.api.transcribe(item.wav, engineOverride());
    const text = String((result && result.text) || '').trim();

    if (result && result.ok && text && !isNoise(text)) {
      const key = text.toLowerCase();
      if (key !== channel.lastText) {
        channel.lastText = key;
        addEntry(item.startAt, channel.speaker, text);
      }
    } else if (result && result.error) {
      setStatus(`Распознавание: ${result.error}`);
    }
  } catch (err) {
    setStatus(`Распознавание: ${err.message}`);
  } finally {
    channel.busy = false;
    if (channel.queue.length) drain(channel);
  }
}

/* ------------------------------------------------------------------ */
/*  Интерфейс                                                          */
/* ------------------------------------------------------------------ */

// Whisper на тишине любит «додумывать» титры — такие фразы не пишем.
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
  'титры',
];

function isNoise(text) {
  const low = String(text || '').toLowerCase();
  return STT_NOISE.some((fragment) => low.includes(fragment));
}

function setStatus(text) {
  $('status').textContent = text || '';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderEntry(entry) {
  const empty = $('empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `entry ${entry.speaker === 'Вы' ? 'me' : 'them'}`;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(entry.t);

  const speaker = document.createElement('span');
  speaker.className = 'speaker';
  speaker.textContent = entry.speaker;

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = entry.text;

  row.append(time, speaker, text);

  const transcript = $('transcript');
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
}

function addEntry(at, speaker, text) {
  const entry = { t: Math.max(0, Math.round(at)), speaker, text: text.trim() };
  state.entries.push(entry);
  state.entries.sort((a, b) => a.t - b.t);
  renderEntry(entry);
  $('btnExport').disabled = false;
  $('btnClear').disabled = false;
  $('btnSummary').disabled = false;
}

function renderSummary(text) {
  $('summaryText').textContent = text;
  $('summaryBox').hidden = false;
}

async function makeSummary() {
  if (!state.entries.length) return;

  $('btnSummary').disabled = true;
  setStatus('Делаю выжимку…');

  try {
    const result = await window.api.meetingSummary({ entries: state.entries });

    if (result && result.ok && result.summary) {
      state.summary = result.summary;
      renderSummary(result.summary);
      setStatus('Выжимка готова');
      await saveMeeting();
    } else {
      setStatus((result && result.error) || 'Не удалось сделать выжимку');
    }
  } catch (err) {
    setStatus(`Выжимка: ${err.message}`);
  } finally {
    $('btnSummary').disabled = state.entries.length === 0;
  }
}

function tick() {
  state.elapsed = (Date.now() - state.startedAt) / 1000;
  $('timer').textContent = formatTime(state.elapsed);
}

/* ------------------------------------------------------------------ */
/*  Старт и стоп                                                       */
/* ------------------------------------------------------------------ */

function connect(stream, channel) {
  const source = state.ctx.createMediaStreamSource(stream);
  const proc = state.ctx.createScriptProcessor(2048, 1, 1);

  proc.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const chunk = new Float32Array(input.length);
    chunk.set(input);
    onAudio(channel, chunk);
  };

  source.connect(proc);
  proc.connect(state.ctx.destination);
  channel.proc = proc;
  channel.source = source;
}

async function start() {
  if (state.running) return;

  // Открытую прошлую запись не дописываем — начинаем новую встречу.
  if (state.loadedFile) clear();

  let micStream = null;
  let sysStream = null;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    setStatus('Нет доступа к микрофону — проверьте разрешения Windows');
    return;
  }

  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    for (const track of sysStream.getVideoTracks()) {
      track.stop();
      sysStream.removeTrack(track);
    }
    if (!sysStream.getAudioTracks().length) throw new Error('система не отдала звук');
  } catch (err) {
    if (sysStream) for (const track of sysStream.getTracks()) track.stop();
    sysStream = null;
    setStatus('Звук системы недоступен — пишу только микрофон');
  }

  const ctx = new AudioContext();
  state.ctx = ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  state.channels = {
    me: makeChannel('Вы', 0.012, 'levelMe'),
    them: makeChannel('Собеседник', 0.008, 'levelThem'),
  };

  state.streams = [micStream, sysStream].filter(Boolean);

  connect(micStream, state.channels.me);
  if (sysStream) connect(sysStream, state.channels.them);

  state.running = true;
  state.startedAt = Date.now();
  state.elapsed = 0;
  tick();
  state.timerId = setInterval(tick, 1000);

  document.body.classList.add('recording');
  $('recordLabel').textContent = 'Остановить';
  $('btnRecords').disabled = true;
  setStatus('Идёт запись — говорите как обычно');

  if (window.api.setMeetingRecording) window.api.setMeetingRecording(true);
}

function disconnect() {
  if (state.channels) {
    for (const channel of Object.values(state.channels)) {
      if (channel.proc) {
        channel.proc.onaudioprocess = null;
        try {
          channel.proc.disconnect();
        } catch {
          /* уже отключён */
        }
      }
      if (channel.source) {
        try {
          channel.source.disconnect();
        } catch {
          /* уже отключён */
        }
      }
    }
  }

  for (const stream of state.streams) {
    for (const track of stream.getTracks()) track.stop();
  }
  state.streams = [];

  if (state.ctx) {
    try {
      state.ctx.close();
    } catch {
      /* уже закрыт */
    }
  }
  state.ctx = null;
}

async function waitQueues() {
  const deadline = Date.now() + 60000;

  for (;;) {
    const busy = state.channels
      ? Object.values(state.channels).some((ch) => ch.busy || ch.queue.length)
      : false;
    if (!busy || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function stop() {
  if (!state.running) return;

  state.running = false;
  clearInterval(state.timerId);

  for (const channel of Object.values(state.channels || {})) flush(channel);

  disconnect();

  document.body.classList.remove('recording');
  $('recordLabel').textContent = 'Записать';
  $('btnRecords').disabled = false;
  $('timer').textContent = formatTime(state.elapsed);
  setStatus('Сохраняю расшифровку…');

  if (window.api.setMeetingRecording) window.api.setMeetingRecording(false);

  await waitQueues();

  if (state.entries.length) {
    const saved = await saveMeeting();
    setStatus(saved ? 'Расшифровка сохранена' : 'Не удалось сохранить');
  } else {
    setStatus('Речь не распознана');
  }

  $('btnExport').disabled = state.entries.length === 0;
  $('btnClear').disabled = state.entries.length === 0;
}

async function saveMeeting() {
  if (!state.entries.length) return false;

  try {
    const result = await window.api.meetingSave({
      startedAt: state.startedAt,
      duration: Math.round(state.elapsed),
      entries: state.entries,
      summary: state.summary,
    });
    return !!(result && result.ok);
  } catch (err) {
    console.error('[meeting] save failed', err);
    return false;
  }
}

function clear() {
  state.entries = [];
  state.summary = '';
  state.loadedFile = null;
  $('summaryBox').hidden = true;
  $('summaryText').textContent = '';
  $('transcript').innerHTML =
    '<p class="empty" id="empty">Нажмите «Записать» — Помогатор запишет микрофон и звук системы, а здесь появится расшифровка с разделением на вас и собеседника. Аудио нигде не сохраняется.</p>';
  $('btnExport').disabled = true;
  $('btnClear').disabled = true;
  $('btnSummary').disabled = true;
  setStatus('');
}

/* ------------------------------------------------------------------ */
/*  Экспорт и выжимка                                                  */
/* ------------------------------------------------------------------ */

async function exportMarkdown() {
  if (!state.entries.length) return;

  try {
    const result = await window.api.meetingExport({
      startedAt: state.startedAt,
      duration: Math.round(state.elapsed),
      entries: state.entries,
      summary: state.summary,
    });
    if (result && result.ok) setStatus(`Сохранено: ${result.path}`);
    else if (result && result.error) setStatus(result.error);
  } catch (err) {
    setStatus(`Экспорт: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Записи прошлых встреч                                              */
/* ------------------------------------------------------------------ */

let recordsCache = [];

function formatDate(ms) {
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function openRecords() {
  if (state.running) return;

  $('recordsPanel').hidden = false;
  $('recordsSearch').value = '';
  await loadRecords();
  $('recordsSearch').focus();
}

async function loadRecords() {
  const list = $('recordsList');
  list.innerHTML = '<div class="records-empty">Загружаю…</div>';

  try {
    const result = await window.api.meetingsList();
    recordsCache = (result && result.items) || [];
    renderRecords();
  } catch (err) {
    list.innerHTML = `<div class="records-empty">Не удалось прочитать записи: ${err.message}</div>`;
  }
}

function renderRecords() {
  const list = $('recordsList');
  const query = $('recordsSearch').value.trim().toLowerCase();
  list.innerHTML = '';

  const items = recordsCache.filter((item) => {
    if (!query) return true;
    return (
      String(item.preview || '').toLowerCase().includes(query) ||
      String(item.summary || '').toLowerCase().includes(query) ||
      formatDate(item.startedAt).toLowerCase().includes(query)
    );
  });

  if (!items.length) {
    const text = recordsCache.length
      ? 'Ничего не найдено'
      : 'Пока нет сохранённых встреч. Запишите первую — она появится здесь.';
    list.innerHTML = `<div class="records-empty">${text}</div>`;
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'record-row';

    const main = document.createElement('div');
    main.className = 'record-main';

    const date = document.createElement('div');
    date.className = 'record-date';
    date.textContent = formatDate(item.startedAt);

    const meta = document.createElement('div');
    meta.className = 'record-meta';
    const parts = [formatTime(item.duration), `${item.entries} реплик`];
    if (item.summary) parts.push('есть выжимка');
    meta.textContent = parts.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'record-preview';
    preview.textContent = item.preview || 'Без текста';

    main.append(date, meta, preview);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'record-del';
    del.textContent = '✕';
    del.title = 'Удалить запись';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      removeRecord(item);
    });

    row.append(main, del);
    row.addEventListener('click', () => openRecord(item.file));
    list.appendChild(row);
  }
}

async function openRecord(file) {
  try {
    const result = await window.api.meetingRead(file);

    if (!result || !result.ok) {
      setStatus((result && result.error) || 'Не удалось открыть запись');
      return;
    }

    state.entries = result.entries;
    state.summary = result.summary;
    state.startedAt = result.startedAt;
    state.elapsed = result.duration;
    state.loadedFile = file;

    $('timer').textContent = formatTime(result.duration);

    const transcript = $('transcript');
    transcript.innerHTML = '';

    if (!state.entries.length) {
      transcript.innerHTML = '<p class="empty">В этой записи нет расшифровки.</p>';
    } else {
      for (const entry of state.entries) renderEntry(entry);
    }

    if (state.summary) renderSummary(state.summary);
    else $('summaryBox').hidden = true;

    $('btnExport').disabled = !state.entries.length;
    $('btnClear').disabled = !state.entries.length;
    $('btnSummary').disabled = !state.entries.length;

    $('recordsPanel').hidden = true;
    setStatus(`Открыта запись от ${formatDate(result.startedAt)}`);
  } catch (err) {
    setStatus(`Записи: ${err.message}`);
  }
}

async function removeRecord(item) {
  const ok = window.confirm(`Удалить запись от ${formatDate(item.startedAt)}? Это необратимо.`);
  if (!ok) return;

  try {
    const result = await window.api.meetingRemove(item.file);

    if (result && result.ok) {
      recordsCache = recordsCache.filter((row) => row.file !== item.file);
      renderRecords();
      setStatus('Запись удалена');
    } else {
      setStatus((result && result.error) || 'Не удалось удалить запись');
    }
  } catch (err) {
    setStatus(`Удаление: ${err.message}`);
  }
}

function boot() {
  $('btnRecord').addEventListener('click', () => {
    if (state.running) stop();
    else start();
  });

  $('btnClose').addEventListener('click', () => window.close());
  $('btnExport').addEventListener('click', exportMarkdown);
  $('btnClear').addEventListener('click', clear);
  $('btnSummary').addEventListener('click', makeSummary);
  $('btnSummaryClose').addEventListener('click', () => {
    $('summaryBox').hidden = true;
  });

  $('btnRecords').addEventListener('click', openRecords);
  $('btnRecordsClose').addEventListener('click', () => {
    $('recordsPanel').hidden = true;
  });
  $('recordsSearch').addEventListener('input', renderRecords);

  window.addEventListener('beforeunload', () => {
    if (state.running) {
      clearInterval(state.timerId);
      disconnect();
      if (window.api.setMeetingRecording) window.api.setMeetingRecording(false);
    }
  });
}

window.addEventListener('DOMContentLoaded', boot);
