"""scripts/merge.py — 把源工作区合并进目标工作区(歌单/已抓/歌词并集, 按去重键去重, 重新分页)。"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import _common as C

C.ensure_project()


def load_json(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_json(p, obj):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


def scan_pages(ws_dir, prefix="lyrics-", suffix=".jsonl"):
    recs = []
    if os.path.isdir(ws_dir):
        for fn in sorted(os.listdir(ws_dir)):
            if fn.startswith(prefix) and fn.endswith(suffix):
                recs += read_jsonl(os.path.join(ws_dir, fn))
    return recs


def main() -> int:
    p = argparse.ArgumentParser(
        description="合并工作区: 把源(如 default)合并进目标(如 a-洛天依)。歌单/已抓/歌词按去重键去重并重新分页。")
    p.add_argument("--from", dest="src", help="源工作区名(被合并进来的, 如 default)")
    p.add_argument("--to", dest="dst", help="目标工作区名(合并到这里, 如 a-洛天依)")
    p.add_argument("--output", default="output", help="输出根目录(默认 output)")
    p.add_argument("--page-size", type=int, default=500)
    a = p.parse_args()

    if not a.src or not a.dst:
        print("用法: merge.bat --from default --to a-洛天依")
        return 1
    root = a.output
    src_dir = os.path.join(root, a.src)
    dst_dir = os.path.join(root, a.dst)
    if not os.path.isdir(src_dir) or not os.path.isdir(dst_dir):
        print(">>> 工作区不存在:", a.src, "->", a.dst)
        return 1

    try:
        from lyrics_crawler.cli import _song_key
    except Exception as e:
        print("import error:", e)
        return 1

    # 1) 歌单并集(目标优先, 按 _song_key 去重)
    src_songs = read_jsonl(os.path.join(src_dir, "songs.jsonl"))
    dst_songs = read_jsonl(os.path.join(dst_dir, "songs.jsonl"))
    merged_songs = {}
    for s in dst_songs:
        merged_songs[_song_key(s.get("title", ""), s.get("artist", ""))] = s
    for s in src_songs:
        k = _song_key(s.get("title", ""), s.get("artist", ""))
        if k not in merged_songs:
            merged_songs[k] = s
    write_jsonl(os.path.join(dst_dir, "songs.jsonl"), list(merged_songs.values()))

    # 2) 已抓登记并集(目标优先)
    src_seen = load_json(os.path.join(src_dir, "seen.json"))
    dst_seen = load_json(os.path.join(dst_dir, "seen.json"))
    merged_seen = dict(dst_seen)
    for k, v in src_seen.items():
        merged_seen.setdefault(k, v)
    save_json(os.path.join(dst_dir, "seen.json"), merged_seen)

    # 3) 歌词并集(按 id 去重), 重新分页写入目标
    src_recs = scan_pages(src_dir)
    dst_recs = scan_pages(dst_dir)
    merged_recs = {}
    for r in dst_recs:
        if r.get("id"):
            merged_recs[r["id"]] = r
    for r in src_recs:
        mid = r.get("id")
        if mid and mid not in merged_recs:
            merged_recs[mid] = r
    # 删除目标旧歌词页, 重新分页
    if os.path.isdir(dst_dir):
        for fn in os.listdir(dst_dir):
            if fn.startswith("lyrics-") and fn.endswith(".jsonl"):
                try:
                    os.remove(os.path.join(dst_dir, fn))
                except OSError:
                    pass
    all_recs = list(merged_recs.values())
    page_size = max(1, a.page_size)
    for i in range(0, len(all_recs), page_size):
        write_jsonl(os.path.join(dst_dir, f"lyrics-{i // page_size + 1:03d}.jsonl"),
                    all_recs[i:i + page_size])

    print(f">>> 合并完成: 歌单 {len(merged_songs)} 首, 已抓 {len(merged_seen)} 首, 歌词 {len(all_recs)} 首")
    print(f"    目录: {dst_dir}")
    print(f"    之后可在菜单选「断点续传」继续抓剩余。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
