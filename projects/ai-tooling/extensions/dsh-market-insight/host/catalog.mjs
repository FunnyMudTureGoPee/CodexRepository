/**
 * Fetch and cache the rich plugin catalog (`dsh-plugin-catalog/plugins.json`).
 *
 * The market index the Discover tab reads carries no popularity data. That file is
 * the community catalog behind the market: one row per listed project with its npm
 * package name, GitHub repository, stars, 30-day downloads and inclusion date. Every
 * market entry we have observed joins it by exact npm package name.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json';

/** Fields kept from each catalog row; the rest is not needed and would bloat the cache. */
const KEPT_FIELDS = ['name', 'owner', 'url', 'npm', 'stars', 'downloads', 'added', 'category'];

/** Localized text picked for both languages we can display. */
function keepDescription(description) {
  if (description === undefined || description === null) return undefined;
  if (typeof description === 'string') return { en: description };
  const en = typeof description.en === 'string' ? description.en : undefined;
  const zh = typeof description.zh === 'string' ? description.zh : undefined;
  return en === undefined && zh === undefined ? undefined : { ...(en === undefined ? {} : { en }), ...(zh === undefined ? {} : { zh }) };
}

/** Trim one catalog row to the fields the insight model consumes. */
function compactRow(row) {
  if (typeof row !== 'object' || row === null) return undefined;
  const out = {};
  for (const field of KEPT_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) out[field] = row[field];
  }
  if (typeof out.npm !== 'string' || out.npm === '') return undefined;
  if (typeof out.stars !== 'number') out.stars = null;
  if (typeof out.downloads !== 'number') out.downloads = null;
  const description = keepDescription(row.description);
  if (description !== undefined) out.description = description;
  return out;
}

/** Trim the whole catalog document into its cache form. */
function compactCatalog(document, fetchedAt, url) {
  const rows = Array.isArray(document?.plugins) ? document.plugins : undefined;
  if (rows === undefined) throw new Error('catalog document has no plugins array');
  const plugins = [];
  for (const row of rows) {
    const compact = compactRow(row);
    if (compact !== undefined) plugins.push(compact);
  }
  return {
    fetchedAt,
    url,
    updated: typeof document.updated === 'string' ? document.updated : undefined,
    count: typeof document.count === 'number' ? document.count : plugins.length,
    plugins,
  };
}

/** Read the offline override: a local catalog path (tests, air-gapped setups). */
async function readLocalCatalog(localPath, fetchedAt, url) {
  const raw = JSON.parse(await fs.readFile(localPath, 'utf8'));
  return compactCatalog(raw, fetchedAt, url);
}

/**
 * Load the catalog: cache first, network when stale or forced, and a stale cache as a
 * last-resort fallback so a temporary network failure never blanks the tab.
 *
 * @param options.cacheDir - durable cache directory.
 * @param options.url - catalog document URL (may be overridden by Config in a future release).
 * @param options.ttlMs - how long a successful read stays fresh.
 * @param options.force - bypass the freshness check.
 * @param options.localPath - read this JSON file instead of the network (tests/offline).
 * @param options.signal - abort signal for the fetch.
 * @returns `{ plugins, updated, count, fetchedAt, ageHours, stale, error? }`
 */
export async function loadCatalog(options) {
  const { cacheDir, url = DEFAULT_CATALOG_URL, ttlMs = 12 * 3_600_000, force = false, localPath, signal } = options;
  const cacheFile = path.join(cacheDir, 'catalog.json');
  const cached = await readJsonFile(cacheFile);
  const usable = cached !== undefined && cached.url === url && Array.isArray(cached.plugins);
  if (usable && !force && Date.now() - cached.fetchedAt < ttlMs) {
    return { ...cached, stale: false };
  }
  try {
    const fetchedAt = Date.now();
    const fresh = localPath !== undefined
      ? await readLocalCatalog(localPath, fetchedAt, url)
      : await fetchCatalog(url, fetchedAt, signal);
    await writeJsonFile(cacheFile, fresh);
    return { ...fresh, stale: false };
  } catch (error) {
    if (usable) return { ...cached, stale: true, error: messageOf(error) };
    throw error;
  }
}

/** Fetch and parse the catalog document. */
async function fetchCatalog(url, fetchedAt, signal) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: signal === undefined ? AbortSignal.timeout(120_000) : AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`catalog fetch failed: HTTP ${String(response.status)}`);
  }
  const document = await response.json();
  return compactCatalog(document, fetchedAt, url);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/* Local wrappers keep this module testable with a plain temporary directory. */
async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}
