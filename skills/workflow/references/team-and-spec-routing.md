# 团队与 SPEC 路由

## solo/team 判断

用户明确要求团队协作时直接选择 team。否则依次判断：

1. 是否存在两项以上可并行且边界清楚的事实探索、实现或测试工作，即明确的多 Owner 并行价值；
2. 单一 Owner 是否会因范围、领域跨度或上下文容量形成明显瓶颈；
3. 多 Owner 同步成本是否低于并行收益；
4. 是否有可用 Platform Profile、合适档位 Agent 和并发容量。

两项以上独立工作可并行、跨领域且单一 Owner 容易形成瓶颈，或用户显式要求时选择 `team`。任务简单、串行依赖强、无法形成独立验收边界时选择 `solo`。独立挑战和核心 Expert 裁决不是选择 `team` 的理由，因为 `solo` 同样必须执行这些复核。

Workflow 通过 `task team` 记录 `solo` 或 `team` 决策及理由；进入新阶段后重新判断。两种模式都把以下输入交给 `team-work` Skill：

- 任务 ID 与当前阶段；
- 目标、范围、约束、完成条件；
- 已注册制品和所需上下文 Profile；
- 风险、预算倾向、期望同步点；
- Platform Profile 路径。

不要在 Workflow 中复制团队拓扑、成员恢复或评分规则。

若 Platform Profile、候选 Agent 或必要操作映射缺失，不进行非受管派发。通过 `task await` 记录 blocker，请用户安装或指定平台能力，或明确授权退出受管执行；恢复后用 `task team` 记录最终模式与理由。由 Workflow 自主判断出的 team 不能静默降级为 solo。

## SPEC 路由

进入 SPEC 路由点时读取项目配置中的 `spec.type`、`spec.skill`、`spec.root`、`spec.mode` 和 `spec.status`：

- 默认路由为 OpenSpec；
- `auto`：工具 ready 时调用；missing 时记录跳过依据，从 `design-review` 直接进入 `implementation`；
- `required`：工具 missing 时阻塞并形成可修复 blocker，提示初始化，不得跳过；
- `disabled`：明确跳过 SPEC，不调用 SPEC Skill；
- SPEC provider 返回状态、制品引用、验证证据、开放问题和建议下一阶段；Workflow 通过 Runtime 持久化执行状态与制品；
- Workflow 注册返回制品，检查当前门禁，再决定进入 `spec-review` 或等待/返工。

OpenSpec 路由由 PlatformPlugin 的确定性适配器执行，而不是由 Lead 拼装命令或路径：

- 进入 `spec` 时创建或恢复与 `task-id` 同名的活动 change；
- proposal 完成后以 `openspec status/instructions` 为准推进 design/specs，最后推进 tasks，不硬编码可能变化的 schema 顺序；
- 派单只选择当前 change 中已经 ready 的 artifact 类型；同一 work item 返工时可续派其 done artifact。delta specs 只补充 proposal 已确认的 capability 名称，物理路径由适配器生成，provider instructions 自动随派单注入 Owner；
- Runtime 拒绝 canonical `openspec/specs/`、`openspec/changes/archive/` 和其他活动 change 的 Agent 产物路径；
- `openspec status` 未完成时不得进入 `spec-review`；最终人工验收通过后才执行严格校验和 archive。

未来可加入其他 SPEC 实现，但路由语义保持不变，具体命令不写入本 Skill。
