@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE (
  echo Node.js 20+ is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
if not defined PORT set "PORT=8766"
rem This file holds only a local proxy URL; environment proxy settings take priority.
if exist "%~dp0proxy-url.txt" if not defined HTTPS_PROXY (
  set /p "HTTPS_PROXY=" < "%~dp0proxy-url.txt"
)
if defined HTTPS_PROXY if not defined HTTP_PROXY set "HTTP_PROXY=%HTTPS_PROXY%"
if not defined NO_PROXY set "NO_PROXY=localhost,127.0.0.1"
echo Starting Gemini API Tester at http://127.0.0.1:%PORT%
echo Open the URL above in your browser. Press Ctrl+C to stop.
set "NODE_PROXY_ARG="
"%NODE_EXE%" --help | findstr /C:"--use-env-proxy" >nul
if not errorlevel 1 set "NODE_PROXY_ARG=--use-env-proxy"
if defined HTTPS_PROXY if not defined NODE_PROXY_ARG (
  echo Your Node.js version cannot use environment proxies. Node.js 24.5+ is required for this proxy configuration.
  pause
  exit /b 1
)
"%NODE_EXE%" %NODE_PROXY_ARG% server.mjs
if errorlevel 1 (
  echo Check the error above, or run: node server.mjs
  pause
)
