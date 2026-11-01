@echo off
chcp 65001 >nul
title Помогатор API (тест)
cd /d "%~dp0server"

set AUTH_SECRET=test-secret
set ADMIN_TOKEN=test-admin
set MAIL_MODE=console

echo.
echo  API:     http://127.0.0.1:8787
echo  Админка: http://127.0.0.1:8787/admin
echo  Код входа печатается ниже.
echo.
echo  Не закрывайте это окно, пока тестируете.
echo.

node src/index.js
pause
