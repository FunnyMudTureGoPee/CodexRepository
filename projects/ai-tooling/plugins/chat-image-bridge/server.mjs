import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CHAT_IMAGE_BRIDGE_PORT || 47831);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.CHAT_IMAGE_BRIDGE_DATA || path.join(os.homedir(), ".chat-image-bridge");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const TOKEN_FILE = path.join(DATA_DIR, "token");
const MANAGER_KEY_FILE = path.join(DATA_DIR, "manager-key");
const WIDGET_URI = "ui://chat-image-bridge/task-manager-v2.html";
const WIDGET_HTML = fs.readFileSync(new URL("./ui/task-manager.html", import.meta.url), "utf8");
const IS_DAEMON = process.argv.includes("--daemon");
const VERSION = "0.4.6";
const LEASE_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 3;
fs.mkdirSync(DATA_DIR, { recursive: true });
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
let jobs = loadJson(JOBS_FILE, []);
let token = process.env.CHAT_IMAGE_BRIDGE_TOKEN || (() => { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { const value = crypto.randomBytes(24).toString("hex"); fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600 }); return value; } })();
const MANAGER_KEY = (() => { try { return fs.readFileSync(MANAGER_KEY_FILE, "utf8").trim(); } catch { const value = crypto.randomBytes(18).toString("hex"); fs.writeFileSync(MANAGER_KEY_FILE, value, { mode: 0o600 }); return value; } })();

async function ensureDaemon() {
  if (IS_DAEMON) return;
  const health = () => fetch(`http://${HOST}:${PORT}/health`, { headers: { "x-bridge-token": token } }).then((r) => r.ok).catch(() => false);
  if (await health()) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => { const task = spawn("schtasks.exe", ["/Run", "/TN", "ChatImageBridge"], { windowsHide: true, stdio: "ignore" }); task.once("error", resolve); task.once("exit", resolve); });
    for (let attempt = 0; attempt < 40; attempt++) { await new Promise((resolve) => setTimeout(resolve, 100)); if (await health()) return; }
  }
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--daemon"], { detached: true, windowsHide: true, stdio: "ignore", env: process.env }).unref();
  for (let attempt = 0; attempt < 40; attempt++) { await new Promise((resolve) => setTimeout(resolve, 100)); if (await health()) return; }
  throw new Error(`无法启动 Chat Image Bridge 后台服务（${HOST}:${PORT}）`);
}

