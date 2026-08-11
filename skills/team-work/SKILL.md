---
name: team-work
description: 组织已决定采用团队模式的研发工作，负责成本档位、成员选择、拓扑、分工、独立挑战、多轮收敛、验收、汇报与恢复。用户显式要求团队，或上层工作流已选择 team 时使用。
---

# 团队协作

在“已经决定组团”后执行本 Skill。不要替普通任务判断是否应该建团；不要直接改写 Runtime 控制状态，也不要解析平台原始配置。

## 接入任务

1. 优先使用明确的活动任务与当前阶段。
2. 没有活动任务但用户直接调用本 Skill 时，根据目标选择最适配的实际研发阶段创建轻量任务，例如方案讨论用 `design`、代码审查用 `code-review`、施工用 `implementation`、测试用 `test`。创建后立即以“用户直接调用团队协作”为理由通过 Runtime 写入 `team` 决策，再只注册该阶段最低输入；不强制补全完整研发流程。
3. 读取 Platform Profile 获取可用 Agent、Junior/Senior/Expert 档位、成本权重、并发限制、操作映射和增量指南。若 Profile 不可用，不猜测平台工具名，也不进行非受管派发；把已有任务置为 `awaiting-user`，请求安装/指定平台能力或明确授权退出团队模式。

## 组建团队

1. 先选场景，再定并行工作边界和验收点。按 [拓扑与成本](references/topologies.md)设计最低充分团队。
2. Junior 是默认主力；Senior 补充复杂判断；Expert 通常只引入 1 位保底、攻坚或收口，达到升级条件时才增加第二位。
3. 每个正式团队必须指定一位非制品作者的挑战者，由 Senior 或 Expert 兼任。
4. 同档有多个候选时，优先引入不同模型；可用 [成员选择脚本](scripts/select-members.mjs)随机抽取，避免 Lead 固定偏好。
5. 为每名成员创建 Runtime work item，明确唯一 Owner、范围、完成条件、制品路径、依赖和验证要求。成员契约见 [分工契约](references/member-contract.md)。

## 执行与收敛

1. 按 Platform Profile 派发成员，遵守其并发和执行模式。首轮要求成员独立工作，避免先看到他人结论造成锚定。
2. 在场景同步点收集提交。长结论写入任务制品，消息只传摘要、路径、证据和待决问题。
3. Lead 验收 work item，辨别共识、互补与冲突；不合格项返工，不能把成员的“完成”直接当成通过。
4. 第二轮只下发分歧、证据缺口和挑战清单；必要时第三轮做最终验证。最多 3 轮仍无法收敛时，提交用户决定，不继续自循环。
5. 最终制品必须经过非作者挑战者复核。挑战者从成本、合理性、事实、推理、需求符合度、边界和失败路径主动找漏洞。
6. 输出团队汇报并由 Lead 决定工作流建议结果。可在最终收敛后执行同档评分；评分只用于后续选人优化，不进入任务循环。

## 选择场景指南

- 方案讨论与设计审查：[方案讨论](references/solution-discussion.md)
- 代码审查：[代码 Review](references/code-review.md)
- 并行实现：[并行施工](references/parallel-delivery.md)
- 单元、集成与 E2E：[测试协作](references/testing.md)
- 制品布局与最终汇报：[制品与汇报](references/artifacts-and-report.md)
- 失败、失联与重派：[恢复规则](references/recovery.md)
- 可选同档评分：[团队评分](references/evaluation.md)
