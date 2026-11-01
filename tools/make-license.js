'use strict';

/**
 * Выпуск ключей активации.
 *
 *   node tools/make-license.js month
 *   node tools/make-license.js season 90
 *   node tools/make-license.js lifetime
 *
 * Закрытый ключ читается из tools/license-private.pem — он есть только
 * у владельца и в git не попадает. Резервную копию держите отдельно:
 * без него выпустить новые ключи нельзя.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 86400000;

const DURATIONS = {
  month: 30,
  season: 90,
  year: 365,
  lifetime: 0,
};

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function main() {
  const plan = String(process.argv[2] || '').trim().toLowerCase();
  if (!DURATIONS[plan] && DURATIONS[plan] !== 0) {
    console.error('Укажите тариф: month | season | year | lifetime');
    process.exit(1);
  }

  const days = process.argv[3] ? Number(process.argv[3]) : DURATIONS[plan];
  const privatePath = path.join(__dirname, 'license-private.pem');

  if (!fs.existsSync(privatePath)) {
    console.error('Нет файла tools/license-private.pem — выпуск ключей невозможен.');
    process.exit(1);
  }

  const privateKey = fs.readFileSync(privatePath, 'utf8');
  const now = Date.now();

  const payload = {
    v: 1,
    plan,
    exp: days > 0 ? now + days * DAY_MS : 0,
    id: crypto.randomBytes(4).toString('hex'),
    issued: now,
  };

  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, payloadBuf, privateKey);

  const key = `POMG1.${b64url(payloadBuf)}.${b64url(signature)}`;

  console.log('');
  console.log(`Тариф: ${plan}${days > 0 ? `, ${days} дн.` : ', бессрочно'}`);
  console.log(`Действует до: ${days > 0 ? new Date(payload.exp).toLocaleString('ru-RU') : 'бессрочно'}`);
  console.log('');
  console.log(key);
  console.log('');
}

main();
