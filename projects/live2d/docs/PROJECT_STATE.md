# 洛天依 ACE AI Live2D 项目总控

基线日期：2026-11-17（Asia/Shanghai）。本会话作为项目总控，记录需求、版本、素材审批、验收与下一步。当前阶段为未觉醒通常形态的可运行迭代版，尚未完成源工程恢复与整体验收。

总控会话：01a1e758-89b3-7b90-a55f-6a27ab43207c。
总控建档时保存了参考图副本和审计证据。

## T50 腰饰方向与逐段传导

2026-11-24。根据用户指出“方向疑似相反、末端先动”，单轴测试确认T49起步时末端同向抢动，且三粒子链缺少可见中段输出。T50新增左右中段参数，三段输出均按相对角累计，校正Reflect方向；加密控制网格并用实际顶点响应标定连接区。向右起步时末端先向左滞后，向移动方向跟随顺序已为上→中→末端。急反向连接区最大额外位移0.048px，六输出无触限、无新增网格翻转。源已保存重开，12个运行文件重导字节一致，ZIP校验完成。

[T50记录](../luotianyi-physics-ornaments-t50/STATE.md) · [方向与传导原速对比](../luotianyi-physics-ornaments-t50/T49-T50-Propagation.gif) · [源工程](../luotianyi-physics-ornaments-t50/LuoTianyi_T50_HipPropagation.psd2live) · [运行包](../luotianyi-physics-ornaments-t50/LuoTianyi_T50_HipPropagation_Runtime.zip)

当前余摆约2.5–2.8秒，超过原R1的回稳区间，故只登记本次方向/传导修正与所测场景结果；用户观感和完整R1验收仍待确认。

## T49 腰饰柔性连续曲线

2026-11-24。根据用户“仍生硬、参考角色辫子”反馈，将两侧腰饰形变改为固定连接区、沿长度连续增长的横向曲线，去掉中间关键形额外增幅；物理采用角色辫子的三段长度、mobility、delay、acceleration。标准轨迹相对裙摆行程14.80/14.75px，较T48保持可见；相对加速度峰值下降约17%/24%，约1.43/1.47秒回稳。身体、反向、挥手轨迹无输出触限或新增翻转；中性及其他已记录部件对照一致。源已保存重开、运行ZIP已校验，用户柔顺度观感待确认。详细验证边界见修订记录。

[T49记录](../luotianyi-physics-ornaments-t49/STATE.md) · [15fps原速对比](../luotianyi-physics-ornaments-t49/T48-T49-SoftSwing.gif) · [源工程](../luotianyi-physics-ornaments-t49/LuoTianyi_T49_HipSoftArc.psd2live) · [运行包](../luotianyi-physics-ornaments-t49/LuoTianyi_T49_HipSoftCurve_Runtime.zip)

## T48 腰饰相对裙摆摆动

2026-11-24。依据用户对 T47“仍与躯干、裙摆一起移动”的反馈，校准两侧腰饰根部和末端的物理输出方向，保留三段链与既有形变。标准轨迹中，腰饰末端相对邻近裙摆顶点的横向行程由9.26/9.21px增至12.23/12.46px。其他已记录部件轨迹与T47一致。身体、反向、挥手13秒轨迹无腰饰输出触限或新增网格翻转；急反向挂点最大额外位移0.497px。源工程已保存并重开，运行重导一致，ZIP已校验。观感由用户确认，完整R1与目标应用验收未重跑。

[T48记录](../luotianyi-physics-ornaments-t48/STATE.md) · [原速对比](../luotianyi-physics-ornaments-t48/T47-T48-RelativeSwing.gif) · [源工程](../luotianyi-physics-ornaments-t48/LuoTianyi_T48_HipRelativeSwing.psd2live) · [运行包](../luotianyi-physics-ornaments-t48/LuoTianyi_T48_HipRelativeSwing_Runtime.zip)

## T46 正面腰饰物理

2026-11-19。以 T45 为基线，只优化正面两侧连接件和垂带；未拆层、未重绘、未扩到背后长带，也未修改裙摆或躯干父级。连接件保持固定，带身与末端分段读取身体 X/Z 和弱呼吸，并在停止后自然衰减。

