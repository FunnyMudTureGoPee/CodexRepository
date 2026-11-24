# -*- coding: utf-8 -*-
"""把 workbuddy2api 的模型元数据写进 dsh 的 provider 配置。

为什么需要这个脚本
------------------
dsh 的「获取可用模型」按钮走 `llm-pi-ai/src/discovery.ts` 的 `readListing()`，
**只读四个字段**：`id` / `name|display_name` / `context_window|context_length` /
`max_output_tokens|max_tokens`。推理等级不在发现路径里 —— 它来自配置里的
`reasoningEfforts`（档位 → wire 拼写）和 `compat.supportsReasoningEffort`。

所以「点一下获取可用模型就全齐」在 dsh 上做不到。这个脚本读 `/v1/models`
（那里有真实的窗口、输出上限、视觉、推理能力），把整段 provider 配置重写一遍，
等价于「获取可用模型 + 手工补推理等级」。

改动范围
--------
只替换 ``- id: llm-pi-ai`` 这一项里 ``providers.<route>`` 下面的 ``models:`` 列表，
并在其前面补/改 ``compat:``。文件里其它配置、以及文件顶部的注释都原样保留
（按文本行处理，不做 YAML 反序列化 → 注释和缩进不会丢）。

用法：
    .venv\\Scripts\\python.exe sync-dsh-models.py
    .venv\\Scripts\\python.exe sync-dsh-models.py --dry-run
    .venv\\Scripts\\python.exe sync-dsh-models.py --route wb-cli --file <path>
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import httpx

APP_ROOT = Path(__file__).resolve().parent
ENV_FILE = APP_ROOT / ".env.local"
DEFAULT_CFG = Path.home() / ".dsh" / "profiles" / "desktop" / "cordis.patch.yml"

# dsh 的 THINKING_LEVELS（pi-ai 的 ModelThinkingLevel），顺序即升档顺序。
# 见 packages/llm/llm-pi-ai/src/catalog.ts 的 THINKING_LEVEL_GATE。
THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

# 上游 copilot.tencent.com 实测接受这七个拼写（off 走 "none"）。
# none 会让 reasoning_tokens 归零，其余逐档加深。
WIRE = {level: ("none" if level == "off" else level) for level in THINKING_LEVELS}

# 排序用：wire 拼写的升档顺序。
WIRE_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

# product.json 声明了 supportsReasoning 但既无 supportedEfforts 也无默认档时
# 的兜底档位（极少数模型，如 glm-4.6）。只取中段，不臆造 xhigh/max。
FALLBACK_EFFORTS = ["low", "medium", "high"]

# --strict：完全照 product.json —— 没枚举档位的模型只给它的默认档。
# 注意 dsh 遇到不支持的档位是**直接抛错**（不是 clamp），所以 strict 会连带
# 校正 agent-default-model 的 reasoningEffort，否则一重启第一轮就失败。
STRICT = False

# 不写进 dsh 的伪模型：`default`/`auto` 由上游自行路由，没有确定的能力，
# 放进配置只会在选择器里占位。想保留就把它们加回来。
SKIP_MODELS = {"auto"}


def load_env(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.is_file():
        return data
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        data[k.strip()] = v.strip()
    return data


def fetch_models(base_url: str, api_key: str) -> list[dict]:
    with httpx.Client(trust_env=False, timeout=30.0) as c:
        r = c.get(base_url.rstrip("/") + "/models",
                  headers={"Authorization": f"Bearer {api_key}", "accept": "application/json"})
        r.raise_for_status()
        payload = r.json()
    data = payload.get("data")
    if not isinstance(data, list):
        raise SystemExit("端点没有返回 data 数组，先确认 baseURL 指到了 /v1")
    return data


def fetch_models_local() -> list[dict]:
    """直接调用本仓库的 converter 取模型卡片。

    比走 HTTP 稳：不依赖 8787 是否已重启到新代码，也能在服务没起时使用。
    """
    if str(APP_ROOT) not in sys.path:
        sys.path.insert(0, str(APP_ROOT))
    try:
        from core.converter import get_available_models, model_card
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"无法导入 core.converter: {e}")
    return [model_card(mid) for mid in get_available_models()]


def efforts_of(entry: dict) -> list[str]:
    """这个模型该给 dsh 的档位（wire 拼写），按 product.json 的真实声明来。

    优先用 ``reasoning.efforts``（服务端已按 supportedEfforts / defaultEffort
    算好的真实列表，含 none 表示可关思考）。模型声明了推理但 product.json
    没给任何档位信息时，退到中间三档 —— 不把"上游大概也收"当官方能力。
    """
    info = entry.get("reasoning") or {}
    if not info.get("supported"):
        return []
    efforts = [str(x) for x in (info.get("efforts") or []) if isinstance(x, str)]
    if STRICT:
        # 只信官方枚举；没枚举就只留默认档
        declared = [str(x) for x in (info.get("declared_efforts") or []) if isinstance(x, str)]
        if declared:
            efforts = declared
        elif info.get("default_effort"):
            efforts = [str(info["default_effort"])]
        else:
            efforts = list(FALLBACK_EFFORTS)
        if info.get("can_disable"):
            efforts = ["none"] + efforts
    if not efforts:
        efforts = list(FALLBACK_EFFORTS)
    order = {name: i for i, name in enumerate(WIRE_ORDER)}
    return sorted(dict.fromkeys(efforts), key=lambda x: order.get(x, len(order)))


def model_block(entry: dict) -> list[str]:
    """一个模型条目 → YAML 行（缩进由调用方决定，这里从 10 空格起）。"""
    mid = entry["id"]
    caps = entry.get("capabilities") or {}
    reasoning = bool(caps.get("reasoning"))

    ctx = entry.get("context_length") or entry.get("context_window")
    out = entry.get("max_output_tokens") or entry.get("max_completion_tokens")
    inputs = ["text"] + (["image"] if caps.get("vision") else [])

    lines = [f"          - id: {mid}"]
    name = entry.get("name") or mid
    lines.append(f"            name: {json.dumps(name, ensure_ascii=False)}")
    if isinstance(ctx, int) and ctx > 0:
        lines.append(f"            contextWindow: {ctx}")
    if isinstance(out, int) and out > 0:
        lines.append(f"            maxTokens: {out}")
    lines.append(f"            input: [{', '.join(inputs)}]")

    efforts = efforts_of(entry) if reasoning else []
    if efforts:
        lines.append("            reasoningEfforts:")
        # dsh 的档位名是 off；wire 拼写是 none。其余档位两者同名。
        for wire in efforts:
            level = "off" if wire == "none" else wire
            lines.append(f"              {level}: {wire}")
    else:
        lines.append("            reasoningEfforts: false")
    return lines


def find_block(lines: list[str], route: str) -> tuple[int, int, int]:
    """定位 llm-pi-ai 段落里 route 的 models 列表。

    返回 (models 行号, 列表起始行, 列表结束行(不含), 缩进)。
    """
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "- id: llm-pi-ai":
            start = i
            break
    if start is None:
        raise SystemExit('配置里找不到 "- id: llm-pi-ai"，请确认 --file 指对了')

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("- "):
            end = i
            break

    route_line = None
    for i in range(start, end):
        if lines[i].strip() == f"{route}:":
            route_line = i
            break
    if route_line is None:
        raise SystemExit(f"llm-pi-ai 段里找不到 provider {route}:，先在界面上建好这个服务商")

    models_line = None
    for i in range(route_line + 1, end):
        if lines[i].strip() == "models:":
            models_line = i
            break
    if models_line is None:
        raise SystemExit(f"provider {route} 下面没有 models: 列表")

    indent = len(lines[models_line]) - len(lines[models_line].lstrip())
    # 列表结束：缩进 <= models 缩进的第一个非空行
    stop = models_line + 1
    while stop < end:
        raw = lines[stop]
        if raw.strip() == "":
            stop += 1
            continue
        cur = len(raw) - len(raw.lstrip())
        if cur <= indent:
            break
        stop += 1
    return models_line, models_line + 1, stop, indent


def fix_default_model_effort(lines: list[str], models: list[dict]) -> list[str]:
    """--strict 下校正 agent-default-model 的 reasoningEffort。

    dsh 的 ``resolveReasoningLevel`` 遇到模型不支持的档位会**抛错**
    （``UNSUPPORTED_REASONING_EFFORT``），不是自动降级。所以一旦收紧档位，
    现有 ``reasoningEffort: max`` 这类配置会让每轮请求直接失败。
    这里把它落到该模型实际支持的档上。
    """
    by_id = {m.get("id"): m for m in models}
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "- id: agent-default-model":
            start = i
            break
    if start is None:
        return lines
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("- "):
            end = i
            break
    model_id = None
    effort_idx = None
    for i in range(start, end):
        s = lines[i].strip()
        if s.startswith("model:") and model_id is None:
            model_id = s.split(":", 1)[1].strip()
        elif s.startswith("reasoningEffort:"):
            effort_idx = i
    if not model_id or effort_idx is None or model_id not in by_id:
        return lines
    allowed = efforts_of(by_id[model_id])
    if not allowed:
        return lines
    current = lines[effort_idx].split(":", 1)[1].strip()
    wire = "none" if current == "off" else current
    if wire in allowed:
        return lines
    info = by_id[model_id].get("reasoning") or {}
    prefer = info.get("default_effort")
    target = prefer if prefer in allowed else next((x for x in allowed if x != "none"), allowed[0])
    level = "off" if target == "none" else target
    indent = lines[effort_idx][: len(lines[effort_idx]) - len(lines[effort_idx].lstrip())]
    lines = list(lines)
    lines[effort_idx] = f"{indent}reasoningEffort: {level}"
    print(
        f"⚠ agent-default-model 的 reasoningEffort 由 {current} 校正为 {level}"
        f"（{model_id} 只支持 {'/'.join(allowed)}）"
    )
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="把 /v1/models 的元数据写进 dsh provider 配置")
    ap.add_argument("--file", default=str(DEFAULT_CFG), help="cordis.patch.yml 路径")
    ap.add_argument("--route", default="wb-cli", help="provider 名（默认 wb-cli）")
    ap.add_argument("--base-url", default="http://127.0.0.1:8787/v1")
    ap.add_argument(
        "--source",
        choices=("auto", "local", "http"),
        default="auto",
        help="auto=优先本地 converter（不受服务是否已重启影响），失败再走 HTTP",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="完全照 product.json：没有 supportedEfforts 的模型只给它的默认档（会连带校正 agent-default-model 的档位）",
    )
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    args = ap.parse_args()

    global STRICT
    STRICT = bool(args.strict)

    env = load_env(ENV_FILE)
    key = env.get("CODEBUDDY2OPENAI_KEY", "").strip()

    cfg_path = Path(args.file)
    if not cfg_path.is_file():
        raise SystemExit(f"配置文件不存在: {cfg_path}")

    models = None
    if args.source in ("auto", "local"):
        try:
            models = fetch_models_local()
            print("模型来源: 本地 core.converter")
        except SystemExit as e:
            if args.source == "local":
                raise
            print(f"本地读取失败（{e}），改走 HTTP")
    if models is None:
        if not key:
            raise SystemExit("在 .env.local 里找不到 CODEBUDDY2OPENAI_KEY")
        models = fetch_models(args.base_url, key)
        print("模型来源: " + args.base_url)
    # 档位变体（model:high）只是给「获取可用模型」做发现用的，不写进 patch：
    # patch 里每个基础模型本来就带 reasoningEfforts，180+ 个变体只会让配置膨胀且重复。
    models = [
        m for m in models
        if m.get("id") and m["id"] not in SKIP_MODELS
        and not m.get("is_effort_variant")
    ]

    text = cfg_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    models_line, list_start, list_stop, indent = find_block(lines, args.route)

    new_body: list[str] = []
    for m in models:
        new_body += model_block(m)

    # compat：supportsReasoningEffort 必须显式为 true，否则 pi-ai 的
    # openai-completions 分支不会把 reasoning_effort 写进请求体。
    compat_lines = [
        "        compat:",
        "          supportsReasoningEffort: true",
        "          maxTokensField: max_tokens",
    ]
    # 已经有 compat 就整段替换掉（从 compat: 行到 models: 行之前）
    compat_start = None
    for i in range(models_line - 1, max(0, models_line - 12), -1):
        if lines[i].strip() == "compat:":
            compat_start = i
            break
        if lines[i].strip() and (len(lines[i]) - len(lines[i].lstrip())) < indent:
            break

    if compat_start is not None:
        head = lines[:compat_start]
    else:
        head = lines[:models_line]
    tail = lines[list_stop:]

    out_lines = head + compat_lines + [lines[models_line].rstrip()] + new_body + tail
    # 无论哪种模式都要跑：只要有模型被收窄档位，默认模型的 reasoningEffort
    # 就可能落在集合外，而 dsh 遇到不支持档位是直接抛错。
    out_lines = fix_default_model_effort(out_lines, models)
    out = "\n".join(out_lines) + "\n"

    summary = ["模型 %d 个（跳过 %s）" % (len(models), ",".join(sorted(SKIP_MODELS)) or "无")]
    groups: dict[tuple[str, ...], list[str]] = {}
    for m in models:
        groups.setdefault(tuple(efforts_of(m)), []).append(m["id"])
    summary.append("档位分组（按 product.json 真实声明，不再是统一一套）：")
    for combo, ids in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        label = "/".join(combo) if combo else "无（reasoningEfforts: false）"
        summary.append(f"  {len(ids):2d} 个  {label}")
        if len(ids) <= 6:
            summary.append(f"        {', '.join(ids)}")

    if args.dry_run:
        print("\n".join(summary))
        print("\n---- 生成内容预览（前 40 行）----")
        print("\n".join(out_lines[:max(0, len(head))] if False else out.splitlines()[:40]))
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = cfg_path.with_name(cfg_path.name + f".bak-{stamp}")
    shutil.copy2(cfg_path, bak)
    cfg_path.write_text(out, encoding="utf-8")

    print("\n".join(summary))
    print("备份:", bak)
    print("已写入:", cfg_path)
    print("\n重启 dsh 后生效：每个模型的推理档位按 product.json 的真实声明给出，不再统一一套。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
