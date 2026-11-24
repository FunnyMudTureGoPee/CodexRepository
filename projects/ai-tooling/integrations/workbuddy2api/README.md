# workbuddy2api

把 **WorkBuddy / CodeBuddy（腾讯代码助手）** 的桌面端登录态，转成你本机可直接使用的 **OpenAI / Anthropic 兼容 API**。

适用场景：

- 用 **Codex CLI** 走 `/v1/responses`
- 用 **Claude Code / CC Switch** 走 `/v1/messages`
- 用 **Cherry Studio / ZCode / LobeChat / NextChat / Open WebUI** 走 `/v1/chat/completions`

[English](#english) · [中文](#中文)

---

## 中文

### 这是什么

`workbuddy2api` 是一个本地协议转换器。它会读取你已经登录好的 WorkBuddy / CodeBuddy 桌面端凭据，转发到腾讯后端 `copilot.tencent.com`，然后在本地暴露这些接口：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`

它不负责登录，不模拟桌面端，也不替你执行工具。它只做三件事：

1. 读取本机登录态并注入鉴权头
2. 在 OpenAI / Anthropic 协议和腾讯后端协议之间转换
3. 对 `Codex CLI` 这类长上下文 agent 请求做后端友好的压缩投影

> 命名说明：项目对外名称现在叫 `workbuddy2api`。代码里仍保留部分历史命名，比如 `codebuddy2openai`、`CODEBUDDY2OPENAI_*`，目的是兼容旧配置和环境变量。
> 另外，GitHub 仓库路径当前也可能仍沿用 `codebuddy2openai`，这是仓库路径与项目展示名尚未完全统一，不影响使用。

### 你能用它做什么

- 把 WorkBuddy 订阅复用到 OpenAI 兼容客户端
- 让 Codex CLI 直接接腾讯后端，而不是只接 OpenAI 官方
- 让 Claude Code 通过 CC Switch 复用 WorkBuddy 支持的模型
- 保留原生 `tools` / `tool_calls` / 流式 SSE / 多轮工具调用

### 当前支持

| 客户端 / 协议 | 接口 | 当前状态 |
|------|------|------|
| OpenAI Chat Completions | `/v1/chat/completions` | 已支持 |
| OpenAI Responses | `/v1/responses` | 已支持，适配 Codex CLI |
| Anthropic Messages | `/v1/messages` | 已支持，适配 Claude Code / CC Switch |
| OpenAI Models | `/v1/models` | 已支持 |
| Health Check | `/health` | 已支持 |

---

## 3 分钟上手

### 1. 前置条件

你需要先满足这 3 个条件：

1. 本机已经安装并登录 **WorkBuddy / CodeBuddy** 桌面端
2. 本机有 **Python 3.8+**
3. 已安装依赖 `fastapi`、`uvicorn`、`httpx`

默认会在这些位置寻找登录态：

- macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info`
- Windows: `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`
- Linux: `~/.local/share/CodeBuddyExtension/Data/Public/auth/*.info`

### 2. 安装依赖

推荐用 `uv`：

```bash
git clone https://github.com/ShouZhuo0413/codebuddy2openai.git workbuddy2api
cd workbuddy2api

uv venv
uv pip install -r requirements.txt
```

也可以用虚拟环境：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> 注意：无论是启动服务，还是执行 `python3 -m core.converter --help`，都必须先装依赖。

### 3. 启动

最常用的启动方式：

```bash
uv run python -m core.converter --desensitize --log converter.log
```

或：

```bash
python3 -m core.converter --desensitize --log converter.log
```

看到监听 `http://127.0.0.1:8787` 就说明已经起来了。

### 4. 快速自检

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

如果这两条能通，说明本地服务、登录态、基本路由都没问题。

---

## 客户端接入

### Codex CLI

这是当前最推荐的接法。Codex CLI 走的是 `/v1/responses`，而不是 `/v1/chat/completions`。

推荐启动命令：

```bash
uv run python -m core.converter --desensitize --log converter.log
```

> **⚠️ 先确认 Codex 版本 —— profile 的写法不一样**
>
> - **新版**（实测 `codex-cli 0.162.0-alpha.17.2`）：`--profile` 是
>   「把 `$CODEX_HOME/<name>.config.toml` **叠加**到 `config.toml` 之上」，
>   **不是** 下面的 `[profiles.x]` 段。做法是新建
>   `~/.codex/workbuddy.config.toml`：
>
>   ```toml
>   model = "glm-5.2"
>   model_provider = "workbuddy"
>
>   # 单个工具输出可进上下文的 token 上限（官方模型是 10000，未知模型走兜底）
>   tool_output_token_limit = 10000
>
>   [model_providers.workbuddy]
>   name = "WorkBuddy (via local proxy)"
>   base_url = "http://127.0.0.1:8080/v1"
>   wire_api = "responses"
>   env_key = "CODEBUDDY2OPENAI_KEY"
>   ```
>
>   然后 `codex -p workbuddy "任务"`。这种写法不动 `config.toml` 的默认模型。
>   反代入口用 `127.0.0.1:8080`，直连应用则用 `127.0.0.1:8787`。
>
> - **老版**：用下面的 `[profiles.workbuddy]` 写法。
>
> **Key 是必需的**：只要 `.env.local` 里配了 `CODEBUDDY2OPENAI_KEY`（当前部署就是），
> `env_key` 指向的环境变量必须是**真实 Key**，填占位值会
> `401 {"error":{"message":"invalid api key",...}}`。
>
> **⚠️ `model_context_window` 不能把窗口调大**（实测 0.162.0-alpha.17.2）。
> 它是「上限帽」，语义为 `min(配置值, 模型元数据值)`：
> 不设置 → 258400（兜底 272000 × 95%）；设 `1000000` → 仍是 258400；
> 设 `100000` → 变成 95000。想让自定义模型拿到真实元数据得用
> `model_catalog_url`（`ModelProviderInfo` 字段之一）自备目录端点。
> 对本转换器没意义——转换器实际只向上游发几千 token，25.8 万的窗口碰不到。
>
> **启动时这两行是正常噪音，可以直接忽略**：
>
> ```text
> Model metadata for `glm-5.2` not found. Defaulting to fallback metadata
> error sending request for url (http://127.0.0.1:8081/mcp)   # Unity MCP 未开
> ```

老版 Codex CLI 的配置（合并到 `~/.codex/config.toml`）：

```toml
[model_providers.workbuddy]
name = "WorkBuddy (via local converter)"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "CODEBUDDY2OPENAI_KEY"

[profiles.workbuddy]
model = "glm-5.2"
model_provider = "workbuddy"
```

环境变量（有 Key 校验时填真实 Key）：

```bash
export CODEBUDDY2OPENAI_KEY='sk-wb-...'
```

启动：

```bash
codex --profile workbuddy "你的任务描述"
```

补充说明：

- 推荐保留 `--desensitize`
- 当前 `/v1/responses` 默认已经会做投影压缩
- 如果你想尽量保留原始 system prompt，可试 `--desensitize --no-compact`
- `--desensitize --no-compact` 下若仍命中审核，当前实现会自动退回紧凑模式重试一次

### Claude Code / CC Switch

Claude Code 不走 OpenAI 协议，而是走 Anthropic Messages。

推荐启动命令：

```bash
uv run python -m core.converter --desensitize --log converter.log
```

在 CC Switch 里配置：

```json
{
  "DeepSeek-V4-Pro": {
    "base_url": "http://127.0.0.1:8787/v1/messages",
    "api_key": "",
    "model": "deepseek-v4-pro"
  }
}
```

注意：

- 模型名必须填写腾讯后端支持的真实模型名
- 不做 Anthropic 模型名到腾讯模型名的自动映射
- Claude Code 场景强烈建议开启 `--desensitize`

### 其他 OpenAI 兼容客户端

适用于：

- Cherry Studio
- ZCode
- LobeChat
- NextChat
- Open WebUI
- 自己写的 OpenAI SDK 客户端

配置方式：

- Base URL: `http://127.0.0.1:8787/v1`
- API Key: 留空，或填你启动时设置的 `--api-key`
- 模型名: `glm-5.2` / `deepseek-v4-pro` / `kimi-k2.7` / `auto` 等

### DeepSeek VS Code 扩展（vizards.deepseek-v4-for-copilot）

这个扩展**不读任何模型列表接口**：它的窗口、输出上限、推理档位全部写死在
`out/consts.js` 里（`maxInputTokens: 655360`、`maxOutputTokens: 393216`、
`thinking.supportedEfforts: ['low','high','max']`），
`provideLanguageModelChatInformation()` 直接返回这份常量表。
所以「让 harness 自动读到真实元数据」在它身上做不到——不是配置问题，
是扩展本身没有这个能力。

能改的只有三个键：

```jsonc
{
  "deepseek-copilot.baseUrl": "http://127.0.0.1:8787/v1",
  "deepseek-copilot.maxTokens": 0,          // 0 = 不限制，交给上游默认
  "deepseek-copilot.modelIdOverrides": {    // 扩展写死的 id → 上游真实 id
    "deepseek-flash": "deepseek-v4.1-flash",
    "deepseek-v4-flash-vision-exp": "deepseek-v4-flash"
  }
}
```

Key 走命令面板的 `DeepSeek: Set API Key`（存在 VS Code SecretStorage），
填本服务的客户端 Key 即可；扩展发的是 `Authorization: Bearer <key>`。

它请求长这样（`provider/request.js`）：

```jsonc
{
  "model": "deepseek-v4-pro",
  "messages": [...],
  "stream": true,
  "thinking": { "type": "enabled" },        // 关思考时是 "disabled"
  "reasoning_effort": "high"                // 关思考时**整条不发**
}
```

`thinking` 对象上游不认，本服务会在 chat 路径上翻译成
`reasoning_effort`（`disabled` → `none`，`enabled` + `budget_tokens` 折档）。
`max` / `high` / `low` 三档上游均接受（实测 `max` 的 reasoning_tokens 还更深）。

⚠️ 注意两边对窗口的认知不一致：扩展以为是 655360 输入 token，
而本服务按 `product.json` 的真实值（`deepseek-v4-pro` = 1,000,000）推算投影预算，
上限 900,000 字符。真把 60 万 token 灌进去，转换器会按预算降级——
这不是扩展或转换器哪一方"错"，是两个数字本来就对不上。

---

## 模型元数据与推理等级

### `/v1/models` 返回的不只是名字

只给 `id/object/created/owned_by` 的话，harness 拿不到窗口和能力，会自己拿主意：

- 有的按保守默认值（常见 4k / 8k）压缩历史 —— **客户端自己就把长上下文截了**，
  看起来像转换器有问题
- 有的让用户手填 `maxInputTokens`，填小了一直报超限
- 推理等级无处可查，只能猜或干脆不发

所以现在每个模型都带真实元数据（来源是 WorkBuddy 的 `product.json`），
并按几套常见命名同时给出，客户端各取所需、多余字段自动忽略：

```json
{
  "id": "glm-5.2",
  "object": "model",
  "context_length": 1000000,
  "context_window": 1000000,
  "max_input_tokens": 1000000,
  "max_model_len": 1000000,
  "max_output_tokens": 64000,
  "max_completion_tokens": 64000,
  "top_provider": { "context_length": 1000000, "max_completion_tokens": 64000 },
  "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
  "capabilities": {
    "tool_calling": true, "vision": false,
    "reasoning": true, "reasoning_only": true, "can_disable_reasoning": false
  },
  "supported_parameters": ["tools", "tool_choice", "…", "reasoning_effort"],
  "reasoning": {
    "supported": true,
    "efforts": ["none", "minimal", "low", "medium", "high", "xhigh"],
    "default_effort": "medium",
    "summary": "auto",
    "reasoning_only": true
  }
}
```

另外提供 `GET /v1/models/{id}` 取单个模型详情（部分客户端先拉列表再逐个取）。

`context_length` 这类字段只在能读到 `product.json` 时才有；读不到不会编造数字，
此时只返回基础字段，客户端会退回它自己的默认值。

### 推理等级：三种写法都能到上游

| 客户端协议 | 请求里的写法 | 转换后 |
| --- | --- | --- |
| OpenAI Chat | `"reasoning_effort": "high"` | 原样透传 |
| OpenAI Responses | `"reasoning": {"effort": "high", "summary": "auto"}` | → `reasoning_effort` / `reasoning_summary` |
| Anthropic Messages | `"thinking": {"type": "enabled", "budget_tokens": 32000}` | 按预算折档：≥16000 high，≥4000 medium，其余 low |

`thinking.type = "disabled"` 会映射成 `reasoning_effort: "none"`（实测该值会让
`reasoning_tokens` 归零）。

**注意**：`reasoning_effort` 显式给了就以它为准，不再被 `reasoning` 对象覆盖。

不传推理参数时，上游可能完全不思考（实测 `reasoning_tokens=0`）——所以需要
模型"想一下"的场景，最好显式给一档。

### 输出长度：上游只认 `max_tokens`

直连上游做过对照（同一提示、同一模型）：

| 字段 | 上游行为 |
| --- | --- |
| `max_tokens: 16` | **生效**，`finish_reason=length`，正文 16 字符 |
| `max_completion_tokens: 16` | **被忽略**，照样输出 119 token |
| `max_output_tokens: 16` | **被忽略** |

新版 OpenAI SDK 默认发 `max_completion_tokens`，OpenRouter 系客户端习惯发
`max_output_tokens` —— 原样透传等于没设上限。所以三条入口都统一归一化到
`max_tokens`，多个值同时出现取**最小值**。

Responses 路径被截断时会返回 `status: "incomplete"` +
`incomplete_details.reason = "max_output_tokens"`，不再一律报 `completed`。

### ⚠️ 推理 token 会占用 `max_tokens`

上游把 `reasoning_tokens` 算进 completion tokens（和 OpenAI o 系一致）。实测：

```
max_tokens=4000 + reasoning_effort=high  → reasoning=4000，正文 0 字，finish=length
max_tokens=200  + reasoning_effort=high  → reasoning=30，正文 3 字
max_tokens=1200 + reasoning_effort=none  → reasoning=0，正文完整
```

也就是说**高推理强度 + 小输出上限 = 空回复**。这不是 bug，是预算被思考吃光了。
应对方式二选一：把 `max_tokens` 调大（至少留出思考空间），或者用
`reasoning_effort: "none"` 关掉思考。

排查时看 `usage.completion_tokens_details.reasoning_tokens`（Responses 是
`usage.output_tokens_details.reasoning_tokens`）——这个数字等于上限，就说明被吃光了。

---

## 上下文投影与预算

`/v1/responses` 上的 agent 请求（Codex CLI / VS Code Copilot 系）会先经过
`core/responses_projection.py` 投影成一份更紧凑的 Chat body，再发往上游。
这里有两个值得知道的机制。

### 装得下就「原样透传」，压缩只在真装不下时发生

这是本层最重要的原则：**客户端发来的内容只要塞得进总预算，就一个字节都不改。**

投影层先算一遍投影后的整体体积；如果 ≤ 总预算
（`_messages_size(conversation) <= total_budget_chars()`），就整段原样保留 ——
不切尾、不做历史摘要、不动工具输出。统计行里会打 `passthrough=True`。

只有真的超预算时，才降级为下面这套有损压缩：

- **尾部按条数/字符预算截取**，并保证「最新一条用户消息」一定被带上（anchor）。
- **被略去的历史**压成一段 `system` 摘要。
- **单条工具输出**超限时用 `_truncate_text()` 保留**首部 + 尾部**、只省略中段：

```
<首部 60%> ... [truncated 1234 chars] ...
<尾部 40%>
```

> 早期实现是 `text[:limit]`（只保头、尾部整段丢弃）。但 agentic 场景里判断下一步
> 所需的信息几乎都在尾部 —— 工具输出的报错与退出码、用户消息末尾的真实提问、
> 命令串最后那几条命令。丢尾会让模型以为上一步没有结果而**反复重跑同一个工具**。
> 实测同一段工具摘要（11,341 字符）在同样的 1,600 字符预算下：
> 旧实现留下 `line 8: zzzz...`，新实现留下 `... 1 Error(s) / Build FAILED.`。

> ⚠️ 但「保头保尾」本身也**不是**正确性的保证：只要发生截断，中段信息就是丢了。
> 所以真正的修法是上面的**透传** —— 让截断路径在绝大多数真实请求里根本不被走到。

### 总预算是「按模型窗口推导」的

各段字符/条数上限（`MAX_*`，见文件顶部）只是**下限/基准值**，实际生效值 =
`总预算 × 该段占比`（占比见 `BUDGET_SHARES`），且不低于基准值：

```
usable  = max(模型窗口 - 64,000 输出预留, 模型窗口 ÷ 2)
总预算  = usable × 2 字符/token，再封顶到 900,000
```

| 模型输入窗口 `maxInputTokens` | 总预算（字符） |
| --- | --- |
| 1,000,000（`glm-5.2` / `deepseek-v4-pro` / `kimi-k3-1`） | 900,000（撞安全上限） |
| 512,000（`minimax-m3`） | 896,000 |
| 200,000（`glm-5.1` / `glm-5v-turbo`） | 272,000 |
| 96,000（`deepseek-v3-1`） | 96,000 |
| 未知 / 无窗口信息 | 32,000（兜底，不反向收紧） |

- 窗口来自本机 WorkBuddy 的 `product.json`（`maxInputTokens`），
  由 `converter._model_input_tokens()` 读取并缓存；读不到就退回兜底值。
- `SAFETY_MAX_TOTAL_CHARS = 900,000` 是**实测**定的：直连上游 800,040 字符的工具
  输出，HTTP 200、22s，且模型能正确读到正中间的标记行。生产日志里最大的真实
  请求是 784,473 字符 —— 也就是说**全部真实流量都落在透传区间内**。
- 想手工缩放总预算：设环境变量 `CODEBUDDY2_PROJECTION_SCALE`（**乘数**，1.0 = 不干预）。

投影日志会打印该请求实际生效的预算与是否透传，可用于确认：

```
── RESPONSES PROJECTION ── mode=aggressive | passthrough=True | model_tokens=1000000
   | total_budget_chars=900000 | tool_output_limit=450000 | msgs 4→5 | chars 120331→120331 | ...
```

---

## 常用命令

### 基本启动

```bash
python3 -m core.converter
python3 -m core.converter --desensitize
python3 -m core.converter --desensitize --log converter.log
python3 -m core.converter --api-key mysecret
python3 -m core.converter --port 9000
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|------|------|
| `--host` | `127.0.0.1` | 监听地址 |
| `--port` | `8787` | 监听端口 |
| `--api-key` | 无 | 给本地客户端加一层鉴权 |
| `--log` | 无 | 记录请求与响应日志 |
| `--desensitize` | 关 | 压缩运行时提示、去掉 tool description、零宽脱敏高风险关键词 |
| `--no-compact` | 关 | 配合 `--desensitize` 使用，保留更完整的原始 system prompt |
| `--skip-check` | 否 | 跳过启动预检 |

### curl 示例

```bash
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}]}'

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","stream":true,"messages":[{"role":"user","content":"数1到5"}]}'
```

---

## 日志与排障

### 推荐启动方式

```bash
uv run python -m core.converter --desensitize --log converter.log
```

### 日志里能看到什么

每次请求都会带一个唯一 ID，常见日志包括：

- `REQUEST BODY`
- `RESPONSES → CHAT BODY`
- `RESPONSES PROJECTION`
- `RESPONSE BODY`
- `RESPONSE RAW SSE`
- `⚠️内容审核拦截`

其中 `RESPONSES PROJECTION` 会告诉你：

- 投影前后消息数
- 投影前后字符数
- tool schema 压缩量
- 是否丢掉了 harness 消息
- 是否保留了 anchor user

### 最常见问题

#### 找不到登录文件

说明桌面端没登录，或者登录目录不在默认路径。先确认桌面端已经真正完成登录。

#### 401

分两种：

- 本地 401：你启用了 `--api-key`，但客户端没带同一个 key
- 后端 401：腾讯 token 失效，尝试重新打开桌面端登录

#### 响应慢

先换快一点的模型，比如 `deepseek-v4-flash`。

#### 被“敏感内容”拦截

这是腾讯后端的内容审核，不一定是用户问题本身敏感，很多时候是 agent runtime 文本触发的，比如：

- `DoS`
- `exploit`
- `credential`
- `sandbox`
- `escalation`
- 竞争品牌词
- tool description 中的安全术语

建议排查顺序：

1. 开 `--log`
2. 看同一请求 ID 下的 `REQUEST BODY` 或 `RESPONSES → CHAT BODY`
3. 如果是 Codex CLI，再看 `RESPONSES PROJECTION`
4. 开 `--desensitize`
5. 如果还不稳，再尝试 `--desensitize --no-compact`

---

## 管理后台（可选）

除原转换器外，项目附带一个中文 Web 管理后台（`admin/`），适合服务器长期运行：

- 浏览器授权添加国内 CodeBuddy / WorkBuddy 账号，无需桌面端；多账号自动轮转、冷却与积分耗尽避让
- 凭据刷新、积分余额查询、每日自动签到（默认北京时间 09:00，可配置）
- 客户端 API Key 创建与撤销、真实模型连接测试
- 概览页：请求量、完成成功率、HTTP 成功率、平均耗时与最近 100 条请求

本地启动（需先安装依赖并设置至少 20 位的管理密钥）：

```bash
export ADMIN_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(36))")
export CODEBUDDY2OPENAI_KEY=sk-wb-$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
python3 -m admin.server
```

然后访问 `http://127.0.0.1:8787/admin/`。一键 Docker 部署见下文；详细说明见 [ADMIN_README.md](ADMIN_README.md)。

