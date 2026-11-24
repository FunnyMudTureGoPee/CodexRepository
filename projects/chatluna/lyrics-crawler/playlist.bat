@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 仅歌单: 只生成歌单文件, 不抓歌词
REM 示例: playlist.bat --artist "洛天依" --singer --limit 100
python scriptsplaylist.py %*
endlocal