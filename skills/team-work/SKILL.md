---
name: team-work
description: 组织已确定 solo 或 team 执行拓扑的研发工作，负责成员选择、成本档位、分工、独立挑战、Expert 裁决、多轮收敛、汇报与恢复。用户显式要求团队或上层工作流需要派发具体工作时使用。
---

# 团队协作

在上层已决定 `solo` 或 `team` 后执行本 Skill，不自行改变拓扑模式。Lead 只掌控 Harness，禁止承担具体工作或技术内容裁决；不要直接改写 Runtime 控制状态，也不要解析平台原始配置。

## 接入任务

1. 优先使用明确的活动任务与当前阶段。
2. 没有活动任务但用户直接调用本 Skill 时，根据目标选择最适配的实际研发阶段创建轻量任务，例如方案讨论用 `design`、代码审查用 `code-review`、施工用 `implementation`、测试用 `test`。创建后立即以“用户直接调用团队协作”为理由通过 Runtime 写入 `team` 决策，再只注册该阶段最低输入；不强制补全完整研发流程。
3. 读取 Platform Profile 获取可用 Agent、Junior/Senior/Expert 档位、成本权重、并发限制、操作映射和增量指南。若 Profile 不可用，不猜测平台工具名，也不进行非受管派发；把已有任务置为 `awaiting-user`，请求安装/指定平台能力或明确授权退出受管执行。

## 组建团队

1. 先选场景，再定并行工作边界和验收点。按 [拓扑与成本](references/topologies.md)设计最低充分团队。
2. `solo` 使用一个 Owner 串行产出，solo 也必须配置非作者挑战者；`team` 使用多个边界互斥的 Owner 并行产出。两者都在核心环节安排一位 Expert 作内容裁决或把关。
3. Junior 是默认 Owner；Senior 补充复杂工作并优先承担挑战位；Expert 通常只引入 1 位，既可作核心 Owner，也可作专家裁决位。达到升级条件时才增加第二位。
4. 同档有多个候选时，优先引入不同模型；可用 [成员选择脚本](scripts/select-members.mjs)随机抽取，避免 Lead 固定偏好。
5. 为每名成员创建 Runtime work item，明确唯一 Owner、范围、完成条件、制品路径、依赖和验证要求。成员契约见 [分工契约](references/member-contract.md)。

## 执行与收敛

1. 按 Platform Profile 派发成员；首轮独立工作，避免锚定。
2. 每一轮依次执行：Owner 产出、挑战者攻击、Owner 独立核验并接受或提出有证据的异议、Owner/整合者修订、核心环节由 Expert 作技术内容裁决、Lead 核对控制面完成条件。Lead 不编写或修订具体制品。
3. Expert 裁决是核心门禁依据，但不是要求 Owner 无条件执行的绝对权威；异议继续进入下一轮。Lead 只从流程、制品、证据和复核策略角度接受或返工 work item，不对技术分歧作强行裁定，也不替代 Expert 或 Owner；成员“完成”不等于通过。
4. 下一轮只续派分歧、证据缺口和修正项。最多 3 轮仍无法收敛时直接请求用户决定；用户可明确授权限定目标和预算的追加轮次，未授权不得继续自循环。
5. 输出团队汇报；Expert 给出内容结论和建议结果，Lead 负责记录并推进工作流。可在收敛后执行同档评分；评分只用于后续选人优化。

## 成员只读辅助

Platform Profile 明确支持时，Owner、挑战者或 Expert 可把独立、并行价值明确的代码探索或资料检索交给临时只读助手。助手不属于团队成员，不创建 work item，不替代 Owner、挑战者或 Expert，也不参与收敛、评分或技术裁决；调用成员必须核验事实并把必要结论整合进自己的制品。

只下发窄范围问题和期望证据，不注入整个任务目录。助手不得修改文件、继续委托或直接面向用户汇报；平台必须后台派发。能力不可用时由成员自行完成该范围，不猜测平台工具名，也不引入可选增强依赖。

## 选择场景指南

- 方案讨论与设计审查：[方案讨论](references/solution-discussion.md)
- 代码审查：[代码 Review](references/code-review.md)
- 并行实现：[并行施工](references/parallel-delivery.md)
- 单元、集成与 E2E：[测试协作](references/testing.md)
- 制品布局与最终汇报：[制品与汇报](references/artifacts-and-report.md)
- 上下文最小化与成员会话：[上下文与会话](references/context-and-sessions.md)
- 失败、失联与重派：[恢复规则](references/recovery.md)
- 可选同档评分：[团队评分](references/evaluation.md)
