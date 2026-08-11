# team-work 仓库开发契约

本文件是跨平台开发 Agent 的项目约束。开始规划、实现或审查前，先阅读本文件和 [`docs/runtime-roadmap.md`](docs/runtime-roadmap.md)，检查工作区并保留用户已有改动。

## 目标

`team-work` 是平台无关的多智能体研发 Harness，负责：

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
8. Agent 声称完成、平台状态完成或消息送达都不代表验收通过；只有 Lead 核验证据后才能推进。
9. Hook 可以校验、注入和记录事件，但不得代替 Lead 做语义验收或静默推进阶段。
10. 是否建团由 Workflow 或用户决定；Team-work 只在决定建团后负责组队和收口。Workflow 运行时不依赖 PlatformPlugin Implementation。
11. 每个正式团队必须指定一名 Senior 或 Expert 挑战非本人制品，从成本、合理性、事实、推理、需求、边界和失败路径主动找漏洞；必须给出证据与最小修正，不机械增员、不扩展三轮上限。
12. 每项工作必须有唯一 Owner、范围、完成条件和产物路径；多轮讨论与审查最多三轮，之后重大分歧交给用户裁决。
13. 团队评分只用于后续选模优化，不进入当前任务循环；默认采用 Lead 汇总再派发，而非依赖 N-to-N 实时通信。
14. standalone 使用不得被无关平台 Hook 或可选 SPEC Skill 阻塞。错误必须保留最后有效制品，并可诊断、重试和恢复。

## 变更要求

- `AGENTS.md` 保存产品边界，Roadmap 保存进度，Skill 保存协作策略，Runtime 输出保存运行状态；不要重复定义。
- `docs/file-inventory.json` 是新实现、历史归档和规划路径的清单；新增或迁移文件时必须同步，禁止新实现反向依赖 `archive/`。
- 开发本仓库时新建 subagent 默认使用 `gpt-5.6-terra` 以控制成本；只有任务明确需要更高能力或用户另行指定时才升级。
- 修改 schema、状态机、门禁、Hook 或安装器时，补齐损坏输入、非法流转、并发、恢复和幂等测试。
- 新增平台时复用 Workflow、Team-work 和 CoreRuntime，只新增 PlatformPlugin；不得复制任务状态机和通用团队策略。
- Roadmap 中尚未完成的能力不得描述成已经可用。

## 当前基线

- 旧 OMO Skill 与旧 Claude Code Skill 已分别归档到 `archive/legacy-omo/`、`archive/legacy-claude-code/`，仅供参考，不参与构建与测试。
- 第一版 PlatformPlugin 以 OpenCode 为实现目标，优先验证多模型兼容、subagent/session、上下文注入和 Lead 汇总协作；不得把 Claude Agent Teams 作为 Runtime 或 Workflow 的前置能力。
- OpenCode 下所有受管 Team-work subagent 必须以 background/non-blocking 模式派发；阻塞式 subagent 调用不得用于团队工作，Lead 必须持续掌握 Harness 并在同步点主动收集结果。
- Runtime 1.0 契约、文件型 CoreRuntime MVP、Workflow 与 Team-work Policy Skill 已完成自动化测试和 Terra 交叉审查；OpenCode PlatformPlugin 尚未开始。
