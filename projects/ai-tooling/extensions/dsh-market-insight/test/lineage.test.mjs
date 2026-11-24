/**
 * Lineage tests: families are built only from repository facts.
 *
 *   1. `same-repo` — entries sharing one GitHub repository;
 *   2. `fork`      — GitHub fork network metadata from the fork snapshot.
 *
 * Descriptions, READMEs and package names must never create a family.
 *
 * Run: <node> test/lineage.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { buildFamilies } from '../host/lineage.mjs';

const DATA = 'D:/DSH/WorkShop/dsh-market-plus/data';
const FORKS_FILE = 'D:/DSH/WorkShop/dsh-market-insight/data/forks.json';
const hasRealData = fs.existsSync(`${DATA}/index.json`) && fs.existsSync(`${DATA}/plugins.json`) && fs.existsSync(FORKS_FILE);

/** A market entry with only the fields lineage reads. */
function entry(name, repositoryUrl, description) {
  return {
    name,
    homepage: repositoryUrl,
    repository: repositoryUrl === undefined ? undefined : { url: repositoryUrl },
    description: description === undefined ? undefined : { en: description },
  };
}

/** Snapshot row set for one fixture. */
function snapshot(repositories) {
  return { repositories };
}

/** Sort a lineage map for stable comparison. */
function sortedMap(map) {
  return [...map.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

test('entries sharing one repository form a same-repo family', () => {
  const result = buildFamilies({
    entries: [
      entry('@scope/a', 'https://github.com/acme/mono'),
      entry('@scope/b', 'https://github.com/acme/mono'),
      entry('@scope/c', 'https://github.com/acme/mono'),
      entry('@scope/solo', 'https://github.com/acme/solo'),
    ],
    catalog: [],
    forkSnapshot: snapshot({}),
  });
  const familyOfA = result.entryLineage.get('@scope/a');
  assert.equal(result.entryFamily.get('@scope/a'), result.entryFamily.get('@scope/b'));
  assert.equal(result.entryFamily.get('@scope/a'), result.entryFamily.get('@scope/c'));
  assert.notEqual(result.entryFamily.get('@scope/a'), result.entryFamily.get('@scope/solo'));
  assert.equal(familyOfA.relation, 'upstream');
  assert.equal(familyOfA.rootRepo, 'acme/mono');
  const family = result.families.find((candidate) => candidate.id === familyOfA.familyId);
  assert.equal(family.entries.length, 3);
  assert.equal(family.relationCounts['same-repo'], 2);
  const sibling = result.entryLineage.get('@scope/b');
  assert.equal(sibling.relation, 'same-repo');
  assert.equal(sibling.parentName, '@scope/a');
});

test('a GitHub fork joins its upstream repository family', () => {
  const result = buildFamilies({
    entries: [
      entry('upstream-plugin', 'https://github.com/up/repo'),
      entry('forked-plugin', 'https://github.com/forker/repo'),
    ],
    catalog: [],
    forkSnapshot: snapshot({
      'forker/repo': { fork: true, source: 'up/repo', stars: 1 },
      'up/repo': { fork: false, source: null, stars: 10 },
    }),
  });
  const upstream = result.entryLineage.get('upstream-plugin');
  const fork = result.entryLineage.get('forked-plugin');
  assert.equal(upstream.familyId, fork.familyId);
  assert.equal(upstream.relation, 'upstream');
  assert.equal(fork.relation, 'fork');
  assert.equal(fork.rootRepo, 'up/repo');
  assert.equal(fork.depth, 1);
  assert.equal(fork.parentName, 'upstream-plugin');
  const family = result.families.find((candidate) => candidate.id === fork.familyId);
  assert.deepEqual(family.entries, ['upstream-plugin', 'forked-plugin']);
  assert.equal(family.externalRoot, null);
});

test('a fork of a repository outside the market gets an external root', () => {
  const result = buildFamilies({
    entries: [entry('forked-plugin', 'https://github.com/forker/repo')],
    catalog: [],
    forkSnapshot: snapshot({ 'forker/repo': { fork: true, source: 'external/upstream' } }),
  });
  const lineage = result.entryLineage.get('forked-plugin');
  assert.equal(lineage.rootRepo, 'external/upstream');
  assert.equal(lineage.relation, 'fork');
  const family = result.families.find((candidate) => candidate.id === lineage.familyId);
  assert.equal(family.id, 'family:external/upstream');
  assert.deepEqual(family.externalRoot, { fullName: 'external/upstream', url: 'https://github.com/external/upstream' });
});

test('independent forks of one external upstream share a family', () => {
  const result = buildFamilies({
    entries: [
      entry('fork-one', 'https://github.com/one/repo'),
      entry('fork-two', 'https://github.com/two/repo'),
    ],
    catalog: [],
    forkSnapshot: snapshot({
      'one/repo': { fork: true, source: 'external/upstream' },
      'two/repo': { fork: true, source: 'external/upstream' },
    }),
  });
  assert.equal(result.entryFamily.get('fork-one'), result.entryFamily.get('fork-two'));
  const family = result.families.find((candidate) => candidate.entries.includes('fork-one'));
  assert.equal(family.entries.length, 2);
  assert.equal(family.relationCounts.fork, 2);
});

test('descriptions and package names never create a family', () => {
  const result = buildFamilies({
    entries: [
      entry('upstream-plugin', 'https://github.com/up/plugin', 'Upstream plugin.'),
      entry('forked-plugin', 'https://github.com/fork/plugin', 'Fork of upstream-plugin that adds a toggle.'),
    ],
    catalog: [],
    forkSnapshot: snapshot({}),
  });
  assert.notEqual(result.entryFamily.get('upstream-plugin'), result.entryFamily.get('forked-plugin'));
  assert.equal(result.families.filter((family) => family.entries.length > 1).length, 0);
});

test('entries without a GitHub repository stay standalone', () => {
  const result = buildFamilies({
    entries: [entry('no-repo', undefined, 'gitlab or tarball plugin')],
    catalog: [],
    forkSnapshot: snapshot({}),
  });
  const lineage = result.entryLineage.get('no-repo');
  assert.equal(lineage.relation, null);
  assert.equal(lineage.rootRepo, null);
  assert.equal(lineage.familyId, 'family:no-repo');
  assert.equal(result.families.length, 1);
});

test('invalid entries and duplicate names are ignored', () => {
  const result = buildFamilies({
    entries: [
      null,
      { name: '' },
      entry('@scope/a', 'https://github.com/acme/mono'),
      entry('@Scope/A', 'https://github.com/other/repo'),
      entry('@scope/b', 'https://github.com/acme/mono'),
    ],
    catalog: [],
    forkSnapshot: snapshot({}),
  });
  assert.equal(result.entryLineage.size, 2);
  assert.equal(result.entryFamily.get('@scope/a'), result.entryFamily.get('@scope/b'));
});

test('output is deterministic and independent of input order', () => {
  const entries = [
    entry('a', 'https://github.com/acme/mono'),
    entry('b', 'https://github.com/acme/mono'),
    entry('c', 'https://github.com/up/repo'),
    entry('d', 'https://github.com/forker/repo'),
    entry('e', 'https://github.com/other/repo'),
  ];
  const forks = snapshot({
    'forker/repo': { fork: true, source: 'up/repo' },
    'up/repo': { fork: false, source: null },
  });
  const first = buildFamilies({ entries, catalog: [], forkSnapshot: forks });
  const second = buildFamilies({ entries: entries.slice().reverse(), catalog: [], forkSnapshot: forks });
  assert.deepEqual(sortedMap(first.entryLineage), sortedMap(second.entryLineage));
  const normalize = (families) => families
    .map((family) => ({ id: family.id, entries: family.entries.slice().sort() }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  assert.deepEqual(normalize(first.families), normalize(second.families));
});

test('real market data: repository-only families, bounded build time', { skip: !hasRealData }, () => {
  const index = JSON.parse(fs.readFileSync(`${DATA}/index.json`, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(`${DATA}/plugins.json`, 'utf8'));
  const forks = JSON.parse(fs.readFileSync(FORKS_FILE, 'utf8'));
  const entries = index.plugins.map((plugin) => ({
    name: plugin.name,
    title: plugin.title,
    description: plugin.description,
    homepage: plugin.homepage,
    repository: plugin.repository,
  }));
  const started = process.hrtime.bigint();
  const result = buildFamilies({ entries, catalog, forkSnapshot: forks });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.entryLineage.size, entries.length);
  assert.ok(elapsedMs < 300, `buildFamilies took ${elapsedMs.toFixed(1)}ms for ${String(entries.length)} entries`);

  const relations = new Set([...result.entryLineage.values()].map((lineage) => lineage.relation));
  for (const relation of relations) {
    assert.ok(relation === null || relation === 'upstream' || relation === 'same-repo' || relation === 'fork', `unexpected relation ${String(relation)}`);
  }
  assert.ok(result.families.length < entries.length, 'some entries share a family');
  const grouped = result.families.reduce((total, family) => total + family.entries.length - 1, 0);
  assert.ok(grouped > 150, `families merge some entries (got ${String(grouped)})`);

  // The monorepo family is factual: one repository, four published packages.
  const notes = result.entryLineage.get('@zzerx/dsh-plugin-notes');
  const notesFamily = result.families.find((family) => family.id === notes.familyId);
  assert.equal(notesFamily.entries.length, 4);

  // README claims carry no weight: panando/dsh-pua says "Fork of @michengai/dsh-pua"
  // but its repository is not a GitHub fork.
  const pua = result.entryLineage.get('@panando/dsh-pua');
  const micheng = result.entryLineage.get('@michengai/dsh-pua');
  assert.notEqual(pua.familyId, micheng.familyId);
  assert.equal(pua.relation, 'upstream');

  // GitHub fork evidence: each fork lineage points at a fork-network root, and
  // forks of repositories outside the market produce externalRoot families.
  const forkLineages = [...result.entryLineage.values()].filter((lineage) => lineage.relation === 'fork');
  assert.ok(forkLineages.length > 0, 'the snapshot contains GitHub forks inside the market');
  for (const lineage of forkLineages) assert.equal(typeof lineage.rootRepo, 'string');
  const externalFamilies = result.families.filter((family) => family.externalRoot !== null);
  assert.ok(externalFamilies.length > 0, 'forks of repositories outside the market are grouped');
  for (const family of externalFamilies) {
    assert.match(family.externalRoot.fullName, /^[^/]+\/[^/]+$/);
    assert.ok(family.entries.length >= 1);
  }
});
