/**
 * Unit tests for the model-picker taxonomy.
 *
 * Run with:  node --test test/classify.test.mjs
 *
 * The taxonomy ships INSIDE client.js (a client bundle must be self-contained:
 * `require` only reaches the module table, so a sibling `.mjs` file would throw
 * and take the whole client boot down). The code lives between the
 * `// >>> mp-pure-helpers` / `// <<< mp-pure-helpers` markers, and this file
 * extracts exactly that slice and evaluates it — so these tests exercise the
 * shipped bytes, not a drifting copy.
 *
 * Pure `node:test` + `node:assert/strict`; no DSH imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url));

/**
 * Evaluate the marked pure-helpers slice of client.js and return its exports.
 * The slice declares only `const`s and `function`s, so a function wrapper is
 * enough to turn it into a module.
 * @returns {Record<string, unknown>} the taxonomy functions and tables.
 */
function loadTaxonomy() {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const start = source.indexOf('// >>> mp-pure-helpers');
  const end = source.indexOf('// <<< mp-pure-helpers');
  assert.ok(start !== -1, 'client.js must carry the mp-pure-helpers start marker');
  assert.ok(end !== -1 && end > start, 'client.js must carry the mp-pure-helpers end marker');
  const slice = source.slice(start, end);
  const factory = new Function(`${slice}
    return { EFFORT_LEVELS, KIND_LABELS, splitEffort, familyOf, modelKind, classifyChannels, matchesQuery };`);
  return factory();
}

const {
  EFFORT_LEVELS,
  KIND_LABELS,
  splitEffort,
  familyOf,
  modelKind,
  classifyChannels,
  matchesQuery,
} = loadTaxonomy();

// ─── fixtures ───────────────────────────────────────────────────────────────

/** Full ladder used by most DeepSeek / Kimi / MiniMax families. */
const FULL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Short ladder used by glm-5.3-flash*, kimi-k2.8-preview. */
const SHORT_EFFORTS = ['none', 'low', 'high', 'max'];

const effortSpec = (ids) => ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));

/**
 * Build the bare + `:effort` twin pair the live profile actually contains.
 * When `withReasoning` is true the bare object carries `reasoning.efforts`
 * (host-authoritative); otherwise only the twins exist.
 */
function modelWithTwins(id, name, efforts, { withReasoning = true, defaultEffort } = {}) {
  const bare = { id, name };
  if (withReasoning) {
    bare.reasoning = { efforts: effortSpec(efforts) };
    if (defaultEffort) bare.reasoning.defaultEffort = defaultEffort;
  }
  const twins = efforts.map((effort) => ({
    id: `${id}:${effort}`,
    name: `${name} [${effort}]`,
  }));
  return [bare, ...twins];
}

const WB_MODELS = [
  // 1 base + 6 twins, reasoning block present
  ...modelWithTwins('deepseek-v4.1-flash', 'Deepseek-V4.1-Flash', FULL_EFFORTS, {
    defaultEffort: 'medium',
  }),
  // 1 base + 6 twins, reasoning block present
  ...modelWithTwins('deepseek-v4-pro', 'Deepseek-V4-Pro', FULL_EFFORTS),
  // 1 base + 6 twins
  ...modelWithTwins('glm-5.3', 'GLM-5.3', FULL_EFFORTS),
  // 1 base + 4 twins, SHORT ladder
  ...modelWithTwins('glm-5.3-flash', 'GLM-5.3-Flash', SHORT_EFFORTS),
  // 1 base + 6 twins
  ...modelWithTwins('glm-5.0-turbo', 'GLM-5.0-Turbo', FULL_EFFORTS),
  // 1 base + 6 twins
  ...modelWithTwins('kimi-k2.6', 'Kimi-K2.6', FULL_EFFORTS),
  // 1 base + 4 twins, documented as Code
  ...modelWithTwins('kimi-k2.7', 'Kimi-K2.7', SHORT_EFFORTS),
  // 1 base + 6 twins
  ...modelWithTwins('minimax-m2.7', 'MiniMax-M2.7', FULL_EFFORTS),
  // 1 base + 0 twins: no reasoning, no twins → efforts []
  { id: 'hy4-preview', name: 'HY4-Preview' },
  // twin-only base: no bare object at all, only `:effort` twins
  { id: 'glm-4.6v:high', name: 'GLM-4.6V [high]' },
  { id: 'glm-4.6v:low', name: 'GLM-4.6V [low]' },
  // virtual / unroutable ids → other
  { id: 'default', name: 'Default' },
  { id: 'auto', name: 'Auto' },
  // Claude reachable only through the display name
  { id: 'default-1.1', name: 'Claude-3.7-Sonnet' },
  { id: 'default-1.2', name: 'Claude-4.0-Sonnet' },
];

