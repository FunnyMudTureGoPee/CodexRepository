import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/key-parser.js', ['key-parser.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const LIMIT = 2 * 1024 * 1024;

export function redact(value, key) {
  let text = String(value ?? '');
  if (key) {
    for (const secret of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text.replace(/([?&](?:key|api_key|apikey)=)[^\s&"<>]+/gi, '$1[REDACTED]');
}

export function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('请求内容必须为 JSON 对象');
  const { protocol, baseUrl, key, model, operation = 'generate' } = input;
  if (!['gemini', 'openai'].includes(protocol)) throw new Error('请选择 Gemini 原生或 OpenAI 兼容协议');
  if (!['generate', 'models'].includes(operation)) throw new Error('不支持的测试方式');
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('请输入有效的 API Key');
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('API 地址格式不正确'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('API 地址必须使用 http/https，且不能包含账号、查询参数或 #');
  }
  base.pathname = base.pathname.replace(/\/+$/, '');
  if (protocol === 'gemini' && base.pathname === '/') base.pathname = '/v1beta';
  if (protocol === 'openai' && base.pathname === '/') base.pathname = '/v1';
  const normalizedModel = typeof model === 'string' ? model.trim().replace(/^models\//, '') : '';
  if (operation === 'generate' && (!normalizedModel || normalizedModel.length > 200 || /[\s/?#]/.test(normalizedModel))) throw new Error('模型名称无效；请填模型 ID，不要填完整 URL');
  const timeout = Number(input.timeout ?? 30);
  const maxTokens = Number(input.maxTokens ?? 256);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error('超时必须为 1–300 秒');
  if (operation === 'generate' && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)) throw new Error('输出 Token 上限必须为 1–8192');
  const prompt = input.prompt ?? 'Reply with exactly: OK';
  if (operation === 'generate' && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000)) throw new Error('测试提示词不能为空，最多 20000 个字符');
  return { protocol, base: base.href.replace(/\/$/, ''), key: key.trim(), model: normalizedModel, operation, timeout, maxTokens, prompt };
}

async function readLimited(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('响应或请求超过 2 MB 限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hintFor(status) {
  if ([401, 403].includes(status)) return '检查 Key、权限、来源限制和地区限制。';
  if (status === 404) return '检查 API 基础地址、协议、模型 ID 及该模型是否开放。';
  if (status === 429) return '配额耗尽或触发频率限制；降低并发，检查余额/配额。';
  if (status === 400) return '请求参数不被接受；检查模型、协议及输出 Token 设置。';
  if (status >= 500) return '上游服务异常，可以稍后重试。';
  if (status >= 300 && status < 400) return '接口返回重定向。为保护 Key 未跟随跳转，请直接填写最终 API 基础地址。';
  return '查看响应详情并检查服务商配置。';
}

export function connectionFailure(error) {
  const code = error.cause?.code || error.cause?.errors?.find(item => item.code)?.code || error.code;
  if (['EACCES', 'EPERM'].includes(code)) return {
    state: 'failed', errorCode: code,
    message: `本机网络连接被运行环境或防火墙拒绝（${code}），尚未收到 API 的 HTTP 响应，不能据此判断 Key 有效性。如果服务由 Codex 沙箱启动，请改在本机终端运行 start.cmd，并确认代理与网络权限。`,
  };
  return { state: 'failed', errorCode: code ?? null, message: `连接失败：${error.message}${code ? ` (${code})` : ''}。检查网络、代理、TLS 证书和 API 地址。` };
}

export async function probe(input, parentSignal) {
  const config = validate(input);
  const { protocol, base, key, model, operation, timeout, maxTokens, prompt } = config;
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
  const cancel = () => controller.abort();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  if (parentSignal?.aborted) cancel();
  const headers = protocol === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
  const suffix = operation === 'models' ? '/models' : protocol === 'gemini' ? `/models/${encodeURIComponent(model)}:generateContent` : '/chat/completions';
  const endpoint = base + suffix;
  const body = operation === 'models' ? undefined : protocol === 'gemini' ? {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  } : { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false };
  let httpStatus = null;
  let raw = '';
  const finish = (data) => ({ ...data, message: redact(data.message, key), ...(data.output !== undefined ? { output: redact(data.output, key) } : {}), httpStatus, endpoint, durationMs: Math.round(performance.now() - started), timestamp: new Date().toISOString() });
  try {
    let next = endpoint;
    const models = [];
    const seenTokens = new Set();
    let pages = 0;
    while (next) {
      const response = await fetch(next, {
        method: operation === 'models' ? 'GET' : 'POST',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      httpStatus = response.status;
      const originalRaw = await readLimited(response.body);
      raw = redact(originalRaw, key);
      let data;
      try { data = JSON.parse(originalRaw); } catch {
        return finish({ state: 'failed', message: response.ok ? 'HTTP 成功，但返回的不是 JSON；请检查 API 地址是否指向网页。' : `HTTP ${httpStatus}：${hintFor(httpStatus)}`, raw });
      }
      if (!response.ok || data.error) {
        const message = data.error?.message ?? (typeof data.error === 'string' ? data.error : data.message);
        return finish({ state: 'failed', message: `${message || `HTTP ${httpStatus}`}\n${hintFor(httpStatus)}`, raw, retryAfter: response.headers.get('retry-after') });
      }
      if (operation === 'models') {
        const list = protocol === 'gemini' ? data.models : data.data;
        if (!Array.isArray(list)) return finish({ state: 'failed', message: 'HTTP 成功，但响应中缺少模型列表；请检查协议。', raw });
        for (const item of list) {
          if (protocol === 'gemini' && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent')) continue;
          const id = protocol === 'gemini' ? item.name?.replace(/^models\//, '') : item.id;
          if (typeof id === 'string' && id) models.push(id);
        }
        pages++;
        const token = protocol === 'gemini' ? data.nextPageToken : null;
        if (token && (seenTokens.has(token) || pages >= 20)) return finish({ state: 'warning', message: '已读取部分模型，分页重复或超过 20 页；模型列表可能不完整。', models: [...new Set(models)], raw });
        if (token) {
          seenTokens.add(token);
          const url = new URL(endpoint);
          url.searchParams.set('pageToken', token);
          next = url.href;
        } else next = null;
      } else {
        const candidate = data.candidates?.[0];
        const output = protocol === 'gemini'
          ? (candidate?.content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n')
          : data.choices?.[0]?.message?.content;
        const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map(part => part.text ?? '').join('\n') : '';
        const finishReason = protocol === 'gemini' ? candidate?.finishReason ?? data.promptFeedback?.blockReason : data.choices?.[0]?.finish_reason;
        return finish({
          state: text.trim() ? 'success' : 'warning',
          message: text.trim() ? '生成成功，模型可用' : `接口已响应，但没有可见文本${finishReason ? `（${finishReason}）` : ''}；可提高 Token 上限或检查安全拦截。`,
          output: text, finishReason, usage: data.usageMetadata ?? data.usage ?? null, raw,
        });
      }
    }
    return finish({ state: 'success', message: `已获取 ${new Set(models).size} 个文本生成模型；尚未验证实际生成权限。`, models: [...new Set(models)], raw });
  } catch (error) {
    if (controller.signal.aborted) return finish({ state: timedOut ? 'failed' : 'cancelled', message: timedOut ? `请求超时（${timeout} 秒）` : '已停止', raw });
    return finish({ ...connectionFailure(error), raw });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', cancel);
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const host = req.headers.host;
    const expected = `127.0.0.1:${req.socket.localPort}`;
    if (![expected, `localhost:${req.socket.localPort}`].includes(host)) return json(res, 403, { error: '仅允许从本机地址访问' });
    if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '拒绝跨站请求' });
    const path = new URL(req.url, `http://${host}`).pathname;
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, node: process.versions.node });
    if (req.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      try {
        const content = await readFile(resolve(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(content);
      } catch { return json(res, 500, { error: '页面文件无法读取' }); }
    }
    if (req.method === 'POST' && path === '/api/probe') {
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '仅接受 application/json' });
      let input;
      try { input = JSON.parse(await readLimited(req)); validate(input); }
      catch (error) { return json(res, 400, { error: error.message }); }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const result = await probe(input, controller.signal);
      if (!res.destroyed) json(res, 200, result);
      return;
    }
    json(res, 404, { error: '未找到此路径' });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Gemini API Tester 已启动：http://127.0.0.1:${port}\n按 Ctrl+C 停止。Key 不会写入服务器文件或日志。`));
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请修改 PORT 后重试。` : `启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
