@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 完整抓取(可传参数, 缺省则交互提示): 拉歌单 -> 抓歌词 -> 交叉验证
REM 示例: crawl.bat --artist "洛天依" --singer
python scriptscrawl.py %*
endlocal