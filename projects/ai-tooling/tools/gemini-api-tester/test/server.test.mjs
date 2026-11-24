import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, probe, validate, redact, connectionFailure } from '../server.mjs';
import { createMock } from './mock-service.mjs';

const mock = createMock();
const app = createServer();
let base, local;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
before(async () => { await listen(mock.server); await listen(app); base = `http://127.0.0.1:${mock.server.address().port}`; local = `http://127.0.0.1:${app.address().port}`; });
after(async () => { await close(mock.server); await close(app); });
const config = extra => ({ protocol: 'gemini', baseUrl: base + '/v1beta', key: 'fake-valid-key', model: 'mock-flash', ...extra });

test('normalizes root base URLs and models prefix, preserves custom paths', () => {
  assert.equal(validate(config({ baseUrl: base })).base, base + '/v1beta');
  assert.equal(validate(config({ baseUrl: base, protocol: 'openai' })).base, base + '/v1');
  assert.equal(validate(config({ baseUrl: base + '/custom/v1beta///', model: 'models/mock-pro' })).model, 'mock-pro');
  assert.equal(validate(config({ baseUrl: base + '/custom/v1beta///' })).base, base + '/custom/v1beta');
});
test('rejects credential URLs, query keys, malformed models and invalid bounds', () => {
  for (const extra of [{ baseUrl: 'file:///secret' }, { baseUrl: 'https://user:pass@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { key: '' }, { key: 'a\nb' }, { protocol: 'unknown' }, { model: '../x' }, { timeout: 0 }, { timeout: 301 }, { maxTokens: 0 }, { prompt: '' }]) assert.throws(() => validate(config(extra)));
});
test('Gemini generation sends correct path, key header and JSON; ignores thoughts', async () => {
  const result = await probe(config());
  assert.equal(result.state, 'success'); assert.equal(result.httpStatus, 200); assert.equal(result.output, 'OK');
  assert.equal(result.usage.promptTokenCount, 5);
  const sent = mock.requests.at(-1);
  assert.equal(sent.path, '/v1beta/models/mock-flash:generateContent'); assert.equal(sent.method, 'POST'); assert.equal(sent.key, 'fake-valid-key');
  assert.equal(sent.body.contents[0].parts[0].text, 'Reply with exactly: OK'); assert.equal(sent.body.generationConfig.maxOutputTokens, 256);
});
test('OpenAI-compatible generation uses Bearer and chat payload', async () => {
  const result = await probe(config({ protocol: 'openai', baseUrl: base + '/v1', model: 'mock-pro', maxTokens: 1024 }));
  assert.equal(result.state, 'success'); assert.equal(result.output, 'OK');
  const sent = mock.requests.at(-1); assert.equal(sent.path, '/v1/chat/completions'); assert.equal(sent.key, 'fake-valid-key'); assert.equal(sent.body.model, 'mock-pro'); assert.equal(sent.body.max_tokens, 1024); assert.equal(sent.body.stream, false);
});
test('Gemini models list follows pagination and filters embeddings', async () => {
  const result = await probe(config({ operation: 'models', model: '' }));
  assert.equal(result.state, 'success'); assert.deepEqual(result.models, ['mock-flash', 'mock-pro']);
  assert.equal(mock.requests.at(-1).search, '?pageToken=page-2');
});
test('OpenAI models list reads data ids', async () => {
  const result = await probe(config({ protocol: 'openai', baseUrl: base + '/v1', operation: 'models' }));
  assert.deepEqual(result.models, ['mock-flash', 'mock-pro']);
});
test('models-only check does not require generation parameters', async () => {
  const result = await probe(config({ operation: 'models', model: '', prompt: '', maxTokens: 0 }));
  assert.equal(result.state, 'success'); assert.equal(result.models.length, 2);
});
test('401 preserves status and redacts echoed Key', async () => {
  const result = await probe(config({ key: 'bad-key' }));
  assert.equal(result.state, 'failed'); assert.equal(result.httpStatus, 401); assert.match(result.message, /权限/); assert.ok(!JSON.stringify(result).includes('bad-key')); assert.match(result.raw, /REDACTED/);
});
test('429 retains Retry-After and quota diagnosis', async () => {
  const result = await probe(config({ key: 'quota-key' }));
  assert.equal(result.httpStatus, 429); assert.equal(result.retryAfter, '60'); assert.match(result.message, /配额/);
});
test('HTTP 200 with no visible text is a warning, not a success', async () => {
  const result = await probe(config({ model: 'empty' }));
  assert.equal(result.state, 'warning'); assert.match(result.message, /MAX_TOKENS/);
});
test('HTML success responses are identified as invalid API responses', async () => {
  const result = await probe(config({ key: 'html-key' })); assert.equal(result.state, 'failed'); assert.match(result.message, /不是 JSON/);
});
test('redirect never forwards Key to another route', async () => {
  const count = mock.requests.length; const result = await probe(config({ key: 'redirect-key' }));
  assert.equal(result.httpStatus, 302); assert.equal(mock.requests.length, count + 1); assert.match(result.message, /重定向/);
});
test('timeout aborts upstream request', async () => {
  const result = await probe(config({ key: 'slow-key', timeout: 1 })); assert.equal(result.state, 'failed'); assert.match(result.message, /超时/); assert.ok(result.durationMs < 1200);
});
test('caller cancellation is reported distinctly from timeout', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
  const result = await probe(config({ key: 'slow-key' }), controller.signal); clearTimeout(timer); assert.equal(result.state, 'cancelled');
});
test('redaction handles escaped and URL-encoded Key values', () => {
  const key = 'key/"\\secret'; assert.ok(!redact(JSON.stringify({ key }), key).includes('secret')); assert.ok(!redact(encodeURIComponent(key), key).includes('secret'));
  assert.equal(redact('https://x/?key=abc&api_key=def'), 'https://x/?key=[REDACTED]&api_key=[REDACTED]');
});
test('network permission errors identify the local layer and do not blame the Key', () => {
  for (const cause of [{ code: 'EACCES' }, { errors: [{ code: 'EPERM' }] }]) {
    const result = connectionFailure({ message: 'fetch failed', cause });
    assert.equal(result.state, 'failed'); assert.match(result.message, /尚未收到 API/); assert.match(result.message, /不能据此判断 Key/);
    assert.ok(['EACCES', 'EPERM'].includes(result.errorCode));
  }
  assert.match(connectionFailure({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }).message, /ENOTFOUND/);
});
test('local server serves UI with security headers and no directory browsing', async () => {
  const response = await fetch(local); assert.equal(response.status, 200); assert.match(await response.text(), /本地连通性测试/); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(local + '/server.mjs')).status, 404); assert.equal((await fetch(local + '/api/health')).status, 200);
});
test('local server rejects cross-origin, non-JSON and invalid input', async () => {
  const post = (headers, body = '{}') => fetch(local + '/api/probe', { method: 'POST', headers, body });
  assert.equal((await post({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await post({ 'Content-Type': 'application/json' }, 'not json')).status, 400);
});
test('local server rejects DNS rebinding Host', async () => {
  const status = await new Promise((resolve, reject) => { const req = http.get(local, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(status, 403);
});
test('full local HTTP proxy request returns structured result without Key', async () => {
  const response = await fetch(local + '/api/probe', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: local }, body: JSON.stringify(config()) });
  const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.state, 'success'); assert.equal(result.output, 'OK'); assert.ok(!JSON.stringify(result).includes('fake-valid-key'));
});
