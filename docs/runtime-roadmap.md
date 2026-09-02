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
- **v3.2 团队拓扑与全局选模已完成**：波次机波组化（多包 produce/respond 波带 owners、DAG 分层派发与依赖解锁、按包计轮、challenger findings 带包归属选择性重派、聚合裁决新鲜度、reviewedPackages 评审覆盖快照）、`tw plan` 机械验收、continuation 增量续派、`tw agent-map` 派单映射、候选池、同波家族多样性、可选 effort、risk 升档、wait-inflight 卡与标签规范均已实施。tier→模型的唯一配置源改为 DSH 全局 settings 的 `team-work-dsh.tiers`（DSH Web“插件配置”页）：兼容单对象或数组，provider/model 必填，family/effort 可选；无完整三档时 dispatch-plan 返回可恢复 blocked 卡。项目 `.team-work/platform/dsh.json` 不读取、不创建，遗留文件可手动删除；`.team-work/tasks/<任务>/agents.json`（任务级注册表）保存该任务的映射与 modelHint 快照。全局配置热变只影响后续波次，已派发波次不重选。
- **角色/场景公共引导库已完成（2026-08-26）**：`team-work/guidance/roles/<role>.md`（owner/challenger/expert 通用纪律）与 `team-work/guidance/scenes/<sceneId>.md`（编码/测试场景指引，键 = 阶段 teamScene）两级数据；`runtime-v3/guidance.mjs` 分层加载——包内默认基线 + 项目根 `team-work/guidance/` 同名文件逐文件覆盖，缺失目录/文件静默跳过（引导是增强不是门禁）；派单按 `role+teamScene` 检索注入（run 与 dispatch-plan 同源，含续派与在途重建），扩展 = 新增 md 文件；skill 增 references/guidance.md 说明检索层级与扩展方式；7 项回归测试覆盖加载、覆盖、注入与缺失跳过。
- **v3.3 DSH 定向委派（第一阶段已实施，真实 DSH 验收待做）**：在基础设施层的 DSH PlatformBinding 内增加 `tw-tool-subagent`（命名对齐 DSH 工具目录的 `dsh-tool-subagent`，短横线风格），复用 DSH 原生可续聊子会话。工具支持档位或精确 provider/model/effort；插件使用 UUID v4 预生成 sessionId，创建前验证模型，并在启动持久化确认（sessionPersistence 在场 + flush 参与）后才报告成功；首请求 header 运行期对账经用户裁决砍除（2026-09-01，模型生效由客户端徽标展示承载）。第一阶段同时交付完整工具和 `@junior|senior|expert` 候选，工具说明含三档成本/速度价值主张（junior 快而廉、senior 性价比、expert 最强推理），工作流内外均可主动选档委派；真实会话验收后，第二阶段将 team-work 首派统一切换到新工具，续派继续使用现有 `agent-map` 和 `send_message`，然后清理标签注入链。方案经 Challenger/Expert 多轮评审（r1 rework 后连续 accept，Expert 裁决 accept）与人工门批准（dec-2ffeb0，2026-08-31），批准后两轮用户裁决增量：更名 `tw-tool-subagent`、新增 §3.7 档位价值主张。详见 `docs/dsh-directed-delegation-plan.md`。第一阶段实施：`dsh/tw-tool-subagent.js`（档位/精确模型、UUID v4 sessionId、§10.3 三风险落点——selection 与 agentOptions 同源派生、provider 钉死 spawn + prepareContinuable 创建前校验、inject.js 直接选择通道 + request/header 回读通道承载 effort 冷恢复）；`dsh/index.js` 装配（工具注册 + systemPrompt 决策表 section，可选服务缺失降级不阻塞）；`dsh/client/badge.js` @ 候选（描述与三档价值主张字面同文）。2026-09-01 实机 Web 装载暴露 `inputTriggers` 未声明属性直读导致 Cordis `without inject`；修复为可选/运行期服务统一走 `ctx.get()`，并一并消除 `systemPrompt` 静默失效及工具执行期 `llm/sessions/sessionPersistence` 的同类风险。`tests/dsh-tw-tool-subagent.test.mjs` 34 条（含严格 Cordis Context 属性守卫）；全量回归 213 pass / 0 fail / 1 skip。§7 真实 DSH 验收七条中 1/2/3/4/5/6 已通过实机验证（2026-09-01，记录见 dsh-delegation-acceptance.md），第 7 项（主动选档行为）待真实使用样本积累。**第二阶段切链清理已实施（2026-09-06，任务 twsub-phase2-switch）**：team-work 首派切换为 `tw-tool-subagent`（target 直接采用 dispatch-plan 的 modelHint，不重选档位）+ `agent-map` 登记续派映射；runtime 写端删除 persistTagHints（tagHints/pendingTags 落盘）与 agent-map 的 modelHints 落盘（任务级 agents.json 收敛为纯 mappings）、删除 dispatch-plan 的 effortNote 硬编码（effort 已可经新工具下发）；插件读端（dsh/inject.js）删除标签反查、childId 轮询补读与 pendingTags 自动回填，仅剩 ⓪直接选择 + ①request/header 回读双通道；skill（dsh-orchestration.md）首派规程同步切换，标签规范降级为纯展示语义并补 @ 候选/自然语言选档指引；旧字段只读兼容窗口经用户增量裁决取消（header 回读天然覆盖旧会话冷恢复，方案 §9 第 6 条）。全量回归 205 pass / 0 fail / 1 skip（skip 为 schemastery 环境预期跳过）。
- **v3.4 波身份与恢复已完成（2026-08-27，方案 `docs/wave-identity-recovery-plan.md` 已批准实施）**：F1 波身份 waveId（`wv1/wv2/…` 全任务递增、dispatched 落盘，波与波永远串行由统一在途守卫维护）；F8 派发 key 改 `d<序号>-<hex>`（消除与 wave 的歧义，旧 w 键只读保留）；F2 轮次唯一算法（每包 max 已交付报告 round，round 由派发事件抄写，删除报告计数口径，reviewedPackages 写入处与判定处同源）；F3 在途守卫统一（所有派发路径同一 waveId 批次守卫，重复/并发推进返回同一在途卡）+ `tw retire` 作废恢复边（只增 `dispatch-superseded`，仅 Lead，幂等矩阵齐备）；F4 续派身份倒序回溯（同角色同包最近有映射的 key，遇 stage-advanced 停止、跳过 superseded）；F5 人工门返工改结构因果（总派 respond + `causeDecisionId` 绑定，删除 deliveredAfter 时间判定，blocked/僵局转 converge-user 仲裁卡）；F6 人工门双指纹（artifactFingerprint 每包映射 + reviewFingerprint 评审链复合，等待期评审变化自动作废旧卡重签）；F7 报告版本 ver（身份 = key+ver，同 key 同 payloadDigest 幂等、变化 ver+1，`report-accepted` 带 ver+payloadDigest，旧报告视为 ver 1）；F9 既有任务迁移（`tw migrate` 追加 `wave-assigned` 映射事件不改写历史行，同轮重复/package=null 各自成波，异 digest 多报告出用户选择卡、其余作废）。回归：新增 `tests/runtime-v3-waves-regression.test.mjs`（1011 行）覆盖方案 §5 验收表第 1–14 行（台账 V3-E2E-01~04 确定性复现 + F1–F9 + 五类鲁棒性），全量 179 pass / 0 fail / 1 skip（skip 为 schemastry 环境预期跳过）；验收表第 15 行（真实 DSH 人工门 rework 复验）由用户实机执行，判据见方案 §6 步骤 7。
- **汇报呈现注入（2026-09-02，用户实测反馈：人工门汇报不说人话、随会话轮数恶化）**：病灶是 Lead 汇报只依赖 skill 一次性装载的汇报要求——会话越长越被卡片 JSON 的编号/术语同化（认知不对等随轮数漂移），且人工门卡本身信息极薄（question + choices），Lead 手里没有现成人话素材。修复为**随卡片输出的稳定注入**（runtime-v3/cli.mjs）：`tw()` 出口统一附加 `presentation` 呈现纪律——awaiting-user 用户决定点（人工门/升档审批/路由/blocked 静止/converge-user，含 dispatch-plan 嵌套 stop 卡）带完整纪律（自足汇报/完整句/禁抛编号术语/选项必须解释后果），dispatch 卡带派发简报纪律，advance/complete/blocked/wait-inflight 带轻量提醒；注入为纯静态文本，E2E-14 终态幂等不受影响。同时用户决定点卡片新增 `progress` 阶段工作摘要（P4：runtime 从 reports/artifacts 自有事实推导各包交付/评审结论/Expert 裁决/产出物路径，Lead 不必翻任务目录）。skill 契约同步（SKILL.md「汇报说人话」硬约束 + scenarios.md 认知对等节）。回归：CLI 呈现注入专项测试（纪律/素材在场、回执不注入、静止期注入稳定、路由卡、dispatch-plan 嵌套卡、completed 轻量版）。
- **可写范围目录授权与 blocked 恢复闭环（2026-09-01，用户实测反馈两项推进缺陷的修复）**：① writable 条目显式尾斜杠 = 目录授权（`docs/:doc` 授权其下全部路径；kind 继承条目 artifactKind），匹配收敛为 `domain/writable.mjs` 纯函数三处共用（intake 交付校验 / plan 包间互斥 / 组合评审清单），互斥判定同步升级为前缀感知（目录与其下路径视为重叠，精确文件条目不误伤同名"目录"）；② produce/respond 波的 blocked 交付此前无消费（blocked 不入投影轮 → 轮次上限永不触发 → 无限重派同形状派单，且新派单丢失 blocked 原因）——现在 nextWave 按"最新 blocked 报告晚于该包最近派发/重拆"判定有效 blocked，无波可派时出 `re-scope` 静止卡（非 decision 卡、幂等；恢复 = 单 owner 带新 `--writable` 重跑 run、多包 `plan` 重拆后 run，重拆窗口对该卡放行），重派派单自动内嵌上一轮 blocked 原因；intake 范围外拒绝文案补双层恢复边（目录写法纠正 + blocked 升级引导）。回归：intake 4 项（含骨架清理）+ topology 3 项（目录授权/前缀边界/精确不扩张、plan 目录互斥、单 owner 与多包 blocked 全链路、respond blocked）。**Expert 裁决返工（r2，2026-09-01）已实施**：① 互斥判定升级为祖先组件语义（docs 与 docs/、docs 与 docs/x 均重叠——同一路径只一个 inode；docs/ 与 docs-x/ 兄弟不重叠）；② `gate.mjs` artifactFingerprints 归属匹配改 `writableMatch`（目录条目下制品进包指纹，人工门双指纹/僵局检测不漏检）；③ 有效 blocked 因果从墙钟 `at` 改 journal seq 全序（同毫秒/时钟回拨不误判，提取 `waves.mjs` 导出 `effectiveBlockedSet`）；④ produceBlocked 静止卡不再遮蔽 F5 人工门 rework 仲裁卡（derive 让位检查），F5 消费规则 2 改用统一有效 blocked 投影（扩权重派/重拆交付后旧绑定波 blocked 不二次触发）；Challenger findings 同轮处置（本条目回归口径修正 + 方案文档 D7/§5 精化与实现内容清单）。返工回归 +5 项（重叠/指纹/seq 因果纯函数、derive 规则 2、F5×produceBlocked 交叉 E2E）+ topology 互斥断言扩展，全量 218 tests / 217 pass / 0 fail / 1 skip。方案文档 `docs/writable-scope-blocked-recovery-plan.md`。

