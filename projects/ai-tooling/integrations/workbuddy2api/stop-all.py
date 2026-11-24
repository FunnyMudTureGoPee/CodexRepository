#!/usr/bin/env python3
"""workbuddy2api 停止器（兜底用）。

正常停止只需在启动器窗口按 Ctrl+C 或关闭窗口。
本脚本用于窗口丢失、进程残留时按「进程 ID / 端口」精确清理：
只终止 python.exe（应用）与 caddy.exe（反向代理），不会误杀其他程序。

用法：
    stop-all.bat
    .venv\\Scripts\\python.exe stop-all.py [--app-port 8787] [--proxy-port 8080]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_FILE = ROOT / "local-data" / "launcher.pid"
ENV_FILE = ROOT / ".env.local"

# 只有这两个进程名允许被终止
ALLOWED_NAMES = {"python.exe", "caddy.exe"}


def say(text: str = "") -> None:
    try:
        print(text, flush=True)
    except OSError:
        pass


def pause() -> None:
    """双击运行时保留窗口；非交互环境直接返回。"""
    try:
        if not sys.stdin or not sys.stdin.isatty():
            return
        input("\n按回车键关闭窗口 ... ")
    except (EOFError, KeyboardInterrupt, OSError):
        pass


def process_name(pid: int) -> str | None:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r'^"([^"]+)"', out.strip())
    return match.group(1) if match else None


def kill(pid: int, label: str) -> bool:
    name = process_name(pid)
    if name is None:
        say(f"  - PID {pid}（{label}）不存在，跳过")
        return False
    if name.lower() not in ALLOWED_NAMES:
        say(f"  ! PID {pid}（{label}）实际是 {name}，不是本项目的进程，已跳过")
        return False
    try:
        # taskkill 会输出本地化的 GBK 文本，这里不需要它的输出
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        say(f"  ! 终止 PID {pid} 失败：{exc}")
        return False
    say(f"  v 已停止 PID {pid}（{label} / {name}）")
    return True


def pids_on_port(port: int) -> list[int]:
    """从 netstat 里找出监听指定端口的进程 ID。"""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    wanted = f":{port} "
    found = []
    for line in out.splitlines():
        if "LISTENING" not in line or wanted not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[-1])
        except ValueError:
            continue
        if pid not in found:
            found.append(pid)
    return found


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    env = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()

    parser = argparse.ArgumentParser(description="workbuddy2api 停止器")
    parser.add_argument("--app-port", type=int, default=int(env.get("PORT") or 8787))
    parser.add_argument("--proxy-port", type=int, default=8080)
    args = parser.parse_args()

    say("=" * 58)
    say("  workbuddy2api 停止器")
    say("=" * 58)
    say()

    stopped = 0
    seen: set[int] = set()

    # 1) 优先按启动器记录的 PID
    if PID_FILE.exists():
        try:
            record = json.loads(PID_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            record = {}
        say("  按启动器记录清理：")
        for key, label in (("proxy", "反向代理"), ("app", "协议转换服务")):
            pid = record.get(key)
            if isinstance(pid, int) and pid not in seen:
                seen.add(pid)
                stopped += kill(pid, label)
        try:
            PID_FILE.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        say("  未找到启动器 PID 记录，改为按端口扫描。")

    # 2) 兜底按端口扫描
    say()
    say("  按端口扫描：")
    hit = False
    for port, label in ((args.proxy_port, "反向代理"), (args.app_port, "应用")):
        for pid in pids_on_port(port):
            if pid in seen:
                continue
            seen.add(pid)
            hit = True
            stopped += kill(pid, f"{label} 端口 {port}")
    if not hit:
        say("  - 两个端口都没有在本项目进程中监听")

    say()
    say(f"  完成，共停止 {stopped} 个进程。")
    say()
    pause()
    return 0


if __name__ == "__main__":
    sys.exit(main())
