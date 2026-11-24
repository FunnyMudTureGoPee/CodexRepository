"""
qq.py — QQ 音乐。

搜索: GET https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=&format=json&p=1&n=30
歌词: GET https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=&format=json&nobase64=1
      响应 lrc.lyric(需 base64 解码, 故用 nobase64=1); 含 [ti:][ar:][al:] 元信息, 由清洗函数剔除
"""
from __future__ import annotations

import base64
import re
from urllib.parse import urlencode

from ..http_client import HttpClient
from ..models import TrackCandidate, clean_lyrics, normalize_text
from .base import BaseSource, LyricsUnavailable, RateLimited, SongNotFound

_QQ_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class QQMusicSource(BaseSource):
    name = "qq"
    display_name = "QQ音乐"
    base = "https://y.qq.com"
    default_language = "zh"

    _client = HttpClient(
        headers={
            "User-Agent": _QQ_UA,
            "Referer": "https://y.qq.com/portal/player.html",
            "Cookie": "pgv_pvid=1; pgv_info=ssid=s1",
        }
    )

    def _matches_artist(self, candidate: TrackCandidate, artist: str) -> bool:
        if not artist:
            return True
        want = normalize_text(artist).lower()
        for part in candidate.artist.replace(",", "、").split("、"):  # QQ 用 " / " 或 "、" 分隔
            for sub in re.split(r"[/&,]+", part):
                if normalize_text(sub).lower() == want:
                    return True
        return False

    def search(self, query: str, limit: int, artist: str = "", max_pages: int = 3) -> list[TrackCandidate]:
        page_size = min(limit or 30, 30)
        found: list[TrackCandidate] = []
        for page in range(1, max_pages + 1):
            params = {
                "w": query,
                "format": "json",
                "p": page,
                "n": page_size,
                "cr": 1,
                "g_tk": 5381,
                "loginUin": 0,
                "hostUin": 0,
                "inCharset": "utf8",
                "outCharset": "utf-8",
                "notice": 0,
                "platform": "yqq.json",
                "needNewCode": 0,
            }
            url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?" + urlencode(params)
            data = self._client.get_json(url)
            song_list = ((data.get("data") or {}).get("song") or {}).get("list") or []
            if not song_list:
                break
            for s in song_list:
                sid = (s.get("songmid") or "").strip()
                title = (s.get("songname") or "").strip()
                singers = [x.get("name", "") for x in (s.get("singer") or [])]
                artist_str = " / ".join([x for x in singers if x])
                album = (s.get("albumname") or "").strip()
                if not sid or not title:
                    continue
                cand = TrackCandidate(
                    id=sid,
                    title=title,
                    artist=artist_str or "",
                    album=album,
                    source_url=f"{self.base}/n/ryqq/songDetail/{sid}",
                    source_name=self.display_name,
                    language=self.default_language,
                )
                if artist and not self._matches_artist(cand, artist):
                    continue
                found.append(cand)
                if len(found) >= limit:
                    return found[:limit]
            if len(song_list) < page_size:
                break
        return found[:limit]

    def lyrics(self, candidate: TrackCandidate) -> tuple[str, str]:
        params = {
            "songmid": candidate.id,
            "format": "json",
            "nobase64": 1,
            "songtype": 0,
            "g_tk": 5381,
            "loginUin": 0,
            "hostUin": 0,
            "inCharset": "utf8",
            "outCharset": "utf-8",
            "notice": 0,
            "platform": "yqq.json",
            "needNewCode": 0,
        }
        url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?" + urlencode(params)
        try:
            data = self._client.get_json(url)
        except Exception as e:
            if getattr(e, "status", None) == 429:
                raise RateLimited(str(e)) from None
            if getattr(e, "status", None) == 404:
                raise SongNotFound(str(e)) from None
            raise
        retcode = data.get("retcode", -1)
        if retcode != 0:
            raise LyricsUnavailable(f"QQ retcode={retcode}")
        lrc = (data.get("lyric") or "")
        if not lrc:
            lrc = (data.get("tlyric") or "")  # 有些歌曲只给 tlyric 外文
        if lrc:
            # 兼容 base64 场景(虽然 nobase64=1, 仍做兜底判断)
            try:
                if re.fullmatch(r"[A-Za-z0-9+/=s]+", lrc.strip()):
                    lrc = base64.b64decode(lrc).decode("utf-8", "replace")
            except Exception:
                pass
        if not lrc or not lrc.strip():
            raise LyricsUnavailable("no lyric")
        lyrics = clean_lyrics(lrc, candidate.title, candidate.artist)
        if not lyrics:
            raise LyricsUnavailable("empty after cleaning")
        return lyrics, candidate.source_url or f"{self.base}/n/ryqq/songDetail/{candidate.id}"
