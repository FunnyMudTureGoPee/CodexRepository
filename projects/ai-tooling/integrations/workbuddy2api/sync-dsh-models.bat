@echo off
rem Sync workbuddy2api model metadata into the dsh provider config.
rem Double-click this file. Needs dsh to be restarted afterwards.
setlocal
pushd "%~dp0"
echo.
echo === Sync dsh model config from workbuddy2api ===
echo.
".venv\Scripts\python.exe" sync-dsh-models.py %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo [OK] Written. Restart dsh to apply.
) else (
  echo [FAILED] exit code %RC%
)
popd
echo.
pause
