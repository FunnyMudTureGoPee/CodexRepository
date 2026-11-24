"""Render explicitly selected memory ledgers into a local HTML snapshot."""

import argparse
import html
import re
from datetime import date
from pathlib import Path

HEADING = re.compile(r"^## \[([A-Z0-9-]+)\] (.+)$", re.MULTILINE)
FIELD = re.compile(r"^- (模块|状态|更新)[：:] *(.+)$")
STATUSES = ("待验证", "已验证", "已替代")

PAGE_HEAD = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>记忆工作台</title>
<style>
:root { color-scheme: light dark; font: 16px/1.6 system-ui, "Microsoft YaHei", sans-serif; }
body { max-width: 70rem; margin: 0 auto; padding: 2rem 1.25rem; }
h1, h2 { line-height: 1.3; }
h1 { margin: 0; }
.controls { display: flex; flex-wrap: wrap; gap: .75rem; }
label { display: grid; gap: .25rem; }
label:first-child { flex: 1 1 15rem; }
input, select { min-width: 0; font: inherit; padding: .4rem .65rem; }
article { border: 1px solid GrayText; border-radius: .7rem; padding: .85rem 1rem; margin: .8rem 0; overflow-wrap: anywhere; }
article h2 { font-size: 1.1rem; margin: .25rem 0; }
.meta { font-size: .88rem; margin: .4rem 0; }
.body { white-space: pre-wrap; margin: .55rem 0 0; }
summary { cursor: pointer; width: fit-content; }
#count { margin: .85rem 0; }
</style>
</head>
<body>
<h1>记忆工作台</h1>
<p>离线快照。选择范围和状态，或搜索错误码、模块和正文。更新台账后可重新生成。</p>
<div class="controls">
<label>关键词<input id="search" type="search" placeholder="例如：Domain Reload"></label>
"""

PAGE_END = """</main>
<script>
const search = document.getElementById("search");
const scope = document.getElementById("scope");
const status = document.getElementById("status");
const count = document.getElementById("count");
const entries = [...document.querySelectorAll("article")].map(card => ({
  card,
  text: card.textContent.toLocaleLowerCase(),
  scope: card.dataset.scope,
  status: card.dataset.status,
}));
function filter() {
  const words = search.value.trim().toLocaleLowerCase().split(/\\s+/u).filter(Boolean);
  let visible = 0;
  for (const entry of entries) {
    const matches = (!scope.value || scope.value === entry.scope)
      && (!status.value || status.value === entry.status)
      && words.every(word => entry.text.includes(word));
    entry.card.hidden = !matches;
    if (matches) visible += 1;
  }
  count.textContent = "显示 " + visible + " / " + entries.length + " 条";
}
search.addEventListener("input", filter);
scope.addEventListener("change", filter);
status.addEventListener("change", filter);
filter();
</script>
</body>
</html>
"""


def read_ledger(path):
    return parse_ledger(path.read_text(encoding="utf-8-sig"), path)


def parse_ledger(source, path):
    headings = list(HEADING.finditer(source))
    if not source.startswith("# ") or len(headings) != len(re.findall(r"^## ", source, re.MULTILINE)):
        raise ValueError(f"{path} 不是有效的记忆工作台台账")

    entries = []
    seen = set()
    for index, heading in enumerate(headings):
        key, title = heading.groups()
        if key in seen:
            raise ValueError(f"{path} 中的条目 ID 重复：{key}")
        seen.add(key)

        end = headings[index + 1].start() if index + 1 < len(headings) else len(source)
        lines = source[heading.end():end].strip("\n").splitlines()
        fields = {}
        for line in lines[:3]:
            match = FIELD.fullmatch(line)
            if match:
                fields[match[1]] = match[2].strip()

        if not fields.get("模块") or fields.get("状态") not in STATUSES or not fields.get("更新"):
            raise ValueError(f"{path} 的 {key} 缺少有效的模块、状态或更新日期")
        try:
            updated = date.fromisoformat(fields["更新"])
            if updated.isoformat() != fields["更新"]:
                raise ValueError()
        except ValueError:
            raise ValueError(f"{path} 的 {key} 更新日期应为 YYYY-MM-DD") from None

        entries.append((key, title, fields["模块"], fields["状态"], updated, "\n".join(lines[3:]).strip()))
    return entries


def options(values):
    return '<option value="">全部</option>' + "".join(
        f"<option>{html.escape(value)}</option>" for value in values
    )


def render_card(scope, entry):
    key, title, module, status, updated, body = map(lambda value: html.escape(str(value)), entry)
    scope = html.escape(scope)
    return f"""<article data-scope="{scope}" data-status="{status}">
<h2>{title}</h2>
<p class="meta">{scope} · {module} · {status} · {updated} · {key}</p>
<details><summary>查看记录</summary><p class="body">{body}</p></details>
</article>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", nargs=2, required=True, metavar=("LABEL", "PATH"))
    parser.add_argument("--output", type=Path, required=True, help="Path to a new HTML file")
    args = parser.parse_args()
    labels = [label for label, _ in args.source]
    if any(not label.strip() for label in labels) or len(labels) != len(set(labels)):
        parser.error("来源名称必须非空且各不相同")

    try:
        entries = [
            (label, entry)
            for label, path in args.source
            for entry in read_ledger(Path(path))
        ]
        entries.sort(key=lambda item: item[1][4], reverse=True)
        page = (
            PAGE_HEAD
            + f'<label>范围<select id="scope">{options(labels)}</select></label>'
            + f'<label>状态<select id="status">{options(STATUSES)}</select></label>'
            + '</div><p id="count" aria-live="polite"></p><main>'
            + "".join(render_card(label, entry) for label, entry in entries)
            + PAGE_END
        )
        with args.output.open("x", encoding="utf-8") as output:
            output.write(page)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
