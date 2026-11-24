---
name: context-window
description: 在用户需要查看或调整 Codex 本机上下文窗口、打开 256k 到 1024k 滑动条或恢复默认 512k 时使用。
---

使用本插件的 `open_context_window` 工具显示滑动条。
用户指定具体数值时，先使用 `read_context_window` 获取最新 revision，再调用 `set_context_window`；window_k 是整数，范围 256 到 1024，1k = 1,000 tokens。
默认值为 512k。仅打开或读取面板不保存设置；面板中的应用按钮执行保存。
说明这是本机 config.toml 的上下文窗口设置，不能突破模型容量，不保证影响当前聊天。保存后重启 Codex 并新建聊天；项目和配置档中的覆盖值可能优先。
不得声称已扩容模型或已验证当前会话使用新容量。不要修改用户的其他 Codex 配置或自动压缩阈值。
