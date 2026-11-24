# lineage-engine 交付报告 — fork 家族图 + 搜索索引

> **v2 修订（2026-11-04 17:xx，Lead 执行）**：用户指出“用 README 描述归纳 fork 过于牵强”。
> 已从 `host/lineage.mjs` 移除 `declared-fork`（描述文本解析）与 store 中的 `same-name`（描述相似度）规则；
> 家族现在只由 `same-repo`（同一 GitHub 仓库）与 GitHub fork 元数据（`fork=true` + `source`）构成。
> 新真实数据：4389 条目 → **4187 家族 / 202 个聚合条目**（同仓库 187、fork 39；24 个外部上游家族）。
> 下文 §1.3、§6 统计等属于 v1 历史记录，保留作参考，不再代表当前行为。

> 冻结契约：`CONTRACT.md` v1（§3.3 / §3.4 / §6）。本报告记录实现、真实数据质量验证、测试命令与遗留风险。

- **日期**：2026-11-04
- **Node**：`D:\DSH\deepseek-harness-app\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）
- **数据快照**：market index `format=1`，4389 条；catalog 8489 条（其中 4389 条带 npm）；`data/forks.json` `generatedAt=2026-11-04T04:13:24.879Z`，`counts={requested:4202, ok:3985, forks:39, missing:217, failed:0}`
- **交付文件**
  - `host/lineage.mjs` — 纯函数：`buildFamilies({ entries, catalog, forkSnapshot })`
  - `host/search.mjs` — 纯函数：`segment(text)` / `buildIndex(entries)` / `matchText(index, text)`
  - `test/lineage.test.mjs` — 16 个测试（fixture 规则 + 真实数据）
  - `test/search.test.mjs` — 14 个测试（fixture 规则 + 真实数据）
  - `notes/lineage-report.md`（本文件）

---

## 一、host/lineage.mjs

### 1.1 API（与 task-1 约定一致）

```js
const { entryFamily, entryLineage, families } = buildFamilies({ entries, catalog, forkSnapshot });
// entryFamily: Map<name, familyId>
// entryLineage: Map<name, { familyId, rootRepo, depth, parentName, relation }>
// families: Array<{ id, rootRepo, rootName, externalRoot, entries, totalStars, totalDownloads, relationCounts }>
```

- 无 import、无 fs/网络、不修改入参、同步纯函数。
- `catalog` 接受数组 / `{plugins:[...]}` 文档 / Map；`forkSnapshot` 接受整份文档或 `repositories` Map；缺失数据只表示“未知”，不会抛错。
- 额外字段 `families[].rootName`（任务清单未列）：家族根条目的 `name`，根不在市场时为 `null`；供宿主快速取根，Lead 的 `store.mjs` 未依赖它。
- 真实数据下 Lead 的 `store.mjs` 只消费 `entryFamily` / `entryLineage`（`test/store.test.mjs` 6/6 全绿，未改变其语义）。

### 1.2 规则实现（CONTRACT §3.3）

| 规则 | 实现 |
|---|---|
| same-repo | 按 `github.com/<owner>/<name>` 归一化（大小写不敏感、去 `.git`/子路径）后并查集合并；`repository.directory` 不影响分组（monorepo 子包同家族） |
| GitHub fork | `forks.json` 中 `fork === true` 且 `source` 可解析 → 根仓库 = source；source 在市场 → 与该仓库条目合并；不在市场 → `externalRoot={fullName, url}`，家族仍以 source 为根 |
| declared-fork | 见 §1.3；仅接受唯一解析到“另一条市场条目”的边，并查集合并，根取目标所在家族根 |
| 根优先级 | ① GitHub source 根（优先市场内仓库）→ ② 声明链最终上游（被其他条目声明为 parent 的终端优先）→ ③ 星标最高仓库；同分时按仓库 key 字典序，保证确定性 |
| depth/relation | 根 = `upstream`/depth 0；同仓库兄弟 = `same-repo`/d1；GitHub fork = `fork`/d1（根在市场时 parentName=根条目名，外部根为 null）；声明派生 = `declared-fork`/parent.depth+1；无仓库、无亲缘的单条 = relation `null`、depth 0 |
| 输出确定性 | 家族按 totalStars desc + id asc 排序；家族内条目按 stars desc + name asc；所有候选/锚点选择都有显式 tie-break；同输入两次运行 JSON 完全一致（测试断言） |
| 性能 | 4389 条 + 4202 仓库 + fork 快照，**best-of-3 = 24.9 ms**（测试机，Node 24；契约要求 < 300 ms） |

### 1.3 声明式派生解析（严格白名单）

- 描述来源：catalog 描述优先（`en` → `zh`），catalog 缺失时回退 market 条目描述。
- 白名单模式（按契约顺序，大小写不敏感）：`fork of`、`forked from`、`fork 自`、`基于`、`based on`、`port of`、`ported from`、`移植自`、`derived from`、`adapted from`。
- 目标取短语后第一个词，去包裹引号/括号/尾部标点，再尝试去尾部版本号（`pkg@1.2.3`、`v1.2.3`）。
- 目标解析顺序（必须唯一命中**另一条市场条目**，否则丢弃）：
  1. npm 包名（小写精确）；
  2. `owner/repo`（大小写不敏感精确，也接受 GitHub URL）；
  3. 仓库短名 / catalog `name`（仅唯一命中时）。
- 兜底拒绝：`the/a/an/DeepSeek/DSH/public/官方/…` 等停用词不当作 target；歧义短名、目标不在市场、自引用一律丢弃。
- 一个描述出现多个短语时，按“描述（en→zh）× 白名单顺序”取第一个可唯一解析的目标；解析失败的短语不会掩盖后续可解析的短语（测试覆盖）。
- 声明边按条目名升序接受；若会形成环则跳过该边（防 A↔B 死循环，测试覆盖）。

### 1.4 解释性决策（契约未逐字规定处）

1. `rootRepo`：非独立家族 = 家族根仓库小写 key；**独立单条 = `null`**（契约 §3.2 “null = 独立插件”），但其 `familyId` 仍为 `family:<自身仓库>`，因此仍可参与分组。
2. 外部根家族：`rootRepo` = source（小写）、`rootName = null`、`externalRoot = {fullName, url}`；这类家族没有 `upstream` 条目，`relationCounts` 覆盖全部成员。
3. 单条但仓库是 GitHub fork → 不是独立插件：家族有 externalRoot，条目 `relation='fork'`、depth 1。
4. `families[].entries` 含根，顺序遵循 §3.2（stars desc, name asc）；不会把根强行放首位（宿主用 `rootName`/relation 定位）。
5. 无仓库 URL 的条目不参与仓库分组，`familyId=family:external:<name>`；真实数据 4389 条全部有 GitHub URL，因此该分支仅 fixture 覆盖。

---

## 二、真实数据质量验证（index.json + plugins.json + forks.json）

### 2.1 规模与家族统计

| 指标 | 数值 |
|---|---|
| market 条目 | **4389** |
| 唯一 GitHub 仓库 | **4202**（其中 56 个仓库被多个条目使用，共 243 条） |
| 家族数（合并后） | **4164** |
| 多条目家族 | **90** |
| 被合并条目 | **315**（= 4389 − 4051 个独立家族） |
| 关系分布 | `upstream` 89 · `same-repo` **187** · `fork` **39** · `declared-fork` **23** · 独立 4051 |
| 外部根家族 | **24**（source 不在市场，`externalRoot` 非空） |
| 最大家族 | `family:liuhange789/data-asset-inspector`：同仓库 **24** 条，totalStars 96 |
| 构建耗时 | **24.9 ms**（best-of-3，4389 条 + catalog + 快照） |

fork 家族部分（39 条 GitHub fork）：15 条根仓库在市场（与上游同家族），24 条根仓库不在市场（`externalRoot`）。

同源/fork 家族样例：

- `family:c1overzz/dsh-bili-scroll`：`dsh-bili-scroll`(upstream) + `dsh-bili-subagent`(fork) + `dsh-deepmoyu`(declared-fork)
- `family:zhu1090093659/dsh-pet`：`@linxin666/dsh-pet`(upstream) + `dsh-pet-copilot`(fork)
- `family:maxeaglet/dsh-bash-terminal`：`dsh-bash-terminal`(upstream) + `dsh-bash-terminal-ts`(fork)
- `family:hdhgsysh/dsh-connect-qoder`（外部根）：`@eghrhegpe/dsh-connect-qoder`(fork)，`externalRoot=hdhgsysh/dsh-connect-qoder`
- `family:liuhange789/data-asset-inspector`：24 条同仓库，1 upstream + 23 same-repo

### 2.2 声明式边（23 条）10 个样例

| 派生条目 | 目标条目（`parentName`） | 描述证据 / 解析类型 |
|---|---|---|
| `@panando/dsh-pua` | `@michengai/dsh-pua` | "Fork of @michengai/dsh-pua …" / npm 精确 |
| `@all3cn/dsh-better-sidebar-n23` | `dsh-better-sidebar` | "Full workbench fork of dsh-better-sidebar" / 唯一短名 |
| `@whybebabo/dsh-file-review-tab` | `dsh-file-review-tab` | "port of Lzh3070/dsh-file-review-tab" / owner/repo |
| `dsh-ui-sound` | `dsh-plugin-uisfx` | "community port of dsh-plugin-uisfx" / 唯一短名 |
| `dsh-chatting-pet` | `dsh-pet` | "A fork of dsh-pet (MIT)" / 唯一短名 |
| `dsh-remote-bot-bridge` | `ds-harness-remote` | "基于 ds-harness-remote 的…"（zh）/ 唯一短名 |
| `dsh-inapp-chat` | `@zerorigin-studio/dsh-deepseek-chat` | "Fork of zerorigin-studio/dsh-deepseek-chat" / owner/repo |
| `dsh-douyin-agent` | `dsh-douyin-browser-local` | "Fork of LockyBee/dsh-douyin-agent" / owner/repo |
| `computer-user-vision` | `computer-user` | "forked from computer-user" / 唯一短名 |
| `dsh-pr-panel` | `dsh-github-flow` | "fork 自 ItQianChen/dsh-github-flow"（zh）/ owner/repo |

`@panando/dsh-pua` 的完整 lineage：`{ familyId: "family:michengai/dsh-pua", rootRepo: "michengai/dsh-pua", depth: 1, parentName: "@michengai/dsh-pua", relation: "declared-fork" }`，与 `@michengai/dsh-pua` 同家族（totalStars 50 / totalDownloads 75168）。

说明：不接 fork 快照时声明边会得到 27 条；接入快照后 4 条同时被 GitHub fork 证据覆盖（relation 归为 `fork`），最终 `declared-fork` = **23** 条。

### 2.3 解析损失与严格性

对 200 条“首命中即解析”的描述做人工/脚本核对：约 172 条被丢弃，主要原因：

- 目标不是市场条目（如 `yumusb/dsh-opencode-go-usage`、`obra/superpowers`）——契约要求必须解析到另一条市场条目；
- 通用词 target（`the` 15 次、`本地` 6、`DSH` 5、`DeepSeek` 4、`官方` 4）——契约明确禁止；
- 歧义短名（多个仓库同名）或目标就是自身仓库。

因此当前声明边数量偏保守但质量高（抽查 23 条全部语义正确）。

---

## 三、host/search.mjs

- 归一化：`String.prototype.normalize('NFKC')` + `toLowerCase()`；字段权重 name/title = 3、category = 2、description = 1（英/中同字段取最大权重）。
- 切词：字母/数字/标记连续段；CJK（Han/Hiragana/Katakana/Hangul）连续段 = 重叠二元组 + 末尾单字（`记忆系统` → `记忆`、`忆系`、`系统`、`统`）。
- 匹配：查询词须全部命中（AND）；对索引词前缀匹配，查询词 ≥4 码点时允许编辑距离 ≤ `max(1, round(len/5))`；每个查询词按命中字段的最高权重计分后求和。
- 无字母/数字查询（空串、纯标点）→ 全部条目 score 0；无依赖、确定性输出。
- 真实数据：4389 条 → **64,382** 个索引词，`buildIndex` ≈ **128–153 ms**；查询 `记忆` 275 命中 / 0.4 ms、`插件` 770 / 0.4 ms、`dsh` 4279 / 0.6 ms、`terminal` 62 / 3 ms、`memoory`（容错）249 / 6.5 ms、`pua` 2 / <0.1 ms。

---

## 四、测试与运行方式

受限 shell 中 `node --test test/*.mjs` 会因子进程管道被沙箱拒绝（`Error: spawn EPERM`，属已知受限边界），因此直接执行测试文件（同一套 `node:test` 断言，in-process 运行，退出码可靠）：

```powershell
$node='D:\DSH\deepseek-harness-app\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node --check host/lineage.mjs
& $node --check host/search.mjs
& $node test/lineage.test.mjs   # 16/16 pass, 0 fail
& $node test/search.test.mjs    # 14/14 pass, 0 fail
& $node test/store.test.mjs     # Lead 的测试，6/6 pass（确认兼容，未改动其语义）
```

本次最终结果：

- `test/lineage.test.mjs`：**16 pass / 0 fail**（含真实数据覆盖/确定性/性能门禁 `<300ms`）
- `test/search.test.mjs`：**14 pass / 0 fail**（含真实数据 4389 条、`记忆`/`pua`/精确包名/容错查询）
- 真实数据测试在数据文件缺失时自动 skip（优先项目内 `data/`，回退开发数据目录），不会误报。

覆盖点：同仓库 4 条合并、`repository.directory` 不拆分、GitHub fork（市场内根/外部根）、声明派生（npm/owner-repo/唯一短名/中文模式）、不可解析/歧义/停用词 target 丢弃、后续短语可解析、根优先级（GitHub source > 声明根）、环破坏、独立条目标识、确定性（重复输入 & 乱序输入）、4389 条真实数据完整性与性能；搜索侧覆盖 NFKC/大小写、CJK 二元组、字段权重（取最大不重复计分）、AND 求和、前缀、编辑距离（≥4 才启用）、空查询、乱序确定性。

---

## 五、风险与待确认项

1. **契约 §6 的“合并后 total ≈ 3.7k–3.9k”与真实数据不符**：按 §3.3 规则实测家族数 **4164**（Lead 的 `store.mjs` 再做同名变体合并后为 4127）。原因是数据快照里 GitHub fork 只有 39 个（契约 §3.1 示例写的是 397），且 217 个仓库查询缺失；同源分组本身只有 187 条。建议 Lead 放宽 §6 的验收表述而不是在 lineage 层造边。
2. **fork 数据稀疏且会变**：`forks.json` 由 collector 生成，当前 `counts.forks=39`。重新生成快照后 fork 家族数量会变化；测试只断言范围/下限，不写死 39。
3. **声明式边严格性**：只认白名单短语 + 唯一解析目标。像 "based on the MIT-licensed `owner/repo`" 这类描述首词是 `the`，会丢边（若同描述的 zh 文本有 `基于 owner/repo` 则仍可命中）。若 Lead 想提高召回，可放宽为“跳过前置停用词/最多扫描 N 个 token”，但这是对 §3.3 的契约变更，需 Lead 确认。
4. **矛盾证据的展示（仅 1 例）**：`dsh-scratchpad-plus` 同时是 GitHub fork（source `1264459640/dsh-scratchpad`，外部根）且声明派生自市场内的 `@chaiyahang/dsh-scratchpad`。按契约 §3.3 规则 4，GitHub source 根优先，因此 `@chaiyahang/dsh-scratchpad` 会作为 `declared-fork` 子节点挂在外部根家族里（树方向在语义上略显倒置）。不影响计数正确性。
5. **独立条目的 `rootRepo=null`**：这是契约 §3.2 的字面语义；若客户端需要“独立条目的仓库”请从 `entry.repo` 取，不要从 `lineage.rootRepo` 取。
6. **`families[]` 额外 `rootName` 字段**：Lead 的 store 未使用 `families[]`；若后续消费请注意该字段非契约冻结字段。
7. **search 计分口径**：同一查询词命中多个字段时取最高权重（name/title=3），不是字段权重累加；多查询词之间求和。若与官方 Discover 的排序有细微差异，可在 Lead 侧用排序字段覆盖（当前契约只要求权重与 AND 语义）。
