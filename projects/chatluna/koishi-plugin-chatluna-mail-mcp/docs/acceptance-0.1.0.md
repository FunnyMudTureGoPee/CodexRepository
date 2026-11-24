# 本地验收记录（2026-10-19）

包：koishi-plugin-chatluna-mail-mcp 0.1.0。所有测试都在新插件目录内进行，未修改或启用现有 Koishi 实例，未连接外部 SMTP 或真实 LLM。

## 已完成

- TypeScript 严格类型检查通过。
- 14 项 Node 测试通过，0 失败。
- tsup 生成 lib/index.cjs、声明文件与 sourcemap。
- 构建后的实际 Koishi 插件加载通过：Config 默认发送关闭，数据库表与 authority=4 管理命令注册成功。
- 真实本地 SMTP 接收器验证 multipart/alternative、PNG Content-Type 和 CID 引用。
- 真实 HTTP MCP 客户端验证鉴权、Origin 拒绝、8 个工具、Prompt、草稿、发送、重复调用、白名单拒绝、发送开关和 GET 405。
- 模拟主插件/模型验证：预设注入、当前分支选择、任务模型覆盖、send/skip、无上下文、非法 JSON、超时关闭。
- 调度与可靠性验证：时区日期边界、重复触发、并发互斥、执行中停用、每日次数限制、进程重启时未知状态恢复。
- SMTP 失败与部分接受使用模拟返回值验证；真实本地 SMTP 使用测试专属明文传输，不改变生产 TLS 要求。

## 尚未完成，不能视为生产验收

- 用户暂未指定真实会话，未用真实 ChatLuna 模型调用验证。
- 未配置 SMTP 账号，未向外部邮箱发送，未验证邮箱客户端排版或服务商 TLS。
- 未跨两个自然日运行；调度目前使用固定时间输入测试。
- 使用内存数据库测试恢复函数，未验证真实数据库进程重启、升级迁移或故障恢复。
- 未在现有 Koishi 实例安装/启用。安装脚本仅生成，待用户有账号和会话后再执行。

## 版本与兼容依据

- 读取本机 ChatLuna 1.4.0-alpha.44 的类型和实现，核实 conversation.getConversation/listMessages、preset.getPreset、promptRenderer.renderPresetTemplate、createChatModel。
- 针对 listMessages 可能回退到全分支排序的行为，邮件适配器额外按 latestMessageId 回溯，避免混入其他会话分支。
- 这只覆盖渲染预设、历史文本和压缩摘要；不代表完整聊天中间件、动态长期记忆或 RAG。
- 构建/测试 Node 24.19.0；声明最低 Node 20，尚未单独在 Node 20 跑测试。
- HTTP MCP SDK 1.32.1、Nodemailer 10.1.7；不复用参考歌词项目的旧依赖版本。

## 依赖审计

已升级本插件直接使用的 MCP SDK 和 Nodemailer。最终 pnpm audit --prod 的剩余 6 项（5 moderate / 1 high）来自本地依赖树自动解析的可选 ChatLuna peer 及其传递依赖（langsmith、file-type、uuid），不是本插件直接依赖新增的已知告警。
没有自动升级用户已安装的 ChatLuna，也不把这些上游风险标记为已修复。正式部署应按目标 Koishi/ChatLuna 实际依赖重新审计。原始本地报告见 dependency-audit.json。

## 后续人工验收顺序

1. 安装包并配置 token，保持 enabled=false。
2. 填写白名单，导入指定会话任务，执行 mail.evaluate，核对使用的预设、模型、上下文数量与决定。
3. 配置专用测试 SMTP，显式开启发送，向测试收件箱发送文字和图文邮件。
4. 开启一条每日任务，检查两个实际触发点、停用与重启恢复。
5. 根据结果记录通过/失败，再扩大使用范围。
