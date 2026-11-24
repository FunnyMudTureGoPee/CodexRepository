#!/usr/bin/env node
/**
 * dsh 配置服务性校验：用 DeepSeek Harness 自己的 Config + apply() 解析
 * cordis.patch.yml，并逐个输出模型在 UI 里实际会显示的
 * 上下文窗口 / 输出上限 / 推理档位。
 *
 * 为什么要绕这一圈：dsh 的 lib/index.js 只导出 Config / PiAiAdapter / apply 等，
 * 没有导出 assertServiceable / resolveProfiles。但 apply() 内部第一件事就是跑
 * resolveProfiles()（assertServiceable 的全部实现），所以造一个假 ctx 调 apply()
 * 等价于 dsh 官方的服务性校验 —— 配置不可服务时它会直接抛错并指名是哪个路由哪个模型。
 *
 * 用法（必须用 dsh 仓库做 cwd，否则解析不到它的依赖）：
 *   cd D:\DSH\deepseek-harness
 *   node <本项目>\tools\dsh-verify.mjs
 *
 * 可用环境变量覆盖：
 *   DSH_ROOT      dsh 仓库根（默认 D:\DSH\deepseek-harness）
 *   DSH_PATCH     要校验的 patch 文件（默认 ~/.dsh/profiles/desktop/cordis.patch.yml）
 *   DSH_ROUTE     只看某个路由（默认 llm-pi-ai 下第一个 provider）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const DSH_ROOT = process.env.DSH_ROOT || 'D:\\DSH\\deepseek-harness'
const PATCH = process.env.DSH_PATCH
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const MOD = 'file:///' + path.join(DSH_ROOT, 'packages', 'llm', 'llm-pi-ai', 'lib', 'index.js')
  .replace(/\\/g, '/')

const require = createRequire(DSH_ROOT + path.sep)
const yaml = require('js-yaml')

const doc = yaml.load(fs.readFileSync(PATCH, 'utf8'))
const entry = (doc || []).find((e) => e && e.id === 'llm-pi-ai')
if (!entry) {
  console.error(`找不到 id: llm-pi-ai —— ${PATCH}`)
  process.exit(2)
}

const { Config, apply } = await import(MOD)
let cfg
try { cfg = Config(entry.config) } catch { cfg = new Config(entry.config) }

const routes = Object.keys(cfg.providers ?? {})
const routeKey = process.env.DSH_ROUTE || routes[0]
if (!cfg.providers?.[routeKey]) {
  console.error(`providers 里没有路由 "${routeKey}"，实际有：${routes.join(', ')}`)
  process.exit(2)
}

let adapter
const noop = () => undefined
const handle = () => ({ replace() {}, dispose() {} })
const ctx = new Proxy({
  get: () => undefined,
  logger: { warn: noop, error: noop, info: noop, debug: noop },
  inject: () => noop,
  llm: {
    registerConfigurableProviders: () => handle(),
    registerModelDiscovery: () => ({ dispose() {} }),
    registerAdapter: (_routes, a) => { adapter = a; return handle() },
  },
}, { get: (t, p) => (p in t ? t[p] : noop) })

// apply() 内部会跑 resolveProfiles()：配置不可服务就在这里抛
apply(ctx, cfg)
if (!adapter) {
  console.error('registerAdapter 未被调用（零路由 → 休眠态）')
  process.exit(3)
}

const route = cfg.providers[routeKey]
console.log(`patch        ${PATCH}`)
console.log(`route        ${routeKey}  (${JSON.stringify(adapter.providerInfo(routeKey))})`)
console.log(`baseURL      ${route.baseURL}`)
console.log(`api          ${route.api}`)
console.log(`compat       ${JSON.stringify(route.compat)}`)
console.log(`models       ${(route.models || []).length}`)
console.log('')

const rows = []
for (const m of route.models || []) {
  const info = await adapter.resolveModel(routeKey, m.id)
  rows.push({
    id: info.id,
    窗口: info.context?.contextWindow,
    输出上限: info.defaultMaxTokens ?? '(未设)',
    模态: (info.inputModalities || []).join('+'),
    推理档位: (info.reasoning?.efforts || []).map((e) => e.id).join(',') || '-',
    默认档: info.reasoning?.defaultEffort ?? '-',
  })
}
console.table(rows)

const withEfforts = rows.filter((r) => r.推理档位 !== '-').length
const noWindow = rows.filter((r) => !r.窗口).length
console.log('')
console.log(`带推理档位 ${withEfforts} / ${rows.length}`)
if (noWindow > 0) console.log(`⚠ 缺上下文窗口 ${noWindow} 个`)
for (const r of rows) {
  if (r.推理档位 !== '-' && r.推理档位.split(',').length < 2) {
    console.log(`⚠ ${r.id} 推理档位不足 2 档`)
  }
}
