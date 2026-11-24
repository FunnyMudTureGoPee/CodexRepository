/**
 * Store-level tests: model construction, search, family grouping, detail pages and the
 * family aggregation of real market/catalog data. Fixtures are annotated in the same
 * shape the Host `pluginMarket` service returns, so no network or profile is needed.
 *
 * Run: <node> --test test/store.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { buildInsightModel, InsightStore, compareVersions, installationOf } from '../host/store.mjs';

const DATA = 'D:/DSH/WorkShop/dsh-market-plus/data';
const hasRealData = fs.existsSync(`${DATA}/index.json`) && fs.existsSync(`${DATA}/plugins.json`);

/** Annotate a raw format-1 index plugin like pluginMarket.search does. */
function annotate(plugin) {
  const versions = plugin.versions.map((version) => ({
    ...version,
    install: { spec: `${plugin.name}@${version.version}` },
    compatibility: { compatible: true },
  }));
  return {
    ...plugin,
    versions,
    defaultVersion: versions[0]?.version,
    installation: { status: 'not-installed' },
  };
}

function loadRealFixtures() {
  const index = JSON.parse(fs.readFileSync(`${DATA}/index.json`, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(`${DATA}/plugins.json`, 'utf8'));
  const forkFile = 'D:/DSH/WorkShop/dsh-market-insight/data/forks.json';
  const forks = fs.existsSync(forkFile)
    ? JSON.parse(fs.readFileSync(forkFile, 'utf8'))
    : { repositories: {}, counts: {}, generatedAt: 'fixture' };
  let forkCount = 0;
  for (const value of Object.values(forks.repositories ?? {})) if (value?.fork === true) forkCount++;
  return {
    market: {
      url: 'https://example.test/index.json',
      title: index.title,
      description: index.description,
      metadata: index.metadata,
      fetchedAt: Date.now(),
      entries: index.plugins.map(annotate),
    },
    catalog: { plugins: catalog.plugins, updated: catalog.updated, count: catalog.count, fetchedAt: Date.now() },
    forks: { repositories: forks.repositories ?? {}, generatedAt: forks.generatedAt ?? 'fixture', counts: forks.counts ?? {}, total: Object.keys(forks.repositories ?? {}).length, forks: forkCount },
  };
}

test('compareVersions orders SemVer and prereleases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3', '1.3.0'), -1);
  assert.equal(compareVersions('1.2.3-alpha.1', '1.2.3'), -1);
  assert.equal(compareVersions('0.1.0-rc.2', '0.1.0-rc.10'), -1);
  assert.equal(compareVersions('garbage', '1.0.0'), -1);
});

test('installationOf follows the market semantics', () => {
  const entry = { name: '@scope/pkg', version: '2.0.0', installation: 'not-installed', installedVersion: undefined };
  assert.deepEqual(installationOf(entry, []), { status: 'not-installed' });
  assert.deepEqual(installationOf(entry, [{ name: '@scope/pkg', version: '2.0.0', installed: true }]), { status: 'installed', installedVersion: '2.0.0' });
  assert.deepEqual(installationOf(entry, [{ name: '@scope/pkg', version: '1.0.0', installed: true }]), { status: 'update-available', installedVersion: '1.0.0' });
  assert.deepEqual(installationOf(entry, [{ name: '@scope/pkg', installed: false, availability: 'installation' }]), { status: 'provided' });
});

test('fixture model groups same-repo plugins and exposes stars', () => {
  const market = {
    url: 'fixture://market',
    title: { en: 'Fixture Market', zh: '夹具市场' },
    description: { en: 'fixture' },
    metadata: { categories: { ui: { title: { en: 'UI', zh: '界面' } } } },
    fetchedAt: 1,
    entries: [
      annotatedEntry('@scope/a', 'https://github.com/acme/mono', 'packages/a', 10, '2026-01-01', 'ui'),
      annotatedEntry('@scope/b', 'https://github.com/acme/mono', 'packages/b', 4, '2026-02-01', 'ui'),
      annotatedEntry('@scope/c', 'https://github.com/acme/solo', undefined, 0, '2026-03-01', 'memory'),
    ],
  };
  const catalog = {
    updated: '2026-11-02',
    count: 3,
    fetchedAt: 2,
    plugins: [
      { name: 'a', npm: '@scope/a', stars: 10, downloads: 100, added: '2026-01-01' },
      { name: 'b', npm: '@scope/b', stars: 4, downloads: 40, added: '2026-02-01' },
      { name: 'c', npm: '@scope/c', stars: 0, downloads: 0, added: '2026-03-01' },
    ],
  };
  const forks = { repositories: {}, generatedAt: 'fixture', total: 0, forks: 0 };
  const model = buildInsightModel({ market, catalog, forks });
  assert.equal(model.entries.length, 3);
  assert.equal(model.entries[0].stars, 10);
  assert.equal(model.entries[1].downloads, 40);
  const family = model.families.find((candidate) => candidate.entries.includes('@scope/a'));
  assert.equal(family.entries.length, 2);
  // Stars of one repository are counted once, not per package it publishes.
  assert.equal(family.totalStars, 10);
});

