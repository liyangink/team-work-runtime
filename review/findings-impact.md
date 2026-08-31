# 影响范围视角审查 findings（wave-identity-recovery-plan）

审查对象：docs/wave-identity-recovery-plan.md（波身份与恢复方案，待批准实施基线）
视角：**影响范围**（调用方、配置、迁移、性能、部署、回滚、下游）
证据事实：runtime-v3/{waves,derive,gate,intake,store,cli,dsh-map}.mjs 全部读取核对；docs/v2-e2e-findings.md V3-E2E-01~04；docs/team-work-runtime-model.md；docs/dsh-directed-delegation-plan.md；tests/ 全套 18 文件与 fixtures。

## 结论

方案对四个台账问题的根因定位与实现现状**一致**（V3-E2E-01↔derive.mjs:30-45 覆盖波绕过守卫、V3-E2E-02↔cli.mjs:851-868 紧邻 key 回溯、V3-E2E-03↔waves.mjs:52 计数口径 vs intake.mjs:213-220 max 口径、V3-E2E-04↔derive.mjs:27-28 墙钟时间判定，均已核实）。修复方向正确、集中在纯函数推导层、持久化基本只增字段，§7 的可靠性/性能/配置面评估成立。

但方案**尚不可直接批准实施**：3 条 blocker 均为「修复项之间或修复项与现状机制组合出的死循环或机制不可达」（无恢复边，违反 AGENTS 规则 4/I5），9 条 risk 为规格缺口与文档/迁移影响未声明。三者不改方案目标与结构，只需补完成路径与定义后即可批准。

## Findings（Blocker）

**B1｜F5 指纹判定缺少「制品不变仍算返工已执行」的完成路径 → 人工门 rework 死循环**
- 位置：方案 §3-F5（59-60 行）；现状 derive.mjs:27-28、30-45；cli.mjs:435-441；intake.mjs:107-108、120-122。
- 归因：方案把 deliveredAfter 从时间戳改为「当前制品指纹 ≠ 决定的 artifactFingerprint」，但未采纳台账 V3-E2E-04 建议的 causeDecisionId/waveRef 绑定，也未定义指纹未变时的合法完成路径。
- 触发条件：人工门 rework 后 respond 交付不改变任何登记制品——(a) writable 为空的纯回应派单（cli.mjs:441 `--writable none` 现成存在）；(b) outcome=blocked 交付（intake.mjs:108 放行、120-122 不要求 paths，报告照常注册）。
- 影响：覆盖波永远判「返工未执行」→ 持续重派 respond，任务卡死在门，无恢复边。
- 证据：方案 60 行明写「制品指纹不变 → 判定未交付 → 继续派 respond」；上述两条代码路径均不改变制品指纹。判据精确性：现状时间判据（derive.mjs:28 `r.at > humanRework.at`）下 blocked 回应因报告 at 刷新而过关，F5 改指纹判据后该出路消失；死循环发生在覆盖波分支（derive.mjs:30-45 在 gateCheck 之前 return），用户到不了 decide 卡、无法以 accept 兜底。
- 最小修复：rework 覆盖波的 dispatched 事件与报告写入 causeDecisionId（runtime 抄写，P4）；deliveredAfter = 存在绑定该决定的 respond 报告；blocked 交付导向 escalate/converge-user 而非循环重派。

