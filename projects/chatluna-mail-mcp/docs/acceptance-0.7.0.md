# 0.7.0 验收记录（2026-10-19）

## 本地自动验收

- `tsc --noEmit`、前端 `tsconfig.client.json` 类型检查通过；`tsup` 构建插件与 Console 前端通过。
- `scripts/smoke.cjs` 在 Koishi 自带 Node 20.12.2 下加载构建产物，验证数据表、命令和默认配置，不连接 SMTP/LLM。
- 60 项测试分别在本机 Node 22.22.2 和 Koishi 自带 Node 20.12.2 下通过。
- 真实 HTTP MCP 回归扫描全部 14 个工具的 `inputSchema`：无空字符串枚举，`save_mail_task.runAt` 仍为普通字符串；`import_mail_image` 已注册。
- 旧任务兼容：缺省 `executionMode=context`、`tools=[]`、`workflowImages=false`，任务 hash 与旧授权不受影响。
- 工作流设置：并发保存只有一个成功；工具白名单拒绝 `send_mail_draft` 等写操作；关闭总开关后启用工具任务被拒绝。
- 完整链路（夹具）：`search → lyrics → generate_mail_image → MediaLuna 成功任务 → 本地缓存导入 → assetId → CID 草稿`；草稿 HTML 含 `cid:image-0@chatluna-mail`，附件字节与源 PNG 一致；执行记录不含工具返回正文。
- 计划投递：首次 SMTP 失败后重试只复用原草稿；工具调用次数、绘图次数、HTML 均不变化，同日再次执行返回 `duplicate`。
- 授权与预算：主工具掩码缺少工具、工具 `authorization` 拒绝、执行中撤权、`maxToolCalls` 超限、`stopped` 撤销均 fail-closed；失败前不产生绘图或发信。
- 失败策略：`stop` 返回 `WORKFLOW_TOOL_FAILED`；`continue` 可跳过工具异常继续生成文字邮件；500 字符上限下工具结果被截断并标记 `truncated`。
- 工具包装：带 `returnDirect=true` 的搜索工具不会提前结束 Agent；18000 字符工具入参返回 `WORKFLOW_INPUT_LIMIT`，工具函数未被执行。
- 新默认值：`maxContextChars=64000`、`historyLimit=60`、`modelTimeoutMs=120000`；工作流默认 10 步／16 次调用／300 秒／16000 字符结果，工具入参上限 16384 字符。旧任务缺省值按新默认解析，但已保存的显式值不变。
- 自动升级脚本 `scripts/upgrade.ps1 -DryRun` 在真实实例路径上完成安装包识别、SHA256 校验、默认实例定位、Yarn 4 命令构造与版本核对，未修改任何文件。未在运行中的实例上执行真实安装。
- 图片导入：他人任务、未完成任务、非本地缓存、超过 5 MiB、关闭导入开关均被拒绝；并发重复导入返回同一 `assetId`，素材默认不固定。
- 并发与恢复：取消后重复执行返回 `WORKFLOW_PREVIOUS_UNRESOLVED`；重启遗留的 `running` 锁转为 `unknown`，hash 不匹配的释放被拒绝。
- 原生集成：使用 ChatLuna `buildVirtualSession` 验证执行身份与 authority/permissions 观察；使用 ChatLuna 原生 `createAgent` + 确定性 LangChain Runnable 完成 4 轮工具调用（3 次工具、1 次最终 JSON），工具结果与绘图均只执行一次。
- 原有图文 SMTP、鉴权、幂等、调度、重试、上下文解码、历史分支、保留期和 SQLite 重启恢复测试继续通过。

## 隔离控制台验收

使用 `scripts/preview-console.cjs`：独立 Koishi 内存数据库、模拟 ChatLuna/MediaLuna 服务、关闭真实发信；未连接用户业务实例。

- 默认页显示 2 个任务，其中一个为工具模式任务，操作按钮显示「试运行工具」。
- 「工作流」页签显示受控工具工作流、执行身份（`preview / bot`）、可授权工具 `web_search`/`music_library`、绘图渠道 `art`、保存按钮。
- 写操作工具 `send_mail` 未出现在白名单。
- 展开「执行预算」后可见最多 Agent 步数、最多工具调用、总超时、单次工具结果字符上限。
- 编辑工具模式任务时显示执行方式、试运行费用提示、自动配图开关、失败策略和工具勾选项。
- 演示截图未包含于公开仓库；可运行隔离预览脚本检查界面。

## 未验证 / 证据边界

- 本机未安装 MediaLuna。接口按 media-luna 源码的 `channels.list`、`tasks.getById`、`cache.get`、`generateByName` 与 `medialuna_asset_cache` 字段对接，未做真实绘图联调。
- 未调用真实 Gemini/OpenAI 等上游模型，因此不能证明真实模型的函数调用、参数生成和长上下文行为；原生 Agent 测试使用确定性 Runnable 和本地夹具工具。
- 未向真实邮箱发信，未升级正在运行的 Koishi 实例，未验证长期调度、系统休眠或跨日运行。
- 隔离浏览器使用模拟服务和内存数据库，只能证明界面与事件处理，不证明生产 ChatLuna/MediaLuna 服务可用。
- 依赖未重新审计；上次审计结果仍为 `dependency-audit-0.5.0.json`。

真实模型、MediaLuna、SMTP 和目标实例升级需要在目标电脑完成，不能以本地夹具测试代替。
