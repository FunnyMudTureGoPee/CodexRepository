"""
responses_projection — /v1/responses 的后端投影层。

目标
----
Codex CLI 会把大量运行时提示、完整工具 schema、长历史、以及工具输出一并塞进
/v1/responses 请求里。腾讯后端对这类 agentic payload 很容易触发内容审核，或者
因为上下文过长而表现不稳定。

本模块在保持外部 OpenAI Responses 兼容的前提下，只对发往后端的 Chat body 做
"最小语义闭包"投影：

- 固定短 system 摘要替换 Codex/Claude Code harness
- 保留最新用户意图
- 保留最近一段真实 assistant/tool 链路
- 把更早历史压缩成规则摘要
- 把 tool schema 收敛成结构字段
- 把超长 tool output / tool arguments 压缩成可继续推理的摘要
"""

from __future__ import annotations

import contextvars
import json
import os
from functools import lru_cache
from typing import Any


AGENTIC_TOOL_NAMES = {
    "exec_command",
    "write_stdin",
    "update_plan",
    "request_user_input",
    "view_image",
    "get_goal",
    "create_goal",
    "update_goal",
    "apply_patch",
    "tool_search_tool",
}

HARNESS_USER_MARKERS = (
    "# AGENTS.md instructions",
    "<environment_context>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<skills_instructions>",
    "<system-reminder>",
    "# claudeMd",
)

HARNESS_SYSTEM_MARKERS = (
    "You are a coding agent running in the Codex CLI",
    "Within this context, Codex refers to",
    "# AGENTS.md spec",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<skills_instructions>",
    "The following deferred tools are now available via ToolSearch.",
    "### Available skills",
    "## request_user_input availability",
    "You are Claude Code",
)

BASE_SYSTEM_PROMPT = (
    "You are a coding assistant serving an OpenAI-compatible CLI. "
    "Be precise, concise, safe, and action-oriented. "
    "Use available tools when needed, follow repository instructions and durable user context, "
    "and continue from the preserved recent context. "
    "If earlier history was condensed, rely on the preserved recent messages and rerun tools when exact old details are required."
)

HISTORY_PREFIX = "Earlier conversation summary (condensed):"

# ---------------------------------------------------------------------------
# 上下文预算：**总预算 + 分段占比**
#
# 原则：**客户端发过来的内容尽量原样送到上游**，只有真正装不下时才降级。
# 每条消息的上限不是拍脑袋的常量，而是「这次请求愿意花多少字符」的一个份额：
#
#     总预算   = 模型输入窗口 maxInputTokens × 2 字符/token × 25%
#     某段上限 = max(总预算 × 该段占比, 下面那个基准值)
#
# 基准值同时是**下限** —— 窗口很小或读不到窗口时，行为与老版本一致，不倒退。
#
# 1M 窗口（glm-5.2 / deepseek-v4-pro|flash / kimi-k3-1）下：
#   总预算 500,000 字符，工具输出单条上限 **250,000 字符**。
# Codex 自己还有 `tool_output_token_limit`（默认 10,000 token ≈ 2 万字符），
# 所以真实工具输出会**完整透传**，中间不会被丢掉。
# ---------------------------------------------------------------------------
MAX_SYSTEM_GUIDANCE_CHARS = 1200
MAX_USER_CHARS = 3200
MAX_ASSISTANT_CHARS = 1800
MAX_TOOL_OUTPUT_CHARS = 1600
MAX_TOOL_ARGS_CHARS = 900
MAX_HISTORY_SUMMARY_CHARS = 2200
MAX_HISTORY_ITEMS = 10
MAX_TAIL_MESSAGES = 8
MAX_TAIL_CHARS = 7000
# 工具输出摘要保留的行数（只在真的超限、必须降级时才用）。
MAX_TOOL_HEAD_LINES = 10
MAX_TOOL_TAIL_LINES = 6

# 条数预算的硬上限。设得宽松，让**字符预算**成为真正的约束 ——
# 条数上限太小会把「预算还很富余」的历史白白丢进摘要里。
MAX_TAIL_MESSAGES_CAP = 400
MAX_HISTORY_ITEMS_CAP = 400
MAX_TOOL_HEAD_LINES_CAP = 40
MAX_TOOL_TAIL_LINES_CAP = 24

