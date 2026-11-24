# 操作说明

插件 ID 保持 `subagent-budget-router`，界面名称仍是“子代理模型与成本路由”。0.3.0 起移除无依据的预估 token 和 token 软额度，以验收和有限轮次控制续派。

## 在插件管理中配置

打开 **插件管理 → 子代理模型与成本路由 → 设置**。直接调整原生控件，无需发送消息。

| 设置 | 新安装初始值 | 字段 |
|---|---|---|
| 分派策略 | balanced | mode |
| 自动最高档位 | deep | max_auto_tier |
| 最大并发 | 2 | max_concurrent |
| 每子任务最多执行轮次 | 3，含首轮 | max_attempts_per_task |
| 连续无验收进展最多轮次 | 2 | max_no_progress_rounds |
| 每子任务最多升级次数 | 1 | max_escalations_per_task |
| 整个长任务最多执行轮次 | 12 | max_attempts_per_run |

另外分别配置 light / standard / deep / expert 的模型与思考等级。新安装初始映射为 Luna/low、Sol/medium、Sol/high、Astra/high；升级不会覆盖用户已设置的映射。

配置跨聊天保存，下一次准入检查生效。并发还受宿主限制，降低限制不会主动中断正在运行的子代理。

## 任务如何分档

0.4.0 起，Skill 内置分档矩阵和 [边界案例](task-routing.md)，路由服务同步执行：

- 实质发散方案、设计与架构提案（brainstorm/design/architecture）推荐 expert，最终选择仍由主代理负责。
- 其他任务复杂度高或风险高，推荐 deep。
- 规则明确且低复杂度、低风险的执行任务推荐 light，包括简单批量转换/模板实现，不限于检索和摘要。
- 其余常规有界任务推荐 standard。

quality 模式将 light 提至 standard；economy 不降低复杂/高风险/设计任务的能力要求，但禁止自动升级。模型和思考等级取当前用户配置，不由档位名称强制决定。

**推荐专家不等于自动允许专家。** 若用户的自动最高档位仍是 deep，专家类任务会返回 recommended_tier=expert 并交回，不会静默降级或擅自提高上限。用户需要自动使用专家时，可在管理设置中将上限调到 expert。

## 一轮如何工作

一轮 = 主代理下发一个有界方案 → 子代理执行并验证 → 返回结果 → 主代理逐项验收。

例如验收项有“空输入不崩溃”“合法输入保持原结果”：

1. 首轮两个都未通过：无进展计数 1。
2. 第二轮仍两个都未通过：计数 2，停止自动续派，交回证据与未完成项。
3. 若第二轮通过了第一项：计数清零，轮次未用完时可以带新方案进入第三轮。
4. 第三轮即使还有进展，只要没有全部通过，也因达到总轮次上限交回，不再自动进入第四轮。

所有原始验收项都通过才能完成；not_checked 不是通过。复杂度/风险仍由主代理判断，验收结论也需主代理检查证据，插件不会自行运行测试或判断证据真实性。

“无进展”的程序判据是通过项数量没有超过此前最好值。该指标不能完整代表研究进展，因此停止后由主代理重新规划，不用编造通过项来继续跑。轮次不是子代理内部 token、消息或工具调用次数；内部循环需要主代理使用宿主工具中断。

## 工具输入示例

首轮 `route_task`：

```json
{
  "run_id": "本次任务固定ID",
  "task_id": "修复空输入崩溃",
  "workspace": "D:/实际项目",
  "kind": "debug",
  "complexity": "medium",
  "risk": "medium",
  "routing_rationale": "已有稳定复现和明确模块边界，需局部修复及输入兼容回归，因此为中等复杂度和中等风险。",
  "available_models": [{"model": "gpt-6.1-sol", "efforts": ["medium", "high"]}],
  "acceptance_criteria": ["空输入不崩溃", "合法输入保持原结果"],
  "reserve": false
}
```

执行前 reserve=true 并加入唯一 request_id。能力列表从当前宿主读取；同一 request_id 不会重复启动。后续轮次固定 task_id/acceptance_criteria，添加 retry_reason、evidence 和针对未满足项的新 next_action。

终态 `record_attempt` 的验收部分：

```json
{
  "acceptance_results": [
    {"criterion": "空输入不崩溃", "verdict": "passed", "evidence": "空输入回归测试通过"},
    {"criterion": "合法输入保持原结果", "verdict": "failed", "evidence": "合法输入回归测试出现输出差异"}
  ]
}
```

该例必须记 failed，不能记 passed。返回 next_step=revise_plan 时只是允许评估下一轮；handoff 时停止自动续派；complete 表示已上报全部通过。

## 数据和兼容

SQLite 位于 `~/.codex/subagent-budget-router/ledger.sqlite3`。升级读取旧配置时忽略历史预估/软额度字段，保留模型、思考等级、并发、尝试限制和所有历史执行记录；新设置中不再显示预估 token。下次保存会写入当前配置格式。

旧任务若没有固定验收项，不自动续派，先交回审查；旧记录里的估算不再计入报表。真实用量可选上报，未知就显示未知，不影响验收决策。不调用模型 API、不读取凭据，不上传账本。

首选管理页配置；用户明确要求代操作时也可调用 update_policy。更新后若旧管理页仍显示 token 字段，关闭后重新打开，使宿主重新发现当前设置 schema。
