@echo off
setlocal
chcp 65001 >nul
title Polymarket BTC 5M Service Console
cd /d "%~dp0"
if errorlevel 1 goto failed
where node.exe >nul 2>nul
if errorlevel 1 goto node_error
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>24||(v[0]===24&&v[1]>=5)?0:1)"
if errorlevel 1 goto node_error
if "%~1"=="--check" goto check_only
if not exist "node_modules\express\package.json" goto install_dependencies
if not exist "node_modules\vite\package.json" goto install_dependencies
goto start_service

:install_dependencies
echo Installing dependencies. Please wait...
call npm.cmd install
if errorlevel 1 goto failed

:start_service
node --env-file-if-exists=.env scripts/service-control.mjs --console %*
if errorlevel 1 goto failed
exit /b 0

:check_only
node --env-file-if-exists=.env scripts/service-control.mjs --status
exit /b %errorlevel%

:node_error
echo Please install Node.js 24.5 or newer.
:failed
echo Startup failed. Please check the error above.
pause
exit /b 1
