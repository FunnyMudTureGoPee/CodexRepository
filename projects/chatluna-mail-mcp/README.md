# ChatLuna Mail MCP 0.7.1

首次安装请看 [快速开始](QUICKSTART.md)。推荐在 [GitHub Release](https://github.com/FunnyMudTureGoPee/CodexRepository/releases/tag/chatluna-mail-mcp-v0.7.1) 下载脚本包，解压后按文档安装。

本地 Koishi 插件。通过 MCP 提供图文邮件服务；每日读取管理员指定的 ChatLuna 预设和会话上下文，由一个可选模型判断当前是否应发送，并生成邮件。没有多模型审核、投票或收件箱功能。


## 0.7.0 受控工具工作流

新增可选工具执行模式：任务可在管理员授权下调用搜索、歌曲库等 ChatLuna 工具，再把结果写成图文邮件；MediaLuna 已完成的绘图可直接导入为邮件素材，不再需要手工导入。
默认仍是只读上下文模式，旧任务无需迁移。工具白名单、执行身份、预算、撤权、并发锁和超时边界见 [upgrade-0.7.0.md](docs/upgrade-0.7.0.md)。

## 0.6.3 Gemini 兼容修复

修复 runAt 参数声明导出空字符串枚举，导致 Gemini 拒绝整个工具请求的问题。服务端日期校验与旧任务兼容不变。升级后需重连邮件 MCP，见 [upgrade-0.6.3.md](docs/upgrade-0.6.3.md)。

## 0.6.2 上下文与预览修复

修复 ChatLuna 将正文存入 gzip content 时被误判为空的问题；支持旧 text 和压缩多模态文字，提供具体诊断错误码。邮件预览仅在模板页签显示。
根因、实际数据验证与升级方法见 [upgrade-0.6.2.md](docs/upgrade-0.6.2.md)。

## 0.6.1 管理页优化

修复长页面滚动，增加吸顶导航和表单定位；采用主题自适应卡片、响应式布局和信封图标。安装后重启插件并刷新 Console。详见 [upgrade-0.6.1.md](docs/upgrade-0.6.1.md)。

## V0.6 / 0.6.0

新增模型目录和邮件默认模型设置、简化分组任务表单、日期时间下拉框、变量卡片与一键插入；MCP 允许授权 Agent 自主创建及修改任务、模板。工具共 13 个；开启插件配置 allowAgentManage 后使用管理接口。
升级与功能边界见 [upgrade-0.6.0.md](docs/upgrade-0.6.0.md)。供应商/API Key 继续在 ChatLuna 适配器配置，判断仍只调用单个模型。

## V0.5 / 0.5.0

增加受控重试队列、部分失败收件人重试、上下文诊断/新增消息模式、时效与预算控制、历史筛选分页、保留期清理预览及图片回收恢复。
自动重试和自动清理默认关闭。判断使用一个 ChatLuna 模型，重试复用原邮件内容而不再次调用模型。
详细配置、升级和不可逆清理边界见 [upgrade-0.5.0.md](docs/upgrade-0.5.0.md)。新增只读 MCP 工具 get_mail_task_diagnostics，工具总数为 9。
## 管理页

启用 Koishi Console 后，管理员可在左侧「邮件任务」编辑每日/每周/单次任务、查看下次执行、试判断、预览草稿、显式发送和查看记录。
「模板」支持自定义提示词、变量、页脚和排版；模板更新产生新版本，旧草稿保留原版。
详细升级步骤见 [upgrade-0.2.0.md](docs/upgrade-0.2.0.md)。MCP 地址和已有连接配置继续有效。
安装脚本已支持 Koishi 自带 koishi.exe，无须把 Node 加入 PATH；在 dist 下运行 ../scripts/install.ps1 即可。
## 当前交付与边界

- 复用 Koishi HTTP 服务与数据库。SMTP 连接已有邮箱或邮件中继，不托管公网邮箱。
- MCP 图文草稿、预览、显式发送、状态查询、模板提示词、图片目录、任务查询、手动试判断。
- 每日、每周、单次计划 + IANA 时区；持久化任务、执行记录、幂等投递、停用和冷却。
- 每个任务可以跟随指定会话的预设和模型，或分别覆盖。一次判断只调用一个模型。
- 预设使用主插件 `preset.getPreset` 与 `promptRenderer.renderPresetTemplate`；历史使用主插件会话服务并按 latestMessageId 回溯当前分支，包含配置范围内的文本消息及已存压缩摘要。
- **默认只读上下文；仅在任务选择工具模式、管理员开启工作流并授权工具时，才通过 ChatLuna Agent 调用白名单内的读取类工具。** 不自动运行其他插件的 RAG、长期记忆检索或完整聊天中间件；非文本消息不进行视觉识别。工具模式仍由一个模型编排，发信统一经过收件人白名单和幂等检查。
- MediaLuna 图片只从成功任务、指定用户、本地 PNG/JPEG 缓存导入；不接受任意 URL 或文件路径。未安装 MediaLuna 时该能力不可用，普通邮件与上下文模式不受影响。
- 会话缺失、分支损坏、无可读文本或超出预算时停止，不伪造上下文。
- 预设需要用户名等变量时，在任务 variables 中显式配置；日期和会话 ID 由插件注入。定时调用没有实时 Koishi 用户消息/session。
- 决策不写回正常聊天历史。任务绑定指定会话；开启 allowAgentManage 后，持令牌 Agent 可选取活跃会话并保存任务。单次判断仍不接受临时改换会话。
- 本地单实例使用；不支持集群、多租户隔离、收信、任意远程图片抓取和自动重试未知投递。自动配图仅限管理员允许的 MediaLuna 渠道，不提供通用绘图能力。
- 当前内置三种写作提示词，共用可靠 HTML 布局。自定义任务 prompt 可以控制内容与语气；可在 Console「邮件任务 → 模板」创建版本化自定义提示词及安全排版。

## 安装

要求 Node >=20、Koishi 4.18、server 和 database 服务。上下文适配以本机安装的 ChatLuna **1.4.0-alpha.44** 源码核实；其他 1.4 版本需实机联调，不能仅凭版本号保证兼容。

安装包位于 dist/koishi-plugin-chatluna-mail-mcp-0.7.1.tgz。首次安装或手动安装时，在 PowerShell 中运行：

```powershell
./scripts/install.ps1 -KoishiDir '你的 Koishi 实例目录'
```

已安装旧版时，可运行自动升级脚本（会校验 SHA256、备份实例配置、自动识别 Yarn/pnpm/npm 并核对安装版本）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1
```

先退出 Koishi Desktop 再升级；非默认实例用 `-KoishiDir '实例目录'` 指定。`-DryRun` 只检查安装包、实例和将执行的命令，不修改文件。

脚本安装包但不修改 koishi.yml、不启用插件、不配置账号。也可以在 Koishi 实例目录用其现有包管理器安装 tgz。

开启插件前先配置一个随机的至少 24 字符 token。token 只使用 24-256 个无空格可打印 ASCII 字符，不要保留中文占位符。token 是本地 MCP 的共享访问凭据，共用它的 Agent 共享本插件数据与权限。不要公开到其他群聊或不可信 Agent。

初次保持 `enabled=false` 和 `allowAgentSend=false`。这时可以使用模板、草稿与手动模型试判断，不会自动发信。

## Koishi 配置字段

| 字段 | 含义 |
|---|---|
| endpoint | 默认 /mcp/mail |
| token | 必填 Bearer Token，至少 24 字符 |
| enabled | 真实发信及每日自动任务总开关，默认关闭 |
| allowAgentSend | MCP 主动发送开关，默认关闭；管理员显式发送不受此开关影响 |
| smtpHost / smtpPort | SMTP 地址、端口 |
| smtpSecure | true 使用隐式 TLS（通常 465）；false 强制 STARTTLS（通常 587） |
| smtpUser / smtpPassword | SMTP 用户及授权码/密码，在 Koishi 密钥字段填写 |
| from | 服务商允许的发件邮箱，当前只接受纯地址 |
| allowedRecipients | 精确收件人白名单，最多单封 10 人 |
| maxPerDay | UTC 日投递尝试上限，默认 10，失败也计数 |
| modelTimeoutMs | 模型调用超时，默认 120 秒，上限 300 秒 |
| maxContextChars | 预设、历史及提示词总字符预算，默认 64000，上限 200000；不是 Token 数 |

不会为测试降低生产 SMTP 的 TLS 要求。不在本插件重复配置模型 API Key，复用 ChatLuna 平台配置。

## 连接 ChatLuna MCP

在 Agent 的 MCP 配置中选择 HTTP：
- URL：`http://127.0.0.1:5140/mcp/mail`（5140 按实际 Koishi HTTP 端口调整）
- HTTP Header：`Authorization: Bearer <你的 token>`
- 仅限同机访问。拒绝携带浏览器 Origin 的请求。
- GET SSE 返回 405；POST 与 DELETE 正常。没有后台通知长连接。

可用工具（14 个）：
- 邮件：`list_mail_templates`、`list_mail_assets`、`create_mail_draft`、`preview_mail_draft`、`send_mail_draft`、`get_mail_delivery_status`
- 任务：`list_mail_tasks`、`evaluate_mail_task`、`get_mail_task_diagnostics`
- 管理（需 allowAgentManage）：`get_mail_configuration`、`get_mail_task`、`save_mail_task`、`save_mail_template`
- 图片交接：`import_mail_image`

另提供 MCP Prompt `compose_mail`。

Agent 建议提示词：
> 需要邮件时先读取模板和可用图片。只使用授权收件人，生成结构化草稿并预览。得到发送授权后调用 send_mail_draft，重试同一次发送必须复用相同 idempotencyKey。evaluate_mail_task 只是试判断，绝不会自动发送。需要 MediaLuna 配图时，先完成绘图，再用 import_mail_image 取得 assetId。

草稿参数示例：

```json
{
  "to": ["your-test@example.com"],
  "subject": "今日提醒",
  "paragraphs": ["第一段正文", "第二段正文"],
  "images": [],
  "templateId": "briefing"
}
```

发送参数：`{"draftId":"创建草稿返回的UUID","idempotencyKey":"unique-request-001"}`。
草稿不可变；需要修改时重新创建。幂等标识相同、内容不同会被拒绝。

## 图片

管理员执行 `mail.asset-import D:/path/photo.png`，获得 assetId。Agent 只能引用此 ID，不能读取本地路径或请求任意 URL。
只接受 PNG/JPEG，单张 <=5 MiB、每封最多 5 张、总图片 <=10 MiB。发送前加载为 Buffer，通过 CID 内嵌；同时提供纯文本正文。
图片存于 Koishi 实例的 data/chatluna-mail/assets。图片签名校验不是专业图片安全扫描。

## 工具工作流

任务「执行方式」选择「工具工作流」后，由一个 ChatLuna 模型在受限预算内调用管理员授权的读取类工具，再用同一模型输出邮件 JSON。定时任务与「试运行工具」走同一条路径；试运行只生成草稿，不发信。

启用前在「工作流」页配置在线机器人、执行用户、工具白名单、预算和 MediaLuna 渠道。名称含邮件、发送、写入、删除、调度、委派等含义的工具不会进入白名单；每次工具调用都会重检 ChatLuna 工具掩码与工具授权。执行中途修改设置、停用任务或暂停插件会阻止后续步骤。

默认失败即停止；任务可改为「跳过失败资料/配图继续」，但超时、授权、步数/调用/入参超限、撤权和策略变更始终终止。工作流锁防止同一任务并发；超时不会取消已提交的外部绘图，重启后需在「工作流」页人工核对并释放。

完整配置、预算、错误码与限制见 [upgrade-0.7.0.md](docs/upgrade-0.7.0.md)。

## MediaLuna 图片

除管理员导入外，0.7.0 支持把 MediaLuna 成功任务的结果登记为邮件素材：
- MCP `import_mail_image`：主 Agent 传入 MediaLuna 任务 ID 和图片序号（0–4），返回 assetId。
- 任务「允许自动配图」：每次执行最多提交一次绘图请求，完成后自动导入并返回 assetId。

只接受指定用户、成功状态、`kind=image`、`medialuna_asset_cache` 中登记为 local 后端、不超过 5 MiB 的 PNG/JPEG；不接受任意 URL 或路径。绘图提示词由模型根据当天邮件内容自动生成（最长 4000 字符），管理员只限定可用渠道。导入素材默认不固定；需要长期保留时在「运行维护」中固定。未安装或未启用 MediaLuna 时，这两项能力不可用。

## 每日任务

复制 examples/daily-task.json，填写指定会话 ID、收件人和判断 prompt。任务默认禁用。
- preset/model 留空：每次运行跟随指定会话当前值。
- model 填 ChatLuna 的完整 `platform/model` 名称：只改变本任务判断模型。
- historyLimit 默认 60（上限 200）：当前分支最近文本消息数量上限；超出 maxContextChars 时仍会拒绝或按任务策略裁剪。
- cooldownMinutes 默认 60；本地同一天最多执行一次。每日任务不建议配置 1440 分钟，以免秒级延迟导致次日触发仍在冷却。
- variables 提供预设所需的业务变量，不含密钥。
- executionMode=tools 时，tools 只能从工作流白名单选择；workflowImages 每次最多一次绘图请求；toolFailurePolicy 默认 stop。
- 每小时最多 60 次判断尝试（手动和定时共用），防止无限消耗模型调用。

管理员命令（authority >=4）：

```text
mail.task-import D:/path/daily-task.json
mail.evaluate daily-reminder
mail.runs
mail.preview <draftId>
mail.enable daily-reminder
mail.disable daily-reminder
mail.status
mail.tasks
mail.assets
mail.send <draftId> <uniqueKey>
mail.delivery <deliveryId>
mail.pause
```

`mail.evaluate` / MCP `evaluate_mail_task` 调用模型并可能生成草稿，但永远不发送。
每日调度只有在任务 enabled 和插件 enabled 均为 true 时才执行。按当前分钟每 15 秒扫描；错过的分钟不补发。停机期间不执行，重启恢复数据库任务。DST 同一天重复时刻只执行一次。执行中的任务修改或停用会在投递前再次检查。
`mail.pause` 立即暂停当前插件实例；长期暂停应关闭配置 enabled，避免重启恢复。

模型输出结构：
```json
{"shouldSend":false,"reason":"当前无值得主动通知的新事项"}
```
需要发送时增加 mail（subject、paragraphs、images），不含 to；收件人始终来自管理员任务配置。

## 状态与限制

accepted 表示 SMTP 接受提交，不证明最终送达或已读。partial 表示部分收件人被接受；unknown 表示提交结果不确定，默认绝不自动重发。断电后未完成的发送恢复为 unknown，未完成的判断标记 interrupted。
0.5.0 提供管理员受控重试和任务显式开启的自动重试；请使用重试队列，不要随意更换请求标识。结果未知不重试。
邮件记录、草稿、上下文摘要引用和图片会保留在本机。可通过预览和确认按保留期清理；自动清理默认关闭。幂等标识与最小元数据长期保留，图片回收区不会立即释放磁盘空间。数据库当前按 kind 读取记录，适合个人低频使用，不面向海量群发。

## 开发与验收

```powershell
pnpm install --ignore-scripts
pnpm check
./scripts/build.ps1
```

本地验收使用独立 Koishi 内存数据库、真实 HTTP MCP 客户端和本地 SMTP 接收器，不连接外部邮箱或真实模型。
`scripts/preview-console.cjs` 提供隔离控制台夹具（模拟 ChatLuna/MediaLuna、禁用发信），用于检查界面与事件处理。
新增命令：mail.templates、mail.template-import、mail.task-archive。每周/单次/工具任务示例见 examples。
0.7.0 共 60 项测试；详见 [acceptance-0.7.0.md](docs/acceptance-0.7.0.md)、[upgrade-0.7.0.md](docs/upgrade-0.7.0.md) 与 [iterations.md](docs/iterations.md)。源码核实、模拟模型测试、外部真实模型联调是不同证据等级。

API 参考：https://chatluna.chat/development/api-reference/chatluna-service.html


## 0.7.1 工单修复

修复在线枚举、图片归属类型及 ID 0；自动配图支持可选 presetName。MCP 使用无状态 HTTP 避免空闲会话过期；升级后在 ChatLuna 手动重连一次。升级脚本会备份旧 lib 及 bak 文件。详见 [升级与验收说明](docs/upgrade-0.7.1.md)。


## 下载 0.7.1

- [插件安装包](dist/koishi-plugin-chatluna-mail-mcp-0.7.1.tgz)
- [便携升级包](dist/mail-mcp-0.7.1-upgrade.zip)
- [升级说明与工单验收](docs/upgrade-0.7.1.md)

本目录是独立 Node/Koishi 项目，构建命令均在本目录执行。需要开发时使用 Node >=20、pnpm 安装依赖，再运行 `pnpm check`。ChatLuna 是运行环境提供的可选 peer dependency；运行涉及 ChatLuna 的测试前需在本地安装满足 package.json 范围的 ChatLuna。安装包直接部署至 Koishi 实例，无需从源码构建。
