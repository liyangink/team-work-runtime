# Runtime 实施与验收地图

本文件把 [`runtime-roadmap.md`](runtime-roadmap.md) 拆成可顺序交付的实施项。每项完成后必须同时提交实现、契约/文档、fixture 和自动化测试；不得只以“Agent 已完成”作为验收。

## architecture-baseline: 四 Module 与 OpenCode 首版基线

Blocked by: 无
Status: resolved
Type: Research

### Question

首版按什么产品边界和平台基线实施？

### Answer

Workflow、Team-work、CoreRuntime、PlatformPlugin 四 Module 已冻结。首个平台是 OpenCode；受管 subagent 只允许 background/non-blocking 派发；任务可从任意阶段介入，门禁只检查当前阶段最低必需制品。依据 [`AGENTS.md`](../AGENTS.md) 和 [`runtime-plugin-design.md`](runtime-plugin-design.md)。

## runtime-contract: 冻结 Runtime Interface 与 Schema

Blocked by: architecture-baseline
Status: resolved
Type: Research

### Question

怎样用最小、平台无关的契约表达任务、阶段、上下文、work item、事件、活动绑定和错误？

### Answer

Runtime Interface 1.0 已冻结。契约采用 JSON Schema Draft 2020-12 加跨文档语义校验，覆盖任务与 Workflow pin、当前阶段门禁、work-item 验收/返工历史、回滚失效、活动任务解析、Platform Profile 和稳定响应包。OpenCode 的 background 派发约束保留在平台 fixture，不渗入平台中立 schema。两轮交叉审查提出的未来阶段状态预写、外来 work-item、空验收证据、重复 Agent ID 等阻断问题均已补反例并关闭。

验收产物：

- `schemas/`：project-config、task、context、workflow、work-item document、event、binding、platform-profile、response schema 与跨字段语义规则；
- `tests/fixtures/runtime/`：每种 schema 的正常、缺字段、非法状态和版本不兼容样本；
- `docs/runtime-interface.md`：CLI、稳定 JSON 成功/错误 envelope、状态边、阶段介入和门禁语义；
- 契约测试：schema、合法边、非法边、当前阶段最低制品门禁、平台私有字段隔离。

退出条件：已满足。全部契约测试通过，OpenCode/Claude/OMO 名称不进入 CoreRuntime schema。

## core-runtime-mvp: 实现文件型 CoreRuntime

Blocked by: runtime-contract
Status: resolved
Type: Prototype

### Question

文件型 Runtime 能否可靠完成 task/context/flow/work/event，而不引入数据库或常驻进程？

### Answer

文件型 MVP 已实现：公开 CLI 覆盖 init/version/migrate/doctor、task、context、flow、work 和 event；使用 schema/语义双层校验、逐级 realpath/symlink 边界检查、带 owner 的排他文件锁、expected revision、同目录原子替换和可重放事务清单。端到端测试覆盖任意阶段介入、当前阶段门禁、返工历史、绑定歧义、任务终态、dry-run、并发写冲突、损坏状态诊断、中断事务恢复和陈旧锁治理。Terra 挑战审查提出的全部 P1 已补反例并关闭。

验收产物：

- `runtime/`：可执行 CLI 与内部 Module；
- task 创建/绑定/完成、context 注册/渲染、flow check/advance/rollback、work item 生命周期、event/doctor；
- 临时文件 + 原子 rename、文件锁、revision 冲突和可恢复错误；
- 单元与集成测试：并发写、半写入、损坏状态、多活动任务歧义、dry-run、任意阶段介入。

退出条件：无 PlatformPlugin 时可在临时项目完整运行；失败不会静默覆盖或形成死门。

## workflow-teamwork: 接入研发流程与团队 Policy

Blocked by: core-runtime-mvp
Status: resolved
Type: Prototype

### Question

Workflow 和 Team-work 如何只通过 Runtime Interface 协作，同时保持 standalone 与任意阶段介入？

### Answer

Workflow 与 Team-work 已实现为中文、平台无关的 Policy Skill。Workflow 可从任意实际研发阶段创建或恢复任务，只检查当前阶段最低输入，持久化每阶段 solo/team 决策与 SPEC 生命周期，并在流转前预检目标阶段输入；两种拓扑的具体工作都由 Team-work 派发成员承担。Team-work 也可 standalone 从适配阶段创建轻量任务，随后显式写入 team 决策。

