# team-work-runtime Roadmap

状态：**v3 工具中心重写进行中**（规约：[`runtime-v3-charter.md`](runtime-v3-charter.md)）。v2 未发布即冻结：V2-8 E2E 台账（20 项）的根因分析结论是 v2 契约设计（MemberReport 回显、EvidenceVerifier 职责、state.json 权威模型）制造了三层不可见校验与平行状态宇宙；继续修补的成本高于重写。**OpenCode PlatformPlugin（plugins/opencode/，约 2.6k 行）自 2026-08-21 冻结**：停止投入、不在 v3 打包清单，OpenCode 支持待 v3 核心稳定后按规约 §4 seam 另起薄适配器。首个 v3 平台绑定为 DSH。不可变规则见 [`AGENTS.md`](../AGENTS.md)，v2 历史设计文档已随实现清理（Git 历史可查；其 §7.3/§8.6/§11 已被 v3 规约替代），真实问题台账见 [`v2-e2e-findings.md`](v2-e2e-findings.md)。

## v3 里程碑（工具中心重写）

- 规约冻结：P1–P6 原则、I1–I10 不变量、台账 20 课处置映射、目录约定与归档、模块判决——已完成；
- 核心实现：waves/gate/derive/store/intake、tw CLI 九命令（open/run/decide/intent/route/archive/gate/deliver/review）、bin/tw.mjs 入口——已完成；
- DSH 绑定：唯一 skill team-work-v3（Lead 判断指引 + 成员纪律）、派发经后台 subagent——已落地；
- 真实 E2E（DoD #4）：已完成。audit-live 任务全链路实测：code-review 介入 → Owner 交付 → Challenger/Expert 评审 → 用户人工门 rework → Owner 原地修订 → Challenger/Expert 复审（裁决新鲜度强制重裁）→ E2E 路由 skip（带依据）→ 人工门 accept → completed → 归档（只读强制 + 终态幂等 + 归档摘要卡）。五位成员交互零参数形状拒绝（优于 DoD 允许的一次）；返工轮实测暴露并修复了人工门 rework 分支丢失、Expert 裁决无新鲜度校验、respond 派单不含返工原因三个缺陷，各有回归测试（33/33 绿，v2 套件不受影响）；
- 预算终核（DoD #3）：实现 979 行 ≤3k；断言测试 599 行（复核修复后现状：实现 1059 行、断言 678 行、42/42 测试绿，比率 0.64 略超 0.6，为并发安全与恢复闭环的增量）；
- 旧实现清理（2026-08-21，用户批准）：v2 Runtime 状态机、OpenCode PlatformPlugin、installer、v2 skills/schemas/测试/文档已全部删除（Git 历史可恢复）；保留件仅 persistence 原语、workflow 定义、team-work policy、OpenSpec provider、policy kernel；package.json 零运行时依赖，bin 只剩 `tw`。
- **交叉复核与修复（2026-08-21，双 subagent 独立审计）**：修复两个实证竞态——并发 deliver 丢登记（读-算-写整体入任务锁）、并发/重复 run 双派发（derive 增加在途波次检查：派发未交付=等待态）；补 I8 恢复闭环 `tw restore`（快照恢复死代码激活）；project.json 版本标记显式化；部分失败孤儿快照消除（先读全部再写）。文档对齐：charter §5 与实现一致（gates/runtime.json 删除、decisions 单文件、journal 七事件、reviews 入 manifest）、route 补进工具面（九命令）、§6.2 文件名纠正。遗留已知项：cmdRun 职责集中（重构候选）、checks 平台对账待 DSH 绑定层、成员越级模型调用治理待插件 hook。

下列 Phase 0–3 仅记录 v1 历史基线，Phase 4 记录迁移前的平台能力；它们用于追溯可复用的不变量，不再代表当前结构或后续实施计划。当前实现与验收状态以 v2 里程碑为准。

## v2 重构进度

- 产品边界与不变约束：以 [`AGENTS.md`](../AGENTS.md) 为唯一事实源；
- 目标架构与 Interface：设计已完成并通过交叉终审和人工确认；
- 工作流分支、角色、成本与恢复演化：已完成非规范性验证；
- v2 实现：V2-0 至 V2-7 已完成；V2-8 已通过 363/363 完整仓库测试和 npm 打包清单验证。用户配置的 Agent 目录改为 role 驱动（junior/senior/expert/challenger/assistant，challenger 回退 senior、assistant 回退 junior），能力快照 digest 保持兼容，挂起任务可跨升级续跑；平台层强制派单写边界、任务制品内容快照与越权自动恢复已落地并经真实任务复验。无 OMO 的 DeepSeek/Luna 正式 code-review 场景已完成 Owner、Senior Challenger、Expert、多轮收敛、重启恢复和最终人工验收；最新修复后的新人工门禁复验仍待完成。

| v2 里程碑 | 状态 |
| --- | --- |
| V2-0 契约与骨架 | 完成 |
| V2-1 Domain 与 Store | 完成 |
| V2-2 Driver、Observation 与 durable effect | 完成 |
| V2-3 人工等待与决定凭证 | 完成 |
| V2-4 Workflow/Team-work Compiler | 完成 |
| V2-5 平台无关 in-memory E2E | 完成 |
| V2-6 OpenCode/OpenSpec Adapter | 完成 |
| V2-7 OpenCode 控制面切换 | 完成 |
| V2-8 安装生命周期、真实 E2E 与发布 | 实现与复验收敛：待发布决策 |

## v3.1 DSH 适配：编排引擎与成本映射（规划 2026-08-21 第二稿，修正两处认知偏差）

