'use strict';

const { net } = require('electron');

/**
 * Все провайдеры ниже — OpenAI-совместимые (/v1/chat/completions, stream: true).
 * Ключи хранятся в settings.keys[providerId].
 */
const PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    needsAccount: true,
    accountUrl: 'https://dash.cloudflare.com/',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    models: [
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/qwen/qwen3.8-27b',
      '@cf/openai/gpt-oss-120b',
      '@cf/google/gemma-4-26b-a4b-it',
    ],
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    note: 'Бесплатно: 10 000 нейронов в день (≈250 ответов), без карты',
  },
  deepseek: {
    label: 'DeepSeek (официальный)',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/',
    note: 'Платно, но очень дешево (~$0.01 за час работы)',
  },
  sambanova: {
    label: 'SambaNova (DeepSeek)',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'DeepSeek-V3.2',
    models: ['DeepSeek-V3.2', 'DeepSeek-V3.1', 'Meta-Llama-3.3-70B-Instruct', 'gpt-oss-120b'],
    keyUrl: 'https://cloud.sambanova.ai/',
    note: 'Бесплатно: 20 запросов в день',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
    keyUrl: 'https://console.groq.com/keys',
    note: 'Нужен VPN: сервис блокирует российские IP',
  },
  mistral: {
    label: 'Mistral (нужен платный план)',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    keyUrl: 'https://console.mistral.ai/',
    note: 'С 2026 года бесплатный план не даёт доступа к API',
  },
  opencode: {
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    defaultModel: 'glm-5.3-flash',
    models: [
      'glm-5.3-flash',
      'deepseek-v4.1-flash',
      'qwen3.8-flash',
      'mimo-v2.6-flash',
      'kimi-k3',
      'glm-5.3',
      'glm-5.2',
    ],
    keyUrl: 'https://opencode.ai/console',
    note: 'Подписка OpenCode Go: ключ из консоли. Быстрее всех — GLM-5.3-Flash',
  },
};

function providerConfig(id) {
  return PROVIDERS[id] || PROVIDERS.cloudflare;
}

/**
 * Модели, которые часть ответа тратят на рассуждения.
 * Им нужен запас токенов, иначе content приходит пустым.
 */
const REASONING_MODELS = new Set([
  '@cf/qwen/qwen3.8-27b',
  '@cf/openai/gpt-oss-120b',
  '@cf/google/gemma-4-26b-a4b-it',
  'deepseek-reasoner',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
  'gpt-oss-120b',
  'glm-5.3',
  'glm-5.2',
]);

/**
 * OpenCode Go: этим моделям можно выключить рассуждения.
 * GLM-5.3 без приставки flash — «thinking-only», ему такой параметр даёт 400.
 */
const OPENCODE_THINKING_OFF = new Set([
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
  'qwen3.8-flash',
  'mimo-v2.6-flash',
  'kimi-k3',
]);

function isReasoningModel(model) {
  return REASONING_MODELS.has(String(model || ''));
}

function outputTokenLimit(modelId, requested) {
  // DeepSeek Reasoner тратит на рассуждения заметно больше остальных.
  if (modelId === 'deepseek-reasoner') return Math.max(requested, 2500);
  if (isReasoningModel(modelId)) return Math.max(requested, 800);
  return requested;
}

/**
 * Где провайдер это поддерживает — отключаем или сокращаем рассуждения.
 * Без этого модель может израсходовать весь лимит на reasoning
 * и вернуть пустой content.
 */
function reasoningTweaks(providerId, model) {
  const id = String(model || '');

  if (providerId === 'cloudflare') {
    if (id === '@cf/qwen/qwen3.8-27b' || id === '@cf/google/gemma-4-26b-a4b-it') {
      return { chat_template_kwargs: { enable_thinking: false } };
    }
    if (id === '@cf/openai/gpt-oss-120b') {
      return { reasoning_effort: 'low' };
    }
  }

  if (providerId === 'groq' && id.includes('gpt-oss')) {
    return { reasoning_effort: 'low' };
  }

  // OpenCode Go: у части моделей рассуждения можно выключить — тогда ответ
  // приходит в разы быстрее, что для суфлёра важнее глубины.
  if (providerId === 'opencode' && OPENCODE_THINKING_OFF.has(id)) {
    return { thinking: { type: 'disabled' } };
  }

  return null;
}

