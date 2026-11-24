# Market Insight 插件 — 设计与协作契约 v1

> 目标：给 DSH Web 的「插件」页面增加一个 **洞察 / Insight** 标签页，在搜索界面里直观显示每个插件仓库的 **Star 数**、下载量，并按 **fork 家族（fork 树）聚合同源插件**；默认合并、可展开树状查看、可切换为逐条显示。

本文件是 Lead 与各 member 之间的冻结契约（v1）。**不要**单方面修改已冻结的字段名/路由；需要变更时先给 Lead 发消息。

## 0. 环境事实（所有 member 必读）

- 工作目录：`D:\DSH\WorkShop`（workspace-write 沙箱）。
- 项目目录：`D:\DSH\WorkShop\dsh-market-insight`（本插件 bundle）。
- 已安装 DSH 源码/构建：`D:\DSH\deepseek-harness-app\resources\app.asar\dsh\node_modules\@deepseek-ai\...`（**只有 `read` 工具能读 asar 内文件**；glob/grep/ripgrep/shell 读不了 asar）。
- Node 可执行文件（绝对路径）：`D:\DSH\deepseek-harness-app\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24）。`node`/`pnpm` 不在 PATH。
- **受限 shell 无外网**（curl/fetch 会失败）；需要联网的探测只能由 Lead 用提权命令或 Host 侧完成。本地文件读写、`node` 跑测试正常。
- 不要调用 `plugin_manager`（安装/卸载/启停由 Lead 独占）；不要改 profile 目录、不要改 `D:\DSH\deepseek-harness` 源码。
- 数据文件（只读参考）：
  - 市场索引（format 1，4389 个可安装插件）：`D:\DSH\WorkShop\dsh-market-plus\data\index.json`
  - 目录元数据（8489 条，含 stars/downloads/npm/repo/描述）：`D:\DSH\WorkShop\dsh-market-plus\data\plugins.json`
  - fork 快照（Lead 后台生成中）：`D:\DSH\WorkShop\dsh-market-insight\data\forks.json`

## 1. Bundle 结构

```
dsh-market-insight/
  package.json          # Lead
  cordis.patch.yml      # Lead
  index.js              # Lead — Host 半：apply(ctx, config) 注册 HTTP 路由
  host/                 # Lead — 数据管线与路由实现
    cache.mjs  catalog.mjs  market.mjs  store.mjs  api.mjs
  host/lineage.mjs      # lineage-engine — 纯函数：同源/ fork 家族图
  host/search.mjs       # lineage-engine — 纯函数：搜索索引与打分
  client.js             # client-ui — 浏览器半（单文件，window.__ModuleLoader__）
  data/forks.json       # Lead（collector 生成，随包分发快照）
  locale/en.json        # Lead — 插件展示用 meta
  locale/zh.json        # Lead
  icon.svg              # Lead — 原创图标
  tools/collect-forks.mjs  # 已存在
  test/*.mjs            # lineage-engine / Lead 的单测
  notes/*.md            # 各 member 的报告
```

写入范围（workspace 相对）：`dsh-market-insight/host/lineage.mjs`、`host/search.mjs`、`test/lineage*.mjs`、`test/search*.mjs`、`notes/lineage-*.md` 属于 lineage-engine；`dsh-market-insight/client.js`、`notes/client-*.md` 属于 client-ui；其余属于 Lead。

## 2. Host 数据来源（Lead 实现）

1. 市场条目：通过 Host 服务 `pluginMarket`（`ctx.pluginMarket`）获得，不用自己 fetch 索引：
   - `listIndexes()` → 取第一个配置源（或 lead 决定选哪个）；没有源 → state `empty`。
   - 对每个源分页 `search(url, { limit: 100, offset })` 直到 `nextOffset == null`；这是**已校验**的市场条目，含 `name/title/description/homepage/repository/metadata/versions/defaultVersion/installation`。版本对象含 `install:{spec,registry?}` 与 `compatibility`。
   - 缓存到 `$DSH_HOME/market-insight/market-<hash>.json`；TTL 见 Config；`plugin-manager/changed`、`plugin-market/changed` 时标记需要刷新安装状态。
2. 星标/下载量：fetch `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json`（11MB，可被 Config 覆盖），按 **npm 包名小写精确匹配** 市场条目 —— 已实测 4389/4389 全部匹配。缓存到 `$DSH_HOME/market-insight/catalog.json`，TTL 12h。
3. fork 关系：随包 `data/forks.json` 快照（结构见 §3），运行时对快照缺失的仓库按需查询：
   `https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/<owner>%2F<name>` → `{fork, source_name, stargazers_count, archived, pushed_at}`；结果合并写回 `$DSH_HOME/market-insight/forks-cache.json`。默认只在用户打开洞察页/详情时对**当前页内**缺失仓库做上限为 `maxForkLookupsPerRefresh` 的补查，绝不一次性全量抓。
4. 安装状态：市场条目自带 `installation`（`not-installed|installed|update-available|different-version|provided`）；Host 每次响应前对当前页条目用 `pluginManager.listBundles()` 轻量刷新版本比较。

## 3. 数据模型（冻结）

### 3.1 forks.json（随包快照，Lead 生成）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-04T04:20:00.000Z",
  "source": "https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/<owner>/<name> (anonymous tier)",
  "counts": { "requested": 4202, "ok": 3985, "forks": 39, "missing": 217, "failed": 0 },
  "repositories": {
    "owner/name": { "fork": true, "source": "upstream-owner/upstream-name", "stars": 123, "archived": false, "pushedAt": "2026-10-01T00:00:00.000Z" },
    "owner/missing": { "missing": true }
  }
}
```

仓库键统一为 `owner/name` 原大小写；比较时用 `.toLowerCase()`。`source` 为 GitHub fork 网络根仓库（`source_name`，可能为空）。

### 3.2 EntrySummary（HTTP 返回；客户端唯一消费形态）

```ts
type Installation = 'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided'

interface EntrySummary {
  name: string                  // npm 包名，如 "@zzerx/dsh-plugin-notes"
  title: { en: string, zh?: string }
  description?: { en?: string, zh?: string }
  category: string              // 分类 id，如 "ui"
  homepage?: string
  repository?: { url: string, directory?: string }
  stars: number | null          // 来自目录元数据；null = 未知
  downloads: number | null
  added: string | null          // "YYYY-MM-DD"
  npm: string | null
  version: string | null        // 默认版本（defaultVersion）
  install: { spec: string, registry?: string, version: string } | null  // 传给 owner install()
  compatible: boolean           // 默认版本对当前 DSH 是否兼容
  installation: Installation
  installedVersion?: string
  repo: { fullName: string, url: string, fork: boolean, source: string | null } | null
  lineage: {
    familyId: string            // "family:<rootKey>"；rootKey = 规范化仓库 owner/name（小写）
    rootRepo: string | null     // 家族根仓库（小写 owner/name）；null = 独立插件
    depth: number               // 到根的层数（根仓库条目=0，fork 仓库条目=1）
    parentName: string | null   // 直接上游条目名（same-repo 兄弟条目与 fork 条目均指向其仓库代表条目）
    relation: 'upstream' | 'fork' | 'same-repo' | null
  }
}

interface FamilyItem {
  kind: 'family'
  id: string
  root: EntrySummary
  entries: EntrySummary[]       // 含 root；按 stars desc, name asc
  externalRoot: { fullName: string, url: string } | null   // 根仓库不在市场中时
  totalStars: number            // 同一仓库的 stars 只计一次（monorepo 条目共享仓库星数）
  totalDownloads: number
  relations: { fork: number, 'same-repo': number }  // entries 内（不含 root 自身）
}
```

`group=0`（逐条模式）时 `items` 为 `EntrySummary[]`（客户端按 `name` 区分：`EntrySummary` 有 `kind` 吗？没有 —— 客户端用 `Array.isArray(item.entries)` 判定 family）。

### 3.3 fork 家族判定规则（只依据仓库事实）

输入：市场条目（`name`、`repository.url`）、目录元数据（`npm`、`url`）、fork 快照。

1. **same-repo**：两个条目解析出的 GitHub 仓库相同（`github.com/<owner>/<name>`，小写比较）→ 同一家族；`rootRepo` 取该仓库。
2. **GitHub fork**：条目仓库 `R` 在快照中 `fork=true` 且有 `source` → 家族根 = `source`。若 `source` 仓库也在市场，其条目的关系为 `upstream`、`R` 的条目为 `fork`，同属一个家族；若 `source` 不在市场，家族仍以 `source` 为根，并输出 `externalRoot={fullName, url}`，`R` 仍为 `fork`。
3. **文本一律不作为家族证据**：描述、README、包名都不参与判定 —— 描述里写着 “Fork of X” 不会让两个仓库合并。
4. 家族根优先级：GitHub source 根 > 共享仓库根。
5. `relation` 只有 `upstream` / `fork` / `same-repo` / `null`；`depth`：根仓库条目为 0，fork 仓库条目为 1；同仓库的兄弟条目 `relation='same-repo'`，`parentName` 指向该仓库的代表条目。
6. 输出确定性：同一输入两次运行结果 JSON 完全一致（排序稳定、无随机）。
7. 性能：4389 条目、~4200 仓库，构建 < 300ms（Node 24，无外部依赖）。

### 3.4 搜索（host/search.mjs）

- 与官方 Discover 语义对齐的简化版：对 `name/title.en/title.zh/description.en/description.zh/category 标题` 建索引；NFKC + 小写。
- 切词：字母/数字/标记连续段；CJK（中日韩）连续段拆成重叠二元组 + 末尾单字。
- 每次查询：查询词全部匹配才算命中；词对索引词的前缀匹配，或（查询词长度 ≥4）编辑距离 ≤ max(1, round(len/5))。
- 打分：name/title 命中权重 3，category 2，description 1；总分为命中权重之和；排序稳定。
- 导出（冻结）：
  ```js
  export function segment(text)          // string[] — 测试用
  export function buildIndex(entries)    // opaque index
  export function matchText(index, text) // Map<entryIndex, score>；text 无字母数字 → 全部条目 score 0
  ```
  `entries` 为 `{ name, title, description, categoryTitle }[]`（已由 Lead 归一化）。
- 无依赖，Node 20+。

## 4. Host HTTP 路由（冻结，前缀 `/dsh-market-insight/api`）

所有响应 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；成功 `{"ok":true,"value":...}`，失败 `{"ok":false,"error":{"code":string,"message":string}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 数据管线状态（见下） |
| GET | `/search?q=&category=&sort=&group=&offset=&limit=` | 搜索/分页 |
| GET | `/entry?name=<npm name>` | 单条详情 + 家族树 + 版本列表 |
| POST | `/refresh` | 重新拉取目录/市场/安装状态；需要请求头 `x-market-insight: 1` |

安全：GET 只读、不设置 `Access-Control-Allow-Origin`；POST 必须带 `x-market-insight: 1`（浏览器跨站请求无法伪造该头，避免 CSRF）。

### 4.1 GET /status

```json
{ "ok": true, "value": {
  "state": "loading|empty|ready|error",
  "source": { "url": "...", "title": { "en": "...", "zh": "..." } } | null,
  "catalog": { "updated": "2026-11-02", "count": 8489, "fetchedAt": "ISO", "ageHours": 1.2 } | null,
  "forks": { "generatedAt": "ISO", "repositories": 4202, "forks": 39 } | null,
  "totals": { "plugins": 4389, "families": 3800, "grouped": 589 },
  "refreshing": false,
  "error": { "code": "catalog-fetch-failed", "message": "..." }
}}
```
`state=loading` 表示首次加载尚未就绪；`empty` = 未配置市场索引源。

### 4.2 GET /search

查询参数：`q` 字符串（缺省空）、`category`（缺省无）、`sort` ∈ `stars|downloads|added|name|index`（缺省 `stars`）、`group` ∈ `1|0`（缺省 1）、`offset` ≥0（缺省 0）、`limit` 1..100（缺省 50）。

```json
{ "ok": true, "value": {
  "query": { "q": "", "category": null, "sort": "stars", "group": true, "offset": 0, "limit": 50 },
  "total": 3800,                 // 当前模式下的结果条数（group=1 为家族数，group=0 为条目数）
  "matched": 4389,               // 命中条目总数（未分组）
  "categories": [ { "id": "ui", "title": { "en": "UI Enhancements", "zh": "UI 增强" } } ],
  "items": [ FamilyItem | EntrySummary ],
  "nextOffset": 50,              // 无更多则为 null
  "generatedAt": "ISO"
}}
```

### 4.3 GET /entry?name=

```json
{ "ok": true, "value": {
  "entry": EntrySummary,
  "family": {
    "id": "family:owner/repo",
    "externalRoot": { "fullName": "upstream/repo", "url": "https://github.com/upstream/repo" } | null,
    "root": EntrySummary,
    "entries": [ { "...": "EntrySummary", "isRoot": true, "relation": "upstream" } ],
    "totalStars": 1234,
    "totalDownloads": 5678
  },
  "versions": [ { "version": "1.2.3", "install": { "spec": "name@1.2.3", "registry": null }, "compatible": true } ]
}}
```
未命中 → HTTP 404 + `{ok:false,error:{code:"entry-not-found"}}`。

## 5. Client（`client.js`，client-ui 实现）

### 5.1 模块骨架（必须照做）

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-market-insight',
  factory(require) {
    const React = require('react');
    // ... controller + components ...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'market-insight: dict-en');
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'market-insight: dict-zh');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'insight',
          order: 20,
          label: () => t('tab.title'),
          locale: NS,
        }, InsightTab));
      },
    };
  },
});
```
- `NS = 'marketInsight'`；字典 key 见 §5.4。`label` 用 thunk，切换语言即时生效。
- 组件 props：`{ install, openPackage }`（来自 `plugins.tab` owner）；`install({ spec, registry?, title, version })`。
- 数据只用 `fetch('/dsh-market-insight/api/...')`（POST 带 `x-market-insight: 1`），不要 import 任何 Harness Client 包（禁止 `@deepseek-ai/dsh-client-ui-primitives` 等）。

### 5.2 界面规格（Insight 标签页内容）

自顶向下：

1. **工具栏**（sticky，`--dsw-alias-bg-base` 背景）：
   - 左：标题（`t('header.title')`）+ 小字来源/更新时间。
   - 搜索框：占位 `t('search.placeholder')`，250ms debounce，有值显示清空按钮。
   - 排序下拉（`t('sort.label')`）：`stars`(默认)/`downloads`/`added`/`name`/`index`，文案见字典。
   - **合并同源开关**（`t('group.label')`，默认开，`role="switch"`+`aria-checked`），开启时右侧显示合并后条数。
   - 刷新按钮（`t('refresh')`，POST /refresh，请求中旋转/禁用）。
2. **分类 pills**：`全部` + 23 个分类（本地化标题），横向可滚动，点击过滤，选中态用 brand 色。
3. **状态行**：`t('stats', {plugins, families, repositories, updated, forks})` 之类；加载中显示骨架屏；错误显示 `t('error.load')` + 重试按钮。
4. **结果列表**（分组模式默认开）：
   - **FamilyItem 卡片**：左图标位（无图标时用分类首字母圆形色块，颜色用 brand 色混合 token），标题（当前语言）、`★ 1.2k` 星标徽章、`⤓ 8.8k` 下载徽章、分类 chip、`v1.2.3`、安装状态/按钮、GitHub 链接。
   - 家族成员数 >1 时显示可点击的 `t('family.count', {n})`（如「同源 3」）+ 展开箭头；展开后渲染 **缩进树**：根节点 + 子节点，用 CSS 连接线（`border-left` + 圆角横线），节点行显示关系标签（上游 / fork / 同仓库）、标题、`★`、安装按钮/small；点击节点行进入详情。
   - 家族合计：`t('family.total', {stars, downloads})`。
   - 单条（无同源）不显示展开区。
   - `逐条模式`（group=0）时每个条目一张卡。
5. **加载更多**按钮（有 `nextOffset` 时显示），加载中禁用。
6. **详情视图**（点击条目/卡片标题进入，用组件内 state 切换，返回时保留搜索/过滤/展开状态）：
   - 返回链接 `t('detail.back')`；大标题 + 星标/下载徽章 + 分类 + `t('detail.added')` 日期 + GitHub/npm 链接。
   - 完整描述（当前语言，缺省回退另一语言；保留换行）。
   - 主按钮：可安装 → `install` 按钮（文案 `t('install')`；调用 owner props，传 `entry.install`）+ 兼容性提示；已安装 → `t('installed')`（调 `openPackage(entry.name)`）；`update-available` → `t('update')` 徽章仍可安装；`provided` → `t('provided')` 禁用。
   - **Fork 树区块**（`t('detail.forkTree')`）：以树/链条形式展示 `family.root → ... → entry`，外部根显示 `externalRoot.fullName` 并链到 GitHub；根节点标 `t('relation.upstream')`；每个节点可点击切换详情。无同源时显示 `t('detail.standalone')`。
   - 版本：显示默认版本 `entry.version` 与来源（npm 包名 / 仓库 + 目录），`t('detail.versionsCount', {n})` 仅作提示，不做全量列表。
7. **空/异常**：无索引源 → `t('empty.noSource')` + 提示去 Discover 配置；请求失败 → 错误行 + 重试。

交互细节：
- 请求竞态用 AbortController + 序号保护；切换 tab/详情不重复请求；`useEffect` 清理。
- 组件卸载时清定时器/abort；不写 DOM、不读别人的 DOM。
- 数字格式化：≥10000 → `12.3k`，≥1000000 → `1.2M`；日期 `YYYY-MM-DD`。
- 所有颜色只用主题 token（`--dsw-alias-*`，见下）；圆角/间距与插件页现有风格一致（8px 圆角、卡片 1px `--dsw-alias-border-l1`、hover 用 `--dsw-alias-bg-layer-2`）。
- 必须处理亮/暗主题（只用 token 即自动）；文本 `--dsw-alias-label-primary/secondary`。
- 文案禁止硬编码中文/英文到 JSX；全部走字典。

### 5.3 主题 token（唯一允许的样式变量）

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-state-error-primary`, `--dsw-alias-state-idle-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`, `--dsw-specific-sidebar-fill`。
星标徽章可用 `--dsw-alias-state-warn-primary` 作强调色。

### 5.4 文案字典（key 冻结；EN/ZH 都要）

| key | en | zh |
|---|---|---|
| `tab.title` | Insight | 洞察 |
| `header.title` | Plugin Insight | 插件洞察 |
| `header.subtitle` | Stars, downloads and fork families from the market catalog | 市场目录中的星标、下载量与 fork 家族 |
| `search.placeholder` | Search plugins, authors, keywords… | 搜索插件、作者、关键词… |
| `sort.label` | Sort | 排序 |
| `sort.stars` | Most starred | 星标最多 |
| `sort.downloads` | Most downloaded | 下载最多 |
| `sort.added` | Recently added | 最新收录 |
| `sort.name` | Name | 名称 |
| `sort.index` | Market order | 市场顺序 |
| `group.label` | Merge fork families | 合并 fork 家族 |
| `group.hint` | Group plugins from the same fork tree or repository into one row | 把同一 fork 树或同一仓库的插件合并为一条 |
| `refresh` | Refresh | 刷新 |
| `category.all` | All | 全部 |
| `stats` | {plugins} plugins · {families} families · {repositories} repositories | {plugins} 个插件 · {families} 个家族 · {repositories} 个仓库 |
| `stats.updated` | Catalog {updated} · Fork data {forks} | 目录 {updated} · Fork 数据 {forks} |
| `install` | Install | 安装 |
| `installed` | Installed | 已安装 |
| `update` | Update available | 可更新 |
| `provided` | Provided by DSH | DSH 内置 |
| `loading` | Loading… | 加载中… |
| `loadMore` | Show more | 加载更多 |
| `retry` | Retry | 重试 |
| `error.load` | Could not load insights | 无法加载洞察数据 |
| `empty.noSource` | No plugin market index configured. Open Discover to add one. | 尚未配置插件市场索引。请到 Discover 添加。 |
| `empty.noMatch` | No plugins match the current filters | 没有匹配当前筛选条件的插件 |
| `family.count` | {n} related | 同源 {n} |
| `family.total` | ★ {stars} · ⤓ {downloads} total | ★ {stars} · ⤓ {downloads} 合计 |
| `relation.upstream` | Upstream | 上游 |
| `relation.fork` | Fork | fork |
| `relation.same-repo` | Same repo | 同仓库 |
| `detail.back` | Back to list | 返回列表 |
| `detail.forkTree` | Fork tree | Fork 树 |
| `detail.standalone` | No known fork family; this plugin stands alone | 没有已知 fork 家族，独立插件 |
| `detail.added` | Added {date} | 收录于 {date} |
| `detail.versionsCount` | {n} versions on the market | 市场共 {n} 个版本 |
| `detail.repo` | Repository | 仓库 |
| `detail.npm` | npm | npm |
| `detail.installHint` | Installs through the Plugins dialog | 通过插件安装对话框安装 |
| `detail.notCompatible` | This version is not compatible with the running DSH | 该版本与当前 DSH 不兼容 |
| `detail.downloads` | Downloads (30d) | 下载量（30 天） |
| `stars.unknown` | Stars unknown | 星标未知 |
| `detail.externalRoot` | Upstream repository (not in market) | 上游仓库（未收录） |

## 6. 验收标准

- `node --check` 通过 host 与 client 文件语法；`node test/*.mjs` 全绿。
- 安装后（Lead 负责）：`plugins.tab` 的 occupant 出现 `id: insight`；`GET /dsh-market-insight/api/status` 返回 `state: ready`；`/search` 返回 4389 条数据（合并后 total ≈ 4.1k–4.2k），每条 EntrySummary 有 `stars`；`group=1` 时包含至少一个 `entries.length>1` 的家族（如 `0x7a7a6572/dsh-forge-studio` 的 4 个插件）；GitHub fork 家族与 `externalRoot` 家族都应出现；`/entry` 返回家族树。
- 客户端：无 slot entry crash；只使用列出的 token；无 Harness Client 包 import；亮/暗主题皆可读（用户视觉确认，Lead 报告验证范围）。
