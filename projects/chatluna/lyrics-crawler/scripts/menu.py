"""scripts/menu.py — 一键菜单主入口: 选择 抓取/仅歌单/从歌单/续传/终止。"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C

C.ensure_project()

# (名称, 子脚本, 是否抓取歌词: 抓取类会询问/传入线程数)
OPTIONS = {
    "1": ("完整抓取", "crawl.py", True),
    "2": ("仅歌单", "playlist.py", False),
    "3": ("从歌单生成", "fromlist.py", True),
    "4": ("断点续传", "resume.py", True),
    "5": ("断点终止", "interrupt.py", False),
    "6": ("合并工作区", "merge.py", False),
}


def _show_menu() -> None:
    print("=" * 46)
    print("   lyrics_crawler  一键菜单")
    print("=" * 46)
    print("   1) 完整抓取    拉歌单 -> 抓歌词 -> 交叉验证")
    print("   2) 仅歌单      只生成歌单文件")
    print("   3) 从歌单生成  基于 .songs.jsonl 抓歌词")
    print("   4) 断点续传    继续上次未完成的部分")
    print("   5) 断点终止    让运行中的任务停下来(保存进度)")
    print("   6) 合并工作区  把一个工作区合并进另一个(如 default -> a-洛天依)")
    print("   0) 退出")
    print("=" * 46)


def _run_child(name: str, extra: list | None = None) -> None:
    label, script, _ = OPTIONS[name]
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), script)
    args = [sys.executable, script] + (extra or [])
    print(f">>> 启动: {label}  ({script})" + (f"  [{' '.join(extra)}]" if extra else ""))
    subprocess.call(args)
    print()


def main() -> int:
    workers = 3
    while True:
        _show_menu()
        raw = input("请选择 (0-5): ").strip()
        if raw == "0":
            print("再见！")
            return 0
        if raw in OPTIONS:
            _label, _script, is_fetch = OPTIONS[raw]
            extra: list[str] = []
            if raw == "6":
                src = C.ask("源工作区名(被合并进来的, 如 default)", "", required=True)
                dst = C.ask("目标工作区名(合并到这里, 如 a-洛天依)", "", required=True)
                extra += ["--from", src, "--to", dst]
            elif is_fetch:
                workers = C.ask_int("并行抓取线程数(默认3, 过大可能被限流)", workers)
                extra += ["--workers", str(workers)]
            _run_child(raw, extra)
        else:
            print("无效选择, 请输入 0-5。")
        try:
            input("按 Enter 返回菜单...")
        except EOFError:
            return 0


if __name__ == "__main__":
    sys.exit(main())
