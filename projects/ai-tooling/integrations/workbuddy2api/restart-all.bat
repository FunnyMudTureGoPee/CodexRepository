@echo off
chcp 65001 >nul
pushd "%~dp0"

rem ============================================================
rem  Run this after editing ANY .py in this project.
rem  run-local.py calls uvicorn.run without reload, so source
rem  edits do NOT take effect until the process is restarted.
rem  This script does: stop-all.py  ->  launcher.py
rem ============================================================

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv\Scripts\python.exe not found.
    echo         Run first:  python -m venv .venv  ^&^&  python -m pip install -r requirements.txt
    pause
    popd
    exit /b 1
)

echo.
echo [1/2] Stopping old service ...
rem <nul makes the "press Enter" prompt inside stop-all.py skip itself
".venv\Scripts\python.exe" "stop-all.py" <nul

echo.
echo [2/2] Starting service ...
start "workbuddy2api" ".venv\Scripts\python.exe" "launcher.py" --no-browser

echo.
echo Ready.  Admin  http://127.0.0.1:8787/admin/
echo         API    http://127.0.0.1:8787/v1
echo.
popd
exit /b 0
