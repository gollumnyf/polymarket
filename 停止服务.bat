@echo off
setlocal
chcp 65001 >nul
title Polymarket BTC 5M Stop Service
cd /d "%~dp0"
if errorlevel 1 goto failed
where node.exe >nul 2>nul
if errorlevel 1 goto node_error
node --env-file-if-exists=.env scripts/service-control.mjs --stop
set "SERVICE_EXIT=%errorlevel%"
if not "%SERVICE_EXIT%"=="0" echo Stop failed. Please check the error above.
pause
exit /b %SERVICE_EXIT%
:node_error
echo Node.js was not found. Cannot stop the service.
:failed
pause
exit /b 1