function refreshJobs() { jobs = loadJson(JOBS_FILE, []); }
function saveJobs() { const temp = `${JOBS_FILE}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`; fs.writeFileSync(temp, JSON.stringify(jobs, null, 2)); fs.renameSync(temp, JOBS_FILE); }
const now = () => new Date().toISOString();
const jobById = (id) => jobs.find((job) => job.id === id);
function expireLeases() {
  let changed = false;
  for (const job of jobs) if (job.status === "generating" && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now())) {
    requeueOrFail(job, "LEASE_EXPIRED", "生成租约过期"); changed = true;
  }
  if (changed) saveJobs();
}
function requeueOrFail(job, code, message) {
  const attempts = job.attempts || 0; job.leaseId = null; job.leaseExpiresAt = null; job.updatedAt = now();
  if (attempts >= MAX_ATTEMPTS) { job.status = "failed"; job.error = `MAX_ATTEMPTS_EXCEEDED: ${message}（已尝试 ${attempts} 次）`; job.nextAttemptAt = null; return; }
  const backoffMs = Math.min(30_000 * (2 ** Math.max(0, attempts - 1)), 5 * 60_000); job.status = "pending"; job.error = `${code}: ${message}`; job.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
}
function requireLease(job, leaseId) {
  if (job.status !== "generating") { const error = new Error(`Job is ${job.status}, not generating`); error.code = "JOB_NOT_GENERATING"; throw error; }
  if (!leaseId || job.leaseId !== leaseId) { const error = new Error("Lease does not own this job"); error.code = "LEASE_EXPIRED"; throw error; }
  if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now()) { const error = new Error("Lease has expired"); error.code = "LEASE_EXPIRED"; throw error; }
}
function wasProcessed(job, key) { return Boolean(key && job.idempotencyKeys?.includes(key)); }
function rememberKey(job, key) { if (!key) return; job.idempotencyKeys ||= []; job.idempotencyKeys.push(key); job.idempotencyKeys = job.idempotencyKeys.slice(-20); }
function publicJob(job) { if (!job) return null; const { projectRoot, absoluteOutput, candidatePath, ...safe } = job; return { ...safe, hasCandidate: Boolean(candidatePath && fs.existsSync(candidatePath)) }; }
function resolveInside(root, candidate) {
  const base = path.resolve(root); const target = path.resolve(base, candidate); const relative = path.relative(base, target);
  if (!relative) throw new Error("outputPath must name a file, not the project root");
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path must stay inside projectRoot");
  return target;
}
function createJob(args, action) {
  refreshJobs();
  if (action === "edit") throw new Error("UNSUPPORTED_CAPABILITY: 0.3.0 尚不支持自动上传参考图或图生图");
  if (!args?.prompt?.trim()) throw new Error("prompt is required");
  if (!args?.projectRoot || !path.isAbsolute(args.projectRoot)) throw new Error("projectRoot must be an absolute path");
  if (!args?.outputPath) throw new Error("outputPath is required");
  const absoluteOutput = resolveInside(args.projectRoot, args.outputPath);
  const references = (args.referenceImages || []).map((item) => resolveInside(args.projectRoot, item));
  if (references.length) throw new Error("UNSUPPORTED_CAPABILITY: 当前 Bridge 不支持 referenceImages");
  for (const item of references) if (!fs.existsSync(item)) throw new Error(`Reference image not found: ${item}`);
  const job = { id: `img_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`, action, status: "pending", prompt: args.prompt.trim(), aspectRatio: args.aspectRatio || "auto", transparent: Boolean(args.transparent), projectRoot: path.resolve(args.projectRoot), outputPath: args.outputPath, absoluteOutput, referenceImages: references, parentJobId: args.parentJobId || null, createdAt: now(), updatedAt: now(), error: null };
  jobs.push(job); saveJobs(); return publicJob(job);
}

