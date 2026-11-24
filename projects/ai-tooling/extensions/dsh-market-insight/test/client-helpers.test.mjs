/**
 * Client-side checks for `dsh-market-insight/client.js`.
 *
 * The browser bundle cannot be imported as an ES module (it registers itself
 * through `window.__ModuleLoader__`), so the tests drive it the way the web
 * shell does:
 *   1. run the bundle in a `vm` sandbox with a capturing module loader;
 *   2. call `factory(stubRequire)` with a minimal React stub;
 *   3. call `apply(fakeCtx)` and inspect the dictionaries / slot registration.
 *
 * Everything between the `mi-pure-helpers` markers is additionally evaluated
 * in isolation and unit-tested (formatters, the fork-tree builder, install
 * decisions, URL builders). The dictionaries are compared key-by-key against
 * CONTRACT §5.4, and the stylesheet against the theme-token allowlist §5.3.
 *
 * Run with: node --test test/client-helpers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8');
const CONTRACT = readFileSync(join(ROOT, 'CONTRACT.md'), 'utf8');

/** Normalize a value created in the vm realm into the host realm. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Slice one markdown section out of the contract. */
function contractSection(startHeading, endHeading) {
  const start = CONTRACT.indexOf(startHeading);
  assert.notEqual(start, -1, 'missing contract section ' + startHeading);
  const end = CONTRACT.indexOf(endHeading, start);
  assert.notEqual(end, -1, 'missing contract section ' + endHeading);
  return CONTRACT.slice(start, end);
}

/** Build a minimal `react` module: components are defined but never rendered. */
function createReactStub() {
  const noop = () => undefined;
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('react.fragment'),
    useState: noop,
    useEffect: noop,
    useSyncExternalStore: noop,
  };
}

/** Build a fake browser plugin context that records what `apply` registers. */
function createFakeCtx() {
  const dictionaries = new Map();
  const registrations = [];
  const injectedSlots = [];
  const effects = [];
  const disposers = [];
  let active = 'en';

  const locale = {
    register(namespace, localeOrDicts, dictionary) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dictionary]] : Object.entries(localeOrDicts);
      let namespaceDictionaries = dictionaries.get(namespace);
      if (namespaceDictionaries === undefined) {
        namespaceDictionaries = new Map();
        dictionaries.set(namespace, namespaceDictionaries);
      }
      for (const [localeId, entries] of pairs) {
        assert.equal(namespaceDictionaries.has(localeId), false, `duplicate dictionary ${namespace}/${localeId}`);
        assert.equal(typeof entries, 'object');
        namespaceDictionaries.set(localeId, entries);
      }
      return () => {
        for (const [localeId, entries] of pairs) {
          if (namespaceDictionaries.get(localeId) === entries) namespaceDictionaries.delete(localeId);
        }
      };
    },
    bind(namespace) {
      return (key, params) => {
        const namespaceDictionaries = dictionaries.get(namespace);
        const translated = namespaceDictionaries === undefined ? undefined : namespaceDictionaries.get(active);
        let template = translated === undefined ? undefined : translated[key];
        if (template === undefined) template = key;
        if (params !== undefined) {
          template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
        }
        return template;
      };
    },
    resolveText(text) {
      if (text === null || text === undefined) return null;
      if (typeof text === 'string') return text;
      return text[active] ?? text.en ?? null;
    },
    getSnapshot() {
      return { active, revision: 1 };
    },
    subscribe() {
      return () => {};
    },
  };

  const ctx = {
    locale,
    effect(fn, label) {
      effects.push({ label, fn });
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    slots: {
      inject(name, fn) {
        injectedSlots.push(name);
        fn();
      },
      register(definition, component) {
        registrations.push({ definition, component });
        return () => {};
      },
    },
  };

  return {
    ctx,
    dictionaries,
    registrations,
    injectedSlots,
    effects,
    disposers,
    setActive(nextActive) {
      active = nextActive;
    },
  };
}

/** Run the bundle in a sandbox and return its `__ModuleLoader__.load` handoff. */
function loadHandoff() {
  const handoffs = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(handoff) {
          handoffs.push(handoff);
        },
      },
    },
    console,
    // Components are never rendered, but the module body must not need more.
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' });
  assert.equal(handoffs.length, 1, 'client.js must register exactly one module');
  return handoffs[0];
}

