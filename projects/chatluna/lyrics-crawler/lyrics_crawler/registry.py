"""registry.py — 来源适配器注册表(按 config.SOURCE_PRIORITY 排序)。"""
from __future__ import annotations

from .config import SOURCE_PRIORITY
from .sources.base import BaseSource
from .sources.netease import NeteaseSource
from .sources.qq import QQMusicSource
from .sources.kuwo import KuwoSource
from .sources.vcpedia import VcpediaSource
from .sources.moegirl import MoegirlSource

# 全部来源实例; 顺序按优先级(网易云/vcpedia 优先)排列
_SOURCES: list[BaseSource] = [
    NeteaseSource(),
    VcpediaSource(),
    QQMusicSource(),
    MoegirlSource(),
    KuwoSource(),
]

_SOURCES.sort(key=lambda s: SOURCE_PRIORITY.get(s.name, 99))

# 音乐平台(按歌手/搜索出歌) 与 百科站点(按歌名/歌手查页面) 分类
MUSIC_SOURCES = {"netease", "qq", "kuwo"}
WIKI_SOURCES = {"vcpedia", "moegirl"}


def all_sources() -> list[BaseSource]:
    return list(_SOURCES)


def by_name(name: str) -> BaseSource:
    for s in _SOURCES:
        if s.name == name:
            return s
    raise KeyError(f"unknown source: {name}")


def resolve(names: str | list[str] | None) -> list[BaseSource]:
    """解析 --sources 参数(逗号分隔或列表)。None => 全部(按优先级排序)。"""
    if names is None:
        return all_sources()
    if isinstance(names, str):
        names = [x.strip() for x in names.split(",") if x.strip()]
    out = []
    for n in names:
        out.append(by_name(n))
    # 保持优先级顺序
    out.sort(key=lambda s: SOURCE_PRIORITY.get(s.name, 99))
    return out
