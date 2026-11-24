/**
 * Directory-mode harness: boots the client half against a fake `modelDirectories`
 * service (the transport the stock selector itself uses) and drives the whole
 * drill-down, so the preferred path is proven without a browser.
 *
 * Run: node tools/test-directory-mode.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))

let captured = null
vm.runInContext(readFileSync(CLIENT, 'utf8'), vm.createContext({
  window: { __ModuleLoader__: { load(definition) { captured = definition } } },
  console: { warn() {}, error() {}, log() {} },
  queueMicrotask,
  Date,
  document: { addEventListener() {}, removeEventListener() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  setTimeout,
}))

// ── a tiny observable store, mirroring SnapshotStore's public face ──────────
function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(patch) { state = { ...state, ...patch }; for (const l of listeners) l() },
  }
}

// ── React shim with real hook bookkeeping ──────────────────────────────────
const stateCells = []
const effects = []
const React = {
  createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() }),
  useCallback: (fn) => fn,
  useEffect: (fn) => { effects.push(fn) },
  useId: () => 'id',
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => {
    const index = React.__index++
    if (!(index in stateCells)) stateCells[index] = initial
    return [stateCells[index], (next) => {
      stateCells[index] = typeof next === 'function' ? next(stateCells[index]) : next
    }]
  },
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  __index: 0,
}

/** Expand function components so the rendered tree is walkable. */
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (!node || typeof node !== 'object' || !('type' in node)) return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, kids: (node.kids ?? []).flatMap(expand) }
}

// ── the fake model directory the service hands out ──────────────────────────
const mk = (id, name, reasoning) => ({ id, name, ...(reasoning ? { reasoning } : {}) })
const GROUPS = [{
  id: 'wb-cli',
  name: 'WorkBuddyFandai',
  models: [
    mk('deepseek-v4-pro', 'Deepseek-V4-Pro', {
      defaultEffort: 'medium',
      efforts: ['minimal', 'low', 'high'].map(e => ({ id: e, name: e[0].toUpperCase() + e.slice(1) })),
    }),
    ...['minimal', 'low', 'high'].map(e => mk(`deepseek-v4-pro:${e}`, `Deepseek-V4-Pro [${e}]`)),
    mk('glm-5.3', 'GLM-5.3'),
    mk('glm-5.3:high', 'GLM-5.3 [high]'),
    // Declares an effort but has NO :effort twin, so its rung maps to the base id.
    mk('kimi-k2.6', 'Kimi-K2.6', { efforts: [{ id: 'high', name: 'High' }] }),
    mk('auto', 'Auto'),
  ],
}]

const store = createStore({
  current: { provider: 'wb-cli', model: 'deepseek-v4-pro:low', reasoningEffort: 'low' },
  routable: true,
  groups: GROUPS,
  failures: [],
  status: 'idle',
  error: null,
})

const calls = { load: 0, select: [] }
const directory = {
  store,
  async load() {
    calls.load += 1
    store.update({ status: 'ready' })
    return { current: store.getSnapshot().current, routable: true, groups: GROUPS, failures: [] }
  },
  async select(selection) {
    calls.select.push(selection)
    store.update({ current: selection, status: 'ready' })
  },
}

let directoryForThrows = false
const modelDirectories = {
  directoryFor(sessionId) {
    if (directoryForThrows) throw new Error('no scope for ' + sessionId)
    return directory
  },
}

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('require escaped the module table: ' + specifier)
})

const registrations = []
plugin.apply({
  locale: { bind: () => key => key, register() {}, current: () => 'zh' },
  effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
  logger: { warn() {} },
  inject: (deps, callback) => callback(scope),
  get: (name) => (name === 'modelDirectories' ? modelDirectories : undefined),
})

