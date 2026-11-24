/**
 * Small durable-cache helpers for the Plugin Insight Host half.
 *
 * Everything this plugin persists lives under `$DSH_HOME/market-insight` (or
 * `~/.dsh/market-insight` without a profile), never beside user files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the cache directory, honoring the test/ops overrides. */
export function resolveCacheDir() {
  if (process.env.DSH_MARKET_INSIGHT_CACHE) return path.resolve(process.env.DSH_MARKET_INSIGHT_CACHE);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'market-insight');
}

/** Resolve the bundled fork snapshot path, honoring the test override. */
export function resolveBundledForksPath() {
  if (process.env.DSH_MARKET_INSIGHT_FORKS) return path.resolve(process.env.DSH_MARKET_INSIGHT_FORKS);
  return fileURLToPath(new URL('../data/forks.json', import.meta.url));
}

/** Read a JSON file, returning undefined for a missing or unparsable file. */
export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Write JSON atomically so a crash cannot leave a truncated cache file. */
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}

/** Stable FNV-1a hash used to key one cache file per index source URL. */
export function hashKey(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Age of a timestamp in hours, rounded to one decimal; undefined for absent values. */
export function ageHours(timestamp, now = Date.now()) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  return Math.round(((now - timestamp) / 3_600_000) * 10) / 10;
}
