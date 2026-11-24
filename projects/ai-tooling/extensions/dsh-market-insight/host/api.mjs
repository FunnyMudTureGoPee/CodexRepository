/**
 * HTTP surface of the Plugin Insight Host half.
 *
 * The page is served from the same origin as the Web GUI, so the client reads these
 * routes with `fetch`. GET endpoints are read-only and set no CORS header, which keeps
 * the data unreachable from other origins. The one state-changing endpoint (refresh)
 * requires a custom request header a cross-site form or image request cannot set.
 */
import { InsightError } from './store.mjs';

export const API_PREFIX = '/dsh-market-insight/api';
const POST_HEADER = 'x-market-insight';

/** Build the raw `webServer.register` handler bound to one store. */
export function createApiHandler({ store }) {
  return async function handle(req, res) {
    try {
      const incoming = new URL(req.url ?? '/', 'http://localhost');
      if (!incoming.pathname.startsWith(API_PREFIX)) return sendError(res, 404, 'not-found', 'Unknown endpoint');
      const route = incoming.pathname.slice(API_PREFIX.length) || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (route === '/status' && method === 'GET') {
        return sendJson(res, 200, { ok: true, value: store.status() });
      }
      if (route === '/search' && method === 'GET') {
        const value = await store.search(parseSearch(incoming.searchParams));
        return sendJson(res, 200, { ok: true, value });
      }
      if (route === '/entry' && method === 'GET') {
        const name = incoming.searchParams.get('name');
        if (name === null || name === '') return sendError(res, 400, 'invalid-query', 'name is required');
        const value = await store.entry(name);
        if (value === undefined) return sendError(res, 404, 'entry-not-found', `No market entry named ${name}`);
        return sendJson(res, 200, { ok: true, value });
      }
      if (route === '/refresh' && method === 'POST') {
        if (req.headers[POST_HEADER] !== '1') return sendError(res, 403, 'forbidden', `The refresh endpoint requires ${POST_HEADER}: 1`);
        const started = store.status().refreshing !== true;
        void store.refresh({ force: true, reason: 'manual' }).catch(() => {});
        return sendJson(res, 200, { ok: true, value: { started, refreshing: true } });
      }
      return sendError(res, 404, 'not-found', 'Unknown endpoint');
    } catch (error) {
      if (error instanceof InsightError) return sendError(res, error.status, error.code, error.message);
      return sendError(res, 500, 'internal', error instanceof Error ? error.message : String(error));
    }
  };
}

/** Parse and validate the search query string. */
function parseSearch(searchParams) {
  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category');
  const sort = searchParams.get('sort') ?? 'stars';
  const groupParam = searchParams.get('group');
  const group = groupParam === null ? true : groupParam !== '0' && groupParam !== 'false';
  const offset = parseInteger(searchParams.get('offset'), 0);
  const limit = parseInteger(searchParams.get('limit'), 50);
  if (offset === undefined) throw new InsightError('invalid-query', 'offset must be a non-negative integer', 400);
  if (limit === undefined || limit < 1 || limit > 100) throw new InsightError('invalid-query', 'limit must be an integer from 1 to 100', 400);
  if (category !== null && category === '') return { q, category: undefined, sort, group, offset, limit };
  return { q, category: category ?? undefined, sort, group, offset, limit };
}

function parseInteger(text, fallback) {
  if (text === null) return fallback;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** Send one JSON payload. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Send the error envelope. */
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}