> 管理后台为单进程设计，正式对外部署必须放在 HTTPS 反向代理之后（示例：`deploy/admin/nginx.conf.example`）。直接运行 `python3 -m core.converter` 的原有用法不受影响。

---

## Docker 部署

如果你更习惯用 Docker，可以直接用。

前提是把宿主机登录态目录挂进去，因为容器里拿不到桌面端 auth 文件。

### 一键部署（推荐，含管理后台）

一条命令完成密钥生成、镜像构建与启动：

```bash
bash deploy/one-click/deploy.sh
```

脚本会自动生成 `ADMIN_KEY` 与客户端 Key（保存在 `deploy/one-click/.env`，仅首次显示），随后访问 `http://127.0.0.1:8787/admin/`。改端口：编辑 `deploy/one-click/.env` 里的 `PORT` 后重跑脚本。

### docker compose（独立转换器）

先改 `deploy/standalone/docker-compose.yml` 里的 auth 挂载路径，再执行：

```bash
docker compose -f deploy/standalone/docker-compose.yml up -d --build
```

### docker run（独立转换器）

```bash
docker build -t workbuddy2api -f deploy/standalone/Dockerfile .

docker run -d --name workbuddy2api -p 8787:8787 \
  -v ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth:/data/auth:ro \
  -e CODEBUDDY_AUTH_DIR=/data/auth \
  workbuddy2api
```