test('descriptions never create families: only repositories and GitHub forks do', () => {
  const market = {
    url: 'fixture://market',
    title: { en: 'Fixture' },
    metadata: { categories: {} },
    fetchedAt: 1,
    entries: [
      annotatedEntry('@upstream/plugin', 'https://github.com/upstream/plugin', undefined, 50, '2026-01-01', 'ui'),
      annotatedEntry('@fork/plugin', 'https://github.com/fork/plugin', undefined, 2, '2026-02-01', 'ui'),
    ],
  };
  const catalog = {
    updated: 'now',
    count: 2,
    fetchedAt: 2,
    plugins: [
      { name: 'plugin', owner: 'upstream', url: 'https://github.com/upstream/plugin', npm: '@upstream/plugin', stars: 50, description: { en: 'Upstream plugin.' } },
      { name: 'plugin', owner: 'fork', url: 'https://github.com/fork/plugin', npm: '@fork/plugin', stars: 2, description: { en: 'Fork of @upstream/plugin that adds a toggle.' } },
    ],
  };
  const model = buildInsightModel({ market, catalog, forks: { repositories: {}, generatedAt: 'fixture', total: 0, forks: 0 } });
  const upstreamFamily = model.byName.get('@upstream/plugin').lineage.familyId;
  const forkFamily = model.byName.get('@fork/plugin').lineage.familyId;
  assert.notEqual(forkFamily, upstreamFamily, 'prose must not join the two entries');
  assert.equal(model.familyById.get(upstreamFamily).entries.length, 1);
  assert.equal(model.familyById.get(forkFamily).entries.length, 1);
});

function annotatedEntry(name, repositoryUrl, directory, stars, added, category) {
  return {
    name,
    title: { en: name, zh: name },
    description: { en: `${name} description` },
    homepage: repositoryUrl,
    repository: { url: repositoryUrl, ...(directory === undefined ? {} : { directory }) },
    metadata: { category, keywords: [], labels: [], sortKeys: {} },
    versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' }, engines: {}, install: { spec: `${name}@1.0.0` }, compatibility: { compatible: true } }],
    defaultVersion: '1.0.0',
    installation: { status: 'not-installed' },
  };
}

test('real market data: totals, stars join, same-repo families, GitHub fork evidence', { skip: !hasRealData }, async () => {
  const fixtures = loadRealFixtures();
  const model = buildInsightModel(fixtures);
  assert.equal(model.entries.length, 4389);
  assert.ok(model.entries.filter((entry) => typeof entry.stars === 'number').length > 4000, 'most entries join the catalog');
  assert.ok(model.families.length < model.entries.length, 'families merge some entries');
  assert.ok(model.totals.grouped > 150, `same-source entries are grouped (got ${String(model.totals.grouped)})`);

  // Only the two verifiable relation kinds may be emitted.
  const relations = new Set(model.entries.map((entry) => entry.lineage?.relation));
  for (const relation of relations) {
    assert.ok(relation === null || relation === 'upstream' || relation === 'same-repo' || relation === 'fork', `unexpected relation ${String(relation)}`);
  }

  const notesFamily = model.familyById.get(model.byName.get('@zzerx/dsh-plugin-notes').lineage.familyId);
  assert.equal(notesFamily.entries.length, 4, 'the four dsh-forge-studio packages share one family');

  // README claims are not evidence: panando/dsh-pua says "Fork of @michengai/dsh-pua"
  // but its repository is not a GitHub fork, so the two entries stay separate.
  const pua = model.byName.get('@panando/dsh-pua');
  const micheng = model.byName.get('@michengai/dsh-pua');
  assert.ok(pua !== undefined && micheng !== undefined);
  assert.notEqual(pua.lineage.familyId, micheng.lineage.familyId, 'prose-only forks are not grouped');

  // GitHub fork evidence still builds families: some entry is a fork whose family
  // contains the upstream entry.
  const forkEntries = model.entries.filter((entry) => entry.lineage?.relation === 'fork');
  assert.ok(forkEntries.length > 0, 'the snapshot contains GitHub forks inside the market');
  const withUpstream = forkEntries.filter((entry) => model.familyById.get(entry.lineage.familyId).entries.some((name) => model.byName.get(name)?.lineage?.relation === 'upstream'));
  assert.ok(withUpstream.length > 0, 'at least one fork family keeps a market upstream root');

  // External upstream repositories produce externalRoot families.
  const externalFamilies = model.families.filter((family) => family.externalRoot !== null);
  assert.ok(externalFamilies.length > 0, 'forks of repositories outside the market are grouped under an external root');
});

test('store answers status, search, and entry from fixtures', { skip: !hasRealData }, async () => {
  const fixtures = loadRealFixtures();
  const store = new InsightStore({ fixtures, cacheDir: 'D:/DSH/WorkShop/dsh-market-insight/data/test-cache' });
  await store.refresh({ force: true });
  const status = store.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.totals.plugins, 4389);

  const grouped = await store.search({ q: '记忆', group: true, sort: 'stars', limit: 5 });
  assert.ok(grouped.items.length > 0);
  assert.equal(grouped.items[0].kind, 'family');
  assert.ok(grouped.items.every((item) => typeof item.totalStars === 'number'));

  const flat = await store.search({ group: false, sort: 'stars', limit: 3 });
  assert.equal(flat.items.length, 3);
  assert.ok((flat.items[0].stars ?? 0) >= (flat.items[1].stars ?? 0));

  const detail = await store.entry(flat.items[0].name);
  assert.ok(detail !== undefined);
  assert.ok(detail.family !== undefined);
  assert.ok(Array.isArray(detail.versions));
  store.dispose();
});
