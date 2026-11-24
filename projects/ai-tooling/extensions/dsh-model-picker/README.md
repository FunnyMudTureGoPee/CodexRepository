# 模型选择器 / Model Picker

给 DeepSeek Harness Web 的 **输入框右侧模型席位** 换成一个按 **渠道 → 类型 → 型号 → 档位** 分级的
选择器，替代原先「一个扁平列表 + 每个模型再重复 6 个 `:effort` 条目」的展示方式。

## 为什么

`wb-cli` 渠道在配置里把每个模型都镜像成 `model`、`model:minimal` … `model:max` 六条。
实测当前 profile 共 **224 行 = 42 个基础型号 + 182 个 `:effort` 档位镜像**，
原生选择器因此显示 224 行，其中 81% 是同一模型的推理档位；渠道与厂商族全靠滚动寻找。

本插件把这 224 行折回 **42 个真实型号、7 个厂商族**，并把分类做成真正的逐级下钻：

```
渠道 Channel          wb-cli（WorkBuddy反代）· deepseek-official · …
  └ 类型 Family       DeepSeek / GLM / Kimi / MiniMax / 混元 Hunyuan / Claude / 其他
      └ 型号 Model    Deepseek-V4.1-Flash · GLM-5.3 · Kimi-K3 · …
          └ 档位 Effort   minimal / low / medium / high / xhigh / max（或渠道默认）
```

实测分类结果（42 个型号）：

| 类型 | 型号数 | 档位数 |
|---|---|---|
| DeepSeek | 9 | 24 |
| GLM | 11 | 62 |
| Kimi | 7 | 34 |
| MiniMax | 3 | 18 |
| 混元 Hunyuan | 8 | 32 |
| Claude | 2 | 12 |
| 其他 Other | 2 | 0 |

- **渠道**行显示「N 类 · M 个模型」，先选线路再选模型；
- **类型**按 id 前缀归类（`deepseek-*`、`glm-*`、`kimi-*`、`minimax-*`、`hy*`/`hunyuan-*`、`claude-*`），
  `default-1.1/1.2` 这类只在显示名里带 Claude 的条目也归到 Claude；
- **型号**再按能力分小标题（专业 Pro / 快速 Flash / 极速 Turbo / 代码 Code / 多模态 Vision / 推理 Thinking / 预览 Preview / 标准），
  右侧 `6×` 表示该型号有多少档位，带搜索框；
- **档位**是最后一级，选完即提交；只有默认档位的型号会被跳过这一级、直接提交。

打开菜单时若当前模型已知，会**直接落到它所在的型号列表**，不必每次从渠道点起；面包屑可逐级回退（Esc 同级回退）。

> 折叠不丢条目：224 个 id 全部可达（要么是型号行本身，要么是该型号的某个档位），
> 且没有任何 `:effort` 镜像泄漏成独立型号行 —— 这两点都有测试覆盖。

## 安装

本地 bundle，安装后浏览器半即时生效：

```
通过 Web 的 Plugins 页或 plugin_manager 工具安装目录：
  D:\DSH\WorkShop\dsh-model-picker
```

本包声明了 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-model-selection"]`，因此它会在原生
模型选择器**之后**装载并接管 `conversation.input.model` 这个单席位——原生选择器保持完整安装，
卸载本插件即回到原生行为，不需要改 DSH 源码。

> 目录安装以 `link:` 方式链接，移动或删除本目录会让插件失效。

## 数据与提交

**主路径**：复用 `@deepseek-ai/dsh-client-ui-model-selection` 提供的 `ctx.modelDirectories`
服务（原生选择器用的就是它）。它按会话给出 `ModelDirectory`，暴露的 snapshot 形状
（`current / routable / groups / failures / status / error`）正是本插件渲染所需，并且自带
连接重置处理。**这是首选**：只要原生席位可用，它就可用，不需要本插件自己去够 `connection.api`。