最终 Web 物理轨迹中，待机末端总幅约 1.17–1.23px，标准身体组合约 7.59–10.40px；快速反向连接区附加位移最大 0.489px，1.60–1.63 秒回稳，四个腰饰输出无触限。固定 30Hz 解算下，身体与挥手的 30/60fps 对齐帧差为 0。源工程已保存并独立重开，运行文件重导一致；用户观感、Unity/VTube Studio 与实际追踪仍待确认。

[T46 记录](../luotianyi-physics-ornaments-t46/STATE.md) · [可编辑工程](../luotianyi-physics-ornaments-t46/LuoTianyi_T46_HipOrnaments.psd2live) · [运行包](../luotianyi-physics-ornaments-t46/LuoTianyi_T46_HipOrnaments_Runtime.zip) · [前后对比](../luotianyi-physics-ornaments-t46/preview/BodyMotion_T45_T46.png)

## T44 挥手袖口保形

2026-11-18。裸手侧的袖口前片、内衬沿同一个支点小幅转动，袖身保留局部褶皱，肘侧接缝保持固定。原生采样中开口网格边长最大变化从约 18% 降到 0.05% 以内。T44 已保存并在当前编辑器播放。PSD2Live 本次会话重开 T44、T43 副本均报作业错误，T44 重开验收待完成，运行包已独立核对。[T44 记录](../luotianyi-sleeves-t44/STATE.md) · [已保存工程](../luotianyi-sleeves-t44/LuoTianyi_T44_SleeveCuffBend.psd2live) · [运行包](../luotianyi-sleeves-t44/LuoTianyi_T44_SleeveCuffBend_Runtime.zip)

## T43 固定挥手袖根

2026-11-18。扩大裸手侧挥手袖的固定区域至可见肘侧接缝，并收敛外袖口的行程。PSD2Live 原生 60 Hz 对照中，袖根额外位移从 3.02 降到不足 0.001 画布像素，袖口横向行程从 15.25 到 9.96。工程重开和导出一致，已有 GIF 保持原样。[T43 记录](../luotianyi-sleeves-t43/STATE.md) · [可编辑工程](../luotianyi-sleeves-t43/LuoTianyi_T43_StableSleeveRoot.psd2live) · [运行包](../luotianyi-sleeves-t43/LuoTianyi_T43_StableSleeveRoot_Runtime.zip)

## T42 挥手袖褶皱与翻转

2026-11-18。裸手侧挥手袖改为贴臂处牵拉、中段沿斜褶收拢、悬空外缘轻翻的三段局部形变。袖根随肘，前臂驱动延续 T41。手部、待机袖与对侧袖的回放对照一致，原生工程已重开并核对导出。[T42 记录](../luotianyi-sleeves-t42/STATE.md) · [原速对比](../luotianyi-sleeves-t42/preview/Wave_Sleeve_T41_T42.gif) · [可编辑工程](../luotianyi-sleeves-t42/LuoTianyi_T42_SleeveFolds.psd2live) · [运行包](../luotianyi-sleeves-t42/LuoTianyi_T42_SleeveFolds_Runtime.zip)

## T41 抬臂袖响应

2026-11-18。缩短裸手侧抬臂袖的换向拖尾，保留布面的分段传导和停手后的余摆。正面挥手中外袖口相对靠臂处的滞后，在 30 Hz 由约 0.17 秒缩到 0.10 秒，在 60 Hz 由约 0.27 秒缩到 0.17 秒。原生工程已重开，运行导出一致。[T41 记录](../luotianyi-sleeves-t41/STATE.md) · [原速对比](../luotianyi-sleeves-t41/preview/Wave_Sleeve_T40_T41.gif) · [可编辑工程](../luotianyi-sleeves-t41/LuoTianyi_T41_FasterSleeve.psd2live) · [运行包](../luotianyi-sleeves-t41/LuoTianyi_T41_FasterSleeve_Runtime.zip)

## T40 前臂驱动左袖

