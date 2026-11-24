@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 断点续传: 自动定位到相同 artist/query 的断点并继续
REM 示例: resume.bat --artist "洛天依"
python scriptsesume.py %*
endlocal