# Runtime v2 实施与验收计划

状态：规划已建立；V2-0 契约与骨架、V2-1 Domain 与文件 Store 已完成并通过两轴终审，下一里程碑为 V2-2。规范性架构见 [`runtime-v2-architecture.md`](runtime-v2-architecture.md)，产品边界见 [`AGENTS.md`](../AGENTS.md)。

## 1. 实施目标

本计划把已批准的 v2 架构拆成可独立审查、测试和回退的里程碑。最终验收不是“新 Runtime 能跑”，而是：

- Lead 正常只需 `open / plan / run / steer`；
- Runtime 独占流程状态、派发事务、恢复和上下文投影；
- Workflow 和 Team-work 以机器化 Policy 提供流程与团队策略；
- OpenCode 和 OpenSpec 只通过 Adapter Interface 接入；
- 宿主重启、网关错误、半完成副作用和人工等待均能稳定收敛；
- v1 公开控制面、schema 和状态兼容分支被删除，不留转发层。

## 2. 实施策略

### 2.1 建设与切换

采用“源码并行建设、运行时一次切换”：

1. 新 v2 Module 按目标路径直接建立，通过 Fake Adapter 和 v2 专用测试运行；
2. v2 不 import、包装或转发 v1 Runtime/LeadController；
3. v1 公开入口在 v2 in-memory E2E 通过前保持可用，但不再增加功能；
4. OpenCode/OpenSpec Adapter 完成后，一次性把公开入口切到 v2；
5. 切换后立即删除 v1 命令族、schema、兼容 fixture 和被 v2 契约覆盖的旧测试。

这是开发期并存，不是运行时兼容。任何里程碑都不得以“先调 v2，失败再调 v1”作为过渡方案。

### 2.2 提交与回退

- 每个里程碑由 2–5 个小提交组成：契约/骨架、实现、故障测试、文档/清单；
- 不在同一提交混合大量文件移动与行为修改；
- 回退以 Git 提交为单位，不在产品中建立 v1 兼容开关；
- 未通过当前里程碑退出条件前，不开始后续 Adapter 或 UI 工作。

### 2.3 审查成本

- 普通实现和测试默认使用 Terra；
- schema/状态机、durable effect、人工门禁、公开切换各保留一次独立 Senior Challenger 审查；
- in-memory E2E 和公开切换使用一位非作者 Expert 终审；
- 只在独立 Expert 不能收敛或有高风险安全/一致性分歧时增加第二 Expert。

## 3. 全局验收产物

| 类别 | 必须产物 |
| --- | --- |
| 公开契约 | LeadControl、MemberDelivery、PlatformObservationSink、ExecutionAdapter、SpecProviderAdapter 的 schema/类型与 contract fixtures |
| Runtime | Task Aggregate、Reducer、StagePlan、Driver、Reconciler、Effect Coordinator、Human Wait、File Store |
| Policy | Workflow Compiler、Team-work Compiler、engineering workflow、default team policy、版本与 digest pin |
| Adapter | Fake Execution/SPEC、OpenCode Execution、OpenSpec Provider |
| 控制面 | 四个 Lead 工具、成员 report 工具、短 ActionCard、按需 DecisionPacket |
| 可靠性 | 并发、损坏输入、幂等、in-doubt、宿主重启、人工等待、部分文件的故障矩阵 |
| 平台 | OpenCode 背景派发/续派、事件唤醒、上下文注入、TUI 投影、安装/更新/卸载/doctor |
| 验收 | 全流程、任意阶段介入、standalone、SPEC/E2E 分支、网关故障和跨进程恢复报告 |

## 4. 里程碑

### V2-0：冻结契约与骨架

目标：让后续 Module 只能通过已审查 Interface 协作。

实施：

- 新建 `schemas/v2/`，定义四动作、RuntimeCard、DecisionPacket、MemberReport、ExpertVerdict 和 Port intent/receipt；TaskState 由 V2-1 随 Domain 不变量定义，Workflow/Team Policy schema 由 V2-4 定义，避免在实现未探明前冻结内部形状；
- 新建 `runtime/index.mjs`、`lead-control.mjs`、`member-delivery.mjs`、`platform-observation.mjs` 空骨架；
- 新建 `runtime/ports/execution.mjs` 和 `spec-provider.mjs`；
- 建立 `tests/v2/contract/` 的正向、损坏、未知字段、版本不兼容 fixture；
- 固定 Runtime major=2，明确拒绝 v1 项目根。

退出条件：

- 五个稳定 seam 无 OpenCode/OpenSpec 私有字段；
- `steer` 未知 action、额外底层编排字段和缺失必需字段稳定拒绝；与当前状态相关的 action 语义由 V2-4 Policy Compiler 校验，不在 schema 中提前硬编码；
- ActionCard 和 ProblemCard 只有一个 next action；
- v2 contract tests 全部通过，v1 公开入口尚未切换。

### V2-1：Domain 与文件 Store

目标：建立单一权威状态和纯状态转移内核。

实施：

