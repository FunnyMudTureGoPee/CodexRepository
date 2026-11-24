#!/usr/bin/env node
/**
 * 复现 dsh「获取可用模型」按钮到底返回什么。
 *
 * 背景：那个按钮背后是 llm-pi-ai 的 discoverModels()，返回类型
 * LlmDiscoveredModel 只有四个字段（id / name / contextWindow / maxTokens），
 * 所以无论后端给多少信息，按钮都拿不到推理档位。这个脚本把同一函数调一遍，
 * 让你自己看到返回的字段集合，而不用猜。
 *
 * 用法（必须用 dsh 仓库做 cwd）：
 *   cd D:\DSH\deepseek-harness
 *   node <本项目>\tools\dsh-discover-check.mjs
 *
 * 环境变量：DSH_ROOT / DSH_PATCH / DSH_BASEURL（默认 http://127.0.0.1:8787/v1）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const DSH_ROOT = process.env.DSH_ROOT || 'D:\\DSH\\deepseek-harness'
const PATCH = process.env.DSH_PATCH
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const BASEURL = process.env.DSH_BASEURL || 'http://127.0.0.1:8787/v1'
const MOD = 'file:///' + path.join(DSH_ROOT, 'packages', 'llm', 'llm-pi-ai', 'lib', 'index.js')
  .replace(/\\/g, '/')

const require = createRequire(DSH_ROOT + path.sep)
const yaml = require('js-yaml')

const creds = (fs.existsSync(CRED) ? yaml.load(fs.readFileSync(CRED, 'utf8')) : {})?.refs || {}
const patch = yaml.load(fs.readFileSync(PATCH, 'utf8'))
const entry = (patch || []).find((e) => e && e.id === 'llm-pi-ai')
if (!entry) {
  console.error(`找不到 id: llm-pi-ai —— ${PATCH}`)
  process.exit(2)
}

const { Config, apply } = await import(MOD)
let cfg
try { cfg = Config(entry.config) } catch { cfg = new Config(entry.config) }

// discoverModels 没从 index 导出；但 apply() 会把它注册进 llm 服务，
// 这里抓住注册时那个回调 —— 与 UI 点按钮走的是同一个函数。
let discover
const noop = () => undefined
const handle = () => ({ replace() {}, dispose() {} })
const ctx = new Proxy({
  get: (n) => (n === 'credentials' ? { resolve: async (r) => (creds[r] ? { value: creds[r] } : undefined) } : undefined),
  logger: { warn: noop, error: noop, info: noop, debug: noop },
  inject: () => noop,
  llm: {
    registerConfigurableProviders: () => handle(),
    registerModelDiscovery: (_ns, fn) => { discover = fn; return { dispose() {} } },
    registerAdapter: () => handle(),
  },
}, { get: (t, p) => (p in t ? t[p] : noop) })

apply(ctx, cfg)
if (!discover) {
  console.error('没抓到 registerModelDiscovery —— dsh 版本可能变了')
  process.exit(3)
}

const routeKey = Object.keys(cfg.providers ?? {})[0]
const cases = [
  { label: '只给 provider（不填 baseURL，模拟端点空着的草稿）', req: { provider: routeKey } },
  { label: 'provider + baseURL（模拟已保存好 baseURL 的路由）', req: { provider: routeKey, baseURL: BASEURL, api: 'openai-completions' } },
]

for (const c of cases) {
  console.log('\n=== ' + c.label)
  try {
    const models = await discover(c.req)
    console.log('  模型数:', models.length)
    console.log('  字段集合:', JSON.stringify(Object.keys(models[0] || {})))
    console.log('  前三个:', JSON.stringify(models.slice(0, 3)))
    const missing = ['reasoning', 'reasoningEfforts', 'defaultEffort', 'input']
      .filter((k) => models[0] && !(k in models[0]))
    if (missing.length) {
      console.log('  注意：下面这些字段按钮拿不到 →', missing.join(', '))
      console.log('        （LlmDiscoveredModel 只定义了 id/name/contextWindow/maxTokens）')
    }
  } catch (e) {
    console.log('  失败:', String((e && e.message) || e))
  }
}
