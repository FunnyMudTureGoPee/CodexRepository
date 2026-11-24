"""scripts/interrupt.py — 断点终止: 向正在运行的任务发出停止信号(优雅保存后退出)。"""
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

out_dir = os.path.join("output")
mtime = 0
target = None
for st in glob.glob(os.path.join("output", "*", "*.state.json")):
    try:
        t = os.path.getmtime(st)
    except OSError:
        continue
    if t > mtime:
        mtime = t
        target = st

if target is None:
    print(">>> 未找到任何断点/运行中的任务(output 下没有 *.state.json)。")
    sys.exit(1)

state = {}
try:
    with open(target, "r", encoding="utf-8") as fh:
        state = json.load(fh)
except Exception:
    pass
name = os.path.basename(target).replace(".state.json", "")
print(f">>> 将终止最近的任务: {target}   (artist={state.get('artist','')} query={state.get('query','')})")
raw = input("确认终止? (y/N): ").strip().lower()
if raw not in ("y", "yes", "是", "1"):
    print("已取消。")
    sys.exit(0)

stopfile = target + ".stop"
with open(stopfile, "w", encoding="utf-8") as fh:
    fh.write("stop\n")
print(f">>> 已写入停止信号 {stopfile}")
print(">>> 任务会在处理完当前首后优雅保存并退出。之后可用 resume.bat 断点续传。")
sys.exit(0)
