'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { app, net: electronNet } = require('electron');

/**
 * Локальное распознавание речи через whisper.cpp.
 *
 * Движок и модель не входят в сборку: они скачиваются по кнопке в настройках
 * в %APPDATA%\Pomogator\whisper. Модель остаётся загруженной в памяти
 * (whisper-server), поэтому на распознавание уходит только инференс.
 */

const ENGINE_BUILD = 'b5454';
const ENGINE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${ENGINE_BUILD}/whisper-bin-x64.zip`;

const MODELS = {
  base: {
    label: 'base — быстрая',
    hint: '≈60 МБ, ответ за ~0,8 с',
    file: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
  },
  small: {
    label: 'small — точнее',
    hint: '≈190 МБ, ответ за ~2,7 с',
    file: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  },
};

function rootDir() {
  return path.join(app.getPath('userData'), 'whisper');
}

function engineDir() {
  return path.join(rootDir(), 'engine');
}

function modelDir() {
  return path.join(rootDir(), 'models');
}

function modelPath(size) {
  const model = MODELS[size] || MODELS.base;
  return path.join(modelDir(), model.file);
}

/** whisper-server.exe лежит внутри папки Release после распаковки архива. */
function findServerExe(dir) {
  if (!fs.existsSync(dir)) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'whisper-server.exe') return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findServerExe(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

function serverExe() {
  return findServerExe(engineDir());
}

function modelReady(size) {
  const file = modelPath(size);
  try {
    const stat = fs.statSync(file);
    return stat.size > 1024 * 1024;
  } catch {
    return false;
  }
}

function status(settings) {
  const size = settings && settings.localSttModel === 'small' ? 'small' : 'base';
  const exe = serverExe();
  return {
    engine: !!exe,
    model: modelReady(size),
    modelSize: size,
    running: !!server && serverPort > 0,
    models: Object.entries(MODELS).map(([id, info]) => ({
      id,
      label: info.label,
      hint: info.hint,
      ready: modelReady(id),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Скачивание                                                         */
/* ------------------------------------------------------------------ */

let downloadJob = null;

async function downloadFile(url, target, onProgress) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;

  const res = await electronNet.fetch(url, {
    headers: { 'User-Agent': 'Pomogator/0.1.0 (overlay assistant)' },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const out = fs.createWriteStream(partial);
  let received = 0;

  try {
    for (;;) {
      if (downloadJob && downloadJob.cancelled) {
        await reader.cancel().catch(() => {});
        throw new Error('Скачивание отменено');
      }

      const { done, value } = await reader.read();
      if (done) break;

      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      if (onProgress) onProgress(received, total);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  fs.renameSync(partial, target);
  return received;
}

function extractZip(zip, target) {
  fs.mkdirSync(target, { recursive: true });
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${target}' -Force`,
    ],
    { windowsHide: true, encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(`Не удалось распаковать движок: ${(result.stderr || '').slice(0, 160)}`);
  }
}

async function download({ size = 'base', onProgress } = {}) {
  const model = MODELS[size] || MODELS.base;
  downloadJob = { cancelled: false };

  try {
    if (!serverExe()) {
      const zip = path.join(rootDir(), 'whisper-engine.zip');
      if (onProgress) onProgress({ stage: 'engine', received: 0, total: 0 });
      await downloadFile(ENGINE_URL, zip, (received, total) => {
        if (onProgress) onProgress({ stage: 'engine', received, total });
      });
      if (downloadJob.cancelled) throw new Error('Скачивание отменено');
      if (onProgress) onProgress({ stage: 'unpack', received: 0, total: 0 });
      extractZip(zip, engineDir());
      fs.unlinkSync(zip);
    }

    if (!modelReady(size)) {
      if (onProgress) onProgress({ stage: 'model', received: 0, total: 0 });
      await downloadFile(model.url, modelPath(size), (received, total) => {
        if (onProgress) onProgress({ stage: 'model', received, total });
      });
    }

    if (onProgress) onProgress({ stage: 'done', received: 0, total: 0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    downloadJob = null;
  }
}

function cancelDownload() {
  if (downloadJob) downloadJob.cancelled = true;
}

/* ------------------------------------------------------------------ */
/*  Сервер                                                             */
/* ------------------------------------------------------------------ */

let server = null;
let serverPort = 0;
let serverModel = '';
let starting = null;

function threads() {
  const cores = os.cpus().length || 4;
  return Math.max(2, Math.min(16, cores - 1));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await electronNet.fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Локальное распознавание не запустилось');
}

function stopServer() {
  if (server) {
    try {
      server.kill();
    } catch {
      /* уже остановлен */
    }
  }
  server = null;
  serverPort = 0;
  serverModel = '';
  starting = null;
}

async function ensureServer(size) {
  const wanted = size === 'small' ? 'small' : 'base';
  if (server && !server.killed && serverPort && serverModel === wanted) return serverPort;
  if (starting) return starting;

  const exe = serverExe();
  if (!exe) throw new Error('Локальный движок не скачан');
  if (!modelReady(wanted)) throw new Error('Локальная модель не скачана');

  starting = (async () => {
    stopServer();
    const port = await freePort();
    const args = [
      '-m',
      modelPath(wanted),
      '-t',
      String(threads()),
      '-l',
      'ru',
      '-nt',
      '-nf',
      '-bo',
      '1',
      '-sns',
      '--port',
      String(port),
    ];

    server = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: 'ignore',
    });
    serverModel = wanted;
    server.on('exit', () => {
      server = null;
      serverPort = 0;
      serverModel = '';
    });

    await waitReady(port);
    serverPort = port;
    return port;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function transcribe(audio, size) {
  const port = await ensureServer(size);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'chunk.wav');
  form.append('temperature', '0');
  form.append('response_format', 'json');

  const res = await electronNet.fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Локальное распознавание: HTTP ${res.status} ${detail.slice(0, 120)}`);
  }

  const data = await res.json().catch(() => null);
  return String((data && data.text) || '').trim();
}

module.exports = {
  MODELS,
  status,
  download,
  cancelDownload,
  transcribe,
  ensureServer,
  stopServer,
  serverExe,
  modelReady,
};
