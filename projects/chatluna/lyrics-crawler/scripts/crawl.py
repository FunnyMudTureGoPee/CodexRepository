"""scripts/crawl.py — 交互式完整抓取(可带参数, 缺省时提示输入)。"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C

C.ensure_project()
p = argparse.ArgumentParser(description="完整抓取: 拉歌单 -> 抓歌词 -> 交叉验证")
p.add_argument("--artist", help="歌手名称")
p.add_argument("--query", help="歌名/搜索词")
p.add_argument("--sources", default="all", help="来源: 逗号分隔 / music / wiki / all")
p.add_argument("--limit", type=int, default=None, help="每来源搜索数量")
p.add_argument("--total", type=int, default=None, help="最终总数上限(0=不限)")
p.add_argument("--page-size", type=int, default=None, help="每页/每次抓多少首(数量分页, 默认500)")
p.add_argument("--workers", type=int, default=None, help="并行抓取线程数(默认3)")
p.add_argument("--singer", action="store_true", help="虚拟歌手模式")
p.add_argument("--quiet", action="store_true", help="不打印进度")
a = p.parse_args()

artist = a.artist or C.ask("歌手名称(抓其歌曲, 回车则不填)")
query = a.query or C.ask("歌名/搜索词(精确抓某首歌, 回车则不填)")
if not artist and not query and not a.singer:
    print(">>> 请至少提供其中之一: --artist 或 --query (歌名)。")
    sys.exit(1)
sources = a.sources or C.ask("来源(逗号分隔或 music/wiki/all)", "all")
limit = a.limit if a.limit is not None else C.ask_int("每来源搜索数量(-1 为尽力搜索)", 20)
total = a.total if a.total is not None else C.ask_int("最终总数上限(0=不限)", 0)
page_size = a.page_size if a.page_size is not None else C.ask_int("每页/每次抓多少首(分页)", 500)
workers = a.workers if a.workers is not None else C.ask_int("并行抓取线程数(过大可能限流)", 3)
singer = a.singer or C.ask_yesno("是否虚拟歌手模式?", False)

argv = []
if artist:
    argv += ["--artist", artist]
if query:
    argv += ["--query", query]
argv += ["--sources", sources, "--limit", str(limit), "--page-size", str(page_size), "--workers", str(workers)]
if total:
    argv += ["--total", str(total)]
if singer:
    argv += ["--singer"]
if a.quiet:
    argv += ["--quiet"]
sys.exit(C.run(argv))