2026-11-18。按裸手侧前臂实测位移校准抬手、垂手袖的物理输入。关闭挥手动作时，单独转头带动前臂也能驱动袖口。正面灵动挥手的袖口相对横向行程由 7.36 增至 13.44 画布像素，手部轨迹与对侧手袖保持 T39 的结果。原生工程已重开，运行导出再次核对一致。[T40 记录](../luotianyi-sleeves-t40/STATE.md) · [只转头对比](../luotianyi-sleeves-t40/preview/No_Clip_Arm_Follow_T39_T40.gif) · [可编辑工程](../luotianyi-sleeves-t40/LuoTianyi_T40_ForearmSleeves.psd2live) · [运行包](../luotianyi-sleeves-t40/LuoTianyi_T40_ForearmSleeves_Runtime.zip)

## T39 挥手袖布面传导

2026-11-18。画面右侧的裸手挥动时，袖根贴随同侧手肘，柔性响应从靠臂布面经中段传向袖口，再自然回落。三段挥手的手部轨迹、对侧手与袖片和 T38 一致。可编辑工程保留 T38–T39 两个修订并已重开，运行导出 11 文件校验一致。[T39 记录](../luotianyi-sleeves-t39/STATE.md) · [原速对比](../luotianyi-sleeves-t39/preview/Wave_Sleeve_Comparison.gif) · [可编辑工程](../luotianyi-sleeves-t39/LuoTianyi_T39_SleeveWave_Editable.psd2live) · [运行包](../luotianyi-sleeves-t39/LuoTianyi_T39_SleeveWave_Runtime.zip)

## T38 袖子由本侧手臂驱动

2026-11-18。左侧裸手挥动时，下方袖身跟肘，上方袖口从靠臂布边向悬空外缘传导。右侧手套的袖子只读取右臂输入。单独驱动每一侧时，对侧手和袖片的实测额外位移均为 0。[T38 记录](../luotianyi-sleeves-t38/STATE.md) · [左右臂独立输入对照](../luotianyi-sleeves-t38/preview/左右臂独立输入.gif) · [原生工程](../luotianyi-sleeves-t38/LuoTianyi_T38_ArmDrivenSleeves.psd2live) · [运行包](../luotianyi-sleeves-t38/LuoTianyi_T38_ArmDrivenSleeves_Runtime.zip)

## T34 垂手待机前臂

2026-11-17。以 T33 为基线，恢复画面右侧裸手的连续前臂轮廓，从袖内根部顺到腕环。为保留前臂比例，中性裸手指尖比 T33 低约 7 画布像素。T34 已保存并重开，已做独显及带袖验证。

[T34 修正记录](../luotianyi-rest-arm-t34/STATE.md) · [独显与袖口对比](../luotianyi-rest-arm-t34/preview/T33-T34_RestForearm.png) · [PSD2Live 工程](../luotianyi-rest-arm-t34/LuoTianyi_T34_RestArm.psd2live) · [运行包](../luotianyi-rest-arm-t34/LuoTianyi_T34_RestArm_Runtime.zip)

## T33 挥手视角联动试调

2026-11-17。在 T32 基础上将肘部视角联动再降低 20%，三段挥手共用灵动循环的手臂曲线。固定身体时，头部在 ±30° 间转向带来的指尖横移比 T32 减少约 18%。T33 原生试调工程已保存并重开。

[T33 原速对比与记录](../luotianyi-wave-t33/STATE.md) · [试调原生工程](../luotianyi-wave-t33/LuoTianyi_T33_Wave.psd2live) · [运行包](../luotianyi-wave-t33/LuoTianyi_T33_Wave_Runtime.zip)

## 挥手修订 T32

2026-11-17。三段挥手统一使用 T31 灵动循环的手臂曲线，保留各自的表情与呼吸。将肘部的头部水平转向联动角度分量降低 28%，固定身体时，头部在 ±30° 间转向带来的指尖横移减小约 25%。原生工程已保存并重开，导出内容与运行包核对一致。

[T32 验证与原速对比](../luotianyi-wave-t32/STATE.md) · [原生工程](../luotianyi-wave-t32/LuoTianyi_T32_Wave.psd2live) · [运行包](../luotianyi-wave-t32/LuoTianyi_T32_Wave_Runtime.zip)

## 挥手修订 T31

