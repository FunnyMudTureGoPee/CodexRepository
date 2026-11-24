# AI / Agent 源码归档

按用途整理 Codex 插件、技能、MCP/API 接入和 DSH 扩展。快照日期为 2026-11-24，保留源文件字节、原有版本、作者与许可。

| 目录 | 内容 |
| --- | --- |
| [plugins](plugins/) | subagent-budget-router、codex-context-window、codex-trace-viewer、memory-workbench、ai-image-denoise-director、chat-image-bridge，6 个本地／个人插件源码 |
| [skills](skills/) | btw、plan-module-change、pragmatic-coding、live2d-agent-kit、gpt-image、unity-mcp-skill，6 个非系统技能源码 |
| [integrations](integrations/) | WorkBuddy API 适配及其有效本地修改、CPA 部署脚本和模板 |
| [extensions](extensions/) | DSH Market Insight 与 Model Picker 两个扩展 |
| [tools](tools/) | Gemini API 测试工具 |

ChatLuna 三个项目分别放在独立的 [ChatLuna 分支](https://github.com/FunnyMudTureGoPee/CodexRepository/tree/feature/chatluna/projects/chatluna)。

## Agent 工程与完整资源入口

| 工程／资源 | 来源 |
| --- | --- |
| Experience Runtime | [上游源码](https://github.com/Jouryane/experience_runtime)，扫描时本地没有业务源码差异 |
| DSH Desk | [上游源码](https://github.com/majiayu000/dsh-desk)，扫描时本地工作区干净 |
| DeepSeek Harness | [上游源码](https://github.com/deepseek-ai/deepseek-harness) |
| WorkBuddy / CodeBuddy API | [上游源码](https://github.com/ShouZhuo0413/codebuddy2api)，本目录保留当前有效本地修改 |
| Live2D Agent Kit 完整示例与素材 | [上游项目](https://github.com/Ariakage/live2d-agent-kit)，素材遵循其独立许可 |
| GPT Image 工具 | [原技能／CLI 项目](https://github.com/wuyoscar/gpt_image_2_skill) |

上述本地 Git 工程的精确来源提交见 [UPSTREAM-PROJECTS.json](UPSTREAM-PROJECTS.json)。论文原文、译本 PDF、图像和完整本地资料包继续保存在本机审查目录对应的来源位置；本次公共仓库只保存工具源码与来源索引。

文件 SHA-256 见 [SOURCE-MANIFEST.json](SOURCE-MANIFEST.json)，归档检查见 [PUBLICATION-REVIEW.md](PUBLICATION-REVIEW.md)。各目录按原 README / SKILL.md 使用，保留原许可证；未声明许可的组件不在归档时补授许可。

这是源码归档，不是已安装状态或完整二进制分发；图像、模型示例、SDK、权重和实际凭据不随此快照上传，需要时从原项目取得并遵循其许可。归档不改变本机插件启用状态，不自动部署服务。