const WB_GROUP = { id: 'wb-cli', name: 'WorkBuddy反代', models: WB_MODELS };

/** Index helper: channel → family id → family node. */
function familyIndex(channels) {
  const out = new Map();
  for (const channel of channels) {
    for (const family of channel.families) out.set(`${channel.id}/${family.id}`, family);
  }
  return out;
}

/** Flatten every model entry of a channel. */
function allEntries(channel) {
  return channel.families.flatMap((f) => f.models);
}

// ─── contract constants ─────────────────────────────────────────────────────

test('EFFORT_LEVELS is the ordered 6-level ladder', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('KIND_LABELS covers every kind with zh + en', () => {
  const kinds = ['pro', 'flash', 'turbo', 'code', 'vision', 'thinking', 'preview', 'standard'];
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), [...kinds].sort());
  for (const kind of kinds) {
    assert.equal(typeof KIND_LABELS[kind].zh, 'string', `${kind}.zh`);
    assert.equal(typeof KIND_LABELS[kind].en, 'string', `${kind}.en`);
    assert.ok(KIND_LABELS[kind].zh.length > 0, `${kind}.zh non-empty`);
    assert.ok(KIND_LABELS[kind].en.length > 0, `${kind}.en non-empty`);
  }
  assert.equal(KIND_LABELS.pro.zh, '专业 Pro');
  assert.equal(KIND_LABELS.standard.en, 'Standard');
});

// ─── splitEffort ────────────────────────────────────────────────────────────

test('splitEffort peels known effort suffixes', () => {
  assert.deepEqual(splitEffort('glm-5.3:high'), { base: 'glm-5.3', effort: 'high' });
  assert.deepEqual(splitEffort('kimi-k2.6:max'), { base: 'kimi-k2.6', effort: 'max' });
  assert.deepEqual(splitEffort('deepseek-v4.1-flash:xhigh'), {
    base: 'deepseek-v4.1-flash',
    effort: 'xhigh',
  });
});

test('splitEffort leaves bare ids alone', () => {
  assert.deepEqual(splitEffort('glm-5.3'), { base: 'glm-5.3', effort: undefined });
  assert.deepEqual(splitEffort('default'), { base: 'default', effort: undefined });
});

test('splitEffort is case-insensitive on the suffix', () => {
  assert.deepEqual(splitEffort('glm-5.3:HIGH'), { base: 'glm-5.3', effort: 'high' });
  assert.deepEqual(splitEffort('glm-5.3:Max'), { base: 'glm-5.3', effort: 'max' });
});

test('splitEffort returns the id unchanged for unknown / malformed suffixes', () => {
  assert.deepEqual(splitEffort('deepseek-v4-pro:somethingelse'), {
    base: 'deepseek-v4-pro:somethingelse',
    effort: undefined,
  });
  assert.deepEqual(splitEffort('a:b:c'), { base: 'a:b:c', effort: undefined });
  assert.deepEqual(splitEffort('a:b'), { base: 'a:b', effort: undefined });
  // Trailing / leading colons are not effort splits.
  assert.deepEqual(splitEffort('glm-5.3:'), { base: 'glm-5.3:', effort: undefined });
  assert.deepEqual(splitEffort(':high'), { base: ':high', effort: undefined });
});