- `runtime/domain/`：Task Aggregate、Reducer、StagePlan、WorkGraph、Invariants；
- `runtime/persistence/`：FileStore、Transactions、Paths、Recovery；
- `state.json` 作为唯一权威快照，reports/operations 不可变，events 只审计；
- 实现 task-id、entry/completion、stageRun、assignment attempt、artifact/evidence digest、Cost Ledger 数据不变量；
- 复用但重写原子 rename、带 owner 锁、realpath/symlink 边界和中断事务恢复。

退出条件：

- Reducer 是纯函数，不访问文件、网络、时钟或 Platform Adapter；
- 合法边、非法边、任意阶段介入、completion 子图和证据失效可枚举测试；
- 并发写、半写、损坏状态和路径逃逸全部 fail closed；
- 不存在与 `state.json` 并列的业务状态源。

### V2-2：Driver、Observation 与 durable effect

目标：让 Runtime 能在不依赖 Lead 轮询的情况下派发、等待、回收和恢复。

实施：

- `runtime/application/driver.mjs`、`effect-coordinator.mjs`、`reconciler.mjs`、`signal-hub.mjs`；
- Observation Inbox 的 sequence、dedupe、ack、崩溃重放和安全压缩；
- dispatch/stop 的 intent-before-effect、operationId/effectDigest、inspect-before-retry；
- MemberDelivery 的结构化 report 校验、不可变落盘和 inbox 原子提交；
- `run` 的双检查信号等待，只以持久状态为事实源。

退出条件：

- 没有 receipt 的 assignment 不能成为 running；
- 重复 report/observation/effect 不产生重复状态转移；
- 崩溃点故障注入最终收敛到 working、blocked、awaiting-user、completed 或 cancelled；
- Lead 不接收成员完整 transcript 或工具日志。

### V2-3：人工等待与决定凭证

目标：实现无后台续跑、无模型轮询的静止人工门禁。

实施：

- `runtime/application/human-wait.mjs`；
- prepare-quiesce-commit 事务和晚到 observation 隔离；
- `verified-event | trusted-caller | unsupported` 三种 capability；
- 决定与 stageRun/evidence digest 绑定，制品变化自动失效；
- design approval 和 final acceptance 的 required/optional/disabled 编译检查。

退出条件：

- 只有 confirmed quiesce receipt 能进入 awaiting-user；
- awaiting-user 无 timer、poll、continuation 或新 dispatch；
- Agent 无法伪造 trusted-caller，平台旧消息无法通过 verified-event；
- unsupported + required 在 Workflow 编译期失败，不形成运行时死门。

### V2-4：Workflow 与 Team-work Policy Compiler

目标：把流程、拓扑和收敛从长 Skill 文本中移入可版本化、可测试的 Policy。

实施：

- `workflow/compiler.mjs` 和 `workflow/definitions/engineering.json`；
- `team-work/compiler.mjs`、`team-work/policies/default.json` 与最小 prompt templates；
- TaskIntent 继承、planning bootstrap、solo/team、Owner/Challenger/Expert、integration Owner、三轮收敛；
- SPEC RouteState 和 E2E RouteState 决策表；
- Cost Ledger 的 forecast、nextWave、automaticLimit、in-doubt uncertain；
- `steer` 受控干预和 Expert 仲裁/第二意见。

退出条件：

- Workflow/Team-work Policy 不读平台原始配置，Platform Adapter 不复制状态机；
- 简单计划不默认增加 planning Agent，复杂计划才派 planning Owner；
- Review 不递归审查 Review report，Expert 作者不能裁决自己的制品；
- SPEC/E2E 的 run/skip/block 都有固定 digest 和证据；
- 超预算和三轮未收敛只返回用户选择，不静默扩容。

### V2-5：平台无关 in-memory E2E

目标：在接入 OpenCode 前证明 CoreRuntime + Policy 可独立闭环。

实施：

- Fake Execution Adapter 和 Fake SPEC Adapter；
- 只通过 LeadControl、MemberDelivery、PlatformObservationSink 驱动的 E2E harness；
- full workflow、through-stage、research/implementation/code-review 介入；
- solo/team、SPEC 三模式、E2E 三模式/内部小循环、人工驳回、三轮与成本越界；
- 架构文档故障矩阵的自动化枚举。

退出条件：

- 不直接调用 Reducer、Store 或 Adapter 修改业务状态；
- 所有正常路径中 Lead 动作数可计数，无逐阶段手工编排；
- ActionCard/DecisionPacket 通过字段与 code-point 预算；
- Senior Challenger 与非作者 Expert 交叉审查通过后，才允许开始平台接入。

### V2-6：OpenCode Execution Adapter 与 OpenSpec Provider

目标：把已验证的平台能力接到 v2 Port，不引入第二状态机。

实施：

- `plugins/opencode/adapter/`：capability snapshot、bind、ensure/inspect/stop execution、quiesce、human proof；
- `spec-providers/openspec/`：probe、prepare、status、validate、archive、inspect；
- OpenCode event 归一化后只提交 PlatformObservationSink；
- background/promptAsync、同 assignment 续派、lost 识别、网关错误分类；
- OpenSpec operationId/effectDigest 幂等、活动 change 边界和归档结果重建。

