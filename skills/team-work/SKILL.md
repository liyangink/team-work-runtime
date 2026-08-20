---
name: team-work
description: 为已选定的 solo 或 team 提供成本、拓扑、角色、场景收敛、质量与汇报策略。用户明确要求团队或 Workflow 选择团队协作时使用。
---

# 团队协作

Team-work 只描述如何组成和挑战一个研发团队，不描述平台派发、状态流转或 Runtime 恢复。Lead 不得承担具体工作或技术内容裁决；成员与 Expert 对内容负责。

## 入口与边界

- 优先使用 ActionCard 给出的任务和阶段。没有活动任务而用户直接调用时，从最适配的实际研发阶段介入；只要求该阶段最低输入，不补齐历史流程。
- 使用 Harness 已解析的 Junior、Senior、Expert 候选、成本和并发信息。能力不足时如实报告成本或覆盖缺口，不猜测平台操作。
- `solo` 是一个 Owner 串行完成；`team` 是多个边界互斥的 Owner。两种模式都需要独立挑战，核心内容还需要非作者 Expert 裁决。

## 成本、角色与收敛

1. 先按 [拓扑与成本](references/topologies.md)选择最低充分团队，再写清每项工作的唯一 Owner、范围、完成条件、制品和验证。
2. Junior 是默认 Owner；Senior 用于复杂判断和挑战；Expert 只在核心、高风险或证据冲突时进入。候选同档时优先模型多样性，可用[成员选择脚本](scripts/select-members.mjs)辅助选择。
3. 每一轮保持“Owner 产出 → 挑战者攻击 → Owner 独立核验与修订 → Expert 内容裁决”。三轮仍有重大分歧时由用户决定；用户可明确授权有目标和预算的追加轮次。
4. Lead 对流程、制品和证据只做完整性核对，不强行裁决技术分歧，也不重写成员结论。

## 只读助手与汇报

可用的只读助手只处理窄范围代码探索或资料检索。它不是团队成员或 work item Owner，不修改文件、不作裁决；调用成员必须核验并整合其结论。不可用时由当前成员完成，不把助手当成必经条件。

团队最终以普通语言汇报结论、依据、产物、分歧、风险和建议；详细论证留在原始制品。场景策略见：

- [方案讨论](references/solution-discussion.md)
- [代码 Review](references/code-review.md)
- [并行施工](references/parallel-delivery.md)
- [测试协作](references/testing.md)
- [制品与汇报](references/artifacts-and-report.md)
- [上下文边界](references/context-and-sessions.md)
- [异常边界](references/recovery.md)
- [团队评分](references/evaluation.md)
