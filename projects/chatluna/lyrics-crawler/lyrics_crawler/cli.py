"""cli.py — 命令行入口: 拉取歌单(网易云优先) → 抓歌词 → 萌娘/VCPedia 交叉验证 → 可断点续抓, 输出 JSONL。"""
from __future__ import annotations

import argparse
import atexit
import datetime
import json
import os
import re
import sys
import time
from collections import defaultdict
from typing import Optional

from .config import SOURCE_PRIORITY, is_virtual_singer
from .models import ErrorRecord, LyricsRecord, TrackCandidate, make_source_id, normalize_text
from .output import validate_jsonl, write_errors, write_jsonl, write_status
from .registry import MUSIC_SOURCES, WIKI_SOURCES, all_sources, resolve
from .sources.base import BaseSource, LyricsUnavailable, RateLimited, SongNotFound

DEFAULT_PREFIX = "lyrics-001"
MAX_FAIL_RETRIES = 3   # 单首歌最多重试次数(超过则标记避免反复失败)


def _ts() -> str:
    return time.strftime("%H:%M:%S")


def _norm(s: str) -> str:
    return normalize_text(s).lower()


def _norm_title(t: str) -> str:
    t = _norm(t)
    m = re.search(r"\(([^()]*)\)$", t)
    if m:
        t = t[: m.start()].strip()
    return t


# 全角 -> 半角 常见字符
_FW_MAP = {
    "（": "(", "）": ")", "【": "[", "】": "]", "《": "<", "》": ">",
    "：": ":", "！": "!", "？": "?", "，": ",", "。": ".", "～": "~",
    "　": " ", "\u3000": " ", "／": "/", "－": "-", "℃": "c",
}
# 版本/格式标记: 去重时剥离, 避免 “屋顶” 与 “屋顶(Live)” 被当成两首
_VER_RE = re.compile(
    r"(?i)[\s\-(（\[【]*(?:"
    r"live|l·?ive版?|演唱会|现场版?|dj版?|remix|mix|伴奏|ktv|karaoke|"
    r"cover|翻唱|版本|version|ver\.?\d*|acoustic|钢琴|吉他|小提琴|笛子|"
    r"弦乐|合唱|feat|ft|完整版|纯享|舞台|音乐版|纯音乐"
    r")[\s\)）\]】]*$"
)


def _norm_title_key(t: str) -> str:
    for k, v in _FW_MAP.items():
        t = t.replace(k, v)
    t = _norm(t).lower()
    t = _VER_RE.sub("", t)
    t = re.sub(r"\([^()]*\)$", "", t)          # 剥去尾部括号(歌手名/版本)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _norm_artist_key(artist: str) -> str:
    if not artist:
        return ""
    a = _norm(artist).lower()
    a = re.split(r"[、,/;&＋+]+", a)[0]         # 取第一个署名歌手
    a = re.sub(r"[\(（].*?[\)）]", "", a).strip()
    return a


def _song_key(title: str, artist: str) -> str:
    """歌曲去重键: 归一化歌名(剥版本/括号/全角) + 归一化歌手(取主唱), 用于跨来源去重。"""
    return _norm_title_key(title) + "\x00" + _norm_artist_key(artist)


def _state_path(output_dir: str, prefix: str) -> str:
    return os.path.join(output_dir, prefix + ".state.json")


