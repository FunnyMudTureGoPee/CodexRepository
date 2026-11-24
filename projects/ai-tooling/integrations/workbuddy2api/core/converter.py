#!/usr/bin/env python3
"""
codebuddy2openai — 把 CodeBuddy / WorkBuddy 的订阅暴露成标准 OpenAI 兼容 API。

原理（直连后端，原生 function calling）：
  - 读取本机已登录的 CodeBuddy 桌面端凭据（auth 文件里的 token / uid / enterpriseId）。
  - 直接转发到 CodeBuddy 后端 `https://copilot.tencent.com/v2/chat/completions`。
    该后端本身就是标准 OpenAI chat/completions 协议（含原生 tools / tool_calls / SSE 流式）。
  - 转换器只做两件事：①注入鉴权 header（Authorization / X-User-Id 等）
    ②在本地 /v1/* 与后端 /v2/* 之间做路径映射与透传（含 Anthropic / Chat / Responses 三种协议）。
  - token 过期时自动调 `/v2/plugin/auth/token/refresh` 刷新，并回写 auth 文件。

跨平台：自动定位 auth 目录（macOS / Windows / Linux）。
依赖：fastapi + uvicorn + httpx（pip install fastapi "uvicorn[standard]" httpx）。

用法：
  python3 converter.py                       # 默认 127.0.0.1:8787
  python3 converter.py --port 9000
  python3 converter.py --api-key mysecret    # 启用客户端鉴权
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

try:
    from .desensitize import desensitize_body
except ImportError:  # 模块缺失时降级为不脱敏

    def desensitize_body(
        body,
        roles=("system",),
        desensitize_harness_user=False,
        desensitize_tools=False,
        compact_harness=False,
        strip_tool_metadata=False,
    ):
        return body


from .anthropic_adapter import (
    AnthropicStreamConverter,
    anthropic_request_to_chat,
)
from .responses_adapter import (
    ResponsesStreamConverter,
    responses_request_to_chat,
)
from .responses_projection import project_responses_chat_body
from . import model_catalog
from . import response_store

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

BACKEND = "https://copilot.tencent.com"
DEFAULT_DOMAIN = "www.codebuddy.cn"
USER_AGENT = "codebuddy2openai/2.0"

# ---------------------------------------------------------------------------
# 平台相关：定位 auth 目录
# ---------------------------------------------------------------------------


def auth_dirs() -> list[Path]:
    env_dir = os.environ.get("CODEBUDDY_AUTH_DIR")
    if env_dir:
        return [Path(env_dir)]
    home = Path.home()
    plat = sys.platform
    if plat == "darwin":
        return [
            home
            / "Library"
            / "Application Support"
            / "CodeBuddyExtension"
            / "Data"
            / "Public"
            / "auth"
        ]
    if plat == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return [local / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    xdg = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return [xdg / "CodeBuddyExtension" / "Data" / "Public" / "auth"]


def find_auth_file() -> Path | None:
    for d in auth_dirs():
        if d.is_dir():
            for f in sorted(d.glob("*.info")):
                return f
    return None


# ---------------------------------------------------------------------------
# Auth 凭据管理（读 + 自动刷新 + 回写）
# ---------------------------------------------------------------------------


class CredentialManager:
    """从 auth 文件读取凭据；token 临近过期时自动刷新并回写。"""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._cached: dict | None = None
        self._mtime: float = 0.0

    def _read_raw(self) -> dict:
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def _load_if_stale(self):
        """若文件 mtime 变了（外部刷新过），重新加载缓存。"""
        try:
            mt = self.path.stat().st_mtime
        except OSError:
            return
        if self._cached is None or mt != self._mtime:
            self._cached = self._read_raw()
            self._mtime = mt

    def _session(self) -> dict:
        self._load_if_stale()
        if self._cached is None:
            raise RuntimeError(f"无法读取 auth 文件：{self.path}")
        return self._cached

    def _is_expired(self) -> bool:
        s = self._session()
        expires_at = (s.get("auth") or {}).get("expiresAt") or 0
        # 提前 60s 判定过期
        return time.time() * 1000 >= (expires_at - 60_000)

    def _refresh(self):
        """调后端刷新 token，写回 auth 文件与缓存。"""
        s = self._session()
        auth = s.get("auth") or {}
        headers = self._build_headers_from(auth, s.get("account") or {})
        headers["X-Refresh-Token"] = auth.get("refreshToken", "")
        headers["X-Auth-Refresh-Source"] = "plugin"
        url = f"{BACKEND}/v2/plugin/auth/token/refresh"
        try:
            with httpx.Client(timeout=15) as c:
                r = c.post(url, headers=headers, json={})
            data = r.json()
        except Exception as e:
            raise RuntimeError(f"刷新 token 网络失败：{e}")
        if data.get("code") != 0 or not data.get("data"):
            raise RuntimeError(f"刷新 token 失败：{data.get('msg', data)}")
        new_auth = data["data"]
        if not isinstance(new_auth, dict) or not new_auth.get("accessToken"):
            raise RuntimeError("刷新响应缺少访问令牌")
        new_auth["refreshToken"] = new_auth.get("refreshToken") or auth.get("refreshToken", "")
        # 继承部分字段
        new_auth["domain"] = new_auth.get("domain") or auth.get("domain")
        new_auth["lastRefreshTime"] = int(time.time() * 1000)
        # 计算 expiresAt（若后端没直接给）
        if not new_auth.get("expiresAt") and new_auth.get("expiresIn"):
            new_auth["expiresAt"] = (
                int(time.time() * 1000) + new_auth["expiresIn"] * 1000
            )
        if not new_auth.get("refreshExpiresAt") and new_auth.get("refreshExpiresIn"):
            new_auth["refreshExpiresAt"] = (
                int(time.time() * 1000) + new_auth["refreshExpiresIn"] * 1000
            )
        s["auth"] = new_auth
        # 原子写回
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
        self._cached = s
        self._mtime = self.path.stat().st_mtime

    def _build_headers_from(self, auth: dict, account: dict) -> dict:
        domain = auth.get("domain") or DEFAULT_DOMAIN
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {auth.get('accessToken', '')}",
            "X-User-Id": account.get("uid", ""),
            "X-Enterprise-Id": account.get("enterpriseId", ""),
            "X-Tenant-Id": account.get("enterpriseId", ""),
            "X-Domain": domain,
            "User-Agent": USER_AGENT,
        }
        return h

    def get_headers(self) -> dict:
        """返回带最新 token 的后端请求 header；必要时先刷新。"""
        with self._lock:
            if self._is_expired():
                self._refresh()
            s = self._session()
            return self._build_headers_from(s.get("auth") or {}, s.get("account") or {})

    def summary(self) -> dict:
        s = self._session()
        auth = s.get("auth") or {}
        acct = s.get("account") or {}
        exp = auth.get("expiresAt", 0)
        return {
            "uid": acct.get("uid"),
            "nickname": acct.get("nickname"),
            "enterpriseName": acct.get("enterpriseName"),
            "token_expires_at": exp,
            "token_expired": self._is_expired(),
        }


# ---------------------------------------------------------------------------
# 模型列表
# ---------------------------------------------------------------------------

DEFAULT_MODELS = [
    "hy3",
    "hy4-preview",
    "kimi-k3",
    "kimi-k2.8-preview",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5v-turbo",
    "kimi-k2.7",
    "kimi-k2.6",
    "kimi-k2.5",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash",
    "minimax-m3-pay",
    "hy3-preview-agent",
    "auto",
]

# 标识非聊天模型的 tag（需要过滤掉）
NON_CHAT_MODEL_TAGS = {
    "text-to-image",
    "image-to-image",
    "text-to-video",
}


def _find_workbuddy_product_json() -> Path | None:
    """
    查找本机 WorkBuddy 应用的 product.json 配置文件。

    WorkBuddy 在安装时会自动解压 asar 到 app.asar.unpacked 目录，
    因此无需用户手动提取。

    macOS: /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json
    Windows: %LOCALAPPDATA%\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\product.json
    Linux: /opt/WorkBuddy/resources/app.asar.unpacked/cli/product.json

    Returns:
        Path 对象如果找到配置文件，否则 None
    """
    possible_paths = []

    if sys.platform == "darwin":  # macOS
        possible_paths.extend(
            [
                # 标准安装路径（WorkBuddy 自动解压）
                Path(
                    "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json"
                ),
                # 开发/调试：本地提取的目录
                Path.home()
                / "Desktop/workspace/opensource/codebuddy2api/workbuddy_extracted/cli/product.json",
            ]
        )
    elif sys.platform == "win32":  # Windows
        local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
        possible_paths.extend(
            [
                local_app_data
                / "Programs/WorkBuddy/resources/app.asar.unpacked/cli/product.json",
                Path(
                    "C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/product.json"
                ),
            ]
        )
    else:  # Linux
        possible_paths.extend(
            [
                Path("/opt/WorkBuddy/resources/app.asar.unpacked/cli/product.json"),
                Path.home() / ".local/share/WorkBuddy/cli/product.json",
            ]
        )

    for path in possible_paths:
        if path.exists() and path.is_file():
            return path

    return None


def _product_config_paths() -> list[Path]:
    """模型元数据源，按「旧 → 新」排：后者覆盖同 id，并补上新上线的模型。

    两份来源：
    1. 安装目录里随包解压的 ``cli/product.json`` —— 静态快照，只在 WorkBuddy
       安装/升级时变。
    2. ``~/.workbuddy/cache/acc-product-config-v3*.json`` —— 服务端下发、
       WorkBuddy 每次启动刷新。**新模型上线只反映在这里**：例如
       ``kimi-k3.1-pro`` 在服务端可用（直连 200），但 10-27 的安装包快照里
       根本没有。取 mtime 最新的一份。

    两条路都没有时返回空列表，所有加载函数静默降级，与以前行为一致。
    """
    paths: list[Path] = []
    static = _find_workbuddy_product_json()
    if static is not None:
        paths.append(static)

    cache_dir = Path.home() / ".workbuddy" / "cache"
    if cache_dir.is_dir():
        best: tuple[float, Path] | None = None
        for p in cache_dir.glob("acc-product-config-v3*.json"):
            try:
                mt = p.stat().st_mtime
            except OSError:
                continue
            if best is None or mt > best[0]:
                best = (mt, p)
        if best is not None and best[1] not in paths:
            paths.append(best[1])
    return paths


def _catalog_signature() -> str:
    """所有配置文件的 path+mtime 签名：WorkBuddy 刷新了动态配置就让缓存失效。"""
    parts: list[str] = []
    for p in _product_config_paths():
        try:
            parts.append(f"{p}:{p.stat().st_mtime_ns}")
        except OSError:
            parts.append(f"{p}:?")
    return "|".join(parts)


def _iter_product_models():
    """按旧 → 新遍历配置里的模型条目（同 id 后面的覆盖前面的）。

    单份文件损坏/半写入只跳过它，静态快照仍在，不会让整个目录消失。
    """
    for p in _product_config_paths():
        try:
            with open(p, encoding="utf-8") as f:
                models = json.load(f).get("models") or []
        except Exception as e:  # noqa: BLE001
            print(f"Warning: 无法读取模型配置 {p}: {e}", file=sys.stderr)
            continue
        for m in models:
            if isinstance(m, dict):
                yield m


def _load_models_from_workbuddy() -> list[str]:
    """
    从本机 WorkBuddy product.json 读取模型列表。

    过滤规则：
    1. 只保留聊天模型（排除 text-to-image, text-to-video 等）
    2. 排除 vendor 为 "tencent" 的内部模型（通常是补全/内部专用）
    3. 返回模型 ID 列表

    Returns:
        模型 ID 列表，如果加载失败返回空列表
    """
    try:
        chat_models: list[str] = []
        seen: set[str] = set()

        # 静态快照 + 服务端动态缓存合并（见 _product_config_paths）
        for model in _iter_product_models():
            model_id = model.get("id")
            if not model_id or model_id in seen:
                continue

            # 过滤掉非聊天模型
            tags = model.get("tags", []) or []
            if any(tag in NON_CHAT_MODEL_TAGS for tag in tags):
                continue

            # 过滤掉内部模型（vendor 为 tencent 的通常是补全/跳转等内部功能）
            vendor = model.get("vendor", "")
            if vendor == "tencent":
                continue

            # 过滤掉名称中明显是补全/内部功能的模型
            name_lower = model_id.lower()
            if any(
                keyword in name_lower
                for keyword in ["completion", "rewrite", "jump", "codewise"]
            ):
                continue

            # 聊天模型一定有输入窗口，或者至少能调工具。
            # 两者都不满足的多半是图生视频/图生图这类生成模型 —— 它们的 tags
            # 不一定带 NON_CHAT_MODEL_TAGS（例如 kling-v3-i2v 就没有 tag），
            # 只靠标签会漏过去，然后以"没有 context_length 的模型"出现在 /v1/models 里。
            has_window = isinstance(model.get("maxInputTokens"), int) and model["maxInputTokens"] > 0
            if not has_window and not model.get("supportsToolCall"):
                continue

            seen.add(model_id)
            chat_models.append(model_id)

        return chat_models

    except Exception as e:
        # 解析失败时静默降级，不影响服务启动
        print(
            f"Warning: Failed to load models from WorkBuddy product.json: {e}",
            file=sys.stderr,
        )
        return []


_MODEL_INPUT_TOKENS_CACHE: tuple[str, dict[str, int]] | None = None


def _load_model_input_tokens() -> dict[str, int]:
    """从模型配置读每个模型的真实输入窗口（maxInputTokens）。

    投影层据此推导分段预算倍率 —— 否则 glm-5.2 的 1,000,000 token 窗口会被
    当成 32K 用（各段预算被压到基准值）。读不到就返回空表，投影层退回基准值。
    """
    global _MODEL_INPUT_TOKENS_CACHE
    sig = _catalog_signature()
    if _MODEL_INPUT_TOKENS_CACHE is not None and _MODEL_INPUT_TOKENS_CACHE[0] == sig:
        return _MODEL_INPUT_TOKENS_CACHE[1]

    mapping: dict[str, int] = {}
    for model in _iter_product_models():
        model_id = model.get("id")
        tokens = model.get("maxInputTokens")
        if model_id and isinstance(tokens, int) and tokens > 0:
            mapping[model_id] = tokens

    _MODEL_INPUT_TOKENS_CACHE = (sig, mapping)
    return mapping


def _model_input_tokens(model_id: str | None) -> int | None:
    """模型的输入窗口（token）。未知模型返回 None，投影层会退回基准预算。"""
    if not model_id:
        return None
    return _load_model_input_tokens().get(model_id)


# ---------------------------------------------------------------------------
# 模型卡（/v1/models 的元数据）
# ---------------------------------------------------------------------------
# 只返回 id/object/created/owned_by 时，harness 拿不到窗口和推理能力：
#   · 有的客户端按保守默认值（常见 4k/8k）压缩历史，长上下文直接被它自己截掉；
#   · 有的让用户手填 maxInputTokens，填错就报超限；
#   · 推理等级无处可查，客户端只能猜或干脆不发 → 上游按默认处理。
# 所以这里把 product.json 里的真实值按几套常见命名同时给出去
# （OpenRouter 的 context_length / top_provider、LiteLLM 的 max_input_tokens、
#   vLLM 的 max_model_len），多余字段客户端会忽略。

# 上游实测：none 会真正关掉思考（reasoning_tokens=0）；
# minimal/low/medium/high/xhigh 均被接受；其他值 deepseek 会 400。
REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

# 档位变体：把「思考档」编码进 model id（OpenRouter 系惯用的 `model:variant`）。
# 有些客户端（典型是 dsh 的「获取可用模型」）只能从 /models 读到
# id/name/context_window/max_tokens 四个字段，推理档位在发现类型里根本不存在。
# 给每个推理模型额外发若干「档位变体」条目，客户端选中变体就等于选中该档；
# 转换器在请求入口把 id 拆回「真模型 + reasoning_effort」。
EFFORT_SEP = ":"
VARIANT_ENV = "WB_EFFORT_VARIANTS"
VARIANT_PATH_PREFIX = "/v1/effort/"

# 无元数据时的能力声明（保守，不虚构窗口）
BASE_SUPPORTED_PARAMETERS = [
    "tools",
    "tool_choice",
    "temperature",
    "top_p",
    "stop",
    "max_tokens",
    "seed",
    "response_format",
]

_MODEL_CATALOG_CACHE: tuple[str, dict[str, dict]] | None = None


def _load_model_catalog() -> dict[str, dict]:
    """静态快照 + 服务端动态配置 → {model_id: 归一化元数据}。读不到返回空表。

    按 _iter_product_models() 的顺序遍历，后读的（更新的）配置覆盖同 id。
    """
    global _MODEL_CATALOG_CACHE
    sig = _catalog_signature()
    if _MODEL_CATALOG_CACHE is not None and _MODEL_CATALOG_CACHE[0] == sig:
        return _MODEL_CATALOG_CACHE[1]

    catalog: dict[str, dict] = {}
    for model in _iter_product_models():
        model_id = model.get("id")
        if not model_id:
            continue
        reasoning = model.get("reasoning")
        if not isinstance(reasoning, dict):
            reasoning = {}
        catalog[model_id] = {
            "name": model.get("name") or model_id,
            "description": (
                model.get("descriptionZh")
                or model.get("descriptionEn")
                or model.get("summary")
                or ""
            ),
            "input_tokens": model.get("maxInputTokens"),
            "output_tokens": model.get("maxOutputTokens"),
            "tool_calling": bool(model.get("supportsToolCall")),
            # supportsImages 只是产品声明，disabledMultimodal 才是「明确关掉」。
            # 实测：hunyuan-2.0-thinking 两者同时为 true，但主色判别里它明确答
            # "I cannot view the image" → 必须判成非视觉，否则客户端会把图片
            # 发给一个看不见的模型。与 sync-vscode-wbcli.py 的口径保持一致。
            "vision": bool(model.get("supportsImages"))
            and not bool(model.get("disabledMultimodal")),
            "reasoning": bool(model.get("supportsReasoning")),
            "reasoning_only": bool(model.get("onlyReasoning")),
            # canDisableThinking 有两处：模型级（kimi-k2.8-preview）与
            # reasoning 对象内（glm-5.3-flash / hy4-preview）。都要看。
            "can_disable_reasoning": bool(
                reasoning.get(
                    "canDisableThinking", model.get("canDisableThinking")
                )
            ),
            # 两种写法：支持集合 supportedEfforts（真·枚举），
            # 或只有单个 effort（默认档，未枚举）。前者才是我能断言的档位。
            "declared_efforts": [
                str(x)
                for x in (reasoning.get("supportedEfforts") or [])
                if isinstance(x, str)
            ],
            "default_effort": reasoning.get("defaultEffort")
            or reasoning.get("effort"),
            "default_summary": reasoning.get("summary"),
        }

    _MODEL_CATALOG_CACHE = (sig, catalog)
    return catalog


def _reasoning_efforts(meta: dict) -> list[str]:
    """一个推理模型**真实可用**的 effort 列表（wire 拼写：none/low/high/max…）。

    依据 product.json，按可信度递减取值：

    1. ``reasoning.supportedEfforts`` —— 官方显式枚举，照抄。
       例：``glm-5.3-flash`` → ``["low","high","max"]``；``hy4-preview`` → ``["high"]``。
    2. 只有 ``reasoning.effort`` / ``defaultEffort`` —— 官方只说"默认发这一档"，
       **没有枚举**。"默认"不等于"只支持"，所以这里给通用阶梯，
       并把默认档放在 ``default_effort`` 里让客户端自己选。
    3. 两者都没有 —— 同样给通用阶梯（能力未知）。

    ``canDisableThinking`` 为真时在最前面补 ``none``（= 关掉思考）；
    为假说明思考不可关（多数 ``onlyReasoning`` 模型），从列表里剔除 ``none``，
    这样客户端不会给出一个一定会被后端拒绝的选项。
    """
    declared = [str(x) for x in (meta.get("declared_efforts") or []) if isinstance(x, str)]
    efforts = list(dict.fromkeys(declared)) if declared else list(REASONING_EFFORTS)
    if meta.get("can_disable_reasoning"):
        if "none" not in efforts:
            efforts = ["none"] + efforts
    else:
        efforts = [x for x in efforts if x != "none"]
    order = {name: i for i, name in enumerate(REASONING_EFFORTS)}
    return sorted(efforts, key=lambda x: order.get(x, len(order)))


def model_card(model_id: str) -> dict:
    """单个模型的对外描述。字段按多套惯用命名并给，客户端各取所需。"""
    base, effort = split_effort_variant(model_id)
    if effort is not None:
        # 档位变体：复用基础模型卡，只把 id/name/档位换成这一档的。
        card = dict(model_card(base))
        card["id"] = model_id
        card["name"] = f"{card.get('name') or base} [{effort}]"
        card["base_model"] = base
        card["effort"] = effort
        card["is_effort_variant"] = True
        r = dict(card.get("reasoning") or {})
        r.update({"supported": True, "efforts": [effort], "default_effort": effort})
        card["reasoning"] = r
        # 档位已由 id 决定，别再让客户端以为还要另发参数。
        card["supported_parameters"] = [
            p for p in card.get("supported_parameters", []) if p != "reasoning_effort"
        ]
        return card
    meta = _load_model_catalog().get(model_id) or {}
    ctx = meta.get("input_tokens")
    out_tokens = meta.get("output_tokens")
    reasoning = bool(meta.get("reasoning"))

    card: dict = {
        "id": model_id,
        "object": "model",
        "created": 1700000000,
        "owned_by": "codebuddy",
        "name": meta.get("name") or model_id,
    }
    if meta.get("description"):
        card["description"] = meta["description"]

    top_provider: dict = {}
    if isinstance(ctx, int) and ctx > 0:
        # OpenRouter 系 / 多数客户端的通用字段
        card["context_length"] = ctx
        # 少数客户端用这两个名字
        card["context_window"] = ctx
        card["max_input_tokens"] = ctx
        # vLLM 风格
        card["max_model_len"] = ctx
        top_provider["context_length"] = ctx
    if isinstance(out_tokens, int) and out_tokens > 0:
        card["max_output_tokens"] = out_tokens
        card["max_completion_tokens"] = out_tokens
        top_provider["max_completion_tokens"] = out_tokens
    if top_provider:
        card["top_provider"] = top_provider

    if meta:
        inputs = ["text"]
        if meta.get("vision"):
            inputs.append("image")
        card["architecture"] = {
            "input_modalities": inputs,
            "output_modalities": ["text"],
        }
        card["capabilities"] = {
            "tool_calling": meta.get("tool_calling", False),
            "vision": meta.get("vision", False),
            "reasoning": reasoning,
            "reasoning_only": meta.get("reasoning_only", False),
            "can_disable_reasoning": meta.get("can_disable_reasoning", False),
        }
        params = list(BASE_SUPPORTED_PARAMETERS)
        if reasoning:
            params.append("reasoning_effort")
        card["supported_parameters"] = params
        if reasoning:
            card["reasoning"] = {
                "supported": True,
                # efforts：这次真的按 product.json 来。
                # 声明了 supportedEfforts 就照抄（真·枚举）；
                # 没声明就只有默认档一档 —— 不把"上游大概也收"当成官方能力。
                "efforts": _reasoning_efforts(meta),
                "declared_efforts": list(meta.get("declared_efforts") or []),
                "default_effort": meta.get("default_effort"),
                "summary": meta.get("default_summary"),
                "reasoning_only": meta.get("reasoning_only", False),
                "can_disable": bool(meta.get("can_disable_reasoning")),
            }
    else:
        card["supported_parameters"] = list(BASE_SUPPORTED_PARAMETERS)
    return card


def effort_variants_enabled() -> bool:
    """是否让默认的 /v1/models 带上档位变体（默认关，避免污染其它客户端）。"""
    return os.environ.get(VARIANT_ENV, "0").strip().lower() in ("1", "true", "yes", "on")


def split_effort_variant(model_id: str) -> tuple[str, str | None]:
    """'glm-5.3-flash:high' → ('glm-5.3-flash', 'high')；不是合法变体则原样返回。

    必须同时满足：基础模型在 product.json 里、是推理模型、档位在它自己的
    efforts 列表里。这样带冒号的第三方模型 id 不会被误拆。
    """
    if not isinstance(model_id, str) or EFFORT_SEP not in model_id:
        return model_id, None
    base, _, effort = model_id.rpartition(EFFORT_SEP)
    if not base or effort not in REASONING_EFFORTS:
        return model_id, None
    meta = _load_model_catalog().get(base) or {}
    if not meta.get("reasoning") or effort not in _reasoning_efforts(meta):
        return model_id, None
    return base, effort


def effort_variant_ids() -> list[str]:
    """按每个模型自己真实的 efforts 生成变体 id。"""
    out: list[str] = []
    for model_id, meta in _load_model_catalog().items():
        if not meta.get("reasoning") or model_id in ("default", "auto"):
            continue
        for effort in _reasoning_efforts(meta):
            out.append(f"{model_id}{EFFORT_SEP}{effort}")
    return out


def apply_effort_variant(payload: dict) -> tuple[dict, str | None]:
    """把变体 model 拆成「真模型 + reasoning_effort」，返回 (新 payload, 原变体 id)。

    客户端若已显式给了 effort（标量 / reasoning 对象 / thinking / enable_thinking），
    以显式值为准，只把 model 换回真名。
    """
    raw = payload.get("model")
    base, effort = split_effort_variant(raw)
    if effort is None:
        return payload, None
    out = dict(payload)
    out["model"] = base
    has_explicit = (
        "reasoning_effort" in payload
        or (
            isinstance(payload.get("reasoning"), dict)
            and bool(payload["reasoning"].get("effort"))
        )
        or "thinking" in payload
        or "enable_thinking" in payload
    )
    if not has_explicit:
        out["reasoning_effort"] = effort
    return out, raw


def get_available_models(include_variants: bool = False) -> list[str]:
    """
    获取可用的模型列表。

    优先从 WorkBuddy product.json 读取，如果失败则使用 DEFAULT_MODELS。
    include_variants=True 时追加「档位变体」条目（见 EFFORT_SEP 的说明）。
    """
    base = _load_models_from_workbuddy() or DEFAULT_MODELS
    if not include_variants:
        return base
    seen = set(base)
    return base + [v for v in effort_variant_ids() if v not in seen]


# 后端请求体里出现过的额外字段（透传时若客户端给了就保留）
PASSTHROUGH_BODY_KEYS = {
    "model",
    "messages",
    "tools",
    "tool_choice",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "top_p",
    "stream",
    "stream_options",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "n",
    "response_format",
    "seed",
    "user",
    "reasoning_effort",
    "verbosity",
    "reasoning_summary",
}

# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

app = FastAPI(title="codebuddy2openai", version="2.0")


# ---------------------------------------------------------------------------
# 鉴权失败的响应形状
# ---------------------------------------------------------------------------
# VS Code Copilot 处理 4xx 时是这么取文案的（copilot 扩展 _handleError）：
#     let c = JSON.parse(body); c = c?.error ?? c;
#     reason = c?.message || `token expired or invalid: ${status}`;
# FastAPI 默认把 detail 包成 {"detail": ...}，顶层既没有 error 也没有 message，
# 所以 401 永远显示成没头没脑的「token expired or invalid: 401」，看不出原因。
# 这里只把 401/403 改写成 {"error": {"message": ...}}，其它状态码维持 FastAPI 原样。
@app.exception_handler(HTTPException)
async def _auth_error_shape(request: Request, exc: HTTPException):
    if exc.status_code in (401, 403):
        detail = exc.detail
        if isinstance(detail, dict):
            inner = detail.get("error")
            message = (inner or {}).get("message") if isinstance(inner, dict) else None
            message = message or detail.get("message") or str(detail)
        else:
            message = str(detail)
        return JSONResponse(
            {"error": {"message": message, "type": "auth_error", "code": exc.status_code}},
            status_code=exc.status_code,
        )
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


CONFIG: dict = {
    "api_key": "",
    "cred": None,
    "log_path": None,
    "desensitize": False,
    "no_compact": False,
}  # cred: CredentialManager | None


# ---------------------------------------------------------------------------
# 日志（写文件）
# ---------------------------------------------------------------------------

_LOG_LOCK = threading.Lock()


def _log(msg: str):
    """写一行日志到 CONFIG['log_path'] 指定的文件（追加，带时间戳）。未设置则丢弃。"""
    path = CONFIG.get("log_path")
    if not path:
        return
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
    try:
        with _LOG_LOCK, open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass  # 日志失败不应影响主流程


def _truncate(s: str, n: int = 80) -> str:
    s = str(s).replace("\n", " ").strip()
    return s[:n] + ("…" if len(s) > n else "")


def _upstream_error_text(raw: bytes, limit: int = 500) -> str:
    """把上游错误响应体压成一句人能看懂的话。

    上游（腾讯后端）失败时有几种形状，都要能认出来：
      流式透传的原样 body : {"code":11102,"msg":"model [x] service info not found", ...}
      FastAPI 包装过的    : {"detail": {"code":11102, "msg": "...", ...}}

    为什么要抽出来放到 message 顶层：VS Code Copilot 取错误文案时只读
    顶层 `message`（见 copilot 扩展的 fxt()），拿不到就退化成
    「The model provider reported a failed response without any error details」，
    排查时完全看不出原因。
    """
    text = raw.decode("utf-8", "replace")
    try:
        j = json.loads(text)
    except Exception:
        return text[:limit]
    if not isinstance(j, dict):
        return text[:limit]

    candidates = [j]
    if isinstance(j.get("detail"), dict):
        candidates.insert(0, j["detail"])

    for obj in candidates:
        msg = obj.get("msg") or obj.get("message")
        if msg:
            code = obj.get("code")
            return f"[{code}] {msg}" if code is not None else str(msg)

    d = j.get("detail")
    if isinstance(d, str) and d:
        return d[:limit]
    e = j.get("error")
    if isinstance(e, dict) and e.get("message"):
        return str(e["message"])[:limit]
    if isinstance(e, str) and e:
        return e[:limit]
    return text[:limit]


def _check_auth(authorization: str | None, x_api_key: str | None):
    key = CONFIG["api_key"]
    if not key:
        return
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    if not token and x_api_key:
        token = x_api_key
    if token != key:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "invalid api key", "type": "auth_error"}},
        )


def _cred() -> CredentialManager:
    # The management deployment binds one credential to each ASGI request.
    # Standalone converter usage keeps the original single-account behavior.
    try:
        from admin.pool import REQUEST_CREDENTIAL
        selected = REQUEST_CREDENTIAL.get()
        if selected is not None:
            return selected
    except ImportError:
        pass
    if CONFIG["cred"] is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "message": "未找到登录凭据，请先在桌面端登录 CodeBuddy/WorkBuddy",
                    "type": "auth_error",
                }
            },
        )
    return CONFIG["cred"]


@app.get("/health")
def health():
    cred = CONFIG["cred"]
    info: dict = {
        "status": "ok",
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "auth_file": str(find_auth_file() or "(未找到)"),
        "mode": "direct-proxy (native function calling)",
    }
    if cred is not None:
        try:
            info["credential"] = cred.summary()
        except Exception as e:
            info["credential_error"] = str(e)
    return info


@app.get("/v1/models")
@app.get("/v1/effort/models")
def list_models(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """dsh 等只认 4 字段的客户端：把 baseURL 指到 /v1/effort 就能拿到档位变体。

    /v1/effort/* 永远带变体；普通 /v1/models 只在 WB_EFFORT_VARIANTS=1 时带，
    这样 Codex / VS Code 的默认模型列表不会被 180+ 个变体淹没。
    """
    _check_auth(authorization, x_api_key)
    include = effort_variants_enabled() or request.url.path.startswith(VARIANT_PATH_PREFIX)
    return {"object": "list", "data": [model_card(m) for m in get_available_models(include)]}


@app.get("/v1/models/{model_id}")
@app.get("/v1/effort/models/{model_id}")
def get_model(
    model_id: str,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """单个模型的详情。部分客户端先拉列表、再逐个取详情。"""
    _check_auth(authorization, x_api_key)
    if model_id not in get_available_models(include_variants=True):
        raise HTTPException(
            status_code=404,
            detail={"error": {"message": f"model not found: {model_id}", "type": "invalid_request_error"}},
        )
    return model_card(model_id)


# ── 模型目录的其它形状 ──────────────────────────────────────────────────
# 各家 harness 读模型能力的入口不一样，多数不认 /v1/models 的扩展字段。
# 同一份元数据按几种主流形状再吐一遍，见 core/model_catalog.py 的说明。
def _cards() -> list[dict]:
    return [model_card(m) for m in get_available_models(effort_variants_enabled())]


def _catalog_cards() -> list[dict]:
    """给「客户端挑模型」用的目录：剔除 default/auto 这类伪模型。"""
    return model_catalog.usable(_cards())


def _api_base(request: Request) -> str:
    """LiteLLM 那边要填 api_base，用请求方看到的主机名，避免写死回环。"""
    return str(request.base_url).rstrip("/")


@app.get("/api/v1/models")
def models_openrouter(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """OpenRouter 形状。"""
    _check_auth(authorization, x_api_key)
    return model_catalog.openrouter_models(_catalog_cards())


@app.get("/model/info")
def models_litellm(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """LiteLLM Proxy 形状。"""
    _check_auth(authorization, x_api_key)
    return model_catalog.litellm_model_info(_catalog_cards(), _api_base(request))


@app.get("/api/v0/models")
def models_lmstudio(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """LM Studio 形状。"""
    _check_auth(authorization, x_api_key)
    return model_catalog.lmstudio_models(_catalog_cards())


@app.get("/api/tags")
def models_ollama(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """Ollama 形状。"""
    _check_auth(authorization, x_api_key)
    return model_catalog.ollama_tags(_catalog_cards())


@app.get("/v1/model_catalog")
def models_codex(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """Codex CLI 形状（供 model_catalog_url 使用）。"""
    _check_auth(authorization, x_api_key)
    return model_catalog.codex_catalog(_catalog_cards())


@app.post("/v1/chat/completions")
@app.post("/v1/effort/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    _check_auth(authorization, x_api_key)
    cred = _cred()

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {"message": f"bad json: {e}", "type": "invalid_request_error"}
            },
        )

    payload, variant = apply_effort_variant(payload)
    if variant:
        _log(f"⚙ 档位变体 {variant} → model={payload['model']}"
             f" effort={payload.get('reasoning_effort')}")

    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": "messages is required",
                    "type": "invalid_request_error",
                }
            },
        )

    # 构造后端 body：只透传已知的合法字段
    client_wants_stream = bool(payload.get("stream"))
    body = {k: payload[k] for k in PASSTHROUGH_BODY_KEYS if k in payload}
    body.setdefault("model", "auto")
    # 后端只支持流式：始终以 stream=True 调后端，非流式由转换器聚合
    body["stream"] = True
    if "stream_options" not in body:
        body["stream_options"] = {"include_usage": True}

    # ---- 输出上限归一化 ----
    # 上游**只认 max_tokens**。实测（直连上游同一提示）：
    #   max_tokens=16            → completion=16，被截断 ✓
    #   max_completion_tokens=16 → completion=119，完全忽略 ✗
    #   max_output_tokens=16     → completion=119，完全忽略 ✗
    # 新版 OpenAI SDK 默认发 max_completion_tokens，OpenRouter 系客户端习惯发
    # max_output_tokens —— 原样透传等于没设上限。这里统一收敛到 max_tokens，
    # 多个值同时出现时取最小（更接近调用方意图）。
    limits = []
    for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            limits.append(value)
    body.pop("max_completion_tokens", None)
    body.pop("max_output_tokens", None)
    if limits:
        body["max_tokens"] = min(limits)

    # ---- 推理强度归一化 ----
    # chat 接口也可能收到对象形式（OpenRouter / 部分客户端），而上游只认标量
    # reasoning_effort。原样透传会让对象被上游忽略（实测 reasoning_tokens=0）。
    if "reasoning_effort" not in body:
        reasoning = payload.get("reasoning")
        if isinstance(reasoning, dict):
            if reasoning.get("effort"):
                body["reasoning_effort"] = reasoning["effort"]
            if reasoning.get("summary") and "reasoning_summary" not in body:
                body["reasoning_summary"] = reasoning["summary"]
        elif isinstance(reasoning, str) and reasoning:
            body["reasoning_effort"] = reasoning

    # ---- thinking 对象 ----
    # DeepSeek 官方 SDK / 其 VS Code 扩展（vizards.deepseek-v4-for-copilot）用的是
    #   {"thinking": {"type": "enabled" | "disabled"}}
    # 且「关闭思考」时**不再发 reasoning_effort**。上游不认 thinking 对象
    # （实测直连：带 thinking 但无 effort 时 reasoning_tokens=0），
    # 所以这里翻译成 effort：disabled → none。anthropic 风格的 budget_tokens 顺带折档。
    if "reasoning_effort" not in body:
        thinking = payload.get("thinking")
        if isinstance(thinking, dict):
            ttype = thinking.get("type")
            if ttype == "disabled":
                body["reasoning_effort"] = "none"
            elif ttype == "enabled":
                budget = thinking.get("budget_tokens")
                if isinstance(budget, int) and budget > 0:
                    body["reasoning_effort"] = (
                        "high" if budget >= 16000 else "medium" if budget >= 4000 else "low"
                    )
        elif thinking is False:
            body["reasoning_effort"] = "none"
        elif payload.get("enable_thinking") is False:
            body["reasoning_effort"] = "none"

    # 腾讯后端不支持 developer role，遇到会触发安全策略拦截（11128），统一映射为 system
    if "messages" in body and isinstance(body["messages"], list):
        body["messages"] = [
            dict(m, role="system")
            if isinstance(m, dict) and m.get("role") == "developer"
            else m
            for m in body["messages"]
        ]

    # 可选：脱敏。缓解客户端合规模板（如 Codex CLI / ZCode 注入的说明文字）被后端误判为敏感词。
    # 处理 system / developer 消息、Codex 注入的上下文 user 消息，以及 tools 的 description。
    if CONFIG.get("desensitize"):
        body = desensitize_body(
            body,
            roles=("system", "developer"),
            desensitize_harness_user=True,
            desensitize_tools=True,
            compact_harness=not CONFIG.get("no_compact"),
            strip_tool_metadata=True,
        )

    # 日志：请求摘要
    model_name = payload.get("model", "auto")
    tool_names = [
        t.get("function", {}).get("name")
        for t in (payload.get("tools") or [])
        if isinstance(t, dict)
    ]
    last_user = _last_user_text(messages)
    rid = os.urandom(4).hex()
    _log(
        f"[{rid}] ▶ REQUEST {model_name} | stream={client_wants_stream} | msgs={len(messages)}"
        + (f" | tools={tool_names}" if tool_names else "")
        + (f" | last_user={_truncate(last_user, 60)!r}" if last_user else "")
    )
    # 完整请求体（发往后端的实际内容；若启用脱敏，这里已是脱敏后）
    _log(
        f"[{rid}] ── REQUEST BODY (发往后端) ──\n"
        f"{json.dumps(_strip_history_reasoning(body), ensure_ascii=False, indent=2)}"
    )

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    if client_wants_stream:
        return StreamingResponse(
            _stream_upstream(url, headers, body, model_name, t0, rid),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 非流式：后端只支持流式，这里把后端 SSE 聚合成单个 chat.completion 响应
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            r, err, status = await _open_upstream_stream(
                c, url, headers, body, model_name, rid, f"[{rid}] "
            )
            if r is None:
                _log(
                    f"[{rid}] ✗ HTTP {status} | {model_name} | {_truncate(err.decode('utf-8', 'replace'), 200)}"
                )
                _log(f"[{rid}] ── ERROR BODY ──\n{err.decode('utf-8', 'replace')}")
                raise HTTPException(
                    status_code=status,
                    detail=_safe_err_raw(err, status),
                )
            try:
                collected = await _collect_stream(r)
            finally:
                await r.aclose()
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        _log(f"[{rid}] ✗ 网络错误 | {model_name} | {e}")
        raise HTTPException(
            status_code=502,
            detail={
                "error": {"message": f"upstream error: {e}", "type": "upstream_error"}
            },
        )
    _log_finish(model_name, t0, collected, rid)
    return JSONResponse(content=collected)


def _last_user_text(messages: list) -> str:
    """取最后一条 user 消息的文本，用于日志预览。"""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "text":
                    return str(blk.get("text", ""))
            return ""
        return str(content)
    return ""


def _log_finish(model_name: str, t0: float, result: dict, rid: str = ""):
    """记录一次完成的请求：耗时 / finish_reason / usage / 工具调用 / 审核拦截 + 完整响应。"""
    elapsed = time.time() - t0
    prefix = f"[{rid}] " if rid else ""
    choice = (result.get("choices") or [{}])[0]
    finish = choice.get("finish_reason")
    msg = choice.get("message") or {}
    tcs = msg.get("tool_calls") or []
    usage = result.get("usage") or {}
    tag = ""
    if finish == "content-filter":
        tag = " ⚠️内容审核拦截"
    tc_names = [t.get("function", {}).get("name") for t in tcs]
    _log(
        f"{prefix}◀ RESPONSE {model_name} | {elapsed:.1f}s | finish={finish}{tag}"
        + (f" | tool_calls={tc_names}" if tc_names else "")
        + f" | tokens={usage.get('total_tokens', '?')}"
    )
    # 完整响应体
    _log(
        f"{prefix}── RESPONSE BODY ──\n{json.dumps(result, ensure_ascii=False, indent=2)}"
    )


async def _collect_stream(response: httpx.Response) -> dict:
    """消费后端的 OpenAI SSE 流，聚合成单个非流式 chat.completion 对象。

    合并所有 chunk 的 delta（content / reasoning_content / tool_calls），并取
    usage / finish_reason。上游 SSE 的 delta 里带 ``reasoning_content``，此前聚合时
    被丢掉，导致非流式客户端只能看到 usage 里的计数、拿不到思考正文。
    """
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    # tool_calls: index -> {id, name, arguments(分片拼接)}
    tool_calls: dict[int, dict] = {}
    model: str | None = None
    finish_reason: str | None = None
    usage: dict | None = None

    async for line in response.aiter_lines():
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        model = chunk.get("model") or model
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            if delta.get("content"):
                content_parts.append(delta["content"])
            # 上游用 reasoning_content（部分网关用 reasoning），两者都收。
            rc = delta.get("reasoning_content") or delta.get("reasoning")
            if isinstance(rc, str) and rc:
                reasoning_parts.append(rc)
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
                slot = tool_calls.setdefault(
                    idx, {"id": None, "name": None, "arguments": ""}
                )
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]

    tcs = None
    if tool_calls:
        tcs = [
            {
                "id": v["id"],
                "type": "function",
                "function": {"name": v["name"], "arguments": v["arguments"]},
            }
            for _, v in sorted(tool_calls.items())
        ]
        finish_reason = finish_reason or "tool_calls"

    message = {"role": "assistant", "content": "".join(content_parts) or None}
    if reasoning_parts:
        message["reasoning_content"] = "".join(reasoning_parts)
    if tcs:
        message["tool_calls"] = tcs
    return {
        "id": "chatcmpl-" + os.urandom(12).hex(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model or "unknown",
        "choices": [
            {"index": 0, "message": message, "finish_reason": finish_reason or "stop"}
        ],
        "usage": usage
        or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _safe_err_raw(raw: bytes, status: int) -> dict:
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {
            "error": {
                "message": raw.decode("utf-8", "replace")[:500],
                "type": "upstream_error",
                "code": status,
            }
        }


# 上游「渠道校验」拦截：code 11128
# "Illegal API invocation from an unapproved channel"。文案讲渠道，实测**检查的是
# system / developer 角色的内容**：同一段文本原样放进 user 角色就放行（2026-11-04 实测：
# system→11128 / user→200；developer 同样被拦；拆成多条 system 也照拦）。
# 与长度无关（6.9 KB 中性英文、5.9 KB 通用 agent 指令都 200），只与「这段 system 是不是
# 第三方 harness 的模板」有关 —— dsh 的 7,633 字系统提示每次必拦。
# 对 agent 是致命的（整轮失败），所以转发层做三级兜底：
#   ① 命中过的 system 指纹记住，下次直接先降级，省一次往返；
#   ② 首次 11128 → 把 system/developer 降级成 user 重发（**全文保留**，不删不摘要）；
#   ③ 再不行 → 原样重发一次，兜住 5xx / 网关抖动。
RETRYABLE_UPSTREAM_CODES = (11128,)
UPSTREAM_RETRY_DELAY = 0.5  # 秒；逐次线性递增

# 已确认「这段 system 会被拦」的指纹（sha1）→ 下次直接先降级。
_DEMOTE_CACHE: "OrderedDict[str, None]" = OrderedDict()
_DEMOTE_CACHE_MAX = 64


def _system_fingerprint(body: dict) -> str:
    """把请求里所有 system/developer 文本揉成一个指纹；没有则返回 ''。"""
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return ""
    parts: list[str] = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("system", "developer"):
            continue
        c = m.get("content")
        parts.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    if not parts:
        return ""
    return hashlib.sha1("\x00".join(parts).encode("utf-8", "replace")).hexdigest()


def _remember_demote(fp: str) -> None:
    if not fp:
        return
    _DEMOTE_CACHE[fp] = None
    _DEMOTE_CACHE.move_to_end(fp)
    while len(_DEMOTE_CACHE) > _DEMOTE_CACHE_MAX:
        _DEMOTE_CACHE.popitem(last=False)


def _system_to_user(body: dict) -> dict | None:
    """把 system/developer 消息降级成 user（上游只对这两个角色做渠道校验）。

    文本一字不改，只改 role；相邻 user 合并成一条，避免连续 user 触发别的校验。
    无法降级（没有 system）时返回 None。
    """
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    staged: list = []
    changed = False
    for m in msgs:
        if isinstance(m, dict) and m.get("role") in ("system", "developer"):
            nm = dict(m)
            nm["role"] = "user"
            staged.append(nm)
            changed = True
        else:
            staged.append(m)
    if not changed:
        return None
    merged: list = []
    for m in staged:
        prev = merged[-1] if merged else None
        if (
            isinstance(prev, dict)
            and isinstance(m, dict)
            and prev.get("role") == "user"
            and m.get("role") == "user"
            and isinstance(prev.get("content"), str)
            and isinstance(m.get("content"), str)
        ):
            merged[-1] = {**prev, "content": prev["content"] + "\n\n" + m["content"]}
            continue
        merged.append(m)
    nb = dict(body)
    nb["messages"] = merged
    return nb


def _is_retryable_upstream_error(status: int, err: bytes) -> bool:
    """判断上游错误是否值得原样重发（目前只有 11128）。"""
    if status >= 500:
        return True  # 网关秒断，重发通常能过
    if status != 400:
        return False
    text = err.decode("utf-8", "replace")
    return any(
        f'"code":{code}' in text or f'"code": {code}' in text
        for code in RETRYABLE_UPSTREAM_CODES
    )


def _strip_history_reasoning(body: dict) -> dict:
    """发往上游前，剥掉历史消息里的思考文本字段。

    响应侧我们把 ``reasoning_content`` 透出给客户端看，但**它不是对话内容**。
    常见写法 ``messages.append(resp.choices[0].message)`` 会把上一轮完整对象
    （含该字段）原样放回历史；chat 的 ``messages`` 又是整体透传的，于是思考
    文本会被发回上游、占上下文预算，甚至被某些后端当成正文。
    DeepSeek 官方也明确要求下一轮**不要**回传上一轮的 reasoning_content。
    这里统一清洗，只作用于入站历史，不影响出站响应里的思考。
    """
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return body
    cleaned: list = []
    changed = False
    for m in msgs:
        if isinstance(m, dict) and (m.get("reasoning_content") or m.get("reasoning")):
            nm = dict(m)
            nm.pop("reasoning_content", None)
            nm.pop("reasoning", None)
            cleaned.append(nm)
            changed = True
        else:
            cleaned.append(m)
    if not changed:
        return body
    out = dict(body)
    out["messages"] = cleaned
    return out


async def _open_upstream_stream(
    c: httpx.AsyncClient,
    url: str,
    headers: dict,
    body: dict,
    model_name: str,
    rid: str,
    prefix: str,
):
    """建立上游流式请求；对 11128「渠道校验」自动降级 system 角色后重试。

    返回 ``(response, None, None)`` 成功；``(None, err_bytes, status)`` 失败。
    """
    # 所有协议（chat / responses / messages）最终都从这里出网，在这里做最后一道
    # 入站清洗，保证历史里的思考文本绝不会被回灌给上游。
    body = _strip_history_reasoning(body)
    fp = _system_fingerprint(body)
    demoted = _system_to_user(body)

    plans: list[tuple[dict, str]] = []
    if demoted is None:
        plans = [(body, "原样"), (body, "原样重发")]
    elif fp and fp in _DEMOTE_CACHE:
        plans = [(demoted, "降级(已记忆)"), (body, "原样")]
    else:
        plans = [(body, "原样"), (demoted, "system→user 降级"), (body, "原样重发")]

    err = b""
    status = 0
    for i, (plan_body, note) in enumerate(plans):
        req = c.build_request("POST", url, headers=headers, json=plan_body)
        r = await c.send(req, stream=True)
        status = r.status_code
        if status == 200:
            if plan_body is not body:
                _remember_demote(fp)  # 证明降级有效，下次直接走降级
            if i or plan_body is not body:
                _log(f"{prefix}✓ 上游重试成功（{note}） | {model_name}")
            return r, None, None
        err = await r.aread()
        await r.aclose()
        if not _is_retryable_upstream_error(status, err) or i == len(plans) - 1:
            return None, err, status
        nxt = plans[i + 1][1]
        delay = UPSTREAM_RETRY_DELAY * (i + 1)
        _log(
            f"{prefix}↻ HTTP {status} 渠道校验拦截（11128），{delay:.1f}s 后改用「{nxt}」重试"
            f" | {model_name}"
        )
        await asyncio.sleep(delay)
    return None, err, status


async def _stream_upstream(
    url: str,
    headers: dict,
    body: dict,
    model_name: str = "?",
    t0: float = 0.0,
    rid: str = "",
):
    """把后端 SSE 原样转发给客户端（后端已是标准 OpenAI SSE，含 tool_calls）。

    同时轻量解析流，统计 finish_reason / tool_calls / usage 用于日志，不阻塞转发。
    完整原始 SSE 累积后落盘到日志（调试用）。
    """
    finish_reason = None
    tool_names: list[str] = []
    usage: dict = {}
    saw_filter = False
    buf = b""
    raw_parts: list[bytes] = []  # 累积完整原始 SSE
    prefix = f"[{rid}] " if rid else ""

    def _feed(chunk: bytes):
        nonlocal finish_reason, saw_filter, buf
        # 行缓冲解析：把累计的 chunk 按 data: 行切出来统计
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                continue
            try:
                obj = json.loads(data)
            except Exception:
                continue
            if obj.get("usage"):
                usage.update(obj["usage"])
            for ch in obj.get("choices") or []:
                if ch.get("finish_reason"):
                    finish_reason = ch["finish_reason"]
                for tc in (ch.get("delta") or {}).get("tool_calls") or []:
                    nm = (tc.get("function") or {}).get("name")
                    if nm:
                        tool_names.append(nm)
            # 内容审核拦截常以 content-filter 或特殊中文文案返回
            try:
                text_repr = data.decode("utf-8", "replace")
            except Exception:
                text_repr = ""
            if (
                "content-filter" in text_repr
                or "敏感" in text_repr
                or "审核" in text_repr
            ):
                saw_filter = True

    try:
        async with httpx.AsyncClient(timeout=None) as c:
            r, err, status = await _open_upstream_stream(
                c, url, headers, body, model_name, rid, prefix
            )
            if r is None:
                _log(
                    f"{prefix}✗ HTTP {status} | {model_name} | {_truncate(err.decode('utf-8', 'replace'), 200)}"
                )
                _log(f"{prefix}── ERROR BODY ──\n{err.decode('utf-8', 'replace')}")
                yield _err_event(err, status)
                return
            try:
                async for chunk in r.aiter_bytes():
                    if chunk:
                        raw_parts.append(chunk)
                        _feed(chunk)
                        yield chunk
            finally:
                await r.aclose()
    except httpx.HTTPError as e:
        _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
        yield _err_event(str(e).encode(), 502)

    # 流结束：输出完成日志
    elapsed = time.time() - t0 if t0 else 0
    tag = " ⚠️内容审核拦截" if (saw_filter or finish_reason == "content-filter") else ""
    _log(
        f"{prefix}◀ RESPONSE {model_name} | {elapsed:.1f}s | stream finish={finish_reason}{tag}"
        + (f" | tool_calls={tool_names}" if tool_names else "")
        + f" | tokens={usage.get('total_tokens', '?')}"
    )
    # 完整原始 SSE（后端返回的全部内容）
    _log(
        f"{prefix}── RESPONSE RAW SSE ──\n{b''.join(raw_parts).decode('utf-8', 'replace')}"
    )


def _safe_err(r: httpx.Response) -> dict:
    try:
        return {"error": r.json()}
    except Exception:
        return {
            "error": {
                "message": r.text[:500],
                "type": "upstream_error",
                "code": r.status_code,
            }
        }


def _err_event(msg: bytes, status: int) -> bytes:
    # 以 OpenAI SSE 错误 chunk 形式返回
    import json as _json

    chunk = {
        "error": {
            "message": msg.decode("utf-8", "replace")[:500],
            "type": "upstream_error",
            "code": status,
        },
    }
    return f"data: {_json.dumps(chunk, ensure_ascii=False)}\n\n".encode()


def _looks_like_content_filter_text(text: str) -> bool:
    text = (text or "").lower()
    return (
        "content-filter" in text
        or "content_filter" in text
        or "敏感内容" in text
        or "内容审核" in text
        or "无法响应您的请求" in text
    )


def _chat_body_desensitize(body: dict, *, force_compact: bool = False) -> dict:
    if not CONFIG.get("desensitize"):
        return body
    return desensitize_body(
        body,
        roles=("system", "developer"),
        desensitize_harness_user=True,
        desensitize_tools=True,
        compact_harness=(force_compact or not CONFIG.get("no_compact")),
        strip_tool_metadata=True,
    )


async def _post_backend_once(url: str, headers: dict, body: dict) -> tuple[int, bytes]:
    async with httpx.AsyncClient(timeout=120) as c:
        async with c.stream("POST", url, headers=headers, json=body) as r:
            chunks: list[bytes] = []
            async for chunk in r.aiter_bytes():
                if chunk:
                    chunks.append(chunk)
            return r.status_code, b"".join(chunks)


async def _post_backend_with_filter_retry(
    url: str, headers: dict, body: dict, rid: str = "", model_name: str = "?"
) -> tuple[int, bytes, dict]:
    prefix = f"[{rid}] " if rid else ""
    status, raw = await _post_backend_once(url, headers, body)
    text = raw.decode("utf-8", "replace")
    if (
        status == 200
        and _looks_like_content_filter_text(text)
        and CONFIG.get("desensitize")
        and CONFIG.get("no_compact")
    ):
        retry_body = _chat_body_desensitize(body, force_compact=True)
        _log(
            f"{prefix}↻ RESPONSES {model_name} | content filter detected, retry with compact harness"
        )
        _log(
            f"{prefix}── RESPONSES RETRY CHAT BODY ──\n{json.dumps(retry_body, ensure_ascii=False, indent=2)}"
        )
        retry_status, retry_raw = await _post_backend_once(url, headers, retry_body)
        retry_text = retry_raw.decode("utf-8", "replace")
        if retry_status == 200 and not _looks_like_content_filter_text(retry_text):
            return retry_status, retry_raw, retry_body
    return status, raw, body


# ---------------------------------------------------------------------------
# Responses API 端点（Codex CLI 兼容）
# ---------------------------------------------------------------------------


def _split_leading_system(messages: list) -> tuple[list, list]:
    """把「开头的 system 消息」与其余消息分开。

    responses_request_to_chat 会把 instructions 变成置顶的 system；
    接入 previous_response_id 的历史时，system 必须仍在最前面。
    """
    head: list = []
    rest: list = []
    for msg in messages or []:
        if not rest and isinstance(msg, dict) and msg.get("role") == "system":
            head.append(msg)
        else:
            rest.append(msg)
    return head, rest


def _user_texts(messages: list) -> list[str]:
    out = []
    for msg in messages or []:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            out.append(
                "".join(
                    str(part.get("text", ""))
                    for part in content
                    if isinstance(part, dict)
                )
            )
    return [t for t in out if t]


def _client_replayed_history(new_messages: list, prior: list | None) -> bool:
    """判断客户端是否**自己又发了一遍完整历史**。

    有些客户端同时发 previous_response_id 和完整历史；这时再拼一次历史就会重复。
    判据：新一轮 input 里的某条 user 消息在历史里已经出现过 → 认定是重放。
    （真正的新提问一定是没见过的文本。）
    """
    if not prior:
        return False
    old = set(_user_texts(prior))
    if not old:
        return False
    return any(text in old for text in _user_texts(new_messages))


def _assistant_message_from_converter(converter) -> dict:
    """把 ResponsesStreamConverter 累积的产出还原成一条 Chat assistant 消息。

    这一步很关键：把 assistant 的 tool_calls 一起记下来，下一轮客户端回传的
    tool 结果才有「声明它的 assistant 轮」可挂靠，不会变成孤儿（11148）。
    """
    tool_calls = []
    for index in sorted(getattr(converter, "_tool_calls", {}) or {}):
        slot = converter._tool_calls[index]
        call_id = slot.get("id")
        if not call_id:
            continue
        tool_calls.append(
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": slot.get("name", ""),
                    "arguments": slot.get("args", ""),
                },
            }
        )
    message: dict = {"role": "assistant", "content": getattr(converter, "_content", "") or ""}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _attach_previous_response(chat_body: dict, payload: dict) -> tuple[list, dict]:
    """按 previous_response_id 把历史接回当前请求。

    返回 (本轮完整对话消息, 诊断信息)。本轮完整对话 = 历史 + 本轮 input，
    会在拿到模型回复后连同回复一起存回 store，供下一轮取用。
    """
    info: dict = {"previous_response_id": payload.get("previous_response_id")}
    lead_system, rest = _split_leading_system(chat_body.get("messages") or [])

    # store 显式为 false 时按无状态处理（OpenAI 语义）
    disabled = payload.get("store") is False
    prior = None if disabled else response_store.load_response(payload.get("previous_response_id"))

    if prior and not _client_replayed_history(rest, prior):
        chat_body["messages"] = lead_system + list(prior) + rest
        info["history_messages"] = len(prior)
        info["attached"] = True
        base_messages = list(prior) + rest
    else:
        info["attached"] = False
        if prior:
            info["skipped"] = "client_replayed_history"
        base_messages = rest

    info["base_messages"] = len(base_messages)
    return base_messages, info


@app.post("/v1/responses")
@app.post("/v1/effort/responses")
async def create_response(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """OpenAI Responses API 兼容端点。

    Codex CLI 使用 Responses API（wire_api = "responses"）而非 Chat Completions。
    本端点接收 Responses 格式请求，转换为 Chat 格式发往后端，再将后端的 Chat SSE
    转换为 Responses 语义事件流返回。
    """
    _check_auth(authorization, x_api_key)
    cred = _cred()

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {"message": f"bad json: {e}", "type": "invalid_request_error"}
            },
        )

    # 档位变体：/v1/effort/responses 也会拿到形如 "glm-5.2:high" 的 model id。
    # 必须在 Responses → Chat 转换之前拆回「真模型 + reasoning_effort」，
    # 否则变体 id 会原样发往上游并被判为未知模型。
    payload, variant = apply_effort_variant(payload)
    if variant:
        _log(f"⚙ 档位变体 {variant} → model={payload['model']}"
             f" effort={payload.get('reasoning_effort')}")

    # 诊断：记录原始 input 的「骨架」以及是否携带 previous_response_id。
    # 背景：VS Code Copilot 的 BRi() 在命中 stateful marker 时会执行
    #   e = e.slice(m + 1)
    # 只把历史「尾部」发过来，更早的 assistant 工具调用交给 previous_response_id；
    # 本转换器不认 previous_response_id，于是那一轮 assistant 丢失，
    # 只剩孤立的 tool 结果 → 上游 400 [11148] tool calls and tool results do not match。
    # 出这个错时，先看这里能确认客户端到底发了什么。
    try:
        _inp = payload.get("input")
        _skeleton = []
        if isinstance(_inp, list):
            for _it in _inp:
                if isinstance(_it, dict):
                    _skeleton.append(
                        {
                            "type": _it.get("type"),
                            "role": _it.get("role"),
                            "call_id": _it.get("call_id"),
                            "name": _it.get("name"),
                        }
                    )
                else:
                    _skeleton.append(f"<{type(_it).__name__}>")
        _log(
            "[RAW RESPONSES] previous_response_id=%r store=%r input=%s\n%s"
            % (
                payload.get("previous_response_id"),
                payload.get("store"),
                len(_inp) if isinstance(_inp, list) else repr(_inp)[:80],
                json.dumps(_skeleton, ensure_ascii=False),
            )
        )
    except Exception:
        pass  # 诊断日志失败不影响主流程

    # 转换请求：Responses → Chat
    try:
        chat_body = responses_request_to_chat(payload)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"request conversion error: {e}",
                    "type": "invalid_request_error",
                }
            },
        )

    # 有状态支持：把 previous_response_id 指向的历史接回来。
    # 很多 agent 客户端后续轮次的 input 只有 tool 结果、没有用户提问，
    # 不接历史就会「丢失指令」。
    base_messages, state_info = _attach_previous_response(chat_body, payload)
    should_store = payload.get("store") is not False

    chat_body, projection_stats = project_responses_chat_body(
        chat_body, model_tokens=_model_input_tokens(chat_body.get("model"))
    )
    chat_body.setdefault("model", "auto")
    chat_body["stream"] = True
    if "stream_options" not in chat_body:
        chat_body["stream_options"] = {"include_usage": True}

    chat_body = _chat_body_desensitize(chat_body)

    client_wants_stream = payload.get("stream", True)  # Codex CLI 默认 stream
    model_name = payload.get("model", "auto")
    rid = os.urandom(4).hex()
    _log(
        f"[{rid}] ▶ RESPONSES {model_name} | stream={client_wants_stream} | input_items={len(payload.get('input', []))}"
    )
    _pt = projection_stats.get("passthrough")
    _log(
        f"[{rid}] ── RESPONSES PROJECTION ── "
        f"mode={projection_stats.get('mode')} "
        # None = 保守路径（不做尾部切分/历史摘要，这个概念不适用）→ 打 n/a，
        # 免得跟「字段丢了」混淆。
        f"| passthrough={'n/a' if _pt is None else _pt} "
        f"| model_tokens={projection_stats.get('model_tokens')} "
        f"| total_budget_chars={projection_stats.get('total_budget_chars')} "
        f"| tool_output_limit={projection_stats.get('tool_output_limit')} "
        f"| msgs {projection_stats.get('original_messages')}→{projection_stats.get('projected_messages')} "
        f"| chars {projection_stats.get('original_message_chars')}→{projection_stats.get('projected_message_chars')} "
        f"| tools {projection_stats.get('original_tools')}→{projection_stats.get('projected_tools')} "
        f"| tool_chars {projection_stats.get('original_tool_chars')}→{projection_stats.get('projected_tool_chars')} "
        f"| summarized_history={projection_stats.get('summarized_history_messages', 0)} "
        f"| dropped_harness={projection_stats.get('dropped_harness_messages', 0)} "
        f"| anchor_user={projection_stats.get('anchor_user_preserved', False)}"
    )
    _log(
        f"[{rid}] ── RESPONSES → CHAT BODY ──\n{json.dumps(chat_body, ensure_ascii=False, indent=2)}"
    )
    _log(
        f"[{rid}] ── RESPONSES STATE ── "
        f"previous_response_id={state_info.get('previous_response_id')!r} "
        f"| attached={state_info.get('attached')} "
        f"| history_msgs={state_info.get('history_messages', 0)} "
        f"| base_msgs={state_info.get('base_messages')} "
        f"| store={should_store}"
        + (f" | skipped={state_info.get('skipped')}" if state_info.get("skipped") else "")
    )

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    if client_wants_stream:
        return StreamingResponse(
            _stream_responses(
                url, headers, chat_body, model_name, t0, rid,
                base_messages=base_messages, should_store=should_store,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 非流式：聚合后端 SSE → 非流式 Response 对象
    try:
        status_code, raw, final_body = await _post_backend_with_filter_retry(
            url, headers, chat_body, rid, model_name
        )
        if status_code != 200:
            _log(
                f"[{rid}] ✗ HTTP {status_code} | {model_name} | {_truncate(raw.decode('utf-8', 'replace'), 200)}"
            )
            raise HTTPException(
                status_code=status_code, detail=_safe_err_raw(raw, status_code)
            )
        converter = ResponsesStreamConverter(model=model_name)
        for line in raw.decode("utf-8", "replace").splitlines():
            converter.feed_line(line)
        chat_body = final_body
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        _log(f"[{rid}] ✗ 网络错误 | {model_name} | {e}")
        raise HTTPException(
            status_code=502,
            detail={
                "error": {"message": f"upstream error: {e}", "type": "upstream_error"}
            },
        )

    result = converter.get_nonstream_response()
    elapsed = time.time() - t0

    # 记住这轮对话（含模型回复），供下一轮 previous_response_id 取用
    if should_store:
        stored = base_messages + [_assistant_message_from_converter(converter)]
        response_store.store_response(converter.resp_id, stored)

    _log(f"[{rid}] ◀ RESPONSES {model_name} | {elapsed:.1f}s")
    _log(
        f"[{rid}] ── RESPONSE OBJ ──\n{json.dumps(result, ensure_ascii=False, indent=2)}"
    )
    return JSONResponse(content=result)


async def _stream_responses(
    url: str,
    headers: dict,
    body: dict,
    model_name: str = "?",
    t0: float = 0.0,
    rid: str = "",
    base_messages: list | None = None,
    should_store: bool = True,
):
    """消费后端 Chat SSE，实时转换为 Responses API 事件流输出。"""
    converter = ResponsesStreamConverter(model=model_name)
    prefix = f"[{rid}] " if rid else ""

    try:
        status_code, raw, _ = await _post_backend_with_filter_retry(
            url, headers, body, rid, model_name
        )
        if status_code != 200:
            _log(
                f"{prefix}✗ HTTP {status_code} | {model_name} | {_truncate(raw.decode('utf-8', 'replace'), 200)}"
            )
            error_evt = {
                "type": "error",
                # 顶层 message / code 是给 VS Code Copilot 看的（它只读顶层字段）
                "code": status_code,
                "message": _upstream_error_text(raw),
                "error": {
                    "message": raw.decode("utf-8", "replace")[:500],
                    "code": status_code,
                },
            }
            yield f"data: {json.dumps(error_evt, ensure_ascii=False)}\n\n".encode()
            return
        raw_sse_lines = []
        for line in raw.decode("utf-8", "replace").splitlines():
            if line.strip():
                raw_sse_lines.append(line)
            events = converter.feed_line(line)
            if events:
                yield events.encode("utf-8")
    except httpx.HTTPError as e:
        _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
        error_evt = {
            "type": "error",
            "code": 502,
            "message": str(e)[:500],
            "error": {"message": str(e)[:500], "code": 502},
        }
        yield f"data: {json.dumps(error_evt, ensure_ascii=False)}\n\n".encode()
        return

    # 发送收尾事件
    finish_events = converter.finish()
    if finish_events:
        yield finish_events.encode("utf-8")

    # 记住这轮对话（含模型回复与 tool_calls），供下一轮 previous_response_id 取用。
    # 必须在 finish() 之后 —— 此时 tool_calls 的 id / arguments 才累积完整。
    if should_store:
        stored = list(base_messages or []) + [_assistant_message_from_converter(converter)]
        if response_store.store_response(converter.resp_id, stored):
            _log(
                f"{prefix}STATE stored {converter.resp_id} | msgs={len(stored)}"
            )

    elapsed = time.time() - t0 if t0 else 0
    _log(f"{prefix}◀ RESPONSES {model_name} | {elapsed:.1f}s | stream done")
    _log(f"{prefix}── RESPONSES RAW SSE ──\n" + "\n".join(raw_sse_lines[-30:]))


# ---------------------------------------------------------------------------
# Anthropic Messages API 端点（Claude Code / CC Switch 兼容）
# ---------------------------------------------------------------------------


@app.post("/v1/messages")
@app.post("/v1/effort/messages")
async def create_message(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """Anthropic Messages API 兼容端点。

    Claude Code / CC Switch 使用 Anthropic Messages API（POST /v1/messages）。
    本端点接收 Anthropic 格式请求，转换为 Chat 格式发往后端，再将后端的 Chat SSE
    转换为 Anthropic SSE 事件流返回。
    """
    _check_auth(authorization, x_api_key)
    cred = _cred()

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {"message": f"bad json: {e}", "type": "invalid_request_error"}
            },
        )

    # 将 Anthropic 格式消息、工具规范在进入后端前统一转换为 OpenAI Chat 格式。
    payload, variant = apply_effort_variant(payload)
    if variant:
        _log(f"⚙ 档位变体 {variant} → model={payload['model']}"
             f" effort={payload.get('reasoning_effort')}")

    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": "messages is required",
                    "type": "invalid_request_error",
                }
            },
        )

    try:
        chat_body = anthropic_request_to_chat(payload)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"request conversion error: {e}",
                    "type": "invalid_request_error",
                }
            },
        )

    chat_body.setdefault("model", "auto")
    # 读取用户的 stream 参数，如果未提供则默认为 True
    user_stream = payload.get("stream", True)
    # 无论用户如何设置，都向后端请求流式响应（后端只支持流式）
    chat_body["stream"] = True
    if "stream_options" not in chat_body:
        chat_body["stream_options"] = {"include_usage": True}

    if CONFIG.get("desensitize"):
        chat_body = desensitize_body(
            chat_body,
            roles=("system", "developer"),
            desensitize_harness_user=True,
            desensitize_tools=True,
            compact_harness=not CONFIG.get("no_compact"),
            strip_tool_metadata=True,
        )

    model_name = payload.get("model", "auto")
    chat_messages = chat_body.get("messages", [])
    rid = os.urandom(4).hex()
    _log(
        f"[{rid}] ▶ ANTHROPIC {model_name} | msgs={len(chat_messages)} | anthropic_msgs={len(messages)} | user_stream={user_stream}"
    )
    _log(
        f"[{rid}] ── ANTHROPIC → CHAT BODY ──\n{json.dumps(chat_body, ensure_ascii=False, indent=2)}"
    )

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"
    t0 = time.time()

    # 如果用户请求流式响应，直接返回流式
    if user_stream:
        return StreamingResponse(
            _stream_anthropic(url, headers, chat_body, model_name, t0, rid),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 否则，收集完整响应并返回 JSON
    from fastapi.responses import JSONResponse

    response_data = await _collect_anthropic_nonstream(
        url, headers, chat_body, model_name, t0, rid
    )
    return JSONResponse(content=response_data)


async def _collect_anthropic_nonstream(
    url: str,
    headers: dict,
    body: dict,
    model_name: str = "?",
    t0: float = 0.0,
    rid: str = "",
) -> dict:
    """收集完整的流式响应并返回非流式 Anthropic Message 对象。"""
    converter = AnthropicStreamConverter(model=model_name)
    prefix = f"[{rid}] " if rid else ""

    try:
        async with httpx.AsyncClient(timeout=120.0) as c:
            async with c.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    _log(
                        f"{prefix}✗ HTTP {r.status_code} | {model_name} | {_truncate(err.decode('utf-8', 'replace'), 200)}"
                    )
                    raise HTTPException(
                        status_code=r.status_code,
                        detail={
                            "error": {
                                "message": err.decode("utf-8", "replace")[:500],
                                "type": "api_error",
                                "code": r.status_code,
                            }
                        },
                    )
                async for line in r.aiter_lines():
                    converter.feed_line(line)
    except httpx.HTTPError as e:
        _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
        raise HTTPException(
            status_code=502,
            detail={
                "error": {"message": str(e)[:500], "type": "api_error", "code": 502}
            },
        ) from None

    elapsed = time.time() - t0 if t0 else 0
    _log(f"{prefix}◀ ANTHROPIC {model_name} | {elapsed:.1f}s | nonstream done")
    return converter.get_nonstream_response()


async def _stream_anthropic(
    url: str,
    headers: dict,
    body: dict,
    model_name: str = "?",
    t0: float = 0.0,
    rid: str = "",
):
    """消费后端 OpenAI Chat SSE，实时转换为 Anthropic Messages SSE 事件流。"""
    converter = AnthropicStreamConverter(model=model_name)
    prefix = f"[{rid}] " if rid else ""

    try:
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    err = await r.aread()
                    _log(
                        f"{prefix}✗ HTTP {r.status_code} | {model_name} | {_truncate(err.decode('utf-8', 'replace'), 200)}"
                    )
                    error_evt = {
                        "type": "error",
                        "error": {
                            "message": err.decode("utf-8", "replace")[:500],
                            "type": "api_error",
                            "code": r.status_code,
                        },
                    }
                    yield f"event: error\ndata: {json.dumps(error_evt, ensure_ascii=False)}\n\n".encode()
                    return
                async for line in r.aiter_lines():
                    events = converter.feed_line(line)
                    if events:
                        yield events.encode("utf-8")
    except httpx.HTTPError as e:
        _log(f"{prefix}✗ 网络错误 | {model_name} | {e}")
        error_evt = {
            "type": "error",
            "error": {"message": str(e)[:500], "type": "api_error", "code": 502},
        }
        yield f"event: error\ndata: {json.dumps(error_evt, ensure_ascii=False)}\n\n".encode()
        return

    finish_events = converter.finish()
    if finish_events:
        yield finish_events.encode("utf-8")

    elapsed = time.time() - t0 if t0 else 0
    _log(f"{prefix}◀ ANTHROPIC {model_name} | {elapsed:.1f}s | stream done")


@app.post("/v1/messages/count_tokens")
async def count_tokens(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
):
    """Anthropic token 计数端点。

    Claude Code 在发送消息前调用此端点获取 token 计数。
    后端只支持流式请求，所以我们发送流式请求并从中提取 usage。
    """
    _check_auth(authorization, x_api_key)
    cred = _cred()

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {"message": f"bad json: {e}", "type": "invalid_request_error"}
            },
        )

    payload, variant = apply_effort_variant(payload)
    if variant:
        _log(f"⚙ 档位变体 {variant} → model={payload['model']}"
             f" effort={payload.get('reasoning_effort')}")

    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": "messages is required",
                    "type": "invalid_request_error",
                }
            },
        )

    try:
        chat_body = anthropic_request_to_chat(payload)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"request conversion error: {e}",
                    "type": "invalid_request_error",
                }
            },
        )

    # 最小化实际生成：只需要 usage 统计
    chat_body.setdefault("model", "auto")
    chat_body["max_tokens"] = 1
    chat_body["stream"] = True  # 后端只支持流式
    chat_body["stream_options"] = {"include_usage": True}

    if CONFIG.get("desensitize"):
        chat_body = desensitize_body(
            chat_body,
            roles=("system", "developer"),
            desensitize_harness_user=True,
            desensitize_tools=True,
            compact_harness=not CONFIG.get("no_compact"),
            strip_tool_metadata=True,
        )

    headers = cred.get_headers()
    url = f"{BACKEND}/v2/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream(
                "POST", url, headers=headers, json=chat_body
            ) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    _log(
                        f"✗ count_tokens HTTP {resp.status_code}: {_truncate(err.decode('utf-8', 'replace'), 200)}"
                    )
                    raise HTTPException(
                        status_code=resp.status_code,
                        detail={
                            "error": {
                                "message": err.decode("utf-8", "replace")[:500],
                                "type": "api_error",
                                "code": resp.status_code,
                            }
                        },
                    )

                # 解析 SSE 流，查找 usage 信息
                # message_start 包含初始 usage（0），message_delta 包含真实 usage
                input_tokens = 0
                async for line in resp.aiter_lines():
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            # message_delta 事件直接包含 usage
                            if "usage" in chunk:
                                usage = chunk.get("usage") or {}
                                tokens = usage.get("prompt_tokens", 0) or usage.get(
                                    "input_tokens", 0
                                )
                                if tokens > 0:
                                    input_tokens = tokens
                            # message_start 事件在 message 对象中包含 usage
                            elif "message" in chunk and "usage" in chunk["message"]:
                                usage = chunk["message"].get("usage") or {}
                                tokens = usage.get("prompt_tokens", 0) or usage.get(
                                    "input_tokens", 0
                                )
                                if tokens > 0:
                                    input_tokens = tokens
                        except json.JSONDecodeError:
                            continue

                return {"input_tokens": input_tokens}

    except httpx.HTTPError as e:
        _log(f"✗ count_tokens network error: {e}")
        raise HTTPException(
            status_code=502,
            detail={
                "error": {"message": str(e)[:500], "type": "api_error", "code": 502}
            },
        ) from None


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------


def preflight() -> bool:
    af = find_auth_file()
    sys.stderr.write("==== 预检 ====\n")
    sys.stderr.write(f"平台      : {sys.platform}\n")
    sys.stderr.write(f"Python    : {sys.version.split()[0]}\n")
    sys.stderr.write(f"后端      : {BACKEND} (直连，原生 function calling)\n")
    sys.stderr.write(f"登录文件  : {af or '(未找到)'}\n")
    if auth_dirs():
        sys.stderr.write(f"已查目录  : {', '.join(str(d) for d in auth_dirs())}\n")
    ok = True
    if af is None:
        sys.stderr.write(
            "\n[警告] 未找到登录文件。请在桌面端完成登录（CodeBuddy/WorkBuddy）。\n"
        )
        ok = False
    else:
        try:
            cm = CredentialManager(af)
            info = cm.summary()
            sys.stderr.write(
                f"账号      : {info.get('nickname')} / {info.get('enterpriseName')}\n"
            )
            sys.stderr.write(
                f"token过期 : {'是(将自动刷新)' if info['token_expired'] else '否'}\n"
            )
        except Exception as e:
            sys.stderr.write(f"[警告] 读取凭据失败：{e}\n")
            ok = False
    sys.stderr.write("================\n")
    return ok


def main():
    ap = argparse.ArgumentParser(
        description="CodeBuddy -> OpenAI 兼容转换器（直连后端）"
    )
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument(
        "--api-key",
        default=os.environ.get("CODEBUDDY2OPENAI_KEY", ""),
        help="可选：要求客户端携带的 API key（默认不校验）",
    )
    ap.add_argument(
        "--log",
        default=None,
        metavar="PATH",
        help="开启日志并写到该文件（如 --log converter.log 或 --log /tmp/cb.log）。"
        "不传则不记日志。",
    )
    ap.add_argument(
        "--desensitize",
        action="store_true",
        help="启用脱敏：对 system 消息里的合规模板敏感词（DoS/exploit/credential 等）"
        "插入零宽空格，缓解被后端内容审核误拦。默认关闭。",
    )
    ap.add_argument(
        "--no-compact",
        action="store_true",
        help="配合 --desensitize 使用：跳过 system/harness 压缩，仅做零宽脱敏。"
        "保留原始 system prompt 完整内容（如 Claude Code 的行为指令），"
        "但审核误拦风险略高于默认压缩模式。",
    )
    ap.add_argument("--skip-check", action="store_true", help="跳过启动预检")
    args = ap.parse_args()

    CONFIG["api_key"] = args.api_key
    CONFIG["desensitize"] = args.desensitize
    CONFIG["no_compact"] = args.no_compact
    # --log 直接指定文件路径即开启；不传则不记
    CONFIG["log_path"] = (
        args.log if args.log else os.environ.get("CODEBUDDY2OPENAI_LOG")
    )
    af = find_auth_file()
    CONFIG["cred"] = CredentialManager(af) if af else None

    if not args.skip_check:
        preflight()

    sys.stderr.write(
        f"\n✅ 监听 http://{args.host}:{args.port}（直连后端，原生 function calling）\n"
    )
    sys.stderr.write("   GET  /v1/models\n")
    sys.stderr.write(
        "   POST /v1/chat/completions   (原生 tools/tool_calls，支持流式)\n"
    )
    sys.stderr.write("   POST /v1/responses          (Responses API，Codex CLI 兼容)\n")
    sys.stderr.write(
        "   POST /v1/messages           (Anthropic API，Claude Code / CC Switch 兼容)\n"
    )
    sys.stderr.write("   GET  /health\n")
    if args.api_key:
        sys.stderr.write("   鉴权已启用（API key 已设置）\n")
    if CONFIG["log_path"]:
        sys.stderr.write(f"   日志      : {CONFIG['log_path']}\n")
    if args.desensitize:
        mode = "零宽脱敏 + 保留全文" if args.no_compact else "零宽脱敏 + 压缩摘要"
        sys.stderr.write(f"   脱敏      : 已启用（{mode}）\n")
    sys.stderr.write("按 Ctrl+C 退出。\n\n")

    # 启动时写一条标记
    _log("==== converter 启动 ====")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
