# Помогатор

Оверлей с подсказками для собеседований и созвонов: распознавание речи,
ответы модели, скриншоты задач, запись встреч с выжимкой, тренажёр и тесты.

## Структура

```
src/                 приложение Electron
  main.js            главный процесс, окна, IPC
  account.js         вход, сессия, облако
  hotkeys.js         горячие клавиши
  wheel-hook.js      глобальный хук колеса
  screenshot.js      выделение области и vision-запросы
  meeting-store.js   сохранение и выжимка встреч
  renderer/          окна: оверлей, настройки, вход, встреча, тренажёр, тесты

server/              API: аккаунты, баланс, прокси к моделям
  src/               Node.js без зависимостей, node:sqlite
  deploy/            systemd, Caddy, инструкция по VPS

scripts/release.js   сборка и публикация версии
```

## Быстрый старт

```powershell
# API для локальных тестов
.\test-server.cmd

# приложение против локального API
.\test-app.cmd
```

Код входа в тестовом режиме — `123456`, админка — `http://127.0.0.1:8787/admin`,
токен `test-admin`.

## Сборка

```powershell
npm install
npm run build
```

Артефакт: `dist/Pomogator-<версия>.exe`.

Релиз с повышением версии, копией на рабочий стол и тегом:

```powershell
npm run release minor
```

## Сервер

Подробно — в `server/README.md` и `server/deploy/README.md`.

Коротко:

1. VPS с Ubuntu 24.04, домен `api.pomogator.ru`.
2. Node.js 22+, Caddy, systemd.
3. `server/.env` с `AUTH_SECRET` (32+ символа) и `ADMIN_TOKEN`.
4. `MAIL_MODE=resend` и ключ Resend для писем.
5. `TEST_LOGIN_CODE` в бою не задавать — сервер откажется стартовать в production.

## Автодеплой

`.github/workflows/deploy-api.yml` при пуше в `main` копирует `server/` на VPS
по SSH и перезапускает сервис.

Секреты репозитория:

| Секрет | Что это |
|---|---|
| `VPS_HOST` | IP или домен сервера |
| `VPS_USER` | пользователь для деплоя |
| `VPS_SSH_KEY` | приватный ключ без пароля |
| `VPS_KNOWN_HOSTS` | вывод `ssh-keyscan -H <host>` |

Пользователь деплоя должен иметь право на
`sudo systemctl restart pomogator-api` без пароля.

## Безопасность

- Секреты и база не хранятся в репозитории: `.env` и `server/data/` в `.gitignore`.
- Ключи провайдеров на клиенте шифруются через DPAPI.
- Коды и токены на сервере хранятся хешами.
- Тариф и режим определяет сервер, а не клиент.
- `TEST_LOGIN_CODE` и короткий `AUTH_SECRET` блокируются в production.
