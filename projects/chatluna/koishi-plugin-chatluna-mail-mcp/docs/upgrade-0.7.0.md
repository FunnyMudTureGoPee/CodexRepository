# 0.7.0 受控工具工作流与 MediaLuna 图片交接

0.7.0 把定时任务从「只读会话上下文，一次模型调用」扩展为可选的「工具工作流」：同一个 ChatLuna 模型可以先调用管理员授权的搜索、歌曲库等工具，再把结果写成图文邮件。主 Agent 或定时任务还可以把 MediaLuna 已完成的绘图直接登记为邮件素材，不再需要管理员手工导入。

这一版不是通用工作流平台：没有可视化编排、并行分支、跨重启恢复整条工具链，也没有放开任意 URL 下载。发信仍只经过邮件插件现有的收件人白名单、幂等和投递检查。

## 启用前的边界

| 项目 | 0.7.0 行为 |
|---|---|
| 默认执行方式 | `context`，与 0.6.x 完全一致；旧任务不需要迁移 |
| 工具模式 | 只有任务显式选择 `tools`，且工作流总开关、工具白名单、执行身份都有效时才运行 |
| 每个任务的模型 | 仍只有一个模型负责编排和最终判断；工具是额外能力，不是多模型投票 |
| 工具来源 | ChatLuna 已注册的工具；管理员在工作流页勾选后，任务才能再从中选择 |
| 工具筛选 | 名称含 mail、media、draw、send、write、delete、schedule、delegate、subagent 等写操作或委派含义的工具不会出现在白名单 |
| 工具授权 | 每次调用都重新检查 ChatLuna 工具掩码和工具自身授权；撤权后立即停止，不继续后续步骤 |
| 发信 | 工具模式只生成草稿或按计划投递；MCP 试运行不会发信，定时任务仍受全局开关、白名单、每日上限和冷却限制 |
| 图片 | 只接受 MediaLuna 成功任务、指定用户、本地缓存中的 PNG/JPEG；不接受任意 URL 或文件路径 |
| 未知结果 | 超时或重启不会自动重跑整条工具链；外部绘图可能仍在运行，需要管理员确认 |

工具名称过滤是策略层面的排除，不等于安全沙箱。只应授权可信的只读工具；工具返回内容仍按不可信资料处理。

## 工作流设置

打开「邮件任务 → 工作流」：

1. 勾选「允许工具工作流」。
2. 选择执行机器人。必须是当前在线、真实存在的 Koishi bot，格式为 `platform / selfId`。
3. 填写执行用户的平台账号。该账号用于 ChatLuna 工具授权；不是机器人账号。
4. 选择私聊身份，或填写频道/群组 ID。后台执行只构造虚拟会话，不会向聊天发送回复，也不允许等待交互输入。
5. 在「允许的外部工具」中勾选需要的工具。列表来自 ChatLuna 当前工具注册表，写操作和委派类工具已被排除。
6. 按需设置预算：
   - 最多 Agent 步数：1–24，默认 10。
   - 最多工具调用：1–40，默认 16。
   - 工具工作流总超时：10–900 秒，默认 300。
   - 单次工具结果字符上限：500–60000，默认 16000，同时受任务上下文剩余预算限制。
7. 保存。保存会产生新的策略版本；正在运行且尚未结束的旧执行会在下一次工具调用前被拒绝。

单次工具入参固定限制为 16384 字符，超过时以 `WORKFLOW_INPUT_LIMIT` 停止。工具返回内容会截断并记录 `truncated`，不会把完整结果写入执行记录。

## MediaLuna 图片交接

需要目标实例已安装并启用 `koishi-plugin-chatluna` 和 MediaLuna。本插件只声明 `mediaLuna` 为可选服务，未安装时不会影响普通邮件和上下文模式。

工作流页的图片设置：

- 允许导入 MediaLuna 图片：开启后 MCP 工具 `import_mail_image` 和任务内配图才可用。
- 图片所属用户编号：Koishi 用户表中的内部数字 ID，不是 QQ 号。任务自动绘图时还必须与执行用户对应。
- 允许绘图渠道：只列出 MediaLuna 已启用的渠道。