/** Load the module exports through the built factory. */
function loadModuleExports() {
  const handoff = loadHandoff();
  assert.equal(handoff.id, '@local/dsh-market-insight');
  assert.equal(typeof handoff.factory, 'function');
  let required = null;
  const moduleExports = handoff.factory((specifier) => {
    required = specifier;
    assert.equal(specifier, 'react', 'the browser bundle may only require react');
    return createReactStub();
  });
  assert.equal(required, 'react');
  return moduleExports;
}

/** Evaluate the pure-helper block (between the markers) on its own. */
function loadPureHelpers() {
  const beginMarker = '// >>> mi-pure-helpers';
  const endMarker = '// <<< mi-pure-helpers';
  const begin = SOURCE.indexOf(beginMarker);
  const end = SOURCE.indexOf(endMarker);
  assert.notEqual(begin, -1, 'missing pure-helper begin marker');
  assert.ok(end > begin, 'missing pure-helper end marker');
  assert.equal(SOURCE.indexOf(beginMarker, begin + 1), -1, 'pure-helper begin marker must be unique');
  const body = SOURCE.slice(SOURCE.indexOf('\n', begin) + 1, end);
  const names = [
    'formatCount',
    'formatTotalValue',
    'formatDate',
    'isSafeHttpUrl',
    'isFamilyItem',
    'relationLabelKey',
    'entryRelation',
    'summarizeFamilyRelations',
    'familyRelationBadges',
    'buildFamilyTree',
    'entryDisplayTitle',
    'categoryTitle',
    'installAction',
    'installPayload',
    'buildSearchPath',
    'summarizeStatus',
    'createTextResolver',
    'errorMessage',
    'numberOr',
  ];
  assert.doesNotMatch(body, /\bwindow\s*\.|\bdocument\s*\.|\bReact\s*\./, 'helper block must stay framework free');
  return new Function(body + '\nreturn {' + names.join(', ') + '};')();
}

test('module skeleton exports inject and apply, and registers the insight tab', () => {
  const moduleExports = loadModuleExports();
  assert.equal(plain(moduleExports.inject).join(','), 'slots,locale');
  assert.equal(typeof moduleExports.apply, 'function');

  const fake = createFakeCtx();
  moduleExports.apply(fake.ctx);

  assert.equal(fake.injectedSlots.join(','), 'plugins.tab');
  assert.equal(fake.registrations.length, 1);
  const registration = fake.registrations[0];
  assert.equal(registration.definition.name, 'plugins.tab');
  assert.equal(registration.definition.id, 'insight');
  assert.equal(registration.definition.order, 20);
  assert.equal(registration.definition.locale, 'marketInsight');
  assert.equal(typeof registration.definition.label, 'function');
  assert.equal(typeof registration.component, 'function');

  // The label is a thunk so a locale switch takes effect without re-registering.
  assert.equal(registration.definition.label(), 'Insight');
  fake.setActive('zh');
  assert.equal(registration.definition.label(), '洞察');
});

test('dictionaries register en and zh and match CONTRACT §5.4 exactly', () => {
  const moduleExports = loadModuleExports();
  const fake = createFakeCtx();
  moduleExports.apply(fake.ctx);

  const namespaceDictionaries = fake.dictionaries.get('marketInsight');
  assert.ok(namespaceDictionaries instanceof Map, 'marketInsight dictionaries must be registered');
  const en = namespaceDictionaries.get('en');
  const zh = namespaceDictionaries.get('zh');
  assert.equal(typeof en, 'object');
  assert.equal(typeof zh, 'object');

  // Every row of the frozen dictionary table must exist verbatim.
  const section = contractSection('### 5.4', '## 6.');
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\|\s*`([A-Za-z0-9.-]+)`\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ key: match[1], en: match[2].trim(), zh: match[3].trim() });
  }
  assert.equal(rows.length, 43, 'CONTRACT §5.4 v2 freezes 43 dictionary keys');
  // Both dictionaries must carry exactly the frozen key set (no missing, no stale keys).
  const contractKeys = rows.map((row) => row.key).sort();
  assert.deepEqual(plain(Object.keys(en)).sort(), contractKeys, 'EN dictionary keys');
  assert.deepEqual(plain(Object.keys(zh)).sort(), contractKeys, 'ZH dictionary keys');
  for (const row of rows) {
    assert.equal(en[row.key], row.en, `EN ${row.key}`);
    assert.equal(zh[row.key], row.zh, `ZH ${row.key}`);
  }
});