### 相关环境变量

| 变量 | 说明 |
|------|------|
| `CODEBUDDY_AUTH_DIR` | 指定登录态目录 |
| `CODEBUDDY2OPENAI_KEY` | 本地 API Key |
| `CODEBUDDY2OPENAI_LOG` | 日志路径 |
| `CODEBUDDY2_PROJECTION_SCALE` | `/v1/responses` 投影**总预算的乘数**（1.0 = 不干预）。不设则按模型 `maxInputTokens` 自动推导；内容装得下总预算时原样透传，不做任何截断 |

---

## 模型列表

当前内置默认模型列表：

`hy3`、`hy4-preview`、`kimi-k3`、`kimi-k2.8-preview`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`kimi-k2.7`、`kimi-k2.6`、`kimi-k2.5`、`deepseek-v4-pro`、`deepseek-v4.1-flash`、`deepseek-v4-flash`、`minimax-m3-pay`、`hy3-preview-agent`、`auto`

> 本机装有 WorkBuddy 时优先使用其动态模型目录，上表为兜底列表。具体能不能用，取决于你的 WorkBuddy / CodeBuddy 订阅与上游状态。

---

## 项目结构

```text
workbuddy2api/
├── core/                      # 协议转换核心
│   ├── converter.py           # 主入口，FastAPI 服务（python3 -m core.converter）
│   ├── responses_adapter.py   # OpenAI Responses ↔ Chat 适配
│   ├── responses_projection.py# Codex / agent 请求投影压缩
│   ├── anthropic_adapter.py   # Anthropic Messages ↔ Chat 适配
│   └── desensitize.py         # 运行时文本压缩与零宽脱敏
├── admin/                     # 中文管理后台（可选，python3 -m admin.server）
│   ├── server.py              # 管理 API、会话与静态页面
│   ├── pool.py                # 账号池轮转、冷却、积分与签到
│   ├── browser_login.py       # 浏览器授权登录
│   ├── metrics.py             # 请求统计
│   └── static/                # 前端资源
├── deploy/                    # 部署
│   ├── standalone/            # 独立转换器（Dockerfile + compose）
│   ├── admin/                 # 管理后台（Dockerfile + compose + nginx 示例）
│   └── one-click/             # 一键式部署（deploy.sh 自动生成密钥并启动）
├── tests/                     # 单元测试（pytest）
├── codex-codebuddy.example.toml
├── README.md
└── LICENSE
```