**B2｜F6 双向机制断点：「等待期修订必然重呈卡」不可达 + 重出卡后再批准恒命中旧决定死循环**
- 位置：方案 §3-F6（65-68 行）；gate.mjs:103-113（未决分支不比对指纹）、114-120（批准后过期分支）；cli.mjs:542-556（未决卡原样返回不重算）；gate.mjs:105（decided 取首个 accept）；cmdDecide 590-592。
- 归因：断点 A——人工门等待期（decision-issued 已签发未 settled）derive 走 gateCheck 时 decided 不存在，走 `if (!decided)` 分支只返回「等待用户决定」、不比对制品/评审链指纹；cli 的 await-decision 分支对 pending 卡原样返回 issued.detail.reason/choices，不重算。故方案 68 行承诺的「等待期修订 → 必然重新呈卡」按字面实施不可达（修订静默不重呈）。断点 B——decisions 是 append 数组，gate 取第一个 accept；重出卡后再批准只是追加新决定，旧决定（旧指纹）仍被 find 命中。
- 触发条件：A 人工门等待期成员修订裁决/评审（V3-E2E-04 现场同款场景）；B 批准后制品或评审链变化 → 指纹过期 blocker → 重出卡 → 用户再次 accept。
- 影响：A 等待期修订不触发重呈卡，F6 修复目标落空；B find 恒命中旧决定 → 指纹恒不等 → 每次 run 重出卡，批准永远无效，死门（无恢复边，违反 AGENTS 规则 4/I5）。
- 证据：gate.mjs:107-113 未决分支无任何指纹比较；cli.mjs:554-555 对 pending 返回 issued.detail 原文本；gate.mjs:105 为 `decisions.find(...)` 非取最新。与本 finding 一致的跨包共识：standards B1、logic L-03、types T2、defects B1（error-handling B2 互补）；requirements 包 2.2 表/F-9 据此改判「部分覆盖（机制不可达待修）」，且 requirements 二轮已新增 F-10 将 F6 扩展实施（未决分支比对 + issued 绑指纹 + find 改最新决定）列为修复项——Expert 终裁确认本 blocker 已被方案吸收，属实施条件而非设计错误（实施不得降级，见 Expert 建议条件 1）。
- 最小修复：A 未决分支同步比对 artifactFingerprint/reviewFingerprint，变化时重签卡文本（或 derive 层对未决卡重算后再呈现）；B decided 查询改为按落盘顺序取**最新** gateId 匹配的 accept 决定并比较其指纹；与 F5 改名一并定义旧决定回退兼容（无 artifactFingerprint 用 fingerprint 字段）。

**B3｜F2 消费点清单遗漏 derive.mjs:35 人工门 rework 覆盖波的轮次计算（第五个计数口径实例）**
- 位置：方案 §3-F2（42 行「消费点全部换源」清单）；derive.mjs:33-37。
- 归因：方案只列 waves 内 respond/review/耗尽/依赖 + intake 快照四处，漏掉 derive 覆盖波的 `stageReports.filter(...).length + 1` 独立计数。
- 触发条件：人工门 rework 覆盖波派发（方案 §6.5 现场任务正处该路径；用户上次就在人工门 rework，再次 rework 概率高）；同轮重复交付的旧数据在场（F9 迁移后 3 条同轮报告计数=3 份而投影轮=3，round=计数+1 得 4~6 与投影分叉）。
- 影响：轮次口径分叉在 rework 路径复发（V3-E2E-03 同源机制），F2 目标「轮次口径唯一」未达成。
- 证据：derive.mjs:35 与 waves.mjs:52 是两个独立的报告计数实现；方案 42 行清单不含 derive。
- 最小修复：覆盖波 round 改用与 waves 共用的导出投影函数（单一实现）；§5 验收补「人工门 rework 后覆盖波 round = 投影轮」用例。

## Findings（Risk）

**R1｜F9 迁移落盘形态与「全部只增不删」矛盾未定义（改写 vs 追加）**
- 位置：方案 98 行（只增不删）、83 行（补写、按序赋 wv1…wvN）、22 行（waveId 只做派发事件上的字段）、§4 新事件类型清单（仅 dispatch-superseded）。
- 归因/证据：给既有 dispatched 事件补 waveId 字段 = 改写既有 journal 行，与 P1 事实流不可变、§4「只增不删」冲突；若追加新事件类型（如 wave-assigned），§4 清单未含且投影数据源需重定义。两路均未声明。
- 影响：改写式破坏幂等重放与回滚安全；追加式改动 waves/derive 投影源。迁移失败回滚路径（journal 备份）也未声明。实施者歧路。
- 最小修复：§4 明确二选一——原地补写 + 迁移命令锁内幂等 + journal 先备份；或追加 `wave-assigned {waveId, dispatchKeys[], at}` 只增事件并声明投影从该事件取 waveId。

**R2｜F2 投影的 waveId 数据源与旧报告兼容回退未定义**
- 位置：方案 24 行（投影定义）、41 行（报告补 waveId）、§4 表格（仅声明新报告 +waveId，未声明旧报告回填）。
- 归因/证据：waves.mjs 是纯函数只收 reports；旧报告（迁移前）无 waveId 字段，§6.5 现场迁移后继续推进时新旧报告混跑。F2 修复 V3-E2E-03 分叉的核心是 waves 换 max(report.round) 口径（与 intake.mjs:213-220 同源），waveId 去重是防御——若实现对缺失 waveId 报错或逐条独立计数，旧数据行为不可预测。
- 影响：迁移前后投影口径不一致，旧数据行为不可预测（Expert 现场证据裁决补充：已接受的 w22 评审快照即 plan@3，迁移后投影轮=3、覆盖判定成立，现场任务无复发判假风险；本 finding 保留为「按 waveId 去重」对缺失 waveId 旧报告须定义回退的规格缺口，非现场阻塞）。
- 最小修复：定义无 waveId 报告按 dispatchKey 视为独立条目（与 max 口径等价）；§5 补「迁移前后混跑投影一致」验收；或迁移时回填报告 waveId（需同步解决 R1 的不可变问题）。

