# -*- coding: utf-8 -*-
"""把转换器的多模态声明同步进 dsh 的 provider 配置（只补 `input` 字段）。

为什么需要这个脚本
------------------
dsh「获取可用模型」按钮走 `llm-pi-ai/src/discovery.ts::readListing()`，
`ListingEntry` 只白名单 7 个字段，构造 `LlmDiscoveredModel` 时只 push
`id / name / contextWindow / maxTokens` —— **模态、推理档位都带不过去**。
dsh 自己在 `config.ts` 的注释里写得很直白：

    nothing can interrogate a gateway for its modalities

所以按钮导入的每一行都不带 `input`，全部 fallback 成 `['text']`。
本脚本等价于「给按钮结果补上模态这一列」，数据源是转换器本地的
`model_card()`（静态 product.json + 服务端动态缓存合并），不需要 8787 重启。

与 sync-dsh-models.py 的区别（很重要）
--------------------------------------
用户当前的 patch 是**档位变体方案**（224 行 `model:<effort>`、baseURL
指向 `/v1/effort`、无 `reasoningEfforts`）。`sync-dsh-models.py` 会把模型列表
重写成 58 个基础模型并写入旧式逐模型档位，**会破坏这套配置，不要跑**。

本脚本按**文本行**处理，只做一件事：给每个模型条目补/改一行 `input:`。
不删行、不增行、不改 id/name/contextWindow/maxTokens、不写 reasoningEfforts、
不动 baseURL/compat/defaultInput、保留文件顶部注释与原有缩进。幂等，可反复跑。

用法：
    .venv\\Scripts\\python.exe sync-dsh-modalities.py            # 预演（默认，不写文件）
    .venv\\Scripts\\python.exe sync-dsh-modalities.py --write    # 写入（自动备份）
    .venv\\Scripts\\python.exe sync-dsh-modalities.py --route wb-cli --file <path>

写入后必须重启 dsh 才生效。
"""
from __future__ import annotations

import argparse
import re
import shutil
import time
from pathlib import Path

from core import converter as C

DEFAULT_CFG = Path.home() / ".dsh" / "profiles" / "desktop" / "cordis.patch.yml"

# 这些模型「明确关掉」多模态或能力未知，保持纯文本（安全下限）。
# 依据：product.json 的 disabledMultimodal + 主色判别实测
# （hunyuan-2.0-thinking 明确答 "I cannot view the image"）。

RE_ENTRY = re.compile(r'^          - id:\s*["\']?([^"\'\s]+)["\']?\s*$')
RE_INPUT = re.compile(r'^            input:\s*.*$')
RE_MODELS = re.compile(r'^        models:\s*$')


def desired_input(model_id: str) -> list[str]:
    """这一行在 dsh 里应该声明的模态。"""
    base, _ = C.split_effort_variant(model_id)
    card = C.model_card(base)
    modalities = (card.get("architecture") or {}).get("input_modalities") or ["text"]
    return ["text", "image"] if "image" in modalities else ["text"]


def render(values: list[str]) -> str:
    return "            input: [" + ", ".join(values) + "]"


def plan(lines: list[str], route: str) -> tuple[list[tuple[int, str]], dict]:
    """返回 [(行号, 新行内容)] 与统计；行号是「插入到该行之前」。"""
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("- id: llm-pi-ai"))
    except StopIteration:
        raise SystemExit("patch 里找不到 '- id: llm-pi-ai'")
    try:
        mstart = next(i for i in range(start, len(lines)) if RE_MODELS.match(lines[i]))
    except StopIteration:
        raise SystemExit("llm-pi-ai 段落里找不到 'models:' 行（缩进需为 8 空格）")

    # 段落结束：遇到下一条内容行，且缩进 <= 8（下一个顶层 key / 顶层 - id:）
    end = len(lines)
    for i in range(mstart + 1, len(lines)):
        raw = lines[i].rstrip("\r\n")
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent <= 8:
            end = i
            break

    # 切出每个模型条目的区间
    heads = [i for i in range(mstart + 1, end) if RE_ENTRY.match(lines[i])]
    stats = {"total": len(heads), "insert": 0, "update": 0, "same": 0,
             "vision": 0, "text": 0}
    edits: list[tuple[int, str]] = []
    newline = "\r\n" if (lines and lines[0].endswith("\r\n")) else "\n"

    for n, head in enumerate(heads):
        stop = heads[n + 1] if n + 1 < len(heads) else end
        mid = RE_ENTRY.match(lines[head]).group(1)
        values = desired_input(mid)
        stats["vision" if len(values) > 1 else "text"] += 1
        nl = render(values) + newline

        existing = [i for i in range(head + 1, stop) if RE_INPUT.match(lines[i])]
        if existing:
            i = existing[0]
            if lines[i].rstrip("\r\n") == nl.rstrip("\r\n"):
                stats["same"] += 1
            else:
                edits.append((i, nl))
                stats["update"] += 1
                # 多余的重复 input 行删掉
                for j in existing[1:]:
                    edits.append((j, None))  # type: ignore[arg-type]
        else:
            edits.append((head + 1, nl))
            stats["insert"] += 1

    return edits, stats


def apply_edits(lines: list[str], edits: list[tuple[int, str]]) -> list[str]:
    """从后往前应用，避免插入导致行号漂移。None 表示删除该行。"""
    out = list(lines)
    for idx, content in sorted(edits, key=lambda x: x[0], reverse=True):
        if content is None:
            del out[idx]
        else:
            out[idx:idx] = [content]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT_CFG), help="cordis.patch.yml 路径")
    ap.add_argument("--route", default="wb-cli", help="provider 路由名（仅用于提示）")
    ap.add_argument("--write", action="store_true", help="真正写入（默认只预演）")
    args = ap.parse_args()

    cfg = Path(args.file)
    text = cfg.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    edits, stats = plan(lines, args.route)

    print(f"配置      {cfg}")
    print(f"路由      {args.route}")
    print(f"模型条目  {stats['total']} 行（一行不删、一行不增）")
    print(f"目标模态  text+image {stats['vision']} 行 / text {stats['text']} 行")
    print(f"变更      新增 input {stats['insert']} 行 / 修正 {stats['update']} 行"
          f" / 已正确 {stats['same']} 行")
    if edits:
        print("\n预览（前 8 处）:")
        for idx, content in edits[:8]:
            label = "删除重复行" if content is None else content.rstrip()
            print(f"  行 {idx + 1:>4}: {label}")
    else:
        print("\n无需改动，配置已是最新。")

    if not args.write:
        print("\n[预演] 未写文件。确认无误后加 --write 执行（会自动备份）。")
        return 0
    if not edits:
        print("\n[跳过] 没有变更，不写文件。")
        return 0

    bak = cfg.with_name(cfg.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(cfg, bak)
    cfg.write_text("".join(apply_edits(lines, edits)), encoding="utf-8")
    print(f"\n已写入 {cfg}")
    print(f"备份     {bak}")
    print("请重启 dsh 使配置生效。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