### 设计原则（修正稿）

1. **团队拓扑在平台层编排，不在 runtime 重建**：DSH 的 workflow 编排工具（`agent(prompt, opts)` / `pipeline(items, ...stages)` / `parallel(thunks)` / 结构化 `schema` 结果）是拓扑执行引擎。runtime 只提供**波次事实**（`tw dispatch-plan`）与**验收**（deliver/review/gate），不实现派发循环与 DAG 调度——E2E 时"Lead 手动逐个 subagent"是权宜形态，目标形态是编排脚本一次驱动整段房间（从当前波次到下一扇门）。
2. **成本控制的本质是 tier→模型映射**：`agent(prompt, {provider, model})` 的独立 LLM target 覆盖是平台原语。简单任务用廉价模型、复杂任务投入高预算 = 派单时按 tier 指定模型；`costWeights`（1:10:50）是映射的权重标注，服务于成本展示与限额判断——不是记账。
3. `awaiting-user` 语义在编排下的落点：编排脚本推进到人工门即终止返回卡片；不越门、不代答。
4. **嵌套派发（实测 2026-08-21）**：DSH subagent 拥有完整工具面（含 `subagent/subagent_fork/workflow`），成员可自行派发子代理；跨层通信受限——`send_message` 仅达 depth-1 直接子代，更深层只能 `interrupt_agent`。团队树深度纪律：Lead(0) → 成员(1) → 只读子派单(2) 为止（规则 16"不得继续委托"即深度上限）。成员层成本治理当前只能靠派单纪律（成员可越级调用昂贵模型，Phase 3 调查 hook 拦截）。

### Phase 1：编排绑定（目标形态，待实测）

1. **`tw dispatch-plan --task <name>`**（runtime 侧新增）：输出当前可派发波次的机器可读描述 `[{dispatchKey, role, tier, kind, round, prompt, writable[], dependsOn[]}]`——编排脚本的唯一输入；波次推进逻辑（waves.mjs 纯函数）不变，门与人工门语义不变。
2. **tier→模型映射配置** `.team-work/platform/dsh.json`：`{tiers: {junior: {provider?, model}, senior: {...}, expert: {...}}, defaults}`；`tw init` 生成模板。角色消费档位：Owner 用场景 `ownerTier`，**Challenger 用场景 `challengerTier`（默认 senior）**，Expert 用 expert。示例：junior→廉价快速模型，senior→强推理中价模型，expert→旗舰模型。**只读子派单（原 v2 助手）= junior 档 + writable 为空 + parallel() 并行**，不设专属角色。
3. **编排脚本模板**（skill references 提供，Lead 经 workflow 工具执行）：读映射 + dispatch-plan → 循环 {并行派发无依赖波次（`agent(prompt, modelByTier[tier])`，成员在 agent 内调 `tw deliver/review --key`）→ `tw run` 消费推进} 直到 gate/awaiting-user 返回卡片。
4. **review 复杂拓扑模板**：八视角 Owner → 并行多 Challenger（`parallel`，按视角分组）→ Expert 裁决 → 门；重派轮在脚本内闭环（rework 波次由 dispatch-plan 顺序导出）。
5. skill 投递：`tw init` 安装到项目 `.dsh/skills/`（DSH filesystem provider 扫描该根）。
- **已知边界（如实记录）**：成员写边界仍是派单纪律 + deliver 校验 + 快照恢复（三层已实现）；编排层按派单沙箱待 Phase 3 调查插件 hook。

### Phase 2：成本投影与限额（建立在映射之上）

- `tw status --task <name>`：journal 的 dispatched 波次 × 映射权重 **纯推导**累计相对成本与"下一波预估"（P1：投影非账本，无新状态文件）；
- 编排脚本在下一波预估将越过 `automaticLimits` 时先出用户卡片（软预算门），不静默升级；
- `concurrencySoftLimit` 作为编排脚本 `parallel` 的并发上限参数。

### Phase 3：DSH 插件包（team-work-runtime-dsh）

- Cordis 插件：`ctx.skills.register` 内嵌 skill 与编排模板（免文件拷贝、随包版本化）；调查 `ctx.tools` 原生工具封装与成员写边界 hook；
- **成员模型/effort 注入（实测可行，2026-08-24；寻址方案定稿）**：`ctx.subagents.registerContinuableSetup` + `installModelSelection` 向 continuable 子代注入 `{provider, model, reasoningEffort}`（官方 API，fresh+cold-resume 均覆盖）。**寻址 = 子代上下文内的派单事实**：注入监听器从子代首条消息（派单 prompt，含 `# 派单（key: …）` 与任务名）解析身份 → 读 `.team-work/platform/agents.json`（Lead 派发前经 agent-map --model-hint 落盘）→ 按键注入。多任务天然隔离（各子代携各自任务事实）、重派新 key 新决策（无需重命名）、恢复路径同注入。标签卸下寻址职责回归纯人读分组建。workflow 一次性子代不可达（RO 扇出，低需求可接受）。残余验证：监听器触发时 ctx 内首条消息可见形态；
- 发布 npm → `dsh plugin add team-work-runtime-dsh`；
- `e2eTemplate` 仅在 e2e 路由 run 时物化子波次图（当前路由只是门检查）。

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

真实网关已完成 DeepSeek/Luna 文本、检索、修改、双 Junior 后台派发、跨进程续派，以及无 OMO 正式 code-review 团队闭环和最终人工验收。完整 Workflow、OpenSpec、网关错误与成员失联由平台无关 E2E、Adapter 集成和故障矩阵覆盖；当前待完成最新修复后新任务的人工门禁实测，详见问题台账。

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