**R3｜retire 作废波后的投影/快照/耗尽口径未定义**
- 位置：方案 49 行（retire 只允许作废当前未结波；批次守卫过滤被作废波）。
- 归因/证据：被 superseded 波可能已有部分包交付（多包部分交付）。该波报告是否计入 max(report.round) 投影、intake 快照、依赖满足判定与耗尽判定，方案未声明；计入=作废仅去重派单但轮次预算仍消耗，不计入=轮次回滚——两口径均自洽但必须定一且四处消费点同口径。
- 影响：retire 后重派的 round、评审覆盖判定、轮次上限判定在不同实现下结果不同；「轮次上限按真实轮消耗」（§5.3）无法验收。
- 最小修复：声明 superseded 波在投影/快照/依赖/耗尽四处一律排除（作废=撤销语义），补「retire 部分交付波后重派」测试。

**R4｜人工门阶段无登记制品时决定指纹与门检指纹公式分歧（现状缺陷，F5/F6 触碰必一并修）**
- 位置：gate.mjs:106；cmdDecide 576-577、584。
- 归因/证据：cmdDecide 决定指纹 = digest(当前阶段制品集)，空阶段=空集；gate.mjs:106 在 current 为空时回退用**全任务** artifacts.items——两端公式在「人工门所在阶段无登记产出物」时永不等。
- 影响：指纹恒「过期」→ blocker → 重出卡 → 再批准仍过期，死循环；F6 复用重出卡机制后该路径成为新死门。
- 最小修复：两端统一为「当前阶段登记制品集（可空）」，空集即空集 digest；补该形态的 gate/decide 一致性测试。

**R5｜方案与模型基线/台账/清单的下游同步未声明**
- 位置：方案 §1（范围）、§8（后置项）；model.md:60、64；台账 50-53 状态「已定位、待修复」；AGENTS 变更要求（file-inventory.json 同步）。
- 归因/证据：model.md「波与波之间永远是串行的」与 F1「同轮超并发上限拆两批 = 同 round 两个 waveId」直接冲突（两波在途并存）；方案未声明 model.md 修订、台账 V3-E2E-01~04 状态更新（已修复+回归证据）、retire 新命令/dispatch-superseded 新事件/迁移工具在 docs/file-inventory.json 与 SKILL/dsh-orchestration（retire 操作规程）、README 的同步项。
- 影响：批准基线文档与模型基线矛盾，实施者以谁为准不明确；台账与清单失真影响后续复盘。
- 最小修复：方案 §2 波行标注拆批为并发上限例外并声明 model.md 同步修订；新增「下游文档与清单同步」清单并入 §6 实施顺序。

**R6｜F7「报告身份 = key+ver」与 F8 文件命名的落盘形态未定义；payloadDigest 公式未定义**
- 位置：方案 72-74 行（F7）、78-79 行（F8）；intake.mjs:130-133、145、202-205、221。
- 归因/证据：现状单文件覆盖、reportId=deliver/review-<key>。ver>1 时是覆盖（reportId 不变 → 与「身份=key+ver」冲突、旧内容仅留 digest）还是多文件（journal report-accepted.detail.reportId、artifacts.reportRef、幂等 hint、归档 manifest、F6 评审链指纹的全部引用点需盘点）；payloadDigest 的规范化（字段集、排序）与 F6 的「payload digest」是否同一公式未声明。
- 影响：两处 digest 公式不一致时评审链指纹与版本链对不上；实施者需自行拍板命名/落盘，返工风险高。
- 最小修复：明确「单文件覆盖 + journal 版本链记 digest」（与 §8 全文留档后置一致），payloadDigest = digestValue(规范化 payload 序列化)，与 F6 同公式同规范，写入 §4。

