"""scripts/fromlist.py — 交互式“从歌单生成”: 基于歌单文件抓歌词(无需搜索/发现)。"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C

C.ensure_project()
p = argparse.ArgumentParser(description="从歌单文件抓歌词(跳过发现阶段, 无需搜索数量)")
p.add_argument("--songs-file", help="歌单文件路径(.songs.jsonl)")
p.add_argument("--sources", default="all")
p.add_argument("--page-size", type=int, default=None, help="每次/每页抓多少首(数量分页)")
p.add_argument("--workers", type=int, default=None, help="并行抓取线程数(默认3)")
p.add_argument("--total", type=int, default=None)
p.add_argument("--quiet", action="store_true")
a = p.parse_args()

songs = a.songs_file or C.ask("歌单文件路径(.songs.jsonl)", "", required=True)
sources = a.sources or C.ask("来源(逗号分隔或 music/wiki/all)", "all")
page_size = a.page_size if a.page_size is not None else C.ask_int("每次/每页抓多少首(分页)", 500)
workers = a.workers if a.workers is not None else C.ask_int("并行抓取线程数(默认3)", 3)
total = a.total if a.total is not None else 0

argv = ["--songs-file", songs, "--sources", sources, "--page-size", str(page_size), "--workers", str(workers)]
if total:
    argv += ["--total", str(total)]
if a.quiet:
    argv += ["--quiet"]
sys.exit(C.run(argv))
