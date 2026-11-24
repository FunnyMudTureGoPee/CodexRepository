"""kuwo.py — 酷我音乐。

搜索: http://search.kuwo.cn/r.s?client=kt&all=<kw>&ft=music&rformat=json...
歌词: http://mobi.kuwo.cn/mobi.s?f=kuwo&q=<MUSIC_rid>&sid=<rid>&rformat=json...
酷我接口在不同网络下可能被网关拒绝(502)或需登录态, 故本适配器为尽力而为:
请求失败时抛异常, 由上层写入 errors.jsonl, 不影响其它来源。
"""
from __future__ import annotations

import ast
import json
import re
import urllib.parse

from ..http_client import HttpClient
from ..models import TrackCandidate, clean_lyrics, normalize_text
from .base import BaseSource, LyricsUnavailable, RateLimited, SongNotFound

_HTML_TRIM = re.compile(r"<[^>]+>")


class KuwoSource(BaseSource):
    name = "kuwo"
    display_name = "酷我音乐"
    base = "https://www.kuwo.cn"
    default_language = "zh"

    _client = HttpClient(
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Referer": "https://www.kuwo.cn/",
        }
    )

    def _matches_artist(self, candidate: TrackCandidate, artist: str) -> bool:
        if not artist:
            return True
        want = normalize_text(artist).lower()
        for part in re.split(r"[、,/;&]+", candidate.artist):
            if normalize_text(part).lower() == want:
                return True
        return False

    @staticmethod
    def _parse_kuwo_array(text: str):
        """解析酷我返回的形如 ['{...}','{...}'] 的类 Python 字面量数组。"""
        text = text.strip()
        if text.startswith("["):
            try:
                items = ast.literal_eval(text)
            except Exception:
                items = []
            out = []
            for it in items:
                if isinstance(it, str):
                    try:
                        out.append(json.loads(it))
                    except Exception:
                        pass
                elif isinstance(it, dict):
                    out.append(it)
            return out
        try:
            return json.loads(text)
        except Exception:
            return []

    def search(self, query: str, limit: int, artist: str = "", max_pages: int = 2) -> list[TrackCandidate]:
        found: list[TrackCandidate] = []
        page_size = min(limit or 30, 30)
        for page in range(max_pages):
            params = {
                "client": "kt",
                "all": query,
                "pn": page * page_size,
                "rn": page_size,
                "ft": "music",
                "rformat": "json",
                "encoding": "utf8",
                "vipver": "1",
                "newver": "1",
                "show_copyright_off": "1",
                "cluster": "0",
                "strategy": "2012",
                "vermerge": "1",
                "mobi": "1",
            }
            url = "http://search.kuwo.cn/r.s?" + urllib.parse.urlencode(params)
            try:
                resp = self._client.get_text(url)
            except Exception as e:
                if getattr(e, "status", None) == 429:
                    raise RateLimited(str(e)) from None
                if getattr(e, "status", None) in (502, 404):
                    raise SongNotFound("kuwo search gateway/endpoint unavailable") from None
                raise
            rows = self._parse_kuwo_array(resp)
            if not rows:
                break
            for r in rows:
                sid = str(r.get("MUSICRID", "") or r.get("musicrid", "") or "").strip()
                if sid.lower().startswith("music_"):
                    sid = sid[6:]
                title = (r.get("SONGNAME") or r.get("songname") or "").strip()
                art = (r.get("ARTIST") or r.get("artist") or "").strip()
                album = (r.get("ALBUM") or r.get("album") or "").strip()
                if not sid or not title:
                    continue
                cand = TrackCandidate(
                    id=sid,
                    title=title,
                    artist=art,
                    album=album,
                    source_url=f"{self.base}/song_detail/{sid}",
                    source_name=self.display_name,
                    language=self.default_language,
                )
                if artist and not self._matches_artist(cand, artist):
                    continue
                found.append(cand)
                if len(found) >= limit:
                    return found[:limit]
        return found[:limit]

    def lyrics(self, candidate: TrackCandidate) -> tuple[str, str]:
        url = (
            "http://mobi.kuwo.cn/mobi.s?f=kuwo&q=" + candidate.id
            + "&sid=" + candidate.id
            + "&rformat=json&encoding=utf8&vipver=1&show_copyright_off=1"
            + "&newver=1&ft=music&cluster=0&strategy=2012&vermerge=1&mobi=1"
        )
        try:
            text = self._client.get_text(url)
        except Exception as e:
            if getattr(e, "status", None) == 429:
                raise RateLimited(str(e)) from None
            if getattr(e, "status", None) in (502, 404):
                raise LyricsUnavailable("kuwo lyric endpoint unavailable") from None
            raise
        rows = self._parse_kuwo_array(text)
        lrc = ""
        for row in rows:
            lrc = (row.get("lyric") or "") if isinstance(row, dict) else ""
            if lrc:
                break
        if not lrc or not lrc.strip():
            raise LyricsUnavailable("no lyric")
        lrc = lrc.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\n")
        lyrics = clean_lyrics(lrc, candidate.title, candidate.artist)
        if not lyrics:
            raise LyricsUnavailable("empty after cleaning")
        return lyrics, candidate.source_url or f"{self.base}/song_detail/{candidate.id}"
