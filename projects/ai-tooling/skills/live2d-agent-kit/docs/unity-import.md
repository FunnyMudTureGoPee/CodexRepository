# PSD2Live → Unity 导入与验收

用于把已有 Live2D 工程导出到 Unity，也用于定位「没有生成 Prefab」「组件齐全但动作播不起来」。按导出文件、Core、Unity 导入、运行时播放四层留证。下文的版本和故障样本来自 EatEatSing，换项目时先核对当前版本与路径。

## 1. 从源工程导出到隔离目录

1. 确认可编辑源档、PSD2Live 版本和目标 Unity 工程当前使用的 Cubism SDK/Core。先从 Unity MCP 列出实例并核对项目路径、版本、编辑状态，再选择目标。用户要求仅通过 MCP 操作 Unity 时，刷新、导入、场景保存和 Play Mode 都走 MCP。
2. 复制源档或使用独立工作副本。用 PSD2Live 已有的 CLI 或 MCP 导出到 Assets 之外的空目录。使用 MCP 时先查当前 schema。已验证的 PSD2Live 3.6.7 接口为 `settings_update(changes={"runtimeTarget":"Cubism53"})` 和 `project_export_target("moc3", ...)`，动作、物理和其他可选资源按源档与任务保留。诊断版本差异时，保持源档、导出选项相同，再单独导出一份 `Cubism50` 对照。
3. 以 `*.model3.json` 为运行包入口，核对它引用的 `.moc3`、贴图、动作、表情、物理等文件。记录源档、导出版本、Core 版本与候选文件 SHA-256。`.cmo3` 是可编辑源文件，Unity Prefab 由运行包生成。

## 2. 先用目标项目的官方 Core 验证

- 对候选 MOC 使用匹配目标平台和架构的官方 Core，按 Core 的内存对齐要求调用 `csmHasMocConsistency`，再用 `csmReviveMocInPlace` 验证可加载。诊断时以同一 Core 校验官方样例或已知可用文件，排除 Core 载入、位数与版本问题。
- 若 5.0 通过、5.3 失败，先检查 5.3 导出产物。EatEatSing 实测 PSD2Live 3.6.7 在有 Part、无离屏对象的 MOC3 v6 里，漏写 `OFFSCREEN_BY_PART` 与 `OFFSCREEN_BY_PART_ALIAS`。修复仅适用于符合这个二进制布局的文件。项目的 `Tools/repair-psd2live-cubism53.py` 会拒绝已通过校验、布局不同或含离屏对象的输入。其它失败保留原件，回到导出器或 Core 兼容性排查。

```powershell
python Tools/repair-psd2live-cubism53.py "<原始 5.3 moc3>" "<新的修复输出 moc3>" --core "<目标项目的官方 Windows x64 Cubism Core DLL>"
```

修复脚本核对源文件失败和输出一致性通过，独立的加载检查仍按上一条执行。对照项目现有包的配套文件哈希。只有 MOC 字节变化时，只替换 MOC。贴图或 JSON 也变化时，按 `model3.json` 的引用更新对应文件并重新核对整包。

## 3. 通过 Unity MCP 更新并检查生成结果

1. 在 Edit Mode 记录当前模型路径、现有 Prefab GUID 和场景引用。覆盖已有资源时保留 `.meta`，留好旧 MOC 或旧包用于回退。新建模型时以独立模型目录导入完整运行包。
2. 先导入替换的 MOC，再强制重导入 `*.model3.json`。等待编译和资源导入完成，查看 Unity Console，确认 SDK 生成的 Prefab、`CubismModel.Moc.Version` 及原有 GUID。Cubism 5.3 的 MOC 版本号为 6。Prefab 生成失败时，检查 JSON 引用和导入器报错，再按报错检查 SDK/Core 的平台配置。仅在 Prefab 生成后继续诊断渲染管线。
3. 检查 `CubismModel`、渲染和更新组件，以及模型有对应资源时的动作、淡入淡出、物理和表情组件及其资产引用。代码驱动的 Cubism Original Workflow 使用 `CubismMotionController`，其 Animator 的 Runtime Animator Controller 应为空。
4. 核对测试场景绑定到该角色的非 Legacy `.anim`。第三方 Legacy 动画报错时改场景绑定，保留原动画的导入属性。遇到 `Not found motion from CubismFadeMotionList` 时，用动作片段里的 `InstanceId` 事件逐一核对本模型列表的 ID 和非空淡入淡出数据，再查动作和模型的重导入是否能保留关联。
5. PSD2Live 的平铺目录是一个已验证的分支。EatEatSing 的 `Assets/Live2D/Cubism/Framework/MotionFade/Editor/CubismFadeMotionImporter.cs` 已适配和模型同目录的动作，并在模型导入时保存 Original Workflow 的事件及列表。可先重导入一个 `.motion3.json`，再重导入模型并检查所有动作。其它项目先看现有 SDK 版本、目录布局和导入器行为，只有复现同类错误再选适配方式。

## 4. 按实际播放验收

通过 MCP 进入 Play Mode。确认角色在 Game 画面实际可见，然后从 Idle 切到至少一个头部动作和一个身体动作，再回到 Idle。检查参数随动作变化、淡入淡出期间 Console 没有错误，以及有物理资产时求解输出是否响应。要验收摆动观感，另外对照源工具的实际播放画面。测试结束后退出 Play Mode。

报告分别列出 Core 加载结果、生成的 Prefab 与引用、实测动作和渲染结果。鼠标跟随、设备运行和正式演出接入需要各自的输入链和验收。

## 已验证样本

EatEatSing，Unity 2022.3.62f3，URP 14.0.12，Cubism SDK R6_1，PSD2Live 3.6.7。「蓝色大肥鱼」的原始 5.0 MOC 通过，同源原始 5.3 失败，修复后的 5.3 通过 Core 一致性与加载。39 个配套文件逐字节一致，Prefab GUID 保留。重导入后 31 个动作的淡入淡出事件与列表匹配。在 `VerticalSlice` 实测角色可见、Idle 与动作 20/21/22 可切换、五组物理求解有响应，Console 无错误。摆动观感与 PSD2Live 的一致性留待专项验收。