2026-11-17。在编辑器实际打开的[胸部 R8](../luotianyi-physics-chest-r8/HANDOFF.md)上完成灵动循环、无表情、呼吸眨眼三段挥手优化。8 秒内由 4 个主要来回增至 5 个，正面指尖行程分别增加约 72%、43%、56%。

[T31 验证与预览](../luotianyi-wave-t31/STATE.md) · [已重开的原生工程](../luotianyi-wave-t31/LuoTianyi_T31_Wave.psd2live) · [含五段动作的运行包](../luotianyi-wave-t31/LuoTianyi_T31_Wave_Runtime.zip)

## 物理 R1 执行记录

2026-11-17 的 R1 执行记录：按[物理R1清单](docs/物理细节优化与验收清单-R1.md)完成了恢复、分派、候选实施与检查。R1 当轮未通过完整验收。详见[当轮执行结果](docs/物理R1本轮执行结果-2026-11-17.md)。

- 范围仍为胸部、常态/挥手衣袖、正面两侧腰饰、裙摆；自然但可见、弱呼吸、停止后回稳，不加持续风。
- 用户手动重启后，已从T29最终CMO、最终动作及原运行图集像素恢复可编辑候选；[T29_Recovered_HD.psd2live](recovery-assessment-r1/T29_Recovered_HD.psd2live)已保存并独立重开。[恢复验证与差异](recovery-assessment-r1/STATE.md)明确它不是原始80层PSD链的无损备份。
- 当前编辑器已切回该恢复基线并显示垂手中性预览：81重建源层、90参数、42物理组、5动作。374组Core比较最大几何差0.000244140625px，真实Web同轨迹物理输出保持；纹理有重采样差异。
- PHY-A胸部：1轮候选未通过，XY组合关键形有误且动态幅度不足。PHY-C腰饰、PHY-D裙摆：各2轮仍未满足幅度/衰减/稳定要求。所有实验及证据独立保留。
- PHY-B衣袖：接口不支持当前旋转父级下的所选Warp插入；用户明确选择“保持现有限制，衣袖暂留未完成”，不再自动重试。
- 本次共11个路由执行轮次，均standard/high；插件策略未改，当前全部子代理已交回，失败任务按无进展规则停止自动续派。参数/动作/物理/美术的原批准范围没有扩大。

## 当前范围与参考分工

| 资料 | 用途 |
| --- | --- |
| [未觉醒立绘](references/1794292976854.png) | 当前形态的设计参考：短发、紫色单侧长手套、另一侧裸手及不对称腿装 |
| [三视图](references/洛天依ACE_AI形象三视图.jpg) | 部件结构、正侧背关系、双侧配饰与遮挡依据；图内批注作为设计资料，不自动变成制作任务 |
| [觉醒立绘](references/1794292967592.png) | 后续觉醒形态参考；不混入当前通常形态制作范围 |
| [历史登记正面母图](references/LuoTianyi-ACEAI-Normal.png) | 历史 approved 目录中 1024×1536 正面图；当前绑定经过多轮局部重绘，并非直接绑定斜身宣传立绘 |
| T29 最终模型与预览 | 当前已实现版本的外观、配准与动作基线；不因原始参考重新出现而擅自整体回退 |

本次三张附件 SHA-256 均与历史 references/design 中的版本完全一致，已原样归档。参考图设计事实、历史正面母图画风和当前局部已接受改动需要分别对照；发现差异先登记，不能自动判定为新的修改授权。

## 版本入口

| 项目 | 当前入口与状态 |
| --- | --- |
| 模型基线 | [T29 状态](../luotianyi-rest-idle-t29/STATE.md)，包含双手高度修正 |
| 运行交付 | [RestIdleWaveRuntime.zip](../luotianyi-rest-idle-t29/delivery/RestIdleWaveRuntime.zip) |
| 运行入口 | [model3.json](../luotianyi-rest-idle-t29/delivery/runtime/LuoTianyi_T29_RestIdleWave.model3.json) |
| 可编辑导出 | [editable-final](../luotianyi-rest-idle-t29/editable-final)，CMO3、CAN3；导出有损失提示，未完成重开验收 |
| 原生工程 | 原T29原生仍未找到；已有[高清恢复候选](recovery-assessment-r1/T29_Recovered_HD.psd2live)，已保存并重开，重建差异见恢复STATE；不能称原PSD无损主源 |
| 预览 | [垂手待机 GIF](../luotianyi-gifs-t30/upper/T29_RestIdle_UpperBody.gif)、[挥手 GIF](../luotianyi-gifs-t30/upper/T29_Wave_Fast_UpperBody.gif) |
| 本次核查 | [artifact-audit.json](audit-2026-11-17/artifact-audit.json)，[可复核脚本](audit-2026-11-17/audit.py)，执行 python -X utf8 audit.py |

