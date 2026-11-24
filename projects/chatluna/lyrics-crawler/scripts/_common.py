"""scripts/_common.py — 交互式一键脚本的公共工具: 路径、输入提示、运行。"""
from __future__ import annotations

import os
import sys


def ensure_project() -> None:
    """把项目根目录加入 sys.path, 以便 import lyrics_crawler。"""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)


def ask(label: str, default: str = "", required: bool = False) -> str:
    """带默认值/必填的输入提示。"""
    while True:
        hint = f" [{default}]" if default else ""
        raw = input(f"{label}{hint}: ").strip()
        if raw:
            return raw
        if default != "":
            return default
        if not required:
            return ""
        print("   ↑ 该项必填, 请重新输入")


def ask_int(label: str, default: int = 0) -> int:
    """输入整数; 允许 -1(尽力搜索)与非负整数。"""
    while True:
        raw = input(f"{label} [{default}]: ").strip()
        if raw == "":
            return default
        try:
            v = int(raw)
            if v == -1 or v >= 0:
                return v
        except ValueError:
            pass
        print("   ↑ 请输入整数(或 -1 表示尽力搜索)")


def ask_yesno(label: str, default: bool = False) -> bool:
    d = "Y/n" if default else "y/N"
    raw = input(f"{label} ({d}): ").strip().lower()
    if raw == "":
        return default
    return raw in ("y", "yes", "是", "1")


def run(argv: list[str]) -> int:
    """把 argv 交给 lyrics_crawler.cli.main 执行。"""
    sys.argv = ["lyrics_crawler"] + argv
    from lyrics_crawler import cli
    return cli.main()
