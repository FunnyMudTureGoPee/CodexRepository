"""models.py — 数据模型、歌词清洗、ID 生成。

对外约定（与 chatluna-lyrics-mcp 插件一致）：
  id, title, artist, album, language, lyrics, source
其中插件最终识别 id / title / artist / album / language / lyrics / source。
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class TrackCandidate:
    """一个来源解析出的“歌曲条目”。id 为来源侧稳定 ID（非最终数据集 ID）。"""

    id: str
    title: str
    artist: str
    album: str = ""
    source_url: str = ""
    source_name: str = ""
    language: str = "zh"


@dataclass
class LyricsRecord:
    """最终写入 JSONL 的一条记录。"""

    id: str
    title: str
    artist: str
    lyrics: str
    album: str = ""
    language: str = "zh"
    source: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        if d.get("album") == "":
            d.pop("album", None)
        if d.get("language") is None or d.get("language") == "":
            d.pop("language", None)
        if d.get("source") == "":
            d.pop("source", None)
        return d


@dataclass
class ErrorRecord:
    """写入 <prefix>.errors.jsonl 的一条失败记录。"""

    id: str
    title: str
    artist: str
    status: str
    error: str
    attempts: int = 1
    retry_after: Optional[int] = None
    source: str = ""

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "status": self.status,
            "error": self.error,
            "attempts": self.attempts,
        }
        if self.retry_after is not None:
            d["retryAfter"] = self.retry_after
        if self.source:
            d["source"] = self.source
        return d


# ---------------------------------------------------------------------------
# 标准化 / 清洗
# ---------------------------------------------------------------------------

_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]+$")
_LRC_TIME = re.compile(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]")
_LRC_META = re.compile(r"^\[[A-Za-z_]{1,10}:[^\]]*\]$")
_LRC_LINE = re.compile(r"^\[[^\]]*\]")
_ZERO_WIDTH = re.compile(r"[\u200b\u200c\u200d\ufeff]")
_HTML_TAG = re.compile(r"<[^>]+>")
_CREDIT_LINE = re.compile(
    r"^\s*(?:作词|作曲|编曲|编曲人|作词人|作曲人|作词者|作曲者|词曲|填词|谱曲|改编|"
    r"制作人|制作公司|监制|策划|企划|统筹|导演|出品|发行|出版|"
    r"演唱|原唱|翻唱|和声|和音|合声|合声编写|和声编写|"
    r"录音室|混音室|录音师|混音师|录音助理|录音工程|混音工程|录音工程师|混音工程师|录音|混音|"
    r"音响总监|音乐总监|乐队总监|总监助理|助理|企宣|文案|封面|美术|视觉|造型|设计|"
    r"吉他|贝斯|贝司|鼓手|鼓|键盘|钢琴|弦乐|打击乐|小提琴|大提琴|风琴|合成器|"
    r"OP|SP|原曲|原唱|翻奏|词|曲)\s*[:：]"
)


def normalize_text(text: str) -> str:
    if text is None:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = _ZERO_WIDTH.sub("", text)
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_lrc(raw: str) -> str:
    """去掉 LRC 时间戳与 [ti:/ar:/al:/by:/offset:] 等元信息行。

    保留原始空行作为歌词分段(后续 clean_lyrics 会折叠为最多一行)；
    只丢弃“纯标签行”(整行去掉标签后为空且原本非空白) 与元信息行。
    """
    out_lines: list[str] = []
    for line in raw.split("\n"):
        raw_blank = line.strip() == ""
        trimmed = line.strip()
        if trimmed and _LRC_META.match(trimmed):
            continue
        cleaned = line
        for _ in range(3):
            new = _LRC_TIME.sub("", cleaned)
            new = _LRC_LINE.sub("", new)
            if new == cleaned:
                break
            cleaned = new
        if not raw_blank and not cleaned.strip() and trimmed:
            continue
        out_lines.append(cleaned.rstrip())
    return "\n".join(out_lines)


def strip_song_info(lyrics: str, title: str = "", artist: str = "") -> str:
    """去掉源歌词开头的 “歌名 - 歌手” 之类信息行（非真正歌词）。
    仅当第一行明显是 “歌名 - 歌手” / “歌名：歌手” 时才移除，避免误删真实歌词。
    """
    if not lyrics or not title:
        return lyrics
    lines = lyrics.split("\n")
    if not lines or not lines[0].strip():
        return lyrics
    first = lines[0].strip()
    n_title = normalize_text(title).lower()
    n_artist = normalize_text(artist).lower() if artist else ""
    n_first = normalize_text(first).lower()
    sep = None
    for s in (" - ", "–", "—", "：", ":", "﹣"):
        if s in first:
            sep = s
            break
    if sep:
        head = first.split(sep, 1)[0].strip()
        tail = first.split(sep, 1)[1].strip()
        head_n = normalize_text(head).lower()
        if head_n.startswith(n_title):
            if n_artist and (n_artist in normalize_text(tail).lower() or n_artist in head_n):
                return "\n".join(lines[1:]).strip()
            if not n_artist and len(head_n) <= len(n_title) + 4:
                return "\n".join(lines[1:]).strip()
    else:
        if n_first == n_title:
            return "\n".join(lines[1:]).strip()
    return lyrics


def clean_lyrics(raw: str, title: str = "", artist: str = "") -> str:
    """按规范清洗歌词文本。

    1) \r\n / \r -> \n
    2) 去掉 LRC 时间戳与元信息标签
    3) 去 HTML 标签
    4) 行尾去空格
    5) 连续空行最多保留一行
    6) 去掉开头的 “歌名 - 歌手” 信息行
    7) 首尾去空白
    不添加歌名/歌手/来源/代码围栏, 不翻译或补全。
    """
    if not raw:
        return ""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = strip_lrc(text)
    if not text.strip():
        return ""
    text = _HTML_TAG.sub("", text)
    text = _ZERO_WIDTH.sub("", text)
    lines = text.split("\n")
    cleaned_lines: list[str] = []
    prev_blank = False
    for line in lines:
        line = line.rstrip()
        if _CREDIT_LINE.match(line):
            continue
        if line.strip() == "":
            if not prev_blank:
                cleaned_lines.append("")
            prev_blank = True
        else:
            cleaned_lines.append(line)
            prev_blank = False
    while cleaned_lines and cleaned_lines[0].strip() == "":
        cleaned_lines.pop(0)
    while cleaned_lines and cleaned_lines[-1].strip() == "":
        cleaned_lines.pop()
    body = "\n".join(cleaned_lines).strip()
    return strip_song_info(body, title, artist)


def derive_id(source: str, title: str, artist: str, album: str = "") -> str:
    """无来源侧 ASCII ID 时回退: crawler:<hash>。

    哈希把 source 一并纳入, 保证同一首歌来自不同来源(vcpedia / moegirl)时
    不会撞 ID, 同时保持 crawler: 前缀 (规范格式)。
    """
    n_src = normalize_text(source).lower() if source else ""
    n_title = normalize_text(title).lower() if title else ""
    n_artist = normalize_text(artist).lower() if artist else ""
    n_album = normalize_text(album).lower() if album else ""
    material = f"{n_src}\x00{n_title}\x00{n_artist}\x00{n_album}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"crawler:{digest[:32]}"


def sanitize_id(value: str) -> str:
    value = value or ""
    cleaned = re.sub(r"[^A-Za-z0-9:_-]+", "-", value)
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    if len(cleaned) > 128:
        cleaned = cleaned[:128]
    return cleaned or derive_id("fallback", value, "", "")


def make_source_id(source: str, source_id: str, title: str, artist: str, album: str = "") -> str:
    """生成最终数据集 ID。
    - 若来源侧 ID 是纯 ASCII(数字/字母/:_-), 用 source:sourceTrackId。
    - 否则(中文页面标题等)或为空, 回退为 crawler:<sha256(标准化歌名+歌手+专辑)[:32]>。
    """
    sid = (source_id or "").strip()
    if sid and _ID_PATTERN.match(sid):
        candidate = f"{source}:{sid}"
        if len(candidate) <= 128:
            return candidate
    return derive_id(source, title, artist, album)