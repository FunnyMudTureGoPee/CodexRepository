/**
 * The insight model: join the market index with the rich catalog, build fork families,
 * index the entries for search, and answer the status/search/entry queries.
 *
 * Nothing here talks HTTP except the three loaders; the store is constructed with the
 * Host services and can be driven from a plain Node test with fixtures.
 */
import { ageHours, resolveCacheDir } from './cache.mjs';
import { loadCatalog, DEFAULT_CATALOG_URL } from './catalog.mjs';
import { loadMarket } from './market.mjs';
import { loadForkData, enrichForkRepos } from './forks.mjs';
import { parseGithubRepo, repoUrl } from './repo.mjs';
import { buildFamilies } from './lineage.mjs';
import { buildIndex, matchText } from './search.mjs';

export const SORTS = ['stars', 'downloads', 'added', 'name', 'index'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const BUNDLE_CACHE_MS = 3_000;

/** Typed failure rendered as a JSON error by the HTTP layer. */
export class InsightError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'InsightError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------------- *
 * Localized text and version helpers
 * ------------------------------------------------------------------------- */

/** Pick one language from a localized market string (plain string or language map). */
export function pickLocalized(value, language) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value;
  if (typeof record[language] === 'string') return record[language];
  if (typeof record.en === 'string') return record.en;
  for (const candidate of Object.values(record)) if (typeof candidate === 'string') return candidate;
  return undefined;
}

/** Both display languages of a localized market string. */
function localizedPair(value) {
  const en = pickLocalized(value, 'en');
  const zh = pickLocalized(value, 'zh');
  if (en === undefined && zh === undefined) return undefined;
  return { ...(en === undefined ? {} : { en }), ...(zh === undefined ? {} : { zh }) };
}

/** Title pair with an always-present `en` fallback so clients never render undefined. */
function titlePair(value) {
  const pair = localizedPair(value) ?? {};
  return { en: pair.en ?? pair.zh ?? '', ...(pair.zh === undefined ? {} : { zh: pair.zh }) };
}

/** Parse a SemVer string into comparable parts, or null when malformed. */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? undefined : match[4].split('.'),
  };
}

/** Compare two SemVer strings; returns 1/0/-1 (a missing or malformed version sorts lowest). */
export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------------- *
 * Entries
 * ------------------------------------------------------------------------- */

/** Build one internal entry from an annotated market entry and its catalog row. */
function createEntry(raw, indexOrder, context) {
  const { catalogByNpm, forkByKey } = context;
  const catalog = typeof raw.name === 'string' ? catalogByNpm.get(raw.name.toLowerCase()) : undefined;
  const repo = parseGithubRepo(raw.repository?.url) ?? parseGithubRepo(raw.homepage);
  const fork = repo === undefined ? undefined : forkByKey.get(repo.key);
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  const chosen = versions.find((version) => version.version === raw.defaultVersion) ?? versions[0];
  const metadata = typeof raw.metadata === 'object' && raw.metadata !== null ? raw.metadata : {};
  const category = typeof metadata.category === 'string' ? metadata.category : '';
  const install = chosen?.install?.spec === undefined
    ? null
    : {
        spec: chosen.install.spec,
        ...(chosen.install.registry === undefined ? {} : { registry: chosen.install.registry }),
        version: chosen.version,
      };
  return {
    name: raw.name,
    title: titlePair(raw.title),
    description: localizedPair(raw.description),
    category,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    repository: typeof raw.repository === 'object' && raw.repository !== null
      ? { url: typeof raw.repository.url === 'string' ? raw.repository.url : '', ...(typeof raw.repository.directory === 'string' ? { directory: raw.repository.directory } : {}) }
      : undefined,
    rawVersions: versions,
    version: typeof chosen?.version === 'string' ? chosen.version : null,
    install,
    compatible: chosen?.compatibility?.compatible === true,
    installation: typeof raw.installation?.status === 'string' ? raw.installation.status : 'not-installed',
    installedVersion: typeof raw.installation?.installedVersion === 'string' ? raw.installation.installedVersion : undefined,
    npm: typeof raw.name === 'string' ? raw.name : null,
    stars: typeof catalog?.stars === 'number' ? catalog.stars : null,
    downloads: typeof catalog?.downloads === 'number' ? catalog.downloads : null,
    added: typeof catalog?.added === 'string' ? catalog.added : null,
    repo: repo === undefined
      ? null
      : { fullName: repo.fullName, url: repoUrl(repo.key), key: repo.key, fork: fork?.fork === true, source: typeof fork?.source === 'string' ? fork.source : null },
    indexOrder,
    lineage: undefined,
  };
}

