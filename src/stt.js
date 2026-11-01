'use strict';

const { net } = require('electron');

/**
 * Распознавание речи.
 * cloudflare — Whisper large-v3-turbo на Workers AI: тот же токен и аккаунт,
 * что и для ответов, отдельная регистрация не нужна.
 */
const STT = {
  cloudflare: {
    label: 'Cloudflare Whisper',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run',
    defaultModel: '@cf/deepgram/nova-3',
    models: [
      '@cf/deepgram/nova-3',
      '@cf/openai/whisper-large-v3-turbo',
      '@cf/openai/whisper',
    ],
    keyProvider: 'cloudflare',
    needsAccount: true,
  },
  mistral: {
    label: 'Mistral Voxtral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'voxtral-mini-latest',
    models: ['voxtral-mini-latest', 'voxtral-small-latest'],
    keyProvider: 'mistral',
  },
};

function sttConfig(id) {
  return STT[id] || STT.cloudflare;
}

function toBase64(arrayBuffer) {
  return Buffer.from(arrayBuffer).toString('base64');
}

async function transcribe(options) {
  const { providerId, model } = options;
  const chosen = model || sttConfig(providerId).defaultModel;

  try {
    return await transcribeOnce({ ...options, model: chosen });
  } catch (err) {
    // Nova может быть недоступна на аккаунте — тогда молча уходим на Whisper,
    // чтобы суфлёр не остался без распознавания.
    if (providerId === 'cloudflare' && /^@cf\/deepgram\//.test(chosen)) {
      console.warn('[stt] nova failed:', err.message);
      return transcribeOnce({ ...options, model: '@cf/openai/whisper-large-v3-turbo' });
    }
    throw err;
  }
}

async function transcribeOnce({
  providerId,
  apiKey,
  accountId,
  model,
  audio,
  language = 'ru',
  initialPrompt = '',
  signal,
}) {
  const cfg = sttConfig(providerId);
  const chosen = model || cfg.defaultModel;
  // Deepgram в Workers AI принимает сам файл телом запроса и параметры в URL,
  // а Whisper — base64 внутри JSON.
  const deepgram = providerId === 'cloudflare' && /^@cf\/deepgram\//.test(chosen);
  // Whisper принимает подсказку ограниченной длины — обрезаем,
  // чтобы контекст разговора помогал, но не ломал запрос.
  const hint = String(initialPrompt || '').trim().slice(0, 700);

  if (!apiKey) throw new Error('Нет ключа для распознавания речи');
  if (cfg.needsAccount && !accountId) throw new Error('Не указан Account ID Cloudflare');

  const base = cfg.baseUrl.replace('{accountId}', String(accountId || '').trim());
  const url = deepgram
    ? `${base}/${chosen}?language=${language}&smart_format=true&punctuate=true`
    : `${base}/${chosen}`;

  // Зависший запрос не должен держать очередь распознавания: через 12 секунд
  // считаем, что сервис не ответил, и уходим на резервную модель.
  const timeout = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  if (providerId === 'cloudflare') {
    if (deepgram) {
      res = await net.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: audio,
        signal: requestSignal,
      });
    } else {
      res = await net.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio: toBase64(audio),
          language,
          task: 'transcribe',
          // Свой VAD уже есть в рендерере: лишняя проверка на стороне Whisper
          // только добавляет задержку перед ответом.
          ...(hint ? { initial_prompt: hint } : {}),
        }),
        signal: requestSignal,
      });
    }
  } else {
    const form = new FormData();
    form.append('model', chosen);
    form.append('language', language);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'chunk.wav');

    res = await net.fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: requestSignal,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text);
      detail =
        parsed.error?.message ||
        parsed.errors?.[0]?.message ||
        parsed.detail ||
        parsed.message ||
        detail;
    } catch {
      /* оставляем как есть */
    }
    const error = new Error(`Распознавание: HTTP ${res.status} — ${detail}`);
    error.status = res.status;
    error.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw error;
  }

  const data = await res.json().catch(() => null);
  const text = deepgram
    ? data?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
    : (data && (data.result?.text ?? data.text ?? data.transcription)) || '';
  return String(text).trim();
}

module.exports = { STT, sttConfig, transcribe };
