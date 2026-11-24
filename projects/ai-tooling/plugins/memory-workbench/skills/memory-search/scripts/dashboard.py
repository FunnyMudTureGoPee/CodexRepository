"""Local MCP server for the Codex Memory Workbench."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

from render import HEADING, STATUSES, parse_ledger

ASSETS = Path(__file__).resolve().parent
FIELDS = ("id", "title", "module", "status", "updated", "body")


class Conflict(ValueError):
    pass


def read_bytes(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return b""


def revision(data):
    return hashlib.sha256(data).hexdigest()


def write_file(path, data, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        pending = Path(output.name)
        output.write(data)
    try:
        if revision(read_bytes(path)) != expected:
            raise Conflict("台账已由其他进程更新。请先复制草稿，再取消编辑并重新打开条目。")
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


class Workbench:
    def __init__(self, codex_home):
        self.home = codex_home
        self.data = self.home / "memory-workbench"
        self.projects = self.data / "projects.json"

    def registered(self):
        raw = read_bytes(self.projects)
        return json.loads(raw) if raw else []

    def sources(self):
        return {
            "global": ("全局记忆", self.data / "global.md"),
            **{f"project:{root}": (Path(root).name, Path(root) / "docs" / "codex-memory.md")
               for root in self.registered()},
        }

    def source(self, scope):
        sources = self.sources()
        if scope not in sources:
            raise ValueError("请先添加该项目")
        return sources[scope]

    def change_projects(self, data, remove):
        path = Path(data["path"].strip().strip('"')).expanduser()
        if not path.is_absolute():
            raise ValueError("请输入项目根目录的绝对路径")
        root = str(path.resolve())
        current = read_bytes(self.projects)
        projects = json.loads(current) if current else []
        if remove:
            projects = [project for project in projects if project != root]
        elif not path.is_dir():
            raise ValueError("项目目录不存在")
        elif root not in projects:
            projects.append(root)
        write_file(self.projects, json.dumps(projects, ensure_ascii=False, indent=2).encode("utf-8"), revision(current))
        return {"scope": "global" if remove else f"project:{root}"}

    def list_sources(self):
        return [{"id": key, "label": label, "path": str(path),
                 "root": str(path.parent.parent) if key.startswith("project:") else ""}
                for key, (label, path) in self.sources().items()]

    def ledger(self, scope):
        label, path = self.source(scope)
        raw = read_bytes(path)
        source = raw.decode("utf-8-sig").replace("\r\n", "\n") if raw else f"# {label}\n"
        return {
            "revision": revision(raw),
            "entries": [dict(zip(FIELDS, row)) for row in parse_ledger(source, path)],
        }

    def change_entry(self, data, delete):
        label, path = self.source(data["scope"])
        raw = read_bytes(path)
        if revision(raw) != data["revision"]:
            raise Conflict("台账已更新。请先复制草稿，再取消编辑并重新打开条目。")
        source = raw.decode("utf-8-sig").replace("\r\n", "\n") if raw else f"# {label}\n"
        entries = parse_ledger(source, path)
        key = data["id"].strip().upper()
        existing = data["existing"]
        if not existing and not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{0,63}", key):
            raise ValueError("条目 ID 须为 1 到 64 位字母、数字或短横线，并以字母或数字起头")

        headings = list(HEADING.finditer(source))
        target = next((index for index, entry in enumerate(entries) if entry[0] == key), None)
        if (target is not None) != existing or (delete and target is None):
            raise Conflict("条目 ID 已存在或原条目已被移除，请刷新后重试。")

        block = ""
        if not delete:
            title, module = (data[name].strip() for name in ("title", "module"))
            status = data["status"]
            body = data["body"].replace("\r\n", "\n").strip()
            if not title or not module or len(title.splitlines()) != 1 or len(module.splitlines()) != 1:
                raise ValueError("请填写单行标题和模块")
            if status not in STATUSES or re.search(r"^## ", body, re.MULTILINE):
                raise ValueError("请选择有效状态，正文里的小标题请用 ###")
            block = (f"## [{key}] {title}\n- 模块：{module}\n- 状态：{status}\n"
                     f"- 更新：{date.today().isoformat()}\n\n{body}\n\n")

        if target is None:
            updated = source.rstrip() + "\n\n" + block
        else:
            end = headings[target + 1].start() if target + 1 < len(headings) else len(source)
            updated = source[:headings[target].start()] + block + source[end:]

        parse_ledger(updated, path)
        newline = "\r\n" if b"\r\n" in raw else "\n"
        encoding = "utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8"
        write_file(path, (updated.rstrip() + "\n").replace("\n", newline).encode(encoding), data["revision"])
        return self.ledger(data["scope"])

    def history(self):
        files = []
        for folder in ("memories_v2", "memories"):
            path = self.home / folder / "memory_summary.md"
            source = read_bytes(path)
            if source:
                files.append({"label": folder, "body": source.decode("utf-8-sig")})
        return files


URI = "ui://memory-workbench/dashboard.html"
MIME = "text/html;profile=mcp-app"
VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
VISIBILITY = {"ui": {"visibility": ["app"]}}


def action_schema(actions, fields):
    return {
        "type": "object", "required": ["action"], "additionalProperties": False,
        "properties": {"action": {"type": "string", "enum": actions},
                       **{field: {"type": kind} for field, kind in fields.items()}},
    }


TOOLS = [
    {
        "name": "open_memory_workbench",
        "title": "记忆工作台",
        "description": "Open the local Memory Workbench inside Codex.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "_meta": {
            "ui": {"resourceUri": URI, "visibility": ["app"]},
            "openai/ui": {"entrypoints": [{"type": "global"}, {"type": "thread"}]},
        },
    },
    {
        "name": "read_memory",
        "title": "查看记忆",
        "description": "Read scopes, a local ledger, or the local Codex memory index.",
        "inputSchema": action_schema(["sources", "ledger", "history"], {"scope": "string"}),
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "_meta": VISIBILITY,
    },
    {
        "name": "manage_memory",
        "title": "维护记忆",
        "description": "Change a registered project or a memory entry from the workbench UI.",
        "inputSchema": action_schema(["add-project", "remove-project", "save", "delete"], {
            "path": "string", "scope": "string", "revision": "string", "existing": "boolean",
            **{field: "string" for field in FIELDS if field != "updated"},
        }),
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
        "_meta": VISIBILITY,
    },
]


def resource():
    markup = (ASSETS / "dashboard.html").read_text(encoding="utf-8")
    script = (ASSETS / "dashboard.js").read_text(encoding="utf-8")
    return {
        "uri": URI, "mimeType": MIME,
        "text": markup.replace("<!-- MCP_APP_SCRIPT -->", f"<script>\n{script}\n</script>", 1),
        "_meta": {"openai/ui": {
            "availableDisplayModes": ["inline", "fullscreen"], "preferredDisplayMode": "fullscreen",
        }},
    }


def call_tool(app, name, args):
    if name == "open_memory_workbench":
        return {"content": [{"type": "text", "text": "记忆工作台"}]}
    action = args.get("action")
    try:
        if name == "read_memory" and action == "sources":
            value = app.list_sources()
        elif name == "read_memory" and action == "ledger":
            value = app.ledger(args["scope"])
        elif name == "read_memory" and action == "history":
            value = app.history()
        elif name == "manage_memory" and action in ("add-project", "remove-project"):
            value = app.change_projects(args, remove=action == "remove-project")
        elif name == "manage_memory" and action in ("save", "delete"):
            if not isinstance(args["existing"], bool):
                raise ValueError("请求中的条目版本无效")
            value = app.change_entry(args, delete=action == "delete")
        else:
            raise ValueError("未知的记忆操作")
        return {"content": [], "_meta": {"workbench": value}}
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        return {"isError": True, "content": [{"type": "text", "text": str(error)}]}


def dispatch(app, method, params):
    if method == "initialize":
        version = params.get("protocolVersion")
        return {
            "protocolVersion": version if version in VERSIONS else VERSIONS[-1],
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "memory-workbench", "version": "0.3.1"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "resources/list":
        return {"resources": [{"uri": URI, "name": "记忆工作台", "mimeType": MIME}]}
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read" and params.get("uri") == URI:
        return {"contents": [resource()]}
    if method == "tools/call":
        return call_tool(app, params.get("name"), params.get("arguments") or {})
    raise LookupError(method)


def send(response):
    print(json.dumps({"jsonrpc": "2.0", **response}, default=str), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex"))
    args = parser.parse_args()
    app = Workbench(args.codex_home.resolve())
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
        except (ValueError, UnicodeError):
            send({"id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue
        call_id = request["id"]
        try:
            result = dispatch(app, request.get("method"), request.get("params") or {})
        except LookupError:
            send({"id": call_id, "error": {"code": -32601, "message": "Unknown method or resource"}})
        except Exception as error:
            print(f"MCP request failed: {error}", file=sys.stderr)
            send({"id": call_id, "error": {"code": -32603, "message": "MCP request failed"}})
        else:
            send({"id": call_id, "result": result})


if __name__ == "__main__":
    main()
