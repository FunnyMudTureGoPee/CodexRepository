# Gemini API 本地连通性测试

本地网页 + Node.js 转发服务，无第三方依赖，无需 npm install。

## 启动

Windows 双击 `start.cmd`，然后在浏览器打开 **http://127.0.0.1:8766**。保留启动窗口，按 Ctrl+C 关闭服务。

也可在此目录运行（Node.js 20+）：

```powershell
node server.mjs
```

如果端口被占用：

```powershell
$env:PORT = '8788'
node server.mjs
```

## 使用

1. 添加服务；每个服务有独立基础地址、接口协议、Key 列表和模型列表。服务名称和 Key 备注可编辑，取消勾选可跳过服务。
2. 直接向 Key 输入框粘贴，自动识别纯 Key、`Bearer ...`、`x-goog-api-key: ...`、`.env` 赋值、JSON、URL 的 `key` 查询参数。粘贴多个 Key 时自动拆成独立输入框。也可展开「智能识别 / 批量导入 Key」，查看识别数量后点击「自动识别并添加」。支持换行、逗号、空格、分号和 `备注 | Key`；自动去重、去掉外层引号及不可见字符。无法识别的内容不会作为 Key 导入，不会将 Key 内部空格直接拼接；这里只检查输入格式，是否有效仍需调用 API 测试。
3. 填入模型 ID（每行一个，也支持逗号分隔），或点击「获取模型」。模型标签可多选；获取模型使用该服务第一个非空 Key。
4. 选择「生成测试」验证各个服务 × Key × 模型组合；「连接检查」仅请求模型列表，每个 Key 一次，不要求填写模型。
5. 设置并发数、单项超时和输出 Token 上限，点击「开始批量测试」。可以停止、筛选结果、查看 HTTP 状态、完整响应、Token 用量并导出 JSON。

| 类型 | 基础地址示例 | 请求 |
| --- | --- | --- |
| Gemini 原生官方 | `https://generativelanguage.googleapis.com/v1beta` | `GET /models`、`POST /models/{model}:generateContent`，`x-goog-api-key` |
| Gemini 官方 OpenAI 兼容 | `https://generativelanguage.googleapis.com/v1beta/openai` | `GET /models`、`POST /chat/completions`，Bearer |
| 第三方 OpenAI 兼容中转 | `https://你的服务商/v1` | 同上，模型名称以服务商提供为准 |
| 第三方 Gemini 原生中转 | `https://你的服务商/v1beta` | Gemini 原生协议，版本路径以服务商提供为准 |

填写**基础地址**，不填完整生成接口，不填 `?key=...`。仅填域名时自动补充 Gemini `/v1beta` 或 OpenAI `/v1`；自定义非根路径会完整保留。此工具面向 API Key 鉴权，不处理 Vertex AI OAuth/服务账号。

## 结果含义

- **成功（生成测试）**：HTTP 成功且收到可见文本。支持文本生成的模型才适合此测试；图像、音频或 embedding 专用模型不适用。
- **成功（连接检查）**：可以获取模型列表，仍需生成测试验证具体模型权限、额度和可用性。Gemini 会自动读取分页并筛选支持 generateContent 的模型；OpenAI 兼容接口读取 `/models` 返回的 `data` 列表。
- **待检查**：接口 HTTP 成功但无可见文本（可能是思考预算用完、安全拦截或非文本响应），或模型列表分页不完整。详情中保留结束原因与原始响应。思考模型可将 Token 上限从 256 提高到 1024–4096；更高上限可能增加用量。
- **401/403**：鉴权或权限问题；**404**：路径、协议或模型问题；**429**：频率或配额问题；**5xx**：上游服务异常。错误提示只是排查方向，具体原因以响应为准。
- **连接失败/超时**：网络、代理、DNS、TLS 或上游响应问题。所有耗时均为本机服务从发起请求到读完响应的总耗时（包含分页），不是首 Token 延迟。

停止会取消排队任务并中止在途连接；已被上游接收的生成请求仍可能计费。工具不自动重试。

## Key 与网络

- Key 默认只保留在当前页面内存中；非秘密配置自动保存到浏览器 localStorage。勾选「在此浏览器记住 Key」后，Key 才会以**明文**写入该浏览器存储；取消勾选会在下一次保存时去掉已存储的 Key。用「清除全部 Key」可同时清除当前 Key 与结果。
- 配置导出不含 Key，结果导出及详情遮盖已知 Key。服务器不写入 Key 文件，不记录请求体或鉴权信息。Key 会经本机服务发送到**你填写的地址**；使用可信地址。
- 服务仅监听 `127.0.0.1`，限制 Host 与同源访问，不对局域网开放。没有 CDN、统计脚本或第三方前端依赖。用本机服务转发以避免上游 CORS 限制。
- 出于 Key 保护，接口重定向不会自动跟随；请填写最终基础地址。
- `node server.mjs` 使用 Node 的默认直连方式，不会自动继承浏览器代理。如果需要 HTTP 代理，Node 24.5+ 可运行：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:NO_PROXY = 'localhost,127.0.0.1'
node --use-env-proxy server.mjs
```

`start.cmd` 在支持时启用环境变量代理。本机已验证 VPN 的 HTTP 代理位于 `127.0.0.1:7890`，并保存到 `proxy-url.txt`；启动脚本会读取该文件，已设置的 HTTPS_PROXY 优先。修改该文件可调整地址，删除或清空该文件可恢复直连。这个文件仅填写代理 URL，不填写 API Key。通过此启动方式使用代理需要 Node.js 24.5+，当前机器的 Node 版本满足要求。不要关闭 TLS 校验来绕过证书错误。

如果所有请求在约 1 ms 内返回 `EACCES` / `EPERM` 且没有 HTTP 状态码，这是本机连接权限被拒绝，尚未到 API 鉴权层；由受限沙箱启动的进程可能出现这种情况。请在本机直接双击 `start.cmd` 启动，或在已有授权的沙箱外启动服务。直连超时和 Key 失效是不同问题，先确认网络与代理能收到上游 HTTP 响应。

## 验证

```powershell
node --test test/*.test.mjs
```

测试使用本机模拟 HTTP 服务，不使用真实 Key、不消耗真实 API 额度。覆盖两种协议、模型分页、错误分类、超时、停止、重定向保护、Key 遮盖和本机服务访问限制。

可选本机演示接口：

```powershell
node test/mock-service.mjs
```

演示基础地址：`http://127.0.0.1:8799/v1beta`（Gemini 原生）或 `http://127.0.0.1:8799/v1`（OpenAI 兼容）。任意假 Key 可用，`bad-key` 返回 401，`quota-key` 返回 429；模型 `mock-flash` 与 `mock-pro` 可用于生成。演示服务也只监听本机。

协议参考：[Gemini 生成接口](https://ai.google.dev/api/generate-content)、[模型列表](https://ai.google.dev/api/models)、[OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)。
