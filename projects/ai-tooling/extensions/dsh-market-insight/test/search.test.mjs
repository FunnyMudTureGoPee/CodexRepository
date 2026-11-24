/**
 * Tests for host/search.mjs (CONTRACT.md §3.4).
 *
 * The fixture tests pin tokenization (NFKC, lowercase, CJK bigrams), field weights,
 * AND semantics, prefix matching, bounded edit distance, empty queries and
 * determinism. The last test runs the index against the real market index to check
 * scale and the examples called out in the acceptance criteria (for example 记忆).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { segment, buildIndex, matchText } from '../host/search.mjs';

/* -------------------------------------------------------------------------- */
/* Real data discovery                                                        */
/* -------------------------------------------------------------------------- */

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const DEV_DATA_DIR = 'D:/DSH/WorkShop/dsh-market-plus/data';

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const indexDoc = readJsonIfExists(path.join(projectRoot, 'data', 'index.json'))
  ?? readJsonIfExists(path.join(DEV_DATA_DIR, 'index.json'));
const catalogDoc = readJsonIfExists(path.join(projectRoot, 'data', 'plugins.json'))
  ?? readJsonIfExists(path.join(DEV_DATA_DIR, 'plugins.json'));
const realMarketEntries = Array.isArray(indexDoc?.plugins) ? indexDoc.plugins : undefined;
const realCategories = catalogDoc?.categories !== null && typeof catalogDoc?.categories === 'object' ? catalogDoc.categories : {};
const hasRealData = realMarketEntries !== undefined;

/** Normalize a market entry the way the Lead's Host pipeline will. */
function normalizeMarketEntry(raw) {
  const categoryId = raw?.metadata?.category;
  const categoryTitle = typeof categoryId === 'string' ? realCategories[categoryId] : undefined;
  return {
    name: raw.name,
    title: { en: raw.title },
    description: raw.description,
    categoryTitle,
  };
}

/** Sorted array form of a score map, for deterministic assertions. */
function sortedScores(map) {
  return [...map.entries()].sort((left, right) => left[0] - right[0]);
}

/* -------------------------------------------------------------------------- */
/* Segmentation                                                               */
/* -------------------------------------------------------------------------- */

test('segment: words, digits and separators', () => {
  assert.deepEqual(segment('Hello, World!'), ['hello', 'world']);
  assert.deepEqual(segment('dsh-plugin-memory_v2'), ['dsh', 'plugin', 'memory', 'v2']);
  assert.deepEqual(segment('  **Alpha.Beta**  '), ['alpha', 'beta']);
  assert.deepEqual(segment('Node24 x64'), ['node24', 'x64']);
});

test('segment: NFKC normalization and lowercasing', () => {
  assert.deepEqual(segment('ＡＢＣ'), ['abc']);
  assert.deepEqual(segment('Café'), ['café']);
  assert.deepEqual(segment('Ｆｕｌｌｗｉｄｔｈ１２'), ['fullwidth12']);
});

test('segment: CJK runs expand to overlapping bigrams plus trailing character', () => {
  assert.deepEqual(segment('记忆'), ['记忆', '忆']);
  assert.deepEqual(segment('记忆系统'), ['记忆', '忆系', '系统', '统']);
  assert.deepEqual(segment('记'), ['记']);
  // Scripts never mix inside one run, so mixed text keeps its Latin token intact.
  assert.deepEqual(segment('dsh记忆插件'), ['dsh', '记忆', '忆插', '插件', '件']);
  assert.deepEqual(segment('插件dsh'), ['插件', '件', 'dsh']);
  // Japanese kana are CJK too.
  assert.deepEqual(segment('メモリ'), ['メモ', 'モリ', 'リ']);
});

test('segment: punctuation and symbol-only text produces no terms', () => {
  assert.deepEqual(segment(''), []);
  assert.deepEqual(segment('!!! ??? …'), []);
  assert.deepEqual(segment('—–·•'), []);
  assert.deepEqual(segment(undefined), []);
  assert.deepEqual(segment(42), []);
});

/* -------------------------------------------------------------------------- */
/* Field weights and AND semantics                                            */
/* -------------------------------------------------------------------------- */

test('matchText: field weights are name/title 3, category 2, description 1', () => {
  const index = buildIndex([
    { name: 'alpha', description: { en: 'gamma helper' } },
    { name: 'beta', title: { en: 'Memory' } },
    { name: 'delta', categoryTitle: { en: 'Memory' } },
  ]);
  assert.deepEqual(sortedScores(matchText(index, 'alpha')), [[0, 3]]);
  assert.deepEqual(sortedScores(matchText(index, 'gamma')), [[0, 1]]);
  assert.deepEqual(sortedScores(matchText(index, 'memory')), [[1, 3], [2, 2]]);
});

