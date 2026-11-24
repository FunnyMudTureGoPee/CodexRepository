# 本机 Codex 反代（CLIProxyAPI）

这是一个只监听本机回环地址的 CLIProxyAPI 部署。默认不开放局域网或公网，不包含批量注册、接码、共享账号或绕过平台限制的自动化。

## 1. 安装

在 PowerShell 中进入本目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

安装器会从项目官方 GitHub Release 下载最新版 Windows 可执行文件，生成独立的管理密钥和本地 API 密钥，并写入被 Git 忽略的 `config.yaml` 与 `.secrets.json`。

## 2. 启动和登录

```powershell
.\start-background.ps1
```

打开 <http://127.0.0.1:8317/management.html#/login>。运行 `.\show-secrets.ps1` 查看管理密钥。进入 OAuth 页面后，只添加你本人有权使用的 ChatGPT/Codex 账号。

服务需保持运行。认证文件保存在本目录的 `auths/`，不要分享或提交到版本库。

查看状态或停止服务：

```powershell
.\status.ps1
.\stop.ps1
```

## 3. 让 Codex CLI 使用本机服务

先安装 Codex CLI，然后运行：

```powershell
.\configure-codex.ps1
```

脚本会备份现有 `~/.codex/config.toml` 与 `auth.json`，将 provider 指向 `http://127.0.0.1:8317/v1`，并把 API 密钥保存为用户级环境变量 `CPA_API_KEY`。重开终端后生效。

指定模型和推理强度：

```powershell
.\configure-codex.ps1 -Model gpt-5.6-sol -ReasoningEffort high
```

## 4. 验证

查看模型列表：

```powershell
$key = (Get-Content .\.secrets.json -Raw | ConvertFrom-Json).api_key
Invoke-RestMethod http://127.0.0.1:8317/v1/models -Headers @{ Authorization = "Bearer $key" }
```

若返回模型列表，说明本地网关和认证已正常工作。OAuth 尚未完成时，接口可能为空或返回认证错误。

## 安全说明

- 管理端和 API 均只绑定 `127.0.0.1`。
- 不要将 `host` 改为 `0.0.0.0` 后直接暴露公网；远程使用应加 TLS、反向代理、访问控制与防火墙。
- 不要分享 `auths/`、`.secrets.json`、`config.yaml` 或 Codex 的登录令牌。
- 第三方代理会接触提示词、代码和凭据。请自行审查项目与更新，并遵守 OpenAI 及账号所属组织的条款。
