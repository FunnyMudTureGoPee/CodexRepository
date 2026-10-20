# 0.6.2 修复说明（2026-10-19）

## ChatLuna 上下文误判为空

症状：任务可以选取会话元数据，但试判断返回 No readable text in context；诊断工具只返回 OPERATION_REJECTED。

根因已通过已安装 ChatLuna 源码及真实 SQLite 数据只读检查确认：
ChatLuna listMessages 返回原始 MessageRecord。当前版本将 JSON 消息正文 gzip 压缩写入二进制 content，text 可以为 null。
邮件插件此前只筛选 text，未解码 content，因此将已有文字记录误判为空。原有模拟测试只覆盖了 text 格式，漏掉了正式压缩格式。
这不是沙盒缺少聊天记录或消息尚未落库的证据，也不需要为了修复此错误接入 QQ。

只读检查当时，绑定会话当前分支有 131 条记录，text 非空数量为 0；131 条压缩正文均可解码，其中 95 条包含文字。
修复后的 Node 解码器对真实数据得到相同结果。未输出聊天正文或凭据，也没有请求 LLM 或 SMTP。

修复：
- 按 ChatLuna 写入协议解码 gzip JSON content，支持 Buffer / ArrayBuffer / 带偏移的二进制视图及 base64。
- 正文支持字符串或多模态内容中的 text 段落；不读取图片链接、思考块及工具参数作为正文，不执行上下文指令。
- 保留旧 text 记录兼容；content 无法解码但有旧 text 时沿用旧字段。
- 先沿 latestMessageId 确定当前分支再解码，其他分支不加入上下文。
- 解码限额：单条压缩和解压后正文均为 1 MiB，累计解码 8 MiB；超限停止，不影响既有最终提示词字符预算。
- 诊断中增加 contextStorage 计数；真正为空、无文字、解码失败及超限分别返回 CONTEXT_EMPTY / CONTEXT_TEXT_UNAVAILABLE / CONTEXT_DECODE_FAILED / CONTEXT_STORAGE_LIMIT，不再统一遮蔽为 OPERATION_REJECTED。
- 任务仍沿用原会话、预设、模型及当前启停状态，不自动启用或删除排查任务。

实际模型接口、预设渲染、SMTP 和收件情况仍需升级后业务联调；真实数据解码成功不等同于完整发信链路验收成功。

## 邮件预览页签

邮件预览只在模板页签渲染。离开模板页签会移除预览 iframe，切回时保留预览状态。
执行记录中的“预览草稿”会跳转至模板页；试判断生成草稿后提供“查看邮件预览”入口，不在其他页签常驻。

隔离浏览器实测：模板页预览 iframe 数量 1；任务/模型设置/执行记录/运行维护页均为 0；切回模板页恢复为 1。

## 升级

安装 dist/koishi-plugin-chatluna-mail-mcp-0.6.2.tgz，重启插件并 Ctrl+F5 刷新 Console，重新连接 MCP。
也可运行项目 scripts/install.ps1，它自动按 package.json 寻找当前版本安装包并支持 Koishi 自带运行时。

```powershell
& "D:\AI\文献\koishi-plugin-chatluna-mail-mcp\scripts\install.ps1"
```

升级后先在任务仍停用的情况下执行上下文诊断；诊断不请求模型生成。再按业务需要执行试判断（会调用模型但不自动发信），确认后启用计划。
本次没有更新正在运行的 Koishi 实例，没有改变业务数据库或三个任务的停用状态。

## 验收

49 项测试、前后端 TypeScript、构建通过；全部测试在 Koishi Node 20.12.2 下通过；构建入口加载通过。
新增压缩格式、旧 text、混合文本、损坏数据、解压限额、分支隔离、单模型调用及 HTTP MCP 上下文错误码回归。
预览页签在隔离管理页逐项验证，未使用真实邮箱或模型。
