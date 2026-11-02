@echo off
chcp 65001 >nul

rem Запуск приложения против локального API.
rem Сначала запустите test-server.cmd.

set POMOGATOR_API=http://127.0.0.1:8787

if exist "%USERPROFILE%\Desktop\Pomogator-0.19.1.exe" (
  start "" "%USERPROFILE%\Desktop\Pomogator-0.19.1.exe"
) else (
  echo Не найден Pomogator-0.19.1.exe на рабочем столе.
  pause
)
