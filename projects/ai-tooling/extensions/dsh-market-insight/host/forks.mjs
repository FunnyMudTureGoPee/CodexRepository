/**
 * Fork lineage data: the bundled snapshot plus the runtime cache, and the bounded,
 * polite top-up that queries ecosyste.ms only for repositories neither source knows.
 *
 * The snapshot ships with the bundle (see tools/collect-forks.mjs) so star counts and
 * fork families render on the first paint without a multi-minute crawl. Repositories
 * that appear in the market later are enriched lazily, a few at a time, and persisted.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

import { resolveBundledForksPath } from './cache.mjs';

const ENRICH_CONCURRENCY = 3;
const ENRICH_TIMEOUT_MS = 12_000;
const DEFAULT_ENRICH_LIMIT = 40;

/** Read and merge the bundled snapshot with the runtime cache. */
export async function loadForkData(cacheDir) {
  const bundled = await readJson(resolveBundledForksPath());
  const runtime = await readJson(path.join(cacheDir, 'forks-cache.json'));
  const repositories = {
    ...(isRecord(bundled?.repositories) ? bundled.repositories : {}),
    ...(isRecord(runtime?.repositories) ? runtime.repositories : {}),
  };
  let forks = 0;
  for (const value of Object.values(repositories)) if (value?.fork === true) forks++;
  return {
    generatedAt: typeof bundled?.generatedAt === 'string' ? bundled.generatedAt : undefined,
    bundledAt: typeof bundled?.generatedAt === 'string' ? bundled.generatedAt : undefined,
    counts: isRecord(bundled?.counts) ? bundled.counts : undefined,
    repositories,
    total: Object.keys(repositories).length,
    forks,
  };
}

/**
 * Enrich a bounded batch of repositories no fork source knows yet.
 *
 * @param options.repos - lowercase repository keys still missing.
 * @param options.forkData - current fork data (mutated and returned).
 * @param options.cacheDir - durable cache directory.
 * @param options.limit - maximum lookups in this batch.
 * @param options.signal - abort signal.
 * @returns `{ enriched, failed, repositories }`; `repositories` is the runtime additions map.
 */
export async function enrichForkRepos(options) {
  const { repos, forkData, cacheDir, limit = DEFAULT_ENRICH_LIMIT, signal } = options;
  if (process.env.DSH_MARKET_INSIGHT_NO_ENRICH === '1') return { enriched: 0, failed: 0, repositories: {} };
  const targets = [];
  for (const key of repos) {
    if (targets.length >= limit) break;
    if (forkData.repositories[key] === undefined) targets.push(key);
  }
  if (targets.length === 0) return { enriched: 0, failed: 0, repositories: {} };

  const runtimeFile = path.join(cacheDir, 'forks-cache.json');
  const runtime = (await readJson(runtimeFile)) ?? { schemaVersion: 1, updatedAt: undefined, repositories: {} };
  if (!isRecord(runtime.repositories)) runtime.repositories = {};

  let next = 0;
  let enriched = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      if (signal?.aborted === true) return;
      const key = targets[index];
      const value = await fetchRepo(key, signal);
      if (value === undefined) {
        failed++;
        continue;
      }
      runtime.repositories[key] = value;
      forkData.repositories[key] = value;
      enriched++;
      if (value.fork === true) forkData.forks = (forkData.forks ?? 0) + 1;
    }
  };
  await Promise.allSettled(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  runtime.updatedAt = new Date().toISOString();
  if (enriched > 0) {
    await fs.mkdir(cacheDir, { recursive: true });
    const tmp = `${runtimeFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(runtime), 'utf8');
    await fs.rename(tmp, runtimeFile);
  }
  return { enriched, failed, repositories: runtime.repositories };
}

/** Fetch one repository's fork facts from the public ecosyste.ms API. */
async function fetchRepo(key, signal) {
  const url = `https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/${encodeURIComponent(key)}`;
  const timeout = AbortSignal.timeout(ENRICH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-market-insight/1.1 (fork lineage enrichment)',
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      redirect: 'error',
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { missing: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const json = await response.json();
    return {
      fork: json?.fork === true,
      source: typeof json?.source_name === 'string' && json.source_name !== '' ? json.source_name : null,
      stars: typeof json?.stargazers_count === 'number' ? json.stargazers_count : null,
      archived: json?.archived === true,
      pushedAt: typeof json?.pushed_at === 'string' ? json.pushed_at : null,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}
