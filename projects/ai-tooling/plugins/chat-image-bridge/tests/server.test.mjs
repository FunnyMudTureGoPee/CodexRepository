import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "chat-image-bridge-test-"));
const port = 48000 + Math.floor(Math.random() * 1000), token = "test-token";
fs.writeFileSync(path.join(data, "token"), token);
fs.writeFileSync(path.join(data, "jobs.json"), JSON.stringify([{ id: "job_test", status: "pending", prompt: "test", referenceImages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]));
const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url)), "--daemon"], { env: { ...process.env, CHAT_IMAGE_BRIDGE_PORT: String(port), CHAT_IMAGE_BRIDGE_DATA: data }, stdio: "ignore" });
const request = async (route, body, key) => { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-bridge-token": token, ...(key ? { "x-idempotency-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; };
try {
  let ready = false; for (let i = 0; i < 50; i++) { try { if ((await request("/health")).status === 200) { ready = true; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } assert.equal(ready, true, "test daemon must start");
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => request("/jobs/claim", { bridgeId: `bridge_${i}`, capabilities: { referenceImages: false } }, `claim_${i}`)));
  assert.equal(claims.filter((item) => item.body.job).length, 1, "exactly one concurrent claim must win");
  const won = claims.find((item) => item.body.job), leaseId = won.body.lease.id;
  const replay = await request("/jobs/claim", { bridgeId: "replay", capabilities: { referenceImages: false } }, `claim_${claims.indexOf(won)}`);
  assert.equal(replay.body.lease.id, leaseId, "claim retry must return the original lease");
  assert.equal((await request("/jobs/job_test/renew", { leaseId: "wrong" }, "wrong-renew")).status, 409);
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8XkWQAAAABJRU5ErkJggg==";
  assert.equal((await request("/jobs/job_test/candidate", { leaseId, dataUrl: image }, "candidate-once")).status, 200);
  const duplicate = await request("/jobs/job_test/candidate", { leaseId, dataUrl: image }, "candidate-once");
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.idempotent, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(data, "jobs.json"), "utf8")); persisted.push({ id: "job_retry", status: "pending", attempts: 2, prompt: "retry", referenceImages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); fs.writeFileSync(path.join(data, "jobs.json"), JSON.stringify(persisted));
  const retryClaim = await request("/jobs/claim", { bridgeId: "retry-bridge", capabilities: { referenceImages: false } }, "retry-claim");
  assert.equal(retryClaim.body.job.id, "job_retry"); assert.equal(retryClaim.body.job.attempts, 3);
  const released = await request("/jobs/job_retry/release", { leaseId: retryClaim.body.lease.id, code: "TEST_FAILURE", message: "failed again" }, "release-final");
  assert.equal(released.body.job.status, "failed"); assert.match(released.body.job.error, /MAX_ATTEMPTS_EXCEEDED/);
  const afterRelease = JSON.parse(fs.readFileSync(path.join(data, "jobs.json"), "utf8")); afterRelease.push({ id: "job_cancel", status: "pending", attempts: 0, prompt: "cancel", referenceImages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); fs.writeFileSync(path.join(data, "jobs.json"), JSON.stringify(afterRelease));
  const cancelClaim = await request("/jobs/claim", { bridgeId: "cancel-bridge", capabilities: { referenceImages: false } }, "cancel-claim");
  assert.equal(cancelClaim.body.job.id, "job_cancel");
  assert.equal((await request("/jobs/job_cancel/cancel", {}, "cancel-once")).body.job.status, "cancelled");
  const staleRenew = await request("/jobs/job_cancel/renew", { leaseId: cancelClaim.body.lease.id }, "renew-after-cancel");
  assert.equal(staleRenew.status, 409); assert.equal(staleRenew.body.code, "JOB_NOT_GENERATING");
  console.log("server lease/idempotency tests passed");
} finally { child.kill(); fs.rmSync(data, { recursive: true, force: true }); }