def _load_state(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(path: str, state: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


def _write_jsonl_append(records: list, path: str) -> None:
    """把记录追加写入 JSONL(不覆盖已有内容, 用于分页累计)。"""
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        for rec in records:
            f.write(json.dumps(rec.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n")


def _count_jsonl(path: str) -> int:
    n = 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
    except FileNotFoundError:
        pass
    return n


def _seen_status(v):
    """seen 值可能是旧字符串("ok"/"failed")或字典 {"status":..., "attempts":...}。"""
    return v.get("status", "failed") if isinstance(v, dict) else v


def _seen_attempts(v):
    return v.get("attempts", 1) if isinstance(v, dict) else 1


def _mark_seen(seen: dict, key: str, status: str) -> None:
    old = seen.get(key)
    base = _seen_attempts(old) if old is not None else 0
    seen[key] = {"status": status, "attempts": base + 1}


def _acquire_lock(path: str) -> bool:
    """尝试获取工作区锁。返回 True 说明获得锁; False 说明已被占用。"""
    import time
    if os.path.exists(path):
        stale = False
        try:
            if time.time() - os.path.getmtime(path) > 15 * 60:
                stale = True
        except OSError:
            stale = True
        if not stale:
            return False
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        return True
    except OSError:
        return False


def _release_lock(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _touch_lock(path: str) -> None:
    """抓取时心跳刷新锁文件 mtime(表示进程仍在运行)。"""
    try:
        now = time.time()
        os.utime(path, (now, now))
    except OSError:
        pass


def _slug(s: str) -> str:
    """把目标转成安全的目录名(保留中文/字母/数字/-_)。"""
    s = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", s or "").strip("_")
    return s or "default"


def _load_seen(path: str) -> dict:
    """载入“已抓登记”: song_key -> ok/failed。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_seen(path: str, seen: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False)
    os.replace(tmp, path)


def _today_str() -> str:
    """今天日期, 用作输出子文件夹名。"""
    return datetime.date.today().isoformat()


def _next_prefix(out_dir: str) -> str:
    """当天调用序号: 统计该日期夹里已有 lyrics-NNN 前缀, 返回下一个(lyrics-001/002/...)。"""
    nums: list[int] = []
    try:
        for fn in os.listdir(out_dir):
            m = re.match(r"lyrics-(\d+)\.", fn)
            if m:
                nums.append(int(m.group(1)))
    except OSError:
        pass
    n = (max(nums) + 1) if nums else 1
    return f"lyrics-{n:03d}"


def _resume_prefix(out_dir: str, artist: str, query: str) -> str | None:
    """断点续抓: 取当天文件夹里 与当前 artist/query 匹配、最近修改 的 state 前缀。"""
    if not os.path.isdir(out_dir):
        return None
    cands: list[tuple[float, str]] = []
    for f in os.listdir(out_dir):
        if not f.endswith(".state.json"):
            continue
        try:
            with open(os.path.join(out_dir, f), "r", encoding="utf-8") as fh:
                st = json.load(fh)
        except Exception:
            continue
        if (st.get("artist") or "") == (artist or "") and (st.get("query") or "") == (query or ""):
            cands.append((os.path.getmtime(os.path.join(out_dir, f)), f))
    if not cands:
        return None
    cands.sort(key=lambda t: t[0], reverse=True)
    return cands[0][1][: -len(".state.json")]


def _cand_to_dict(src: BaseSource, cand: TrackCandidate) -> dict:
    return {
        "source": src.name,
        "id": cand.id,
        "title": cand.title,
        "artist": cand.artist,
        "album": cand.album,
        "source_url": cand.source_url,
        "language": cand.language,
    }


def _cand_from_dict(d: dict, src: "BaseSource | None" = None) -> TrackCandidate:
    return TrackCandidate(
        id=d.get("id", ""),
        title=d.get("title", ""),
        artist=d.get("artist", ""),
        album=d.get("album", ""),
        source_url=d.get("source_url", ""),
        source_name=d.get("source", ""),
        language=d.get("language", "zh"),
    )


class SourceStats:
    def __init__(self) -> None:
        self.ok = 0
        self.errors = 0
        self.validated = 0


def _run_source_lyrics(source: BaseSource, cand: TrackCandidate) -> tuple[LyricsRecord, None] | tuple[None, ErrorRecord]:
    try:
        lyrics, src = source.lyrics(cand)
        rec = source.build_record(cand, lyrics)
        rec.source = src or rec.source
        return rec, None
    except RateLimited as e:
        return None, ErrorRecord(id=make_source_id(source.name, cand.id, cand.title, cand.artist, cand.album), title=cand.title, artist=cand.artist,
                                 status="rate_limited", error=str(e), retry_after=3, source=source.name)
    except (SongNotFound, LyricsUnavailable) as e:
        return None, ErrorRecord(id=make_source_id(source.name, cand.id, cand.title, cand.artist, cand.album), title=cand.title, artist=cand.artist,
                                 status="not_found", error=str(e), source=source.name)
    except Exception as e:
        return None, ErrorRecord(id=make_source_id(source.name, cand.id, cand.title, cand.artist, cand.album), title=cand.title, artist=cand.artist,
                                 status="error", error=f"{type(e).__name__}: {e}", source=source.name)


def _process_song_worker(entry: dict, sname: dict, wiki_sources: list[BaseSource], val_state: dict, seen: dict) -> tuple | None:
    """单个工人线程: 抓取一首歌的歌词(含分级回退)并做百科核验。返回结果元组, 不打印/不改共享计数。"""
    src = sname.get(entry.get("source"))
    if src is None:
        return None
    cand = _cand_from_dict(entry, src)
    key = _song_key(cand.title, cand.artist)
    rec, err = _run_source_lyrics(src, cand)
    use_name = src.name
    if rec is None:
        fallbacks = [n for n in entry.get("hit_sources", []) if n != src.name]
        if "vcpedia" in sname and "vcpedia" not in fallbacks:
            fallbacks.append("vcpedia")
        for fn in fallbacks:
            fs = sname.get(fn)
            if fs is None:
                continue
            try:
                alt = fs.search(cand.title, 1)
            except Exception:
                alt = []
            if not alt:
                continue
            rec, _ = _run_source_lyrics(fs, alt[0])
            if rec is not None:
                use_name = fn
                break
    vres: dict = {}
    if wiki_sources and cand.title:
        vres = _validate_song(cand.title, cand.artist, use_name, wiki_sources, val_state, None)
    return (key, rec, err, use_name, cand.title, cand.artist, vres, src.name)


# 明显无歌词的标题关键词(伴奏/纯电音/纯音乐/无词/卡拉OK/无人声等), 发现时直接跳过
_NO_LYRICS_RE = re.compile(
    r"(?:伴奏|纯音乐|纯音|无词|无人声|无人声版|纯电音|电音版|卡拉ok|ktv|"
    r"instrumental|纯乐器|口哨|哼唱|纯伴奏|元伴奏|无人声)|\b(inst|karaoke)\b",
    re.I,
)


def _has_no_lyrics(title: str) -> bool:
    return bool(title and _NO_LYRICS_RE.search(title))


def _add_candidate(best: dict, hit_counts: dict, src: BaseSource, cand: TrackCandidate, priority: dict, query_artist: str = "") -> None:
    # 去重键: 若候选歌手名包含查询歌手(网易云常为 “作词/其他歌手, 洛天依”), 统一用查询歌手做键,
    # 以便与 VCPedia “歌名(洛天依)” 的同一首歌合并。
    if _has_no_lyrics(cand.title):
        return   # 明显无歌词(伴奏/纯电音等), 直接跳过, 避免抓取失败
    key_artist = cand.artist
    if query_artist and _norm(query_artist) in _norm(cand.artist):
        key_artist = query_artist
    key = _song_key(cand.title, key_artist)
    # 记录命中过这首歌的来源(用于“多平台命中优先”排序)
    hit_counts.setdefault(key, set()).add(src.name)
    p = priority.get(src.name, 99)
    if key not in best or p < best[key][0]:
        best[key] = (p, src, cand)


def _build_song_list(artist: str, query: str, sources: list[BaseSource], per_source: int, singer: bool, log, total_limit: int = 0) -> list[dict]:
    """先拉取歌单: 网易云为主(分页), 其它来源做补充, 并按歌曲去重、保留优先级最高的来源。
    per_source == -1 表示“尽力搜索”: 尽最大分页把各来源能搜到的歌都抓全。"""
    if per_source is not None and per_source == -1:
        per_source = 100000
        log(f"[{_ts()}] 尽力搜索模式: 超大分页抓全各来源(可能较慢)") if log else None
    priority = {s.name: SOURCE_PRIORITY.get(s.name, 99) for s in sources}
    best: dict[str, tuple[int, BaseSource, TrackCandidate]] = {}
    hit_counts: dict[str, set[str]] = {}

    def collect(src: BaseSource, cands: list[TrackCandidate]) -> None:
        for cand in cands:
            _add_candidate(best, hit_counts, src, cand, priority, artist)

    if query:
        # 精确按歌名: 每个来源都搜一遍(交叉验证也基于这个歌名)
        for src in sources:
            log(f"[{_ts()}] [{src.name}] 搜索 \"{query}\" ...")
            try:
                collect(src, src.search(query, per_source))
            except Exception as e:
                log(f"[{_ts()}] [{src.name}] 搜索失败: {e}");
    else:
        # 按歌手: 音乐平台按歌手出歌; 虚拟歌手再启用百科的按歌手发掘
        for src in sources:
            if src.name in MUSIC_SOURCES:
                log(f"[{_ts()}] [{src.name}] 拉取歌手 \"{artist}\" 的歌单 ...")
                try:
                    if hasattr(src, "song_list"):
                        cands = src.song_list(artist, per_source)
                    else:
                        cands = src.search(artist, per_source, artist=artist)
                except Exception as e:
                    log(f"[{_ts()}] [{src.name}] 歌单拉取失败: {e}");
                    cands = []
                collect(src, cands)
            else:
                # wiki: 仅在虚拟歌手场景启用按歌手发掘
                if singer or is_virtual_singer(artist):
                    log(f"[{_ts()}] [{src.name}] 按歌手 \"{artist}\" 检索歌页 ...")
                    try:
                        collect(src, src.discover(artist, per_source))
                    except Exception as e:
                        log(f"[{_ts()}] [{src.name}] 检索失败: {e}");
                else:
                    log(f"[{_ts()}] [{src.name}] 非虚拟歌手, 跳过按歌手检索(可用 --singer 强制)");

    # 歌单排序: 多平台均命中的优先(命中来源数多者在前), 命中数相同则按来源优先级
    entries = []
    for key, (p, src, cand) in best.items():
        e = _cand_to_dict(src, cand)
        e["hits"] = len(hit_counts.get(key, set()))
        # 记录命中过该歌的来源(按优先级排序), 供歌词回退使用
        e["hit_sources"] = sorted(hit_counts.get(key, set()),
                                  key=lambda n: SOURCE_PRIORITY.get(n, 99))
        entries.append(e)
    entries.sort(key=lambda e: (-e.get("hits", 0), SOURCE_PRIORITY.get(e.get("source", ""), 99)))
    if total_limit and total_limit > 0 and len(entries) > total_limit:
        entries = entries[: total_limit]
    return entries


def _validate_song(title: str, artist: str, song_src_name: str, wiki_sources: list[BaseSource], val_state: dict, log) -> dict:
    """用萌娘/VCPedia 对一首歌做交叉验证, 返回 {sourceName: found|missing|unavailable}。
    已处理过的歌名不会重复查询(断点续抓时复用)。"""
    if not title or not wiki_sources:
        return {}
    res: dict[str, str] = {}
    for wsrc in wiki_sources:
        if wsrc.name == song_src_name:
            res[wsrc.name] = "found";  # 歌词已来自该百科, 视为已命中
            continue
        cache_key = f"v|{title}|{wsrc.name}"
        if cache_key in val_state:
            res[wsrc.name] = val_state[cache_key]
            continue
        # 轻量核验: 优先用 exists()(只搜标题不拉整页, 更快); 否则退回 search
        try:
            if hasattr(wsrc, "exists"):
                status = "found" if wsrc.exists(title) else "missing"
            else:
                cands = wsrc.search(title, 1)
                if cands:
                    wt = _norm_title(cands[0].title)
                    qt = _norm_title(title)
                    status = "found" if (wt == qt or (qt and qt in wt)) else "missing"
                else:
                    status = "missing"
        except SongNotFound:
            status = "unavailable"
        except Exception:
            status = "unavailable"
        res[wsrc.name] = status
        val_state[cache_key] = status
    return res


def _err_from_dict(d: dict) -> ErrorRecord:
    return ErrorRecord(
        id=d.get("id", ""),
        title=d.get("title", ""),
        artist=d.get("artist", ""),
        status=d.get("status", "error"),
        error=d.get("error", ""),
        attempts=d.get("attempts", 1),
        retry_after=d.get("retryAfter"),
        source=d.get("source", ""),
    )


def _load_existing(jsonl_path: str, err_path: str) -> tuple[list[LyricsRecord], list[ErrorRecord]]:
    """断点续抓时, 重新载入已生成的 lyrics/errors, 以保留之前抓到的结果。"""
    records: list[LyricsRecord] = []
    errors: list[ErrorRecord] = []
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                records.append(LyricsRecord(**d))
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        pass
    try:
        with open(err_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                errors.append(_err_from_dict(d))
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        pass
    return records, errors


def write_song_entries(entries: list[dict], path: str) -> int:
    """把歌单(候选歌曲元数据, 不含歌词)逐行写入 JSONL。"""
    n = 0
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def load_song_entries(path: str) -> list[dict]:
    """从歌单 JSONL 载入候选歌曲列表(文件不存在返回 [])。"""
    if not os.path.exists(path):
        return []
    entries: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("title"):
                entries.append(d)
    return entries


def _reconstruct_from_done(done: dict) -> tuple[list[LyricsRecord], list[ErrorRecord]]:
    """从断点状态还原已抓取的歌词与失败记录(即使 jsonl 尚未写出也能恢复)。"""
    records: list[LyricsRecord] = []
    errors: list[ErrorRecord] = []
    for v in done.values():
        rec = v.get("record")
        if rec and rec.get("id"):
            try:
                records.append(LyricsRecord(**rec))
            except TypeError:
                pass
        if "error" in v:
            errors.append(_err_from_dict(v["error"]))
    return records, errors


def _summarize_validation(val_state: dict) -> dict:
    from collections import Counter
    by_status: Counter = Counter()
    songs = set()
    checks = 0
    for k, v in val_state.items():
        if not k.startswith("v|"):
            continue
        songs.add(k.split("|")[1])
        by_status[v] += 1
        checks += 1
    return {"validated_songs": len(songs), "validation_checks": checks, "by_status": dict(by_status)}


def run_crawl(artist: str, query: str, sources: list[BaseSource], per_source: int,
              output_dir: str, quiet: bool = False, singer: bool = False,
              resume: bool = False, songs_file: str = "", songs_only: bool = False,
              total: int = 0, page_size: int = 500, prefix: str = "",
              workers: int = 3) -> dict:
    start = time.time()

    def log(*parts) -> None:
        if not quiet:
            print(" ".join(str(p) for p in parts))

    os.makedirs(output_dir, exist_ok=True)
    sname = {s.name: s for s in sources}
    stats: dict[str, SourceStats] = {s.name: SourceStats() for s in sources}
    wiki_sources = [s for s in sources if s.name in WIKI_SOURCES]

    seed_query = query or artist or ""

    # 工作区: 按 歌手/歌名/自定义 建独立目录(跨运行增量, 不再按天分)
    if prefix:
        ws_key = prefix
    elif songs_file:
        # 从歌单文件所在目录推导工作区(复用同一工作区, 不另建 default)
        _parent = os.path.dirname(os.path.abspath(songs_file))
        _base = os.path.basename(_parent)
        _outroot = os.path.basename(os.path.abspath(output_dir))
        if _base and _base != _outroot:
            ws_key = _base                    # 如 output\a-洛天依\songs.jsonl -> a-洛天依
        else:
            ws_key = os.path.splitext(os.path.basename(songs_file))[0].strip() or "default"
    else:
        ws_key = "q-" + _slug(query) if query else ("a-" + _slug(artist) if artist else "default")
    ws_dir = os.path.join(output_dir, ws_key)
    os.makedirs(ws_dir, exist_ok=True)
    lock_path = os.path.join(ws_dir, ".lock")
    if not _acquire_lock(lock_path):
        raise SystemExit(f"[锁定] 工作区 {ws_key} 正被其他进程使用(可能仍在后台写)。请等待完成, 或先终止后重试。")
    atexit.register(_release_lock, lock_path)   # 无论正常/异常/报错退出都释放锁

    # 主歌单(持久化): 优先复用已保存的, 否则生成
    playlist_path = os.path.join(ws_dir, "songs.jsonl")
    seen_path = os.path.join(ws_dir, "seen.json")
    if songs_file:
        song_entries = load_song_entries(songs_file)
        log(f"[{_ts()}] 从歌单文件载入 {len(song_entries)} 首: {songs_file}")
        write_song_entries(song_entries, playlist_path)
    else:
        song_entries = load_song_entries(playlist_path)
        if not song_entries:
            if not seed_query:
                raise SystemExit("请提供 --artist / --query, 或 --songs-file / 已存在的工作区歌单之一。")
            song_entries = _build_song_list(artist, query, sources, per_source, singer, log, total_limit=total)
            log(f"[{_ts()}] 歌单生成: {len(song_entries)} 首唯一歌曲")
        else:
            log(f"[{_ts()}] 已有歌单 {len(song_entries)} 首, 正在增量发现扩充...")
            try:
                extra = _build_song_list(artist, query, sources, per_source, singer, log, total_limit=total)
                existing = {_song_key(e["title"], e["artist"]) for e in song_entries}
                added = 0
                for x in extra:
                    k = _song_key(x["title"], x["artist"])
                    if k not in existing:
                        song_entries.append(x); existing.add(k); added += 1
                log(f"[{_ts()}] 增量发现新增 {added} 首, 歌单现在 {len(song_entries)} 首" +
                    ("" if added else " (没有新增, 可调大 --limit 发现更多)"))
            except Exception as e:
                log(f"[{_ts()}] 增量发现失败: {e}")
    if total and total > 0 and len(song_entries) > total:
        song_entries = song_entries[: total]
    write_song_entries(song_entries, playlist_path)

    seen = _load_seen(seen_path)

    def _retryable(key: str) -> bool:
        v = seen.get(key)
        if v is None:
            return True                      # 从未抓过 -> 待抓
        if _seen_status(v) == "ok":
            return False                     # 已成功 -> 跳过
        return _seen_attempts(v) <= MAX_FAIL_RETRIES   # 失败但在重试上限内 -> 可重试

    def _is_pending(e) -> bool:
        return _retryable(_song_key(e["title"], e["artist"]))

    done_ok = sum(1 for v in seen.values() if _seen_status(v) == "ok")
    remain = sum(1 for e in song_entries if _is_pending(e))
    log(f"[{_ts()}] 工作区 {ws_key}: 歌单 {len(song_entries)} 首, 已成功 {done_ok} 首, 待抓/待重试 {remain} 首")

    if songs_only:
        log(f"[{_ts()}] --songs-only: 仅生成歌单, 不抓歌词")
        return {"jsonl": "", "errors": "", "status": "", "songs": playlist_path,
                "ok": done_ok, "errors_count": 0, "validated": 0, "problems": [],
                "elapsed": time.time() - start, "stats": {name: vars(s) for name, s in stats.items()},
                "page_index": 0, "total_songs": len(song_entries), "remaining": remain}

    # 数量分页: 基于“累计成功数”确定当前页, 且本批只填当前页剩余名额(避免覆盖/超大页)
    new_entries = [e for e in song_entries if _is_pending(e)]
    page_index = done_ok // page_size + 1
    slots = page_size - (done_ok % page_size) if (done_ok % page_size) else page_size
    page_entries = new_entries[: slots]
    if not page_entries:
        log(f"[{_ts()}] 没有待抓/待重试的歌曲(该歌手基本完成, 或已多次失败; 可调大 --limit 发现更多)。")
        _release_lock(lock_path)
        return {"jsonl": "", "errors": "", "status": "", "songs": playlist_path,
                    "ok": done_ok, "errors_count": 0, "validated": 0, "problems": [],
                    "elapsed": time.time() - start, "stats": {name: vars(s) for name, s in stats.items()},
                    "page_index": page_index, "total_songs": len(song_entries), "remaining": remain}

    page_prefix = f"lyrics-{page_index:03d}"
    base_path = os.path.join(ws_dir, page_prefix)
    jsonl_path = base_path + ".jsonl"
    err_path = base_path + ".errors.jsonl"
    status_path = base_path + ".status.json"
    state_path = os.path.join(ws_dir, "state.json")
    log(f"[{_ts()}] 本页: {page_prefix}.jsonl (第 {page_index} 页, 处理 {len(page_entries)} 首 / 上限 {page_size})")

    records: list[LyricsRecord] = []
    errors: list[ErrorRecord] = []
    val_state: dict = {}
    interrupted = False
    stopfile = state_path + ".stop"
    dead_keys: set[str] = set()
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        n = len(page_entries)
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            futs = {}
            for entry in page_entries:
                if os.path.exists(stopfile):
                    interrupted = True
                    try:
                        os.remove(stopfile)
                    except OSError:
                        pass
                    break
                futs[ex.submit(_process_song_worker, entry, sname, wiki_sources, val_state, seen)] = entry
            donec = 0
            for fut in as_completed(futs):
                if os.path.exists(stopfile):
                    interrupted = True
                    try:
                        os.remove(stopfile)
                    except OSError:
                        pass
                    break
                try:
                    res = fut.result()
                except Exception:
                    continue
                if res is None:
                    continue
                key, rec, err, use_name, title, artist, vres, primary = res
                donec += 1
                if rec is not None:
                    records.append(rec);  stats[use_name].ok += 1
                    _mark_seen(seen, key, "ok")
                    log(f"[{_ts()}] ({donec}/{n}) [{use_name}] 成功  {title}")
                else:
                    errors.append(err);  stats[primary].errors += 1
                    _mark_seen(seen, key, "failed")
                    if getattr(err, "status", "") == "not_found":
                        # 无歌词/未找到 => 永久失败, 不再反复重试, 并从歌单移除
                        seen[key]["attempts"] = MAX_FAIL_RETRIES + 1
                        dead_keys.add(key)
                    log(f"[{_ts()}] ({donec}/{n}) [{primary}] 失败  {title}  {err.error}")
                okv = {wn: ws for wn, ws in vres.items() if ws == "found"}
                if okv:
                    log(f"[{_ts()}] ({donec}/{n}) [{use_name}] 验证命中文库: {''.join(okv.keys())}")
                for wn in okv:
                    stats[wn].validated += 1
                _save_seen(seen_path, seen)
                _touch_lock(lock_path)
    except KeyboardInterrupt:
        interrupted = True
        log(f"[{_ts()}] [手动终止] 收到 Ctrl+C, 正在保存已抓取的 {len(records)} 首歌词 ...")
        _save_seen(seen_path, seen)

    # 工作区状态(供 interrupt 定位)
    _save_state(state_path, {"workspace": ws_key, "artist": artist or "", "query": query or "",
                          "page_index": page_index, "done": done_ok, "remaining": remain})

    if interrupted:
        log(f"[{_ts()}] [手动终止] 已保存 {len(records)} 首 / {len(errors)} 条失败; 再运行会自动跳过已完成并继续下一页")
    else:
        log(f"[{_ts()}] 本页抓取结束, 写文件 -> {ws_dir}\\{page_prefix}")
    # 把“永久失败(无歌词/未找到)”的歌从歌单移除, 避免反复无效请求/页数不足
    if dead_keys:
        _before = len(song_entries)
        song_entries = [e for e in song_entries if _song_key(e["title"], e["artist"]) not in dead_keys]
        if len(song_entries) != _before:
            write_song_entries(song_entries, playlist_path)
            log(f"[{_ts()}] 已移除 {_before - len(song_entries)} 首无歌词/未找到的歌, 歌单剩 {len(song_entries)} 首")
    # 追加写入当前页(跨运行同一页不覆盖, 页满才进下一页); errors 同样追加
    _write_jsonl_append(records, jsonl_path)
    _write_jsonl_append(errors, err_path)
    page_total = _count_jsonl(jsonl_path)
    err_total = _count_jsonl(err_path)
    this_ok = len(records)
    this_err = len(errors)
    write_status({
        "workspace": ws_key, "artist": artist or "", "query": query or "",
        "page_index": page_index, "page_size": page_size, "total_songs": len(song_entries),
        "handled": len(seen), "done": done_ok,
        "summary": {"this_run_ok": this_ok, "this_run_errors": this_err,
                    "page_songs": page_total, "page_errors": err_total},
        "sources": {name: vars(s) for name, s in stats.items()},
        "validation": _summarize_validation(val_state),
    }, status_path)

    count, problems = validate_jsonl(jsonl_path)
    _release_lock(lock_path)
    return {"jsonl": jsonl_path, "errors": err_path, "status": status_path, "state": state_path,
            "ok": this_ok, "errors_count": this_err, "page_total": page_total,
            "validated": count, "problems": problems,
            "elapsed": time.time() - start, "interrupted": interrupted,
            "stats": {name: vars(s) for name, s in stats.items()},
            "page_index": page_index, "total_songs": len(song_entries),
            "remaining": sum(1 for e in song_entries if _song_key(e["title"], e["artist"]) not in seen)}


def _print_result(res: dict, verbose: bool) -> None:
    if res.get("interrupted"):
        print("[手动终止]  已保存当前进度; 再次运行相同歌手会自动跳过已完成并继续下一页")
    if res.get("page_index"):
        print(f"[进度]  第 {res.get('page_index')} 页  本批新增 {res.get('ok', 0)} 首  当前页累计 {res.get('page_total', 0)} 首  "
              f"歌单共 {res.get('total_songs', 0)} 首  剩余 {res.get('remaining', 0)} 首")
    if res.get("songs"):
        print(f"[歌单]  {res['songs']}")
    if res.get("jsonl"):
        print(f"[JSONL]  {res['jsonl']}  ({res.get('page_total', res.get('ok', 0))} 首)")
    print(f"[耗时]  {res.get('elapsed', 0):.1f} 秒")
    if res.get("errors"):
        print(f"[错误]  {res['errors']}  ({res['errors_count']} 条)")
    if res.get("status"):
        print(f"[状态]  {res['status']}")
    print("[来源统计]")
    for name, st in res["stats"].items():
        print(f"    {name:<10} ok={st['ok']}  errors={st['errors']}  validated={st['validated']}")
    if res.get("jsonl"):
        if res["problems"]:
            print(f"[校验]  有 {len(res['problems'])} 条问题, 首条: {res['problems'][0]}")
        else:
            print(f"[校验]  {res['validated']} 行全部通过")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="lyrics_crawler",
        description="先拉取歌单(网易云优先) → 抓歌词 → 萌娘/VCPedia 交叉验证 → 可断点续抓, 输出 UTF-8 JSONL。",
    )
    p.add_argument("--artist", help="歌手名称: 拉取其歌单并抓歌词")
    p.add_argument("--query", help="歌名/搜索词: 精确抓取某一首歌")
    p.add_argument("--sources", default="all",
                   help="逗号分隔来源: netease,qq,kuwo,vcpedia,moegirl (, all/music/wiki)。默认按网易云/VCPedia 优先")
    p.add_argument("--limit", type=int, default=20, dest="per_source",
                   help="每来源搜索多少首(仅用于发现歌单; -1 表示尽力搜索/超大分页; 从歌单生成时用 --page-size)")
    p.add_argument("--output", default="output", help="输出根目录 (默认 output; 其下按 歌手/歌名 建工作区)")
    p.add_argument("--prefix", default=None,
                   help="工作区目录名(默认按歌手/歌名自动命名); 用于指定同一歌手的工作区")
    p.add_argument("--page-size", type=int, default=500,
                   help="数量分页: 每页/每文件处理多少首歌, 避免一次耗时过大 (默认 500)")
    p.add_argument("--workers", type=int, default=3,
                   help="并行抓取的线程数 (默认 3; 过大可能被平台限流)")
    p.add_argument("--singer", action="store_true", help="强制虚拟歌手模式: 启用百科(VCPedia/萌娘)按歌手检索歌页")
    p.add_argument("--resume", action="store_true", help="从断点继续: 跳过已完成歌曲, 避免重复查询")
    p.add_argument("--total", type=int, default=0,
                   help="最终歌单/结果总数上限(跨来源去重后, 0=不限制)")
    p.add_argument("--songs-file", metavar="PATH", help="用现成歌单 JSONL 抓歌词(跳过发现阶段)")
    p.add_argument("--songs-only", action="store_true", help="只生成歌单文件(不抓歌词)")
    p.add_argument("--validate", metavar="JSONL", help="校验已有 JSONL 文件后退出")
    p.add_argument("--quiet", action="store_true", help="不打印抓取进度, 只输出最终摘要")
    p.add_argument("--verbose", action="store_true", help="打印更详细日志(保留)")
    return p


def _resolve_sources(arg: str):
    if arg in ("all", ""):
        return all_sources()
    if arg == "music":
        return [s for s in all_sources() if s.name in MUSIC_SOURCES]
    if arg == "wiki":
        return [s for s in all_sources() if s.name in WIKI_SOURCES]
    return resolve(arg)


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    if args.validate:
        count, problems = validate_jsonl(args.validate)
        print(f"[校验] {args.validate}: 共 {count} 行, {len(problems)} 个问题")
        for pr in problems[:20]:
            print("   ", json.dumps(pr, ensure_ascii=False))
        return 1 if problems else 0

    sources = _resolve_sources(args.sources)
    if not (args.artist or args.query or args.songs_file or args.prefix):
        build_parser().print_usage()
        print("请提供 --artist / --query / --songs-file / --prefix(工作区名) 之一。")
        return 2

    res = run_crawl(args.artist, args.query, sources, args.per_source, args.output,
                    quiet=args.quiet, singer=args.singer, resume=args.resume,
                    songs_file=args.songs_file, songs_only=args.songs_only,
                    total=args.total, page_size=args.page_size, prefix=args.prefix or "",
                    workers=args.workers)
    _print_result(res, args.verbose)
    return 1 if res["problems"] else 0