# 总预算怎么算：
#   usable = 模型输入窗口 - 上面预留的输出额度
#   总预算 = usable × 2 字符/token，再被 SAFETY_MAX_TOTAL_CHARS 封顶
#
# ⚠️ 这里刻意**不**取「窗口的一个小比例」。原则是：
# **客户端发来的内容只要装得下就一个字节都不动**，压缩只在真正装不下时发生。
# 实测（2026-10-15，glm-5.2 直连上游）：
#   300,102 字符 → HTTP 200，4.7s，正中间的标记行模型能读到
#   800,040 字符 → HTTP 200，22.1s，同样能读到中间
# 而生产日志里真实请求最大 784,473 字符 → 也就是说**全部真实流量都能原样透传**。
SAFETY_MAX_TOTAL_CHARS = 900_000
# 从输入窗口里扣掉、留给输出与上游自身开销的 token。
OUTPUT_TOKEN_RESERVE = 64_000
# 中英混排的经验换算（1 token ≈ 2 字符）。
BUDGET_CHARS_PER_TOKEN = 2.0
# 读不到模型窗口时的总预算（≈ 16K token），与老版本量级相当。
FALLBACK_TOTAL_BUDGET_CHARS = 32000

# 各段可以占用总预算的比例。键就是上面那些基准常量。
BUDGET_SHARES: dict[int, float] = {
    MAX_SYSTEM_GUIDANCE_CHARS: 0.05,
    MAX_USER_CHARS: 0.40,
    MAX_ASSISTANT_CHARS: 0.10,
    MAX_TOOL_OUTPUT_CHARS: 0.50,
    MAX_TOOL_ARGS_CHARS: 0.05,
    MAX_HISTORY_SUMMARY_CHARS: 0.10,
    MAX_TAIL_CHARS: 0.60,
}

# 手动覆盖：作为**乘数**叠加在推导出的总预算上（1.0 = 不干预）。
BUDGET_SCALE_ENV = "CODEBUDDY2_PROJECTION_SCALE"

# 每个请求在入口处设置一次；projection 内部全同步，但请求之间可能并发，
# 所以用 ContextVar 而不是模块级变量。
_TOTAL_CHARS: contextvars.ContextVar[int] = contextvars.ContextVar(
    "responses_projection_total_chars", default=FALLBACK_TOTAL_BUDGET_CHARS
)

# 「先探体积、后决定压不压」用的开关。
#
# ⚠️ 为什么需要它：分段预算（`MAX_TOOL_OUTPUT_CHARS` 等）是在**逐条构造会话**时
# 就生效的，而「整段透传」的判定却在构造**之后**。于是会出现：
# 单条工具输出 800,040 字符 > 分段上限 450,000 → 当场被摘要成 8,000 字符，
# 等轮到判 `fits_in_budget` 时体积早就小了，判成 True 也救不回来。
# 实测就是这个坑：800,040 字符的读取请求，`total_budget_chars=900000` 却只送出 7,955。
#
# 解法：先用「无限额」跑一遍构造（只做归一化：抽文本、折叠 harness 信封、清孤立 tool），
# 量出**真实体积**；装得下就直接用这一版（真·一字不改）；装不下才用有限额的方式重跑。
_UNBOUNDED: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "responses_projection_unbounded", default=False
)
_UNBOUNDED_LIMIT = 1 << 40  # 「无限额」哨兵值，远大于任何真实内容

# 截断标记。文案**刻意保持不变**（` ... [truncated N chars]`），
# 这样 diagnose-truncation-source 技能里的统计脚本与既有取证文件继续有效。
_TRUNCATION_MARKER_ROOM = 40