const scope = {
  get: (name) => {
    if (name === 'modelDirectories') return modelDirectories
    // Deliberately NO connection: directory mode must not need it.
    return undefined
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}
// Re-apply through a scope that resolves modelDirectories.
registrations.length = 0
plugin.apply({
  locale: { bind: () => key => key, register() {}, current: () => 'zh' },
  effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
  logger: { warn() {} },
  inject: (deps, callback) => callback(scope),
  get: (name) => (name === 'modelDirectories' ? modelDirectories : undefined),
})

const { component, options } = registrations[0]
const injectFace = typeof options.inject === 'function' ? options.inject('sess-1') : {}

const find = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  for (const child of node.kids ?? []) find(child, predicate, out)
  return out
}
const isElement = (node) => node && typeof node === 'object' && 'type' in node
const byClass = (tree, className) => find(tree, n => isElement(n) && n.props && n.props.className === className)
const rows = (tree) => find(tree, n => isElement(n) && n.props && n.props.className === 'mp-row')
const rowName = (row) => find(row, n => n.props && n.props.className === 'mp-row-name')[0]?.kids[0]

const paint = () => { React.__index = 0; return expand(component({ locked: false, ...injectFace })) }
let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures += 1 }

// 1. Mount with NO connection at all: directory mode must still serve the seat.
let tree = paint()
for (const fn of effects.splice(0)) fn()
tree = paint()
let trigger = byClass(tree, 'mp-trigger')[0]
check('seat is enabled with no connection (directory mode)', trigger !== undefined && trigger.props.disabled === false)
check('directory.load() was called', calls.load >= 1)

// 2. Trigger shows the current model.
check('trigger names the current model', byClass(tree, 'mp-trigger-label')[0].kids[0] === 'Deepseek-V4-Pro')

// 3. Drill into the model level: twins are folded.
byClass(tree, 'mp-trigger')[0].props.onClick()
tree = paint()
check('model level folds twins into one row', rows(tree).map(rowName).join(',') === 'Deepseek-V4-Pro')

// 4. Effort level, then submit through directory.select.
rows(tree).find(r => rowName(r) === 'Deepseek-V4-Pro').props.onClick()
tree = paint()
check('effort level lists the rungs', rows(tree).some(r => rowName(r) === 'High'))
rows(tree).find(r => rowName(r) === 'High').props.onClick()
for (let i = 0; i < 6; i += 1) await Promise.resolve()
tree = paint()
const sent = calls.select.at(-1)
// The rung resolves to the catalog twin `deepseek-v4-pro:high`, which encodes
// the effort in the model id and declares no reasoning metadata — so the effort
// must NOT be sent alongside it.
check('submits the effort twin through directory.select',
  sent !== undefined && sent.model === 'deepseek-v4-pro:high')
check('twin rung omits reasoningEffort (id already encodes it)',
  sent !== undefined && sent.reasoningEffort === undefined)
check('menu closes after acceptance', byClass(tree, 'mp-menu').length === 0)

// 4b. A rung that falls back to the BASE id has no twin, so the effort MUST
//     travel in the reasoningEffort field instead.
calls.select.length = 0
stateCells.length = 0
effects.length = 0
store.update({
  current: { provider: 'wb-cli', model: 'kimi-k2.6', reasoningEffort: 'high' },
  status: 'ready',
})
tree = paint()
byClass(tree, 'mp-trigger')[0].props.onClick()
tree = paint()
rows(tree).find(r => rowName(r) === 'Kimi-K2.6').props.onClick()
tree = paint()
rows(tree).find(r => rowName(r) === 'High').props.onClick()
for (let i = 0; i < 6; i += 1) await Promise.resolve()
const baseSent = calls.select.at(-1)
check('base-id rung sends reasoningEffort in the field',
  baseSent !== undefined && baseSent.model === 'kimi-k2.6' && baseSent.reasoningEffort === 'high')

// 5. A directory that cannot resolve a session must not crash the seat, and it
//    must stay interrogable: a clickable chip whose menu states the reason.
directoryForThrows = true
stateCells.length = 0
effects.length = 0
tree = paint()
trigger = byClass(tree, 'mp-trigger')[0]
check('unresolvable directory still renders a chip', trigger !== undefined)
check('unresolvable chip stays clickable', trigger !== undefined && trigger.props.disabled === false)
if (trigger !== undefined) {
  trigger.props.onClick()
  tree = paint()
  const status = byClass(tree, 'mp-status')
  check('opening it explains why', status.length > 0)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
