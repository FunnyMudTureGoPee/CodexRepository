/**
 * Fork lineage for the Plugin Insight tab.
 *
 * Families are built **only from verifiable repository facts**:
 *
 *   1. `same-repo` — several market entries point at the same GitHub repository
 *      (a monorepo publishing multiple packages, for example);
 *   2. `fork`      — the entry's repository is a fork according to the bundled fork
 *      snapshot (`forks.json`, see CONTRACT.md §3.1); the fork network root
 *      (`source`) becomes the family root.
 *
 * Descriptions, READMEs, package names and other prose are deliberately **not**
 * consulted: "Fork of X" in a README is a claim, not a repository relationship.
 *
 * The module is pure: it never touches the file system or the network, does not
 * mutate its inputs, and produces byte-identical output for identical inputs.
 * See CONTRACT.md §3.3 for the frozen data model.
 */

/* -------------------------------------------------------------------------- */
/* GitHub identity helpers                                                    */
/* -------------------------------------------------------------------------- */

/** A GitHub repository URL (also matches `.../tree/<ref>/<path>` links). */
const GITHUB_URL_PATTERN = /github\.com\/([^/]+)\/([^/#?\s]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * @typedef {{ key: string, fullName: string }} RepoIdentity
 * `key` is the lowercase comparison form, `fullName` keeps the original casing.
 */

/** Parse a repository or homepage URL into its identity. */
function parseGithubUrl(url) {
  if (typeof url !== 'string') return undefined;
  const match = GITHUB_URL_PATTERN.exec(url.trim());
  if (match === null) return undefined;
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, '');
  if (owner === '' || name === '') return undefined;
  return { key: `${owner}/${name}`.toLowerCase(), fullName: `${owner}/${name}` };
}

/** Parse an `owner/name` token from the fork snapshot. */
function parseRepoText(text) {
  if (typeof text !== 'string') return undefined;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text.trim());
  if (match === null) return undefined;
  return { key: `${match[1]}/${match[2]}`.toLowerCase(), fullName: `${match[1]}/${match[2]}` };
}

/* -------------------------------------------------------------------------- */
/* Input normalization                                                        */
/* -------------------------------------------------------------------------- */

/** Catalog rows may be an array, a document with a `plugins` array, or a Map. */
function catalogRowsOf(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog && catalog.plugins)) return catalog.plugins;
  if (catalog instanceof Map) return [...catalog.values()];
  return [];
}

/** Index catalog rows by their lowercase npm package name (first row wins). */
function catalogIndex(catalog) {
  const byNpm = new Map();
  for (const row of catalogRowsOf(catalog)) {
    if (row === null || typeof row !== 'object') continue;
    const npm = typeof row.npm === 'string' ? row.npm.trim().toLowerCase() : '';
    if (npm === '' || byNpm.has(npm)) continue;
    byNpm.set(npm, row);
  }
  return byNpm;
}

/**
 * Index the fork snapshot's `repositories` object by lowercase `owner/name`.
 * Accepts the JSON document, its `repositories` map, or a Map of the same.
 */
function forkSnapshotIndex(forkSnapshot) {
  let repositories = forkSnapshot;
  if (repositories !== null && typeof repositories === 'object' && !Array.isArray(repositories)) {
    if (repositories.repositories !== null && typeof repositories.repositories === 'object' && !(repositories instanceof Map)) {
      repositories = repositories.repositories;
    }
  }
  const index = new Map();
  const rows = repositories instanceof Map ? [...repositories.entries()] : Object.entries(repositories ?? {});
  for (const [rawKey, value] of rows) {
    const identity = parseRepoText(rawKey);
    if (identity === undefined || value === null || typeof value !== 'object') continue;
    const existing = index.get(identity.key);
    // A duplicate key in different casing is unlikely; keep whichever row is a fork.
    if (existing === undefined || (existing.fork !== true && value.fork === true)) index.set(identity.key, value);
  }
  return index;
}

/** The fork-network root recorded for a repository, when the snapshot says it is a fork. */
function forkSourceOf(repoKey, forkIndex) {
  const info = forkIndex.get(repoKey);
  if (info === undefined || info.fork !== true) return undefined;
  return parseRepoText(info.source);
}

