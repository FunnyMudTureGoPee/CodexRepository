"""lyrics_crawler — 自动抓取主流音乐平台歌词并输出 UTF-8 JSONL。

识别字段: id / title / artist / album / language / lyrics / source
输出: <prefix>.jsonl (歌词) 与 <prefix>.errors.jsonl (失败记录)。
"""

__version__ = "0.1.0"
