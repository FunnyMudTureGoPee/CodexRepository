# koishi-plugin-chatluna-lyrics-mcp

一个面向 ChatLuna Agent 的本地、只读歌词 MCP 服务。插件复用 Koishi
数据库与 HTTP 服务，不启动额外数据库、端口或常驻进程。

## 功能

- Streamable HTTP MCP：`/mcp/lyrics`
- 歌名、歌手、专辑与歌词片段检索
- 按歌曲 ID 获取纯文本或原始 LRC
- CSV、JSONL、NDJSON 与 LRC 目录导入
- staging 导入、原子切换、合并、回滚与历史清理
- 可选复用 ChatLuna Embeddings 和向量数据库
- 默认只允许本机访问；可配置 Bearer Token

插件不包含歌词抓取器，也不附带歌词数据库。请只导入你有权使用的数据。

## 依赖

- Node.js 18 或更高版本
- Koishi 4.18.9 或兼容版本
- 已启用 Koishi `database` 和 `server` 服务
- ChatLuna Agent；只有启用语义检索时才需要 ChatLuna Embeddings 和向量库

推荐使用 Koishi SQLite。插件通过 `ctx.database` 访问数据，也兼容 Koishi 的
MySQL、PostgreSQL 和 MongoDB 驱动接口。

## 构建与安装

在 Windows PowerShell 中执行：

```powershell
.\scripts\build.ps1
```

构建产物位于 `dist/`。安装到现有 Koishi 项目：

```powershell
.\dist\install.ps1 -KoishiDir "D:\path\to\koishi"
```

安装脚本只安装本地 `.tgz`，不会修改 `koishi.yml`。随后在 Koishi 控制台中启用
`chatluna-lyrics-mcp`。

## 插件配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `/mcp/lyrics` | MCP HTTP 路径 |
| `token` | 空 | 可选 Bearer Token |
| `allowRemote` | `false` | 是否允许非回环地址访问 |
| `queryTimeoutMs` | `3000` | 歌词正文查询超时 |
| `maxResults` | `20` | 单次查询硬上限 |
| `retainVersions` | `1` | 清理时保留的归档版本数 |
| `semanticEnabled` | `false` | 是否启用语义索引 |
| `embeddings` | 空 | ChatLuna 嵌入模型完整名称 |
| `vectorStore` | `luna-vdb` | ChatLuna 向量库名称 |

如果 Koishi 监听在 `0.0.0.0`，插件仍会默认拒绝非本机 MCP 请求。若确实需要远程
访问，应同时启用 `allowRemote` 和强随机 `token`，并在反向代理层增加访问控制。

## 导入格式

### CSV

CSV 第一行必须是列名。支持：

```text
id,title,artist,album,language,lyrics,lrc,source
```

必填字段为 `title`、`artist`，以及 `lyrics` 或 `lrc` 之一。示例位于
`examples/lyrics.csv`。

### JSONL / NDJSON

每行是一个对象：

```json
{"id":"song-1","title":"歌名","artist":"歌手","album":"专辑","lyrics":"第一行\n第二行","language":"zh"}
```

### LRC 目录

插件递归读取 `.lrc` 文件，优先读取 `[ti:]`、`[ar:]`、`[al:]` 标签。缺少标签时，
使用文件名作为歌名、直接父目录名作为歌手。

## 管理命令

所有管理命令要求 Koishi 权限等级 4，不会暴露给 MCP Agent。

```text
lyrics.validate <path>
lyrics.replace <path>
lyrics.merge <path>
lyrics.import <path> --mode replace
lyrics.import <path> --mode merge
lyrics.status
lyrics.rollback
lyrics.cleanup
lyrics.semantic-reindex
```

- `replace`：写入新 staging 数据集，校验成功后原子切换。
- `merge`：先复制当前活动版本，再合并输入并切换，不会原地修改活动数据。
- 导入失败：删除 staging 歌曲并记录失败原因，原活动版本继续提供服务。
- `rollback`：切回最近一个归档版本。
- `cleanup`：保留活动版本和配置数量的历史版本，删除其他数据。

路径中包含空格时请使用引号。

## ChatLuna Agent 配置

在 ChatLuna Agent WebUI 的 MCP 页面新增服务器：

```json
{
  "name": "lyrics",
  "type": "http",
  "url": "http://127.0.0.1:5140/mcp/lyrics",
  "headers": {
    "Authorization": "Bearer replace-with-your-token"
  }
}
```

如果插件 `token` 为空，应删除 `headers`。保存后确认状态为 `connected`，再在工具
列表中启用需要的工具。

本插件只使用 Streamable HTTP 的请求/响应模式，不提供服务端主动通知，因此对可选的
GET SSE 通道返回 `405 Method Not Allowed`。这是预期行为，可避免空闲长连接被服务器
定时关闭后导致 ChatLuna 周期性重连；POST 工具调用不受影响。

MCP 工具：

- `search_songs`：检索并返回歌曲摘要和匹配歌词片段。
- `get_lyrics`：获取指定歌曲的完整歌词。
- `get_lyrics_database_status`：查看当前数据集状态。
- `semantic_search_lyrics`：仅当语义索引已就绪时出现。

建议让 Agent 先调用 `search_songs`，取得歌曲 ID 后再调用 `get_lyrics`，避免一次
搜索把大量完整歌词送入模型上下文。

## 可选语义检索

1. 安装并配置 ChatLuna Embeddings。
2. 安装并配置 `chatluna-vector-store-service`，低配置单机可选 `luna-vdb`。
3. 在本插件中启用 `semanticEnabled`，填写嵌入模型名称和向量库名称。
4. 新数据集会在 staging 阶段先构建独立索引，成功后才切换；已有数据集可执行
   `lyrics.semantic-reindex`。

每个数据集使用独立索引键。索引构建失败只会把语义状态标记为 `failed`，不会影响
普通歌词查询，原活动数据集也不会被替换。更换嵌入模型或向量库后必须重新构建索引；
重建使用新的索引键，失败时不会破坏旧索引。

十万首歌词的向量索引可能消耗数百 MB 内存和大量嵌入额度，因此默认关闭，并限制
每首歌的最大切片数。

## 开发验证

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

十万首模拟数据的压力检查默认跳过，按需运行：

```powershell
$env:LYRICS_BENCHMARK = '1'
pnpm test
```

还可以使用 MCP Inspector 连接：

```text
http://127.0.0.1:5140/mcp/lyrics
```