function resolveBaseUrl(provider, accountId) {
  const id = String(accountId || '').trim();
  return provider.baseUrl.replace('{accountId}', id);
}

// OpenCode Go просит клиента представляться и присылать стабильный id сессии:
// по нему сервис маршрутизирует запросы и кэширует промпт.
const OPENCODE_SESSION_ID = require('crypto').randomUUID();

function extraHeaders(providerId) {
  if (providerId !== 'opencode') return null;
  return {
    'User-Agent': 'Suflyor/0.1.0 (overlay assistant)',
    'x-opencode-session': OPENCODE_SESSION_ID,
  };
}

async function streamChat({
  providerId,
  model,
  apiKey,
  accountId,
  messages,
  maxTokens = 200,
  temperature = 0.4,
  signal,
  onDelta,
}) {
  const provider = providerConfig(providerId);
  const modelId = model || provider.defaultModel;
  const headers = { 'Content-Type': 'application/json' };
  if (!provider.noKey && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  Object.assign(headers, extraHeaders(providerId) || {});

  const tweaks = reasoningTweaks(providerId, modelId);
  const outputLimit = outputTokenLimit(modelId, maxTokens);

  const body = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: outputLimit,
    temperature,
    ...(tweaks || {}),
  };

  const res = await net.fetch(`${resolveBaseUrl(provider, accountId)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text);
      detail =
        parsed.error?.message ||
        parsed.errors?.[0]?.message ||
        parsed.message ||
        detail;
    } catch {
      /* оставляем как есть */
    }
    const error = new Error(`${provider.label}: HTTP ${res.status} — ${detail}`);
    error.status = res.status;
    error.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw error;
  }

  if (!res.body) throw new Error(`${provider.label}: пустой ответ`);

  // Не все OpenAI-совместимые шлюзы отдают SSE — если пришёл обычный JSON,
  // просто отдаём текст целиком.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('event-stream')) {
    const json = await res.json().catch(() => null);
    const message = json?.choices?.[0]?.message;
    const text =
      message?.content ??
      json?.result?.response ??
      json?.response ??
      '';
    if (text) {
      onDelta(String(text));
      return;
    }

    const reasoning = message?.reasoning_content || message?.reasoning;
    if (reasoning) {
      throw new Error(
        `${provider.label}: модель вернула только рассуждение без ответа. Выберите другую модель.`
      );
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentSeen = false;
  let reasoningSeen = false;

  stream: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') break stream;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta || {};

        // Рассуждения не показываем, но запоминаем: если модель потратила
        // на них весь лимит, content останется пустым.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) reasoningSeen = true;

        let piece = delta.content;
        // Некоторые шлюзы отдают первый токен-цифру как JSON-число,
        // а не строку. Без этого терялся ведущий «1» в нумерации.
        if (typeof piece === 'number') piece = String(piece);
        if (typeof piece !== 'string' || !piece) continue;

        // Убираем ведущие переводы строк, которые некоторые модели
        // добавляют перед ответом.
        if (!contentSeen) piece = piece.replace(/^\s+/, '');
        if (!piece) continue;

        contentSeen = true;
        onDelta(piece);
      } catch {
        /* неполный JSON в потоке — пропускаем */
      }
    }
  }

  if (!contentSeen && reasoningSeen) {
    throw new Error(
      `${provider.label}: модель израсходовала лимит на рассуждение и не дала ответ. Выберите другую модель.`
    );
  }
}

module.exports = { PROVIDERS, providerConfig, resolveBaseUrl, streamChat };