/** Fallback grouping used only if the lineage module throws: group by repository. */
function fallbackFamilies(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.repo === null ? `solo:${entry.name.toLowerCase()}` : `repo:${entry.repo.key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const entryFamily = new Map();
  const entryLineage = new Map();
  const families = [];
  for (const [id, members] of groups) {
    const rootRepo = members[0]?.repo?.key ?? null;
    for (const member of members) {
      const relation = members.length > 1 && rootRepo !== null
        ? member.repo?.key === rootRepo ? 'upstream' : 'same-repo'
        : null;
      entryFamily.set(member.name, id);
      entryLineage.set(member.name, { familyId: id, rootRepo, depth: 0, parentName: null, relation });
    }
    families.push({ id, rootRepo, externalRoot: null, entries: members.map((member) => member.name) });
  }
  return { entryFamily, entryLineage, families };
}

/** Total known stars/downloads of a set of entries. */
function sumKnown(entries, field) {
  let total = 0;
  for (const entry of entries) if (typeof entry[field] === 'number') total += entry[field];
  return total;
}

/** Stars of a family, counting one repository once (a monorepo row repeats repo stars). */
function familyTotalStars(members) {
  const byRepo = new Map();
  let unrelated = 0;
  for (const member of members) {
    const stars = typeof member.stars === 'number' ? member.stars : -1;
    if (member.repo === null) {
      if (stars > 0) unrelated += stars;
      continue;
    }
    byRepo.set(member.repo.key, Math.max(byRepo.get(member.repo.key) ?? -1, stars));
  }
  let total = unrelated;
  for (const stars of byRepo.values()) if (stars > 0) total += stars;
  return total;
}

/** Choose the entry that represents a family. */
function pickRoot(members) {
  const upstream = members.find((entry) => entry.lineage?.relation === 'upstream' && entry.repo !== null && entry.repo.key === entry.lineage.rootRepo);
  if (upstream !== undefined) return upstream;
  return [...members].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name))[0];
}

/**
 * Build the complete insight model from the three data layers.
 * @param args.market - annotated market index (`{ entries, title, description, metadata, fetchedAt, url }`).
 * @param args.catalog - compact catalog (`{ plugins, updated, count, fetchedAt }`).
 * @param args.forks - fork data (`{ repositories, generatedAt, counts, total, forks }`).
 */
export function buildInsightModel({ market, catalog, forks }) {
  const catalogByNpm = new Map();
  for (const row of catalog.plugins) {
    if (typeof row?.npm === 'string') catalogByNpm.set(row.npm.toLowerCase(), row);
  }
  const forkByKey = new Map();
  const repositories = {};
  for (const [key, value] of Object.entries(forks.repositories ?? {})) {
    forkByKey.set(key.toLowerCase(), value);
    repositories[key] = value;
    repositories[key.toLowerCase()] = value;
  }
  const entries = market.entries.map((raw, indexOrder) => createEntry(raw, indexOrder, { catalogByNpm, forkByKey }));

  let lineage;
  try {
    lineage = buildFamilies({ entries, catalog: catalog.plugins, forkSnapshot: { repositories } });
  } catch {
    lineage = fallbackFamilies(entries);
  }
  if (lineage === undefined || !(lineage.entryFamily instanceof Map)) lineage = fallbackFamilies(entries);

  for (const entry of entries) {
    const info = lineage.entryLineage.get(entry.name);
    entry.lineage = info ?? {
      familyId: `solo:${entry.name}`,
      rootRepo: entry.repo?.key ?? null,
      depth: 0,
      parentName: null,
      relation: null,
    };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const categoryTitle = new Map();
  for (const [id, declaration] of Object.entries(market.metadata?.categories ?? {})) {
    const title = localizedPair(declaration?.title);
    if (title !== undefined) categoryTitle.set(id, title);
  }
  const categories = [...categoryTitle.entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.en.localeCompare(b.title.en) || a.id.localeCompare(b.id));

  const searchEntries = entries.map((entry) => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    categoryTitle: categoryTitle.get(entry.category),
  }));
  const searchIndex = buildIndex(searchEntries);

  const grouped = new Map();
  for (const entry of entries) {
    const id = entry.lineage.familyId;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(entry);
  }
  const families = [];
  for (const [id, members] of grouped) {
    const root = pickRoot(members);
    const rootRepo = root.lineage?.rootRepo ?? null;
    const rootListed = rootRepo !== null && members.some((member) => member.repo?.key === rootRepo);
    let latestAdded = null;
    for (const member of members) if (member.added !== null && (latestAdded === null || member.added > latestAdded)) latestAdded = member.added;
    families.push({
      id,
      rootName: root.name,
      rootRepo,
      externalRoot: rootRepo !== null && !rootListed ? { fullName: rootRepo, url: repoUrl(rootRepo) } : null,
      entries: members.map((member) => member.name),
      totalStars: familyTotalStars(members),
      totalDownloads: sumKnown(members, 'downloads'),
      latestAdded,
      minOrder: Math.min(...members.map((member) => member.indexOrder)),
      relationCounts: countRelations(members, root.name),
    });
  }
  const familyById = new Map(families.map((family) => [family.id, family]));
  const familyIdByEntry = new Map(entries.map((entry) => [entry.name, entry.lineage.familyId]));

  return {
    entries,
    byName,
    searchIndex,
    categories,
    families,
    familyById,
    familyIdByEntry,
    marketTitle: market.title,
    marketDescription: market.description,
    marketFetchedAt: market.fetchedAt,
    marketUrl: market.url,
    catalogMeta: {
      updated: catalog.updated,
      count: catalog.count,
      fetchedAt: catalog.fetchedAt,
      ageHours: ageHours(catalog.fetchedAt),
    },
    forksMeta: {
      generatedAt: forks.generatedAt,
      repositories: forks.total,
      forks: forks.forks,
    },
    builtAt: Date.now(),
    totals: {
      plugins: entries.length,
      families: families.length,
      grouped: families.reduce((total, family) => total + family.entries.length - 1, 0),
    },
  };
}

/** Count relation kinds beneath a family root. */
function countRelations(members, rootName) {
  const counts = { fork: 0, 'same-repo': 0 };
  for (const member of members) {
    if (member.name === rootName) continue;
    const relation = member.lineage?.relation;
    if (relation === 'fork' || relation === 'same-repo') counts[relation]++;
  }
  return counts;
}

/* ------------------------------------------------------------------------- *
 * Live installation state
 * ------------------------------------------------------------------------- */

/** Recompute one entry's installation status from the profile's bundles. */
export function installationOf(entry, bundles) {
  const bundle = bundles.find((candidate) => candidate?.name === entry.name);
  if (bundle === undefined) {
    return entry.installation === 'provided'
      ? { status: 'provided', ...(entry.installedVersion === undefined ? {} : { installedVersion: entry.installedVersion }) }
      : { status: 'not-installed' };
  }
  if (bundle.installed !== true) {
    if (bundle.availability !== undefined && bundle.availability !== 'installation') return { status: 'not-installed' };
    return { status: 'provided', ...(typeof bundle.version === 'string' ? { installedVersion: bundle.version } : {}) };
  }
  if (typeof bundle.version !== 'string' || entry.version === null) return { status: 'different-version' };
  if (bundle.version === entry.version) return { status: 'installed', installedVersion: bundle.version };
  return compareVersions(entry.version, bundle.version) === 1
    ? { status: 'update-available', installedVersion: bundle.version }
    : { status: 'different-version', installedVersion: bundle.version };
}

/* ------------------------------------------------------------------------- *
 * The store
 * ------------------------------------------------------------------------- */

/**
 * Owns the loaded model, the refresh lifecycle and the query surface the HTTP layer calls.
 *
 * @param options.pluginMarket - Host `pluginMarket` service (optional; empty state without it).
 * @param options.pluginManager - Host `pluginManager` service (optional; installation falls back to market data).
 * @param options.cacheDir - durable cache directory; defaults to `$DSH_HOME/market-insight`.
 * @param options.catalogUrl - catalog document URL.
 * @param options.fixtures - `{ market, catalog, forks }` for tests: bypasses loaders entirely.
 */
export class InsightStore {
  constructor(options = {}) {
    this.pluginMarket = options.pluginMarket;
    this.pluginManager = options.pluginManager;
    this.cacheDir = options.cacheDir ?? resolveCacheDir();
    this.catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
    this.catalogLocalPath = options.catalogLocalPath;
    this.fixtures = options.fixtures;
    this.logger = options.logger;
    this.controller = new AbortController();
    this.disposed = false;
    this.started = false;
    this.state = { phase: 'loading', source: undefined, catalog: undefined, forks: undefined, error: undefined };
    this.model = undefined;
    this.forkData = undefined;
    this.loaded = undefined;
    this._refreshing = undefined;
    this._enriching = false;
    this._bundles = undefined;
    this._bundlesAt = 0;
  }

  /** Attach (or replace) the Host services this store reads. */
  setServices({ pluginMarket, pluginManager } = {}) {
    if (pluginMarket !== undefined) this.pluginMarket = pluginMarket;
    if (pluginManager !== undefined) this.pluginManager = pluginManager;
  }

  /** Start the first load; safe to call more than once. */
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.refresh({ force: false, reason: 'startup' }).catch(() => {});
  }

  /** Abort in-flight work and release state. */
  dispose() {
    this.disposed = true;
    this.controller.abort(new Error('market insight disposed'));
    this.model = undefined;
    this.loaded = undefined;
    this.forkData = undefined;
    this._bundles = undefined;
  }

  /** Pick the first usable configured market source; undefined when none is configured. */
  pickSource() {
    if (this.pluginMarket === undefined || typeof this.pluginMarket.listIndexes !== 'function') {
      throw new InsightError('market-unavailable', 'The plugin market service is not available in this profile', 503);
    }
    const sources = this.pluginMarket.listIndexes();
    if (!Array.isArray(sources) || sources.length === 0) return undefined;
    const usable = sources.find((source) => source?.error === undefined && typeof source.url === 'string');
    if (usable === undefined) {
      throw new InsightError('market-source-unavailable', sources[0]?.error ?? 'No usable market index source', 502);
    }
    return usable;
  }

  /** Refresh the model. Concurrent calls share one run. */
  async refresh({ force = false, reason = 'auto' } = {}) {
    if (this.disposed) return;
    if (this._refreshing !== undefined) return this._refreshing;
    this._refreshing = this._refresh(force, reason).finally(() => {
      this._refreshing = undefined;
    });
    return this._refreshing;
  }

  async _refresh(force, reason) {
    try {
      if (this.fixtures !== undefined) {
        const { market, catalog, forks } = this.fixtures;
        this.commit({ market, catalog, forks, source: { url: market.url } });
        return;
      }
      const source = this.pickSource();
      if (source === undefined) {
        this.state = { phase: 'empty', source: undefined, catalog: undefined, forks: undefined, error: undefined };
        return;
      }
      const signal = this.controller.signal;
      const [market, catalog, forks] = await Promise.all([
        loadMarket({ pluginMarket: this.pluginMarket, cacheDir: this.cacheDir, url: source.url, force, signal }),
        loadCatalog({ cacheDir: this.cacheDir, url: this.catalogUrl, force, signal, localPath: this.catalogLocalPath }),
        loadForkData(this.cacheDir),
      ]);
      if (this.disposed) return;
      this.commit({ market, catalog, forks, source });
      void this.runEnrichment();
    } catch (error) {
      if (this.disposed) return;
      const insightError = error instanceof InsightError
        ? error
        : new InsightError('load-failed', error instanceof Error ? error.message : String(error), 502);
      this.state = {
        ...this.state,
        phase: this.model === undefined ? 'error' : this.state.phase,
        error: { code: insightError.code, message: insightError.message },
      };
      this.logger?.warn?.(`[market-insight] ${reason}: ${insightError.message}`);
    }
  }

  /** Build and publish one loaded model. */
  commit({ market, catalog, forks, source }) {
    const model = buildInsightModel({ market, catalog, forks });
    this.loaded = { market, catalog, forks };
    this.forkData = forks;
    this.model = model;
    this.state = {
      phase: 'ready',
      source: { url: market.url, title: titlePair(market.title) },
      catalog: model.catalogMeta,
      forks: model.forksMeta,
      error: undefined,
    };
  }

  /** Status surfaced to the client. */
  status() {
    const state = this.state;
    const value = {
      state: state.phase,
      source: state.source ?? null,
      catalog: state.catalog ?? null,
      forks: state.forks ?? null,
      totals: this.model?.totals,
      refreshing: this._refreshing !== undefined,
    };
    if (state.error !== undefined) value.error = state.error;
    return value;
  }

  /** Live bundle list, lightly cached to avoid one call per request. */
  async bundles() {
    if (this.pluginManager === undefined || typeof this.pluginManager.listBundles !== 'function') return this._bundles ?? [];
    const now = Date.now();
    if (this._bundles !== undefined && now - this._bundlesAt < BUNDLE_CACHE_MS) return this._bundles;
    try {
      const list = await this.pluginManager.listBundles();
      this._bundles = Array.isArray(list) ? list : [];
      this._bundlesAt = now;
    } catch {
      /* keep the previous snapshot */
    }
    return this._bundles ?? [];
  }

  /** The public summary of one entry. */
  toSummary(entry, bundles) {
    const installation = installationOf(entry, bundles);
    return {
      name: entry.name,
      title: entry.title,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      category: entry.category,
      ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
      ...(entry.repository === undefined ? {} : { repository: entry.repository }),
      stars: entry.stars,
      downloads: entry.downloads,
      added: entry.added,
      npm: entry.npm,
      version: entry.version,
      install: entry.install,
      compatible: entry.compatible,
      installation: installation.status,
      ...(installation.installedVersion === undefined ? {} : { installedVersion: installation.installedVersion }),
      repo: entry.repo === null
        ? null
        : { fullName: entry.repo.fullName, url: entry.repo.url, fork: entry.repo.fork, source: entry.repo.source },
      lineage: entry.lineage,
    };
  }

  /** One family as the client renders it. */
  toFamilyItem(family, bundles) {
    const summaries = [];
    for (const name of family.entries) {
      const entry = this.model.byName.get(name);
      if (entry !== undefined) summaries.push(this.toSummary(entry, bundles));
    }
    summaries.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name));
    const rootSummary = summaries.find((summary) => summary.name === family.rootName) ?? summaries[0];
    return {
      kind: 'family',
      id: family.id,
      root: rootSummary,
      entries: summaries,
      externalRoot: family.externalRoot,
      totalStars: family.totalStars,
      totalDownloads: family.totalDownloads,
      relations: family.relationCounts,
    };
  }

  /** Search and page the market. */
  async search(params = {}) {
    const model = this.model;
    if (model === undefined) throw new InsightError('not-ready', 'Insight data is still loading', 503);
    const q = typeof params.q === 'string' ? params.q : '';
    const category = typeof params.category === 'string' && params.category !== '' ? params.category : null;
    const sort = SORTS.includes(params.sort) ? params.sort : 'stars';
    const group = params.group !== false && params.group !== '0';
    const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const requestedLimit = Number.isSafeInteger(params.limit) ? params.limit : DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit));
    const bundles = await this.bundles();

    const scores = q.trim() === '' ? new Map() : matchText(model.searchIndex, q);
    const matchedPositions = q.trim() === '' ? model.entries.map((_entry, index) => index) : [...scores.keys()];
    const filtered = matchedPositions.filter((position) => category === null || model.entries[position].category === category);

    const value = {
      query: { q, category, sort, group, offset, limit },
      matched: filtered.length,
      categories: model.categories,
      nextOffset: null,
    };

    if (group) {
      const families = this.selectFamilies(model, filtered, sort, scores);
      const page = families.slice(offset, offset + limit);
      const items = page.map((family) => this.toFamilyItem(family, bundles));
      const next = offset + page.length;
      pureAssign(value, {
        total: families.length,
        items,
        nextOffset: next < families.length ? next : null,
        generatedAt: new Date(model.builtAt).toISOString(),
      });
      return value;
    }

    const sorted = filtered.slice().sort((left, right) => compareEntries(model.entries[left], model.entries[right], sort, scores));
    const page = sorted.slice(offset, offset + limit);
    const next = offset + page.length;
    pureAssign(value, {
      total: sorted.length,
      items: page.map((position) => this.toSummary(model.entries[position], bundles)),
      nextOffset: next < sorted.length ? next : null,
      generatedAt: new Date(model.builtAt).toISOString(),
    });
    return value;
  }

  /** Rank families for a query/sort selection. */
  selectFamilies(model, positions, sort, scores) {
    const scoresByName = new Map();
    const matched = new Map();
    for (const position of positions) {
      const entry = model.entries[position];
      const familyId = entry.lineage.familyId;
      if (!matched.has(familyId)) matched.set(familyId, []);
      matched.get(familyId).push(entry);
      const score = scores.get(position) ?? 0;
      if (score > (scoresByName.get(familyId) ?? -1)) scoresByName.set(familyId, score);
    }
    const families = [];
    for (const [familyId, members] of matched) {
      const family = model.familyById.get(familyId);
      if (family === undefined) continue;
      families.push({ family, score: scoresByName.get(familyId) ?? 0 });
    }
    families.sort((left, right) => compareFamilies(left, right, sort) || right.score - left.score || left.family.rootName.localeCompare(right.family.rootName));
    return families.map((item) => item.family);
  }

  /** One entry page with its family tree and market versions. */
  async entry(name) {
    const model = this.model;
    if (model === undefined) throw new InsightError('not-ready', 'Insight data is still loading', 503);
    if (typeof name !== 'string' || name === '') return undefined;
    const entry = model.byName.get(name);
    if (entry === undefined) return undefined;
    const bundles = await this.bundles();
    const summary = this.toSummary(entry, bundles);
    const family = model.familyById.get(entry.lineage.familyId);
    const members = family === undefined ? [] : family.entries.map((memberName) => model.byName.get(memberName)).filter((member) => member !== undefined);
    const entries = members.map((member) => this.toSummary(member, bundles));
    for (const item of entries) item.isRoot = item.name === family?.rootName;
    entries.sort((left, right) => Number(right.isRoot === true) - Number(left.isRoot === true) || (right.stars ?? -1) - (left.stars ?? -1) || left.name.localeCompare(right.name));
    const root = entries.find((item) => item.name === family?.rootName) ?? entries[0] ?? summary;
    const versions = entry.rawVersions.map((version) => ({
      version: version.version,
      install: version.install?.spec === undefined
        ? null
        : { spec: version.install.spec, ...(version.install.registry === undefined ? {} : { registry: version.install.registry }) },
      compatible: version.compatibility?.compatible === true,
    }));
    return {
      entry: summary,
      family: family === undefined
        ? undefined
        : {
            id: family.id,
            externalRoot: family.externalRoot,
            root,
            entries,
            totalStars: family.totalStars,
            totalDownloads: family.totalDownloads,
          },
      versions,
    };
  }

  /** Lazily top up fork lineage for repositories newer than the bundled snapshot. */
  async runEnrichment() {
    if (this._enriching || this.disposed || this.fixtures !== undefined || this.model === undefined || this.forkData === undefined) return;
    this._enriching = true;
    try {
      const missing = [];
      for (const entry of this.model.entries) {
        if (entry.repo !== null && entry.repo.key !== undefined && this.forkData.repositories[entry.repo.key] === undefined) missing.push(entry.repo.key);
      }
      if (missing.length === 0) return;
      const result = await enrichForkRepos({
        repos: [...new Set(missing)],
        forkData: this.forkData,
        cacheDir: this.cacheDir,
        limit: 40,
        signal: this.controller.signal,
      });
      if (this.disposed || this.loaded === undefined) return;
      if (result.enriched > 0) {
        const { market, catalog } = this.loaded;
        this.commit({ market, catalog, forks: this.forkData, source: this.state.source ?? { url: market.url } });
        this.logger?.info?.(`[market-insight] enriched ${String(result.enriched)} repositories with fork lineage`);
      }
    } catch (error) {
      this.logger?.warn?.(`[market-insight] fork enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this._enriching = false;
    }
  }
}

