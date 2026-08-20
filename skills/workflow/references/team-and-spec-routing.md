# 团队与 SPEC 路由

## solo/team 判断

用户明确要求团队时选择 `team`；否则看是否存在边界清楚的并行价值、单一 Owner 的明显瓶颈，以及并行收益是否高于协作成本。任务简单、串行依赖强或无法独立验收时选择 `solo`。独立挑战不是选择 `team` 的理由：两种模式都交给 team-work 采用非作者复核。

每个新阶段可重新判断。两种模式都向 [Team-work](../../team-work/SKILL.md) 提供目标、范围、约束、完成条件、已知制品、风险和预算倾向；不要在 Workflow 中复制团队拓扑、成员会话或评分策略。必要能力缺失时，向用户说明缺口与可选替代，不静默把 `team` 改成 `solo`。

## SPEC 路由

默认 SPEC 实现是 OpenSpec。项目配置决定：

- `auto`：可用时采用；不可用时说明跳过依据；
- `required`：不可用时阻塞并请求可修复的输入；
- `disabled`：明确跳过，不调用 SPEC。

SPEC 提供制品、开放问题和建议；Harness 决定其后的 ActionCard。Lead 不拼装 provider 命令、路径或归档步骤。
