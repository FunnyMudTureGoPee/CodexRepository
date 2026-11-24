/**
 * End-to-end pipeline test: real catalog loader, real market pager and real fork
 * snapshot against a fake `pluginMarket` service backed by the downloaded index.
 * No profile, no network, no HTTP — this is the closest offline run to the installed
 * Host plugin.
 *
 * Run: <node> test/pipeline.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { InsightStore } from '../host/store.mjs';
import { loadCatalog } from '../host/catalog.mjs';

const DATA = 'D:/DSH/WorkShop/dsh-market-plus/data';
const FORKS = 'D:/DSH/WorkShop/dsh-market-insight/data/forks.json';
const hasData = fs.existsSync(`${DATA}/index.json`) && fs.existsSync(`${DATA}/plugins.json`);
const node = process.version;

/** Minimal fake of the Host pluginMarket service: pages through the raw index. */
class FakeMarket {
  constructor(index) {
    this.index = index;
    this.entries = index.plugins.map((plugin) => {
      const versions = plugin.versions.map((version) => ({
        ...version,
        install: { spec: `${plugin.name}@${version.version}` },
        compatibility: { compatible: true },
      }));
      return { ...plugin, versions, defaultVersion: versions[0]?.version, installation: { status: 'not-installed' } };
    });
  }
  listIndexes() {
    return [{ url: 'fixture://catalog/index.json', title: this.index.title, description: this.index.description }];
  }
  async search(url, query) {
    const page = this.entries.slice(query.offset, query.offset + query.limit);
    return {
      url,
      title: this.index.title,
      description: this.index.description,
      metadata: this.index.metadata,
      fetchedAt: 1,
      entries: page,
      total: this.entries.length,
      nextOffset: query.offset + page.length < this.entries.length ? query.offset + page.length : null,
    };
  }
}

/** Minimal fake of pluginManager; verifies the market annotator path is avoided. */
const fakeManager = {
  async listBundles() {
    return [{ name: 'dshmarket', version: '1.0.0', installed: true }];
  },
  listVersionExemptions() {
    return { exemptions: {}, warnings: [] };
  },
};

test('catalog loader compacts and caches the real catalog', { skip: !hasData }, async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-insight-cat-'));
  try {
    const catalog = await loadCatalog({ cacheDir, url: 'fixture://catalog', localPath: `${DATA}/plugins.json` });
    assert.equal(catalog.count, 8489, 'the catalog total is preserved for display');
    assert.ok(catalog.plugins.length > 4000, 'npm-published rows are kept for the join');
    const first = catalog.plugins[0];
    assert.equal(typeof first.npm, 'string');
    assert.equal(typeof first.stars, 'number');
    assert.ok('description' in first);
    const again = await loadCatalog({ cacheDir, url: 'fixture://catalog', localPath: `${DATA}/plugins.json` });
    assert.equal(again.plugins.length, catalog.plugins.length, 'second load serves the cache');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('store pipeline: fake market + real catalog + real forks', { skip: !hasData }, async () => {
  const index = JSON.parse(fs.readFileSync(`${DATA}/index.json`, 'utf8'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-insight-pipe-'));
  // Copy the bundled snapshot so enrichment never runs; the loader resolves it from
  // the package path, which is what the installed plugin uses too.
  assert.equal(fs.existsSync(FORKS), true);
  const store = new InsightStore({
    pluginMarket: new FakeMarket(index),
    pluginManager: fakeManager,
    cacheDir,
    catalogUrl: 'fixture://catalog',
    catalogLocalPath: `${DATA}/plugins.json`,
  });
  try {
    await store.refresh({ force: true });
    const status = store.status();
    assert.equal(status.state, 'ready', JSON.stringify(status.error));
    assert.equal(status.totals.plugins, 4389);
    assert.ok(status.catalog.count > 8000);
    assert.ok(status.forks.repositories > 4000);
    assert.ok(status.forks.forks > 0);

    const page = await store.search({ q: '', sort: 'stars', group: true, limit: 10 });
    assert.equal(page.items.length, 10);
    assert.equal(page.items[0].kind, 'family');
    assert.ok(page.items[0].totalStars > 0);
    assert.ok(page.categories.length > 10);
    assert.ok(page.nextOffset === 10);

    const withStars = page.items.map((item) => item.root.stars ?? 0);
    assert.ok(withStars.every((value) => value > 0), 'top families all have stars');

    const q = await store.search({ q: '记忆', group: true, limit: 5 });
    assert.ok(q.items.length > 0);

    const flat = await store.search({ group: false, sort: 'downloads', limit: 5 });
    assert.ok(flat.items.length === 5);
    const downloads = flat.items.map((item) => item.downloads ?? -1);
    assert.deepEqual(downloads, [...downloads].sort((a, b) => b - a));

    const detail = await store.entry(page.items[0].root.name);
    assert.ok(detail !== undefined);
    assert.ok(detail.versions.length > 0);
    assert.equal(detail.family.entries[0].isRoot, true);

    const missing = await store.search({ q: 'zzzz-not-a-plugin-name', group: true });
    assert.equal(missing.items.length, 0);
  } finally {
    store.dispose();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ node, pipeline: 'ok' }));
});
