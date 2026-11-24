"""scripts/resume.py — 断点续传: 列出所有工作区, 你选一个继续(无需手动输入歌手/歌名)。"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C

C.ensure_project()

OUT = "output"


def _load_json(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _scan(out: str = OUT) -> list[dict]:
    """扫描 output 下所有工作区, 返回其状态(歌手/歌名/已抓/总数/剩余/时间)。"""
    ws: list[dict] = []
    if not os.path.isdir(out):
        return ws
    try:
        from lyrics_crawler.cli import _song_key
    except Exception:
        return ws
    for name in os.listdir(out):
        d = os.path.join(out, name)
        if not os.path.isdir(d):
            continue
        songs = os.path.join(d, "songs.jsonl")
        if not os.path.exists(songs):
            continue
        state = _load_json(os.path.join(d, "state.json"))
        seen = _load_json(os.path.join(d, "seen.json"))
        total = 0
        remaining = 0
        seen_keys = set(seen.keys())
        try:
            with open(songs, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    j = json.loads(line)
                    total += 1
                    if _song_key(j.get("title", ""), j.get("artist", "")) not in seen_keys:
                        remaining += 1
        except Exception:
            pass
        artist, query = state.get("artist", ""), state.get("query", "")
        if not artist and not query:
            if name.startswith("a-"):
                artist = name[2:]
            elif name.startswith("q-"):
                query = name[2:]
        meta = os.path.join(d, "state.json")
        mtime = os.path.getmtime(meta) if os.path.exists(meta) else (
            os.path.getmtime(songs) if os.path.exists(songs) else 0)
        ws.append({
            "name": name, "artist": artist, "query": query,
            "done": len(seen), "total": total, "remaining": remaining, "mtime": mtime,
        })
    return ws


def main() -> int:
    p = argparse.ArgumentParser(description="断点续传: 列出所有工作区, 选一个继续(无需手输歌手/歌名)")
    p.add_argument("--workers", type=int, default=None, help="并行抓取线程数(默认3)")
    p.add_argument("--output", default="output", help="输出根目录(默认 output)")
    p.add_argument("--index", type=int, default=None, help="直接指定工作区编号(跳过交互)")
    a = p.parse_args()

    ws = _scan(a.output)
    if not ws:
        print(">>> 未找到任何工作区/断点(输出根目录下没有歌单)。请先跑一次抓取。")
        input("按 Enter 退出...")
        return 1

    # 排序: 未完成优先, 再按最近修改
    ws.sort(key=lambda w: (w["remaining"] == 0, -w["mtime"]))
    print(f"找到 {len(ws)} 个工作区:")
    print("=" * 56)
    for i, w in enumerate(ws, 1):
        status = "未完成" if w["remaining"] > 0 else "已完成"
        target = f"歌手={w['artist']}" if w["artist"] else (f"歌名={w['query']}" if w["query"] else "通用")
        print(f"  [{i}] {w['name']:<18} {target:<18} "
              f"歌单 {w['total']} / 已抓 {w['done']} / 剩余 {w['remaining']}  [{status}]")
    print("=" * 56)

    # 选一个: 只有1个自动选; 给了 --index 直接用; 否则交互
    if len(ws) == 1:
        idx = 1
    elif a.index is not None:
        if not (1 <= a.index <= len(ws)):
            print(f">>> 编号越界(1-{len(ws)})。"); return 1
        idx = a.index
    else:
        raw = input(f"请选择要续传的工作区编号 (1-{len(ws)}, 回车=1): ").strip()
        try:
            idx = int(raw) if raw else 1
        except ValueError:
            idx = 1
        if not (1 <= idx <= len(ws)):
            print(f">>> 编号越界(1-{len(ws)})。"); return 1

    t = ws[idx - 1]
    print(f">>> 将续传工作区: {t['name']}")
    print(f"    artist={t['artist'] or '-'}  query={t['query'] or '-'}  "
          f"歌单 {t['total']} 首, 已抓 {t['done']} 首, 剩余 {t['remaining']} 首")
    workers = a.workers if a.workers is not None else C.ask_int("并行抓取线程数(默认3)", 3)

    argv = ["--prefix", t["name"], "--output", a.output, "--workers", str(workers)]
    if t["query"]:
        argv += ["--query", t["query"]]
    elif t["artist"]:
        argv += ["--artist", t["artist"]]
    argv += ["--resume"]
    sys.exit(C.run(argv))


if __name__ == "__main__":
    sys.exit(main())
