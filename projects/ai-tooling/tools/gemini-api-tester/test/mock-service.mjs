import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createMock() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const key = req.headers['x-goog-api-key'] || req.headers.authorization?.replace(/^Bearer /, '');
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, search: url.search, method: req.method, key, body: body ? JSON.parse(body) : null });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (key === 'bad-key') return send(401, { error: { message: `Invalid API key: ${key}` } });
    if (key === 'quota-key') { res.setHeader('retry-after', '60'); return send(429, { error: { message: 'Quota exceeded' } }); }
    if (key === 'redirect-key') { res.writeHead(302, { Location: '/capture-key' }); return res.end(); }
    if (key === 'html-key') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Not an API</h1>'); }
    if (key === 'slow-key') await new Promise(done => setTimeout(done, 1200));
    if (url.pathname === '/v1beta/models') {
      const models = url.searchParams.has('pageToken') ? [{ name: 'models/mock-pro', supportedGenerationMethods: ['generateContent'] }] : [{ name: 'models/mock-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/mock-embedding', supportedGenerationMethods: ['embedContent'] }];
      return send(200, { models, ...(!url.searchParams.has('pageToken') ? { nextPageToken: 'page-2' } : {}) });
    }
    if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'mock-flash' }, { id: 'mock-pro' }] });
    if (url.pathname.includes(':generateContent')) {
      if (url.pathname.includes('empty')) return send(200, { candidates: [{ finishReason: 'MAX_TOKENS' }] });
      return send(200, { candidates: [{ content: { parts: [{ text: 'Internal thought', thought: true }, { text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } });
    }
    if (url.pathname === '/v1/chat/completions') return send(200, { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    return send(404, { error: { message: 'Unknown mock endpoint' } });
  });
  return { server, requests };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createMock();
  server.listen(8799, '127.0.0.1', () => console.log('Mock API ready: http://127.0.0.1:8799 (fake keys only)'));
}
