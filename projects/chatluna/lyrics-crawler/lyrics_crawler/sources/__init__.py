"""
sources — 各音乐平台/站点适配器。

每个适配器实现 BaseSource:
  - search(query, limit)  : 搜索歌曲, 返回 TrackCandidate 列表
  - lyrics(candidate)     : 抓取并清洗歌词, 返回 (歌词文本, 来源URL)
  - building(record)      : 生成最终 LyricsRecord(可选覆盖 id/album/language)
"""
from .base import BaseSource
from .netease import NeteaseSource
from .qq import QQMusicSource
from .kuwo import KuwoSource
from .vcpedia import VcpediaSource
from .moegirl import MoegirlSource

__all__ = [
    "BaseSource",
    "NeteaseSource",
    "QQMusicSource",
    "KuwoSource",
    "VcpediaSource",
    "MoegirlSource",
]
