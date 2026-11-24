"""模型目录的多种业界形状。

背景
----
各家 harness 读「模型能力」的入口互不相同，而且大多数**不读 OpenAI 的
`/v1/models` 扩展字段**。只把元数据塞进 `/v1/models` 只能覆盖一部分客户端，
其余的仍然拿不到上下文窗口和推理档位。

所以这里把同一份元数据（来自 WorkBuddy 的 `product.json`）渲染成几种主流形状，
挂在不同路径上，让客户端各取所需：

| 路径 | 形状 | 典型读者 |
| --- | --- | --- |
| `/v1/models` | OpenAI（带扩展字段） | 多数 OpenAI 兼容客户端、LiteLLM |
| `/api/v1/models` | OpenRouter | OpenRouter 系客户端、SillyTavern |
| `/model/info` | LiteLLM | LiteLLM 生态、部分网关 |
| `/api/v0/models` | LM Studio | LM Studio 系客户端（Jan 等） |
| `/api/tags` | Ollama | 按 ollama 配置的 Continue 等 |
| `/v1/model_catalog` | Codex CLI | Codex 的 `model_catalog_url` |

本模块是**纯函数**：输入是 `converter.model_card()` 产出的模型卡列表，
不碰网络、不读文件，方便单测。

关于 Codex
----------
Codex CLI 有两条自动发现路径（从 codex.exe 里挖出来的配置键）：

1. `model_providers.<name>.model_catalog_url` —— 必须与 `base_url`
   **同 scheme/host/port**，否则 Codex 拒绝拉取并提示
   「Codex would send gateway credentials to a different model catalog」。
2. 顶层 `model_catalog_json` —— 指向本地 JSON 文件，完全离线。

两者内容格式相同，都是 ``{"models": [...]}``，字段见 ``codex_catalog()``。
"""
from __future__ import annotations

import hashlib
from typing import Any

# Codex 声明的推理档位用这套名字（取自它自己的 models_cache.json）。
# 上游实测接受 none/minimal/low/medium/high/xhigh；这里只取交集里 Codex
# 认得的几档，避免出现「客户端给了档位、上游不认识」的情况。
CODEX_LEVELS = ["low", "medium", "high", "xhigh"]
CODEX_LEVEL_DESC = {
    "low": "Fast responses with lighter reasoning",
    "medium": "Balances speed and reasoning depth for everyday tasks",
    "high": "Greater reasoning depth for complex problems",
    "xhigh": "Extra high reasoning depth for complex problems",
}

# OpenRouter 的 supported_parameters 用 "reasoning" 表示「支持推理控制」，
# 而不是我们将要透传的 reasoning_effort。
OPENROUTER_REASONING_PARAM = "reasoning"

# 伪模型：`default` 实际映射到某个推理模型，`auto` 由上游自行挑。
# 它们没有确定的窗口/档位，放进「给客户端挑模型用」的目录里只会让人选错，
# 所以这几套形状统一剔除。（`/v1/models` 仍然保留，兼容既有客户端。）
PSEUDO_MODELS = {"default", "auto"}


def usable(cards: list[dict]) -> list[dict]:
    return [c for c in cards if c.get("id") not in PSEUDO_MODELS]


def _ctx(card: dict) -> int | None:
    for key in ("context_length", "context_window", "max_input_tokens"):
        v = card.get(key)
        if isinstance(v, int) and v > 0:
            return v
    return None


def _out(card: dict) -> int | None:
    for key in ("max_output_tokens", "max_completion_tokens"):
        v = card.get(key)
        if isinstance(v, int) and v > 0:
            return v
    return None


def _caps(card: dict) -> dict:
    caps = card.get("capabilities")
    return caps if isinstance(caps, dict) else {}


def _vision(card: dict) -> bool:
    return bool(_caps(card).get("vision"))


def _reasoning(card: dict) -> bool:
    return bool(_caps(card).get("reasoning"))