| 动作 | 主路径（directory） | 兜底（直连 RPC） |
|---|---|---|
| 读取目录 | `directory.load()` | `session.models` |
| 提交选择 | `directory.select(...)` | `session.selectModel` |

> 早期版本只走直连 RPC，并在 `apply()` 里抢先抓 `connection.api`；连接晚到时拿到 `undefined`，
> 席位已经遮蔽了原生选择器却什么都不渲染 —— 表现就是"模型按钮变成灰色/消失"。
> 现在改为 **directory 优先 + 渲染期惰性解析 + 双路径兜底**。

### 菜单表面必须用不透明 token

菜单底色用 **`--dsw-alias-bg-overlay`**（`rgb()`，不透明），不用 `--dsw-specific-menu`。
后者是 DSH 内部值、不在主题 token 契约里，且实际解析出的表面会让背后的聊天内容透出来
（截图里能看清下面正文），粘性分组标题（Pro / Code / Thinking…）也会出现透条。

| 用途 | token | 是否透明 |
|---|---|---|
| 菜单 / 粘性分组标题 | `--dsw-alias-bg-overlay` | 不透明 ✅ |
| 悬停高亮 | `--dsw-alias-interactive-bg-hover` | `rgba(...,0.06)`，叠在不透明菜单上，无副作用 |
| kind 徽章 | `--dsw-alias-bg-module-platform` | 不透明 |

### 提交档位时的一个协议细节（重要）

目录里同一个型号可能出现两种形态，提交方式**不同**：

| 形态 | 例子 | 提交 |
|---|---|---|
| 档位是独立目录行（有 `:effort` 副本） | `deepseek-v4-pro:high` | 只发 `model`，**不要**再带 `reasoningEffort` |
| 只有基础行，档位来自 `reasoning.efforts` | `kimi-k2.6` + `high` | 发 `model` **并**带 `reasoningEffort` |

原因：带 `:effort` 的副本行自身没有 `reasoning` 元数据，模型 id 已经编码了档位；此时再附带
`reasoningEffort`，等于要求 Host 对一个没声明档位的模型应用档位，会被拒绝——表现就是
"选了没反应、切不过去"。这一点有单测覆盖（`tools/test-directory-mode.mjs` 的
`twin rung omits reasoningEffort` 与 `base-id rung sends reasoningEffort in the field`）。

选择被拒绝时，错误现在会直接显示在菜单顶部（并上报到诊断汇聚点），不会再静默失败。

Host 始终是唯一事实源；失败在菜单顶部给出错误条与「重试」，渠道级失败（`failures`）逐渠道告警但保留可用渠道。

## 自检通道

本插件遮蔽了原生席位，失败时没有原生兜底可看，而浏览器控制台又不在 Host 侧。因此 Host 半提供
一个极小的同源诊断汇聚点（仅保留最后一条、写侧需要自定义请求头）：

```
GET  /dsh-model-picker/api/diag   → { ok, value: { at, report } }
POST /dsh-model-picker/api/diag   → 客户端上报"看到了什么/取不到什么"
```

客户端在**两条路径都不可用**时上报一次（每页一次），因此"灰掉的芯片"背后一定有可查的原因记录。
该路由只在本插件的 Host 半重启后生效；GET 只读、不触碰任何用户数据。

## 目录

```
index.js              Host 半：诊断汇聚点（/dsh-model-picker/api/diag）
client.js             浏览器半：分类逻辑（0. 节）+ 席位 + 三级菜单 + 样式 + 双路径数据层
test/classify.test.mjs  单测：从 client.js 抽取 mp-pure-helpers 片段求值
tools/test-directory-mode.mjs  directory 主路径的端到端校验（无需浏览器）
tools/test-revival.mjs         "新建会话/重启后变灰"的回归测试
tools/repair-encoding.mjs      一次性编码修复脚本（PowerShell 重编码损坏后的恢复用）
locale/*.json         词典副本（运行时词典在 client.js 内注册）
```

## 最关键的坑：cordis 会把服务调用追踪到「调用方上下文」