下列 Phase 0–3 仅记录 v1 历史基线，Phase 4 记录迁移前的平台能力；它们用于追溯可复用的不变量，不再代表当前结构或后续实施计划。当前实现与验收状态以 v3 里程碑为准（见上文 v3 里程碑各批次记录）。

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

> **迁移说明（当前实现）**：本节保留最初方案与平台调研，不能把其中的项目 `dsh.json`、`agent-default`、`projectRoots` 或 `twBin` 叙述当作当前行为。现在唯一的 tier→模型配置源是 DSH 全局 settings 的 `team-work-dsh.tiers`，由 DSH Web“插件配置”页管理；`injectionEnabled`、`projectRoots`、`twBin` 已从 schema 和运行链移除且不兼容读取。注入和 `tw` 工具只以子会话 cwd 定位项目的 `agents.json`，该文件仍是运行时映射事实。遗留 YAML 键和项目 `dsh.json` 可由用户手动删除。

### 设计原则（修正稿）

1. **团队拓扑在平台层编排，不在 runtime 重建**：DSH 的 workflow 编排工具（`agent(prompt, opts)` / `pipeline(items, ...stages)` / `parallel(thunks)` / 结构化 `schema` 结果）是拓扑执行引擎。runtime 只提供**波次事实**（`tw dispatch-plan`）与**验收**（deliver/review/gate），不实现派发循环与 DAG 调度——E2E 时"Lead 手动逐个 subagent"是权宜形态，目标形态是编排脚本一次驱动整段房间（从当前波次到下一扇门）。
2. **成本控制的本质是 tier→模型映射**：`agent(prompt, {provider, model})` 的独立 LLM target 覆盖是平台原语。简单任务用廉价模型、复杂任务投入高预算 = 派单时按 tier 指定模型；`costWeights`（1:10:50）是映射的权重标注，服务于成本展示与限额判断——不是记账。
3. `awaiting-user` 语义在编排下的落点：编排脚本推进到人工门即终止返回卡片；不越门、不代答。
4. **嵌套派发（实测 2026-08-21）**：DSH subagent 拥有完整工具面（含 `subagent/subagent_fork/workflow`），成员可自行派发子代理；跨层通信受限——`send_message` 仅达 depth-1 直接子代，更深层只能 `interrupt_agent`。团队树深度纪律：Lead(0) → 成员(1) → 只读子派单(2) 为止（规则 16"不得继续委托"即深度上限）。成员层成本治理当前只能靠派单纪律（成员可越级调用昂贵模型，Phase 3 调查 hook 拦截）。

