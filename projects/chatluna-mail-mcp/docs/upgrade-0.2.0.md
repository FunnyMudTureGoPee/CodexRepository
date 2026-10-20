# 升级到 0.2.0

## 新功能

- Koishi Console 左侧新增「邮件任务」页面，管理员 authority >=4 可管理。
- 页面支持新建/编辑任务、启停、归档、下次执行时间、试判断、草稿预览、显式发送和执行记录。
- 每日 / 每周 / 单次三种计划。每周星期使用 1=周一至 7=周日；单次时间必须带 Z 或 +08:00 等时区。
- 自定义模板：写作提示词、变量声明、页脚、颜色、宽度、是否显示标题。不执行任意 HTML 或脚本。
- 模板保存产生新版本；草稿保存模板快照，模板修改不影响已有草稿。
- 任务编辑带冲突检测，避免两个页面互相覆盖；内置模板通过复制建立自定义副本。
- 长模型判断在后台运行，页面轮询结果，避免受 Console 单次 RPC 60 秒超时影响。
- 安装脚本自动使用 PATH 中的 node，找不到时使用 C:/Program Files/Koishi/Desktop/bin/koishi.exe。
- token 启动时校验 24-256 个无空格可打印 ASCII 字符，避免中文 HTTP Header 错误。

## 更新安装包

在新插件 dist 目录中运行（PowerShell）：

```powershell
& ..\scripts\install.ps1
```

默认实例为 $env:APPDATA/Koishi/Desktop/data/instances/default。
其他实例传 -KoishiDir；自定义 Node 位置传 -NodePath。

也可以直接使用 Koishi 自带运行时和 Yarn：

```powershell
Set-Location "$env:APPDATA\Koishi\Desktop\data\instances\default"
& "C:\Program Files\Koishi\Desktop\bin\koishi.exe" ".\.yarn\releases\yarn-4.1.1.cjs" add "koishi-plugin-chatluna-mail-mcp@file:D:/AI/文献/koishi-plugin-chatluna-mail-mcp/dist/koishi-plugin-chatluna-mail-mcp-0.2.0.tgz"
```

保存或备份现有 Koishi 配置与数据库后升级，重启或重新加载插件。安装脚本不重置配置或表。
当前开发目录不是 Git 仓库；升级开发前的源码快照位于 dist/source-0.1.0-before-0.2.0.zip。

## 数据兼容

- 旧任务缺少 scheduleType 时自动视为 daily，仍使用旧的本地日期幂等键。
- 旧草稿继续使用稳定的内置模板 v1。
- 已有 delivery 的请求标识保持有效；重复请求不会因新增 variables 默认值而再次发信。
- 数据表不变，新的模板、模板历史和归档任务使用不同 kind。
- 新版投递 hash 包含模板快照。新版本数据不建议直接降级后运行；需要回滚时恢复升级前数据库与配置副本。
- 0.1.0 安装包仍保留。没有自动清理历史任务或邮件。

## 操作说明

1. 打开控制台左侧「邮件任务」。
2. 创建或编辑任务，绑定明确授权的 ChatLuna 会话 ID，模型/预设留空跟随会话。
3. 首次保持任务停用，点「试判断」核实决定和草稿。
4. 在「模板」中复制内置模板或新建模板；变量声明示例：
   `{"name":{"required":true,"default":""}}`
   写作提示词或页脚使用 `{{name}}`，任务 variables 填 `{"name":"小明"}`。
5. 正式发信需全局 enabled=true、合法 SMTP 和精确收件人白名单。页面「发送此草稿」是管理员显式发送；Agent 另受 allowAgentSend 控制。
6. 归档前先停用任务，并等待正在执行的判断结束。归档保留执行记录。
7. 当前不自动补发错过时间，不自动重试结果未知的邮件。单次任务若需要再次安排，修改 runAt 后保存为新时间即可。

## 功能边界

一条任务的一次判断使用一个 ChatLuna 模型，未加入审核模型或投票。
上下文仍为渲染后的预设、当前分支文本历史与已存摘要；动态 RAG/其他插件记忆尚未接入。
管理页依赖现有 Console 与其登录/权限机制，不开新 HTTP 管理接口。未启用 Console 时，原命令和 MCP 继续可用。
下一阶段：记录保留期与安全清理、明确失败的受控重试、更完整的上下文适配与使用体验。
