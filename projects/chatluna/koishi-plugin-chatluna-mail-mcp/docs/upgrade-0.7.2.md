# 0.7.2 上下文存储限额修复与验收（2026-10-21）

## 根因与修复

0.7.1 先解码活动分支全部消息，再执行检查点、historyLimit 和字符预算筛选。范围外的旧超大消息可能先触发 CONTEXT_STORAGE_LIMIT。本版先验证活动分支和检查点，再由新到旧有界解码，凑够最近 historyLimit 条可读消息后停止。图片等非文本行不计作一条可读消息。minNewMessages 大于 historyLimit 时，会继续检查必要的新消息，直到达到阈值或到达检查点。

since-last-send 不解码检查点本身和更早消息；没有检查点时使用有界的初始历史窗口。检查点丢失仍明确失败（recent 且 minNewMessages=0 保留旧的容许行为）。没有新增可读消息时跳过，不会调用模型或付费工具。这个场景不再解码旧检查点来检查新鲜度；有选中可读消息时，新鲜度仍由最新一条判断，contextMaxAgeHours 不是历史时间范围过滤器。

## 范围内数据也尽力处理

任务的 contextOverflow=trim-oldest 现在先尝试有界抢救和文字提取，再进行开头／两个中段／结尾的分布式摘录压缩，最后必要时裁剪最旧消息。你反馈的 daily-diary 已是此模式，升级不需要改任务定义。它是有损摘录，不是无损压缩或额外模型生成的语义摘要；主任务仍只调用原来选定的判断模型，是否发送仍由它决定。诊断不请求模型，压缩也不增加模型请求次数。

严格的 reject 模式保留原单条压缩/解压/文字 1 MiB、累计解码 8 MiB 限额。自动压缩模式采用有限的抢救上限：压缩输入每条 8 MiB、解压输出每条 16 MiB、累计解码/失败解压工作预算 32 MiB；每条提取后的文字先限制为不超过 16000 字符（小字符预算下更少），然后再按任务总字符预算压缩。旧 text 字段已是内存中的字符串，直接摘录，不复制完整内容到模型上下文。工具模式预留最多 16000 字符、且不超过总预算三分之一给后续工具结果。

若某条消息超过抢救上限或损坏，但还有其他真实可读事实，则保留这些事实继续判断，在 source.contextStorage.unreadableMessages 和 source.contextWarnings 记录具体消息元数据；模型和管理页均明确提示上下文不完整。不把未提供的部分声称为全文；图片数据不会当作文字送给模型。若没有任何可读事实，或者缺失内容使 minNewMessages 阈值无法可靠判断，仍明确失败，不能捏造一个 shouldSend=false。

source.contextStorage.compactions 记录摘录方式、原字符数与保留字符数；rescuedMessages 记录走过抢救窗口的压缩消息数。字符裁剪和压缩均不修改原会话记录、不改任务开关、不更新发送检查点、不自动重试旧失败的计划。

`error` 是未完成判断，不能解释为 `shouldSend=false`；模型 503 另行排查。

## 诊断计数的兼容说明

为了不解码范围外历史，不再声称知道整个活动分支的准确可读条数。availableTextMessages、newMessages 和 droppedMessages 是实际检查范围的计数；未检查完时只是下界。source.historySelection 明确给出 countScope、inspectedRows、uninspectedRows、excludedByCheckpointRows、availableTextMessagesExact、newMessagesExact 和 countsAreLowerBounds，droppedMessagesExact 也明确准确性。业务上的 historyLimit 和 minNewMessages 仍按可读消息数判断，而非原始行数。

## 先备份，后升级与只读定位

目标实例不在当前开发电脑上，因此未读取或修改目标电脑数据库，尚未确认 daily-diary 等任务共享哪条问题消息。

1. 先使用原数据库插件的备份方式建立本地数据库备份。若是 SQLite 文件复制，先退出 Koishi，再复制实际数据库文件及同位置存在的 -wal/-shm 文件；不要猜数据库路径。配置/锁文件备份不等于业务数据库备份，完整备份包含私密数据，勿上传到 GitHub。
2. 用脚本包的 scripts/upgrade.ps1 安装 0.7.2；它会备份配置、锁文件、原 lib，但不备份业务数据库。重启插件并重连 MCP 更新工具声明。
3. 执行只读存储诊断。它不解压正文、不检查图片内容、不读取密钥、不渲染预设或调用模型：

```json
{"name":"get_mail_task_diagnostics","arguments":{"taskId":"daily-diary","storageOnly":true}}
```

也可在 Koishi 管理命令中调用 `mail.context-storage daily-diary`（authority 4），或在解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\audit-context.ps1
```

脚本默认依次检查 daily-diary、morning-note、tiandian-report、sunday-playlist、var-test，安全提示输入 MCP token；输出只含元数据的本地 JSON，不运行 evaluate、不发送。自定义端口传 -Endpoint；自定义任务用 PowerShell 脚本调用传入 -TaskIds 数组。

报告包含任务/会话 ID、活动分支最新 ID、检查点及超限消息的 messageId、role、storageType、encodedLength、compressedBytes、legacyTextBytes、检查点相对位置，超限条目最多返回 100 条，truncated=true 表示未全部列出。二进制存储字节数准确；base64 字符串的压缩大小为估算并明确标记。storageOnly 不解压，因此不能判断实际图片/文字类型、解压后大小或最终可读窗口，只能定位压缩/旧 text 大小异常；不能据此断言没有其他解压错误。正常诊断错误会返回具体消息 metadata。

## 分阶段验收

- 逐个任务调用默认 get_mail_task_diagnostics（storageOnly=false），确认其是否成功，而不是把历史错误记录当当前全部任务都失败。
- 诊断成功后再决定是否 evaluate_mail_task。它不发邮件，但 tools 模式会调用外部工具、可能产生绘图费用；真实评估须先确认费用与授权。本次开发只使用本地夹具，没有对用户任务执行 evaluate。
- 所选范围的超大消息在 trim-oldest 模式先尽力抢救和摘录；严格模式或抢救后无可读事实才失败。查看 contextWarnings、compactions、unreadableMessages 或 contextError；不会删除原记录。
- 真实定时发信须再次确认，仅用测试收件人先验证。失败运行已占用当次计划键，升级不会重放此前失败或不确定的投递，也不会改变 SMTP 幂等规则。

本地自动验收覆盖范围外旧超大、范围内超大、文字/多模态、单条压缩和解压限额、累计 8 MiB、检查点存在/丢失、无新消息、minNewMessages 超过 historyLimit、存储元数据只读诊断、错误不等于不发送，以及诊断成功后 dry run 调用一次模型但不发信。真实目标环境是否恢复尚未验收。


本轮 80 项测试通过，包含真实本地 HTTP 下的 Windows PowerShell 元数据审计脚本。此前 PowerShell 子进程因继承宿主 PSModulePath 导致模块无法加载，测试启动环境已修正；没有改变目标用户的 PowerShell 安全配置。
