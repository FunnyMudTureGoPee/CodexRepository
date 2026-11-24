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

start "workbuddy2api" ".venv\Scripts\python.exe" "launcher.py" %*
if errorlevel 1 (
    echo [ERROR] launcher failed to start.
    pause
)

popd
exit /b 0
