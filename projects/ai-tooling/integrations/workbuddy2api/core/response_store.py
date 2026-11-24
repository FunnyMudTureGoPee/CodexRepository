"""response_store — /v1/responses 的「有状态」支持（store + previous_response_id）。

背景（已从真实请求日志坐实）
---------------------------
OpenAI Responses API 允许客户端**只发增量**：后续轮次的 `input` 里只放新产生的
item（通常只有 tool 结果），并且带一个 `previous_response_id`，由**服务端**把之
前的上下文接上。VS Code Copilot 这类 agent 客户端就是这么用的，实测请求形如：

    previous_response_id='resp_80062ba1a0c7bd872be14bd7'  input=2
    [{"type":"function_call_output","call_id":"list_dir_0_54cc3519"},
     {"type":"function_call_output","call_id":"grep_search_1_adf49477"}]

原来的转换器**不认 previous_response_id**，只把这一轮 input 转成 messages，
于是：
  - 用户最初那条指令（只出现在第一轮）彻底丢失 → 模型答
    「I don't see a specific request or preserved prior context」
  - 只剩孤立的 tool 结果 → 被 _sanitize_tool_sequence 丢掉后，
    整个 body 只剩一条 system，模型完全无话可接

本模块用一个**进程内 LRU 表**记住每个 response id 对应的对话消息，
下一个请求带 previous_response_id 时把历史接回来。

不落盘：进程重启后旧 id 自然失效，退化成「没有历史」，与修复前行为一致，
不会出错。存储量有上限（条数 + 单条字符数），避免长会话把内存吃穿。
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

# 最多记住多少个 response（按 LRU 淘汰）。agent 会话通常只回溯最近若干轮。
MAX_STORED_RESPONSES = 256
# 单条会话超过这个字符数就不存（避免超长历史把内存吃穿）
MAX_STORED_CHARS = 400_000

_lock = threading.Lock()
_store: "OrderedDict[str, list[dict]]" = OrderedDict()

# 统计
_hits = 0
_misses = 0


def _size(messages: list[dict]) -> int:
    total = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content", "")
        total += len(content) if isinstance(content, str) else len(str(content))
        for call in msg.get("tool_calls") or []:
            if isinstance(call, dict):
                function = call.get("function") or {}
                total += len(str(function.get("name", "")))
                total += len(str(function.get("arguments", "")))
    return total


def store_response(response_id: str | None, messages: list[dict] | None) -> bool:
    """把一条 response 对应的完整对话记下来，供后续 previous_response_id 取用。"""
    if not response_id or not messages:
        return False
    if _size(messages) > MAX_STORED_CHARS:
        return False
    with _lock:
        _store[response_id] = list(messages)
        _store.move_to_end(response_id)
        while len(_store) > MAX_STORED_RESPONSES:
            _store.popitem(last=False)
    return True


def load_response(response_id: str | None) -> list[dict] | None:
    """按 previous_response_id 取回历史消息；取不到返回 None。"""
    global _hits, _misses
    if not response_id:
        return None
    with _lock:
        messages = _store.get(response_id)
        if messages is None:
            _misses += 1
            return None
        _store.move_to_end(response_id)
        _hits += 1
        return list(messages)


def stats() -> dict[str, Any]:
    with _lock:
        return {
            "stored": len(_store),
            "hits": _hits,
            "misses": _misses,
        }


def clear() -> None:
    with _lock:
        _store.clear()
