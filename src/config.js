'use strict';

/**
 * Ссылки и контакты приложения.
 *
 * donateUrl    — страница донатов (CloudTips).
 * supportEmail — почта для обратной связи и диагностики.
 * updatesUrl   — JSON с последней версией. Пустая строка — проверка отключена.
 *
 * Формат updatesUrl:
 *   { "version": "0.27.2", "url": "https://.../Pomogator-Setup-0.27.2.exe", "notes": "..." }
 *
 * Достаточно поменять значения здесь и пересобрать приложение.
 */
module.exports = {
  donateUrl: 'https://pay.cloudtips.ru/p/17b6f1f4',
  supportEmail: 'softpuff@ya.ru',
  updatesUrl: 'https://github.com/ali-handro/pomogator/releases/latest/download/updates.json',
};