/** A finite number from the catalog, or 0 for unknown popularity. */
function numberOr0(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize the market entries into internal records.
 * @returns {Array<object>}
 */
function collectRecords(entries, byNpm, forkIndex) {
  const records = [];
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '') continue;
    const nameLower = name.toLowerCase();
    if (seen.has(nameLower)) continue;
    seen.add(nameLower);

    const catalogRow = byNpm.get(nameLower);
    const repo = parseGithubUrl(raw.repository && raw.repository.url) ?? parseGithubUrl(catalogRow && catalogRow.url);
    const repoKey = repo === undefined ? undefined : repo.key;
    records.push({
      index: records.length,
      name,
      nameLower,
      repo: repo === undefined ? undefined : { key: repo.key, fullName: repo.fullName },
      forkSource: repoKey === undefined ? undefined : forkSourceOf(repoKey, forkIndex),
      stars: numberOr0(catalogRow && catalogRow.stars),
      downloads: numberOr0(catalogRow && catalogRow.downloads),
    });
  }
  return records;
}

/* -------------------------------------------------------------------------- */
/* Disjoint set                                                               */
/* -------------------------------------------------------------------------- */

function createDisjointSet(size) {
  const parent = new Int32Array(size);
  const rank = new Uint8Array(size);
  for (let i = 0; i < size; i++) parent[i] = i;
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    let cursor = value;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return;
    if (rank[a] < rank[b]) {
      const swap = a;
      a = b;
      b = swap;
    }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
  };
  return { find, union };
}

/* -------------------------------------------------------------------------- */
/* Family construction                                                        */
/* -------------------------------------------------------------------------- */

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stars of a family, counting one repository once (a monorepo row repeats repo stars). */
function sumDistinctRepos(records) {
  const byRepo = new Map();
  let unrelated = 0;
  for (const record of records) {
    if (record.repo === undefined) {
      unrelated += record.stars;
      continue;
    }
    const previous = byRepo.get(record.repo.key);
    if (previous === undefined || record.stars > previous) byRepo.set(record.repo.key, record.stars);
  }
  let total = unrelated;
  for (const stars of byRepo.values()) total += stars;
  return total;
}

/** Count relation kinds beneath a family root (the upstream row itself is not a child). */
function countRelations(records, rootRepo) {
  const counts = { fork: 0, 'same-repo': 0 };
  for (const record of records) {
    if (record.repo !== undefined && record.repo.key === rootRepo) {
      // The first root-repository entry is the upstream row. A second one would be a
      // same-repo sibling, which is counted below through its relation.
      continue;
    }
    if (record.repo !== undefined && record.forkSource !== undefined && record.forkSource.key === rootRepo) counts.fork++;
    else counts['same-repo']++;
  }
  // Monorepo families have no fork children; their root repository's sibling packages
  // are still same-repo children, so recount them explicitly.
  let rootEntries = 0;
  for (const record of records) if (record.repo !== undefined && record.repo.key === rootRepo) rootEntries++;
  if (rootEntries > 1) counts['same-repo'] += rootEntries - 1;
  return counts;
}

/**
 * Build fork families for the market entries.
 *
 * @param args.entries - market entries (`name`, `repository`, …).
 * @param args.catalog - catalog rows or document; only `npm` and `url` are used to find
 *   the repository of an entry whose market row has no usable repository URL.
 * @param args.forkSnapshot - the bundled fork snapshot (`{ repositories }`).
 * @returns `{ entryFamily, entryLineage, families }`
 */
