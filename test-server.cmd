@echo off
chcp 65001 >nul
title Помогатор API (тест)
cd /d "%~dp0server"

set AUTH_SECRET=test-secret
set ADMIN_TOKEN=test-admin
set MAIL_MODE=console
set TEST_LOGIN_CODE=123456

if exist ".env.test" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env.test") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

echo.
echo  API:     http://127.0.0.1:8787
echo  Админка: http://127.0.0.1:8787/admin (токен test-admin)
echo  Код входа: 123456 (тестовый, не истекает)
echo.

if "%CF_API_TOKEN%"=="" (
  echo  Внимание: server/.env.test не заполнен.
  echo  Скопируйте .env.test.example в .env.test и укажите ключи.
  echo.
)

echo  Не закрывайте это окно, пока тестируете.
echo.

node src/index.js
pause