Team-work 已覆盖 Junior/Senior/Expert 成本拓扑、单成员 solo、并行 team、非作者挑战者、核心 Expert 裁决、最多三轮自主收敛与人工有限续轮、方案讨论、全视角代码 Review、并行施工、测试、制品汇报、有界恢复和可选同档评分。成员选择脚本在同档内无放回随机，并优先模型差异。两轮 Terra forward test 补齐了初始化、Profile 缺失等待、binding revision、返工目标输入、SPEC/team 状态，以及网关限流后的 work blockage、同档换 Owner 和最终错误审计。

验收产物：

- `skills/workflow/`：阶段、上下文计划、门禁、solo/team 和 SPEC 路由；
- `skills/team-work/`：成本档位、拓扑、场景、三轮收敛、汇报和评分；
- 阶段制品契约及 code-review/方案讨论/并行实施/测试场景 forward test；
- standalone Team-work 与已存在 Workflow task 的双路径测试。

退出条件：已满足。Skill 不直接写控制状态、不解析平台原始配置；策略与 Runtime 回归覆盖任意阶段介入、standalone、成本拓扑、三轮收敛和基础设施恢复。实际 Agent 派发由下一项 OpenCode PlatformPlugin 实现。

## opencode-plugin: 实现首个平台 Adapter

Blocked by: workflow-teamwork
Status: in-progress
Type: Prototype

### Question

怎样利用 OpenCode 原生 Agent、Skill、Plugin、Tool 和 child session 提供稳定的多模型团队工作？

### Answer

第一批平台能力已实现：用户级安装器物化 Workflow、Team-work、CoreRuntime、Plugin、Platform Profile 与指南，首次项目调用再初始化 `.team-work/`。Plugin 启动时读取版本化用户配置，动态注入七个分档 Agent 的 model/effort。`solo/team` 受管派发都使用 `session.create + promptAsync`，并以 task/work-item ID 保存 child session 映射；同一 work item 续派复用会话，失联或停止后才受控替换并保留历史。

安装生命周期采用 digest 清单。更新前备份全部旧受管文件，新路径碰撞和本地修改默认拒绝；`--force` 也必须先备份。smoke test 失败会回滚。卸载只处理清单内文件，修改项默认保留为 partial，任务、制品、Workflow/SPEC 配置和用户 OpenCode 文件始终保留。

OpenCode session 故障事件审计、OpenSpec 准备检查和自动化故障注入已经补齐；安装器不会自动安装或初始化 OpenSpec。真实网关已完成 DeepSeek/Luna 工具调用、双 Junior 后台派发和跨进程续派；剩余工作是补齐含 Owner、Senior 挑战者、核心 Expert 裁决、Lead 控制面验收和最终制品的正式 Workflow 场景 E2E。

验收产物：

- `plugins/opencode/`：安装器、Skills、Junior/Senior/Expert 动态 Agent 配置、Plugin Hook、Runtime Tool 和 Platform Profile；
- 活动 task/session/work-item 映射与最小上下文注入；
- 受管派发只暴露 background/non-blocking Interface，阻塞式请求被拒绝或确定性改写；
- 多模型工具调用、child session 导航、结果收集、跨会话重新绑定和卸载保留项目数据测试。

退出条件：Lead 不被单个 subagent 阻塞；Plugin 故障不损坏 Runtime；失效 child session 可由任务制品恢复并重新派发。

## e2e-stability: 真实研发循环验收

Blocked by: opencode-plugin
Status: open
Type: Prototype

### Question

首版能否在真实项目、多模型和网关故障下完成可恢复研发循环？

### Answer

待完成。

验收产物：

- 从 research、implementation、code-review 任意阶段启动的 E2E；
- solo/team、OpenSpec、返工回退、跨会话恢复和 standalone E2E；
- API 超时/限流、subagent 空结果/失联、Plugin Hook 失败、并发写冲突测试；
- 最终验收报告：通过项、降级项、已知限制、恢复步骤和后续平台适配建议。

退出条件：关键失败路径具有稳定错误码和恢复动作；代码、测试、审查报告与任务状态可追溯。
