# Chat Image Bridge

Chat Image Bridge 让 Codex 将图片生成任务加入队列，再由 Chrome 或 Edge 扩展使用你已经登录的 ChatGPT 网页完成生图。生成结果会先进入待审核状态，只有调用 `accept_image` 后才会写入项目。

本插件属于个人本地浏览器自动化工具，并非 ChatGPT Web 官方 API。ChatGPT 网页结构发生变化后，浏览器适配代码可能需要更新。

## 功能

- Codex 只负责提交任务，不需要持续操作或等待网页。
- 使用普通 ChatGPT Web 会话完成图片生成。
- 图片写入前保留人工审核环节。
- 仅允许把图片写入调用时声明的项目根目录以内。
- 每次接受图片时，自动在 `<项目根目录>/.assets/images/` 中保存编号版本。

## 安装浏览器扩展

浏览器扩展无需从商店下载，需要以“已解压的扩展程序”方式加载。

### Chrome

1. 在地址栏打开 `chrome://extensions/`。
2. 打开页面右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择目录：

   ```text
   C:\Users\2033\plugins\chat-image-bridge\extension
   ```

5. 确认扩展列表中出现 **Chat Image Bridge**，并保持启用。
6. 建议点击浏览器工具栏的扩展按钮，把 Chat Image Bridge 固定到工具栏。

### Microsoft Edge

1. 在地址栏打开 `edge://extensions/`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择目录 `C:\Users\2033\plugins\chat-image-bridge\extension`。
5. 确认扩展已启用，并将其固定到工具栏。

## 首次连接

1. 首次安装或升级后，以当前用户运行 `scripts/install-windows-daemon.ps1`。它会注册并启动名为 `ChatImageBridge` 的 Windows 登录任务，使本地服务不依赖某个 Codex 会话。使用 `scripts/install-windows-daemon.ps1 -Uninstall` 可移除该任务。
2. 新建一个 Codex 任务。旧任务不会自动加载刚安装或更新的插件。在新任务中要求 Codex 使用 Chat Image Bridge；插件也会尝试唤醒已注册的后台任务。
3. 打开 `C:\Users\2033\.chat-image-bridge\token` 并复制其中的令牌。如果文件尚不存在，先在新的 Codex 任务中使用一次插件。
4. 点击浏览器工具栏中的 Chat Image Bridge 图标。
5. 将令牌粘贴到 **Bridge token**，勾选 **启用任务轮询**，点击 **保存并检查**。
6. 扩展会选定一个专用 ChatGPT 标签页（没有可用页面时会自动创建）；请在该页确认已经登录。
7. 弹窗中的 Bridge 服务、Token、专用标签页和页面脚本均显示正常，并且任务为 `idle` 时，说明连接成功。

令牌仅用于保护本地桥接服务，不要将它发送给他人或写入项目代码。

## 使用流程

在新的 Codex 任务中可以这样说：

> 使用 Chat Image Bridge 为当前项目生成一张 16:9 的首页 Hero 插画，人物靠右，左侧留出标题区域，输出到 public/assets/generated/hero.png。

插件提供以下工具：

- `generate_image`：提交新的文字提示生图任务。
- `get_image_status`：查看任务状态。
- `open_image_manager`：在 Codex 对话中打开交互式任务管理器。
- `accept_image`：接受待审核图片，写入目标路径并保存历史版本。
- `cancel_image`：取消尚未完成的任务。

任务管理器每 5 秒自动刷新，可直接接受待审核图片、重新排队失败任务或取消未完成任务。你可以对 Codex 说：“打开 Chat Image Bridge 图片任务管理器”。

任务状态：`pending` 表示等待扩展；`generating` 表示正在生图；`review` 表示等待确认；`completed` 表示已写入项目；`failed` 表示自动化失败；`cancelled` 表示已取消。

扩展不会自动接受候选图片。设计结果需要由用户确认后，Codex 才应调用 `accept_image`。

## 当前 MVP 限制

- 当前版本只支持纯文字提示生图。
- 参考图上传与图生图尚未开放；工具能力声明中不会暴露这些能力，传入参考图也会立即拒绝。
- ChatGPT Web 没有为此用途提供正式 API，因此网页更新可能导致输入框、发送按钮或图片识别失效。
- 为避免串单，同一 Bridge 实例同一时间只持有一个带服务端租约的任务。

## 故障排查

### 弹窗提示需要设置令牌

检查 `C:\Users\2033\.chat-image-bridge\token` 是否存在，把完整内容重新复制到扩展弹窗并保存。

### 弹窗提示打开 ChatGPT 标签页

打开 `https://chatgpt.com/` 并确认登录。扩展会记住所选的专用标签页，不会操作其他普通聊天页；专用页关闭后会重新选择或创建。

### 弹窗提示桥接服务不可用

运行 `scripts/install-windows-daemon.ps1`，然后在扩展弹窗点击“保存并检查”。还应检查任务计划程序中的 `ChatImageBridge` 以及安全软件是否阻止了 `127.0.0.1:47831`。

### ChatGPT 已生成图片，但任务没有进入 review

0.3.0 只观察本次新出现的 assistant 回复，并使用 `jobId + leaseId + runId + tabId` 校验回调。若仍失败，请查看弹窗中的机器错误码，并在扩展管理页打开错误详情。

### 修改扩展文件后没有生效

回到浏览器扩展管理页，点击 Chat Image Bridge 卡片上的“重新加载”，然后刷新 ChatGPT 标签页。

## 文件位置

- 个人插件源码：`C:\Users\2033\plugins\chat-image-bridge`
- 浏览器扩展：`C:\Users\2033\plugins\chat-image-bridge\extension`
- 本地任务和候选图片：`C:\Users\2033\.chat-image-bridge`
- 工作区开发副本：`D:\AI\文献\plugins\chat-image-bridge`
