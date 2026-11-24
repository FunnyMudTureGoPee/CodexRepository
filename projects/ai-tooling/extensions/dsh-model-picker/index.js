/**
 * Model Picker — Host half of the `@local/dsh-model-picker` bundle.
 *
 * The picker is a browser contribution: it replaces the composer's
 * `conversation.input.model` seat and reads/writes the session model directory.
 *
 * This half owns ONE thing: a tiny same-origin diagnostic sink
 * (`/dsh-model-picker/api/diag`). The seat SHADOWS the stock selector, so when
 * it cannot resolve its inputs there is no stock fallback left on screen — and
 * a browser console is not reachable from the Host. The client half therefore
 * posts what it saw and what it could not resolve, and the Host keeps the last
 * report so a failure is inspectable instead of guessed at:
 *
 *   GET  /dsh-model-picker/api/diag  → { ok, value: { at, report } }
 *   POST /dsh-model-picker/api/diag  → stores the report (header-guarded)
 *
 * The sink is bounded (last report only), header-guarded, and stores nothing
 * about the user — it exists purely to make this plugin's own failures
 * observable.
 */

/** The HTTP carrier is required to expose the sink. */
export const inject = ['webServer'];

/** Route prefix owned by this bundle. */
const API_PREFIX = '/dsh-model-picker/api';

/** Custom header required by the write side (a cross-site form cannot set it). */
const POST_HEADER = 'x-model-picker';

/**
 * Register the diagnostic route and keep the last report.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  /**
   * Reports posted by client seats, one entry per distinct seat signature.
   * A page renders one seat per session, so a single "last report" hid the
   * difference between a healthy seat and a grey one.
   */
  const sink = { at: null, reports: [] };

  const handler = async (req, res) => {
    const incoming = new URL(req.url ?? '/', 'http://localhost');
    const route = incoming.pathname.slice(API_PREFIX.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (route === '/diag' && method === 'GET') {
      return sendJson(res, 200, { ok: true, value: sink });
    }

    if (route === '/diag' && method === 'POST') {
      if (req.headers[POST_HEADER] !== '1') {
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `requires ${POST_HEADER}: 1` } });
      }
      try {
        const body = await readBody(req);
        const parsed = body === '' ? null : JSON.parse(body);
        sink.at = new Date().toISOString();
        const key = parsed !== null && typeof parsed.signature === 'string' ? parsed.signature : sink.at;
        const existing = sink.reports.findIndex(report => report !== null && report.signature === key);
        if (existing === -1) sink.reports.push(parsed);
        else sink.reports[existing] = parsed;
        // Bounded: keep the most recent reports only.
        if (sink.reports.length > 12) sink.reports.splice(0, sink.reports.length - 12);
        return sendJson(res, 200, { ok: true, value: { stored: true, count: sink.reports.length } });
      } catch (error) {
        const message = error && typeof error.message === 'string' ? error.message : String(error);
        return sendJson(res, 400, { ok: false, error: { code: 'invalid-body', message } });
      }
    }

    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  }), 'model-picker: diag route');

  const logger = typeof ctx.logger === 'function' ? ctx.logger('model-picker') : undefined;
  if (logger && typeof logger.info === 'function') {
    logger.info('model picker host half ready (diag sink at ' + API_PREFIX + ')');
  }
}

/**
 * Read a request body as UTF-8 text with a hard size cap.
 * @param req - the incoming request.
 * @returns {Promise<string>} the body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) });
    req.on('error', reject);
  });
}

/** Send one JSON payload with no-store semantics. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