test('matchText: the strongest field wins per term (no double counting)', () => {
  const index = buildIndex([
    { name: 'memory', description: { en: 'memory', zh: '记忆' }, title: { en: 'Memory' }, categoryTitle: { en: 'Memory' } },
  ]);
  // One query term, the same word in four fields: score is max(3, 3, 2, 1) = 3.
  assert.deepEqual(sortedScores(matchText(index, 'memory')), [[0, 3]]);
});

test('matchText: query terms are ANDed and their weights are summed', () => {
  const index = buildIndex([
    { name: 'alpha', description: { en: 'beta' } },
    { name: 'alpha only' },
    { name: 'beta only' },
  ]);
  assert.deepEqual(sortedScores(matchText(index, 'alpha beta')), [[0, 4]]);
  assert.deepEqual(sortedScores(matchText(index, 'alpha')), [[0, 3], [1, 3]]);
  assert.deepEqual(sortedScores(matchText(index, 'alpha nothing')), []);
});

test('matchText: multi-script query combines CJK and Latin terms', () => {
  const index = buildIndex([
    { name: 'dsh-memory', title: { zh: '项目记忆' } },
    { name: 'unrelated' },
  ]);
  // Segments: dsh (+3 name), 记忆 (+3 title) and the trailing bigram 忆 (+3 title).
  const scores = matchText(index, 'dsh 记忆');
  assert.equal(scores.size, 1);
  assert.equal(scores.get(0), 9);
});

/* -------------------------------------------------------------------------- */
/* Prefix and fuzzy matching                                                  */
/* -------------------------------------------------------------------------- */

test('matchText: query terms match as prefixes of indexed terms', () => {
  const index = buildIndex([
    { name: 'terminal' },
    { name: 'terminator' },
    { name: 'other' },
  ]);
  assert.deepEqual(sortedScores(matchText(index, 'term')), [[0, 3], [1, 3]]);
  assert.deepEqual(sortedScores(matchText(index, 'termina')), [[0, 3], [1, 3]]);
  assert.deepEqual(sortedScores(matchText(index, 'terminator')), [[1, 3]]);
});

test('matchText: bounded edit distance matches typos for query terms of 4+ code points', () => {
  const index = buildIndex([{ name: 'memory' }]);
  // 7 or 5 code points: max(1, round(len / 5)) = 1 → one typo is allowed.
  assert.deepEqual(sortedScores(matchText(index, 'memoory')), [[0, 3]]);
  assert.deepEqual(sortedScores(matchText(index, 'memry')), [[0, 3]]);
  // 4 code points: max(1, round(4 / 5)) = 1.
  assert.deepEqual(sortedScores(matchText(index, 'memmory')), [[0, 3]]);

  // Query terms shorter than 4 code points never use edit distance.
  const shortIndex = buildIndex([{ name: 'abd' }]);
  assert.deepEqual(sortedScores(matchText(shortIndex, 'abc')), []);
  // ...but prefix matching still applies at any length.
  assert.deepEqual(sortedScores(matchText(shortIndex, 'ab')), [[0, 3]]);
});

/* -------------------------------------------------------------------------- */
/* CJK queries                                                                */
/* -------------------------------------------------------------------------- */

test('matchText: Chinese query hits Chinese fields through bigrams', () => {
  const index = buildIndex([
    {
      name: '@acme/dsh-memory',
      title: { zh: '项目记忆' },
      description: { zh: '持久化记忆', en: 'persistent memory' },
      categoryTitle: { zh: '记忆', en: 'Memory' },
    },
    { name: 'unrelated', description: { zh: '完全无关' } },
  ]);
  // 记忆 expands to ["记忆", "忆"]; both terms hit the memory entry (max weight 3).
  assert.deepEqual(sortedScores(matchText(index, '记忆')), [[0, 6]]);
  // 持久 expands to ["持久", "久"], which only matches the description (weight 1).
  assert.deepEqual(sortedScores(matchText(index, '持久')), [[0, 2]]);
  // A bigram that spans no word boundary in the entry does not match.
  assert.deepEqual(sortedScores(matchText(index, '项目')), [[0, 6]]);
  assert.deepEqual(sortedScores(matchText(index, '无关')), [[1, 2]]);
});

