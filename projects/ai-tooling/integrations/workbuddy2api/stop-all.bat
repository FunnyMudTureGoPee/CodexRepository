@echo off
chcp 65001 >nul
pushd "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python venv not found: .venv\Scripts\python.exe
    pause
    popd
    exit /b 1
)

".venv\Scripts\python.exe" "stop-all.py" %*
set "RC=%errorlevel%"

popd
exit /b %RC%
