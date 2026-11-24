"""
netease.py — 网易云音乐。

搜索: GET /api/v1/search/get  (明文, 非 weapi)
歌词: GET /api/song/lyric?id=&lv=1&kv=1&tv=-1  (返回 LRC, 取 lrc.lyric)
"""
from __future__ import annotations

from urllib.parse import urlencode

from ..http_client import HttpClient
from ..models import TrackCandidate, clean_lyrics, normalize_text
from .base import BaseSource, LyricsUnavailable, RateLimited, SongNotFound


class NeteaseSource(BaseSource):
    name = "netease"
    display_name = "网易云音乐"
    base = "https://music.163.com"
    default_language = "zh"

    _client = HttpClient(
        headers={
            "Referer": "https://music.163.com/",
            "Accept": "application/json, text/plain, */*",
        }
    )

    def _matches_artist(self, candidate: TrackCandidate, artist: str) -> bool:
        if not artist:
            return True
        want = normalize_text(artist).lower()
        # candidate.artist 可能为逗号拼接的多个名字
        for part in candidate.artist.split(","):
            if normalize_text(part).lower() == want:
                return True
        # 部分平台用 " / " 分隔
        for part in candidate.artist.replace("/", ",").split(","):
            if normalize_text(part).lower() == want:
                return True
        return False

    def search(self, query: str, limit: int, artist: str = "", max_pages: int = 3) -> list[TrackCandidate]:
        page_size = min(limit or 30, 30)
        found: list[TrackCandidate] = []
        offset = 0
        for _ in range(max_pages):
            params = {
                "csrf_token": "",
                "type": 1,
                "offset": offset,
                "total": "true",
                "limit": page_size,
                "s": query,
            }
            url = f"{self.base}/api/v1/search/get?" + urlencode(params)
            data = self._client.get_json(url)
            songs = (data.get("result") or {}).get("songs") or []
            if not songs:
                break
            for s in songs:
                sid = str(s.get("id", "")).strip()
                title = (s.get("name") or "").strip()
                artists = [a.get("name", "") for a in (s.get("artists") or [])]
                artist_str = ", ".join([a for a in artists if a])
                album = (s.get("album") or {}).get("name", "") or ""
                if not sid or not title:
                    continue
                cand = TrackCandidate(
                    id=sid,
                    title=title,
                    artist=artist_str or "",
                    album=album.strip(),
                    source_url=f"{self.base}/song?id={sid}",
                    source_name=self.display_name,
                    language=self.default_language,
                )
                if artist and not self._matches_artist(cand, artist):
                    continue
                found.append(cand)
                if len(found) >= limit:
                    return found[:limit]
            offset += page_size
            if len(songs) < page_size:
                break
        return found[:limit]

    def song_list(self, artist: str, limit: int, max_pages: int = 6) -> list[TrackCandidate]:
        """拉取歌手歌单: 用歌手名做多页歌曲搜索并按歌手过滤, 尽量拿全。"""
        if limit and limit > 0:
            max_pages = max(max_pages, min(25, (limit // 30) + 1))  # limit 越大越尽力(翻更多页)
        return self.search(artist, limit, artist=artist, max_pages=max_pages)

    def lyrics(self, candidate: TrackCandidate) -> tuple[str, str]:
        url = f"{self.base}/api/song/lyric?id={candidate.id}&lv=1&kv=1&tv=-1"
        try:
            data = self._client.get_json(url)
        except Exception as e:
            if getattr(e, "status", None) == 429:
                raise RateLimited(str(e)) from None
            if getattr(e, "status", None) == 404:
                raise SongNotFound(str(e)) from None
            raise
        lrc = (data.get("lrc") or {}).get("lyric") or ""
        if not lrc or not lrc.strip():
            # 可能为纯音乐/翻译歌词, 无正式歌词
            raise LyricsUnavailable("no lrc lyric")
        lyrics = clean_lyrics(lrc, candidate.title, candidate.artist)
        if not lyrics:
            raise LyricsUnavailable("empty after cleaning")
        return lyrics, candidate.source_url or f"{self.base}/song?id={candidate.id}"