T29 MOC SHA-256：`2056040a68b7ff01f134e809829cf9cb0b0b81bc8553eef8b73f5ef4ae257df6`。

T30 只是基于 T29 制作的展示 GIF，不是新模型版本。旧 normal-completion 工作副本属于较早暂停的整体完善分支，不能覆盖后续 T15–T29 修改。旧 outputs/LuoTianyi-ACEAI/STATE.md 仍停留在头脸 R04；历史状态仅用于追溯，当前版本由本入口与 T29 状态定位。

## 实际进度

| 模块 | 状态 | 边界 |
| --- | --- | --- |
| 通常形态基础模型 | 已有分层、头脸/头发与身体绑定，当前 MOC 可加载 | 参数存在不等于完整参数空间视觉通过 |
| 头眼与挥手联动 | 已实现水平朝向及肩、大臂、肘、腕联动 | 不等于二维 IK 或真实摄像头追踪 |
| 五指 | 已有五个独立小幅控制参数，作用于连续手部素材 | 不支持以现有证据声称握拳、大幅出平面或手捕完成 |
| 挥手 | 既有灵动、无表情、呼吸眨眼三个自定义循环 | 均为已抬手姿态中的挥动 |
| 待机 | 既有抬手待机与 T29 垂手待机，呼吸眨眼 | ParamT29ArmMode 0=垂手、1=抬手，差分互斥切换 |
| 双手高度 | T29 已调整画面右侧裸手，保留袖内根部 | 历史测量中中性姿态两侧指尖下缘一致 |
| 物理 | 运行包有 physics3，42 组设置 | 本次未做连续物理播放验收；T30 GIF 明确未推进物理 |
| 嘴部 | 保留原嘴及参数 | T23 新嘴候选已撤回并隐藏，后续精修待确定；不可擅自导回候选 |
| 情绪、点头摇头等整体完善 | 尚未建立 T29 的完整专项验收 | 编辑器 builtin 名称不能当成角色专属交付动作 |
| 觉醒形态 | 有参考及历史母图 | 本次没有查验或认定觉醒绑定完成，不纳入当前施工 |

T29 历史编辑器快照：80 源层、90 参数、5 个自定义动作，画布 1024×1536。运行模型为 51 个 drawable；这三个数量含义不同。交付 ZIP 只包含 Idle_RestArmsLoop 和 Wave_BreathBlinkLoop 两段动作，不能声称包含全部编辑器动作。

较早整体计划提出过自然抬手—挥手—放下；后续 T15/T17 明确改为当前挥手姿态绑定，其他姿势用差分，T29 差分又获得批准。因此连续抬放属于需重新讨论的扩展，不作为当前已授权范围的遗漏任务。

## 验收证据

2026-11-17 新检查：

- 运行包 9 个文件与既有哈希清单匹配；ZIP 的 CRC、成员内容哈希与磁盘交付一致；model3 引用无缺失。
- 3 张运行图集均为 4096×4096；不据此宣称源 PSD/编辑素材全部同等高清。
- 官方 Windows Cubism Core 实际完成一致性检查、模型实例化、更新；读到 51 drawable、90 参数。
- 新抽测垂手和抬手两端默认状态：全部顶点有限，小臂/挥手手部互斥显隐。此检查不是连续动画、物理或应用导入验收。
- 两张上半身 GIF 哈希与 T30 记录一致。待机 8 秒/160 帧，挥手 4 秒/80 帧，均 20fps；挥手加速只用于展示。
- 已查看 T29 最终中性预览、T30 抽帧联系表与历史正面母图；未逐帧复审全部动画。

