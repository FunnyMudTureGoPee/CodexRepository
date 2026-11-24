@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 从歌单生成: 基于已有 .songs.jsonl 抓歌词
REM 示例: fromlist.bat --songs-file "output\2026-08-27\lyrics-001.songs.jsonl"
python scriptsromlist.py %*
endlocal