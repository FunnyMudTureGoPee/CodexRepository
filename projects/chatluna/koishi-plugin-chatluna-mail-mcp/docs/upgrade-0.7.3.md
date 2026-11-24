# 0.7.3 失效检查点恢复（2026-10-26）

错误 `Context checkpoint is no longer in active history` 指上次发信保存的消息 ID 已不在当前活动分支，发生在正文解码之前，不等于图片解码失败。已核对本机 ChatLuna：压缩、历史裁剪或工具消息清理可替换/删除消息。尚未访问目标电脑，所以不能断言每次含图都会触发这条路径。

## 修复行为

- 优先按原消息 ID 定位检查点，仍按可读消息数执行 historyLimit 和 minNewMessages。
- 新投递记录保存边界消息的 createdAt。旧 ID 丢失后，在同一会话中按保存的时间边界恢复，只把严格晚于边界的记录计作新增；等于边界的记录不作为新增。
- 兼容 0.7.2：同一会话的已发送记录缺少边界消息时间时，使用该次执行的 createdAt（不是重试的 updatedAt）。这是近似恢复，可能与当时已处理的内容有重叠，诊断、管理页及模型输入均明确告警。
- 新生成的 infinite_context 摘要不因时间较新就算作新增聊天，避免把旧事项重新通知。图片本身仍不计入可读文字条数。
- 任务换绑其他会话时，不继承原会话的检查点；旧重试完成不会把检查点退回较早的执行。
- 没有同会话归属信息、可用时间边界或消息时间时，仍返回 CONTEXT_CHECKPOINT_UNRESOLVED，不清空检查点重放全量历史。

诊断、只读审计和 dry run 均不会写入发送进度；只有原有的 accepted/partial 投递规则建立新检查点。时间恢复不改变原会话、不删除历史，也不重放之前的失败投递。既有上下文有界压缩和 SMTP 幂等规则保持。

## 安装与验收

先退出 Koishi，并按原数据库插件方式备份业务数据库。升级脚本仅备份配置、锁文件及旧 lib，不能代替数据库备份。将 0.7.3 tgz 或完整脚本包复制到目标电脑，使用原安装/升级命令替换版本号即可。

重启 Koishi 并重连 MCP，先调用 `get_mail_task_diagnostics`。展开 `historySelection.checkpointRecovery`，查看 mode、originalMessageId、at、timeBasis 和 warning；timestamp-recovered 表示使用了恢复路径。storageOnly 元数据审计会显示 checkpointFound、checkpointAt 和 recoveryRequired，但不解码，不代替正常诊断。

诊断成功后，再决定是否执行 evaluate。evaluate 不发信，但 tools 模式可能触发工具和绘图费用，需确认后再进行。真实定时发信仍须单独验收。本次只用本地夹具，没有修改目标实例或向真实收件人发信。

验证覆盖：删除图片检查点、旧文字排除、新文字保留、新增图片无文字跳过、旧记录近似恢复、换绑会话、较早重试不倒退检查点、无可用时间时明确错误。86 项本地测试通过，包含 Koishi Node 20、类型检查、构建与默认关闭发信的加载验证；目标电脑运行状态尚未验证。