**R7｜F1 幂等判定「属性相同」的比较字段集未定义（含 modelHint 则幂等失效）**
- 位置：方案 35 行（属性相同 → 返回原在途卡）；dispatchedDetail（cli.mjs:392-404）含 modelHint；selectModelHint 每次派发重算（cli.mjs:319-325、838-843，usedFamilies 闭包每波重置）。
- 归因/证据：detail 字段含 key/at/modelHint 等每次派发必然变化的项；若「属性」含 modelHint 或 at，重复推进永不判同波 → V3-E2E-01 复发（台账 44 行明确重复推进是合法用法）。
- 影响：幂等守卫失效风险高，且两批拆波（同 round 两个 waveId）与单批的属性比较行为不同。
- 最小修复：§3-F1 明确属性 = (kind, role, round, 包集, writable 集) 的规范化比较，显式排除 key/at/modelHint/continuation 无关项；补「同波重复推进 modelHint 重算仍判同波」测试。

**R8｜F9 迁移规则未处理「同轮同包不同 digest 多报告」的用户选择分支（台账建议未采纳）**
- 位置：方案 83 行（迁移规则）；台账 V3-E2E-03 建议处置（52 行：「多报告且 digest 不同才出用户选择卡」）。
- 归因/证据：迁移规则「package 相同各自成波」对同轮同包、不同 key、不同内容的交付机械收敛为同轮——waves.mjs:71-88 覆盖判定只比轮次（快照轮 ≥ 投影轮即覆盖），Challenger 组合评审可能只覆盖其中一份内容。
- 影响：未经评审的内容混入收敛基线；「评审覆盖」名实不符。
- 最小修复：迁移工具对同轮同包多报告按 payload digest 分组——同 digest 机械收敛、不同 digest 出用户选择卡（决定保留哪份/全部重评），与台账建议一致。

**R9｜F9「归档任务重开时再迁移」引用不存在的重开路径**
- 位置：方案 85 行。
- 归因/证据：CLI 无 unarchive 命令；归档目录被 chmod 0444/0555 强制只读（cli.mjs:1024-1035），help 卡（960 行）明示归档只读、后续工作新开任务。
- 影响：该句对实施者无操作含义；若误以为存在重开机制会引入范围外功能。
- 最小修复：改为「归档任务保持只读不动；需要继续时另开新任务引用归档结论」（与 cmdIntent 的 TASK_COMPLETED 语义一致）。

## Findings（Info）

**I1｜既有测试更新范围远大于方案声明（§5.8 只点 topology 一处）**
- 证据：grep 得 16 个测试文件 + tests/support/v3-fixtures.mjs 共 119 处 key/dispatchKey/round 相关引用——含 fixtures 手工构造的 `key: "w2-aaa"`、mappings `{ w1: "child-real" }`、tag-agent-auto-register 17 处、runtime-v3-topology 20 处、runtime-v3-intake 21 处。F8 前缀、F1 waveId 字段、F7 ver 字段会批量改变 fixtures 种子形状与断言。
- 最小修复：实施前先做一次测试形状盘点并入 §5；§6.4「回归全量」依赖该盘点，否则实施第 4 步必然返工。

**I2｜F6 评审链指纹「最新 Challenger/Expert 报告」未声明 stage 过滤**
- 证据：store.mjs:102 按 at 全任务排序；store 载入 reports 为全任务集合。人工门等待期若跨阶段取到上一阶段报告（当前阶段尚无评审），修订上一阶段报告会误触发本阶段重出卡。
- 最小修复：指纹选取加当前阶段过滤（与 gate.mjs:24 stageArtifacts 同口径）。

**I3｜F8「全任务递增序号」与现状生成器（journal.length+1）不符**
- 证据：cli.mjs:432、442、483 同批多 key 共用同一 journal.length 序号（随机 hex 保唯一）；F9 迁移追加 journal 事件后序号空间跳变。d 前缀对 dsh/ 插件无影响（已 grep 证实 0 处前缀硬编码）。
- 最小修复：要么接受批内同序号（唯一性由 hex 保证，调整方案措辞），要么换独立递增计数器；两者都需在 §3-F8 写明。

**I4｜derive.mjs:27 humanRework 未按阶段过滤（现状隐患，F5 触碰该行）**
- 证据：`decisions.filter((d) => d.choice === "rework" && d.gateId).at(-1)` 全任务取最新 rework；跨阶段后遗留 rework 决定仍参与 gate 分支判定。触发窄（无活跃包阶段的 gate），但 F5 改 deliveredAfter 时应一并加 stage 过滤，避免新语义带入旧隐患。

