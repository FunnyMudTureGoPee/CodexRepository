@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 一键菜单主入口(选择 抓取/仅歌单/从歌单/续传/终止)
python scripts\menu.py %*
endlocal