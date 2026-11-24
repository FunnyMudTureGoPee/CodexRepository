/**
 * One-off repair for client.js after a PowerShell re-encode mangled its
 * non-ASCII literals (UTF-8 bytes were read as GBK, then written back as UTF-8).
 *
 * The damage is confined to characters outside ASCII: the Chinese dictionary,
 * the bilingual kind/family labels, and typographic dashes/arrows in comments.
 * ASCII code is untouched, so each damaged line is rebuilt from its intended
 * text below, reusing the indentation already present in the file.
 *
 * Run: node tools/repair-encoding.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TARGET = fileURLToPath(new URL('../client.js', import.meta.url))

/** lineNumber (1-based) → intended content without its leading whitespace. */
const REPAIRS = new Map([
  [1, '/**'],
  [2, '* Model Picker — browser half of the `@local/dsh-model-picker` bundle.'],
  [7, '*   渠道 channel  →  厂商族 family  →  型号 model  →  推理档位 effort'],
  [10, '* mirrored as `model:minimal` … `model:max` twins. Here the twins are folded'],
  [11, '* away: the model list holds base models only (≈50), the effort twins of the'],
  [35, '// 0. Pure classification (inlined — a client bundle MUST be self-contained)'],
  [48, '/** Canonical effort levels, weakest → strongest. Hosts may expose a subset. */'],
  [54, '* accepted for SUFFIX PARSING only — EFFORT_LEVELS stays the 6 levels.'],
  [60, '/** kind → bilingual label for the UI chip / group header. */'],
  [62, "pro: Object.freeze({ zh: '专业 Pro', en: 'Pro' }),"],
  [63, "flash: Object.freeze({ zh: '快速 Flash', en: 'Flash' }),"],
  [64, "turbo: Object.freeze({ zh: '极速 Turbo', en: 'Turbo' }),"],
  [65, "code: Object.freeze({ zh: '代码 Code', en: 'Code' }),"],
  [66, "vision: Object.freeze({ zh: '多模态 Vision', en: 'Vision' }),"],
  [67, "thinking: Object.freeze({ zh: '推理 Thinking', en: 'Thinking' }),"],
  [68, "preview: Object.freeze({ zh: '预览 Preview', en: 'Preview' }),"],
  [69, "standard: Object.freeze({ zh: '标准 Standard', en: 'Standard' }),"],
  [90, "hunyuan: Object.freeze({ id: 'hunyuan', label: '混元 Hunyuan', order: 50 }),"],
  [92, "other: Object.freeze({ id: 'other', label: '其他 Other', order: 900 }),"],
  [191, "/** Associate one provider group's flat list into family → model buckets. */"],
  [194, '/** baseId → { bare?, twins: Map<effort, model> } */'],
  [387, "'channel.summary': '{families} types · {models} models',"],
  [393, "'search.placeholder': 'Filter models…',"],
  [395, "'status.loading': 'Loading models…',"],
  [408, "'trigger.fallback': '选择模型',"],
  [409, "'trigger.selectAria': '选择模型',"],
  [410, "'trigger.aria': '选择模型，当前 {model}',"],
  [411, "'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',"],
  [412, "'menu.aria': '模型与推理等级',"],
  [413, "'crumb.channel': '渠道',"],
  [414, "'crumb.family': '类型',"],
  [415, "'crumb.model': '模型',"],
  [416, "'crumb.effort': '档位',"],
  [417, "'pane.channels': '渠道',"],
  [418, "'pane.families': '模型类型',"],
  [419, "'pane.models': '模型',"],
  [420, "'pane.efforts': '推理档位',"],
  [421, "'channel.summary': '{families} 类 · {models} 个模型',"],
  [422, "'family.summary': '{n} 个模型',"],
  [423, "'model.current': '当前',"],
  [424, "'effort.providerDefault': '渠道默认',"],
  [425, "'effort.current': '当前',"],
  [426, "'back': '返回',"],
  [427, "'search.placeholder': '筛选模型…',"],
  [428, "'search.clear': '清除筛选',"],
  [429, "'status.loading': '正在加载模型…',"],
  [430, "'empty.models': '该渠道下没有模型',"],
  [431, "'empty.efforts': '该模型没有可调推理档位',"],
  [432, "'empty.search': '没有匹配的模型',"],
  [433, "'error.action': '加载模型失败：{message}',"],
  [434, "'warning.groupLoad': '{name} 加载失败：{message}',"],
  [435, "'retry': '重试',"],
  [436, "'action.reload': '重新加载',"],
  [437, "'menu.close': '关闭',"],
  [498, '* `connection.api` at the right moment — the failure that left the seat grey.'],
  [530, '* an unresolvable state is otherwise silent — the Host keeps the last report'],
  [699, '// Breadcrumb: 渠道 / 类型 / 模型 / 档位 with the current path in primary.'],
  [718, '// Kind badge (pro / flash / vision …) and the per-kind group heading.'],
  [785, '* Level 1 — channels. One row per provider group, with its type count and'],
  [808, '/** Level 2 — model families (厂商族) inside one channel. */'],
  [828, '* (Pro / Flash / Vision …) so a 12-model family still reads as a short menu.'],
  [829, '* Kind groups are not clickable — only models are.'],
  [857, ": h('span', { className: 'mp-row-count' }, entry.efforts.length + '×'),"],
  [865, '/** Level 4 — reasoning efforts of the chosen model, plus the provider default. */'],
  [999, "/** 'channels' → 'families' → 'models' → 'efforts' */"],
  [1020, '* Load the directory once per session. Keyed on the session alone — NOT on'],
  [1021, '* the store status — so a failed load cannot loop: the error surface is the'],
  [1048, '// a hole — it becomes live on the next render once the connection lands.'],
  [1172, '// fall back to the catalog\'s own display name for the exact id — never a'],
  [1273, "// level — never to the host's current selection, which does not move"],
  [1303, "title: effortLabel === undefined ? modelLabel : modelLabel + ' · ' + effortLabel,"],
  [1339, '* Two boot-safety rules learned the hard way — violating either took the'],
])

const raw = readFileSync(TARGET, 'utf8')
// Strip a BOM a PowerShell write may have added, and normalize line endings.
const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
const lines = text.split('\n')

let repaired = 0
for (const [lineNumber, content] of REPAIRS) {
  const index = lineNumber - 1
  const current = lines[index]
  if (current === undefined) throw new Error(`line ${lineNumber} does not exist`)
  const indent = /^[ \t]*/.exec(current)[0]
  const next = indent + content
  if (next !== current) {
    lines[index] = next
    repaired += 1
  }
}

const output = lines.join('\n')
writeFileSync(TARGET, output, 'utf8')
console.log(`repaired ${repaired}/${REPAIRS.size} lines; ${output.length} chars, BOM-free`)