这是让本插件连续多轮「看起来逻辑没问题却始终不可用」的真正原因，值得单独记一笔：

```
directoryError: cannot get property "remote.session" without inject
```

`modelDirectories.directoryFor(sessionId)` 被我调用时，cordis 会把这次方法调用**绑定到调用方
（本插件）的 ctx**；该方法内部经由会话运行时访问 `remote.session`，而本插件的 ctx 没有注入它，
于是**方法一调就抛**。

原生选择器不受影响，因为它的 inject 面来自框架槽位基础设施，上下文自带这些能力。

**结论**：只要你的代码需要调用别的包的 `Service` 方法，就必须把该方法链路上会触达的
mixin（如 `remote.session`、`remote.commands`）声明进自己的 `inject`——否则调用必然抛错，
而且错误信息只会指向内部属性，不会告诉你"是调用方权限不足"。

```js
inject: ['connection', 'locale', 'modelDirectories', 'remote.commands', 'remote.session', 'slots']
```

## 为什么新建会话 / 重启后会变灰（已修复）

早期版本里灰态席位**没有任何活跃订阅**：它既没有 directory，也没有 connection，两个 store 都是
空订阅。于是切到灰态之后**再也没有东西能触发它重渲染**——哪怕 200ms 后连接就绪、目录作用域就
建好了，它也永远停在灰色。这解释了为什么"本来能用，一新建会话/一重启就灰"。

修复是给灰态席位装一个**复活泵**：

| 机制 | 行为 |
|---|---|
| 快轮询 | 灰态时每 250ms 触发一次重渲染，重新解析传输层 |
| 慢心跳 | 20s 后降为每 3s 一次，保证迟到的重连仍能被接住 |
| 事件唤醒 | `connection/reset` 立即唤醒所有灰态席位 |
| 自愈即停 | 一旦可用，定时器与监听自动清理，不再有任何轮询 |

另外灰态**不再禁用按钮**：可点开、直接显示原因并带「重试」。一个用户点不动的死灰按钮是最糟的
失败形态——既没法用，也没法告诉你为什么。

## 测试

```powershell
$node = "D:\DSH\deepseek-harness-app\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node --test test/classify.test.mjs        # 44 项：分类与折叠
& $node tools/test-directory-mode.mjs        # 8 项：directory 主路径
& $node tools/test-revival.mjs               # 6 项：灰态自愈
```

## 两个曾导致 DSH 打不开的致命错误（已修复）

客户端 bundle 是**自包含**的：`require` 只认模块表里的**平台种子词**（如 `react`）和其他包注册的
graph row，**认不了相对路径文件**。违反下面任一条都会在启动时抛异常，并连带整个 Web 客户端白屏。

| # | 错误写法 | 后果 | 正确写法 |
|---|---|---|---|
| 1 | `require('./classify.mjs')` | `client-modules: require("./classify.mjs") missed the module table` | 分类逻辑**内联**进 `client.js`（0 节，`mp-pure-helpers` 标记之间） |
| 2 | `slots.register({ name: 'conversation.input.model' })`（默认 priority 0） | `single slot "conversation.input.model" already has a registration at priority 0` | 传 **`priority: -1`** 遮蔽原生席位（同优先级才冲突，最低者渲染） |

另外 `apply()` 整体包了 try/catch：插件自身再出问题时只退化成"没有自定义席位"（原生选择器继续工作），
不会再拖垮整个界面的启动。

> 教训：`single` 槽位是**替换**语义而非追加，必须换优先级；而本地文件永远进不了模块表，
> 客户端代码只能单文件自包含。

## 测试

```powershell
$node = "D:\DSH\deepseek-harness-app\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node --test test/classify.test.mjs
```

测试不 import 任何 `.mjs`，而是读取 `client.js`、截取 `// >>> mp-pure-helpers` 到
`// <<< mp-pure-helpers` 之间的片段再求值 —— 因此测的就是**实际发布的那段代码**，不会与被测副本漂移。
