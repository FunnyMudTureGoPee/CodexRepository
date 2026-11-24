@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 合并工作区: 把源(如 default)合并进目标(如 a-洛天依)
REM 示例: merge.bat --from default --to a-洛天依
python scripts\merge.py %*
endlocal
