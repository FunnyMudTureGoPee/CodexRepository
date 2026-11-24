"""moegirl.py — 萌娘百科 (zh.moegirl.org.cn)。

提示: 萌娘百科近期对匿名 MediaWiki API 做了访问限制 (action-notallowed)。
本适配器优先走 MediaWiki API (list=search + prop=revisions) 取 <poem> 歌词；
若被限制则抛 SongNotFound/不可用, 由上层写入 errors.jsonl。
歌词在页面 “歌词” 小节; 演唱者可由 Infobox 解析。
"""
from __future__ import annotations

import re
from urllib.parse import quote

from ..http_client import HttpClient
from ..models import TrackCandidate, clean_lyrics
from .base import BaseSource, LyricsUnavailable, SongNotFound

_SECTION = re.compile(r"^\s*==\s*([^=]+?)\s*==\s*$", re.M)
_POEM = re.compile(r"<poem>\s*(.*?)\s*</poem>", re.S | re.I)
_WIKILINK = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")
_LYRIC_HEAD = re.compile(r"歌词|歌詞")


class MoegirlSource(BaseSource):
    name = "moegirl"
    display_name = "萌娘百科"
    base = "https://zh.moegirl.org.cn"
    default_language = "zh"

    _client = HttpClient(
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
        }
    )

    def _api(self, **params) -> dict:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
        return self._client.get_json(f"{self.base}/api.php?{qs}")

    def _resolve_title(self, query: str) -> str | None:
        try:
            d = self._api(action="query", list="search", format="json", srlimit=8, srsearch=query)
        except Exception:
            return None
        if "error" in d:
            raise SongNotFound(f"moegirl API restricted: {d['error'].get('info', '')}")
        hits = (d.get("query") or {}).get("search") or []
        for s in hits:
            title = (s.get("title") or "").strip()
            if title and query.lower() in title.lower():
                return title
        return hits[0]["title"].strip() if hits else None

    def exists(self, title: str) -> bool:
        """轻量存在性核验(交叉验证提速): 只做 list=search。"""
        try:
            return self._resolve_title(title) is not None
        except Exception:
            return False

    def _page_wikitext(self, title: str) -> str:
        d = self._api(action="query", format="json", prop="revisions", rvprop="content", rvslots="main", titles=title)
        if "error" in d:
            raise SongNotFound(f"moegirl API restricted: {d['error'].get('info', '')}")
        pages = (d.get("query") or {}).get("pages") or {}
        for pid, page in pages.items():
            revs = page.get("revisions") or [{}]
            content = (revs[0].get("slots") or {}).get("main", {}).get("*") or ""
            if content:
                return content
        return ""

    def _infobox_artist(self, wt: str) -> str:
        m = re.search(r"\|\s*演唱\s*=\s*([^|\n]+)", wt)
        if not m:
            m = re.search(r"\|\s*(?:singer|vocals?)\s*=\s*([^|\n]+)", wt, re.I)
        if not m:
            return ""
        raw = m.group(1).strip()
        links = _WIKILINK.findall(raw)
        if links:
            return " / ".join([x.strip() for x in links if x.strip()])
        return re.split(r"[、,/]|<!--", raw, maxsplit=1)[0].strip()

    def _extract_lyrics(self, wt: str) -> str:
        # 优先取 “歌词” 小节内的 <poem>; 找不大“歌词”小节时避免取整页首个(可能为简介/文案), 返回空。
        sections = re.split(_SECTION, wt)
        chosen = None
        for i in range(1, len(sections), 2):
            if _LYRIC_HEAD.search(sections[i]):
                chosen = sections[i + 1] if i + 1 < len(sections) else ""
                break
        if chosen is None:
            return ""
        poems = _POEM.findall(chosen)
        poem = poems[0] if poems else chosen
        poem = poem.replace("<br/>", "\n").replace("<br />", "\n").replace("<br>", "\n")
        return clean_lyrics(poem)

    def search(self, query: str, limit: int, artist: str = "") -> list[TrackCandidate]:
        title = self._resolve_title(query)
        if not title:
            return []
        try:
            wt = self._page_wikitext(title)
        except Exception:
            wt = ""
        return [TrackCandidate(
            id=title,
            title=title,
            artist=self._infobox_artist(wt) if wt else "",
            album="",
            source_url=f"{self.base}/index.php?title={quote(title)}",
            source_name=self.display_name,
            language=self.default_language,
        )]

    _ARTIST_SUFFIX = staticmethod(lambda artist: re.compile(r"^(.+?)\s*\(\s*" + re.escape(artist) + r"\s*\)$"))

    def discover(self, artist: str, limit: int) -> list[TrackCandidate]:
        """按歌手名在萌娘百科搜索, 找出形如 “歌名(歌手)” 的歌页(尽力而为)。"""
        if not artist:
            return []
        pat = self._ARTIST_SUFFIX(artist)
        try:
            d = self._api(action="query", list="search", format="json", srlimit=25, srsearch=artist)
        except Exception:
            return []
        hits = (d.get("query") or {}).get("search") or []
        out: list[TrackCandidate] = []
        for h in hits:
            title = (h.get("title") or "").strip()
            m = pat.match(title)
            if not m:
                continue  # 只收录“歌名(歌手)”形式的歌页
            song = m.group(1).strip()
            if not song:
                continue
            out.append(TrackCandidate(
                id=title,
                title=song,
                artist=artist,
                album="",
                source_url=f"{self.base}/index.php?title={quote(title)}",
                source_name=self.display_name,
                language=self.default_language,
            ))
            if len(out) >= limit:
                break
        return out

    def lyrics(self, candidate: TrackCandidate) -> tuple[str, str]:
        wt = self._page_wikitext(candidate.id)
        if not wt or not wt.strip():
            raise SongNotFound("empty wikitext")
        lyrics = self._extract_lyrics(wt)
        if not lyrics:
            raise LyricsUnavailable("no poem lyrics")
        src = candidate.source_url or f"{self.base}/index.php?title={quote(candidate.id)}"
        return lyrics, src