绘图提示词不需要管理员预先配置：模型会在执行时根据邮件主题、正文和工具资料自动生成提示词（最长 4000 字符），管理员只决定哪些渠道可用。这样同一任务可以根据当天内容选择不同画面，而不是固定一句提示词。

本版支持两种入口：

1. **主 Agent 交接**：ChatLuna 主 Agent 完成绘图后，调用 MCP `import_mail_image`，参数为 `taskId` 和可选的 `imageIndex`（0–4），返回邮件 `assetId`，再用于 `create_mail_draft`。
2. **任务内自动配图**：任务勾选「允许自动配图」后，工作流额外获得 `generate_mail_image` 工具。每次执行最多提交一次绘图请求，参数为管理员允许的渠道名和模型自动生成的提示词；绘图完成后立即导入并返回 `assetId`。

导入条件全部满足才会成功：

- MediaLuna 任务存在且 `uid` 等于配置的图片所属用户编号；
- 任务状态为 `success`；
- 指定输出项 `kind` 为 `image`；
- 输出 URL 能在 `medialuna_asset_cache` 中按 `cachedUrl` 找到记录；
- 缓存后端为 `local`，`cache.get` 能返回同一 URL 和可用本地路径；
- 文件为 PNG/JPEG，大小 1 字节–5 MiB；
- 同一 `taskId + imageIndex` 重复请求会复用同一个 `assetId`，但缓存内容变化后重新导入。

导入的素材默认不固定（`pinned=false`），仍受图片保留期和回收区策略影响。需要长期保留时在「运行维护」中固定。

## 任务配置

任务表单的「执行方式」选择「工具工作流（搜索／歌曲库／配图）」后：

- 只显示工作流页已授权的工具；
- 可勾选「允许自动配图」（每次最多一次绘图请求）；
- 可选择失败策略：
  - `stop`（默认）：任一工具失败即停止本次任务，不生成邮件。
  - `continue`：工具或绘图失败时允许跳过该资料/配图继续判断，但不得虚构结果。

以下情况不受 `continue` 影响，始终终止并记录错误码：超时、工具调用超限、步数超限、工具入参超限、授权失败、策略变更、任务/暂停撤销、上下文预算不足、MediaLuna 限制。

「试运行工具」会真实调用所选工具和模型，可能产生模型或绘图费用，但只生成草稿/预览，不会自动发信。

## 并发、超时与重启

- 每个任务有独立工作流锁，同一任务不会并发执行两次。
- 超时只停止本插件的等待，不能取消已经提交到 MediaLuna 的外部绘图。
- 超时、取消或异常后，锁保持为 `running`；插件重启后转为 `unknown`。
- 工作流页会列出未确认的执行。管理员应先到 MediaLuna 或对应外部工具核对结果，再点「确认已核对外部结果」释放锁。释放不等于取消外部任务，再次执行可能重新产生费用。
- 计划任务的同一执行键只会投递一次；SMTP 重试复用原草稿和 HTML，不会重新搜索、重新绘图或重新调用模型。

## 错误码（常见）

