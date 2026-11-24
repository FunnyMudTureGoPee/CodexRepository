@echo off
chcp 65001 >nul
pushd "%~dp0"

set "CADDY=..\tools\caddy\caddy.exe"
if defined CADDY_EXE set "CADDY=%CADDY_EXE%"

set "XDG_DATA_HOME=%~dp0local-data\caddy\data"
set "XDG_CONFIG_HOME=%~dp0local-data\caddy\config"

if not exist "%CADDY%" (
    echo [ERROR] caddy.exe not found.
    echo Set environment variable CADDY_EXE to its full path if it lives elsewhere.
    pause
    popd
    exit /b 1
)

echo Starting reverse proxy on 127.0.0.1:8080 ...
echo   Admin  http://127.0.0.1:8080/admin/
echo   API    http://127.0.0.1:8080/v1
echo Start the app first if it is not running yet.
echo Press Ctrl+C to stop.
echo.

"%CADDY%" run --config "%~dp0deploy\local\Caddyfile" --adapter caddyfile
set "RC=%errorlevel%"

popd
exit /b %RC%