test('splitEffort tolerates non-string input', () => {
  assert.deepEqual(splitEffort(undefined), { base: '', effort: undefined });
  assert.deepEqual(splitEffort(''), { base: '', effort: undefined });
});

// ─── familyOf ───────────────────────────────────────────────────────────────

test('familyOf classifies every real vendor prefix', () => {
  assert.equal(familyOf('deepseek-v4-pro').id, 'deepseek');
  assert.equal(familyOf('deepseek-v3-1-lkeap').id, 'deepseek');
  assert.equal(familyOf('deepseek-r1-0528-lkeap').id, 'deepseek');
  assert.equal(familyOf('glm-5.3').id, 'glm');
  assert.equal(familyOf('glm-4.6v').id, 'glm');
  assert.equal(familyOf('kimi-k2.6').id, 'kimi');
  assert.equal(familyOf('kimi-k2-instruct-taiji').id, 'kimi');
  assert.equal(familyOf('minimax-m2.7').id, 'minimax');
  assert.equal(familyOf('minimax-m3-pay').id, 'minimax');
});

test('familyOf maps hunyuan-* and hy* to hunyuan', () => {
  assert.equal(familyOf('hunyuan-chat').id, 'hunyuan');
  assert.equal(familyOf('hunyuan-2.0-thinking').id, 'hunyuan');
  for (const id of ['hy3', 'hy3-x', 'hy3-preview', 'hy4-preview', 'hy4-preview-x']) {
    const fam = familyOf(id);
    assert.equal(fam.id, 'hunyuan', `${id} → hunyuan`);
    assert.equal(fam.label, '混元 Hunyuan');
    assert.equal(fam.order, 50);
  }
  // The dash-delimited short slug counts too.
  assert.equal(familyOf('hy-chat').id, 'hunyuan');
  assert.equal(familyOf('hy-preview').id, 'hunyuan');
});

test('familyOf does NOT swallow unrelated `hy…` ids into hunyuan', () => {
  // `hy` must be a delimited root; a bare `hy` prefix is not enough.
  for (const id of ['hynix-x', 'hyphen-model', 'hyperion-9', 'hysteria']) {
    assert.equal(familyOf(id).id, 'other', `${id} → other`);
  }
});

test('familyOf splits effort before matching the prefix', () => {
  assert.equal(familyOf('glm-5.3:high').id, 'glm');
  assert.equal(familyOf('kimi-k2.8-preview:max').id, 'kimi');
  assert.equal(familyOf('HY3:X').id, 'hunyuan');
});

test('familyOf is case-insensitive', () => {
  assert.equal(familyOf('GLM-5.3').id, 'glm');
  assert.equal(familyOf('DeepSeek-V4-Pro').id, 'deepseek');
  assert.equal(familyOf('Kimi-K2.6').id, 'kimi');
});

test('familyOf falls back to the display name for Claude', () => {
  // The live profile's only route to Claude is the display name.
  const sonnet37 = familyOf('default-1.1', 'Claude-3.7-Sonnet');
  assert.equal(sonnet37.id, 'claude');
  assert.equal(sonnet37.label, 'Claude');
  assert.equal(sonnet37.order, 60);

  const sonnet40 = familyOf('default-1.2', 'Claude-4.0-Sonnet');
  assert.equal(sonnet40.id, 'claude');

  // Case-insensitive on the name too.
  assert.equal(familyOf('default-1.1', 'CLAUDE-3.7-SONNET').id, 'claude');
  // Real claude-* ids match on prefix regardless of name.
  assert.equal(familyOf('claude-sonnet-4', 'Whatever').id, 'claude');
});

test('familyOf sends everything unmatched to other', () => {
  for (const id of ['default', 'auto', 'default-1.1', 'some-random-model']) {
    const fam = familyOf(id);
    assert.equal(fam.id, 'other', `${id} → other`);
    assert.equal(fam.label, '其他 Other');
    assert.equal(fam.order, 900);
  }
  // `default-1.1` with a non-Claude name stays in other.
  assert.equal(familyOf('default-1.1', 'Mystery-Model').id, 'other');
});