| 错误码 | 含义 |
|---|---|
| `WORKFLOW_DISABLED` | 工作流总开关未开启，或任务启用时校验失败 |
| `WORKFLOW_API_UNAVAILABLE` | 当前 ChatLuna 缺少 Agent、工具掩码或过滤接口 |
| `WORKFLOW_IDENTITY_REQUIRED` | 未配置执行机器人或执行用户 |
| `WORKFLOW_BOT_NOT_FOUND` / `WORKFLOW_BOT_OFFLINE` | 执行机器人不存在或不在线 |
| `WORKFLOW_TOOL_NOT_ALLOWED` / `WORKFLOW_TOOL_UNAVAILABLE` | 任务工具不在管理员白名单，或工具已下线 |
| `WORKFLOW_TOOL_AUTHORIZATION` | 执行身份没有该工具权限，或工具自身授权拒绝 |
| `WORKFLOW_TOOL_LIMIT` / `WORKFLOW_STEP_LIMIT` | 工具调用次数或 Agent 步数达到上限 |
| `WORKFLOW_INPUT_LIMIT` | 单次工具入参超过 16384 字符 |
| `WORKFLOW_TIMEOUT` | 总超时或被取消；外部绘图可能仍在运行 |
| `WORKFLOW_CONTEXT_LIMIT` | 工具结果超出剩余上下文预算 |
| `WORKFLOW_POLICY_CHANGED` | 执行期间工作流设置被修改 |
| `WORKFLOW_REVOKED` | 任务被修改/停用，或插件暂停 |
| `WORKFLOW_PREVIOUS_UNRESOLVED` / `WORKFLOW_LOCK_CONFLICT` | 上一次执行未释放或锁状态变化，需要先人工核对 |
| `WORKFLOW_INVALID_OUTPUT` | 工具模式最终没有返回要求的 JSON |
| `WORKFLOW_TOOL_FAILED` | 工具失败且策略为 `stop` |
| `WORKFLOW_MEDIA_FAILED` / `MEDIA_*` | 绘图未成功、渠道不允许、缓存/大小/归属不符合要求 |

执行记录只保存工具名称、状态、耗时、轮数和生成数量，不保存工具返回正文，避免把搜索结果或私密资料写入日志。

## 安装与升级

### 自动升级脚本

在项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1
```

脚本会：

- 读取项目 `package.json` 与 `dist/<name>-<version>.tgz`，校验同名 `.sha256`；
- 自动定位 `%APPDATA%\Koishi\Desktop\data\instances\default`，多实例时要求 `-KoishiDir`；
- 备份实例的 `package.json`、锁文件、`koishi.yml` 到 `backups\<插件名>\<时间>`；
- 使用实例现有的 Yarn 4 / pnpm / npm 安装 tgz；
- 读取安装后的 `package.json` 和 `lib`/`console` 产物核对版本，失败时恢复配置备份。

升级前请退出 Koishi Desktop；检测到进程会拒绝执行，`-Force` 可强制但可能文件占用。`-DryRun` 只检查安装包、实例和将执行的命令，不修改文件。数据库不在脚本备份范围内，请单独备份数据库。

### 手动步骤

1. 退出 Koishi Desktop，备份实例配置和数据库。
2. 安装 `dist/koishi-plugin-chatluna-mail-mcp-0.7.0.tgz`，重启邮件插件。
3. 刷新 Console。前端包已更新，工作流页和任务表单的新字段需要新前端。
4. 断开并重连 ChatLuna 中的邮件 MCP，使工具声明缓存从 13 个更新为 14 个（新增 `import_mail_image`）。
5. 进入「工作流」配置身份、工具、预算和 MediaLuna 渠道，先保持关闭，配置完成后再开启。
6. 用一个停用任务点「试运行工具」，确认草稿和日志后再启用计划任务。

升级不会修改旧任务：缺少 `executionMode`、`tools`、`workflowImages`、`toolFailurePolicy` 的记录会按 `context`、空数组、`false`、`stop` 解析。模板、图片、草稿和投递记录无需重新导入。

若 ChatLuna 版本缺少 `createAgent`、`resolveToolMask` 或 `getFilteredTools`，工具模式会以 `WORKFLOW_API_UNAVAILABLE` 拒绝执行；普通上下文模式不受影响。本版按本机 ChatLuna 1.4.0-alpha.44 的类型定义核实，其他版本需要实机联调。

## 本版不包含

- 音频附件、任意 URL 下载、网页抓取代理；
- 并行分支、条件图、可视化工作流编辑器；
- 重启后继续执行未完成的工具链；
- 任务级别的自定义工具 schema 或独立 Agent 人格；
- 对未知投递结果自动重发；
- 真实 MediaLuna、真实上游模型和真实 SMTP 的自动验收。

真实绘图、真实模型工具调用和目标电脑的 Koishi 升级仍需在该环境完成。验收证据等级见 [acceptance-0.7.0.md](acceptance-0.7.0.md)。
