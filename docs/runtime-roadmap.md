# team-work-runtime Roadmap

状态：Runtime 1.0、文件型 MVP、Workflow 与 Team-work Policy 已实现，但实际使用暴露出 Lead 控制面过重、流程状态分散和平台层重复编排问题，已停止继续为 v1 叠加补丁。Runtime v2 的不兼容重构设计已通过人工确认；V2-0 至 V2-5 均已完成并通过两轴终审，下一步进入 V2-6 平台适配。不可变规则见 [`AGENTS.md`](../AGENTS.md)，v2 目标设计见 [`runtime-v2-architecture.md`](runtime-v2-architecture.md)，实施与验收见 [`runtime-v2-implementation-plan.md`](runtime-v2-implementation-plan.md)，十阶段状态机演化审查见 [`runtime-v2-workflow-simulation.md`](runtime-v2-workflow-simulation.md)。

下列 Phase 0–3 记录 v1 已完成基线，Phase 4 记录已落地但尚未完成正式 E2E 的部分实现；它们用于识别可复用的不变量，不再代表下一版目标结构。v2 通过人工设计审核后，以其实施切割替换后续 v1 验收计划；在此之前不得把 v2 能力描述为已经可用。

## v2 重构进度

- 产品边界与不变约束：以 [`AGENTS.md`](../AGENTS.md) 为唯一事实源；
- 目标架构与 Interface：设计已完成并通过交叉终审和人工确认；
- 工作流分支、角色、成本与恢复演化：已完成非规范性验证；
- v2 实现：V2-0 至 V2-5 均已完成并通过两轴终审。V2-5 已把生命周期编排收回 Task Driver，打通只凭 requirement 启动的完整 Workflow happy path、任意阶段 through-stage、planning preflight 转正式多 Owner 计划、Challenger/Expert 后 Owner 证据化回应、方案与最终人工驳回归因、累计成本增额/重规划/停止、成员选择的语义返工边、E2E run/skip/block 与环境恢复，以及 assessment 验收后重启恢复。E2E run 的已验收路由快照会跨阶段复用，不重复评估；Fake SPEC 三模式矩阵、E2E 三类失败回流、三轮后人工有限追加、持久且受预算约束的 DecisionPacket，以及 `owner-rework / collect-evidence / expert-arbitrate` 三种原子受控干预均已通过平台无关 E2E。并发 DecisionPacket 干预和并发人工选择都只能有一个生效；InMemoryStore 异步校验后的 revision 竞争窗口也已关闭。23 项架构故障矩阵已机器化枚举：V2-5 范围全部绑定可执行测试，依赖 OpenCode/OpenSpec Adapter 的 4 项明确留给 V2-6。SPEC Provider 的 prepare/validate/archive 生命周期属于 V2-6。

| v2 里程碑 | 状态 |
| --- | --- |
| V2-0 契约与骨架 | 完成 |
| V2-1 Domain 与 Store | 完成 |
| V2-2 Driver、Observation 与 durable effect | 完成 |
| V2-3 人工等待与决定凭证 | 完成 |
| V2-4 Workflow/Team-work Compiler | 完成 |
| V2-5 平台无关 in-memory E2E | 完成 |
| V2-6 OpenCode/OpenSpec Adapter | 待开始 |
| V2-7 OpenCode 控制面切换 | 待开始 |
| V2-8 安装生命周期、真实 E2E 与发布 | 待开始 |

## v1 Phase 0：规则冻结

状态：完成。

仓库已提供 `AGENTS.md`、本 Roadmap、Runtime 契约和约束测试，并只保留当前实现；旧 OMO/Claude Code 资产仅存在于拆分前的 Git 历史。后续 Agent 不依赖聊天历史或本地 memory 即可恢复方向。

## v1 Phase 1：Runtime 契约

状态：完成。

定义：

- `task.json`：身份、不可变 workflow pin、阶段、SPEC 状态、团队决策、权威 gates/evidence 和任务验收；
- `context.jsonl`：路径、类型、profile、优先级、摘要和必读标记；
- `work-items.json`：带 revision 的 document、Owner、attempt、产物、验证和验收，不包含成本或拓扑策略；
- `events.jsonl`：流转、门禁、恢复、派发和验收事件；
- `bindings/<platform>/<session-key>.json`：可重建的会话到 task-id 绑定；
- Workflow：阶段、合法边、门禁、团队评估点和恢复策略；
- Platform Profile：Agent 目录、原生工具映射、平台限制和增量指南路径；
- Project Config、session binding 与稳定 success/error response envelope；
- 活动任务解析与稳定 JSON 错误协议。

完成标准：schema 有正常和损坏 fixture；状态边可测试枚举；契约不包含平台私有字段。

## v1 Phase 2：Core Runtime MVP

状态：完成。

实现任务初始化、活动绑定、上下文索引和渲染、workflow 加载、门禁、原子阶段切换、通用 work-item、事件和审计恢复。提供 `task/context/flow/work/event/doctor` 命令族。

完成标准：

- 无 PlatformPlugin 也能运行；
- 并发写入不会静默覆盖，多活动任务不会猜测；
- 损坏状态可诊断，恢复保留原因和 blocker；
- 上下文只输出最小索引和路径；
- 写操作具有 dry-run 或等价检查路径。