export function buildFamilies({ entries, catalog, forkSnapshot }) {
  const byNpm = catalogIndex(catalog);
  const forkIndex = forkSnapshotIndex(forkSnapshot);
  const records = collectRecords(entries, byNpm, forkIndex);

  /* 1. Repositories that publish several entries. */
  const repoGroups = new Map();
  for (const record of records) {
    if (record.repo === undefined) continue;
    if (!repoGroups.has(record.repo.key)) repoGroups.set(record.repo.key, []);
    repoGroups.get(record.repo.key).push(record);
  }

  /* 2. Union by repository identity, then by fork network. */
  const dsu = createDisjointSet(records.length);
  for (const members of repoGroups.values()) {
    for (let i = 1; i < members.length; i++) dsu.union(members[0].index, members[i].index);
  }
  const forkParents = new Map(); // repository key → fork network root key
  const externalRoots = new Map(); // external root key → member records
  for (const members of repoGroups.values()) {
    const source = members[0].forkSource;
    if (source === undefined) continue;
    forkParents.set(members[0].repo.key, source);
    if (repoGroups.has(source.key)) {
      dsu.union(repoGroups.get(source.key)[0].index, members[0].index);
    } else {
      if (!externalRoots.has(source.key)) externalRoots.set(source.key, []);
      externalRoots.get(source.key).push(...members);
    }
  }
  // Several independent forks of the same upstream repository share one family.
  for (const members of externalRoots.values()) {
    for (let i = 1; i < members.length; i++) dsu.union(members[0].index, members[i].index);
  }

  /* 3. Describe every component. */
  const components = new Map();
  for (const record of records) {
    const root = dsu.find(record.index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(record);
  }

  const entryFamily = new Map();
  const entryLineage = new Map();
  const families = [];
  for (const members of components.values()) {
    // The family root is the fork network's upstream repository when one exists,
    // otherwise the repository the entries share.
    let rootRepo;
    const externalCandidates = [];
    for (const record of members) {
      if (record.repo === undefined) continue;
      const source = forkParents.get(record.repo.key);
      if (source !== undefined && !repoGroups.has(source.key)) externalCandidates.push(source.key);
    }
    if (externalCandidates.length > 0) {
      externalCandidates.sort(compareStrings);
      rootRepo = externalCandidates[0];
    } else {
      for (const record of members) {
        if (record.repo === undefined) continue;
        const source = forkParents.get(record.repo.key);
        if (source !== undefined) {
          rootRepo = source.key;
          break;
        }
      }
      if (rootRepo === undefined) {
        for (const record of members) {
          if (record.repo !== undefined) {
            rootRepo = record.repo.key;
            break;
          }
        }
      }
    }

    const upstreamEntry = rootRepo === undefined
      ? undefined
      : members.find((record) => record.repo !== undefined && record.repo.key === rootRepo && record.forkSource === undefined)
        ?? members.find((record) => record.repo !== undefined && record.repo.key === rootRepo);
    const upstreamName = upstreamEntry === undefined ? null : upstreamEntry.name;

    const ordered = members.slice().sort((left, right) => (
      popularityKey(left, rootRepo) - popularityKey(right, rootRepo)
      || (right.stars - left.stars)
      || compareStrings(left.name, right.name)
      || left.index - right.index
    ));
    const externalRoot = rootRepo !== undefined && !repoGroups.has(rootRepo)
      ? { fullName: rootRepo, url: `https://github.com/${rootRepo}` }
      : null;
    const familyId = `family:${rootRepo ?? ordered[0].nameLower}`;
    const representative = new Map(); // repository key → the entry representing it
    const seenRepos = new Set();

    for (const record of ordered) {
      entryFamily.set(record.name, familyId);
      let relation = null;
      let parentName = null;
      let depth = 0;
      if (record.repo === undefined) {
        relation = null;
      } else if (record.repo.key === rootRepo) {
        if (!representative.has(record.repo.key)) {
          relation = 'upstream';
          representative.set(record.repo.key, record.name);
        } else {
          relation = 'same-repo';
          parentName = representative.get(record.repo.key);
        }
        seenRepos.add(record.repo.key);
      } else {
        depth = 1;
        seenRepos.add(record.repo.key);
        if (!representative.has(record.repo.key)) {
          if (record.forkSource !== undefined && record.forkSource.key === rootRepo) {
            relation = 'fork';
            parentName = upstreamName;
          } else {
            relation = 'same-repo';
            parentName = upstreamName;
          }
          representative.set(record.repo.key, record.name);
        } else {
          relation = 'same-repo';
          parentName = representative.get(record.repo.key);
        }
      }
      entryLineage.set(record.name, {
        familyId,
        rootRepo: rootRepo ?? null,
        depth,
        parentName,
        relation,
      });
    }

    families.push({
      id: familyId,
      rootRepo: rootRepo ?? null,
      externalRoot,
      entries: ordered.map((record) => record.name),
      totalStars: sumDistinctRepos(ordered),
      totalDownloads: ordered.reduce((total, record) => total + record.downloads, 0),
      relationCounts: countRelations(ordered, rootRepo),
    });
  }

  families.sort((left, right) => compareStrings(left.id, right.id));
  return { entryFamily, entryLineage, families };
}

/** Ordering rank inside a family: upstream repository first, then forks, then siblings. */
function popularityKey(record, rootRepo) {
  if (record.repo === undefined) return 3;
  if (record.repo.key === rootRepo) return 0;
  if (record.forkSource !== undefined && record.forkSource.key === rootRepo) return 1;
  return 2;
}
