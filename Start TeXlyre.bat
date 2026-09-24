@echo off
rem Start TeXlyre + SSH: opens the TeXlyre dev server and the SFTP bridge in
rem their own windows (skipping any that are already running), then opens
rem TeXlyre in your browser. Close a window to stop that program.
setlocal
title TeXlyre + SSH launcher
cd /d "%~dp0"

if not defined TEXLYRE_PORT set TEXLYRE_PORT=5173
if not defined BRIDGE_PORT set BRIDGE_PORT=7050
set "URL=http://localhost:%TEXLYRE_PORT%/texlyre/"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo First run: installing TeXlyre dependencies, this takes a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed, see the messages above.
    pause
    exit /b 1
  )
)
if not exist "sftp-bridge\node_modules\ssh2" (
  echo Installing SFTP bridge dependencies...
  pushd sftp-bridge
  call npm install --no-audit --no-fund
  popd
)

netstat -ano | findstr /r /c:":%TEXLYRE_PORT% .*LISTENING" >nul
if errorlevel 1 (
  echo Starting TeXlyre...
  start "TeXlyre dev server (close to stop)" cmd /k node node_modules\vite\bin\vite.js --port %TEXLYRE_PORT% --strictPort
) else (
  echo TeXlyre is already running.
)

netstat -ano | findstr /r /c:":%BRIDGE_PORT% .*LISTENING" >nul
if errorlevel 1 (
  echo Starting the SFTP bridge...
  start "TeXlyre SFTP bridge (close to stop)" /d "%~dp0sftp-bridge" cmd /k "set WS_PORT=%BRIDGE_PORT%&& node bridge.cjs"
) else (
  echo The SFTP bridge is already running.
)

echo Waiting for TeXlyre at %URL% ...
for /l %%i in (1,1,90) do (
  curl -sf -o nul "%URL%" && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo TeXlyre did not respond within 90 seconds. Check the "TeXlyre dev server" window.
pause
exit /b 1

:ready
rem Hand the bridge token to TeXlyre in the URL so nobody has to paste it.
rem The bridge writes the token file before it starts listening.
for /l %%i in (1,1,30) do (
  netstat -ano | findstr /r /c:":%BRIDGE_PORT% .*LISTENING" >nul && goto bridge_ready
  ping -n 2 127.0.0.1 >nul
)
:bridge_ready
set "TOKEN="
set "TOKEN_FILE=%USERPROFILE%\.texlyre-sftp-bridge\token"
if exist "%TOKEN_FILE%" for /f "usebackq delims=" %%t in ("%TOKEN_FILE%") do set "TOKEN=%%t"
set "OPEN_URL=%URL%"
if defined TOKEN set "OPEN_URL=%URL%?sftp-bridge-token=%TOKEN%"
if not defined NO_BROWSER start "" "%OPEN_URL%"
endlocal