## v1 Phase 3：Workflow 与 Team-work

状态：完成。

- Workflow 驱动十阶段任务流、上下文计划、solo/team 判断和 SPEC Skill 路由；
- 方案批准与最终验收默认使用 `required` 人工门禁，可按项目配置为 `optional|disabled`；
- Team-work 保留成本、拓扑、Owner/挑战者/Expert 协作、三轮自主收敛、有限人工续轮、汇报和评分能力；
- 两个 Skill 通过 CoreRuntime 记录状态，通过 Project Config/Profile 获取安装结果和平台增量信息。

完成标准：两者可独立 forward test；Team-work 可 standalone 从适配的实际研发阶段创建轻量任务；不解析平台原始配置或复制 Runtime 状态机。

## v1 Phase 4：OpenCode PlatformPlugin

状态：进行中。

打包 Workflow、Team-work、CoreRuntime、Junior/Senior/Expert Agent 和 OpenCode Plugin：

- 用户级安装时扫描模型并物化 Platform Profile，用 OpenCode 全局目录安装 Workflow、Team-work、Runtime 与 Plugin；Agent 在 OpenCode 启动时由用户配置动态注入；
- 首次项目调用时懒初始化 `.team-work/`，物化当前平台 Profile/指南并探测默认 OpenSpec；
- 通过 Plugin 的 session、message、tool 事件完成活动任务识别、上下文注入和生命周期记录；
- 复用原生 subagent child session 与 session 导航，不实现第二套 Agent 调度器；
- 所有受管 Team-work subagent 强制 background/non-blocking 派发；Lead 在显式同步点挂起一次 Plugin 工具调用，由 session 事件直接唤醒并收集结果，等待期间不得通过模型或定时状态轮询；
- 可选地从独立 `helper` 模型配置生成只读 explore/librarian 助手；受管成员通过原生后台 child session 并行检索，助手不成为团队成员或 Runtime work item；
- 使用稳定 task/work-item ID 关联 child session；同一 work item 跨轮次复用会话，Lead 只记录并转发成员与 Expert 结论；
- 跨会话恢复 Runtime 任务、制品与映射；只有失联、停止、换 Owner、职责变化或独立第二意见才新建 child session，并保留旧映射历史；
- 模型/provider/网关仍由 OpenCode 管理，PlatformPlugin 只解析用户 Agent 绑定并注入能力档位。

完成标准：可独立创建、恢复和完成团队任务；多模型 Agent 能正常调用工具；受管派发测试证明不会进入阻塞模式；Lead 与 subagent 获得不同的最小上下文；Plugin 失败不损坏状态或形成死门；卸载不删除项目数据。

已完成：最低版本校验、模型唯一解析、启动时动态 Agent model/effort 注入、独立 helper 模型与只读 explore/librarian 后台辅助链路、跨平台用户配置路径、版本化配置 Schema、用户级 Skill/Plugin 装配、可配置软启停、npm 安装器、项目懒初始化、安装清单、更新备份与回滚、安全卸载、doctor、原生 `promptAsync` child session、稳定 task/work-item 映射、事件驱动挂起与派发轮次级持久提示、深 Runtime `continue` 控制面、阶段重开轮次隔离、人工等待静止协议、最小上下文 Hook、OpenSpec 自动重探测与受管生命周期（活动 change、instructions、路径门禁、完成校验和最终归档）、平台事件审计、右侧 Team 会话与原生 session 跳转，以及网关失败—续派—成员失联的故障注入。侧栏只依赖 OpenCode 官方响应式 session state 重算同步文件快照，不自行创建定时器或订阅事件。

真实网关已完成 DeepSeek/Luna 文本、检索、修改、双 Junior 后台派发和跨进程续派。待完成：在无 OMO 配置中从实际研发阶段完成 Workflow 路由、Owner、挑战者、核心 Expert 裁决、Lead 控制面验收和最终制品的正式场景 E2E。

## v1 Phase 5：Claude Code 与 OMO PlatformPlugin

状态：待开始。

- Claude Code：适配 Agent Teams、Agent/SendMessage/task、Hook 和分屏展示，但不改变通用 Workflow/Team-work。
- OMO：在 OpenCode Plugin 之上可选适配 `team_*`，把消息、重试和关闭增量规则限制在 PlatformPlugin 内。

完成标准：同一个任务可以由不同 CLI 继续，平台 ID 变化不影响任务身份和制品历史。

## v1 Phase 6：稳定性

状态：待开始。

覆盖进程中断、半写入、锁竞争、Hook 超时、网关错误和成员失联；完善 `doctor`、事件查询和团队状态视图，并用真实任务评估恢复率、误阻断率、上下文体积和成本。

完成标准：关键失败路径都有稳定错误码、恢复建议和自动测试，平台故障不会破坏 Core Runtime 数据。

## 暂不实施

N-to-N 消息总线、分布式调度、常驻 daemon、默认数据库、统一多 CLI UI，以及由评分自动触发返工或模型升级。只有真实使用证据证明必要时再加入路线。