def _stable_digest(model_id: str) -> str:
    """Ollama 的 /api/tags 每条都要 digest，这里用 id 派生一个稳定假值。"""
    return "sha256:" + hashlib.sha256(model_id.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- OpenRouter
def openrouter_models(cards: list[dict]) -> dict[str, Any]:
    """`/api/v1/models`：OpenRouter 形状。

    读这个的主要是 OpenRouter 系客户端，它们靠 `context_length` 与
    `top_provider.max_completion_tokens` 决定压缩策略与输出上限。
    """
    data = []
    for card in cards:
        ctx = _ctx(card)
        out = _out(card)
        params = list(card.get("supported_parameters") or [])
        if _reasoning(card) and OPENROUTER_REASONING_PARAM not in params:
            params.append(OPENROUTER_REASONING_PARAM)
        item: dict[str, Any] = {
            "id": card["id"],
            "canonical_slug": card["id"],
            "name": card.get("name") or card["id"],
            "description": card.get("description") or "",
            "created": card.get("created", 1700000000),
            # 本机转发，不计费；给 0 而不是省略，省略会被某些客户端当 null 崩
            "pricing": {"prompt": "0", "completion": "0", "request": "0"},
            "architecture": {
                "input_modalities": ["text"] + (["image"] if _vision(card) else []),
                "output_modalities": ["text"],
                "tokenizer": "other",
                "instruct_type": None,
            },
            "per_request_limits": None,
            "supported_parameters": params,
            "default_parameters": {},
        }
        if ctx:
            item["context_length"] = ctx
        top: dict[str, Any] = {"is_moderated": False}
        if ctx:
            top["context_length"] = ctx
        if out:
            top["max_completion_tokens"] = out
        item["top_provider"] = top
        if _reasoning(card):
            rec = card.get("reasoning") if isinstance(card.get("reasoning"), dict) else {}
            item["reasoning"] = {
                "supported_efforts": rec.get("efforts") or [],
                "default_effort": rec.get("default_effort"),
                "supports_summary": bool(rec.get("summary")),
            }
        data.append(item)
    return {"data": data}


# ------------------------------------------------------------------- LiteLLM
def litellm_model_info(cards: list[dict], api_base: str = "") -> dict[str, Any]:
    """`/model/info`：LiteLLM Proxy 形状。

    LiteLLM 系工具（以及一些企业网关）用 `model_info.max_input_tokens` /
    `max_output_tokens` 建模型表。
    """
    base = api_base.rstrip("/")
    data = []
    for card in cards:
        ctx = _ctx(card)
        out = _out(card)
        info: dict[str, Any] = {
            "id": card["id"],
            "key": card["id"],
            "db_model": False,
        }
        if ctx:
            info["max_input_tokens"] = ctx
        if out:
            info["max_tokens"] = out
            info["max_output_tokens"] = out
        info["supports_function_calling"] = bool(_caps(card).get("tool_calling"))
        info["supports_vision"] = _vision(card)
        info["supports_reasoning"] = _reasoning(card)
        params: dict[str, Any] = {"model": f"openai/{card['id']}"}
        if base:
            params["api_base"] = base.rstrip("/") + "/v1"
        data.append(
            {
                "model_name": card["id"],
                "litellm_params": params,
                "model_info": info,
            }
        )
    return {"data": data}


# ----------------------------------------------------------------- LM Studio
def lmstudio_models(cards: list[dict]) -> dict[str, Any]:
    """`/api/v0/models`：LM Studio 形状。

    它用 `max_context_length` 和 `capabilities` 两个键，加载状态用 `state`。
    我们是纯转发，没有本地权重，`state` 固定 `not-loaded`。
    """
    data = []
    for card in cards:
        caps = []
        if _caps(card).get("tool_calling"):
            caps.append("tool_use")
        item: dict[str, Any] = {
            "id": card["id"],
            "object": "model",
            "type": "vlm" if _vision(card) else "llm",
            "publisher": "codebuddy",
            "arch": "",
            "compatibility_type": "gguf",
            "quantization": "",
            "state": "not-loaded",
            "capabilities": caps,
        }
        ctx = _ctx(card)
        if ctx:
            item["max_context_length"] = ctx
        data.append(item)
    return {"object": "list", "data": data}


# --------------------------------------------------------------------- Ollama
def ollama_tags(cards: list[dict]) -> dict[str, Any]:
    """`/api/tags`：Ollama 形状。

    Ollama 客户端（如 Continue 的 ollama provider）靠这个列模型，
    再调 `/api/show` 取细节。我们没有权重文件，`size` 给 0。
    """
    models = []
    for card in cards:
        mid = card["id"]
        models.append(
            {
                "name": mid,
                "model": mid,
                "modified_at": "2026-01-01T00:00:00Z",
                "size": 0,
                "digest": _stable_digest(mid),
                "details": {
                    "format": "gguf",
                    "family": "codebuddy",
                    "families": ["codebuddy"],
                    "parameter_size": "unknown",
                    "quantization_level": "unknown",
                },
            }
        )
    return {"models": models}


# ---------------------------------------------------------------------- Codex
def codex_catalog(cards: list[dict]) -> dict[str, Any]:
    """Codex CLI 的模型目录（`model_catalog_url` / `model_catalog_json`）。

    字段名与类型全部对齐 Codex 自己缓存下来的 `models_cache.json`：
    `slug` / `display_name` / `supported_reasoning_levels[{effort,description}]`
    / `context_window` / `max_context_window` / `visibility` / `supported_in_api`
    / `priority` / `input_modalities` / `effective_context_window_percent`。

    只给已知会被读取的键 —— Codex 对缺省字段有 serde default，
    多塞它不认识的键反而可能在严格解析时炸掉。
    """
    models = []
    for idx, card in enumerate(cards, start=1):
        ctx = _ctx(card)
        item: dict[str, Any] = {
            "slug": card["id"],
            "display_name": card.get("name") or card["id"],
            "description": card.get("description") or "",
            "visibility": "list",
            "supported_in_api": True,
            "priority": idx,
            "shell_type": "unified_exec",
            "input_modalities": ["text"] + (["image"] if _vision(card) else []),
            "default_reasoning_summary": "auto",
            "truncation_policy": {"mode": "tokens", "limit": 10000},
            "effective_context_window_percent": 95,
        }
        if ctx:
            item["context_window"] = ctx
            item["max_context_window"] = ctx
        if _reasoning(card):
            rec = card.get("reasoning") if isinstance(card.get("reasoning"), dict) else {}
            declared = [e for e in (rec.get("efforts") or []) if e in CODEX_LEVELS]
            levels = declared or list(CODEX_LEVELS)
            default = rec.get("default_effort")
            item["supported_reasoning_levels"] = [
                {"effort": e, "description": CODEX_LEVEL_DESC[e]} for e in levels
            ]
            item["default_reasoning_level"] = (
                default if default in levels else ("medium" if "medium" in levels else levels[0])
            )
            item["supports_reasoning_effort_updates"] = True
        models.append(item)
    return {"models": models}


# ------------------------------------------------------------------- registry
def shapes(cards: list[dict], api_base: str = "") -> dict[str, dict]:
    """路径 → 响应体。路由层直接照着挂，避免两边各写一遍 key 名。"""
    return {
        "/api/v1/models": openrouter_models(cards),
        "/model/info": litellm_model_info(cards, api_base),
        "/api/v0/models": lmstudio_models(cards),
        "/api/tags": ollama_tags(cards),
        "/v1/model_catalog": codex_catalog(cards),
    }