运行测试：

```bash
python3 -m pytest tests/
```

---

## 致谢

本项目基于 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai) 的思路演进而来，感谢原作者的开源贡献。

## 免责声明

本项目仅用于个人学习与研究。与腾讯、WorkBuddy、CodeBuddy、OpenAI、Anthropic 无官方关联。请仅在你合法拥有订阅的前提下使用，并自行承担风险。

## 开源协议

[MIT](./LICENSE)

---

<a name="english"></a>
## English

`workbuddy2api` exposes your already logged-in **WorkBuddy / CodeBuddy** desktop session as local **OpenAI- and Anthropic-compatible APIs**.

Supported endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`

Recommended use cases:

- **Codex CLI** via `/v1/responses`
- **Claude Code / CC Switch** via `/v1/messages`
- **Cherry Studio / ZCode / LobeChat / Open WebUI** via `/v1/chat/completions`

### Quick Start

```bash
git clone https://github.com/ShouZhuo0413/codebuddy2openai.git workbuddy2api
cd workbuddy2api

uv venv
uv pip install -r requirements.txt
uv run python -m core.converter --desensitize --log converter.log
```

Then verify:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

### Codex CLI

Use `/v1/responses` and keep `--desensitize` enabled.

```toml
[model_providers.workbuddy]
name = "WorkBuddy (via local converter)"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "CODEBUDDY2OPENAI_KEY"

