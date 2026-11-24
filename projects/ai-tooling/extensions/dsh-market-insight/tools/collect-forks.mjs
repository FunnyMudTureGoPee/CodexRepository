/**
 * Collect GitHub fork lineage metadata for every repository the plugin market lists,
 * through the public ecosyste.ms repository API (anonymous tier: 5000 requests/hour).
 *
 * Output: data/forks.json — the bundled snapshot the plugin reads at startup so star
 * counts and fork families render immediately. Repositories missing here are enriched
 * on demand at runtime.
 *
 * Usage: node tools/collect-forks.mjs [--limit N] [--concurrency 6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const devData = 'D:/DSH/WorkShop/dsh-market-plus/data';
const indexFile = fs.existsSync(path.join(root, 'data', 'index.json'))
  ? path.join(root, 'data', 'index.json')
  : path.join(devData, 'index.json');
const outFile = path.join(root, 'data', 'forks.json');
const rawFile = path.join(root, 'data', 'forks.raw.jsonl');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = Number(argValue('limit', '0')) || Infinity;
const CONCURRENCY = Math.max(1, Number(argValue('concurrency', '6')) || 6);
const TIMEOUT_MS = 30_000;

const repoKey = (url) => {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/#?\s]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
};

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const repos = [];
const seen = new Set();
for (const p of index.plugins) {
  const key = repoKey(p.repository?.url);
  if (!key) continue;
  const norm = key.toLowerCase();
  if (seen.has(norm)) continue;
  seen.add(norm);
  repos.push(key);
}
const targets = repos.slice(0, LIMIT);
console.log(JSON.stringify({ phase: 'start', indexFile, uniqueRepos: repos.length, targets: targets.length, concurrency: CONCURRENCY }));

// --- simple concurrency pool with retries -----------------------------------
const results = new Map();
let done = 0;
let ok = 0;
let forks = 0;
let missing = 0;
let failed = 0;
let rateRemaining = null;
const startedAt = Date.now();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchRepo(repo) {
  const url = 'https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/' + encodeURIComponent(repo);
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dsh-market-insight/1.0 (fork snapshot builder)', Accept: 'application/json' },
        signal: ac.signal,
      });
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining != null) rateRemaining = Number(remaining);
      if (res.status === 404) return { missing: true };
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      return {
        fork: Boolean(json.fork),
        source: typeof json.source_name === 'string' && json.source_name ? json.source_name : null,
        stars: typeof json.stargazers_count === 'number' ? json.stargazers_count : null,
        archived: Boolean(json.archived),
        pushedAt: typeof json.pushed_at === 'string' ? json.pushed_at : null,
      };
    } catch (error) {
      if (attempt === 2) return { error: String(error?.message || error) };
      await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 300));
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: 'unreachable' };
}

const rawStream = fs.createWriteStream(rawFile, { flags: 'w' });
const record = (repo, value) => {
  rawStream.write(JSON.stringify({ repo, ...value }) + '\n');
};

const queue = [...targets];
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) {
    const repo = queue.shift();
    if (repo === undefined) break;
    const value = await fetchRepo(repo);
    results.set(repo, value);
    record(repo, value);
    done++;
    if (value.error) failed++;
    else if (value.missing) missing++;
    else { ok++; if (value.fork) forks++; }
    if (done % 100 === 0 || done === targets.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(JSON.stringify({
        phase: 'progress', done, total: targets.length, ok, forks, missing, failed,
        rateRemaining, elapsedSeconds: Math.round(elapsed),
        perSecond: Math.round((done / Math.max(elapsed, 1)) * 10) / 10,
      }));
    }
  }
});
await Promise.all(workers);
rawStream.end();

const repositories = {};
for (const [repo, value] of [...results.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  repositories[repo] = value;
}
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/<owner>/<name> (anonymous tier, 5000 requests/hour)',
  indexUpdated: index.plugins?.length ? (index.plugins.length + ' plugins') : undefined,
  counts: { requested: targets.length, ok, forks, missing, failed },
  repositories,
};
fs.writeFileSync(outFile, JSON.stringify(payload, null, 1));
console.log(JSON.stringify({ phase: 'done', outFile, bytes: fs.statSync(outFile).size, counts: payload.counts, rateRemaining }));
