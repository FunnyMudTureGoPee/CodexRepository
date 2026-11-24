# ChatLuna 工具归档

这三个独立项目来自本机留存的源码。目录中的版本号沿用原项目，归档不代表原作者的正式发布，也不会自动部署到 Koishi。

| 项目 | 版本 | 用途 | 构建与验证 |
| --- | --- | --- | --- |
| [ChatLuna Mail MCP](koishi-plugin-chatluna-mail-mcp/README.md) | 0.7.3 | 定时邮件 MCP 与 Koishi 控制台 | Node.js 20+，安装依赖后运行 `pnpm check` |
| [ChatLuna Lyrics MCP](koishi-plugin-chatluna-lyrics-mcp/README.md) | 0.1.1 | 通过 MCP 只读查询 Koishi 数据库中的歌词 | Node.js 18+，安装依赖后运行 `pnpm check` |
| [歌词抓取工具](lyrics-crawler/README.md) | 0.1.0 | 生成可供 Lyrics MCP 导入的 JSONL | Python 3.10+，运行 `python -m lyrics_crawler --help` |

两个插件分别进入项目目录安装和检查。

```powershell
pnpm install --frozen-lockfile
pnpm check
```

版本依据、归档范围和许可状态见各项目的来源说明。[邮件插件](koishi-plugin-chatluna-mail-mcp/PROVENANCE.md) · [歌词插件](koishi-plugin-chatluna-lyrics-mcp/PROVENANCE.md) · [抓取工具](lyrics-crawler/PROVENANCE.md)
