"""output.py — 写入歌词 JSONL、错误 JSONL、状态文件，并对 JSONL 做 schema 校验。"""
from __future__ import annotations

import json
import re
import datetime
from typing import Iterable

from .models import LyricsRecord, ErrorRecord

_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]+$")
REQUIRED = ("id", "title", "artist", "lyrics")


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_jsonl(records: Iterable[LyricsRecord], path: str) -> int:
    """把记录逐行写入 JSONL (UTF-8, \n 换行, ensure_ascii=False)。返回成功行数。"""
    n = 0
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            d = rec.to_dict()
            fh.write(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def write_errors(errors: Iterable[ErrorRecord], path: str) -> int:
    n = 0
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for err in errors:
            fh.write(json.dumps(err.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def write_status(status: dict, path: str) -> None:
    payload = {"updatedAt": _utc_now(), **status}
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def validate_record(d: dict) -> list[str]:
    """按 schema 校验单条记录, 返回问题列表(空表示通过)。"""
    issues: list[str] = []
    for f in REQUIRED:
        if f not in d or d.get(f) is None:
            issues.append(f"missing required field: {f}")
            continue
        v = d[f]
        if not isinstance(v, str):
            issues.append(f"{f} must be string")
            continue
        if not v.strip():
            issues.append(f"{f} is empty")
    if "id" in d and isinstance(d["id"], str):
        if not _ID_PATTERN.match(d["id"]):
            issues.append("id fails pattern ^[A-Za-z0-9:_-]+$")
        if len(d["id"]) > 128:
            issues.append("id exceeds 128 chars")
    if "title" in d and isinstance(d["title"], str) and len(d["title"]) > 512:
        issues.append("title exceeds 512 chars")
    if "artist" in d and isinstance(d["artist"], str) and len(d["artist"]) > 512:
        issues.append("artist exceeds 512 chars")
    if "album" in d and isinstance(d["album"], str) and len(d["album"]) > 512:
        issues.append("album exceeds 512 chars")
    if "language" in d and isinstance(d["language"], str) and len(d["language"]) > 32:
        issues.append("language exceeds 32 chars")
    if "lyrics" in d and isinstance(d["lyrics"], str) and not d["lyrics"].strip():
        issues.append("lyrics has no non-empty line")
    allowed = {"id", "title", "artist", "album", "language", "lyrics", "source"}
    extra = set(d.keys()) - allowed
    if extra:
        issues.append("unexpected fields: " + ",".join(sorted(extra)))
    return issues


def validate_jsonl(path: str) -> tuple[int, list[dict]]:
    """逐行校验 JSONL 文件。返回 (行数, 问题列表)。"""
    count = 0
    problems: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            count += 1
            try:
                d = json.loads(line)
            except json.JSONDecodeError as e:
                problems.append({"line": lineno, "error": f"JSON decode: {e}"})
                continue
            issues = validate_record(d)
            if issues:
                problems.append({"line": lineno, "id": d.get("id"), "issues": issues})
    return count, problems
