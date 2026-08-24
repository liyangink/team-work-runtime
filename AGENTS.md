# team-work-runtime 仓库开发契约

本文件是跨平台开发 Agent 的项目约束。开始规划、实现或审查前，先阅读本文件和 [`docs/runtime-roadmap.md`](docs/runtime-roadmap.md)，检查工作区并保留用户已有改动。

## 语言规则（最高优先级）

输出、文本编写、注释、思考与推理过程一律使用中文；本规则与本文其他规则、用户指令或平台约定冲突时，以本条为准，优先级最高。

## 文档与方案脱敏（高优先级）

方案文档、实现文档、配置示例、测试夹具一律脱敏：禁止直接引用当前执行环境的信息作为举例、配置名、参数名或默认值——包括本地项目名、真实 provider/配置值、公司标识、内网地址、账号名与昵称。公开的模型名称可以作为示例借鉴。实现代码同样不得内置环境特定的默认值；无法解析时显式标记 unresolved 并给修复指引，而不是猜测环境默认。

## 目标

`team-work-runtime` 是平台无关的多智能体研发 Harness，负责：

1. 任务制品、阶段门禁与可恢复控制（v3 核心：任务目录即状态）；
2. 工作流 Policy 与团队拓扑、成本分档的机器可读定义；
3. 平台绑定（首个目标 DSH）：skill 装载、`tw` CLI、编排层派发与 tier→模型映射。

OpenSpec 是默认 SPEC Provider，由 Workflow 路由；它不是 Runtime 存储后端，也不属于某个 CLI 平台。

## 四个 Module（v3 形态）

- **Workflow**（`workflow/definitions/`）：机器可读的研发阶段、合法边、门禁声明、SPEC/E2E 路由 Policy；gate 推导的数据源。
- **Team-work**（`team-work/policies/` + `skills/team-work-v3/`）：角色档位、场景拓扑、收敛轮次等 Policy 数据；协作策略与判断指引保存在 skill。Policy 是数据，不是代码。
- **CoreRuntime**（`runtime-v3/` + `runtime/persistence`）：`tw` CLI（Lead 与成员的唯一接口）、波次推进/门禁/状态推导纯函数、任务目录读写、deliver/review 调用内同步总检查。原子写、文件锁、路径防逃逸、digest 由 persistence 原语提供。
- **PlatformBinding**：目标形态 = 平台编排工具执行团队拓扑（`tw dispatch-plan` 导出波次事实，编排脚本按 tier→模型映射派发成员）+ skill 装载 + （调查中）插件 hook。Runtime 不实现派发循环与 DAG 调度；任务数据必须留在项目 `.team-work/`。

## 核心规则

