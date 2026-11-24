/**
 * Read the configured plugin market through the Host `pluginMarket` service.
 *
 * This reuses the shipped service instead of fetching the index ourselves: the service
 * validates the document, resolves relative icons, and annotates every entry and version
 * with the profile's installation status, compatibility verdict and exact install target.
 * The only work added here is paging the whole index once and caching the result.
 */
import path from 'node:path';

const PAGE_SIZE = 100;
const MARKET_CACHE_TTL_MS = 3_600_000;
const MAX_PAGES = 200;

/** Cache file for one configured index source URL. */
export function marketCacheFile(cacheDir, url) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return path.join(cacheDir, `market-${hash.toString(16).padStart(8, '0')}.json`);
}

/**
 * Load every entry of one configured market index.
 *
 * @param options.pluginMarket - the Host `pluginMarket` service.
 * @param options.cacheDir - durable cache directory.
 * @param options.url - configured index URL.
 * @param options.ttlMs - how long a successful read stays fresh.
 * @param options.force - bypass the freshness check.
 * @param options.signal - abort signal checked between pages.
 * @param options.onProgress - optional progress callback.
 */
export async function loadMarket(options) {
  const { pluginMarket, cacheDir, url, ttlMs = MARKET_CACHE_TTL_MS, force = false, signal, onProgress } = options;
  const cacheFile = marketCacheFile(cacheDir, url);
  const cached = await readJsonFile(cacheFile);
  const usable = cached !== undefined && cached.url === url && Array.isArray(cached.entries);
  if (usable && !force && Date.now() - cached.fetchedAt < ttlMs) return { ...cached, stale: false };

  try {
    const collected = await collectAll({ pluginMarket, url, signal, onProgress });
    await writeJsonFile(cacheFile, collected);
    return { ...collected, stale: false };
  } catch (error) {
    if (usable) return { ...cached, stale: true, error: messageOf(error) };
    throw error;
  }
}

/** Page through the whole index with the shipped market query. */
async function collectAll({ pluginMarket, url, signal, onProgress }) {
  const fetchedAt = Date.now();
  const entries = [];
  let offset = 0;
  let title;
  let description;
  let metadata = { categories: {}, labels: {}, sortKeys: {} };
  let fetchedAtToken;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    signal?.throwIfAborted();
    const page = await pluginMarket.search(url, {
      offset,
      limit: PAGE_SIZE,
      sort: { kind: 'index' },
    });
    if (title === undefined) {
      title = page.title;
      description = page.description;
      metadata = page.metadata ?? metadata;
      fetchedAtToken = page.fetchedAt;
    }
    entries.push(...page.entries);
    onProgress?.({ loaded: entries.length, total: typeof page.total === 'number' ? page.total : undefined });
    if (page.nextOffset === null || page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  return {
    url,
    title,
    description,
    metadata,
    fetchedAt,
    fetchedAtToken,
    entries,
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonFile(file) {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJsonFile(file, value) {
  const { mkdir, writeFile, rename } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, file);
}
