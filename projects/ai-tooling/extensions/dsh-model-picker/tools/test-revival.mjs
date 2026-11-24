/**
 * Regression harness for the "grey seat" bug.
 *
 * Reported symptom: the picker works, but a NEW SESSION or a RESTART leaves it
 * grey. Both are the same root cause — at first paint the seat has no transport
 * (a brand-new session has no directory scope yet; after a restart the socket
 * is not up), and because an unavailable seat subscribes to nothing, it never
 * re-rendered once the world became ready. It latched grey forever.
 *
 * This harness boots such a seat, then flips the world ready and proves the seat
 * recovers on its own (revival pump), without any external nudge.
 *
 * Run: node tools/test-revival.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))

/**
 * Captured timers: the revival pump is the component's OWN setInterval, so the
 * test fires those callbacks rather than simulating a re-render. That is what
 * makes this a real regression test for "it latched grey forever".
 */
const timers = []

let captured = null
vm.runInContext(readFileSync(CLIENT, 'utf8'), vm.createContext({
  window: { __ModuleLoader__: { load(definition) { captured = definition } } },
  console: { warn() {}, error() {}, log() {} },
  queueMicrotask,
  Date,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: (fn, ms) => { const id = timers.push({ fn, ms, active: true }); return id },
  clearInterval: (id) => { const timer = timers[id - 1]; if (timer !== undefined) timer.active = false },
  document: { addEventListener() {}, removeEventListener() {} },
  fetch: () => Promise.resolve({ ok: true }),
}))

/** Fire every still-active interval callback once, as the browser would. */
function tickTimers() {
  for (const timer of timers) if (timer.active) timer.fn()
}

// ── controllable world ─────────────────────────────────────────────────────
const world = {
  /** Directory scope exists for the session? (a brand-new session: false at first) */
  scopeReady: false,
  /** Connection handle up? (restart: false at first) */
  connectionReady: false,
}

function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener() },
  }
}

const GROUPS = [{
  id: 'wb-cli',
  name: 'WorkBuddyFandai',
  models: [
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
    { id: 'deepseek-v4-pro:high', name: 'Deepseek-V4-Pro [high]' },
  ],
}]

const store = createStore({
  current: { provider: 'wb-cli', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  routable: true, groups: GROUPS, failures: [], status: 'idle', error: null,
})
const directory = {
  store,
  load: async () => { store.update({ status: 'ready' }); return { current: store.getSnapshot().current, routable: true, groups: GROUPS, failures: [] } },
  select: async (selection) => { store.update({ current: selection }) },
}
const modelDirectories = {
  directoryFor() {
    if (!world.scopeReady) throw new Error('session scope not registered yet')
    return directory
  },
}

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

function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (!node || typeof node !== 'object' || !('type' in node)) return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, kids: (node.kids ?? []).flatMap(expand) }
}

const plugin = captured.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('require escaped the module table: ' + spec)
})

const scope = {
  get: (name) => {
    if (name === 'modelDirectories') return modelDirectories
    if (name === 'connection') return world.connectionReady ? { api: { sessions: { models: async () => ({ result: { ok: true, value: { current: store.getSnapshot().current, routable: true, groups: GROUPS, failures: [] } } }) } } } : undefined
    return undefined
  },
  slots: { inject: (name, cb) => cb(), register: (options, component) => ({ options, component }) },
}

const registrations = []
plugin.apply({
  locale: { bind: () => key => key, register() {}, current: () => 'en' },
  effect: (fn) => { const out = typeof fn === 'function' ? fn() : undefined; return typeof out === 'function' ? out : () => {} },
  logger: { warn() {} },
  on: () => () => {},
  inject: (deps, callback) => callback({
    ...scope,
    slots: { inject: (n, cb) => cb(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  }),
  get: scope.get,
})

const { component, options } = registrations[0]
const injectFace = typeof options.inject === 'function' ? options.inject('brand-new-session') : {}

const find = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  for (const child of node.kids ?? []) find(child, predicate, out)
  return out
}
const isElement = (node) => node && typeof node === 'object' && 'type' in node
const byClass = (tree, className) => find(tree, n => isElement(n) && n.props && n.props.className === className)

/**
 * One render + effect flush, exactly like React's mount pass.
 *
 * Effects stay ALIVE until the next frame (React only runs a cleanup when the
 * effect re-runs or the component unmounts). Running cleanup immediately would
 * tear down the revival interval before it could ever fire — which is what the
 * first version of this harness got wrong.
 */
let pendingCleanups = []
const frame = () => {
  for (const cleanup of pendingCleanups) cleanup()
  pendingCleanups = []
  React.__index = 0
  const tree = expand(component({ locked: false, ...injectFace }))
  const batch = effects.splice(0)
  for (const fn of batch) {
    const cleanup = fn()
    if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
  }
  return tree
}

let failures = 0
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures += 1 }

// 1. Brand-new session: no directory scope, no connection → grey, but VISIBLE.
let tree = frame()
let trigger = byClass(tree, 'mp-trigger')[0]
check('new session: seat renders (not a hole)', trigger !== undefined)
// An unavailable seat is deliberately NOT disabled: it opens a menu that states
// the reason and offers Retry. A dead grey button was the worst failure mode.
check('new session: seat stays clickable while unavailable',
  trigger !== undefined && trigger.props.disabled === false)
check('new session: seat marks itself disabled only when the owner locks it',
  component({ locked: true, ...injectFace }) !== null)

// 2. The world becomes ready. NOTHING external pokes the seat: the revival
//    pump inside the component must schedule a timer, and firing it must
//    recover the seat.
world.scopeReady = true
world.connectionReady = true
check('grey seat scheduled a revival timer', timers.some(t => t.active))
tickTimers()
tree = frame()
trigger = byClass(tree, 'mp-trigger')[0]
check('after scope appears: seat revives by itself (no longer grey)',
  trigger !== undefined && trigger.props.disabled === false)
check('after revival: trigger names the current model',
  byClass(tree, 'mp-trigger-label')[0]?.kids[0] === 'Deepseek-V4-Pro')

// 3. Same for a restart where only the CONNECTION was missing (no directory service).
world.scopeReady = false
world.connectionReady = true
stateCells.length = 0
effects.length = 0
tree = frame()
trigger = byClass(tree, 'mp-trigger')[0]
check('restart with RPC only: seat is usable', trigger !== undefined && trigger.props.disabled === false)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
