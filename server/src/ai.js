'use strict';

const { HttpError } = require('./util');
const crypto = require('crypto');

/** OpenCode просит стабильный id сессии, иначе отвечает 400. */
const OPENCODE_SESSION = crypto.randomUUID();

/**
 * Прокси к моделям. Ключи живут только на сервере, клиент их не видит.
 *
 * Распознавание — Cloudflare Workers AI: Nova-3, при сбое Whisper.
 * Ответы — OpenCode Go, OpenAI-совместимый /chat/completions.
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const OPENCODE_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions';

const THINKING_OFF = new Set([
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
  'qwen3.8-flash',
  'mimo-v2.6-flash',
  'kimi-k3',
]);

/** Длительность WAV по заголовку: клиент не может занизить списание. */
function wavSeconds(buffer) {
  try {
    if (!buffer || buffer.length < 44) return 0;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;

    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;

    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);

      if (id === 'fmt ' && offset + 20 <= buffer.length) {
        byteRate = buffer.readUInt32LE(offset + 16);
      }

      if (id === 'data') {
        dataSize = Math.min(size, buffer.length - offset - 8);
        break;
      }

      offset += 8 + size + (size % 2);
    }

    if (!byteRate || !dataSize) return 0;
    return dataSize / byteRate;
  } catch {
    return 0;
  }
}

async function cfRun(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`.trim());
  }

  return response.json();
}

async function transcribe(wav, { language = 'ru', prompt = '' } = {}) {
  const accountId = String(process.env.CF_ACCOUNT_ID || '').trim();
  const token = String(process.env.CF_API_TOKEN || '').trim();

  if (!accountId || !token) {
    throw new HttpError(503, 'Распознавание не настроено на сервере');
  }

  const base = `${CF_BASE}/${accountId}/ai/run`;

  try {
    const data = await cfRun(
      `${base}/@cf/openai/whisper-large-v3-turbo`,
      { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      JSON.stringify({
        audio: Buffer.from(wav).toString('base64'),
        language,
        task: 'transcribe',
        ...(prompt ? { initial_prompt: prompt } : {}),
      })
    );

    const text = String(data?.result?.text || '').trim();
    if (text) return text;
  } catch (err) {
    console.warn('[ai] whisper не ответил:', err.message);
  }

  const data = await cfRun(
    `${base}/@cf/deepgram/nova-3?language=${encodeURIComponent(language)}&smart_format=true&punctuate=true`,
    { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
    wav
  );

  return String(
    data?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  ).trim();
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];

  const out = [];

  for (const item of input.slice(-12)) {
    if (!item || typeof item !== 'object') continue;
    if (!['system', 'user', 'assistant'].includes(item.role)) continue;

    let content = item.content;

    if (typeof content === 'string') {
      content = content.slice(0, 8000);
    } else if (Array.isArray(content)) {
      content = content.slice(0, 4);
    } else {
      continue;
    }

    if (!content || (typeof content === 'string' && !content.trim())) continue;

    out.push({ role: item.role, content });
  }

  return out;
}

async function chat(messages, { maxTokens = 400 } = {}) {
  const key = String(process.env.OPENCODE_API_KEY || '').trim();
  if (!key) throw new HttpError(503, 'Модель не настроена на сервере');

  const model = String(process.env.OPENCODE_MODEL || 'glm-5.3-flash').trim();

  const response = await fetch(OPENCODE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'Pomogator/0.1.0 (overlay assistant)',
      'x-opencode-session': OPENCODE_SESSION,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: Math.min(1200, Math.max(50, Number(maxTokens) || 400)),
      temperature: 0.4,
      ...(THINKING_OFF.has(model) ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Модель: HTTP ${response.status} ${detail.slice(0, 200)}`.trim());
  }

  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

module.exports = { wavSeconds, transcribe, chat, cleanMessages };
