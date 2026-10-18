@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sword Arena - запуск

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js не найден. Устанавливаю...
    winget install -e --id OpenJS.NodeJS.LTS
    echo.
    echo Готово. ЗАКРОЙ это окно и запусти start-game.bat ещё раз.
    pause
    exit /b
)

where cloudflared >nul 2>&1
if errorlevel 1 (
    echo cloudflared не найден. Устанавливаю...
    winget install -e --id Cloudflare.cloudflared
    echo.
    echo Готово. ЗАКРОЙ это окно и запусти start-game.bat ещё раз.
    pause
    exit /b
)

echo Запускаю сервер игры...
start "Sword Arena - СЕРВЕР (не закрывай)" cmd /k node server.js

echo.
echo Запускаю туннель. Через несколько секунд здесь появится ссылка для друга,
echo она сама скопируется в буфер обмена. НЕ ЗАКРЫВАЙ это окно, пока играете.
echo.
powershell -NoProfile -Command "& cloudflared tunnel --url http://localhost:3000 2>&1 | ForEach-Object { $l = \"$_\"; Write-Host $l; if ($l -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $matches[0] | Set-Clipboard; Write-Host ''; Write-Host ('>>> ССЫЛКА СКОПИРОВАНА: ' + $matches[0]) -ForegroundColor Green; Write-Host '>>> Открой её сам и отправь другу.' -ForegroundColor Green; Write-Host '' } }"
pause