/* -------------------------------------------------------------------------- */
/* Empty queries and determinism                                              */
/* -------------------------------------------------------------------------- */

test('matchText: a query without letters/digits returns every entry with score 0', () => {
  const entries = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }];
  const index = buildIndex(entries);
  for (const query of ['', '   ', '!!!', '— ??? —']) {
    const scores = matchText(index, query);
    assert.equal(scores.size, entries.length, `query ${JSON.stringify(query)}`);
    for (const score of scores.values()) assert.equal(score, 0);
  }
});

test('matchText: results are deterministic across calls and entry order is irrelevant', () => {
  const entries = [
    { name: 'alpha', description: { en: 'shared keyword' } },
    { name: 'beta', description: { en: 'shared keyword' } },
    { name: 'gamma', title: { en: 'keyword' } },
  ];
  const first = matchText(buildIndex(entries), 'keyword');
  const second = matchText(buildIndex(entries), 'keyword');
  assert.deepEqual(sortedScores(first), sortedScores(second));
  assert.deepEqual(sortedScores(first), [[0, 1], [1, 1], [2, 3]]);

  // A different input order must produce the same score for each name.
  const reordered = [entries[2], entries[0], entries[1]];
  const reorderedScores = matchText(buildIndex(reordered), 'keyword');
  const scoreByName = new Map();
  for (const [entryIndex, score] of reorderedScores) scoreByName.set(reordered[entryIndex].name, score);
  assert.equal(scoreByName.get('alpha'), 1);
  assert.equal(scoreByName.get('beta'), 1);
  assert.equal(scoreByName.get('gamma'), 3);
});

/* -------------------------------------------------------------------------- */
/* Real dataset gate                                                          */
/* -------------------------------------------------------------------------- */

test('real market data: 4389 entries index quickly and answer CJK/Latin queries', { skip: !hasRealData && 'market index not available' }, () => {
  const entries = realMarketEntries.map(normalizeMarketEntry);
  const started = performance.now();
  const index = buildIndex(entries);
  const buildMs = performance.now() - started;
  assert.equal(index.entryCount, entries.length);
  assert.ok(index.terms.length > 10_000, `expected a rich term lexicon, got ${index.terms.length}`);

  const byName = new Map(entries.map((entry, entryIndex) => [entry.name, entryIndex]));

  // CJK: 记忆 is the memory category and appears in many descriptions.
  const memoryScores = matchText(index, '记忆');
  assert.ok(memoryScores.size > 100, `expected many 记忆 hits, got ${memoryScores.size}`);
  const projectMemory = byName.get('@yolk_vat-y/dsh-project-memory');
  assert.ok(projectMemory !== undefined, 'expected the project-memory plugin in the index');
  assert.ok(memoryScores.has(projectMemory), '记忆 must hit the project-memory plugin');

  // Latin: pua hits the two pua plugins.
  const puaScores = matchText(index, 'pua');
  assert.ok(puaScores.has(byName.get('@michengai/dsh-pua')), 'pua must hit @michengai/dsh-pua');
  assert.ok(puaScores.has(byName.get('@panando/dsh-pua')), 'pua must hit @panando/dsh-pua');

  // Exact package name, hyphenated: all three terms must hit.
  const exactScores = matchText(index, 'dsh-plugin-memory');
  assert.ok(exactScores.size > 0);
  assert.ok(exactScores.has(byName.get('@zzerx/dsh-plugin-memory')), 'dsh-plugin-memory must hit @zzerx/dsh-plugin-memory');

  // Empty query: every entry, score 0.
  const emptyScores = matchText(index, '');
  assert.equal(emptyScores.size, entries.length);
  for (const score of emptyScores.values()) assert.equal(score, 0);

  // Typo tolerance on the real lexicon.
  assert.ok(matchText(index, 'memoory').size > 0);

  // Determinism.
  assert.deepEqual(sortedScores(matchText(index, 'terminal')), sortedScores(matchText(index, 'terminal')));

  const queryMs = performance.now() - started - buildMs;
  console.log('[search real data]', JSON.stringify({
    entries: entries.length,
    terms: index.terms.length,
    buildMs: Math.round(buildMs * 10) / 10,
    queryMs: Math.round(queryMs * 10) / 10,
    memoryHits: memoryScores.size,
    puaHits: puaScores.size,
  }));
  assert.ok(buildMs < 5000, `buildIndex took ${buildMs.toFixed(1)} ms`);
});
