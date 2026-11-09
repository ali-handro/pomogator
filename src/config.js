'use strict';

/**
 * Ссылки приложения.
 *
 * donateUrl    — страница донатов (CloudTips).
 * feedbackUrl  — куда написать по вопросам и ошибкам (Telegram).
 * updatesUrl   — JSON с последней версией. Пустая строка — проверка отключена.
 *
 * Формат updatesUrl:
 *   { "version": "0.26.1", "url": "https://.../Pomogator-Setup-0.26.1.exe", "notes": "..." }
 *
 * Достаточно поменять значения здесь и пересобрать приложение.
 */
module.exports = {
  donateUrl: 'https://pay.cloudtips.ru/p/17b6f1f4',
  feedbackUrl: 'https://t.me/Alex_sndr',
  updatesUrl: 'https://github.com/ali-handro/pomogator/releases/latest/download/updates.json',
};
