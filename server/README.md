# API Помогатора

Аккаунты, устройства, баланс и админка. Без внешних зависимостей: Node.js 22.5+
и встроенный `node:sqlite`.

## Запуск локально

```powershell
cd server
copy .env.example .env
# отредактируйте AUTH_SECRET и ADMIN_TOKEN
$env:AUTH_SECRET="локальный-секрет"
$env:ADMIN_TOKEN="локальный-админ"
$env:MAIL_MODE="console"
npm start
```

Сервер поднимется на `http://127.0.0.1:8787`, админка — `/admin`.

В режиме `MAIL_MODE=console` код входа печатается в консоль сервера.

## Проверка через PowerShell

```powershell
# 1. Запросить код (смотрите консоль сервера)
Invoke-RestMethod -Method Post http://127.0.0.1:8787/auth/request `
  -ContentType 'application/json' -Body '{"email":"test@example.com"}'

# 2. Подтвердить код
$r = Invoke-RestMethod -Method Post http://127.0.0.1:8787/auth/verify `
  -ContentType 'application/json' `
  -Body '{"email":"test@example.com","code":"123456","deviceName":"Ноутбук","fingerprint":"dev-1"}'

# 3. Профиль
Invoke-RestMethod http://127.0.0.1:8787/me -Headers @{ Authorization = "Bearer $($r.token)" }

# 4. Зачислить 500 ₽
Invoke-RestMethod -Method Post http://127.0.0.1:8787/admin/api/credit `
  -ContentType 'application/json' -Headers @{ 'x-admin-token' = 'локальный-админ' } `
  -Body '{"email":"test@example.com","amountRub":500,"comment":"тест"}'
```

## Что уже есть

- вход по коду на почту, без пароля;
- привязка к устройствам (по умолчанию 2);
- сессии на 30 дней, отзыв при выходе и блокировке;
- баланс в копейках, журнал транзакций, атомарное списание;
- пробные 20 минут (`TRIAL_SECONDS=1200`);
- админка: поиск, зачисление, блокировка, сводка.

## Чего пока нет

- прокси к STT/LLM и списание за минуты (0.19.0);
- платежи ЮKassa (0.20.0);
- отправка писем в РФ через Unisender (сейчас `console` или `resend`).

## Развёртывание

1. VPS в РФ (Timeweb Cloud, Beget), 2 vCPU / 2 ГБ.
2. Node.js 22.5+.
3. `server/.env` с боевыми `AUTH_SECRET` и `ADMIN_TOKEN`.
4. systemd-юнит: `node /opt/pomogator/server/src/index.js`.
5. Caddy или nginx с Let's Encrypt на `api.pomogator.ru`.
6. Бэкап `server/data/pomogator.db` раз в сутки.

Порт наружу не открывать: только через reverse proxy с HTTPS.
