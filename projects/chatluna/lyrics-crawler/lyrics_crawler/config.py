"""config.py — 来源优先级与虚拟歌手识别。

priority 越小越优先(0 最高)。按需求把 网易云 / VCPedia 置前。
"""
from __future__ import annotations

# 来源抓取优先级 (数字越小越优先)。
# 歌词来源(百科为主, 避免音乐平台的翻唱/同曲多版本): VCPedia > 萌娘 > 网易云 > QQ > 酷我。
# 百科收录的是原作/权威版本; 音乐平台用于百科没有的歌 (仍作为回退)。
# 歌词来源优先级: 音乐平台(网易云/QQ/酷我)优先(歌词更可靠), 百科用于发现歌单与兜底。
# 因为百科(尤其 VCPedia)部分页面的“歌词”其实是简介/文案, 故平台优先, 百科兜底。
SOURCE_PRIORITY: dict[str, int] = {
    "netease": 0,
    "qq": 1,
    "kuwo": 2,
    "vcpedia": 3,
    "moegirl": 4,
}

# 常见虚拟歌手 / 声音库, 用于识别“虚拟歌手模式”(会启用百科的按歌手发掘)
VIRTUAL_SINGERS: frozenset[str] = frozenset({
    # 中文虚拟歌手
    "洛天依", "言和", "乐正绫", "乐正龙牙", "徵羽摩柯", "墨清弦",
    "星尘", "星尘infinity", "心华", "心羽", "海伊", "诗雨", "微音",
    "花语", "时羽", "羽刃", "伊野", "舒子", "春", "豆", "南", "笛",
    "心羽", "绯", "沐", "瑞", "凌", "灵", "蔷", "华", "沉", "止",
    "漠", "绡", "朝", "s", "l", "墨", "潼", "锦", "瓷", "夕", "迹",
    # VOCALOID / Synthesizer V / ACE 声音库
    "初音未来", "初音ミク", "hatsune miku", "镜音铃", "镜音连", "镜音铃・连",
    "巡音流歌", "巡音露卡", "巡音ルカ", "kaito", "meiko", "gumi", "ia",
    "重音テト", "重音teto", "歌爱雪", "结月缘", "东云海", "剑持刀也",
    "花隈千冬", "夏色花梨", "yuzuki", "歌爱ユキ", "如月千早",
    # 音街 / 爱豆等
    "洛天依", "乐正绫", "言和", "星尘", "心华", "心羽", "徵羽摩柯",
})


def is_virtual_singer(name: str) -> bool:
    """判断一个歌手名是否属于已收录的虚拟歌手/声音库。"""
    if not name:
        return False
    n = name.strip().lower()
    if not n:
        return False
    for v in VIRTUAL_SINGERS:
        if v.lower() == n:
            return True
    return False
