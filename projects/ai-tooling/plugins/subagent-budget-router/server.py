"""Native subagent routing ledger. No inference calls, credentials or background jobs."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
TIERS = ["light", "standard", "deep", "expert"]
EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"]
DEFAULTS = json.loads((ROOT / "defaults.json").read_text(encoding="utf-8"))
LIMIT_NOTE = "Acceptance-based admission control. One round is one delegated attempt plus coordinator review, not an internal model/tool turn. The host must stop internal loops; this server cannot interrupt native agents. No estimated-token budgets."


def merge(base, patch):
    result = copy.deepcopy(base)
    for key, value in patch.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
    return result


def validate(value, schema, path="arguments"):
    """Validate the small JSON Schema subset used by these tools, including unknown keys."""
    kind = schema.get("type")
    ok = {"object": lambda: isinstance(value, dict), "array": lambda: isinstance(value, list),
          "string": lambda: isinstance(value, str), "integer": lambda: type(value) is int,
          "number": lambda: type(value) in (int, float) and math.isfinite(value),
          "boolean": lambda: type(value) is bool}
    if kind and not ok[kind]():
        raise ValueError(f"{path}: expected {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: expected one of {schema['enum']}")
    if isinstance(value, str) and (len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 1000000)):
        raise ValueError(f"{path}: invalid length")
    if type(value) in (int, float) and (value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf)):
        raise ValueError(f"{path}: out of range")
    if kind == "object":
        for key in schema.get("required", []):
            if key not in value:
                raise ValueError(f"{path}: missing {key}")
        for key, item in value.items():
            child = schema.get("properties", {}).get(key)
            if child is None:
                extra = schema.get("additionalProperties", True)
                if extra is False:
                    raise ValueError(f"{path}: unknown field {key}")
                child = extra if isinstance(extra, dict) else {}
            validate(item, child, f"{path}.{key}")
    if kind == "array":
        if len(value) < schema.get("minItems", 0):
            raise ValueError(f"{path}: too few items")
        for item in value:
            validate(item, schema.get("items", {}), path + "[]")


def obj(properties, required=(), additional=False):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": additional}


def string(choices=None, maxlen=200):
    result = {"type": "string", "minLength": 1, "maxLength": maxlen}
    if choices:
        result["enum"] = choices
    return result


def integer(minimum=0, maximum=1000000000):
    return {"type": "integer", "minimum": minimum, "maximum": maximum}


PROFILE = obj({"model": string(), "reasoning_effort": string(EFFORTS)})
PRICE = obj({"input": {"type": "number", "minimum": 0}, "cached_input": {"type": "number", "minimum": 0},
             "output": {"type": "number", "minimum": 0}, "source": string(maxlen=2000), "as_of": string()},
            ["input", "cached_input", "output", "source", "as_of"])
POLICY_SCHEMA = obj({
    "mode": string(["economy", "balanced", "quality"]), "max_concurrent": integer(1, 32),
    "max_attempts_per_task": integer(1, 10), "max_escalations_per_task": integer(0, 3),
    "max_attempts_per_run": integer(1, 1000), "max_no_progress_rounds": integer(1, 10), "max_auto_tier": string(TIERS),
    "profiles": obj({tier: PROFILE for tier in TIERS}),
    "prices_usd_per_million": obj({}, additional=PRICE)
})
PATCH_SCHEMA = copy.deepcopy(POLICY_SCHEMA)
PATCH_SCHEMA["properties"]["prices_usd_per_million"]["additionalProperties"]["required"] = []
CAPABILITIES = {"type": "array", "minItems": 1, "items": obj({
    "model": string(), "efforts": {"type": "array", "minItems": 1, "items": string(EFFORTS)}}, ["model", "efforts"])}
USAGE = obj({"input_tokens": integer(), "cached_input_tokens": integer(), "output_tokens": integer(),
             "source": string(maxlen=1000)}, ["input_tokens", "cached_input_tokens", "output_tokens", "source"])
ACCEPTANCE_CRITERIA = {"type": "array", "minItems": 1, "items": string(maxlen=1000)}
ACCEPTANCE_RESULTS = {"type": "array", "minItems": 1, "items": obj({
    "criterion": string(maxlen=1000), "verdict": string(["passed", "failed", "not_checked"]),
    "evidence": string(maxlen=2000)}, ["criterion", "verdict", "evidence"])}

# Native plugin-details controls accept primitive fields only. Flatten the profile
# fields at the UI boundary; the existing policy remains the single source of truth.
SETTINGS_LABELS = {
    "mode": ("分派策略", "balanced：均衡省成本；economy：优先省成本；quality：优先质量。"),
    "max_auto_tier": ("自动最高模型档位", "light 轻量、standard 标准、deep 深度、expert 专家；仅影响后续分派。"),
    "max_concurrent": ("最大并发子代理数", "插件登记的并发上限；实际还受 Codex 宿主限制。"),
    "max_attempts_per_task": ("每个子任务最多执行轮次", "一轮是一次委派执行加主代理验收，包含首轮；不是模型内部消息或工具调用次数。"),
    "max_escalations_per_task": ("每个子任务最多升级次数", "0 表示不允许升档；还受自动最高档位限制。"),
    "max_attempts_per_run": ("整个长任务最多执行轮次", "所有子任务及其重试累计的执行轮次。"),
    "max_no_progress_rounds": ("连续无验收进展最多轮次", "已通过验收项的数量没有超过此前最好结果，就计为无进展；达到上限交回主代理。")
}
SETTINGS_PROPERTIES = {key: {**copy.deepcopy(POLICY_SCHEMA["properties"][key]), "title": label, "description": description}
                       for key, (label, description) in SETTINGS_LABELS.items()}
for tier in TIERS:
    for field, title, description in (
        ("model", "模型", "填写模型标识；实际可用模型由当前 Codex 宿主决定，不可用时不会静默回退。"),
        ("reasoning_effort", "思考等级", "选择该模型支持的思考等级；模型和思考等级可分别调整。")
    ):
        SETTINGS_PROPERTIES[f"{tier}_{field}"] = {**copy.deepcopy(PROFILE["properties"][field]), "title": title, "description": description}
SETTINGS_OUTPUT = obj({"schema": {"type": "object"}, "values": {"type": "object"},
                       "layout": {"type": "array", "items": {"type": "object"}}}, ["schema", "values"])
SETTINGS_UPDATE_SCHEMA = obj({"set": {**obj(SETTINGS_PROPERTIES), "minProperties": 1}}, ["set"])
SETTINGS_CAPABILITY = {"readTool": "read_settings", "updateTool": "save_settings"}
ROUTE_SCHEMA = obj({
    "run_id": string(), "task_id": string(), "workspace": string(maxlen=2000),
    "kind": string(["lookup", "summarize", "transform", "implement", "debug", "review", "brainstorm", "design", "architecture"]),
    "complexity": string(["low", "medium", "high"]), "risk": string(["low", "medium", "high"]),
    "routing_rationale": string(maxlen=2000),
    "available_models": CAPABILITIES, "reserve": {"type": "boolean"}, "request_id": string(),
    "retry_reason": string(["fix_failed_criteria", "missing_context", "reasoning_gap", "infrastructure", "model_unavailable"]),
    "evidence": string(maxlen=2000), "next_action": string(maxlen=2000), "acceptance_criteria": ACCEPTANCE_CRITERIA,
    "requested_tier": string(TIERS), "user_override": string(maxlen=2000)
}, ["run_id", "task_id", "workspace", "kind", "complexity", "risk", "routing_rationale", "available_models", "acceptance_criteria"])
TOOLS = [
    ("read_settings", "Read native plugin-management settings: schema, effective values and grouped layout. No conversation is required.", obj({})),
    ("save_settings", "Persist changed fields submitted by the native plugin-management controls. Preserves other settings, usage records and the main model.", SETTINGS_UPDATE_SCHEMA),
    ("get_policy", "Read subagent model/effort profiles, admission limits and local storage path.", obj({})),
    ("update_policy", "Update persistent routing settings only when user requests a policy change. Does not change Codex config or the main model.", obj({"patch": PATCH_SCHEMA, "reason": string(maxlen=1000)}, ["patch", "reason"])),
    ("route_task", "Select model and reasoning effort for a bounded native subagent. Preview by default; reserve=true atomically admits one attempt. Pass current host capabilities, never assumed account access.", ROUTE_SCHEMA),
    ("record_attempt", "Bind a native agent or record coordinator acceptance after it ends. passed/failed requires a verdict and evidence for every original criterion. Returns complete, revise_plan or handoff; unknown usage may be omitted.", obj({
        "attempt_id": string(), "status": string(["running", "passed", "failed", "blocked", "cancelled"]),
        "agent_id": string(), "summary": string(maxlen=3000), "evidence": string(maxlen=3000), "usage": USAGE,
        "actual_model": string(), "actual_effort": string(EFFORTS), "acceptance_results": ACCEPTANCE_RESULTS
    }, ["attempt_id", "status"])),
    ("report_usage", "Show execution rounds, acceptance results, progress and reported usage. Unknown usage remains unknown; no estimated token budgets.", obj({"run_id": string(), "limit": integer(1, 100)}, []))
]
SCHEMAS = {name: schema for name, _, schema in TOOLS}


class Router:
    def __init__(self, home=None):
        self.home = Path(home or os.environ.get("SUBAGENT_ROUTER_HOME", str(Path.home() / ".codex" / "subagent-budget-router")))

    def connect(self):
        self.home.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.home / "ledger.sqlite3", timeout=15)
        db.row_factory = sqlite3.Row
        db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
          workspace TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS policy_events (created REAL NOT NULL, reason TEXT NOT NULL, value TEXT NOT NULL);
        """)
        return db

    def policy(self, db):
        row = db.execute("SELECT value FROM settings WHERE id=1").fetchone()
        saved = json.loads(row[0]) if row else {}
        # Project legacy policies onto the active schema without modifying the
        # user's ledger on read. Preserve models, efforts, concurrency and history.
        saved = {key: value for key, value in saved.items() if key in DEFAULTS}
        if "profiles" in saved:
            saved["profiles"] = {tier: {k: v for k, v in profile.items() if k in ("model", "reasoning_effort")}
                                 for tier, profile in saved["profiles"].items() if tier in TIERS}
        return merge(DEFAULTS, saved)

    def call(self, name, args):
        if name not in SCHEMAS:
            raise ValueError("Unknown tool")
        validate(args, SCHEMAS[name])
        # Opening the native settings page must not create a database or mutate
        # the ledger. Reads use SQLite's read-only mode when a ledger exists.
        if name == "read_settings":
            path = self.home / "ledger.sqlite3"
            if not path.exists():
                return self.settings_result(copy.deepcopy(DEFAULTS))
            db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                return self.settings_result(self.policy(db))
            finally:
                db.close()
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            result = getattr(self, name)(db, **args)
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def get_policy(self, db):
        return {"policy": self.policy(db), "storage": str(self.home), "limits": LIMIT_NOTE,
                "cost_basis": "No default prices. Price estimates require user-configured rates and reported usage; never equivalent to subscription charges."}

    @staticmethod
    def settings_result(policy):
        values = {key: policy[key] for key in SETTINGS_LABELS}
        for tier in TIERS:
            values.update({f"{tier}_{key}": value for key, value in policy["profiles"][tier].items()})
        groups = [("分派策略", ["mode", "max_auto_tier"]),
                  ("验收与防循环（跨聊天保存，下一轮生效）", [key for key in SETTINGS_LABELS if key not in ("mode", "max_auto_tier")])]
        for tier, label in zip(TIERS, ["轻量档 · light", "标准档 · standard", "深度档 · deep", "专家档 · expert"]):
            groups.append((label, [f"{tier}_{field}" for field in ("model", "reasoning_effort")]))
        return {"schema": obj(copy.deepcopy(SETTINGS_PROPERTIES)), "values": values,
                "layout": [{"kind": "group", "title": title, "items": [{"kind": "property", "property": key} for key in keys]}
                           for title, keys in groups]}

    def save_settings(self, db, **args):
        changes = args["set"]
        if not changes:
            raise ValueError("请至少修改一项设置。")
        patch = {}
        for key, value in changes.items():
            if key in SETTINGS_LABELS:
                patch[key] = value
            else:
                tier, field = key.split("_", 1)
                patch.setdefault("profiles", {}).setdefault(tier, {})[field] = value
        result = self.update_policy(db, patch, "用户通过插件管理设置修改配置")
        return {"values": self.settings_result(result["policy"])["values"]}

    def update_policy(self, db, patch, reason):
        policy = merge(self.policy(db), patch)
        validate(policy, POLICY_SCHEMA)
        db.execute("INSERT OR REPLACE INTO settings VALUES (1, ?)", (json.dumps(policy),))
        db.execute("INSERT INTO policy_events VALUES (?, ?, ?)", (time.time(), reason, json.dumps(policy)))
        return {"policy": policy, "limits": LIMIT_NOTE}

    def rows(self, db, run_id=None):
        if run_id:
            rows = db.execute("SELECT data FROM attempts WHERE run_id=? ORDER BY rowid", (run_id,))
        else:
            rows = db.execute("SELECT data FROM attempts ORDER BY rowid")
        return [json.loads(row[0]) for row in rows]

    @staticmethod
    def accounted(row):
        usage = row.get("usage")
        return usage["input_tokens"] + usage["output_tokens"] if usage else None

    def route_task(self, db, **a):
        policy = self.policy(db)
        if not a["routing_rationale"].strip():
            raise ValueError("routing_rationale must explain the task classification")
        if any(not c.strip() for c in a["acceptance_criteria"]) or len(set(a["acceptance_criteria"])) != len(a["acceptance_criteria"]):
            raise ValueError("Acceptance criteria must be nonblank and unique")
        reserve = a.get("reserve", False)
        if reserve and not a.get("request_id"):
            raise ValueError("reserve=true requires a unique request_id; reuse it only to recover the same request")
        if a.get("request_id"):
            old = db.execute("SELECT data FROM attempts WHERE request_id=?", (a["request_id"],)).fetchone()
            if old:
                row = json.loads(old[0])
                if row["request"] != a:
                    raise ValueError("request_id already used with different arguments")
                return {"decision": "existing", "attempt": row, "do_not_spawn_again": True}
        all_rows = self.rows(db)
        run = [x for x in all_rows if x["run_id"] == a["run_id"]]
        if run and any(x["workspace"] != a["workspace"] for x in run):
            raise ValueError("run_id already belongs to another workspace")
        task = [x for x in run if x["task_id"] == a["task_id"]]

        def deny(reason):
            return {"decision": "coordinator", "reason": reason, "limits": LIMIT_NOTE}

        if task and task[-1]["status"] == "passed":
            return deny("Task already passed; use a new task ID only for a genuinely new objective.")
        if task and task[-1]["status"] in ("reserved", "running"):
            return deny("An attempt for this task is still active; reconcile its native state before retrying.")
        if task and task[0].get("acceptance_criteria") != a["acceptance_criteria"]:
            return deny("Keep the original acceptance criteria; legacy tasks without criteria must be handed back to the coordinator for review.")
        if task and task[-1].get("no_progress_rounds", 0) >= policy["max_no_progress_rounds"]:
            return deny("Acceptance progress has stalled for the configured number of rounds. Hand back the failed criteria and evidence; do not retry automatically.")
        if len(task) >= policy["max_attempts_per_task"] or len(run) >= policy["max_attempts_per_run"]:
            return deny("Attempt limit reached.")
        active = sum(x["status"] in ("reserved", "running") for x in all_rows)
        if active >= policy["max_concurrent"]:
            return deny("Global admission concurrency is full. Wait for an active native agent; do not release a running reservation.")

        # Required capability comes before cost preference. Design/architecture
        # agents propose alternatives; the coordinator retains final decisions.
        if a["kind"] in ("brainstorm", "design", "architecture"):
            tier = "expert"
        elif a["complexity"] == "high" or a["risk"] == "high":
            tier = "deep"
        elif a["complexity"] == "low" and a["risk"] == "low":
            tier = "light"
        else:
            tier = "standard"
        if policy["mode"] == "quality" and tier == "light":
            tier = "standard"
        if a.get("requested_tier"):
            if not a.get("user_override"):
                raise ValueError("requested_tier needs the user's explicit choice in user_override")
            tier = a["requested_tier"]
        elif a.get("user_override"):
            raise ValueError("user_override requires requested_tier")
        escalations = task[-1]["escalations"] if task else 0
        if task:
            reason = a.get("retry_reason")
            if not reason or not a.get("evidence") or not a.get("next_action"):
                return deny("Retry requires a reason, evidence and a concrete changed next_action targeting unmet criteria.")
            if task[-1].get("request", {}).get("next_action") == a["next_action"]:
                return deny("The next action repeats the previous retry plan. Hand back or provide a genuinely changed approach.")
            if reason in ("infrastructure", "model_unavailable"):
                return deny("Resolve environment/model access first; a larger model does not repair this failure.")
            old_tier = task[-1]["tier"]
            if not a.get("requested_tier"):
                tier = old_tier
                if reason == "reasoning_gap":
                    if policy["mode"] == "economy":
                        return deny("Economy mode requires an explicit user tier override for escalation.")
                    old_config = (task[-1]["model"], task[-1]["reasoning_effort"])
                    candidates = [t for t in TIERS[TIERS.index(old_tier) + 1:]
                                  if (policy["profiles"][t]["model"], policy["profiles"][t]["reasoning_effort"]) != old_config]
                    if not candidates:
                        return deny("No higher tier with a different model/effort is available.")
                    tier = candidates[0]
            if TIERS.index(tier) > TIERS.index(old_tier):
                escalations += 1
        if escalations > policy["max_escalations_per_task"]:
            return deny("Escalation limit reached; change policy only if the user requests it.")
        if TIERS.index(tier) > TIERS.index(policy["max_auto_tier"]) and not a.get("user_override"):
            return {**deny("Task requires a tier above the automatic ceiling. Do not silently downgrade; hand the recommendation to the coordinator."),
                    "recommended_tier": tier, "automatic_ceiling": policy["max_auto_tier"], "routing_rationale": a["routing_rationale"]}
        profile = policy["profiles"][tier]
        supported = any(x["model"] == profile["model"] and profile["reasoning_effort"] in x["efforts"] for x in a["available_models"])
        if not supported:
            return deny(f"Configured {profile['model']}/{profile['reasoning_effort']} is not in the supplied host capabilities. No silent fallback or parent-model inheritance.")
        row = {"id": str(uuid.uuid4()), "run_id": a["run_id"], "task_id": a["task_id"], "workspace": a["workspace"],
               "status": "reserved", "tier": tier, "model": profile["model"], "reasoning_effort": profile["reasoning_effort"],
               "acceptance_criteria": a["acceptance_criteria"], "round": len(task) + 1,
               "no_progress_rounds": task[-1].get("no_progress_rounds", 0) if task else 0,
               "escalations": escalations, "routing_rationale": a["routing_rationale"], "created": time.time(), "request": a,
               "price_snapshot": policy["prices_usd_per_million"].get(profile["model"])}
        if reserve:
            db.execute("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (row["id"], a["request_id"], row["run_id"], row["task_id"], row["workspace"], row["status"], json.dumps(row)))
        return {"decision": "admitted" if reserve else "preview", "attempt": row if reserve else None,
                "tier": tier, "spawn": {"model": profile["model"], "reasoning_effort": profile["reasoning_effort"], "fork_turns": "none"},
                "round": len(task) + 1, "max_rounds": policy["max_attempts_per_task"],
                "acceptance_criteria": a["acceptance_criteria"],
                "reason": f"{policy['mode']} policy; {a['kind']}, complexity={a['complexity']}, risk={a['risk']}; {a['routing_rationale']}",
                "limits": LIMIT_NOTE}

    def record_attempt(self, db, attempt_id, status, **fields):
        found = db.execute("SELECT data FROM attempts WHERE id=?", (attempt_id,)).fetchone()
        if not found:
            raise ValueError("Unknown attempt")
        row = json.loads(found[0])
        if row["status"] not in ("reserved", "running"):
            if status == row["status"] and all(row.get(k) == v for k, v in fields.items()):
                return {"attempt": row, "duplicate": True}
            raise ValueError("Terminal attempt is immutable; do not relabel failures or add duplicate usage")
        if status == "running" and not (fields.get("agent_id") or row.get("agent_id")):
            raise ValueError("running requires actual native agent_id")
        if status != "running" and not fields.get("summary"):
            raise ValueError("Terminal result requires summary")
        if status in ("passed", "failed") and not fields.get("evidence"):
            raise ValueError("passed/failed requires evidence, including what was and was not verified")
        if status in ("passed", "failed") and row.get("acceptance_criteria"):
            results = fields.get("acceptance_results", [])
            criteria = row["acceptance_criteria"]
            if len(results) != len(criteria) or {r["criterion"] for r in results} != set(criteria):
                raise ValueError("Report exactly one verdict and evidence for every original acceptance criterion")
            passed_count = sum(r["verdict"] == "passed" for r in results)
            if (status == "passed") != (passed_count == len(criteria)):
                raise ValueError("passed requires all acceptance criteria passed; failed requires at least one unmet or unchecked criterion")
            prior = [r for r in self.rows(db, row["run_id"]) if r["task_id"] == row["task_id"] and r["id"] != row["id"]]
            best = max((r.get("passed_count", 0) for r in prior), default=0)
            row["passed_count"] = passed_count
            row["no_progress_rounds"] = 0 if status == "passed" or passed_count > best else row.get("no_progress_rounds", 0) + 1
        if fields.get("usage", {}).get("cached_input_tokens", 0) > fields.get("usage", {}).get("input_tokens", 0):
            raise ValueError("cached_input_tokens must be a subset of input_tokens")
        if status == "running" and fields.get("usage"):
            raise ValueError("Report total per-attempt usage only at termination, not incremental snapshots")
        for key in ("agent_id", "actual_model", "actual_effort"):
            if row.get(key) and fields.get(key) and row[key] != fields[key]:
                raise ValueError(f"{key} cannot change within an attempt")
        row.update(fields)
        row["status"] = status
        row["updated"] = time.time()
        row["configuration_mismatch"] = ((row.get("actual_model", row["model"]) != row["model"]) or
                                         (row.get("actual_effort", row["reasoning_effort"]) != row["reasoning_effort"]))
        policy = self.policy(db)
        if status == "passed":
            row["next_step"] = "complete"
        elif status in ("blocked", "cancelled"):
            row["next_step"] = "handoff"
        elif status == "failed":
            run_rows = self.rows(db, row["run_id"])
            rounds = len([r for r in run_rows if r["task_id"] == row["task_id"]])
            row["next_step"] = "handoff" if (rounds >= policy["max_attempts_per_task"] or
                                               len(run_rows) >= policy["max_attempts_per_run"] or
                                               row.get("no_progress_rounds", 0) >= policy["max_no_progress_rounds"]) else "revise_plan"
        else:
            row["next_step"] = "await_result"
        db.execute("UPDATE attempts SET status=?, data=? WHERE id=?", (status, json.dumps(row), attempt_id))
        return {"attempt": row, "limits": LIMIT_NOTE}

    def report_usage(self, db, run_id=None, limit=30):
        rows = self.rows(db, run_id)
        costs = []
        compact = []
        for row in rows:
            usage, price = row.get("usage"), row.get("price_snapshot")
            cost = None
            if usage and price and not row.get("configuration_mismatch"):
                cost = ((usage["input_tokens"] - usage["cached_input_tokens"]) * price["input"] +
                        usage["cached_input_tokens"] * price["cached_input"] + usage["output_tokens"] * price["output"]) / 1000000
                costs.append(cost)
            compact.append({k: row.get(k) for k in ("id", "run_id", "task_id", "status", "tier", "model", "reasoning_effort", "actual_model", "actual_effort", "agent_id", "configuration_mismatch", "summary", "round", "acceptance_criteria", "acceptance_results", "passed_count", "no_progress_rounds", "next_step", "routing_rationale")})
            compact[-1].update({"reported_tokens": self.accounted(row), "usage_basis": "reported" if usage else "unknown",
                                "price_estimate_usd": cost, "price_source": price, "usage": usage})
        reported = [x for x in rows if x.get("usage")]
        return {"count": len(rows), "active": sum(x["status"] in ("reserved", "running") for x in rows),
                "reported_usage_attempts": len(reported), "unknown_usage_attempts": len(rows) - len(reported),
                "reported_tokens": sum(self.accounted(x) for x in reported),
                "priced_attempts": len(costs), "unpriced_attempts": len(rows) - len(costs),
                "partial_price_estimate_usd": sum(costs) if costs else None,
                "billing": "Not a bill. Unknown usage is never zero; configured API rates do not represent ChatGPT subscription consumption.",
                "attempts": compact[-limit:], "limits": LIMIT_NOTE}


def serve(router):
    for line in sys.stdin:
        req = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("Expected JSON-RPC object")
            if "id" not in req:
                continue
            method = req.get("method")
            if method == "initialize":
                version = req.get("params", {}).get("protocolVersion")
                result = {"protocolVersion": version if version in ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25") else "2025-11-25",
                          "capabilities": {"tools": {}, "experimental": {"openai/settings": SETTINGS_CAPABILITY}},
                          "serverInfo": {"name": "subagent-budget-router", "version": "0.4.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                definitions = []
                for n, d, s in TOOLS:
                    tool = {"name": n, "description": d, "inputSchema": s,
                            "annotations": {"readOnlyHint": n in ("get_policy", "report_usage", "read_settings"), "destructiveHint": False, "openWorldHint": False}}
                    if n == "read_settings":
                        tool.update({"title": "子代理配置", "outputSchema": SETTINGS_OUTPUT})
                    elif n == "save_settings":
                        tool.update({"title": "保存子代理配置", "outputSchema": obj({"values": {"type": "object"}}, ["values"])})
                    definitions.append(tool)
                result = {"tools": definitions}
            elif method == "tools/call":
                try:
                    p = req.get("params", {})
                    data = router.call(p.get("name"), p.get("arguments", {}))
                    result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data, "isError": False}
                except (ValueError, TypeError, sqlite3.Error, OSError) as exc:
                    result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
                continue
            response = {"jsonrpc": "2.0", "id": req["id"], "result": result}
        except (ValueError, TypeError) as exc:
            response = {"jsonrpc": "2.0", "id": req.get("id") if isinstance(req, dict) else None,
                        "error": {"code": -32700, "message": str(exc)}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", help="Override ledger directory (use for isolated verification)")
    parser.add_argument("--call", choices=list(SCHEMAS))
    parser.add_argument("--input", help="JSON argument file for CLI invocation")
    options = parser.parse_args()
    instance = Router(options.home)
    if options.call:
        payload = json.loads(Path(options.input).read_text(encoding="utf-8-sig")) if options.input else {}
        print(json.dumps(instance.call(options.call, payload), ensure_ascii=False, indent=2))
    else:
        serve(instance)
