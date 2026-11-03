'use strict';

const { net } = require('electron');

/**
 * Распознавание речи.
 *
 * cloudflare — Workers AI (Nova-3 / Whisper), нужен Account ID.
 * custom     — свой endpoint: OpenAI-совместимый (/audio/transcriptions)
 *              или Cloudflare-совместимый (/ai/run/<model>).
 */

const STT = {
  cloudflare: {
    label: 'Cloudflare Workers AI',
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
  custom: {
    label: 'Свой API',
    baseUrl: '',
    defaultModel: '',
    models: [],
    needsAccount: false,
  },
};

function sttConfig(id) {
  return STT[id] || STT.custom;
}

function toBase64(arrayBuffer) {
  return Buffer.from(arrayBuffer).toString('base64');
}

async function transcribe(options) {
  const { providerId, model, format } = options;
  const chosen = model || sttConfig(providerId).defaultModel;

  try {
    return await transcribeOnce({ ...options, model: chosen });
  } catch (err) {
    const nova = /^@cf\/deepgram\//.test(chosen);
    const cloudflare =
      providerId === 'cloudflare' || (providerId === 'custom' && format === 'cloudflare');

    // Nova может быть недоступна — молча уходим на Whisper.
    if (cloudflare && nova) {
      console.warn('[stt] nova failed:', err.message);
      return transcribeOnce({ ...options, model: '@cf/openai/whisper-large-v3-turbo' });
    }

    throw err;
  }
}

async function transcribeOnce({
  providerId,
  format,
  baseUrl,
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
  const cloudflareFormat =
    providerId === 'custom' ? format === 'cloudflare' : providerId === 'cloudflare';

  const rawBase = String(baseUrl || cfg.baseUrl || '');
  const account = String(accountId || '').trim();

  if (rawBase.includes('{accountId}') && !account) {
    throw new Error('Укажите Account ID');
  }

  const base = rawBase.replace('{accountId}', account).replace(/\/+$/, '');

  if (!base) throw new Error('Не указан адрес API распознавания');
  if (cfg.needsAccount && !account) throw new Error('Укажите Account ID');

  const deepgram = cloudflareFormat && /^@cf\/deepgram\//.test(chosen);
  const hint = String(initialPrompt || '').trim().slice(0, 700);

  const timeout = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;

  if (cloudflareFormat) {
    const url = deepgram
      ? `${base}/${chosen}?language=${language}&smart_format=true&punctuate=true`
      : `${base}/${chosen}`;

    if (deepgram) {
      res = await net.fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'audio/wav' },
        body: audio,
        signal: requestSignal,
      });
    } else {
      res = await net.fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: toBase64(audio),
          language,
          task: 'transcribe',
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

    res = await net.fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers,
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

  const text = cloudflareFormat
    ? deepgram
      ? data?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
      : (data && (data.result?.text ?? data.text ?? data.transcription)) || ''
    : (data && (data.text ?? data.transcription ?? data.result?.text)) || '';

  return String(text).trim();
}

module.exports = { STT, sttConfig, transcribe };