### Phase 1：编排绑定（目标形态，待实测）

1. **`tw dispatch-plan --task <name>`**（runtime 侧新增）：输出当前可派发波次的机器可读描述 `[{dispatchKey, role, tier, kind, round, prompt, writable[], dependsOn[]}]`——编排脚本的唯一输入；波次推进逻辑（waves.mjs 纯函数）不变，门与人工门语义不变。
2. **tier→模型配置（当前实现）**：DSH 全局 settings 的 `team-work-dsh.tiers` 是唯一来源，DSH Web“插件配置”页负责编辑。`junior`、`senior`、`expert` 必须同时完整；每档兼容单个候选对象或候选数组，provider/model 非空必填，family/effort 可选。运行时按候选池并在同波优先不同 family 挑选，dispatch-plan 写入精确 modelHint 快照；`tw init` 只安装 skill，不生成映射。角色消费档位：Owner 用场景 `ownerTier`，**Challenger 用场景 `challengerTier`（默认 senior）**，Expert 用 expert。**只读子派单（原 v2 助手）= junior 档 + writable 为空 + parallel() 并行**，不设专属角色。
3. **编排脚本模板**（skill references 提供，Lead 经 workflow 工具执行）：读映射 + dispatch-plan → 循环 {并行派发无依赖波次（`agent(prompt, modelByTier[tier])`，成员在 agent 内调 `tw deliver/review --key`）→ `tw run` 消费推进} 直到 gate/awaiting-user 返回卡片。
4. **review 复杂拓扑模板**：八视角 Owner → 并行多 Challenger（`parallel`，按视角分组）→ Expert 裁决 → 门；重派轮在脚本内闭环（rework 波次由 dispatch-plan 顺序导出）。
5. skill 投递：`tw init` 安装到项目 `.dsh/skills/`（DSH filesystem provider 扫描该根）。
- **已知边界（如实记录）**：成员写边界仍是派单纪律 + deliver 校验 + 快照恢复（三层已实现）；编排层按派单沙箱待 Phase 3 调查插件 hook。

