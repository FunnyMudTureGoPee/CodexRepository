# 插件洞察 / Plugin Insight

给 DeepSeek Harness Web 的 **Plugins（插件）** 页面新增一个 **洞察 / Insight** 标签：

- 搜索界面里每个插件直接显示 **GitHub Star 数**（★）与 **近 30 天下载量**（⤓）；
- 按 **fork 家族 / 同源关系** 聚合插件，默认合并成一条，可展开为可点击的 **fork 树**；
- 可按星标、下载量、收录时间、名称、市场顺序排序，按 23 个分类过滤；
- 安装仍然走 DSH 自带的插件安装对话框（复用 Plugins 页 owner 的 install / openPackage 能力）。

## 功能

### 星标与热度

Star 数与下载量来自社区维护的 **awesome-dsh-plugin 目录**（`dsh-plugin-catalog` npm 包里的 `plugins.json`，约 8,500 条记录）。加载时按 npm 包名与当前配置的插件市场索引精确 join（实测 4,389 / 4,389 全部命中），因此不需要逐个仓库调用 GitHub API，也不会因为 GitHub 限流而空白。

### fork 家族（同源聚合）

家族关系**只依据可核实的仓库事实**，不读取描述/README/包名：

| 关系 | 含义 | 来源 |
|---|---|---|
| `same-repo` | 同一 GitHub 仓库发布的多个包（monorepo） | 市场索引里的 repository URL |
| `fork` | GitHub fork，家族根为 fork 网络的上游仓库 | ecosyste.ms 公共仓库元数据（随包快照 + 运行时增量补查） |

> 说明：早期版本曾尝试从 README 里的 “Fork of X / 基于 X” 等文字推断派生关系，这类证据不可靠，已移除。现在如果两个插件只是描述上自称 fork、但其 GitHub 仓库既不同源也不是 fork，它们**不会**被合并。

- 默认把同源插件聚合为一条卡片，卡片上给出家族合计（同一仓库的 star 只计一次，避免 monorepo 重复累加）；
- 展开后是缩进 fork 树：上游在根部，子节点带关系标签（上游 / fork / 同仓库），每个节点可点进详情；
- 关闭工具栏的 **合并 fork 家族** 开关即回到逐条列表；
- 详情页的 **Fork 树** 区块展示当前插件在家族中的位置；上游仓库不在市场时给出外链节点（externalRoot）。

当前随包快照（2026-11-04 生成，覆盖 4,202 个仓库、39 个 GitHub fork）下：4,389 条市场索引入口 → 4,187 个家族。其中 202 个条目因同仓库/同 fork 家族被折叠（同仓库 187；fork 条目 39，其中 15 个与市场内上游同家族、24 个挂到市场外的上游仓库并单独成家族）。市场索引与目录会随源更新，实际数字以页面为准。

### 数据来源与缓存

| 数据 | 来源 | 缓存 |
|---|---|---|
| 市场条目 | Host `pluginMarket` 服务（用户自己配置的索引） | `$DSH_HOME/market-insight/market-<hash>.json`，TTL 1h |
| Star / 下载量 | `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json` | `$DSH_HOME/market-insight/catalog.json`，TTL 12h |
| fork 关系 | 随包 `data/forks.json` 快照（约 4,200 个仓库，构建于 2026-11-04） | 运行时增量写入 `$DSH_HOME/market-insight/forks-cache.json` |

- 随包快照让首屏无需等待逐仓库探测；快照之后新上架的插件在打开对应列表页时按需、限流补查（每批最多 40 个仓库，并发 3）。
- 只有读取：GET 接口只返回市场与目录的公开数据，不写任何用户文件；刷新接口需要自定义请求头，浏览器跨站请求无法触发。
- 缓存目录可用 `DSH_MARKET_INSIGHT_CACHE` 覆盖；离线/测试可用 `DSH_MARKET_INSIGHT_NO_ENRICH=1` 关闭 fork 增量补查。

## 安装 / 卸载

这是一个 DSH bundle（本地目录包），安装后 Host 与浏览器两半都会通过 profile 的 HMR 生效：

```powershell
# 通过插件管理器（Web 的 Plugins 页或 agent 的 plugin_manager 工具）安装本目录：
#   D:\DSH\WorkShop\dsh-market-insight
# 安装后打开 Plugins → 洞察
```

注意：本地目录安装会以 `link:` 方式链接到本工作区目录，因此**移动或删除本目录会让插件失效**；要长期使用可把目录移到固定位置后重新安装。
卸载：在 Plugins 页移除该 bundle 即可；`$DSH_HOME/market-insight` 缓存可手动删除。

## 目录

```
index.js               Host 半入口：注册 /dsh-market-insight/api 路由，等待服务后启动数据管线
host/
  store.mjs            模型：join 星标、构建家族、搜索索引、状态/搜索/详情查询
  lineage.mjs          纯函数：same-repo + GitHub fork 家族图（并查集；不读文本）
  search.mjs           纯函数：双语/CJK 分词、前缀 + 编辑距离匹配、字段加权
  catalog.mjs          目录 JSON 的抓取、裁剪与缓存
  market.mjs           经 pluginMarket 服务分页读取整个市场索引并缓存
  forks.mjs            fork 快照/运行时缓存的合并与有界增量补查
  cache.mjs / repo.mjs / api.mjs
client.js              浏览器半：Plugins 页「洞察」标签（React，只用主题 token 与 i18n 字典）
data/forks.json        随包 fork 快照（tools/collect-forks.mjs 生成）
tools/collect-forks.mjs  快照重建脚本（node tools/collect-forks.mjs）
tools/stats.mjs          家族/星标统计（node tools/stats.mjs）
test/                  纯函数与 store 的单测（node test/xxx.test.mjs）
```

## 已知限制

- Star/下载量来自社区目录的更新节奏（目录本身每天生成），不是实时 GitHub 数值；
- GitHub fork 关系依赖 ecosyste.ms 的公开仓库索引：约 5% 的小仓库暂未被其收录，这些仓库只会按“同仓库”或独立插件处理；
- 只有仓库级证据：描述里自称的 “fork/移植” 不会被采信，因此生态里大量换 scope 的软 fork 不会合并；
- 插件图标暂用分类首字母色块（市场索引里的图标是远程 URL，本插件不额外加载第三方图片）。
