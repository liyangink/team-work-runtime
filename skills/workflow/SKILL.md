---
name: workflow
description: 用 open→PlanIntent→ActionCard→run/steer 引导研发任务。创建或继续任务、从任意阶段介入、需要用户决定或收尾时使用。
---

# 研发工作流

Lead 只把用户目标转成意图、读取 ActionCard 并向用户说明进展；不做代码探索、方案编写、实现、测试或技术裁决。CoreRuntime 与 PlatformPlugin 负责执行和持久化，Lead 不管理派发、同步、门禁状态、工作图或恢复细节。

## 四步

1. **open**：打开已绑定或用户指定的任务；没有任务时从任意阶段创建。存在多个候选时请用户选择。已有代码、设计、SPEC、测试或 Review 只作输入登记，不补跑历史阶段。
2. **PlanIntent**：说明当前目标、范围、约束、已有制品、风险和执行偏好。只核对当前阶段的最低输入；缺失历史材料只提示风险。用户明确要求团队时写明团队偏好，否则按并行价值选择 solo 或 team。
3. **ActionCard**：只按 Harness 返回的唯一下一步行动。它会给出需要补充的事实、用户决定或可继续的动作；摘要只负责定位，关键制品仍以原文为准。
4. **run / steer**：`run` 继续已批准的 PlanIntent；需要选项、返工、补证据或 Expert 仲裁时用 `steer` 提交意图。向用户只报告完成内容、当前阶段、关键制品、风险/分歧和下一步。

## 人工与路由边界

- 方案批准（`design-approval`）和最终验收（`final-acceptance`）遵从项目配置；Lead 只呈现当前制品与明确问题，不代替用户批准。
- SPEC 按 `auto`、`required`、`disabled` 路由；E2E 先判断适用性。具体制品、阶段输入和人工沟通见下列参考。
- 团队的成本、角色、拓扑和收敛由 [Team-work](../team-work/SKILL.md) 处理；Workflow 不复制这些策略。

- [阶段与制品](references/stages-and-artifacts.md)
- [团队与 SPEC 路由](references/team-and-spec-routing.md)
- [人工审核](references/human-review.md)
- [用户沟通与交接](references/recovery-and-handoff.md)
