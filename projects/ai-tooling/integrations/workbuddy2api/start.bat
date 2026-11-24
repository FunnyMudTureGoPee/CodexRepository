@echo off
chcp 65001 >nul
pushd "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python venv not found: .venv\Scripts\python.exe
    echo.
    echo Run these in this folder first:
    echo     python -m venv .venv
    echo     python -m pip install -r requirements.txt
    echo.
    pause
    popd
    exit /b 1
)

echo Starting workbuddy2api on 127.0.0.1:8787 ...
echo   Admin  http://127.0.0.1:8787/admin/
echo   API    http://127.0.0.1:8787/v1
echo Press Ctrl+C to stop.
echo.

".venv\Scripts\python.exe" "run-local.py"
set "RC=%errorlevel%"

popd
exit /b %RC%