[profiles.workbuddy]
model = "glm-5.2"
model_provider = "workbuddy"
```

Run:

```bash
export CODEBUDDY2OPENAI_KEY="sk-wb-..."   # a real key: a placeholder gets 401
codex --profile workbuddy "your task"
```

> **Note (codex-cli 0.162.0-alpha.17.2)**: `--profile` now means
> "layer `$CODEX_HOME/<name>.config.toml` on top of `config.toml`" — it is
> **not** the `[profiles.x]` block shown above. See the Chinese section above
> for the recommended layout, and for why `model_context_window` can only
> lower the window, never raise it.

### Claude Code / CC Switch

Use `/v1/messages`:

```json
{
  "DeepSeek-V4-Pro": {
    "base_url": "http://127.0.0.1:8787/v1/messages",
    "api_key": "",
    "model": "deepseek-v4-pro"
  }
}
```

### Notes

- `--desensitize` is recommended for both Codex CLI and Claude Code
- `/v1/responses` already applies backend-facing projection by default
- `--desensitize --no-compact` preserves more of the original system prompt
- if that still gets review-blocked, `/v1/responses` will retry once in compact mode
- an optional Chinese web admin console (`python3 -m admin.server`, see [ADMIN_README.md](ADMIN_README.md)) adds browser-based account authorization, multi-account rotation, client API keys, daily check-in and request metrics; one-command Docker setup: `bash deploy/one-click/deploy.sh`

### CLI Options

```bash
python3 -m core.converter [--host HOST] [--port PORT] [--api-key KEY] [--log PATH] [--desensitize] [--skip-check]
```

### Disclaimer

For personal learning and research only. Not affiliated with Tencent, WorkBuddy, CodeBuddy, OpenAI, or Anthropic.

---

<sub>
Keywords: codebuddy to openai · codebuddy2openai · workbuddy api proxy · workbuddy openai adapter · codex cli workbuddy · claude code workbuddy · tencent code assistant openai compatible api
</sub>
