# Codex 运行轨迹

Windows 本地插件，读取 Codex 已写入磁盘的会话事件，按轮次显示输入、助手消息和工具时间轴。点击色条可以定位到事件，关键词和标签可以组合筛选。「跟随最新轮次」配合自动刷新，大约每 3 秒检查一次当前会话。

## 在 Codex 中打开

注册包含 `.agents/plugins/marketplace.json` 的源码目录，并安装插件。以下命令在该目录运行。

```powershell
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-trace-viewer@codex-trace-local
```

重新打开 Codex 后，在会话的内容标签菜单寻找「运行轨迹」，或在聊天里调用插件的 `open_trace` 工具。会话自动定位取决于宿主提供的会话 ID。也可以从列表选择，或通过「按 ID 打开」查看本机留存的旧会话。

## 本地浏览器入口

在插件目录运行以下命令，打开终端打印的地址。按 Ctrl+C 结束服务。它只监听 `127.0.0.1`，每次启动使用新的随机访问路径。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Browser
```

插件使用 Node.js 22+，优先使用 Codex 提供的 Node 路径或本机的 Codex 运行时，然后查找 PATH。会话目录默认为 `%USERPROFILE%\.codex`，支持 `CODEX_HOME`。

## 标签依据

- **插件调用**：已记录的 MCP 调用，且来源可以对应到插件或连接器。其他 MCP 调用显示服务器和工具名。
- **插件提及**：用户消息中有插件的 @ 引用。
- **批次**：Codex 的 `functions.exec` 包装层。独立记录的 MCP 调用会作为单独一行显示，顶部的 MCP 数字是工具数的子集。
- **Skill · 已加载**：会话记录有带名称与路径的 Skill 注入块。
- **Skill · 读取线索**：日志记录了成功的 Shell 命令，其中出现了 Skill 文件路径和读取命令。标签表示文件读取线索。
- **失败**：展开该行可查看错误、退出码与日志片段，并复制日志。搜索也会匹配错误内容。

界面显示公开消息摘要、工具名、状态和时长。失败日志使用会话里留存的错误片段，保留换行并掩盖常见密钥与凭据格式。浏览器入口和 MCP 服务都在本机运行。可见范围取决于客户端实际记录的事件。单轮界面最多显示 800 条，工具包装层内缺少独立事件的调用只能显示包装层，云端会话需要先在本机产生会话日志。
