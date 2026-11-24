# 洛天依 Live2D 项目备份

当前冻结版本：**T50 腰饰惯性方向与逐段传导**，2026-11-24。

完整原生工程保存在[同仓库 Release](https://github.com/FunnyMudTureGoPee/CodexRepository/releases/tag/live2d-t50-20261124)，项目文件位于 `feature/live2d` 分支的 `projects/live2d/`。原生工程约2.86GB，采用可逐字节还原的分卷附件；没有删减工程内部修订或素材。

## 当前内容

| 内容 | 入口 |
| --- | --- |
| 最新状态和验证记录 | [latest/STATE.md](latest/STATE.md) |
| 项目总控状态原文 | [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) |
| 物理优化清单原文 | [docs/物理细节优化与验收清单-R1.md](docs/物理细节优化与验收清单-R1.md) |
| 可运行模型、纹理、物理与五段动作 | [latest/runtime/](latest/runtime/) |
| 方向及传导原速对比 | [preview/T49-T50-Propagation.gif](preview/T49-T50-Propagation.gif) |
| 源工程分卷、运行ZIP、可编辑CMO3/CAN3 | [Release附件](https://github.com/FunnyMudTureGoPee/CodexRepository/releases/tag/live2d-t50-20261124) |
| 文件尺寸和SHA-256 | [BACKUP_MANIFEST.json](BACKUP_MANIFEST.json) |

## 恢复原生工程

需要Python 3.11或更高版本，仅使用标准库。获取本分支后，在本目录运行：

```powershell
python restore_source.py
```

脚本下载全部分卷，逐个校验SHA-256，合并后再次校验完整文件。输出为：

```text
latest/source/LuoTianyi_T50_HipPropagation.psd2live
```

也可以先从Release手动下载所有`.partNNN`附件，再离线恢复：

```powershell
python restore_source.py --parts-dir D:\Downloads\T50-parts
```

只校验仓库中冻结的运行文件、预览和状态文档：

```powershell
python restore_source.py --verify-only
```

不要把分卷直接作为PSD2Live文件打开。合并后的`.psd2live`是完整可编辑源；运行ZIP供运行时使用，CMO3/CAN3为额外导出物。完整源文件SHA-256为`427ca6666d9fb00e335861966c7e2dfa41b64f7473f15c1f18f372058a290ed8`。

## 版本范围

T50新增左右腰饰中段参数，校正起步惯性方向，建立上段→中段→末端跟随。源工程已保存重开，运行文件和ZIP已核对；原有辫子、美术、裙摆和其他部件沿用既有版本。详细测量与修改记录见最新状态文档。

本目录冻结最新交付，不包含本机所有历史候选及逐帧测试缓存。总控原文中的旧版本和本机路径用于追溯，相关旧目录未全部上传。T50余摆约2.5–2.8秒，用户观感、完整R1及目标应用验收仍按原记录保持待确认。
