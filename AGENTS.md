# team-work-runtime 仓库开发契约

本文件是跨平台开发 Agent 的项目约束。开始规划、实现或审查前，先阅读本文件和 [`docs/runtime-roadmap.md`](docs/runtime-roadmap.md)，检查工作区并保留用户已有改动。

## 目标

`team-work-runtime` 是平台无关的多智能体研发 Harness，负责：

1. 任务制品、活动任务和跨会话/子 Agent 上下文；
2. 工作流状态、阶段门禁和可恢复控制；
3. Claude Code、OpenCode、OMO 等 CLI 的多智能体适配。

OpenSpec 是默认 SPEC Skill，由项目 Workflow Config 路由；它不是 Runtime 存储后端，也不属于某个 CLI 平台。

## 四个 Module

- **Workflow**：主导上下文计划、研发阶段、任务状态、流程门禁、solo/team 判断和 SPEC Skill 路由。
- **Team-work**：负责团队成本、拓扑、分工、场景协作、收敛、汇报和通用恢复规则；Skill 不充当数据库。
- **CoreRuntime**：用平台无关 CLI 执行 task/context/flow/work-item 的确定性操作；初版使用文本文件、原子写入和文件锁。
- **PlatformPlugin**：负责安装装配、Agent、Hook、上下文注入、平台工具映射、配置扫描和平台增量指南。任务数据必须留在项目 `.team-work/`。

## 核心规则

1. 任务使用稳定 `task-id` 和版本化 schema，存放在 `.team-work/tasks/<task-id>/`；路径不得越出项目根目录。
2. 活动任务按“显式 `TEAM_WORK_TASK_ROOT`、当前会话绑定、项目唯一活动任务”解析；存在歧义时禁止猜测。
3. 原始 PRD、SPEC、设计、实现和测试制品保持各自事实源。`context.jsonl` 保存机器索引，`index.md` 只保存生成的摘要和路径。
4. 上下文按 Lead、research、implement、check 等 profile 最小化渲染；摘要不能替代源码、测试或原始制品。
5. 任务允许从任意研发阶段创建并介入工作流；门禁只检查当前阶段声明的最低必需输入，历史阶段制品缺失不得默认阻塞。
6. 工作流必须版本化；状态切换必须显式、合法、原子、带锁且可审计。
7. `check` 保持只读；门禁失败必须返回 blocker、证据和修复建议。强制恢复必须记录原因和原 blocker，避免“死门”。
8. Agent 声称完成、平台状态完成或消息送达都不代表验收通过；Lead 只能核对流程、制品、证据和复核链是否完整。非作者 Expert 在核心环节给出技术裁决，但 Owner 必须独立核验，可用证据接受或提出异议；Lead 不强行裁定技术分歧，三轮仍未收敛时交用户决定。
9. Hook 可以校验、注入和记录事件，但不得代替 Lead 做语义验收或静默推进阶段。
10. 执行拓扑由 Workflow 或用户决定：`solo` 是一个成员 Owner 串行工作，`team` 是多个 Owner 并行工作；两种模式的具体工作都由 Team-work 派发，Lead 不得亲自执行。Workflow 运行时不依赖 PlatformPlugin Implementation。
11. 每个相对完整工作单元都必须由非作者 Senior 或 Expert 挑战；核心环节还必须由非作者 Expert 作技术内容裁决。挑战者从成本、合理性、事实、推理、需求、边界和失败路径主动找漏洞，并给出证据与最小修正。
12. 每项工作必须有唯一 Owner、范围、完成条件和产物路径；同一工作项跨轮次复用成员会话。自主讨论与审查最多三轮，之后直接请求用户决定；用户可显式授权有目标、有预算的有限追加轮次。
13. 团队评分只用于后续选模优化，不进入当前任务循环；默认由 Lead 记录、转发成员和 Expert 的结论再续派，不依赖 N-to-N 实时通信，也不得由 Lead 重写技术结论。
14. standalone 使用不得被无关平台 Hook 或可选 SPEC Skill 阻塞。错误必须保留最后有效制品，并可诊断、重试和恢复。
15. SPEC 与 E2E 都是显式路由：SPEC 按 `auto|required|disabled` 处理；E2E 必须判断适用性但可在有证据时跳过。E2E 制品问题留在内部小循环，产品缺陷回实施，系统性测试策略缺口才回测试。
16. PlatformPlugin 可为受管成员提供独立模型配置的临时只读助手，用于代码探索和资料检索。助手不是团队成员或 work-item Owner，不进入收敛、评分和技术裁决，不得修改文件或继续委托；调用成员必须核验并整合结果。辅助派发仍必须 background/non-blocking，且不得依赖 OMO 等可选增强。
17. 默认工程 Workflow 在方案审查后和任务完成前分别设置 `design-approval`、`final-acceptance` 人工门禁，默认都为 `required`，可由项目配置改为 `optional|disabled`，但 Agent 不得自行降级。人工批准必须绑定当前制品指纹；批准制品变化后必须重新确认。方案文档是需求、范围与实现方向的人机唯一批准基线，必须用朴实语言完整描述修改点和影响；引用核心代码时只能基于已读取的代码事实，拟议内容必须明确标为伪代码或建议。

## 变更要求

- `AGENTS.md` 保存产品边界，Roadmap 保存进度，Skill 保存协作策略，Runtime 输出保存运行状态；不要重复定义。
- `docs/file-inventory.json` 是当前实现与规划路径的清单；新增或迁移文件时必须同步。根目录不得重新引入 OMO、Claude Code 等旧版资产，历史实现只通过 Git 历史保留。
- 开发本仓库时新建 subagent 默认使用 `gpt-5.6-terra` 以控制成本；只有任务明确需要更高能力或用户另行指定时才升级。
- 修改 schema、状态机、门禁、Hook 或安装器时，补齐损坏输入、非法流转、并发、恢复和幂等测试。
- 新增平台时复用 Workflow、Team-work 和 CoreRuntime，只新增 PlatformPlugin；不得复制任务状态机和通用团队策略。
- Roadmap 中尚未完成的能力不得描述成已经可用。

## 当前基线

- 第一版 PlatformPlugin 以 OpenCode 为实现目标，优先验证多模型兼容、subagent/session、上下文注入和 Lead 控制面协作；不得把 Claude Agent Teams 作为 Runtime 或 Workflow 的前置能力。
- OpenCode 下所有受管 Team-work subagent 必须以 background/non-blocking 模式派发；阻塞式 subagent 调用不得用于团队工作，Lead 必须持续掌握 Harness 并在同步点主动收集结果。Agent model/effort 由 Plugin 启动时读取用户配置并动态注入。
- Runtime 1.0 契约、文件型 CoreRuntime MVP、Workflow 与 Team-work Policy Skill 已完成自动化测试和 Terra 交叉审查；OpenCode PlatformPlugin 的安装生命周期、原生异步 child session、Runtime Tool 和上下文 Hook 已落地。低成本多模型平台链路 E2E 已完成，含 Senior 挑战者的正式 Workflow 场景 E2E 尚待完成。
