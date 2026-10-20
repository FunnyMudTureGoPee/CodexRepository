# 0.6.3 Gemini 工具声明兼容修复

症状：Gemini 返回 HTTP 400 INVALID_ARGUMENT，指向 tools[0].function_declarations[30].parameters.properties[task].properties[runAt].any_of[0].enum[0]: cannot be empty。

原因：save_mail_task 的 runAt 原先采用 z.union([z.literal(''),datetime])，MCP 将空字面量导出为空字符串枚举。Gemini 拒绝该工具参数声明。
function_declarations[30] 是当前请求工具列表中的位置，不是任务编号。错误发生于模型请求校验阶段，未执行邮件工具；
即使当轮不需要发送邮件，只要请求携带这项声明，也会被拒绝。此错误不表明 SMTP、网络或沙盒权限异常。

修复：runAt 对外声明为普通字符串；服务端仍严格校验“空值或带时区 ISO 日期时间”，单次任务必须非空。已保存任务和 Console 表单无需迁移。
真实 HTTP MCP listTools 回归递归检查全部 13 个邮件工具的参数声明，禁止出现空字符串枚举，并确认 runAt 不再含 anyOf/enum。
50 项测试在本地和 Koishi 自带 Node 20 下通过，前后端类型检查和构建通过。未请求真实 Gemini 或发送外部邮件，不能以本地测试代替目标电脑的上游联调。

安装 dist/koishi-plugin-chatluna-mail-mcp-0.6.3.tgz 后，重启邮件插件并断开/重连 ChatLuna 中的邮件 MCP 连接，使工具声明缓存更新。
只刷新邮件管理网页不足以更新模型携带的工具声明。旧任务、模板和数据库不需重新导入。
升级前临时恢复普通 Gemini 聊天，可先停用邮件 MCP 连接，避免请求携带旧的错误声明。
