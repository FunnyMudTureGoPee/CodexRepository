# Codex 上下文窗口

本地 MCP 插件，在 Codex 插件应用菜单及聊天内容页提供滑动条。

- 范围：256k–1024k，步长 1k，1k = 1,000 tokens。
- 初始默认：512k；已有设置会在面板中读取并显示。
- 拖动只选择数值，点击「应用」才保存；「恢复 512k」恢复默认选择。
- 保存到 `CODEX_HOME/config.toml`（未设置 CODEX_HOME 时使用用户目录下 `.codex/config.toml`）中的顶层 `model_context_window`。
- 保留其他配置、注释和配置档；修改前创建 `config.toml.context-backup-*` 备份。
- 配置在其他位置变化时会拒绝覆盖，重新读取后可再次保存。

保存配置不代表当前会话容量已改变。保存后重启 Codex 并新建聊天；项目、配置档或启动参数的覆盖值仍可能优先。此插件不改变模型实际容量，也不修改自动压缩阈值。

要求：本机 Python 3.11+，Codex 桌面版支持 MCP Apps。

通过本地 marketplace 安装后，可从插件应用入口打开「上下文窗口」，或对 Codex 说「打开上下文窗口滑动条」。

源码测试：`python -B -m unittest -v test_settings.py`。

依据：[官方 Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)和 [MCP Extensions](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)。
