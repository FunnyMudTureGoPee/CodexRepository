import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { listSessions, readTrace, threadIdPattern } from './trace.mjs';

const html = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');
const uri = 'ui://codex-trace-viewer/timeline-v2.html';
const mimeType = 'text/html;profile=mcp-app';
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const threadId = { type: 'string', description: 'Local Codex session UUID.' };
const tools = [
  {
    name: 'open_trace', title: '运行轨迹',
    description: 'Open the local Codex timeline viewer. Omit threadId to use the active local thread, if available.',
    inputSchema: { type: 'object', properties: { threadId }, additionalProperties: false },
    annotations: readOnly,
    _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
  },
  {
    name: 'trace_sessions', title: '本机会话',
    description: 'List local Codex sessions in the trace viewer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly, _meta: { ui: { visibility: ['app'] } }
  },
  {
    name: 'trace_turn', title: '读取轮次',
    description: 'Read the requested turn in the local Codex trace viewer.',
    inputSchema: {
      type: 'object', properties: { threadId, turnId: { type: 'string' } },
      required: ['threadId'], additionalProperties: false
    },
    annotations: readOnly, _meta: { ui: { visibility: ['app'] } }
  }
];

function activeThread() {
  const id = process.env.CODEX_THREAD_ID;
  return id && threadIdPattern.test(id) ? id : null;
}

function friendly(error) {
  return error?.code ? '无法读取本地会话日志（' + error.code + '）。' : error?.message || '无法读取轨迹。';
}

async function getData(tool, args = {}) {
  if (tool === 'trace_sessions') return { sessions: listSessions() };
  if (tool === 'trace_turn') return readTrace(args.threadId, args.turnId);
  const id = args.threadId ?? activeThread();
  if (id && !threadIdPattern.test(id)) throw new Error('请填写有效的会话 UUID。');
  return { threadId: id };
}

async function respond(method, params = {}) {
  if (method === 'initialize') {
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    return {
      protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
      capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-trace-viewer', version: '0.1.1' }
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'resources/list') return { resources: [{ uri, name: '运行轨迹', mimeType }] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  if (method === 'resources/read' && params.uri === uri) {
    return { contents: [{ uri, mimeType, text: html }] };
  }
  if (method === 'tools/call' && tools.some((tool) => tool.name === params.name)) {
    try {
      const data = await getData(params.name, params.arguments);
      return {
        content: [{ type: 'text', text: params.name === 'open_trace' ? '已请求打开运行轨迹。若客户端没有显示界面，请使用本地浏览器入口。' : '已读取本地轨迹数据。' }],
        _meta: { trace: data }
      };
    } catch (error) {
      const message = friendly(error);
      return { isError: true, content: [{ type: 'text', text: message }], _meta: { trace: { error: message } } };
    }
  }
  throw Object.assign(new Error('Unknown method or resource'), { rpcCode: -32601 });
}

function startMcp() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
  input.on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (message?.id == null) return;
    const { id, method, params } = message;
    try { send({ id, result: await respond(method, params) }); }
    catch (error) { send({ id, error: { code: error.rpcCode ?? -32603, message: 'MCP request failed' } }); }
  });
}

function startBrowser() {
  const token = randomBytes(24).toString('hex');
  const prefix = '/' + token + '/';
  const server = createServer(async (req, res) => {
    const origin = '127.0.0.1:' + server.address().port;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method !== 'GET' || req.headers.host !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://' + origin);
      if (url.pathname === prefix) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      if (url.pathname !== prefix + 'api') {
        res.writeHead(404).end();
        return;
      }
      const args = { threadId: url.searchParams.get('threadId') ?? undefined, turnId: url.searchParams.get('turnId') ?? undefined };
      const data = await getData(url.searchParams.get('method'), args);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: friendly(error) }));
    }
  });
  server.listen(0, '127.0.0.1', () => {
    console.log('http://127.0.0.1:' + server.address().port + prefix);
    console.log('打开上方地址。按 Ctrl+C 停止。');
  });
}

if (process.argv.includes('--browser')) startBrowser();
else startMcp();
