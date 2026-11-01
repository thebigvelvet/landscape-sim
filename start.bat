@echo off
setlocal
title Landscape Time-Lapse
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Opening the download page - install the "LTS" version, then double-click start.bat again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" goto install
if not exist "node_modules\electron\install.js" goto install
goto launch

:install
echo.
echo   First run: installing the simulator's parts. This takes a minute or two...
echo.
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo   Installing failed. Check the internet connection and try again.
  pause
  exit /b 1
)

:launch
node scripts\launch.cjs %*
if errorlevel 1 (
  echo.
  echo   The simulator could not start. See the message above.
  pause
  exit /b 1
)
exit /b 0