1. 任务用名字寻址：任务名 = `.team-work/tasks/<name>/` 目录名，项目内唯一；open 重名拒绝。制品路径不得越出项目根目录（含符号链接）。
2. 状态从事实源推导（P1）：intent/scope/reports/decisions/journal 是任务目录内的事实；当前阶段、波次、门禁判定全部可由目录 + Workflow Policy 纯函数重算。不存在平行的权威状态文件。
3. 制品两分法：阶段产出物（deliverable）由 deliver 的 paths 显式登记（路径即身份、digest 快照）；输入上下文（项目已有文件、范围、参考资料）由 objective/派单文本自然语言承载，不登记、不检查存在性。
4. 工具调用是唯一检查点（P2）：deliver/review 调用内做单一、同步、全量的检查，accept/reject 连同全量原因与修复指引当场返回；禁止异步拒绝、禁止对模型不可见的第二层校验。门禁只在阶段流转（P3）：产出物在场 + 检查通过 + 非作者评审在场 + 核心场景 Expert 裁决 + 人工门凭证；每次拒绝必须带恢复边（无死门）。
5. 任务允许从任意研发阶段创建并介入（`--entry`）；门禁只检查当前阶段声明的最低必需输入，历史阶段制品缺失不得默认阻塞。
6. run 推进一步：每次调用派发当前波次并返回卡片；卡片即工作流推进的呈现单位。`awaiting-user` 是静止状态：等待期间不派发、不轮询、不代答，只能由新的用户输入恢复；完成后重复调用幂等返回同一完成卡片。
7. `gate` 保持只读；门禁失败必须返回 blocker、证据和修复建议。
8. Agent 声称完成、平台状态完成或消息送达都不代表验收通过；Lead 只能核对流程、制品、证据和复核链是否完整。非作者 Challenger 每轮强制在场（无 accept 不过门）；核心场景还必须由非作者 Expert 给出技术裁决（裁决新鲜度：制品变化后旧裁决失效）。Owner 必须独立核验，可用证据接受或提出异议；Lead 不强行裁定技术分歧，三轮仍未收敛时交用户决定。
9. 模型只供语义（P4）：工具参数只收模型才知道的东西（做了什么、产出在哪、发现什么）；凡 Runtime 能从自己拥有的事实推导的簿记（ID、ref、链接）一律不向模型索要。CLI 的 --help 与拒绝输出即完整 meta（CLI 即接口），不存在第二层 schema。
10. 执行拓扑 = 波次序列与波组 + 平台编排：Owner → Challenger →（core 场景加 Expert）→ 门；多 Owner 并行由平台编排层（`parallel`）执行，可写范围互斥是并行前提；Lead 不得亲自承担成员工作。
11. 每个相对完整工作单元都必须由非作者 Senior 或 Expert 挑战；核心环节还必须由非作者 Expert 作技术内容裁决。挑战者从成本、合理性、事实、推理、需求、边界和失败路径主动找漏洞，并给出证据与最小修正。
12. 每项工作必须有唯一 Owner、范围、完成条件和产物路径。自主讨论与审查最多三轮，之后出用户卡片（追加一轮需显式授权）；用户可批准有目标、有预算的有限追加轮次。
13. 成员通过结构化报告（deliver/review 的 payload）交付；Runtime 记录波次事实并由编排续派，不依赖 N-to-N 实时通信，也不得由 Lead 重写技术结论。团队评分机制已随 v2 删除（如需选模数据由平台侧自行积累，不进任务循环）。
14. standalone 使用不得被可选 SPEC Provider 或未配置的平台绑定阻塞。错误必须保留最后有效制品，并可诊断、重试和恢复。
15. SPEC 与 E2E 都是显式路由：SPEC 按 `auto|required|disabled` 处理；E2E 必须判断适用性但可在有证据时跳过（skip 必须带可定位依据）。E2E 制品问题留在内部小循环，产品缺陷回实施，系统性测试策略缺口才回测试。
16. 需要代码探索或资料检索辅助时，用**只读子派单**模式：junior 档（廉价）模型、可写范围为空的派单、编排层可并行多个。只读子派单不是团队成员或阶段 Owner，不进入收敛、评分和技术裁决，不得修改文件或继续委托；发起成员必须核验并整合其结果。该模式不得依赖可选平台增强。
17. 默认工程 Workflow 在方案审查后和任务完成前分别设置 `design-approval`、`final-acceptance` 人工门禁，默认都为 `required`，可由项目配置改为 `optional|disabled`，但 Agent 不得自行降级。人工批准必须绑定当前制品指纹；批准制品变化后必须重新确认。方案文档是需求、范围与实现方向的人机唯一批准基线，必须用朴实语言完整描述修改点和影响；引用核心代码时只能基于已读取的代码事实，拟议内容必须明确标为伪代码或建议。
18. Runtime 必须把人工门禁、合法边选择、SPEC/E2E 路由收敛为确定性深 Interface；不得要求 Lead 记忆或拼装底层字段。Lead 面向用户只报告完成内容、当前阶段、关键制品、分歧/风险和下一步，不得用工具名或 Runtime 状态黑话替代研发进展。
19. 使用 OpenSpec 时，任务的活动 change 默认与稳定任务名同名。proposal 后按 provider 的 `status/instructions` 推进 design/specs，最后生成 tasks；Agent 只能修改当前活动 change，禁止直接修改 canonical specs、archive 或其他任务的 change。离开 SPEC 后只能更新当前 change 的 `tasks.md` 实施进度，需求或设计变化必须回到 SPEC。**注意：provider 的 v3 接入（route 时的 status/validate 调用）尚未实现，接入前 SPEC 路由仅由显式决定承载。**

