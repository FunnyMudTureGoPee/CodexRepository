# client-ui report — `dsh-market-insight/client.js`

> **v2 修订（2026-11-04 17:xx，Lead 执行）**：家族规则改为只认 `same-repo` / GitHub fork 后，
> 移除了字典键 `relation.declared-fork` 与 `relation.same-name`（CONTRACT §5.4 现为 43 键），
> `FAMILY_RELATION_KEYS` 只保留 `fork` / `same-repo`；家族卡片徽章逻辑不变（按现有键动态生成）。
> 下文的 “v1.1 四键/45 键” 描述属于历史记录。

状态：**完成**（CONTRACT v1.1 已同步）。交付物：

| 文件 | 说明 |
|---|---|
| `dsh-market-insight/client.js` | 单文件浏览器模块（`window.__ModuleLoader__.load`），约 1820 行 |
| `dsh-market-insight/test/client-helpers.test.mjs` | 10 个测试，全绿 |
| `dsh-market-insight/notes/client-report.md` | 本报告 |

## 验证结果

```text
node --check client.js                 -> exit 0 (SYNTAX OK)
node test/client-helpers.test.mjs      -> tests 10, pass 10, fail 0
```

注意：受限 shell 里 `node --test ...` 会因沙箱禁止子进程管道而 `spawn EPERM`（环境限制，非测试本身失败）；
用 `node test/client-helpers.test.mjs` 直接运行（Node 24 进程内 test runner）即全绿。

测试内容：

1. 模块骨架：vm 沙箱捕获 `__ModuleLoader__.load` → `id='@local/dsh-market-insight'`、`inject=['slots','locale']`、
   `apply`；`plugins.tab` 注册项 `name/id/order:20/locale`，label thunk 中英切换（Insight ↔ 洞察）。
2. 字典：从 CONTRACT §5.4 解析 45 行（含 v1.1 `relation.same-name`），逐 key 断言 EN/ZH 与契约逐字一致，
   且两边 key 集合 = 契约 key 集合（无缺无余）。
3. 样式：client.js 中所有 `--dsw-*` 变量 ⊆ CONTRACT §5.3 token 白名单；无 hex/rgb/hsl 字面色值。
4. 依赖边界：只出现 `require('react')`；源码不含 `@deepseek-ai/`；无 ESM import。
5. 纯函数单测：数字/日期格式化、`isSafeHttpUrl`、`isFamilyItem`、`relationLabelKey`（含 same-name）、
   `entryRelation`（兼容 §4.3 顶层 relation）、`summarizeFamilyRelations`/`familyRelationBadges`（四键动态、丢 0、
   v1.0 无 relations 对象时回退按 entries 统计）、`buildFamilyTree`（排序/坏 parent/环/自指）、
   `installAction`/`installPayload`、`buildSearchPath`、`summarizeStatus`、`createTextResolver`（locale 异常回退 en）、
   `errorMessage`、`numberOr`。
6. `apply` 幂等性：apply 本身不渲染、不发请求；dispose disposer 可安全执行。

## 结构

1. **常量 + 字典**：`NS='marketInsight'`、API 前缀、`PAGE_SIZE=50`、搜索 debounce 250ms、状态轮询上限；
   EN/ZH 字典（CONTRACT §5.4 的 45 个 key）。
2. **纯函数区**（`// >>> mi-pure-helpers` 标记，测试可独立 eval；无 React/DOM/模块状态）：
   格式化、家族树构建、relations 四键汇总、install 决策、URL 构建、status 汇总、locale resolver、错误消息。
3. **`InsightController`**：单一不可变 snapshot + `useSyncExternalStore`；五类读（status/search/more/detail/refresh）
   各自 AbortController + 序号 fence（`beginRead/cancelRead/isCurrent/finishRead`），过期响应永远不会覆盖新状态；
   status 为 `loading` 时按 2s 轮询（上限 20 次）；`dispose()` 中止全部请求并清轮询定时器。
4. **CSS**：class 前缀 `mi-`，只用 §5.3 token；通过 React 渲染 `<style>` 注入（不写 `document.body`/不读他人 DOM）。
5. **组件**：
   - `InsightTab`（根，hooks：useSyncExternalStore/useState/useEffect；250ms debounce + effect 清理）
   - `Toolbar`（sticky、标题+来源/更新时间、搜索+清空、排序下拉、`role="switch"` 合并开关+条数徽标、刷新 spinner/disabled）
   - `StatusLine`（stats）、`CategoryPills`（全部+分类，横向滚动，brand 选中）
   - `ResultsBody`（骨架/空/错误重试/列表；`group=1` 用 `Array.isArray(item.entries)` 判定 family）
   - `FamilyCard`（root 行 + 展开树 + `family.total`；v1.1 从 `item.relations` 四键动态生成关系徽章，忽略 0）
   - `EntryCard`（group=0 逐条）、`SkeletonList`、`ErrorBlock`、`EmptyPanel`、`LoadMoreBar`
   - `DetailView`（返回、大标题、星标/下载/分类/版本/安装状态/收录日期、描述 pre-wrap、安装主按钮+兼容性提示、
     Fork 树区块、npm/repo/目录/下载量事实、`detail.versionsCount`）
   - `ForkTree` / `renderTreeNode`（缩进 + CSS 连接线；节点点击切详情；当前节点高亮；外部根未收录链接；
     relation 标签 upstream/fork/same-repo/declared-fork/same-name）
   - `InstallControl`（provided→禁用；installed→`openPackage(name)`；installable→
     `install({spec, registry?, title: 当前语言标题, version})`；不兼容→禁用 + 提示）