test('familyOf returns fresh objects (callers may mutate)', () => {
  const a = familyOf('glm-5.3');
  a.label = 'mutated';
  assert.equal(familyOf('glm-5.3').label, 'GLM');
});

// ─── modelKind ──────────────────────────────────────────────────────────────

test('modelKind classifies the real wb-cli ids', () => {
  const expected = {
    'deepseek-v4-pro': 'pro',
    'deepseek-v4-flash': 'flash',
    'deepseek-v4.1-flash': 'flash',
    'deepseek-v3-0324-lkeap': 'standard',
    'deepseek-r1-0528-lkeap': 'thinking',
    'glm-5.3': 'standard',
    'glm-5.3-flash': 'flash',
    'glm-5.3-flashx': 'flash',
    'glm-5.0-turbo': 'turbo',
    'glm-5v-turbo': 'turbo',
    'glm-4.6v': 'vision',
    'kimi-k2.7': 'code',
    'kimi-k2-thinking': 'thinking',
    'kimi-k2.8-preview': 'preview',
    'minimax-m3-pay': 'standard',
    hy3: 'standard',
    'hy3-x': 'standard',
    'hy4-preview': 'preview',
    'hy4-preview-x': 'preview',
    'hunyuan-2.0-thinking': 'thinking',
  };
  for (const [id, kind] of Object.entries(expected)) {
    assert.equal(modelKind(id), kind, `${id} → ${kind}`);
  }
});

test('modelKind first-match-wins precedence', () => {
  // flash beats everything, including an inner `pro` token.
  assert.equal(modelKind('deepseek-v4-flash-pro'), 'flash');
  // turbo beats the vision `v` suffix (documented: glm-5v-turbo is turbo).
  assert.equal(modelKind('glm-5v-turbo'), 'turbo');
  // vision beats pro.
  assert.equal(modelKind('glm-pro-vision'), 'vision');
  // code override beats preview.
  assert.equal(modelKind('kimi-k2.8-preview'), 'preview');
  assert.equal(modelKind('kimi-k2.7'), 'code');
  // explicit code token
  assert.equal(modelKind('some-code-model'), 'code');
});

test('modelKind detects `-pro` only as a token', () => {
  assert.equal(modelKind('deepseek-v4-pro'), 'pro');
  assert.equal(modelKind('vendor-x-pro'), 'pro');
  // Not a pro token.
  assert.equal(modelKind('project-model'), 'standard');
  assert.equal(modelKind('deepseek-v4-product'), 'standard');
});

test('modelKind detects the trailing v (vision) suffix', () => {
  assert.equal(modelKind('glm-4.6v'), 'vision');
  assert.equal(modelKind('glm-4v'), 'vision');
  // A `v` that is not glued to a digit is not vision.
  assert.equal(modelKind('glm-4.6-v'), 'vision'); // delimiter-separated v still counts
  assert.equal(modelKind('vibe-model'), 'standard');
});

test('modelKind strips effort suffixes and is case-insensitive', () => {
  assert.equal(modelKind('deepseek-v4.1-flash'), 'flash');
  assert.equal(modelKind('DEEPSEEK-V4-PRO'), 'pro');
  assert.equal(modelKind('Kimi-K2-Thinking'), 'thinking');
  assert.equal(modelKind(''), 'standard');
  assert.equal(modelKind(undefined), 'standard');
});

// ─── classifyChannels ───────────────────────────────────────────────────────