/** Assign several properties without repeating the target. */
function pureAssign(target, values) {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) target[key] = value;
  return target;
}

/** Compare two base entries for the flat (un-grouped) listing. */
function compareEntries(left, right, sort, scores) {
  switch (sort) {
    case 'downloads':
      return (right.downloads ?? -1) - (left.downloads ?? -1) || (right.stars ?? -1) - (left.stars ?? -1) || left.name.localeCompare(right.name);
    case 'added':
      return (right.added ?? '').localeCompare(left.added ?? '') || (right.stars ?? -1) - (left.stars ?? -1) || left.name.localeCompare(right.name);
    case 'name':
      return left.title.en.localeCompare(right.title.en) || left.name.localeCompare(right.name);
    case 'index':
      return left.indexOrder - right.indexOrder;
    case 'stars':
    default:
      return (right.stars ?? -1) - (left.stars ?? -1) || (right.downloads ?? -1) - (left.downloads ?? -1) || left.name.localeCompare(right.name);
  }
}

/** Compare two candidate families for the grouped listing. */
function compareFamilies(left, right, sort) {
  const a = left.family;
  const b = right.family;
  switch (sort) {
    case 'downloads':
      return b.totalDownloads - a.totalDownloads || b.totalStars - a.totalStars || b.entries.length - a.entries.length;
    case 'added':
      return (b.latestAdded ?? '').localeCompare(a.latestAdded ?? '') || b.totalStars - a.totalStars;
    case 'name':
      return a.rootName.localeCompare(b.rootName);
    case 'index':
      return a.minOrder - b.minOrder;
    case 'stars':
    default:
      return b.totalStars - a.totalStars || b.entries.length - a.entries.length || b.totalDownloads - a.totalDownloads;
  }
}
