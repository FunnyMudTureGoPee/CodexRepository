/**
 * Print family/star statistics for the real market + catalog + fork snapshot.
 * Used to keep README/CONTRACT numbers honest after a rule or data change.
 *
 * Run: node tools/stats.mjs
 */
import fs from 'node:fs';

import { buildInsightModel } from '../host/store.mjs';

const DEV = 'D:/DSH/WorkShop/dsh-market-plus/data';
const INDEX_FILE = `${DEV}/index.json`;
const CATALOG_FILE = `${DEV}/plugins.json`;
const FORKS_FILE = new URL('../data/forks.json', import.meta.url);

const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
const forks = JSON.parse(fs.readFileSync(FORKS_FILE, 'utf8'));
let forkCount = 0;
for (const value of Object.values(forks.repositories ?? {})) if (value?.fork === true) forkCount++;

const annotate = (plugin) => {
  const versions = plugin.versions.map((version) => ({ ...version, install: { spec: `${plugin.name}@${version.version}` }, compatibility: { compatible: true } }));
  return { ...plugin, versions, defaultVersion: versions[0]?.version, installation: { status: 'not-installed' } };
};
const model = buildInsightModel({
  market: { url: 'stats', title: index.title, description: index.description, metadata: index.metadata, fetchedAt: Date.now(), entries: index.plugins.map(annotate) },
  catalog: { plugins: catalog.plugins, updated: catalog.updated, count: catalog.count, fetchedAt: Date.now() },
  forks: { repositories: forks.repositories, generatedAt: forks.generatedAt, counts: forks.counts, total: Object.keys(forks.repositories).length, forks: forkCount },
});

const sizes = new Map();
const relationFamilies = {};
for (const family of model.families) {
  sizes.set(family.entries.length, (sizes.get(family.entries.length) ?? 0) + 1);
  for (const [relation, count] of Object.entries(family.relationCounts)) {
    if (count > 0) relationFamilies[relation] = (relationFamilies[relation] ?? 0) + 1;
  }
  if (family.externalRoot !== null) relationFamilies.externalRoot = (relationFamilies.externalRoot ?? 0) + 1;
}
const relationEntries = {};
for (const entry of model.entries) {
  const relation = entry.lineage?.relation ?? 'standalone';
  relationEntries[relation] = (relationEntries[relation] ?? 0) + 1;
}
console.log(JSON.stringify({
  fixtures: { uniqueRepos: Object.keys(forks.repositories ?? {}).length, forkRepos: forkCount },
  totals: model.totals,
  familySizeDistribution: [...sizes.entries()].sort((a, b) => a[0] - b[0]),
  relationFamilies,
  relationEntries,
  externalRootFamilies: model.families.filter((family) => family.externalRoot !== null).length,
  multiEntryFamilies: model.families.filter((family) => family.entries.length > 1).length,
}, null, 2));

const examples = {
  'dsh-forge-studio': '@zzerx/dsh-plugin-notes',
  'panando/dsh-pua': '@panando/dsh-pua',
  'michengai/dsh-pua': '@michengai/dsh-pua',
};
for (const [label, name] of Object.entries(examples)) {
  const entry = model.byName.get(name);
  if (entry === undefined) { console.log(label, '=> missing'); continue; }
  const family = model.familyById.get(entry.lineage.familyId);
  console.log(label, '=>', JSON.stringify({ family: family?.id, entries: family?.entries, relation: entry.lineage.relation, rootRepo: entry.lineage.rootRepo }));
}
let shown = 0;
for (const family of model.families) {
  if (family.relationCounts.fork > 0 && shown < 8) {
    shown++;
    console.log('fork family:', JSON.stringify({ id: family.id, rootRepo: family.rootRepo, external: family.externalRoot, entries: family.entries }));
  }
}