test('classifyChannels collapses bare + twin pairs into one entry per model', () => {
  const channels = classifyChannels([WB_GROUP]);
  assert.equal(channels.length, 1);
  const channel = channels[0];

  const entries = allEntries(channel);
  // The fixture is 59 raw rows (bare models + every `:effort` twin) covering 14
  // distinct base ids; folding must collapse them all, not just some.
  assert.equal(WB_MODELS.length, 59, 'fixture holds 59 raw rows');
  assert.equal(entries.length, 14, '14 model entries after folding');
  assert.equal(channel.count, 14, 'channel.count counts model entries, not efforts');
  assert.ok(entries.length < WB_MODELS.length / 4, 'the entry count collapses by >4x');

  // No base id appears twice.
  const baseIds = entries.map((e) => e.baseId);
  assert.equal(new Set(baseIds).size, baseIds.length, 'base ids are unique');
});

test('classifyChannels: the documented 8-base/40-twin collapse', () => {
  // 8 base models, each with 5 efforts → 8 bare + 40 twins = 48 rows → 8 entries.
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const models = [];
  for (let i = 0; i < 8; i += 1) {
    models.push(...modelWithTwins(`deepseek-x${i}`, `Deepseek-X${i}`, efforts));
  }
  assert.equal(models.length, 48);
  const [channel] = classifyChannels([{ id: 'wb-cli', name: 'WB', models }]);
  assert.equal(allEntries(channel).length, 8);
  assert.equal(channel.count, 8);
  for (const entry of allEntries(channel)) {
    assert.equal(entry.efforts.length, 5);
  }
});