### Phase 2：成本投影与限额（建立在映射之上）

- `tw status --task <name>`：journal 的 dispatched 波次 × 映射权重 **纯推导**累计相对成本与"下一波预估"（P1：投影非账本，无新状态文件）；
- 编排脚本在下一波预估将越过 `automaticLimits` 时先出用户卡片（软预算门），不静默升级；
- `concurrencySoftLimit` 作为编排脚本 `parallel` 的并发上限参数。

### Phase 3：DSH 根制品绑定——**已实施**

- **唯一市场制品**：根 `package.json` 同时发布 Runtime、CLI、skill、`dsh/` host/client 与 bundle patch。早期 tgz 子包、重复 skill、子包 build/manifest/README、手工安装脚本和专属装载脚本已删除，仅由 Git 历史保留；
- **DSH 能力**：host 插件提供模型/effort 注入（二阶段切链后：⓪直接选择 + ①header 回读双通道，见 v3.3 条目）、skill 注册、tw 原生工具与全局 settings；client 提供真实模型/effort 徽标和插件配置卡。`tw` 工具直接执行同一根制品内的 `bin/tw.mjs`，不依赖 PATH 或第二包身份；
- **注入寻址（v2 评审后定稿）**：childId 主键（childCtx.agent.id 直查 modelHints——时序证伪了 seed 文本解析）+ agent-map 自动落盘（P4：零手动转录）；隔离性源码证实（每子代独立 session/agent/ctx）；
- **验收状态（功能矩阵 F-1..F-12）**：F-1..F-4/F-6/F-8..F-11 已由自动层验证（Cordis 装载层 + Runtime 功能矩阵 + 根制品宿主 boot 链 + 隔离 Web 实例）；**F-5/F-7/F-12（真实 LLM 注入、effort header、徽标最终位置与样式）仍待用户以带凭据的真实会话确认**（根 README 的 DSH 节）。
- **客户端启动回归修复（2026-08-25）**：实机刷新暴露 client 工厂误用 Node `(module, exports)` 形态，导致 `factory(require)` 返回 `undefined`；修正为直接返回 Cordis 插件导出，并移除把内建 `logger` 误声明为注入服务的第二层 pending blocker。新增工厂协议回归测试，隔离 web profile 已验证完整进入主界面且控制台零错误；
- **插件配置卡视觉回归修复（2026-08-25）**：实机确认 `settings.plugin.item` 只负责排列，带 client 的插件必须自己绘制卡片外壳；原实现直接渲染常开表单并使用原生 HTML/内联样式，未继承宿主视觉。现改为与 DSH 内建插件一致的默认折叠卡（折叠态为插件名与一行简述），展开后按宿主字号、间距、圆角与 `--dsw-alias-*` 主题 token 渲染字段和操作；回归测试覆盖折叠/展开、无内联样式、主题与字体继承，重新安装后的最终视觉仍待用户实机确认；
- **子代理模型徽标修复（2026-08-25）**：实机暴露席位不显示真实模型/effort。根因四项：RPC 漏解 `result.value`；动态插件抢占 `single` 模型席位且父会话 inject 返回 null 会使条目退席；只拉取一次导致运行中选择变化不刷新；addressed 子代理在部分宿主不开放 models RPC。修复为追加到相邻 `conversation.input.right`、inject 恒返对象、声明 connection 生命周期、运行状态切换刷新，并优先显示会话最新真实 requestConfig（RPC 仅兜底）；6 项 I4 行为测试覆盖工厂/释放、显示、父会话隔离、刷新与 RPC 真拒绝降级。UI 位置与样式仍待用户安装后实机过目；
- 剩余：npm 正式发布（本地 pack 已验证）；写边界平台 hook 不做（用户裁决：skill 规范承载，派单边界声明已落地）；
- **台账（2026-08-25 复盘，记录待批不实施）**：① runtime 引导缺口——writable 形状校验应前移到 run 派发时（目录粒度警告、kind 不在阶段合同当场拒绝），DISPATCH_INPUT_REQUIRED 提示补文件级语义；② 归档 manifest 应保留 deliver 的 paths/digest 明细（当前 completed 归档精简后 P1 重算不完全成立）；③ Lead 纪律拟固化进 skill：派单禁伪代码级注入、"已验证"断言逐条真验、归档重开后新成员核验自交；④ skill 装载故障：宿主 skill 工具对仓库内 team-work-v3 报 "loaded skill source must be a string"（平台侧或 skill 资源形态问题，待查）；⑤ 后台 continuable 子代死亡根因见下条（已修）。
- **DSH 用户卡片超时输入丢失（2026-08-31，宿主缺陷已确认/未修复）**：实机错误为 `Error: code run failed (timeout): wall-clock ceiling reached (600000ms)`。Lead 在 DSH 外层代码执行工具中 `await tools.ask_user_question(...)` 呈现人工门；用户等待计入 code run 的 10 分钟墙钟上限，超时后外层调用及其 continuation 被销毁，而界面卡片仍可能接受输入，导致晚到回答静默丢失。该上限不来自 Runtime；Runtime 本地复验表明 `awaiting-user` 持久静止且重复 `run` 返回同一 `decisionId`。DSH 根治：交互等待必须从 code run 墙钟计时中挂起并持久化 continuation，或让 `ask_user_question` 脱离 code run、以稳定 questionId 独立收件；提交须先持久化并确认，等待者已结束时自动转成新一轮用户消息，重复提交幂等，失效问题显式拒绝并保留原文。必须覆盖超过 600000ms 后提交、进程重启后提交、确认丢失后重试、问题失效四类宿主回归；仅延长 ceiling 不视为修复。team-work 立即绕行：skill 明确禁止在 stop=`awaiting-user` 时调用阻塞式问答工具，Lead 将 question/choices 写入普通最终消息并结束本轮，下一条普通用户消息到达后再执行 `tw decide`。本仓库无 DSH 内建问答工具的可执行 seam，只能增加 skill 文本守卫并以真实 DSH 验收。
- **注入致命 bug 修复（2026-08-25，实机铁证）**：inject.js selection 占位值 `{provider:null, model:null}` 违背宿主语义——installModelSelection 里 `selected === undefined` 才是不干预（继承默认），null 对象会把 variables.provider/model 覆写为 null → 子代 no provider/model 直接 turn error（两个后台子代无遗言死亡的根因；前台子代未登记 modelHints 未触发注入所以存活）。修复：占位改 undefined，hint 就绪才赋值完整对象；守护测试同步改判 undefined 语义。注意：此前"F-5 注入侧证"结论作废——当时 3 个前台子代正常恰因未注入。
- **tw 工具 render 契约崩溃修复（2026-08-25，实机两崩铁证）**：render 返回纯字符串违背宿主契约——commit 管线 result.content.some（dsh-tools:1294）对字符串抛 TypeError → unhandled → 宿主进程整体退出（调 tw/skill 工具即触发）。修正为 content 块数组 [{type:"text",text}]（官方 dsh-tool-bash:384 同形态实证）；补 render 契约守护测试。契约病根第五例：早先"平台事实"只验 schema/render 被调用，未验 render 返回形态。
- **effort=thinking 与首轮边界的组合缺陷（2026-08-25 实机实证）**：注入首轮必用默认模型（childId 不可预知边界），若默认模型为非 thinking 而 hint 带 reasoningEffort，其首轮 assistant 消息无 reasoning_content 写入会话历史 → 后续 thinking 请求被 DeepSeek 平台 400（reasoning_content must be passed back，INVALID_REQUEST）。实测证据：请求1 v4-pro 无 reasoning 块 → 请求2-4 flash/max 中 turn 尾部 400。宿主序列化器对无 reasoning 轮不发空字段（按规则回传）。处置选项：A 插件降级 effort（牺牲功能）；B 文档标注组合风险（最小）；C 平台侧序列化器实验空字段回传（根治在平台）。待用户裁决。
- **agent-map 自动回填实施（2026-08-26，方案 docs/tag-agent-auto-register-plan.md v2）**：交叉评审 F1-F8 全处置——pendingTags[标签]=key（runtime 派发落盘）+ 插件标签命中后 fire-and-forget 回填 mappings[key]=childId（任务作用域键，有界重试 3 次，幂等）；锁面统一（agent-map 改 agents.lock 与 persistTagHints/插件互斥）；续派卡 expectedAgentId 缺失显式提示；skill 规程统一标签格式并条件化保留 agent-map 兜底。136/136 绿。真机验证待用户重启后执行。
- **agents.json 任务级迁移实施（2026-08-26，方案 docs/agents-json-task-scope-plan.md，用户裁决硬切）——真机闭环**：实机四验全过——①任务级落盘（tasks/<任务>/agents.json 13:36 写入，项目级旧文件时间戳停 10:33 零再写）；②带 #任务名 标签子代首请求即注入（official/flash/max）；③零 agent-map 插件自动回填 mappings（key→childId）；④同标签两任务 mappings 各归各（残余窗口消灭实锤）。真机为 cp 同步版（市场 0.2.1-beta.3 落后于 HEAD，市场重发后覆盖）。
- **agents.json 任务级迁移实施（2026-08-26，方案 docs/agents-json-task-scope-plan.md，用户裁决硬切）**：注册表迁 .team-work/tasks/<任务>/agents.json（与 journal 同层，随任务归档）；标签形态 `阶段·角色[@包] · 简述 #任务名`（任务段殿后，# 定界三重防线：形态约束+目录存在性事实校验+简述不含 # 规范）；pendingTags 跨任务覆盖窗口根除（键空间任务作用域+同任务串行）；锁面简化为 task.lock；持久化原语不再项目级共享。139 pass/0 fail/1 skip（schemastery 环境预期跳过）。真机验证待已装包同步+重启。
- **注入寻址回归实施（2026-08-25，方案 v2 批准后）——真机闭环**：标签寻址主通道实机三验全过——①带规范标签子代（CR·owner · 简述）**首请求 header 即注入** deepseek-official/flash/max（旧行为首轮默认，二轮才注入）；②tagHints 落盘确认（RES·owner/CR·owner 键俱在）；③无标签回退三态正确（首轮默认→补读二轮注入）。cross-resume 幂等/续派 hint 更新/并发合并由单测覆盖（128/128）。剩余真机项（resume/续派/并发）风险低可后置。
- **注入寻址回归实施（2026-08-25，方案 docs/dsh-tag-injection-plan.md v2 批准后）**：标签寻址主通道——dispatched 落盘自动写 agents.json.tagHints（键=阶段缩写·角色[@包]，P4 零转录，项目级 owner 锁，实测 RES·owner 命中）；插件 contribution 同步段读 seed descriptor.label 首轮同步注入（三态回退全序：标签命中→锁死互斥 F-7 / 标签在 hint 缺→降级 childId 补读 / 无标签→现状）；首轮边界消灭，effort=thinking 历史污染 400 随之消除。6 项标签测试 + 126/126 全绿。实施修正一处：方案 v2 承诺的归档清理因标签键无任务身份不可精确实现，改语义为最近快照覆盖（§2.2 已同步修正）。E2E（真实子代首请求 header 注入）待真机。
- **注入修复补全（2026-08-25 二轮复核，94aa091 定性为部分修复）**：独立复核发现三处残留——① contribution 必须是同步函数（宿主 SetupRegistry.apply 把返回值直接存为 disposer、不 await；async contribution 同步段在首个 await 让出，install 晚于首请求）；② childId 首轮不可预知（agent-map 在 spawn 后调用，而 startContinuable 返回 ID 前首 prompt 已被接受）——首轮必为默认模型，靠自循环补读（500ms 间隔/120s 上限，命中即停）在 Lead 写入 hint 后的下轮请求生效；③ 测试曾用 await contribution() 掩盖同步契约——已改为不 await 直接断言同步效果 + 迟到写入用例。安装器解析改双通道（contribution 同步段 createRequire 直取——Node 22+ require(esm) 实测可行；apply 时异步预解析填缓存兜底旧 Node）。skill 注册名改 team-work，skill 注册补 source 字段。
- **注入残留闭环（2026-08-25 三轮代码审查修复）**：补齐 SetupRegistry disposer 契约（禁用、安装器缺失、异常均返回可安全释放函数）；cold-resume 对已存在 hint 同步首读，fresh 子代保留“首轮默认、补读命中后下一请求注入”的平台边界；插件改为 Cordis async apply 激活门槛，安装器解析完成后才注册 setup，消除 Node 18/20 首子代竞态；单次安装器解析设 5 秒上限，失败或超时后每 5 秒后台重试，恢复后新子代可注入，并在根制品显式声明直接使用的 dsh-agent peer；损坏 agents.json、权限错误、补读超时与安装器失败均记录分类原因及可执行恢复指引；skill E2E 改为严格断言 team-work。自动回归已覆盖上述契约，真实 LLM F-5/F-7/F-12 仍待实机确认。
- `e2eTemplate` 物化已实施（run 路由 → e2e 阶段 → 三包依赖链，E2E-B F-11 验证）。

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