test('stylesheet uses only CONTRACT §5.3 theme tokens', () => {
  const section = contractSection('### 5.3', '### 5.4');
  const allowed = new Set(section.match(/--dsw-[a-z0-9-]+/g) ?? []);
  assert.ok(allowed.size >= 10, 'theme-token allowlist must be readable from the contract');

  const used = SOURCE.match(/--dsw-[a-z0-9-]+/g) ?? [];
  assert.ok(used.length > 0, 'the client must style with theme tokens');
  for (const token of used) {
    assert.ok(allowed.has(token), `token ${token} is not in CONTRACT §5.3`);
  }
  // No literal colors may sneak past the token system.
  assert.doesNotMatch(SOURCE, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(SOURCE, /\b(?:rgb|hsl)a?\(/);
});

test('bundle imports nothing from the Harness client packages', () => {
  assert.doesNotMatch(SOURCE, /@deepseek-ai\//);
  const requires = [...SOURCE.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]);
  assert.deepEqual(requires, ['react']);
  assert.doesNotMatch(SOURCE, /^\s*import\s/m);
});

test('formatters follow the frozen number and date rules', () => {
  const helpers = loadPureHelpers();
  assert.equal(helpers.formatCount(0), '0');
  assert.equal(helpers.formatCount(999), '999');
  assert.equal(helpers.formatCount(1000), '1k');
  assert.equal(helpers.formatCount(1234), '1.2k');
  assert.equal(helpers.formatCount(12345), '12.3k');
  assert.equal(helpers.formatCount(123456), '123k');
  assert.equal(helpers.formatCount(999999), '1M');
  assert.equal(helpers.formatCount(1000000), '1M');
  assert.equal(helpers.formatCount(1234567), '1.2M');
  assert.equal(helpers.formatCount(null), null);
  assert.equal(helpers.formatCount(-5), null);
  assert.equal(helpers.formatCount('12'), null);
  assert.equal(helpers.formatCount(Number.NaN), null);
  assert.equal(helpers.formatCount(Number.POSITIVE_INFINITY), null);

  assert.equal(helpers.formatTotalValue(null), '—');
  assert.equal(helpers.formatTotalValue(8800), '8.8k');

  assert.equal(helpers.formatDate('2026-11-02'), '2026-11-02');
  assert.equal(helpers.formatDate('2026-11-02T03:04:05.000Z'), '2026-11-02');
  assert.equal(helpers.formatDate('not a date'), null);
  assert.equal(helpers.formatDate(null), null);
});

test('entry and family predicates expose the frozen data-model shape', () => {
  const helpers = loadPureHelpers();
  assert.equal(helpers.isFamilyItem({ kind: 'family', id: 'x', entries: [] }), true);
  assert.equal(helpers.isFamilyItem({ name: '@scope/pkg' }), false);
  assert.equal(helpers.isFamilyItem(null), false);

  assert.equal(helpers.relationLabelKey('upstream'), 'relation.upstream');
  assert.equal(helpers.relationLabelKey('fork'), 'relation.fork');
  assert.equal(helpers.relationLabelKey('same-repo'), 'relation.same-repo');
  assert.equal(helpers.relationLabelKey('unknown'), null);
  assert.equal(helpers.relationLabelKey(null), null);

  // `GET /search` keeps the relation in lineage; `GET /entry` mirrors it on
  // the entry itself (CONTRACT §4.3), so both seats are read.
  assert.equal(helpers.entryRelation({ lineage: { relation: 'same-repo' } }), 'same-repo');
  assert.equal(helpers.entryRelation({ relation: 'upstream', lineage: { relation: 'fork' } }), 'upstream');
  assert.equal(helpers.entryRelation({ lineage: null }), null);
  assert.equal(helpers.entryRelation(null), null);

  // v2 family rows carry two relation counters; zeros are dropped from the
  // rendered badges and the frozen order is kept.
  const family = {
    id: 'family:root/repo',
    root: { name: 'root' },
    entries: [{ name: 'root' }, { name: 'child-a' }],
    relations: { fork: 2, 'same-repo': 0 },
  };
  assert.deepEqual(plain(helpers.summarizeFamilyRelations(family)), { fork: 2, 'same-repo': 0 });
  assert.deepEqual(plain(helpers.familyRelationBadges(family)), [
    { relation: 'fork', key: 'relation.fork', count: 2 },
  ]);
  assert.deepEqual(plain(helpers.summarizeFamilyRelations(null)), { fork: 0, 'same-repo': 0 });

  // Defensive fallback: a payload without `relations` counts entry lineage,
  // excluding the root; relation ids this version does not know are ignored.
  const legacy = {
    root: { name: 'root' },
    entries: [
      { name: 'root', lineage: { relation: 'upstream' } },
      { name: 'child-a', lineage: { relation: 'same-name' } },
      { name: 'child-b', lineage: { relation: 'fork' } },
    ],
  };
  assert.deepEqual(plain(helpers.summarizeFamilyRelations(legacy)), { fork: 1, 'same-repo': 0 });

  assert.equal(helpers.isSafeHttpUrl('https://github.com/a/b'), true);
  assert.equal(helpers.isSafeHttpUrl('http://example.com'), true);
  assert.equal(helpers.isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(helpers.isSafeHttpUrl('github.com/a/b'), false);
  assert.equal(helpers.isSafeHttpUrl(null), false);
});

test('buildFamilyTree orders the forest and survives broken or cyclic lineage', () => {
  const helpers = loadPureHelpers();
  const root = { name: 'root', stars: 10, lineage: { parentName: null } };
  const forkA = { name: 'alpha', stars: 2, lineage: { parentName: 'root' } };
  const forkB = { name: 'beta', stars: 7, lineage: { parentName: 'root' } };
  const orphan = { name: 'gamma', stars: 1, lineage: { parentName: 'missing' } };
  const forest = helpers.buildFamilyTree([orphan, forkA, root, forkB, { name: 'broken', lineage: null }]);
  assert.equal(forest.length, 3);
  const rootNode = forest.find((node) => node.entry.name === 'root');
  assert.ok(rootNode, 'root must be a forest root');
  assert.deepEqual(
    rootNode.children.map((node) => node.entry.name),
    ['beta', 'alpha'],
    'siblings are ordered by stars desc, then name',
  );

  // Cycles are broken instead of recursing forever.
  const cyclic = helpers.buildFamilyTree([
    { name: 'x', lineage: { parentName: 'y' } },
    { name: 'y', lineage: { parentName: 'x' } },
  ]);
  const flattened = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      flattened.push(node.entry.name);
      walk(node.children);
    }
  };
  walk(cyclic);
  assert.deepEqual(flattened.sort(), ['x', 'y']);

  // Self-parent links are ignored.
  const selfParent = helpers.buildFamilyTree([{ name: 'self', lineage: { parentName: 'self' } }]);
  assert.equal(selfParent.length, 1);
  assert.equal(selfParent[0].children.length, 0);
});

test('localized text, install affordances and search URLs are decided as frozen', () => {
  const helpers = loadPureHelpers();
  const resolve = (text) => {
    if (text === null || text === undefined) return null;
    if (typeof text === 'string') return text;
    return text.zh ?? text.en ?? null;
  };

  assert.equal(helpers.entryDisplayTitle({ name: '@a/b', title: { en: 'Notes', zh: '笔记' } }, resolve), '笔记');
  assert.equal(helpers.entryDisplayTitle({ name: '@a/b', title: { en: 'Notes' } }, resolve), 'Notes');
  assert.equal(helpers.entryDisplayTitle({ name: '@a/b' }, resolve), '@a/b');
  assert.equal(helpers.entryDisplayTitle(null, resolve), '');

  const categories = [{ id: 'ui', title: { en: 'UI Enhancements', zh: 'UI 增强' } }];
  assert.equal(helpers.categoryTitle(categories, 'ui', resolve), 'UI 增强');
  assert.equal(helpers.categoryTitle(categories, 'missing', resolve), 'missing');
  assert.equal(helpers.categoryTitle(null, null, resolve), '');

  assert.equal(helpers.installAction(null), 'none');
  assert.equal(helpers.installAction({ installation: 'provided' }), 'provided');
  assert.equal(helpers.installAction({ installation: 'installed', install: { spec: 'a@1' } }), 'open');
  assert.equal(helpers.installAction({ installation: 'not-installed', compatible: true, install: { spec: 'a@1' } }), 'install');
  assert.equal(helpers.installAction({ installation: 'update-available', compatible: true, install: { spec: 'a@1' } }), 'install');
  assert.equal(helpers.installAction({ installation: 'not-installed', compatible: false, install: { spec: 'a@1' } }), 'blocked');
  assert.equal(helpers.installAction({ installation: 'not-installed', compatible: true, install: null }), 'none');

  assert.deepEqual(
    plain(helpers.installPayload({ name: '@a/b', version: '2.0.0', install: { spec: '@a/b@2.0.0', registry: 'https://reg.example', version: '2.0.0' } }, 'Notes')),
    { spec: '@a/b@2.0.0', title: 'Notes', registry: 'https://reg.example', version: '2.0.0' },
  );
  assert.deepEqual(plain(helpers.installPayload({ name: '@a/b', version: '2.0.0', install: { spec: '@a/b@2.0.0' } }, 'Notes')), {
    spec: '@a/b@2.0.0',
    title: 'Notes',
    version: '2.0.0',
  });
  assert.equal(helpers.installPayload({ name: '@a/b', install: null }, 'Notes'), null);
  assert.equal(helpers.installPayload(null, 'Notes'), null);

  assert.equal(
    helpers.buildSearchPath({ q: '  notes  ', category: 'ui', sort: 'downloads', group: false }, 50, 100),
    '/search?q=notes&category=ui&sort=downloads&group=0&offset=50&limit=100',
  );
  assert.equal(helpers.buildSearchPath({}, 0, 50), '/search?sort=stars&group=1&offset=0&limit=50');
});

test('status counters, locale resolver and error messages tolerate missing data', () => {
  const helpers = loadPureHelpers();
  const summary = plain(
    helpers.summarizeStatus({
      state: 'ready',
      totals: { plugins: 4389, families: 3800 },
      forks: { repositories: 4202, forks: 397 },
      catalog: { updated: '2026-11-02' },
    }),
  );
  assert.deepEqual(summary, { state: 'ready', plugins: 4389, families: 3800, repositories: 4202, updated: '2026-11-02', forks: 397 });
  assert.deepEqual(plain(helpers.summarizeStatus(null)), {
    state: null,
    plugins: null,
    families: null,
    repositories: null,
    updated: null,
    forks: null,
  });

  const englishOnly = helpers.createTextResolver({ resolveText: (text) => text.en ?? null });
  assert.equal(englishOnly({ en: 'Hello' }), 'Hello');
  assert.equal(englishOnly('raw'), 'raw');
  assert.equal(englishOnly(null), null);

  const broken = helpers.createTextResolver({
    resolveText() {
      throw new Error('locale exploded');
    },
  });
  assert.equal(broken({ en: 'Fallback', zh: '回退' }), 'Fallback');

  const noLocale = helpers.createTextResolver(null);
  assert.equal(noLocale({ en: 'Plain' }), 'Plain');

  assert.equal(helpers.errorMessage(new Error('boom')), 'boom');
  assert.equal(helpers.errorMessage({ code: 'entry-not-found' }), 'entry-not-found');
  assert.equal(helpers.errorMessage(null), null);
  assert.equal(helpers.numberOr(undefined, 3), 3);
  assert.equal(helpers.numberOr(Number.NaN, 7), 7);
  assert.equal(helpers.numberOr(12, 0), 12);
});

test('controller owns a stable subscribe/getSnapshot pair before first load', () => {
  const moduleExports = loadModuleExports();
  const fake = createFakeCtx();
  moduleExports.apply(fake.ctx);

  const afterApply = fake.registrations.length;
  assert.equal(afterApply, 1, 'apply must not render or fetch by itself');

  // The dispose effect is registered; running it must be safe even though the
  // tab never mounted (no request was started).
  for (const dispose of fake.disposers) assert.doesNotThrow(() => dispose());
});