@lru_cache(maxsize=64)
def _total_budget_from_tokens(model_tokens: int | None) -> int:
    """按模型输入窗口推导总预算（字符）。读不到窗口时用兜底值。

    取的是「窗口扣掉输出预留」后的**绝大部分**，不是一个小比例 ——
    目标是让客户端发来的内容尽量原样送达。真正封顶的是 SAFETY_MAX_TOTAL_CHARS
    （按实测的上游可接受体积定的），而不是这里。
    """
    if not model_tokens or model_tokens <= 0:
        return FALLBACK_TOTAL_BUDGET_CHARS
    usable = max(model_tokens - OUTPUT_TOKEN_RESERVE, model_tokens // 2)
    derived = int(usable * BUDGET_CHARS_PER_TOKEN)
    return max(min(derived, SAFETY_MAX_TOTAL_CHARS), FALLBACK_TOTAL_BUDGET_CHARS)


def resolve_total_budget(model_tokens: int | None = None) -> int:
    """当前生效的总预算（字符）。环境变量作为乘数叠加在推导值之上。"""
    total = _total_budget_from_tokens(model_tokens)
    raw = (os.environ.get(BUDGET_SCALE_ENV) or "").strip()
    if raw:
        try:
            return max(int(total * float(raw)), 1)
        except ValueError:
            pass
    return total


def total_budget_chars() -> int:
    """读取本次请求已设置的总预算。"""
    return _TOTAL_CHARS.get()


def _budget(base: int) -> int:
    """一段**字符**预算：总预算 × 该段占比，且不低于基准值。

    在「探体积」阶段（`_UNBOUNDED`）返回哨兵值，等于不限额。
    """
    if _UNBOUNDED.get():
        return _UNBOUNDED_LIMIT
    share = BUDGET_SHARES.get(base, 0.0)
    return max(int(_TOTAL_CHARS.get() * share), base)


def _count_budget(base: int, cap: int) -> int:
    """一段**条数**预算（条数涨得比字符慢，且有硬上限）。"""
    if _UNBOUNDED.get():
        return cap
    ratio = _TOTAL_CHARS.get() / FALLBACK_TOTAL_BUDGET_CHARS
    return max(min(int(round(base * ratio)), cap), base)


SCHEMA_KEEP_KEYS = {
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "oneOf",
    "anyOf",
    "allOf",
    "additionalProperties",
    "format",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "nullable",
}


def project_responses_chat_body(
    body: dict, model_tokens: int | None = None
) -> tuple[dict, dict]:
    """把 Responses 转出来的 Chat body 投影成更适合腾讯后端的最小上下文。

    `model_tokens` 是该模型的**真实输入窗口**（WorkBuddy product.json 的
    `maxInputTokens`）。给了就按窗口推导总预算，没给就用兜底总预算。

    预算足够时内容**原样透传**；只有真的超限才做有损压缩。
    """
    token = _TOTAL_CHARS.set(resolve_total_budget(model_tokens))
    try:
        return _project_responses_chat_body(body, model_tokens)
    finally:
        _TOTAL_CHARS.reset(token)


def _project_responses_chat_body(
    body: dict, model_tokens: int | None = None
) -> tuple[dict, dict]:
    projected = dict(body)
    messages = list(body.get("messages") or [])
    tools = list(body.get("tools") or [])

    projected_tools, tool_stats = _project_tools(tools)
    if projected_tools:
        projected["tools"] = projected_tools
    elif "tools" in projected:
        projected["tools"] = []

    aggressive = _looks_like_agentic_cli(messages, tools)
    if not aggressive:
        conservative_messages, orphan_tools = _sanitize_tool_sequence(
            _project_messages_conservative(messages)
        )
        projected["messages"] = conservative_messages
        return projected, {
            "mode": "conservative",
            "aggressive": False,
            # 保守路径不做尾部切分/历史摘要，所以「是否透传」这个概念不适用。
            # 显式给 None（而不是干脆不给）是为了让日志能区分
            # 「这条请求走了保守路径」与「统计字段丢了」。
            "passthrough": None,
            "model_tokens": model_tokens,
            "total_budget_chars": total_budget_chars(),
            "tool_output_limit": _budget(MAX_TOOL_OUTPUT_CHARS),
            "dropped_orphan_tool_messages": orphan_tools,
            "original_messages": len(messages),
            "projected_messages": len(projected["messages"]),
            "original_message_chars": _messages_size(messages),
            "projected_message_chars": _messages_size(projected["messages"]),
            **tool_stats,
        }

    tool_name_by_call_id = _build_tool_call_name_map(messages)

    def _build_conversation(unbounded: bool) -> tuple[list[dict], list[str], int]:
        """按给定限额模式构造会话（只归一化，不做尾部切分/历史摘要）。"""
        flag = _UNBOUNDED.set(unbounded)
        try:
            guidance_out: list[str] = []
            convo: list[dict] = []
            dropped = 0
            for msg in messages:
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                text = _content_to_text(msg.get("content", ""))

                if role == "system":
                    if _looks_like_harness_system(text):
                        dropped += 1
                        continue
                    guidance = _truncate_text(text, _budget(MAX_SYSTEM_GUIDANCE_CHARS))
                    if guidance:
                        guidance_out.append(guidance)
                    continue

                if role == "user" and _looks_like_harness_user(text):
                    dropped += 1
                    continue

                projected_msg = _project_conversation_message(msg)
                if projected_msg is not None:
                    convo.append(projected_msg)

            if not convo:
                convo = _project_messages_conservative(messages)
            return convo, guidance_out, dropped
        finally:
            _UNBOUNDED.reset(flag)

    # 阶段一：**不限额**构造一遍，只为量出真实体积（只归一化，绝不丢内容）。
    conversation, preserved_guidance, dropped_harness_messages = _build_conversation(
        unbounded=True
    )
    # 工具序列兜底（必须在选尾部之前）：清掉孤立的 tool 结果，
    # 否则 _expand_tail_for_tool_context 会去找一个根本不存在的 assistant 轮。
    conversation, orphan_tools = _sanitize_tool_sequence(conversation)

    # ⭐ 装得下就**整段原样保留**：不做尾部切分、不做历史摘要。
    #    这才是「工具读取的内容视为完全有效」的落点 —— 只要体积在总预算内，
    #    任何中间内容都不会被丢掉。只有真的装不下才走下面的压缩路径。
    #
    #    注意：这里比的是**归一化后、未限额**的体积。早年踩过的坑是先按分段预算
    #    截好了再来判，结果单条大输出早被摘要掉、判定永远为真（800 KB → 7.9 KB）。
    fits_in_budget = _messages_size(conversation) <= total_budget_chars()

    if fits_in_budget:
        tail_start = 0
        latest_user_idx = None
        anchor_user = None
        omitted: list[dict] = []
        passthrough = True
    else:
        # 阶段二：确实装不下，重新按**分段预算**构造，再走切尾 + 历史摘要。
        conversation, preserved_guidance, dropped_harness_messages = _build_conversation(
            unbounded=False
        )
        conversation, orphan_tools_extra = _sanitize_tool_sequence(conversation)
        orphan_tools += orphan_tools_extra

        tail_start = _choose_tail_start(conversation)
        tail_start = _expand_tail_for_tool_context(conversation, tail_start)
        latest_user_idx = _latest_user_index(conversation)

        anchor_user = None
        if latest_user_idx is not None and latest_user_idx < tail_start:
            anchor_user = dict(conversation[latest_user_idx])

        omitted = []
        for idx, msg in enumerate(conversation):
            if idx >= tail_start:
                break
            if latest_user_idx is not None and idx == latest_user_idx and anchor_user is not None:
                continue
            omitted.append(msg)
        passthrough = False

    final_messages: list[dict] = [{"role": "system", "content": BASE_SYSTEM_PROMPT}]
    guidance_message = _merge_guidance_messages(preserved_guidance)
    if guidance_message:
        final_messages.append({"role": "system", "content": guidance_message})

    history_summary = _build_history_summary(omitted, tool_name_by_call_id)
    if history_summary:
        final_messages.append({"role": "system", "content": history_summary})

    if anchor_user is not None:
        final_messages.append(anchor_user)

    final_messages.extend(conversation[tail_start:])

    # 再兜一次：尾部切分可能让工具消息和它的 assistant 轮脱节。
    # 幂等，正常情况下这一次不会再多丢东西。
    final_messages, orphan_tools_2 = _sanitize_tool_sequence(final_messages)
    orphan_tools += orphan_tools_2
    projected["messages"] = final_messages

    return projected, {
        "mode": "aggressive",
        "aggressive": True,
        "passthrough": passthrough,
        "model_tokens": model_tokens,
        "total_budget_chars": total_budget_chars(),
        "tool_output_limit": _budget(MAX_TOOL_OUTPUT_CHARS),
        "dropped_orphan_tool_messages": orphan_tools,
        "dropped_harness_messages": dropped_harness_messages,
        "preserved_guidance_messages": len(preserved_guidance),
        "summarized_history_messages": len(omitted),
        "anchor_user_preserved": anchor_user is not None,
        "tail_messages": len(conversation[tail_start:]),
        "original_messages": len(messages),
        "projected_messages": len(final_messages),
        "original_message_chars": _messages_size(messages),
        "projected_message_chars": _messages_size(final_messages),
        **tool_stats,
    }


def _looks_like_agentic_cli(messages: list[dict], tools: list[dict]) -> bool:
    tool_names = {
        _tool_name(tool)
        for tool in tools
        if _tool_name(tool)
    }
    if tool_names & AGENTIC_TOOL_NAMES:
        return True

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        text = _content_to_text(msg.get("content", ""))
        if _looks_like_harness_user(text) or _looks_like_harness_system(text):
            return True
    return False


def _project_messages_conservative(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for msg in messages:
        projected = _project_conversation_message(msg, conservative=True)
        if projected is not None:
            out.append(projected)
    return out


def _has_image_part(content: Any) -> bool:
    """content 是否为含图片 part 的多模态列表。"""
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") in ("image_url", "input_image")
        for block in content
    )


def _truncate_multimodal(content: list, limit: int) -> list:
    """多模态 content 的截断：图片原样保留，只截断文本 part。

    图片走 base64 data URI，长度远超 MAX_USER_CHARS，若按文本截断会把图片切碎，
    所以这里对图片完全不做长度限制——真正的护栏是上游自己的请求体大小限制。
    """
    out = []
    for block in content:
        if not isinstance(block, dict):
            out.append(block)
            continue
        if block.get("type") in ("image_url", "input_image"):
            out.append(block)
        elif block.get("type") in ("text", "input_text", "output_text"):
            text = _condense_harness_user(str(block.get("text", "")))
            out.append({**block, "text": _truncate_text(text, limit)})
        else:
            out.append(block)
    return out


def _project_conversation_message(msg: dict, conservative: bool = False) -> dict | None:
    if not isinstance(msg, dict):
        return None

    role = msg.get("role")
    out = dict(msg)

    if role == "system":
        text = _content_to_text(msg.get("content", ""))
        out["content"] = _truncate_text(text, _budget(MAX_SYSTEM_GUIDANCE_CHARS))
        return out

    if role == "user":
        content = msg.get("content", "")
        if _has_image_part(content):
            # 多模态：保留图片，文本仍按 MAX_USER_CHARS 截断
            out["content"] = _truncate_multimodal(
                content, _budget(MAX_USER_CHARS)
            )
            return out
        text = _condense_harness_user(_content_to_text(content))
        out["content"] = _truncate_text(text, _budget(MAX_USER_CHARS))
        return out

    if role == "assistant":
        text = _content_to_text(msg.get("content", ""))
        out["content"] = _truncate_text(text, _budget(MAX_ASSISTANT_CHARS))
        tool_calls = []
        for tool_call in msg.get("tool_calls") or []:
            projected_call = _project_tool_call(tool_call)
            if projected_call is not None:
                tool_calls.append(projected_call)
        if tool_calls:
            out["tool_calls"] = tool_calls
        elif "tool_calls" in out:
            out.pop("tool_calls", None)
        return out

    if role == "tool":
        out["content"] = _summarize_tool_output(_content_to_text(msg.get("content", "")))
        return out

    if conservative:
        text = _content_to_text(msg.get("content", ""))
        out["content"] = _truncate_text(text, _budget(MAX_ASSISTANT_CHARS))
        return out

    return None


def _sanitize_tool_sequence(messages: list[dict]) -> tuple[list[dict], int]:
    """保证 tool 消息一定挂在「前面对应 assistant 的 tool_calls」下面。

    腾讯后端会严格校验这一对，不成对就直接 400：
        [11148] tool calls and tool results do not match,
                please start a new conversation and retry

    为什么会不成对（已查清）：VS Code Copilot 的 BRi() 在命中 stateful marker 时
    会执行 `e = e.slice(m + 1)`，只把历史尾部发过来，更早的 assistant 工具调用
    交给 previous_response_id（由服务端自己记住）。而本转换器不认
    previous_response_id，那一轮 assistant 就彻底丢了，只剩孤立的 tool 结果。
    历史被截断时同样会出现「有 tool_calls 但结果被截掉」的相反情况。

    兜底规则（两个方向都修）：
      - tool 消息找不到声明的 tool_call_id  → 丢掉
      - assistant 的某个 tool_call 没有对应结果 → 从 tool_calls 里摘掉；
        若摘完 tool_calls 为空且 content 也为空，这条 assistant 一并丢掉
        （否则会留下空 assistant，上游同样可能报错）
    """
    declared: set[str] = set()
    answered: set[str] = set()
    staged: list[dict] = []
    dropped = 0

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")

        if role == "assistant":
            for call in msg.get("tool_calls") or []:
                if isinstance(call, dict) and call.get("id"):
                    declared.add(str(call["id"]))
            staged.append(msg)
            continue

        if role == "tool":
            call_id = str(msg.get("tool_call_id") or "")
            if not call_id or call_id not in declared:
                dropped += 1
                continue
            answered.add(call_id)
            staged.append(msg)
            continue

        staged.append(msg)

    out: list[dict] = []
    for msg in staged:
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            remaining = [
                call
                for call in msg["tool_calls"]
                if isinstance(call, dict) and str(call.get("id")) in answered
            ]
            if len(remaining) != len(msg["tool_calls"]):
                msg = dict(msg)
                if remaining:
                    msg["tool_calls"] = remaining
                else:
                    msg.pop("tool_calls", None)
                    if not _content_to_text(msg.get("content", "")).strip():
                        dropped += 1
                        continue
        out.append(msg)

    return out, dropped


def _project_tool_call(tool_call: dict) -> dict | None:
    if not isinstance(tool_call, dict):
        return None

    function = tool_call.get("function") or {}
    name = function.get("name", "")
    arguments = function.get("arguments", "")

    return {
        "id": tool_call.get("id"),
        "type": tool_call.get("type", "function"),
        "function": {
            "name": name,
            "arguments": _summarize_tool_arguments(name, arguments),
        },
    }


def _summarize_tool_arguments(name: str, arguments: Any) -> str:
    if not isinstance(arguments, str):
        try:
            return json.dumps(arguments, ensure_ascii=False)
        except Exception:
            return json.dumps({"summary": _truncate_text(str(arguments), 240)}, ensure_ascii=False)

    if len(arguments) <= _budget(MAX_TOOL_ARGS_CHARS):
        return arguments

    if name == "apply_patch":
        return json.dumps(
            {"summary": "Large apply_patch payload omitted; a patch was prepared or applied in a previous step."},
            ensure_ascii=False,
        )

    try:
        parsed = json.loads(arguments)
    except Exception:
        return json.dumps({"summary": _truncate_text(arguments, 320)}, ensure_ascii=False)

    return json.dumps(_shrink_json_value(parsed), ensure_ascii=False)


def _shrink_json_value(value: Any, depth: int = 0, key: str = "") -> Any:
    if depth >= 4:
        return "<omitted>"

    if isinstance(value, dict):
        out = {}
        items = list(value.items())
        for idx, (item_key, item_value) in enumerate(items):
            if idx >= 12:
                out["_omitted_keys"] = len(items) - idx
                break
            out[item_key] = _shrink_json_value(item_value, depth + 1, item_key)
        return out

    if isinstance(value, list):
        trimmed = [_shrink_json_value(item, depth + 1, key) for item in value[:6]]
        if len(value) > 6:
            trimmed.append(f"<omitted {len(value) - 6} items>")
        return trimmed

    if isinstance(value, str):
        limit = 240 if key in {"cmd", "chars", "patch", "content", "text", "question"} else 120
        return _truncate_text(value, limit)

    return value


def _project_tools(tools: list[dict]) -> tuple[list[dict], dict]:
    projected = []
    original_chars = _tools_size(tools)

    for tool in tools:
        if not isinstance(tool, dict):
            continue

        if tool.get("type") != "function":
            continue

        function = tool.get("function") or tool
        name = function.get("name")
        if not name:
            continue

        projected_function: dict[str, Any] = {"name": name}
        if "parameters" in function:
            projected_function["parameters"] = _project_schema(function.get("parameters"))
        if "strict" in function:
            projected_function["strict"] = function.get("strict")

        projected.append({"type": "function", "function": projected_function})

    return projected, {
        "original_tools": len(tools),
        "projected_tools": len(projected),
        "original_tool_chars": original_chars,
        "projected_tool_chars": _tools_size(projected),
    }


def _project_schema(schema: Any, depth: int = 0) -> Any:
    if depth >= 6:
        return {"type": "object"}

    if isinstance(schema, dict):
        out: dict[str, Any] = {}
        for key, value in schema.items():
            if key not in SCHEMA_KEEP_KEYS:
                continue
            if key == "properties" and isinstance(value, dict):
                out["properties"] = {
                    prop: _project_schema(prop_schema, depth + 1)
                    for prop, prop_schema in value.items()
                }
            elif key == "items":
                out["items"] = _project_schema(value, depth + 1)
            elif key in {"oneOf", "anyOf", "allOf"} and isinstance(value, list):
                out[key] = [_project_schema(item, depth + 1) for item in value[:6]]
            elif key == "additionalProperties" and isinstance(value, dict):
                out[key] = _project_schema(value, depth + 1)
            else:
                out[key] = value
        return out or {"type": "object"}

    if isinstance(schema, list):
        return [_project_schema(item, depth + 1) for item in schema[:6]]

    return schema


def _choose_tail_start(messages: list[dict]) -> int:
    if not messages:
        return 0

    start = len(messages) - 1
    total_chars = 0
    kept = 0

    for idx in range(len(messages) - 1, -1, -1):
        cost = _message_cost(messages[idx])
        if kept > 0 and (
            kept >= _count_budget(MAX_TAIL_MESSAGES, MAX_TAIL_MESSAGES_CAP)
            or total_chars + cost > _budget(MAX_TAIL_CHARS)
        ):
            break
        start = idx
        total_chars += cost
        kept += 1
    return start


def _expand_tail_for_tool_context(messages: list[dict], start: int) -> int:
    if start <= 0 or not messages:
        return start

    needed_call_ids = {
        msg.get("tool_call_id")
        for msg in messages[start:]
        if isinstance(msg, dict) and msg.get("role") == "tool" and msg.get("tool_call_id")
    }
    if not needed_call_ids:
        return start

    expanded = start
    for idx in range(start - 1, -1, -1):
        msg = messages[idx]
        if msg.get("role") != "assistant":
            continue
        call_ids = {
            tool_call.get("id")
            for tool_call in msg.get("tool_calls") or []
            if isinstance(tool_call, dict)
        }
        if call_ids & needed_call_ids:
            expanded = idx
            needed_call_ids -= call_ids
            if not needed_call_ids:
                break
    return expanded


def _latest_user_index(messages: list[dict]) -> int | None:
    for idx in range(len(messages) - 1, -1, -1):
        if messages[idx].get("role") == "user":
            return idx
    return None


def _build_history_summary(messages: list[dict], tool_name_by_call_id: dict[str, str]) -> str:
    lines: list[str] = []
    total_chars = 0
    summarized = 0

    for msg in messages:
        line = _history_line(msg, tool_name_by_call_id)
        if not line:
            continue
        if summarized >= _count_budget(
            MAX_HISTORY_ITEMS, MAX_HISTORY_ITEMS_CAP
        ) or total_chars + len(line) > _budget(MAX_HISTORY_SUMMARY_CHARS):
            break
        lines.append(f"- {line}")
        total_chars += len(line)
        summarized += 1

    remaining = len(messages) - summarized
    if remaining > 0:
        lines.append(f"- {remaining} earlier messages or tool results were further condensed.")

    if not lines:
        return ""
    return HISTORY_PREFIX + "\n" + "\n".join(lines)


def _history_line(msg: dict, tool_name_by_call_id: dict[str, str]) -> str:
    role = msg.get("role")
    text = _content_to_text(msg.get("content", ""))

    if role == "user":
        # 先拆 harness 信封再截断，否则 220 字符的窗口只够装信封头部，
        # 真正的指令（在信封末尾）会被切掉。
        return f"User asked: {_truncate_text(_condense_harness_user(text), 220)}"

    if role == "assistant":
        tool_names = [
            (tool_call.get("function") or {}).get("name")
            for tool_call in msg.get("tool_calls") or []
            if isinstance(tool_call, dict)
        ]
        tool_names = [name for name in tool_names if name]
        if text and tool_names:
            return f"Assistant replied: {_truncate_text(text, 160)} Then called tools: {', '.join(tool_names[:4])}."
        if tool_names:
            return f"Assistant called tools: {', '.join(tool_names[:4])}."
        if text:
            return f"Assistant replied: {_truncate_text(text, 180)}"
        return ""

    if role == "tool":
        tool_name = tool_name_by_call_id.get(msg.get("tool_call_id", ""), "tool")
        summary = _tool_output_inline_summary(text)
        return f"Tool {tool_name} returned: {summary}"

    if role == "system":
        return f"System guidance: {_truncate_text(text, 180)}"

    return ""


def _build_tool_call_name_map(messages: list[dict]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        for tool_call in msg.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            call_id = tool_call.get("id")
            name = (tool_call.get("function") or {}).get("name")
            if call_id and name:
                mapping[call_id] = name
    return mapping


def _merge_guidance_messages(messages: list[str]) -> str:
    merged: list[str] = []
    total = 0
    limit = _budget(MAX_SYSTEM_GUIDANCE_CHARS)
    for message in messages[:2]:
        text = message.strip()
        if not text:
            continue
        if total + len(text) > limit:
            text = _truncate_text(text, limit - total)
        merged.append(text)
        total += len(text)
        if total >= limit:
            break
    if not merged:
        return ""
    if len(merged) == 1:
        return merged[0]
    return "Additional instructions:\n" + "\n\n".join(merged)


def _summarize_tool_output(text: str) -> str:
    """工具输出：**装得下就原样返回**，装不下才降级成首尾摘要。

    旧实现除了长度限制，还额外要求 `\\n` 行数 <= 24 —— 等于「多行输出一律摘要」。
    文件读取、grep 结果、grep 出的代码片段恰恰是行多且**每一行都可能有用**，
    这个门槛把它们全部压成首尾各几行，中间整段丢失（实测 120 KB 的文件读取
    被压成 7.9 KB，正中间的标记行直接不见）。现在只按**体积**决定是否降级。
    """
    text = (text or "").strip()
    if not text:
        return ""
    limit = _budget(MAX_TOOL_OUTPUT_CHARS)
    if len(text) <= limit:
        return text

    lines = text.splitlines()
    exit_line = next((line.strip() for line in lines if "Process exited with code" in line), "")
    useful_lines = []
    saw_output = False
    for line in lines:
        stripped = line.rstrip()
        if stripped == "Output:":
            saw_output = True
            continue
        if (
            stripped.startswith("Chunk ID:")
            or stripped.startswith("Wall time:")
            or stripped.startswith("Original token count:")
            or stripped.startswith("Process exited with code")
        ):
            continue
        useful_lines.append(stripped)

    body_lines = useful_lines

    head_n = _count_budget(MAX_TOOL_HEAD_LINES, MAX_TOOL_HEAD_LINES_CAP)
    tail_n = _count_budget(MAX_TOOL_TAIL_LINES, MAX_TOOL_TAIL_LINES_CAP)

    head = body_lines[:head_n]
    tail = body_lines[-tail_n:] if len(body_lines) > head_n + tail_n else []
    omitted = max(len(body_lines) - len(head) - len(tail), 0)

    parts: list[str] = []
    if exit_line:
        parts.append(exit_line)
    if head:
        parts.append("Key output:")
        parts.extend(head)
    if omitted:
        parts.append(f"... [omitted {omitted} lines] ...")
    if tail:
        parts.append("Recent tail:")
        parts.extend(tail)

    summary = "\n".join(part for part in parts if part).strip()
    return _truncate_text(summary or text, limit)


def _tool_output_inline_summary(text: str) -> str:
    summarized = _summarize_tool_output(text)
    summarized = summarized.replace("\n", " | ")
    return _truncate_text(summarized, 220)


def _truncate_text(text: str, limit: int) -> str:
    """超长文本截断：保留「首部 + 尾部」，只省略中段。

    旧实现是 `text[:limit]`，即**保头砍尾**。但 agentic 场景里判断下一步所需的
    信息几乎都在尾部：工具输出的报错与退出码、用户消息末尾的真实提问、
    JSON 命令串最后那几条命令。丢尾会让模型以为上一步没有结果而反复重跑工具。

    实测证据（`local-data/requests.log`）：`_summarize_tool_output()` 明明已经拼好了
    `... [omitted N lines] ...` + `Recent tail:` 两段，却被本函数的保头砍尾在
    最后一步把尾巴摘掉 —— `Key output:` 出现 1890 次而 `Recent tail:` 只有 1135 次。

    改成首尾对开，**字符预算不变**（仍 ≤ limit），所以不会把「上游内容审核 /
    上下文过长」这两个原始设计目标重新引回来 —— 这是它比「放大常量」更该做的
    原因：形状不改，预算转多大都会丢尾巴。

    标记文案刻意保持不变（` ... [truncated N chars]`），
    以便 `diagnose-truncation-source` 技能里的统计脚本继续有效。
    """
    text = (text or "").strip()
    if not text or limit <= 0:
        return ""
    if len(text) <= limit:
        return text

    budget = max(limit - _TRUNCATION_MARKER_ROOM, 16)
    head_len = max(int(budget * 0.6), 1)
    tail_len = max(budget - head_len, 1)
    head = text[:head_len].rstrip()
    tail = text[-tail_len:].lstrip()
    omitted = len(text) - len(head) - len(tail)
    if omitted <= 0:
        return text[:limit]
    return f"{head} ... [truncated {omitted} chars] ...\n{tail}"


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if "text" in block:
                    parts.append(str(block.get("text", "")))
                elif "output" in block:
                    parts.append(str(block.get("output", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content)


def _looks_like_harness_user(text: str) -> bool:
    return any(marker in text for marker in HARNESS_USER_MARKERS)


def _looks_like_harness_system(text: str) -> bool:
    return any(marker in text for marker in HARNESS_SYSTEM_MARKERS)


USER_REQUEST_OPEN = "<userRequest>"
USER_REQUEST_CLOSE = "</userRequest>"
EDITOR_FILE_MARKER = "The user's current file is"


def _extract_user_request(text: str) -> str | None:
    """取出 <userRequest>…</userRequest> 里真正的提问。"""
    start = text.find(USER_REQUEST_OPEN)
    if start == -1:
        return None
    start += len(USER_REQUEST_OPEN)
    end = text.find(USER_REQUEST_CLOSE, start)
    inner = text[start : end if end != -1 else len(text)].strip()
    return inner or None


def _extract_editor_file(text: str) -> str:
    """取出「当前文件」这一行（短、有用，值得保留）。"""
    idx = text.find(EDITOR_FILE_MARKER)
    if idx == -1:
        return ""
    return text[idx:].split("\n", 1)[0].strip()[:200]


def _condense_harness_user(text: str) -> str:
    """把 agent 客户端的 harness 信封压成「当前文件 + 真正的提问」。

    实测信封形态：
        <context>…日期 / 终端 / todoList…</context>
        <editorContext>The user's current file is …</editorContext>
        <reminderInstructions>…每轮都重复的工具使用须知…</reminderInstructions>
        <userRequest>将演出时的食材表现默认调为第三档，…</userRequest>

    真正的指令吊在**末尾**，信封约 1.2K 字符，其中 ~700 字符是每次都重复的
    reminderInstructions。于是任何「从头截断」都会先把指令切掉：
      - 用户消息投影里的 `_truncate_text(…, MAX_USER_CHARS)`
      - 历史摘要 `_history_line` 的 220 字符
    实测后果就是模型答「I don't see a specific request」。
    所以这里先把信封拆开，只留指令（外加当前文件名这种短而有用的信息）。
    """
    intent = _extract_user_request(text)
    if intent is None:
        return text
    editor = _extract_editor_file(text)
    return f"{editor}\n{intent}" if editor else intent


def _message_cost(msg: dict) -> int:
    cost = len(_content_to_text(msg.get("content", "")))
    for tool_call in msg.get("tool_calls") or []:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function") or {}
        cost += len(function.get("name", ""))
        cost += len(function.get("arguments", ""))
    return cost


def _messages_size(messages: list[dict]) -> int:
    total = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        total += _message_cost(msg)
        total += len(msg.get("role", ""))
    return total


def _tool_name(tool: dict) -> str:
    if not isinstance(tool, dict):
        return ""
    function = tool.get("function") or tool
    return str(function.get("name", "") or "")


def _tools_size(tools: list[dict]) -> int:
    try:
        return len(json.dumps(tools, ensure_ascii=False))
    except Exception:
        return 0