2026-11-16 历史记录与本次未改变的 MOC 哈希对应：27 组抬手回归最大约 0.015625 画布像素差异；2169 组垂手数值采样无非有限坐标，循环端点顶点误差为 0。属于已有数值记录，本次未重新运行这些密集采样。

Unity、VTube Studio、真实鼠标操作、摄像头/手捕、全参数组合逐像素验收均不能认定完成。目标软件仍待明确，沿用此前暂不做 Unity/摄像头、不安装 Cubism Editor 的选择，不自动扩大任务。

## 需要解决的事项

| 优先级 | 事项 | 完成条件 |
| --- | --- | --- |
| P0 | T29 源工程持久化与恢复 | 已恢复并独立重开CMO+原图集重建候选；原始源未找回，恢复差异与抽测范围见恢复STATE，不能继承完整原PSD无损结论 |
| P0 | CMO 导出损失 | 报告共 57 条：10 条四轴到三轴关键形近似、47 条纹理尺寸/图集重建提示；包含 T15UpperArms。先确认可编辑恢复是否丢失关键控制，不把 CMO 当无损主源 |
| P1 | 设定与当前画面差异 | 对照同姿态近景逐项核对耳侧蓝白配件、头发星形装饰、顶部发环轮廓、辫子质感及配饰细节；现有预览未清楚呈现部分参考细节，需区分遮挡、风格变更与漏件，未经确认不重绘 |
| P1 | 全模型动作与物理验收 | 闭眼/半闭眼、嘴型×张口、头部三轴、头身反向、各发束、袖裙、挥手反向与重复切换；记录真实渲染、控制器、时间轨迹和复查范围 |
| P2 | 表情与更多动作 | 基于当前模型逐项确定开心/害羞/惊讶、点头/摇头等需求，明确哪些复用哪些新增，再建立专项验收 |
| P2 | 后续交付目标 | 按用户选定平台做实际导入与输入映射验收；自然抬放、觉醒形态、面捕/手捕单独立项 |

最初建档时本机 MCP 返回401；本轮随后已恢复合法连接，核对旧内存T29身份。用户手动重启后，创建并重开了新恢复工程，当前项目ID为`0137a124-eadc-403a-96d4-ee47cb4d167a`。具体历史和新证据见本轮执行结果；旧项目ID不能作为新恢复工程的在线身份。

## 持续执行规范

1. 未觉醒形态优先。三视图约束结构，认可母图约束画风与比例，当前已接受局部修改保留；冲突先记录具体部位。
2. 新增、拆分、补画前，对照母图、live2d-agent-kit 与目标动作提交逐层方案并取得明确批准。方案写清角色侧/画面侧、真实层 ID、隐藏补绘、父级固定点、层序及运动归属。已批准范围不重复申请，实质扩展重新评审。
3. 拆层后逐层独显、深浅背景 alpha 检查、同姿态合成对照，通过后再绑定。保留已认可五官、肤色和细节；按运动与遮挡需求拆层，不能以层数代替质量。
4. 当前大臂与躯干保留连续素材，腕环和蓝色美甲沿用已批准局部基准；角色左手=画面右侧裸手。不得重新启用 T29 STATE 中列出的试稿、旧完整垂手或重复手掌。
5. 姿势差分只按已批准用途使用，不把显隐切换宣称为连续变形，不用透明切换掩盖未验收的动作缺陷。
6. 新修订放独立目录；先核对活动工程、保存与备份，再变更。超时先查结果，禁止盲目重放累积变形/创建操作；不丢弃未保存工程以强行重开。
7. 分别记录文件检查、Core 数值、真实渲染视觉、目标软件验收。冻结模型、纹理、动作与控制器哈希；源内容变化时更新受影响的验收，不继承无关旧结论。
8. 每次完成后更新本总控的版本入口、批准范围、完成项、缺陷、证据和下一步；各修订目录保留详细 STATE。不得按目录名中的 final 或最新时间自动选择交付。

规范来源：本轮用户指定范围、既有已批准的 T15/T23/T29 决定，以及 `C:/Users/2033/.codex/skills/live2d-agent-kit/SKILL.md`、`docs/art-baseline-and-review.md`、`docs/workflow.md`、`mcp/psd2live-project-revisions.md`。本文件属于项目记录，不修改全局记忆。
