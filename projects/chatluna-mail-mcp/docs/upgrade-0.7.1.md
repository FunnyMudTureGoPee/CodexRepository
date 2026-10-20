# 0.7.1 工单修复与升级

## 已修复

- 在线校验使用 Koishi 实际导出的 `Universal.Status.ONLINE`（数值 1）。0、连接中、重连中及未知状态都拒绝执行，不用真值判断代替在线状态。
- 图片生成与导入使用同一归属函数：两边转字符串比较；缺失、null、布尔值及其他用户均不能授权。恢复严格检查，没有 `if (false && ...)` 绕过。
- 图片所有者设置为非负安全整数或 null；0 合法，输入框留空保存为 null。已存数字配置无需改写，原值 0 现在按真实用户 0 处理，请确认归属。
- 自动配图工具新增可选 `presetName`，直接传给 MediaLuna `generateByName`；仍只允许既有渠道、每次工作流最多绘图一次。预设必须已存在，不能通过此字段创建预设。外部主 Agent 的 MediaLuna 工具参数由其插件独立定义，此处只修改邮件工作流内的 `generate_mail_image`。
- 工具目录、任务白名单、执行身份授权不匹配时，错误包含具体工具名；不输出参数、密钥或聊天正文。
- 升级脚本备份原插件 lib，包括 index.cjs 及其 bak 到 bak4 等临时文件，作为人工核对依据，不再向旧文件追加临时补丁。

## 连接问题的结论与边界

源码确认旧邮件服务端会回收闲置超过 30 分钟的 MCP 会话，新请求携带旧 ID 会得到 404。直连重新 initialize 正常只证明新连接可用，不能证明旧连接仍有效。

当前本机安装的 ChatLuna Agent 1.0.44 已有 onerror/onclose 重连和最多 5 次退避重试；因此不能在没有目标机日志和客户端版本的情况下断言它完全没有自动重连。旧工具实例持有已关闭 client、重试耗尽等路径仍需要目标机现场日志确认。本次没有修改第三方客户端 node_modules，也没有向上游发布工单。

0.7.1 将邮件端改为 SDK 支持的无状态 HTTP：每个 POST 创建独立 transport，不再签发或回收 session ID；任务、草稿、锁和幂等记录仍保存在原数据库中。逐请求鉴权保持不变，最多 32 个并发请求。GET 保持 405，DELETE 返回 204；无服务器主动通知、事件恢复或跨请求取消能力。邮件执行仍受自身超时、预算、撤权和幂等规则约束。网络断开时不会自动重放发信或绘图；结果不明应先查执行记录。

升级后在 ChatLuna MCP 页面手动重连 mail 一次，以清理旧 client/工具缓存。若仍报未连接，记录 ChatLuna Agent 版本、断开和重试日志，再检查客户端；本包不能修复第三方客户端已经关闭的实例。

## 安装

先退出 Koishi Desktop。建议解压本次升级 ZIP 后，在其根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -KoishiDir 'C:\Users\Administrator\Desktop\koishi-desktop-win-x64-v1.1.3\data\instances\default' -NodePath 'C:\Users\Administrator\Desktop\koishi-desktop-win-x64-v1.1.3\bin\koishi.exe'
```

脚本校验 SHA256、备份配置/锁文件/旧插件 lib，再使用实例原包管理器安装。备份包含配置，勿公开上传。脚本不会迁移或重建用户、会话、任务数据库，也不自动启用任务、不发送测试邮件。若该便携版 Node 运行时不在 bin/koishi.exe，需将 NodePath 改为实际位置。

## 验收

自动验收：63 项测试（含真实本地 SMTP 的 MIME/CID、真实 HTTP MCP、原生 ChatLuna Agent 确定性模型）。覆盖数字在线状态、非在线拒绝、数字/字符串 0、缺失/越权拒绝、presetName 透传、错误工具名、模拟时间前进 31 分钟、接口重载后的同一 HTTP 客户端调用，以及同一发送键不重复发信。时间前进测试不是实际等待 31 分钟。

目标电脑人工验收：

1. 版本显示 0.7.1，确认备份中保存原 index.cjs/bak 文件。
2. MCP 手动重连后列出 14 个工具；退出重进会话仍可列工具。
3. 确认机器人真实在线、执行账号和内部 user.id 对应；进行 dry run。仅 dry run，不直接发送；绘图可能产生费用。
4. 提示词指定已有 MediaLuna 预设，检查生成图及邮件预览；他人任务 ID 应拒绝导入。
5. 闲置超过 30 分钟后再次调用；如失败收集不含密钥的断开/重试日志。
6. 真实发信须使用测试收件人明确验收。本地自动测试不证明目标机 SMTP 或真实绘图渠道可用。
