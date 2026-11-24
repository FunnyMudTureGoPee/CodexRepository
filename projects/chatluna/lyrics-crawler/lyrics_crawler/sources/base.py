"""
base.py — 来源适配器抽象基类与公共异常。
"""
from __future__ import annotations

import abc

from ..models import LyricsRecord, TrackCandidate, make_source_id


class SongNotFound(Exception):
    """搜索或解析不到歌词/歌曲。"""


class LyricsUnavailable(Exception):
    """歌曲存在但拿不到可用歌词(付费/无歌词/解析失败)。"""


class RateLimited(Exception):
    """被对方限流。"""


class BaseSource(abc.ABC):
    """子类需实现 name/display_name, search 与 lyrics。

    lyrics 返回 (清洗后歌词文本, 来源URL)。
    """

    name: str = "base"
    display_name: str = "Base"
    default_language: str = "zh"

    @abc.abstractmethod
    def search(self, query: str, limit: int) -> list[TrackCandidate]:
        """按 query(歌名/歌手/组合) 搜索, 返回候选歌曲列表。"""

    @abc.abstractmethod
    def lyrics(self, candidate: TrackCandidate) -> tuple[str, str]:
        """抓取候选歌词, 返回 (清洗后歌词, 来源URL)。

        失败时抛 SongNotFound / LyricsUnavailable / RateLimited。
        """

    def discover(self, artist: str, limit: int) -> list[TrackCandidate]:
        """按歌手发掘歌曲列表(默认退化为带歌手过滤的 search)。

        音乐平台默认即可; 百科类站点(vcpedia/moegirl)会覆盖以实现
        “按歌手名搜出该歌手的歌页”。
        """
        return self.search(artist, limit, artist=artist)

    def build_record(self, candidate: TrackCandidate, lyrics: str) -> LyricsRecord:
        return LyricsRecord(
            id=make_source_id(self.name, candidate.id, candidate.title, candidate.artist, candidate.album),
            title=candidate.title.strip(),
            artist=candidate.artist.strip(),
            album=candidate.album.strip(),
            language=candidate.language or self.default_language,
            lyrics=lyrics,
            source=candidate.source_url,
        )
