# ChatLuna Mail MCP 0.7.1 快速开始

这是安装到 Koishi 的本地邮件插件。它复用 ChatLuna 模型，根据预设与会话上下文判断是否发信；可选调用搜索、歌曲库和 MediaLuna 完成图文邮件。它不提供收信或独立邮箱托管服务。

## 1. 下载什么

在 GitHub Release 的 Assets 中下载 **mail-mcp-0.7.1-scripts.zip**，解压全部文件，不要只取出 scripts 文件夹。

脚本包包含：`package.json`、`scripts/install.ps1`、`scripts/upgrade.ps1`、`dist/koishi-plugin-chatluna-mail-mcp-0.7.1.tgz` 及其 SHA256、本快速开始文档与 MCP 配置示例。无需在目标电脑编译源码。

也可单独下载 `.tgz`，用现有 Koishi 实例的包管理器安装。GitHub 自动生成的 Source code ZIP 不是这里的脚本安装包。

## 2. 安装前准备

- 已有可启动的 Koishi 实例，提供 database、server 服务；图形管理页还需 console。
- Koishi 4.18、Node >=20；Koishi Desktop 自带运行时可以使用，不要求系统 PATH 中有 node。
- 配好 ChatLuna 及其模型适配器；模型 API Key 在原适配器中填写。
- 需要真实发送时，准备 SMTP 地址、端口、发件地址和授权码，以及测试收件箱。

**安装前退出 Koishi Desktop。** 在解压后包含 package.json 的目录中打开 PowerShell。先只检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -DryRun
```

### 默认安装版 Koishi Desktop

默认实例一般为 `%APPDATA%\Koishi\Desktop\data\instances\default`。首次安装和升级都可以运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1
```

### 便携版或自定义目录

`KoishiDir` 必须指向**包含实例 package.json 的目录**，不能只指向 Koishi 程序目录。下面以便携版为例，按实际位置修改：

```powershell
$KoishiRoot = 'C:\Users\Administrator\Desktop\koishi-desktop-win-x64-v1.1.3'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 `
  -KoishiDir "$KoishiRoot\data\instances\default" `
  -NodePath "$KoishiRoot\bin\koishi.exe"
```

若实际运行时不在 `bin\koishi.exe`，改为真实的 Node 可执行文件路径；先用 `Test-Path` 核对。不要把 QQ、邮箱账号或密码填入命令。

脚本校验安装包 SHA256，备份实例配置、锁文件和旧插件 lib（包括 bak 补丁），再调用实例原来的 Yarn/pnpm/npm 安装。备份默认在实例的 `backups/koishi-plugin-chatluna-mail-mcp/` 下。备份可能含原配置中的密钥，请保存在本机。

脚本不会自动启用插件或任务，也不会替你配置 SMTP。出现 `Done with warnings` 时看末尾是否成功返回，并启动 Koishi 核对实际版本；Yarn peer 警告本身不等于安装失败。

## 3. 在 Koishi 中配置

重新启动 Koishi，在插件配置中搜索并添加/启用 `chatluna-mail-mcp`。

| 字段 | 首次建议 |
| --- | --- |
| endpoint | `/mcp/mail` |
| token | 自己生成的 24–256 位无空格可打印 ASCII 随机字符串，不使用中文占位符 |
| enabled | 先关闭；确认测试收件人和 SMTP 后再开启真实发信 |
| allowAgentManage | 希望 Agent 创建任务、模板时开启 |
| allowAgentSend | 希望 Agent 直接发送时才开启 |
| allowedRecipients | 只加入获授权的收件地址，精确匹配 |
| smtpHost / smtpPort | 邮件服务商提供的 SMTP 地址和端口 |
| smtpSecure | 465 通常为 true；587 通常为 false（强制 STARTTLS） |
| smtpUser / smtpPassword | SMTP 账号及服务商授权码 |
| from | 服务商允许的纯发件邮箱地址 |

可在你自己的 PowerShell 中生成随机令牌，保存到插件 token 字段及 MCP 请求头中，勿公开：

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

## 4. 连接 ChatLuna MCP

在 ChatLuna Agent 的 MCP 管理页添加 HTTP 服务。`5140` 改成 Koishi server 实际端口，`Authorization` 里填与插件完全相同的 token：