test('classifyChannels keeps channel order and labels', () => {
  const groups = [
    { id: 'zeta', name: 'Zeta渠道', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { id: 'alpha', name: 'Alpha渠道', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { id: 'mid' }, // no models, no name → still a channel, empty
  ];
  const channels = classifyChannels(groups);
  assert.deepEqual(
    channels.map((c) => c.id),
    ['zeta', 'alpha', 'mid'],
    'input provider order is preserved',
  );
  assert.equal(channels[0].label, 'Zeta渠道');
  assert.equal(channels[2].label, 'mid', 'label falls back to the id');
  assert.equal(channels[2].count, 0);
  assert.deepEqual(channels[2].families, []);
});

test('classifyChannels orders families deepseek < glm < kimi < minimax < hunyuan < claude < other', () => {
  const channels = classifyChannels([WB_GROUP]);
  const fams = channels[0].families;
  assert.deepEqual(
    fams.map((f) => f.id),
    ['deepseek', 'glm', 'kimi', 'minimax', 'hunyuan', 'claude', 'other'],
  );
  const orders = fams.map((f) => f.order);
  assert.deepEqual(orders, [10, 20, 30, 40, 50, 60, 900]);
  for (let i = 1; i < orders.length; i += 1) {
    assert.ok(orders[i - 1] < orders[i], 'family orders ascend');
  }
});

test('classifyChannels puts hy* in the hunyuan family', () => {
  const channels = classifyChannels([WB_GROUP]);
  const hy = familyIndex(channels).get('wb-cli/hunyuan');
  assert.ok(hy, 'hunyuan family exists');
  assert.equal(hy.label, '混元 Hunyuan');
  assert.ok(
    hy.models.some((m) => m.baseId === 'hy4-preview'),
    'hy4-preview landed in hunyuan',
  );
});

test('classifyChannels routes display-name Clades to the claude family', () => {
  const channels = classifyChannels([WB_GROUP]);
  const claude = familyIndex(channels).get('wb-cli/claude');
  assert.ok(claude, 'claude family exists');
  assert.deepEqual(
    claude.models.map((m) => m.baseId).sort(),
    ['default-1.1', 'default-1.2'],
  );
  // And they are NOT duplicated into other.
  const other = familyIndex(channels).get('wb-cli/other');
  assert.ok(other);
  assert.ok(!other.models.some((m) => m.baseId === 'default-1.1' || m.baseId === 'default-1.2'));
  assert.deepEqual(other.models.map((m) => m.baseId).sort(), ['auto', 'default']);
});

test('classifyChannels builds efforts from reasoning.efforts in host order', () => {
  const channels = classifyChannels([WB_GROUP]);
  const ds = familyIndex(channels).get('wb-cli/deepseek');
  const flash = ds.models.find((m) => m.baseId === 'deepseek-v4.1-flash');

  assert.equal(flash.modelId, 'deepseek-v4.1-flash', 'bare id is the representative modelId');
  assert.equal(flash.name, 'Deepseek-V4.1-Flash');
  assert.equal(flash.kind, 'flash');
  assert.equal(flash.defaultEffort, 'medium');
  assert.deepEqual(flash.efforts, [
    { effort: 'minimal', modelId: 'deepseek-v4.1-flash:minimal', name: 'Minimal' },
    { effort: 'low', modelId: 'deepseek-v4.1-flash:low', name: 'Low' },
    { effort: 'medium', modelId: 'deepseek-v4.1-flash:medium', name: 'Medium' },
    { effort: 'high', modelId: 'deepseek-v4.1-flash:high', name: 'High' },
    { effort: 'xhigh', modelId: 'deepseek-v4.1-flash:xhigh', name: 'Xhigh' },
    { effort: 'max', modelId: 'deepseek-v4.1-flash:max', name: 'Max' },
  ]);
});

test('classifyChannels honours a custom host effort order (glm short ladder)', () => {
  const channels = classifyChannels([WB_GROUP]);
  const glm = familyIndex(channels).get('wb-cli/glm');
  const flash = glm.models.find((m) => m.baseId === 'glm-5.3-flash');
  assert.deepEqual(
    flash.efforts.map((e) => e.effort),
    SHORT_EFFORTS,
    'none/low/high/max preserved exactly as the host lists them',
  );
});

test('classifyChannels falls back to present twins when there is no reasoning block', () => {
  const models = [
    // No `reasoning` on the bare object → derive from twins, sorted by EFFORT_LEVELS.
    { id: 'glm-9:max', name: 'GLM-9 [max]' },
    { id: 'glm-9', name: 'GLM-9' },
    { id: 'glm-9:low', name: 'GLM-9 [low]' },
    { id: 'glm-9:high', name: 'GLM-9 [high]' },
  ];
  const [channel] = classifyChannels([{ id: 'p', name: 'P', models }]);
  const [entry] = channel.families[0].models;
  assert.equal(entry.baseId, 'glm-9');
  assert.deepEqual(
    entry.efforts.map((e) => e.effort),
    ['low', 'high', 'max'],
    'sorted by canonical EFFORT_LEVELS order, not input order',
  );
  assert.deepEqual(
    entry.efforts.map((e) => e.modelId).sort(),
    ['glm-9:high', 'glm-9:low', 'glm-9:max'],
  );
});

test('classifyChannels yields [] efforts when there are none', () => {
  const channels = classifyChannels([WB_GROUP]);
  const hy = familyIndex(channels).get('wb-cli/hunyuan').models.find((m) => m.baseId === 'hy4-preview');
  assert.deepEqual(hy.efforts, []);
  assert.equal(hy.modelId, 'hy4-preview');
});

test('classifyChannels folds twin-only bases into ONE entry and strips the [effort] suffix', () => {
  const channels = classifyChannels([WB_GROUP]);
  const glm = familyIndex(channels).get('wb-cli/glm');
  const vision = glm.models.find((m) => m.baseId === 'glm-4.6v');
  assert.ok(vision, 'glm-4.6v exists as a single entry');
  assert.equal(vision.kind, 'vision');
  assert.equal(vision.name, 'GLM-4.6V', 'display name stripped of " [high]"');
  assert.ok(!/\[/.test(vision.name), 'no bracket suffix leaks through');
  assert.deepEqual(vision.efforts.map((e) => e.effort).sort(), ['high', 'low']);
  // No twin leaked in as its own model entry.
  assert.ok(!glm.models.some((m) => m.baseId.includes(':')));
});

test('classifyChannels never duplicates an effort within an entry', () => {
  const models = [
    {
      id: 'glm-7',
      name: 'GLM-7',
      reasoning: { efforts: effortSpec(['high', 'high', 'low']) },
    },
    { id: 'glm-7:high', name: 'GLM-7 [high]' },
    { id: 'glm-7:low', name: 'GLM-7 [low]' },
    { id: 'glm-7:max', name: 'GLM-7 [max]' },
  ];
  const [channel] = classifyChannels([{ id: 'p', name: 'P', models }]);
  const [entry] = channel.families[0].models;
  assert.deepEqual(entry.efforts.map((e) => e.effort), ['high', 'low']);
});

test('classifyChannels carries a description on effort entries for the UI', () => {
  const models = [
    {
      id: 'glm-8',
      name: 'GLM-8',
      description: 'base-desc',
      reasoning: { efforts: effortSpec(['low', 'high']) },
    },
    { id: 'glm-8:low', name: 'GLM-8 [low]', description: 'twin-low-desc' },
    { id: 'glm-8:high', name: 'GLM-8 [high]' },
    // no twin at all for `max`, so it falls back to the base modelId
    // no description anywhere → the property is simply absent
    { id: 'glm-8n', name: 'GLM-8N', reasoning: { efforts: effortSpec(['low']) } },
  ];
  const [channel] = classifyChannels([{ id: 'p', name: 'P', models }]);
  const entry = channel.families[0].models.find((m) => m.baseId === 'glm-8');

  const [low, high] = entry.efforts;
  assert.equal(low.modelId, 'glm-8:low');
  assert.equal(low.description, 'twin-low-desc', "the twin's own description wins");
  assert.equal(high.modelId, 'glm-8:high');
  assert.equal(high.description, 'base-desc', 'falls back to the base description');

  // With no description anywhere the key is absent, not undefined-valued.
  const bare = channel.families[0].models.find((m) => m.baseId === 'glm-8n');
  assert.equal(bare.efforts.length, 1);
  assert.equal(bare.efforts[0].modelId, 'glm-8n', 'no twin → maps to the base modelId');
  assert.ok(!('description' in bare.efforts[0]), 'no empty description key is emitted');
});

test('classifyChannels effort descriptions work on the derived (no-reasoning) path', () => {
  const models = [
    { id: 'glm-9', name: 'GLM-9', description: 'base' },
    { id: 'glm-9:low', name: 'GLM-9 [low]', description: 'low-desc' },
    { id: 'glm-9:high', name: 'GLM-9 [high]' },
  ];
  const [channel] = classifyChannels([{ id: 'p', name: 'P', models }]);
  const [entry] = channel.families[0].models;
  assert.equal(entry.efforts[0].description, 'low-desc');
  assert.equal(entry.efforts[1].description, 'base');
});

test('classifyChannels dedupes efforts across every entry of the fixture', () => {
  const channels = classifyChannels([WB_GROUP]);
  for (const channel of channels) {
    for (const entry of allEntries(channel)) {
      const effs = entry.efforts.map((e) => e.effort);
      assert.equal(new Set(effs).size, effs.length, `duplicate effort in ${entry.baseId}`);
      for (const eff of entry.efforts) {
        assert.ok(
          eff.modelId === entry.baseId || eff.modelId.startsWith(`${entry.baseId}:`),
          `effort modelId ${eff.modelId} belongs to ${entry.baseId}`,
        );
        assert.equal(typeof eff.name, 'string');
        assert.ok(eff.name.length > 0);
      }
    }
  }
});

test('classifyChannels keeps every effort modelId routable (present in the raw list)', () => {
  const rawIds = new Set(WB_MODELS.map((m) => m.id));
  const channels = classifyChannels([WB_GROUP]);
  for (const entry of allEntries(channels[0])) {
    assert.ok(rawIds.has(entry.modelId), `${entry.modelId} is a real selectable id`);
    for (const eff of entry.efforts) {
      assert.ok(rawIds.has(eff.modelId), `${eff.modelId} is a real selectable id`);
    }
  }
  assert.ok(rawIds.size > 0);
});

test('classifyChannels sorts models by kind rank then baseId inside a family', () => {
  const channels = classifyChannels([WB_GROUP]);
  const glm = familyIndex(channels).get('wb-cli/glm');
  assert.deepEqual(
    glm.models.map((m) => `${m.kind}:${m.baseId}`),
    ['flash:glm-5.3-flash', 'turbo:glm-5.0-turbo', 'vision:glm-4.6v', 'standard:glm-5.3'],
  );
  // The general invariant over every family.
  const rank = { pro: 10, flash: 20, turbo: 30, code: 40, vision: 50, thinking: 60, preview: 70, standard: 80 };
  for (const family of channels[0].families) {
    for (let i = 1; i < family.models.length; i += 1) {
      const prev = family.models[i - 1];
      const cur = family.models[i];
      assert.ok(rank[prev.kind] <= rank[cur.kind], `${family.id}: kind rank ascends`);
    }
  }
});

test('classifyChannels is total on empty / junk input', () => {
  assert.deepEqual(classifyChannels([]), []);
  assert.deepEqual(classifyChannels(undefined), []);
  assert.deepEqual(classifyChannels(null), []);
  const [channel] = classifyChannels([{ id: 'x', name: 'X', models: [null, { name: 'no id' }, 'junk'] }]);
  assert.equal(channel.count, 0);
  assert.equal(channel.label, 'X');
});

test('classifyChannels does not mutate the input groups', () => {
  const snapshot = JSON.stringify(WB_MODELS);
  classifyChannels([WB_GROUP]);
  assert.equal(JSON.stringify(WB_MODELS), snapshot, 'input model list untouched');
});

test('classifyChannels handles multiple channels independently', () => {
  const channels = classifyChannels([
    { id: 'wb-cli', name: 'WorkBuddy反代', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { id: 'other-cli', name: 'Other', models: [{ id: 'kimi-k2.6', name: 'Kimi-K2.6' }] },
  ]);
  assert.equal(channels.length, 2);
  assert.deepEqual(channels[0].families.map((f) => f.id), ['glm']);
  assert.deepEqual(channels[1].families.map((f) => f.id), ['kimi']);
});

// ─── matchesQuery ───────────────────────────────────────────────────────────

test('matchesQuery is an empty-query no-op', () => {
  const entry = { baseId: 'glm-5.3', name: 'GLM-5.3', kind: 'standard' };
  assert.equal(matchesQuery(entry, ''), true);
  assert.equal(matchesQuery(entry, '   '), true);
  assert.equal(matchesQuery(entry, undefined), true);
  assert.equal(matchesQuery(entry, null), true);
});

test('matchesQuery matches baseId, name and kind case-insensitively', () => {
  const entry = { baseId: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', kind: 'flash' };
  assert.equal(matchesQuery(entry, 'v4.1'), true);
  assert.equal(matchesQuery(entry, 'DEEPSEEK'), true);
  assert.equal(matchesQuery(entry, 'flash'), true);
  assert.equal(matchesQuery(entry, 'Flash'), true);
  assert.equal(matchesQuery(entry, 'thinking'), false);
  assert.equal(matchesQuery(entry, 'glm'), false);
});

test('matchesQuery filters a real channel down sensibly', () => {
  const [channel] = classifyChannels([WB_GROUP]);
  const entries = allEntries(channel);
  const glmHits = entries.filter((e) => matchesQuery(e, 'glm'));
  assert.ok(glmHits.length >= 3, 'glm query finds the glm models');
  assert.ok(glmHits.every((e) => e.baseId.startsWith('glm')));
  assert.equal(entries.filter((e) => matchesQuery(e, 'zzz-nope')).length, 0);
  // Total: the empty query returns everything.
  assert.equal(entries.filter((e) => matchesQuery(e, '')).length, entries.length);
});

test('matchesQuery rejects junk entries', () => {
  assert.equal(matchesQuery(null, 'x'), false);
  assert.equal(matchesQuery(undefined, ''), false);
});