退出条件：

- Adapter contract suite 与 Fake 使用相同 fixtures；
- OpenCode Adapter 不决定 accept/rework/advance，不维护 pendingSync 业务状态；
- 重启后 ensure/inspect 不重复创建 session/change/archive；
- OpenSpec 不依赖 OpenCode，standalone Fake/CLI 可替换该 Provider。

### V2-7：OpenCode 控制面切换

目标：让真实 Lead 只看见简单、运行稳定的 v2 控制面。

实施：

- `plugins/opencode/tools/`：四个 Lead tool + 一个 member report tool；
- `plugins/opencode/context/`：Lead/Owner/Challenger/Expert/Helper 最小上下文；
- 更新薄 Workflow/Team-work Skill，删除 Runtime 命令教程；
- TUI 只读 Runtime 投影，保留 child session 跳转，不保存业务状态；
- root CLI 和 npm package 公开 v2，删除 v1 `executeRuntime`、LeadController 命令族和旧 schema。

退出条件：

- Lead 工具 meta 不包含 revision、gate、work-item、session、SPEC command 或恢复教程；
- 普通任务推进不需要 Lead 读 Runtime 源码；
- 旧 `.team-work` 根稳定返回 major mismatch，不自动迁移；
- 全量仓库测试在删除 v1 测试后仍全绿，没有 v2→v1 import。

### V2-8：安装生命周期、真实 E2E 与发布

目标：证明新架构在真实 OpenCode/网关下可用，并能安全更新、卸载和诊断。

实施：

- 更新 installer manifest、package files、config schema、doctor 和旧版检测；
- 安装/更新先备份受管文件，失败回滚，卸载不删项目任务数据；
- 使用 DeepSeek/Luna 完成低成本真实链路；
- 覆盖完整 Workflow、standalone code-review、OpenSpec、用户人工门禁、宿主重启、网关错误和成员失联；
- 用 Senior Challenger + Expert 完成最终正式场景审查。

退出条件：

- 安装、更新、软停用、卸载、doctor 均通过破坏性 fixture；
- 真实网关故障后不重复派发、不丢 report、不损坏 state；
- Lead 汇报只包含研发进展、制品、分歧/风险和下一步，不出现 Runtime 黑话；
- 用户完成 final acceptance 后才允许 OpenSpec archive 和发布。

## 5. 切换前的强制门禁

V2-7 公开切换前必须同时满足：

1. V2-0–V2-6 全部退出条件通过；
2. in-memory E2E 只通过五个稳定 seam 完成；
3. 架构文档中所有故障矩阵已自动化；
4. Standards 审查、Senior Challenger 和 Expert 均无 P0/P1；
5. 一份不依赖 v1 的切换清单已生成并人工确认。

任一未满足时，v1 可继续作为开发期对照基线，但不允许把部分 v2 工具提前发布给 Lead。

## 6. 新旧文件账本

### v2 新建/重写目标

```text
runtime/index.mjs
runtime/lead-control.mjs
runtime/member-delivery.mjs
runtime/platform-observation.mjs
runtime/{application,domain,persistence,ports}/
workflow/
team-work/
spec-providers/openspec/
schemas/v2/
plugins/opencode/{adapter,tools,context,tui,lifecycle}/
tests/v2/
```

### 切换时删除/替换

```text
runtime/core.mjs
runtime/cli.mjs 中的 v1 命令分派
schemas/ 中 v1 task/context/work/event/binding/response 契约
tests/fixtures/runtime/ 中 v1 状态 fixture
plugins/opencode/src/lead-controller.mjs
plugins/opencode/src/opencode-adapter.mjs 中的业务编排
plugins/opencode/assets/team-work.js 中的 v1 Lead 工具
skills/workflow/references/runtime-commands.md
只验证 v1 公开命令和状态形状的测试
```

最终删除清单在 V2-7 前由 import graph、package files、installer manifest 和测试引用自动扫描生成，不依赖人工记忆。`docs/file-inventory.json` 每个里程碑同步更新。

## 7. 每个里程碑的 Definition of Done

- 实现、schema、fixture、自动测试和必要文档同步提交；
- 新增路径同步 `docs/file-inventory.json`；
- 正常、损坏输入、非法流转、并发、恢复和幂等根据变更面有测试；
- 没有新的 v2→v1、CoreRuntime→Platform Implementation 或 Team-work→Workflow 反向依赖；
- Lead 默认上下文体积和工具参数没有因新能力无界增长；
- 独立审查发现的 P0/P1 在进入下一里程碑前关闭；
- Roadmap 只更新真实完成状态，不把计划描述为可用能力。

## 8. 立即下一步

完成 V2-1 两轴终审后进入 V2-2：实现 Driver、Observation Inbox 与 durable effect。V2-2 不改动 Lead Interface，也不提前接入 Platform Adapter 或安装器。
