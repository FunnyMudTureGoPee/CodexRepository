"""vcpedia.py — VCPedia (https://vcpedia.cn/) 虚拟歌手百科。

搜索/取文走 MediaWiki API (list=search + prop=revisions&rvslots=main)。
歌词位于页面的 “== 歌词 ==” 小节内的 <poem> 块；演唱者可由 Infobox 的 “演唱” 字段解析。
"""
from __future__ import annotations

import re
from urllib.parse import quote

from ..http_client import HttpClient
from ..models import TrackCandidate, clean_lyrics, normalize_text
from .base import BaseSource, LyricsUnavailable, SongNotFound

_SECTION = re.compile(r"^\s*==\s*([^=]+?)\s*==\s*$", re.M)
_POEM = re.compile(r"<poem>\s*(.*?)\s*</poem>", re.S | re.I)
_WIKILINK = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")
_LYRIC_HEAD = re.compile(r"歌词|歌詞")


class VcpediaSource(BaseSource):
    name = "vcpedia"
    display_name = "VCPedia"
    base = "https://vcpedia.cn"
    default_language = "zh"

    _client = HttpClient(headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"})

    def _api(self, **params) -> dict:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
        url = f"{self.base}/api.php?{qs}"
        return self._client.get_json(url)

    def _resolve_title(self, query: str) -> str | None:
        try:
            d = self._api(action="query", list="search", format="json", srlimit=8, srsearch=query)
        except Exception:
            return None
        hits = (d.get("query") or {}).get("search") or []
        # 优先精确/包含命中
        for s in hits:
            title = (s.get("title") or "").strip()
            if title and query.lower() in title.lower():
                return title
        return hits[0]["title"].strip() if hits else None

    def exists(self, title: str) -> bool:
        """轻量存在性核验: 只做 list=search 判断是否有对应页面, 不拉取整页歌词(用于交叉验证提速)。"""
        try:
            return self._resolve_title(title) is not None
        except Exception:
            return False

    def _page_wikitext(self, title: str) -> str:
        d = self._api(action="query", format="json", prop="revisions", rvprop="content", rvslots="main", titles=title)
        pages = (d.get("query") or {}).get("pages") or {}
        if not pages:
            raise SongNotFound(f"no page for {title}")
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
        first = re.split(r"[、,/]|<!--", raw, maxsplit=1)[0]
        return first.strip()

    def _extract_lyrics(self, wt: str) -> str:
        # 优先取 “歌词” 小节内的 <poem>; 找不大“歌词”小节时避免取整页首个(可能为简介/文案), 返回空。
        sections = re.split(_SECTION, wt)
        chosen = None
        for i in range(1, len(sections), 2):
            title = sections[i].strip()
            if _LYRIC_HEAD.search(title):
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
        artist_name = self._infobox_artist(wt) if wt else ""
        return [TrackCandidate(
            id=title,
            title=title,
            artist=artist_name or "",
            album="",
            source_url=f"{self.base}/index.php?title={quote(title)}",
            source_name=self.display_name,
            language=self.default_language,
        )]

    _ARTIST_SUFFIX = staticmethod(lambda artist: re.compile(r"^(.+?)\s*\(\s*" + re.escape(artist) + r"\s*\)$"))

    def _category_songs(self, artist: str, limit: int) -> list[str]:
        """特化: 用 Category:<歌手>歌曲 枚举该歌手在 VCPedia 上的全部歌名(可翻页)。"""
        cat = f"Category:{artist}歌曲"
        titles: list[str] = []
        cont = None
        page_size = min(max(limit or 50, 50), 100)
        max_pages = 6
        if limit and limit > 0:
            max_pages = max(max_pages, min(60, (limit // page_size) + 1))  # limit 越大越尽力(翻更多页)
        for _ in range(max_pages):
            params: dict = {
                "action": "query", "list": "categorymembers",
                "cmtitle": cat, "cmlimit": page_size, "cmnamespace": "0", "format": "json",
            }
            if cont:
                params["cmcontinue"] = cont
            try:
                d = self._api(**params)
            except Exception:
                break
            mems = (d.get("query") or {}).get("categorymembers") or []
            titles.extend(m.get("title", "") for m in mems)
            cont = (d.get("continue") or {}).get("cmcontinue")
            if not cont:
                break
            if limit and len(titles) >= limit:
                break
        return titles[: limit] if limit else titles

    def _suffix_songs(self, artist: str, limit: int) -> list[str]:
        """退化为 “歌名(歌手)” 后缀搜索。"""
        pat = self._ARTIST_SUFFIX(artist)
        try:
            d = self._api(action="query", list="search", format="json", srlimit=25, srsearch=artist)
        except Exception:
            return []
        hits = (d.get("query") or {}).get("search") or []
        titles = []
        for h in hits:
            title = (h.get("title") or "").strip()
            if pat.match(title):
                titles.append(title)
        return titles

    def discover(self, artist: str, limit: int) -> list[TrackCandidate]:
        """特化搜索歌名: 优先用 <歌手>歌曲 分类枚举(覆盖更全), 分类为空则退化为后缀搜索。"""
        if not artist:
            return []
        titles = self._category_songs(artist, limit)
        if not titles:
            titles = self._suffix_songs(artist, limit)
        if not titles:
            return []
        pat = self._ARTIST_SUFFIX(artist)
        out: list[TrackCandidate] = []
        for title in titles:
            m = pat.match(title)
            song = m.group(1).strip() if m else title
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
