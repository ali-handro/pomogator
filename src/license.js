'use strict';

const crypto = require('crypto');

/**
 * Офлайн-лицензии.
 *
 * Ключ — это подписанный закрытым ключом набор данных:
 *   POMG1.<payload в base64url>.<подпись в base64url>
 *
 * Приложение проверяет подпись встроенным открытым ключом, поэтому сервер
 * для продажи ключей не нужен. Закрытый ключ лежит только у владельца
 * (tools/license-private.pem) и в сборку не попадает.
 */

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmRLSFSMlqAlpTmPkiCRuoKXK01a03+IvODkjGhLPPV0=
-----END PUBLIC KEY-----`;

const PLANS = {
  free: { label: 'Бесплатно' },
  trial: { label: 'Пробный период' },
  month: { label: 'Месяц', days: 30 },
  season: { label: 'Сезон', days: 90 },
  year: { label: 'Год', days: 365 },
  lifetime: { label: 'Навсегда' },
};

/** Что можно бесплатно. Полная версия снимает оба ограничения. */
const FREE_LIMITS = {
  answersPerDay: 20,
  screenshotsPerDay: 5,
};

const TRIAL_DAYS = 7;
const DAY_MS = 86400000;

function b64urlToBuffer(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(text, 'base64');
}

function verifyKey(key) {
  const parts = String(key || '')
    .trim()
    .split('.');

  if (parts.length !== 3 || parts[0] !== 'POMG1') {
    return { ok: false, error: 'Ключ не похож на ключ Помогатора' };
  }

  const payload = b64urlToBuffer(parts[1]);
  const signature = b64urlToBuffer(parts[2]);

  let valid = false;
  try {
    valid = crypto.verify(null, payload, PUBLIC_KEY, signature);
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, error: 'Ключ неверный или повреждён' };

  let data;
  try {
    data = JSON.parse(payload.toString('utf8'));
  } catch {
    return { ok: false, error: 'Ключ повреждён' };
  }

  const plan = data && PLANS[data.plan] && data.plan !== 'free' && data.plan !== 'trial'
    ? data.plan
    : null;
  if (!plan) return { ok: false, error: 'В ключе неизвестный тариф' };

  const exp = Number(data.exp) || 0;
  if (exp && Date.now() > exp) {
    return { ok: false, error: 'Срок действия ключа истёк', plan, exp };
  }

  return { ok: true, plan, exp, id: String(data.id || '') };
}

function dayKey(date) {
  const d = date || new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function freshUsage(now) {
  return { date: dayKey(new Date(now)), answers: 0, screenshots: 0 };
}

/** Текущее состояние тарифа и остатки на сегодня. */
function describe(settings, now) {
  const at = Number(now) || Date.now();

  const license = settings.license || null;
  const plan = (license && license.plan) || 'free';
  const exp = Number(license && license.exp) || 0;

  let active = plan !== 'free' && plan !== 'trial';
  if (active && exp && at > exp) active = false;

  const trialStartedAt = Number(settings.trialStartedAt) || 0;
  const trialExp = trialStartedAt ? trialStartedAt + TRIAL_DAYS * DAY_MS : 0;
  const trialActive = !active && trialExp > 0 && at < trialExp;

  const effective = active ? plan : trialActive ? 'trial' : 'free';
  const paid = effective !== 'free';
  const until = active ? exp : trialActive ? trialExp : 0;

  const usage =
    settings.usage && settings.usage.date === dayKey(new Date(at))
      ? settings.usage
      : freshUsage(at);

  return {
    plan: effective,
    label: PLANS[effective].label,
    paid,
    exp: until,
    daysLeft: until ? Math.max(0, Math.ceil((until - at) / DAY_MS)) : 0,
    usage,
    limits: FREE_LIMITS,
    remaining: {
      answers: paid
        ? -1
        : Math.max(0, FREE_LIMITS.answersPerDay - (Number(usage.answers) || 0)),
      screenshots: paid
        ? -1
        : Math.max(0, FREE_LIMITS.screenshotsPerDay - (Number(usage.screenshots) || 0)),
    },
  };
}

/**
 * Списывает одну единицу лимита. В полной версии ничего не считает.
 * Мутирует settings.usage — вызывающий сохраняет настройки.
 */
function consume(settings, kind, now) {
  const at = Number(now) || Date.now();
  const state = describe(settings, at);

  if (state.paid) return { ok: true, paid: true, state };

  const field = kind === 'screenshots' ? 'screenshots' : 'answers';
  const limit =
    field === 'screenshots' ? FREE_LIMITS.screenshotsPerDay : FREE_LIMITS.answersPerDay;
  const used = Number(state.usage[field]) || 0;

  if (used >= limit) {
    const message =
      field === 'screenshots'
        ? 'В бесплатной версии 5 скриншотов в день. Полная версия — без ограничений.'
        : `В бесплатной версии ${FREE_LIMITS.answersPerDay} ответов в день. Полная версия — без ограничений.`;
    return { ok: false, paid: false, error: message, state };
  }

  settings.usage = { ...state.usage, [field]: used + 1 };

  return { ok: true, paid: false, state: describe(settings, at) };
}

module.exports = {
  PLANS,
  FREE_LIMITS,
  TRIAL_DAYS,
  verifyKey,
  describe,
  consume,
  dayKey,
};
