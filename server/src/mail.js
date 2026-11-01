'use strict';

/**
 * Отправка кодов входа.
 *
 * MAIL_MODE=console  — печатает код в лог (для разработки).
 * MAIL_MODE=resend   — отправляет через Resend (нужен RESEND_API_KEY).
 *
 * Для России позже добавляется Unisender или SendPulse — это ещё один
 * блок if с fetch, остальной код не меняется.
 */

const MODE = String(process.env.MAIL_MODE || 'console').toLowerCase();

async function sendCode(email, code) {
  if (MODE === 'console') {
    console.log(`[mail] код для ${email}: ${code}`);
    return { ok: true, mode: 'console' };
  }

  if (MODE === 'resend') {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY не задан');

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Помогатор <login@pomogator.ru>',
        to: [email],
        subject: 'Код входа в Помогатор',
        text: `Код входа: ${code}\n\nОн действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend: ${response.status} ${detail}`.trim());
    }

    return { ok: true, mode: 'resend' };
  }

  throw new Error(`Неизвестный MAIL_MODE: ${MODE}`);
}

module.exports = { sendCode };