```json
{
  "name": "chatluna-mail-mcp",
  "type": "http",
  "startupTimeout": 20,
  "timeout": 360,
  "url": "http://127.0.0.1:5140/mcp/mail",
  "headers": {
    "Authorization": "Bearer REPLACE_WITH_YOUR_ASCII_TOKEN"
  }
}
```

此示例可用于默认 300 秒工具工作流；如果你把工作流总超时调得更长，也应调大 MCP timeout。插件只允许同机访问。连接后应能看到 **14 个工具**。升级后手动重连一次，刷新旧客户端和工具声明。

本版使用无状态 Streamable HTTP；浏览器直接 GET 得到 405 是预期行为，不能用这一结果判断 MCP 不可用。401 表示请求头令牌不匹配。`ByteString ... greater than 255` 通常说明 HTTP Header 中仍有中文占位符。

## 5. 先完成一次不发信的验收

1. 打开 Koishi 左侧「邮件任务」，在「模型设置」中刷新目录、选择邮件默认模型；供应商和 Key 仍在 ChatLuna 适配器配置。
2. 在「模板」页使用内置模板，或新建自定义模板；变量声明后可通过卡片插入提示词。
3. 在「任务」页新建任务，先保持任务禁用；选择真实的 ChatLuna 会话、时间、时区、收件白名单地址。需要发信判断时必须有可读会话上下文。
4. 运行上下文诊断，再点「试判断」；这会调用模型并可能产生费用，**不会发邮件**。`shouldSend=false` 跳过是正常判断结果。
5. 生成草稿后查看邮件预览。工具模式的试运行可能调用外部工具、产生绘图费用，但仍不发送邮件。
6. SMTP 已准备好时，使用测试收件人打开全局 enabled，再通过管理页显式发送测试邮件。确认收到后，按需要启用每日/每周/单次任务。

启用任务允许它在计划时间自动判断并可能发信；`allowAgentSend=false` 只禁止 MCP 主动发送，不能代替关闭全局 enabled 或禁用任务。电脑、Koishi 和依赖服务在执行时须保持运行，本版不承诺关机补跑。

## 6. 可选：搜索、歌曲库与自动配图

在「工作流」页开启工具执行，选择**真实在线机器人**与执行用户，再勾选允许的读取类工具。任务执行方式选择工具模式；工具仍受 ChatLuna 自身授权、步数、调用次数和超时限制。

安装并配置 MediaLuna 后，可开启图片导入、允许的绘图渠道，并填写执行用户对应的 **Koishi 内部 user.id**（不是 QQ 号；0 合法，留空是未配置）。图片只导入该用户的成功任务和本地 PNG/JPEG 缓存。任务自动配图每次执行最多一次。

在任务提示词中指定已有 MediaLuna 预设，例如「绘图时调用 generate_mail_image，presetName 使用已存在的角色预设名」。该工具接受 `channelName`、`prompt`、可选 `presetName`；不能用额外字段创建预设。

## 7. 常见问题

| 现象 | 检查方向 |
| --- | --- |
| PowerShell 找不到 scripts/install.ps1 | 必须在完整解压目录根部运行，不是在 dist 或压缩包预览里 |
| 找不到 node | 使用 Koishi 自带运行时并显式传 `-NodePath` |
| WORKFLOW_BOT_OFFLINE | 机器人必须真实在线；0.7.1 已修复数值枚举比较 |
| MEDIA_TASK_NOT_ALLOWED | 执行用户、Koishi 内部 ID 与绘图任务归属必须一致，不能绕过校验 |
| No readable text / CONTEXT_* | 核对绑定会话及实际可读文字，不要直接归因于沙盒 |
| 工具不可用/未授权 | 错误会列出名称；核对工具目录、任务白名单和 ChatLuna 用户授权 |
| 连接已关闭或未连接 | 先在 MCP 页重连一次；仍失败收集 ChatLuna Agent 版本及断开/退避重试日志 |

0.7.1 的 63 项本地测试已通过，包括 HTTP MCP、本地 SMTP/CID 和 Koishi Node 20；真实模型、MediaLuna、目标电脑 SMTP 及长期调度仍需在你的环境验收。演示截图未包含于公开包。