const jobSchema = { type: ["object", "null"], additionalProperties: true };
const tools = [
  { name: "generate_image", title: "提交生图任务", description: "Use this when the user wants to queue a ChatGPT Web image generation job. Returns immediately.", inputSchema: { type: "object", required: ["prompt", "projectRoot", "outputPath"], properties: { prompt: { type: "string" }, projectRoot: { type: "string" }, outputPath: { type: "string" }, aspectRatio: { type: "string", default: "auto" }, transparent: { type: "boolean", default: false }, referenceImages: { type: "array", items: { type: "string" } } } }, outputSchema: { type: "object", properties: { job: jobSchema }, required: ["job"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, _meta: { "openai/toolInvocation/invoking": "正在提交生图任务…", "openai/toolInvocation/invoked": "生图任务已提交" } },
  { name: "get_image_status", title: "查看图片任务", description: "Use this when the user or task manager needs the latest image-job status.", inputSchema: { type: "object", properties: { jobId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } }, outputSchema: { type: "object", properties: { jobs: { type: "array", items: jobSchema }, stateVersion: { type: "integer" } }, required: ["jobs", "stateVersion"] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: "open_image_manager", title: "打开图片任务管理器", description: "Use this when the user wants an interactive image-job dashboard. After calling it, immediately open the returned managerUrl in the Codex browser panel; do not claim the manager is visible before that succeeds.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } } }, outputSchema: { type: "object", properties: { jobs: { type: "array", items: jobSchema }, stateVersion: { type: "integer" }, managerUrl: { type: "string" } }, required: ["jobs", "stateVersion", "managerUrl"] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI, "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "正在打开任务管理器…", "openai/toolInvocation/invoked": "任务管理器已就绪" } },
  { name: "accept_image", title: "接受候选图片", description: "Use this when the user has approved a reviewed candidate and wants it copied into the project.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } }, outputSchema: { type: "object", properties: { job: jobSchema }, required: ["job"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false } },
  { name: "retry_image", title: "重试图片任务", description: "Use this when the user wants a failed or stalled image job returned to the browser queue.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } }, outputSchema: { type: "object", properties: { job: jobSchema }, required: ["job"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true } },
  { name: "cancel_image", title: "取消图片任务", description: "Use this when the user wants to cancel an unfinished image job.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } }, outputSchema: { type: "object", properties: { job: jobSchema }, required: ["job"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true } }
];

function accept(job) {
  if (!job) throw new Error("Job not found");
  if (job.status !== "review" || !job.candidatePath || !fs.existsSync(job.candidatePath)) throw new Error("Job has no candidate ready for review");
  const asset = path.basename(job.absoluteOutput, path.extname(job.absoluteOutput)).replace(/[^a-zA-Z0-9_-]/g, "-") || "asset";
  const versionDir = path.join(job.projectRoot, ".assets", "images", asset); fs.mkdirSync(versionDir, { recursive: true });
  const existing = fs.readdirSync(versionDir).filter((x) => /^v\d{3}\./.test(x)); const number = existing.length + 1;
  const ext = path.extname(job.candidatePath) || path.extname(job.absoluteOutput) || ".png"; const versionName = `v${String(number).padStart(3, "0")}${ext}`; const versionPath = path.join(versionDir, versionName);
  fs.copyFileSync(job.candidatePath, versionPath); fs.mkdirSync(path.dirname(job.absoluteOutput), { recursive: true }); fs.copyFileSync(versionPath, job.absoluteOutput);
  const manifestPath = path.join(versionDir, "manifest.json"); const manifest = loadJson(manifestPath, { asset, current: null, history: [] });
  manifest.current = versionName; manifest.history.push({ version: number, file: versionName, jobId: job.id, parentJobId: job.parentJobId, prompt: job.prompt, createdAt: now() }); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  job.status = "completed"; job.versionPath = versionPath; job.completedAt = now(); job.updatedAt = now(); saveJobs(); return publicJob(job);
}
async function callTool(name, args = {}) {
  await ensureDaemon();
  refreshJobs();
  if (name === "generate_image") return { job: createJob(args, "generate") };
  if (name === "get_image_status" || name === "open_image_manager") { const selected = args.jobId ? [publicJob(jobById(args.jobId))].filter(Boolean) : jobs.slice(-Math.min(args.limit || (name === "open_image_manager" ? 20 : 10), 50)).reverse().map(publicJob); return { jobs: selected, stateVersion: Date.now(), ...(name === "open_image_manager" ? { managerUrl: `http://${HOST}:${PORT}/manager/${MANAGER_KEY}` } : {}) }; }
  if (name === "accept_image") return { job: accept(jobById(args.jobId)) };
  if (name === "retry_image") { const job = jobById(args.jobId); if (!job) throw new Error("Job not found"); if (job.status === "completed") throw new Error("Completed jobs cannot be retried"); job.status = "pending"; job.error = null; job.attempts = 0; job.nextAttemptAt = null; job.leaseId = null; job.leaseExpiresAt = null; job.updatedAt = now(); saveJobs(); return { job: publicJob(job) }; }
  if (name === "cancel_image") { const job = jobById(args.jobId); if (!job) throw new Error("Job not found"); if (["completed", "cancelled"].includes(job.status)) throw new Error(`Job is already ${job.status}`); job.status = "cancelled"; job.leaseId = null; job.leaseExpiresAt = null; job.claimIdempotencyKey = null; job.updatedAt = now(); saveJobs(); return { job: publicJob(job) }; }
  throw new Error(`Unknown tool: ${name}`);
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
async function handleRpc(message) {
  const { id, method, params } = message;
  if (method === "initialize") return rpcResult(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: "chat-image-bridge", title: "Chat Image Bridge", version: VERSION } });
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools });
  if (method === "resources/list") return rpcResult(id, { resources: [{ uri: WIDGET_URI, name: "图片任务管理器", mimeType: "text/html;profile=mcp-app" }] });
  if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
  if (method === "resources/read" && params?.uri === WIDGET_URI) return rpcResult(id, { contents: [{ uri: WIDGET_URI, name: "图片任务管理器", mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/widgetDescription": "显示 Chat Image Bridge 任务状态，并提供刷新、接受、重试和取消操作。", "openai/widgetPrefersBorder": true } }] });
  if (method === "tools/call") { try { const value = await callTool(params?.name, params?.arguments); const widgetMeta = params?.name === "open_image_manager" ? { _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI } } : {}; return rpcResult(id, { structuredContent: value, content: [{ type: "text", text: params?.name === "open_image_manager" ? `图片任务管理器：${value.jobs.length} 个任务。` : JSON.stringify(value, null, 2) }], ...widgetMeta }); } catch (error) { return rpcResult(id, { content: [{ type: "text", text: error.message }], isError: true }); } }
  if (id !== undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}
if (!IS_DAEMON) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => { if (!line.trim()) return; try { const response = await handleRpc(JSON.parse(line)); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); } catch (error) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } })}\n`); } });
}

function sendJson(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-bridge-token,x-idempotency-key", "access-control-allow-methods": "GET,POST,OPTIONS" }); res.end(status === 204 ? "" : JSON.stringify(body)); }
function readBody(req, max = 25 * 1024 * 1024) { return new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on("data", (chunk) => { size += chunk.length; if (size > max) { reject(new Error("Payload too large")); req.destroy(); } else chunks.push(chunk); }); req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
const api = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const managerMatch = url.pathname.match(/^\/manager\/([^/]+)$/);
    if (req.method === "GET" && managerMatch?.[1] === MANAGER_KEY) { const html = WIDGET_HTML.replace("const standalone=null;", `const standalone=${JSON.stringify({ key: MANAGER_KEY })};`); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(html); }
    const managerAuthorized = url.searchParams.get("key") === MANAGER_KEY;
    const candidateFileMatch = url.pathname.match(/^\/jobs\/([^/]+)\/candidate-file$/);
    if (req.method === "GET" && managerAuthorized && candidateFileMatch) { refreshJobs(); const job = jobById(candidateFileMatch[1]); if (!job?.candidatePath || !fs.existsSync(job.candidatePath)) return sendJson(res, 404, { error: "Candidate not found" }); const ext = path.extname(job.candidatePath).toLowerCase(); const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png"; res.writeHead(200, { "content-type": mime, "cache-control": "no-store" }); return fs.createReadStream(job.candidatePath).pipe(res); }
    if (req.headers["x-bridge-token"] !== token && !managerAuthorized) return sendJson(res, 401, { error: "Invalid bridge token" });
    refreshJobs();
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION, capabilities: { textToImage: true, referenceImages: false, imageToImage: false, aspectRatio: "validated", transparent: "validated", exactlyOneImage: "validated" } });
    if (req.method === "GET" && url.pathname === "/jobs") return sendJson(res, 200, { jobs: jobs.slice(-50).reverse().map(publicJob), stateVersion: Date.now() });
    if (req.method === "POST" && url.pathname === "/jobs/claim") {
      const body = await readBody(req), claimKey = String(req.headers["x-idempotency-key"] || ""); expireLeases();
      let migrated = false; for (const item of jobs) if (item.status === "pending" && (item.attempts || 0) >= MAX_ATTEMPTS) { item.status = "failed"; item.error = `MAX_ATTEMPTS_EXCEEDED: 已尝试 ${item.attempts} 次`; item.nextAttemptAt = null; item.updatedAt = now(); migrated = true; } if (migrated) saveJobs();
      const previous = claimKey && jobs.find((item) => item.claimIdempotencyKey === claimKey && item.status === "generating" && Date.parse(item.leaseExpiresAt) > Date.now());
      if (previous) return sendJson(res, 200, { job: publicJob(previous), lease: { id: previous.leaseId, expiresAt: previous.leaseExpiresAt }, idempotent: true });
      const job = jobs.find((item) => item.status === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now()) && (!item.referenceImages?.length || body.capabilities?.referenceImages));
      if (!job) return sendJson(res, 200, { job: null, lease: null });
      const leaseId = `lease_${crypto.randomUUID()}`; job.status = "generating"; job.leaseId = leaseId; job.claimIdempotencyKey = claimKey || null; job.leaseOwner = body.bridgeId || null; job.leaseTabId = body.tabId || null; job.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString(); job.updatedAt = now(); job.error = null; job.attempts = (job.attempts || 0) + 1; saveJobs();
      return sendJson(res, 200, { job: publicJob(job), lease: { id: leaseId, expiresAt: job.leaseExpiresAt } });
    }
    const match = url.pathname.match(/^\/jobs\/([^/]+)\/(candidate|fail|retry|release|renew|accept|cancel)$/);
    if (match && req.method === "POST") {
      const job = jobById(match[1]); if (!job) return sendJson(res, 404, { error: "Job not found", code: "JOB_NOT_FOUND" }); const body = await readBody(req); const key = String(req.headers["x-idempotency-key"] || "");
      if (wasProcessed(job, key)) return sendJson(res, 200, { job: publicJob(job), idempotent: true });
      if (["candidate", "fail", "release", "renew"].includes(match[2])) requireLease(job, body.leaseId);
      rememberKey(job, key);
      if (match[2] === "candidate") { const encoded = String(body.dataUrl || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s); if (!encoded) throw new Error("candidate requires a PNG, JPEG, or WebP dataUrl"); const ext = encoded[1] === "image/jpeg" ? ".jpg" : `.${encoded[1].split("/")[1]}`; const dir = path.join(DATA_DIR, "candidates"); fs.mkdirSync(dir, { recursive: true }); job.candidatePath = path.join(dir, `${job.id}${ext}`); fs.writeFileSync(job.candidatePath, Buffer.from(encoded[2], "base64")); job.sourceUrl = body.sourceUrl || null; job.metadata = body.metadata || null; job.status = "review"; job.leaseId = null; job.leaseExpiresAt = null; job.updatedAt = now(); saveJobs(); }
      else if (match[2] === "fail") { job.status = "failed"; job.error = `${body.code || "IMAGE_GENERATION_FAILED"}: ${body.message || "Browser automation failed"}`; job.leaseId = null; job.leaseExpiresAt = null; job.updatedAt = now(); saveJobs(); }
      else if (match[2] === "release") { requeueOrFail(job, body.code || "RELEASED", body.message || "Lease released"); saveJobs(); }
      else if (match[2] === "renew") { job.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString(); job.updatedAt = now(); saveJobs(); }
      else if (match[2] === "retry") { job.status = "pending"; job.error = null; job.attempts = 0; job.nextAttemptAt = null; job.leaseId = null; job.leaseExpiresAt = null; job.updatedAt = now(); saveJobs(); }
      else if (match[2] === "accept") accept(job);
      else { if (!["completed", "cancelled"].includes(job.status)) { job.status = "cancelled"; job.leaseId = null; job.leaseExpiresAt = null; job.claimIdempotencyKey = null; job.updatedAt = now(); saveJobs(); } }
      return sendJson(res, 200, { job: publicJob(job) });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) { sendJson(res, ["LEASE_EXPIRED", "JOB_NOT_GENERATING"].includes(error.code) ? 409 : 400, { error: error.message, code: error.code || "BAD_REQUEST" }); }
});
if (IS_DAEMON) {
  api.on("error", (error) => { process.stderr.write(`Bridge HTTP error: ${error.message}\n`); process.exitCode = 1; });
  api.listen(PORT, HOST, () => process.stderr.write(`Chat Image Bridge daemon listening on http://${HOST}:${PORT}; token: ${TOKEN_FILE}\n`));
}