## 与真实运行时的对齐（读 app.asar 0.2.1-rc.5 官方 bundle 验证）

- `plugins.tab` 由 `dsh-client-ui-plugin-manager` 声明并 `renderSlot("plugins.tab", { install, openPackage })`；
  occupant 还会从 renderer 拿到按注册 `locale` 绑定的 `t`（本组件优先用 `props.t`，回退 apply 内 `bind(NS)`）。
- `ctx.locale.register(ns, 'en', dict)` 三参数形式在 0.2.1-rc.5 受支持（`register(ns, localeOrDicts, dict)`）；
  `bind(ns)` 返回按当前语言动态解析的 t；`resolveText` 走 fallback chain（用其解析 `{en,zh}` 标题/描述）。
- 未 import 任何 Harness Client 包；数据只经 `fetch('/dsh-market-insight/api/...')`；POST `/refresh` 带
  `x-market-insight: 1`；响应按 `{ok,value}` / `{ok,error}` 解包（§4）。
- 安全：外链仅渲染 http(s)（`isSafeHttpUrl`），`target=_blank rel=noreferrer noopener`。

## 与 Host 实现（Host 半已就绪后）的交叉核对

对照 `host/api.mjs`（路由/信封/参数解析）与 `host/store.mjs`（`status()/search()/entry()` 返回构造）：

- `/search`：`{query, matched, categories, total, items, nextOffset, generatedAt}`，`categories: {id,title}`；
  `group=1` 的 FamilyItem 为 `{kind:'family', id, root, entries, externalRoot, totalStars, totalDownloads, relations}`，
  其中 `relations = family.relationCounts` 固定四键（fork/same-repo/declared-fork/same-name）——client 按此四键动态出徽章。
- `/entry`：`family` 在无家族时直接省略（`undefined`）——client 归一为 `null` 并展示 `detail.standalone`；
  `family.entries[]` 带 `isRoot`，关系在 `lineage.relation`（client 同时兼容 entry 顶层 `relation`）。
- `/status`：`totals` 在 model 未建好时可能缺省、`catalog`/`forks` 可能为 `null`——client 全部走 null 兜底。
- `/refresh`：Host 立即返回 `{started, refreshing:true}` 后异步重建；client 轮询 `/status` 直到
  `refreshing !== true`（500ms × 120 上限）再重新 `loadStatus()`+搜索，避免“点了刷新数据不变”。
  `refreshing` 期间工具栏 spinner/禁用保持。
- EntrySummary 实测形状：`install:{spec,registry?,version}`、`repo:{fullName,url,fork,source}`、
  `repository:{url,directory?}`、`npm` 恒为包名、`stars/downloads/added` 可为 null、`installation` 五态——
  与 client 的 `installAction/installPayload/格式化` 假设一致。

## 已知未验证项（环境所限，无法在本会话验证）

1. **真实接口联调**：Host 代码已就绪但插件尚未安装、未起真实 HTTP 请求；上述对齐来自契约 + Host 源码静态核对，
   不等于端到端验证（Lead 负责安装后用 `/status`、`/search`、`/entry` 实测）。
2. **浏览器视觉**：未做亮/暗主题人工确认；仅静态保证只使用 §5.3 token。未验证 sticky 在 Plugins 页容器内的表现。
3. **React 实渲染**：测试用 stub React 只验证工厂/apply/注册/纯函数，未在 Electron 里挂载组件；
   hooks 规则（全部 hook 在条件返回前调用）、key 均人工复核。
4. **`install`/`openPackage` owner 行为**：只按契约传参，未验证 Plugins 页实际安装/跳转流程。
5. **性能**：未在真实 4389 条数据下测渲染；列表分页 50/页，家族内条目数预计很小（树构建 O(n)）。

## 实现取舍

- 数字格式：契约文字写“≥10000 → 12.3k”，但示例出现 `★ 1.2k`/`⤓ 8.8k`；实现采用 ≥1000 → `1.2k`、
  ≥1M → `1.2M`（`999950` 起进位为 M），兼容两处表述。
- 错误行统一显示 `t('error.load')` + Host 错误 message 小字 + 重试；刷新失败在工具栏内单独显示并可重试。
- 详情视图替换整个列表区（工具栏隐藏），返回后 query/category/sort/group/expanded 全部保留在 controller 中；
  切换 Plugins 页 tab 不重复请求（`ensureLoaded` 只启动一次，数据在 controller 生命周期内保留）。
- v1.1 `same-name`：加入 relation 标签映射与字典；家族卡片关系徽章从 `FamilyItem.relations` 四键动态生成、
  过滤 0 值、固定顺序 `fork / same-repo / declared-fork / same-name`；无 `relations` 对象时按 entries 回退统计。