**I5｜F3 重排后的调用方清理项未列**
- 证据：runTransition:417-422 的 `next.kind==="dispatch" && !state.next.wave` blocker 分支在「所有派发路径统一经过守卫」后成为死代码；cli.mjs:483-489 非 owner 派发分支并入统一守卫的改动未声明。currentStageOf 两处重复（intake.mjs:230-232 vs derive.mjs:16 内联）方案已声明合一，与代码事实一致。
- 最小修复：§6 实施清单补「清理死代码分支 + 非 owner 派发并入统一守卫」。

## 影响面清单（供汇总去重归因）

- **调用方**：nextWave 签名可能扩展（投影需 journal/wave 事实，§4 未声明）；deriveTask/gateCheck 行为变化影响 cli 全部命令与 16 个测试文件；新增 retire 命令。
- **配置**：无新配置项；tier→模型映射、risk 升档、升档审批均不受影响。
- **迁移**：F9 一次性迁移工具（形态未定义，R1/R8/R9）；当前活动任务迁移需真实 journal 快照先行验证（§6.5 的 w24 在途波与三条同轮 respond 的合并结果应以现场数据核对，我按派单纪律未读 .team-work 内部状态）。
- **性能**：F4 倒序回溯 O(journal)、F2 投影 O(reports)、F6 指纹 O(制品数) 均线性；任务级规模无实质风险，§7 成立。
- **部署**：分批实施（§6.1/6.2 在迁移前完成）过渡态闭环；现场任务在迁移前不产生新派发即可无缝切换——但方案未声明「实施期间现场任务冻结」这一前置条件，建议明写。
- **回滚**：F5 决定改名 artifactFingerprint 后，旧版 runtime 读 fingerprint 得 undefined → 人工门恒过期——「旧决定兼容」只覆盖旧→新，未覆盖新→旧。需双写 fingerprint 或声明不支持回滚并给数据修复指引（并入 B2 修复建议落实）。
- **下游**：dsh 编排层（dispatch-plan 输出是否新增 waveId 字段未声明；retire 的编排操作规程需进 SKILL/dsh-orchestration）、dsh 插件（无 key 前缀硬编码，无影响，已核实）、docs 与清单（R5）。

## 自查

- 对照派单目标：已独立完成影响范围视角审查，findings 全部基于已读取的方案文档与源码行号事实，未臆造；不能验证的现场任务数据明确标注（影响面清单·迁移）。
- 对照视角定义（场景指导·影响范围=调用方/配置/迁移/性能/部署/回滚/下游）：七维均覆盖且逐维有结论。
- 对照 finding 质量要求：每条 finding 有位置、归因、严重级别、触发条件、影响、证据与最小修复；无证据的猜测未记为 finding。
- 审查结论：方案方向正确、根因定位与实现一致，但存在 3 blocker（死循环/机制不可达类）+ 9 risk + 5 info，须先收敛（最小修复均已给出）再批准为实施基线。

## 轮次 2 修订记录（回应 Challenger rework 意见）

- B2 扩充为「F6 双向机制断点」：吸收 Challenger 共识补充的代码证据（gate.mjs:103-113 未决分支不比对指纹、cli.mjs:542-556 未决卡原样返回不重算），与五包 blocker 共识对齐，并标注 requirements 包 2.2 表/F-9 应改判「部分覆盖（机制不可达待修）」、批准条件并入本 F6 机制类 blocker。
- B1 补「判据精确性」：明确现状时间判据（derive.mjs:28）下 blocked 回应可过关、F5 指纹判据后该出路消失，死循环位于覆盖波分支（用户到不了 decide 卡），堵住「blocked 判据归属」的解读分歧。
- 不落本包的 Challenger 意见按归属处理、不越界修订：门槛 7 三档定级分歧（requirements/test-coverage/standards 三包 + summary 终裁）、L84 时序解读（summary 采纳精确表述）、standards 包三处 info——本包 R2 与上述内容无冲突。

## 轮次 3 修订记录（回应 Challenger/Expert 组合结论）

- 本包 findings 主体维持不变：Challenger 三条 findings（summary 丢信息/B1 计数/勘误记录）全部归属 summary 包，不涉及 impact；Expert 条件 3 对 impact B2 的「requirements F-10 已满足」标注由 summary 终裁回写，不在本包文件内改动。
- 两处按 Expert 终裁做最小事实对齐：R2 影响行补现场证据（w22 快照即 plan@3、覆盖成立，R2 保留为迁移兼容规格缺口，非现场阻塞）；B2 同步 requirements 二轮 F-10 吸收状态与「实施条件而非设计错误」定性。