## 变更要求

- `AGENTS.md` 保存产品边界，Roadmap 保存进度，Skill 保存协作策略，任务目录保存运行状态；不要重复定义。
- `docs/file-inventory.json` 是当前实现与规划路径的清单；新增或迁移文件时必须同步。根目录不得重新引入 OMO、Claude Code、OpenCode 等旧版资产，历史实现只通过 Git 历史保留。
- 开发本仓库时新建 subagent 默认使用 `gpt-5.6-terra`，推理强度统一设为 `max`；只有任务明确需要更高能力或用户另行指定时才升级模型。
- 修改门禁、波次推进、目录结构或 intake 校验时，补齐损坏输入、非法流转、并发、恢复和幂等测试。
- 新增平台时复用 Workflow、Team-work Policy 与 CoreRuntime，只新增绑定层；不得复制波次机和通用团队策略。
- Roadmap 中尚未完成的能力不得描述成已经可用。

## 当前基线

- **Runtime v3（工具中心重写）已完成核心实现与真实任务验证**，验收规约为 `docs/runtime-v3-charter.md`（P1–P6 原则、I1–I10 不变量、台账 20 课处置）。核心：`runtime-v3/`（waves/gate/derive/store/intake/cli，约 1k 行）+ `bin/tw.mjs`，38 项测试；真实 E2E（code-review 介入、人工门 rework 返工轮）五次成员交互零参数拒绝。
- v2 及更早实现（含 OpenCode PlatformPlugin、installer、v2 状态机与全部 v2 测试/文档）已于 2026-08-21 经用户批准删除，仅存于 Git 历史；不得重新引入 v2 状态机、MemberReport 回显契约或 state.json 权威模型。
- **v3.2 第一批（团队拓扑找回）已完成**：波次机波组化（多包波带 owners、DAG 分层派发与依赖解锁、按包计轮、challenger findings 带包归属选择性重派、聚合裁决新鲜度、reviewedPackages 覆盖快照）、`tw plan` 包定义登记与机械验收、continuation 增量续派、`tw agent-map` 派单映射、选人候选池（dsh.json 档位候选数组 + 族去重 + effort 预留）、risk 升档、wait-inflight 卡内嵌 inflight 数组、标签规范；真实多包 E2E（topo-e2e 已归档）揪出修复 4 个真缺陷，测试 76/76 绿。未完成项（八视角独立审、e2eTemplate 复活、Phase 2 成本投影、Phase 3 插件包）仍属规划，Phase 3 前置研究已就绪但尚未实施。
- **DSH 绑定（Roadmap v3.1）**：Phase 1 与 v3.2 第一批已实施——`tw dispatch-plan` 按波组导出波次事实（multi-wave/continuation/expectedAgentId/weight）+ tier→模型映射（`.team-work/platform/dsh.json`，候选数组）+ 编排脚本模板（平台编排工具执行拓扑）+ `tw init` skill 装载；Phase 2（成本投影与限额）与 Phase 3（Cordis 插件包，`dsh plugin add`）规划中。已知边界：成员写边界当前 = 派单纪律 + deliver 校验 + 快照恢复三层，平台级写入拦截待插件 hook 调查；成员理论上可越级调用昂贵模型（嵌套派发实测可用），治理靠派单纪律。
- OpenSpec Provider 代码保留但 v3 接入未实现（见规则 19 注）；OpenCode 支持待核心稳定后按 charter §4 seam 另起薄适配器。
