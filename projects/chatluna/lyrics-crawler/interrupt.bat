@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 断点终止: 向正在运行的任务发出停止信号(处理完当前首后优雅保存并退出)
python scriptsinterrupt.py %*
endlocal