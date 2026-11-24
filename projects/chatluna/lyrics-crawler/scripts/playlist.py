"""scripts/playlist.py — 交互式“仅歌单”: 只生成歌单文件, 不抓歌词。"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C

C.ensure_project()
p = argparse.ArgumentParser(description="仅生成歌单(不抓歌词)")
p.add_argument("--artist", help="歌手名称")
p.add_argument("--sources", default="all")
p.add_argument("--limit", type=int, default=None, help="歌单每来源数量")
p.add_argument("--total", type=int, default=None)
p.add_argument("--page-size", type=int, default=None,
               help="每页/每次抓多少首(仅用于后续从本歌单抓歌词时; 本阶段生成歌单不抓歌词)")
p.add_argument("--singer", action="store_true")
p.add_argument("--quiet", action="store_true")
a = p.parse_args()

artist = a.artist or C.ask("歌手名称", "", required=True)
sources = a.sources or C.ask("来源(逗号分隔或 music/wiki/all)", "all")
limit = a.limit if a.limit is not None else C.ask_int("歌单每来源数量(-1 为尽力搜索)", 50)
total = a.total if a.total is not None else C.ask_int("歌单总数上限(0=不限)", 0)
singer = a.singer or C.ask_yesno("虚拟歌手模式?", False)

argv = ["--artist", artist, "--sources", sources, "--limit", str(limit), "--songs-only"]
if a.page_size:
    argv += ["--page-size", str(a.page_size)]
if total:
    argv += ["--total", str(total)]
if singer:
    argv += ["--singer"]
if a.quiet:
    argv += ["--quiet"]
sys.exit(C.run(argv))
