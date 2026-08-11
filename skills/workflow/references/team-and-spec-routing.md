# 团队与 SPEC 路由

## solo/team 判断

用户明确要求团队协作时直接选择 team。否则依次判断：

1. 是否存在可并行且边界清楚的事实探索、实现或测试工作，即明确的并行价值；
2. 是否需要独立评审价值，例如复杂方案、代码 Review、高风险变更或容易自证正确的任务；
3. 单人上下文是否已经足够，团队同步成本是否会超过预期收益；
4. 是否有可用 Platform Profile、合适档位 Agent 和并发容量。

满足任一强信号即可组团：两项以上独立工作可并行；需要非作者挑战；跨领域且单人容易遗漏；用户显式要求。任务简单、串行依赖强、无法形成独立验收边界时保持 solo。

Workflow 通过 `task team` 记录 `solo` 或 `team` 决策及理由；进入新阶段后重新判断。选择 team 后，把以下输入交给 `team-work` Skill：

- 任务 ID 与当前阶段；
- 目标、范围、约束、完成条件；
- 已注册制品和所需上下文 Profile；
- 风险、预算倾向、期望同步点；
- Platform Profile 路径。

不要在 Workflow 中复制团队拓扑、成员恢复或评分规则。

若 Platform Profile、候选 Agent 或必要操作映射缺失，不进行非受管派发。通过 `task await` 记录 blocker，请用户选择安装/指定平台能力，或明确授权降级为 solo；恢复后用 `task team` 记录最终模式与理由。由 Workflow 自主判断出的 team 也不能静默降级。

## SPEC 路由

进入 SPEC 路由点时读取项目配置中的 `spec.type`、`spec.skill`、`spec.root`、`spec.mode` 和 `spec.status`：

- 默认路由为 OpenSpec；
- `auto`：工具 ready 时调用；missing 时记录跳过依据，从 `design-review` 直接进入 `implementation`；
- `required`：工具 missing 时阻塞并形成可修复 blocker，提示初始化，不得跳过；
- `disabled`：明确跳过 SPEC，不调用 SPEC Skill；
- SPEC Skill 返回状态、制品引用、验证证据、开放问题和建议下一阶段；Workflow 通过 `task spec` 持久化执行状态与制品；
- Workflow 注册返回制品，检查当前门禁，再决定进入 `spec-review` 或等待/返工。

未来可加入其他 SPEC 实现，但路由语义保持不变，具体命令不写入本 Skill。
