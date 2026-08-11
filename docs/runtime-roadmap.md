# team-work Runtime Roadmap

状态：Runtime 1.0、文件型 MVP、Workflow 与 Team-work Policy 已实现，OpenCode PlatformPlugin 正在完成正式场景验收。不可变规则见 [`AGENTS.md`](../AGENTS.md)，实现设计见 [`runtime-plugin-design.md`](runtime-plugin-design.md)，逐项实施与验收见 [`runtime-implementation-plan.md`](runtime-implementation-plan.md)。

## 目标结构

```text
runtime/        CoreRuntime：task、context、flow、work-item、event
skills/         Workflow 与 Team-work
plugins/        claude-code、opencode、omo
schemas/        project-config、task、context、workflow、work-item(s)、event、binding、platform-profile、response
```

项目状态统一放在 `.team-work/`：

```text
.team-work/
├── config.yaml
├── workflows/engineering.yaml
├── bindings/<platform>/<session-key>.json
├── platform/<platform>/{profile.json,guides/}
├── tasks/<task-id>/{task.json,context.jsonl,index.md,work-items.json,events.jsonl,artifacts/}
└── archive/
```

## 已冻结决策

- 产品只保留 Workflow、Team-work、CoreRuntime、PlatformPlugin 四个核心 Module。
- 初版使用文件、原子写入和文件锁，不引入数据库或常驻服务。
- 原始制品不复制；`context.jsonl` 是索引，`index.md` 是生成视图。
- OpenSpec 是默认 SPEC Skill；PlatformPlugin 安装期准备工具并写入项目 Workflow Config，Workflow 运行期只读取配置。
- Workflow 决定是否建团，Team-work 只负责建团后的协作。
- 先完成 OpenCode PlatformPlugin，再适配 Claude Code 和 OMO；首版不依赖平台原生 Team Agent。

## Phase 0：规则冻结

状态：完成。

仓库已提供 `AGENTS.md`、本 Roadmap、Runtime 契约和约束测试；旧 OMO/Claude Code Skill 已移入 `archive/`，仅作为历史参考。后续 Agent 不依赖聊天历史或本地 memory 即可恢复方向。

## Phase 1：Runtime 契约

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

## Phase 2：Core Runtime MVP

状态：完成。

实现任务初始化、活动绑定、上下文索引和渲染、workflow 加载、门禁、原子阶段切换、通用 work-item、事件和审计恢复。提供 `task/context/flow/work/event/doctor` 命令族。

完成标准：

- 无 PlatformPlugin 也能运行；
- 并发写入不会静默覆盖，多活动任务不会猜测；
- 损坏状态可诊断，恢复保留原因和 blocker；
- 上下文只输出最小索引和路径；
- 写操作具有 dry-run 或等价检查路径。

## Phase 3：Workflow 与 Team-work

状态：完成。

- Workflow 驱动十阶段任务流、上下文计划、solo/team 判断和 SPEC Skill 路由；
- Team-work 保留成本、拓扑、场景、三轮收敛、汇报和评分能力；
- 两个 Skill 通过 CoreRuntime 记录状态，通过 Project Config/Profile 获取安装结果和平台增量信息。

完成标准：两者可独立 forward test；Team-work 可 standalone 从适配的实际研发阶段创建轻量任务；不解析平台原始配置或复制 Runtime 状态机。

## Phase 4：OpenCode PlatformPlugin

状态：进行中。

打包 Workflow、Team-work、CoreRuntime、Junior/Senior/Expert Agent 和 OpenCode Plugin：

- 用户级安装时扫描模型并物化 Platform Profile，用 OpenCode 全局目录安装 Workflow、Team-work、Runtime 与 Plugin；Agent 在 OpenCode 启动时由用户配置动态注入；
- 首次项目调用时懒初始化 `.team-work/`，物化当前平台 Profile/指南并探测默认 OpenSpec；
- 通过 Plugin 的 session、message、tool 事件完成活动任务识别、上下文注入和生命周期记录；
- 复用原生 subagent child session 与 session 导航，不实现第二套 Agent 调度器；
- 所有受管 Team-work subagent 强制 background/non-blocking 派发；Lead 在显式同步点查询状态并收集结果，禁止阻塞等待单个成员；
- 使用稳定 task/work-item ID 关联 child session，Lead 通过汇总、续派和共享制品协作；
- 跨会话只恢复 Runtime 任务、制品与映射，失效 subagent 在需要时重新创建；
- 模型/provider/网关仍由 OpenCode 管理，PlatformPlugin 只解析用户 Agent 绑定并注入能力档位。

完成标准：可独立创建、恢复和完成团队任务；多模型 Agent 能正常调用工具；受管派发测试证明不会进入阻塞模式；Lead 与 subagent 获得不同的最小上下文；Plugin 失败不损坏状态或形成死门；卸载不删除项目数据。

已完成：最低版本校验、模型唯一解析、启动时动态 Agent model/effort 注入、跨平台用户配置路径、版本化配置 Schema、用户级 Skill/Plugin 装配、npm 安装器、项目懒初始化、安装清单、更新备份与回滚、安全卸载、doctor、原生 `promptAsync` child session、稳定 task/work-item 映射、最小上下文 Hook、OpenSpec 模式路由、平台事件审计，以及网关失败—续派—成员失联的故障注入。

真实网关已完成 DeepSeek/Luna 文本、检索、修改、双 Junior 后台派发和跨进程续派。待完成：在无 OMO 配置中启用一个低成本 Senior，从实际研发阶段完成 Workflow 路由、挑战者、Lead 验收和最终制品的正式场景 E2E。除非场景达到升级条件，不调用 Expert。

## Phase 5：Claude Code 与 OMO PlatformPlugin

状态：待开始。

- Claude Code：适配 Agent Teams、Agent/SendMessage/task、Hook 和分屏展示，但不改变通用 Workflow/Team-work。
- OMO：在 OpenCode Plugin 之上可选适配 `team_*`，把消息、重试和关闭增量规则限制在 PlatformPlugin 内。

完成标准：同一个任务可以由不同 CLI 继续，平台 ID 变化不影响任务身份和制品历史。

## Phase 6：稳定性

状态：待开始。

覆盖进程中断、半写入、锁竞争、Hook 超时、网关错误和成员失联；完善 `doctor`、事件查询和团队状态视图，并用真实任务评估恢复率、误阻断率、上下文体积和成本。

完成标准：关键失败路径都有稳定错误码、恢复建议和自动测试，平台故障不会破坏 Core Runtime 数据。

## 暂不实施

N-to-N 消息总线、分布式调度、常驻 daemon、默认数据库、统一多 CLI UI，以及由评分自动触发返工或模型升级。只有真实使用证据证明必要时再加入路线。
