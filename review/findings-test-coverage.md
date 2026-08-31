# 波身份与恢复方案 · 测试覆盖视角交叉评审（八视角之 coverage，包 coverage）

> 本文件是 wave-plan-review 交叉评审中 coverage 包的产出物（code-review）。审查对象：docs/wave-identity-recovery-plan.md（138 行）。证据基线：docs/v2-e2e-findings.md V3-E2E 段、docs/team-work-runtime-model.md、runtime-v3/{waves,derive,gate,intake,cli}.mjs、tests/ 17 个 .test.mjs 测试文件 + 1 个 support fixture（tests/support/v3-fixtures.mjs）、docs/runtime-v3-charter.md（I1–I10）。方法：台账修复验收门槛（findings.md:114-122）与 4 个确定性复现（findings.md:59-62）逐条对照方案第 5 节验收矩阵，再落到现有测试面核对覆盖现状。结论已去重归因；未确认处显式标 unresolved。

## 1. 已核验的事实（方案与台账断言对照现有测试现场）

| 台账点名的覆盖缺口 | 现场核验结果 | 证据 |
| --- | --- | --- |
| invariants 只断言人工门 rework 首次派 respond，无第二次推进验证在途幂等 | 确认：测试在首次 respond 后即结束，未再 run；同一测试也未走 dispatch-plan | runtime-v3-invariants.test.mjs:150-162 |
| dsh 只验证普通首派的重复 dispatch-plan 会等待，未覆盖人工门特殊分支 | 确认：断言对象是普通 produce 波的在途幂等 | runtime-v3-dsh.test.mjs:301-302 |
| topology 测试名声称覆盖 expectedAgentId，正文无第二次续派、无任何 expectedAgentId 断言 | 确认：该测试经 run 通道取卡，而 expectedAgentId 只由 dispatch-plan 的 waves[] 导出（cli.mjs:856-877），run 卡不携带该字段，测试必然无法断言 | runtime-v3-topology.test.mjs:319-344；cli.mjs:483-489 |
| tag 测试固化 pendingTags 覆盖最新 key，未验证 send_message 不触发回填 | 确认：仅断言覆盖语义 | tag-agent-auto-register.test.mjs:22-32 |

方案 §5.8「修正既有测试名与正文不符处（如 topology 的 expectedAgentId 断言缺失）」与台账结论一致，属已识别的修复项——这部分方案是诚实的。

基线事实：tests/ 目录对方案全部新概念（waveId / retire / superseded / artifactFingerprint / reviewFingerprint / ver）零匹配；测试入口为 npm test = node --test tests/*.test.mjs（package.json:27-29）；charter 要求「I1–I10 各有测试」「已修复项必须同时有自动化回归」（charter 210/225 行、findings.md:145）。

## 2. 发现（按严重度排序，已去重归因）

### Blocker

**F-C01 旧形状回退语义未定义，测试基线无法确定（归因 F1/F2/F3）**
方案只描述新形态：dispatched 带 waveId、报告带 waveId、守卫按「同 waveId 未结波属性相同」判定。但未迁移任务、归档边界以及全部现有测试夹具（seedDispatch 写入的 detail 无 waveId，v3-fixtures.mjs:34-41；core/topology 夹具报告也无 waveId）在批次守卫与轮次投影下的行为没有声明：无 waveId 的连续 dispatched 是否视为同一批？旧报告在「按 waveId 去重」投影中如何归组？没有这条规则，F1/F3/F2 的测试写不出「旧形状→新规则」的预期值，也无法确定 fixture 是保留旧形状还是全面改造。建议：在方案中显式定义无 waveId 事实的退化语义（如：缺失 waveId 的每条派发各视为独立波、报告去重键回退 dispatchKey），并把该语义本身列为迁移测试用例。

**F-C02 F7「报告身份 = key+ver」的文件形态未定义（归因 F7）**
方案 §4 仅说「reports 报告 +ver」，但 ver+1 时是覆盖原 deliver-<key>.json 还是另存新文件、reportId 是否变为 deliver-<key>-v2、幂等判定（现 intake.mjs:130-134 按 payload JSON 全等比较）与 ver 的关系，均未定义。现有断言「同 key 只有一份报告」（intake.test.mjs:79）与「同 key 不同 payload 覆盖」的语义（intake.test.mjs:70-80）将在 F7 下直接冲突或失义。测试无法落笔，且这是台账 P1#3「payload 变化应产生可追溯 revision」的实现形态问题。建议：先定案「单文件 ver 字段递增」或「每 ver 一文件」，再写 F7 测试矩阵（同 payload 幂等 / 变 payload 递增 / 事件带 digest / 旧报告视为 ver 1）。

### Risk

**F-C03 台账验收门槛未全量映射进方案第 5 节（归因 §5 验收矩阵完整性）**
逐条对照结果：门槛 1（一批 + 任意 run/dispatch-plan/混用/并发 → wait-inflight）≈ §5.1 已覆盖；门槛 2（多包部分交付只等剩余包、重启恢复一批）在 §5 缺失；门槛 3（三角色三次续派 / replace-owner / 不跨阶段）≈ §5.2 已覆盖；门槛 4（四类历史重复 key 注入：零报告 / 单报告 / 同 digest 多报告 / 不同 digest 多报告 → 确定、可审计、无删除的恢复结果）在方案中完全缺失——F3 retire 只允许作废当前未结波，F9 只做 journal 分段赋号，台账要求的「digest 不同 → 用户选择卡保留版本」恢复边没有对应机制与用例；门槛 5 ≈ §5.3 已覆盖；门槛 6 仅覆盖 §5.4 前半（旧 key 冒充），迟到报告与「第二次 rework 不能被第一次报告消费」未提；门槛 7（真实 DSH 人工门 rework 复验）被弱化为 §6.5「迁移后继续当前任务」，不保证重现 rework 循环。建议：第 5 节按台账 7 条门槛一一列出对应用例与落点，缺机制的门槛 4 要么补机制要么显式声明后置并给出理由。

跨包定级记录（Challenger 轮）：同一条门槛 7 缺口在 requirements 包定为 blocker、standards 包标「待确认不阻塞」，与本包 risk 并存。本包维持 risk，理由：它是台账七条验收门槛之一、方案 §5/§6 无显式落点、§6.5 仅部分承接，但作为真实链路复验不阻塞代码基线冻结。终裁定级归 summary 包，回写三包后以终稿为准。

**F-C04 方案未指定新增/修改测试的落点文件与命名（归因 §5/§6.4 可追踪性）**
除 topology 一处点名外，F1–F9 的新增用例落在哪个测试文件、哪些既有测试预期需修订（如 F5/F6 决定字段改名对 core.test.mjs:106-137/170 的 fingerprint 断言、F7 对 intake.test.mjs:70-80 的影响）、台账 4 个确定性复现移植到哪，全部未声明。「回归测试全量 + 台账复现用例」无法在验收时逐项对照。建议：方案附「F# → 测试文件 → 用例名」映射表（见第 4 节建议矩阵）。

**F-C05 retire 命令与 dispatch-superseded 事件零测试面（归因 F3）**
新 CLI 命令 tw retire 无任何测试计划：合法作废、幂等、拒绝路径（已结波 / 未知 waveId / 缺 reason / 跨任务）、作废后 derive 守卫与 intake 提示（inflightHint）的过滤、run 与 dispatch-plan 双入口一致。tests/ 现零匹配。这是 I5「拒绝必有出路」与「已修复项必须带自动化回归」的直接欠账。

**F-C06 F9 迁移工具测试面未定义，且存在不可达分支（归因 F9）**
§5.7 仅一条合并/拆分用例。缺失：迁移幂等（重跑不重复赋号）、跨 stage-advanced 边界分段、含重复同轮报告的既有任务迁移后投影轮验算（§5.7 声称的「投影轮 = 3」无落点）、以及「归档任务重开时再迁移」的触发面——当前 CLI 无 unarchive/resume 命令（archive 是单向 rm + 只读归档，cli.mjs:662-699），该分支当前不可达、不可测试。建议：删除该承诺或给出触发面设计；迁移工具独立成 tests/runtime-v3-migration.test.mjs。

时序语义（第三轮 Expert 裁决已同步修正；本段最初与 logic L-05 同源的「快照=2 过时视图」不再成立）：F9 迁移只给 journal 赋 waveId、不动已接受报告；旧 review 的 reviewedPackages 快照是评审当时按旧口径写入的（intake.mjs:213-220）。现场任务的快照实际是 plan@3：Expert 核验 live journal（seq16/17/18 三条同轮 respond w16/w17/w18，round=3，pkg=plan）与已接受 challenger review review-w22-c98961（reviewedPackages=[plan@3]，在三条 round=3 交付之后写入，与 intake 取 max round 机制一致），waves.mjs:74-80 覆盖判定 3<=3 成立——L84「迁移后快照 plan@3 覆盖成立」为机械事实，无需条件化；迁移后下一推进方向为裁决新鲜度失效触发的 Expert 重裁（w11 早于 round3 交付），非死循环 review。F9 测试断言按现场事实写：快照=plan@3、迁移后覆盖即成立。一般性提醒仍成立：迁移不改旧快照，覆盖取决于最新已接受 review 的快照是否已含投影轮，跨任务断言须按该机制推导。现场 journal 事实本包无法直接读取（派单禁止读 .team-work），以 Expert 裁决为准。

**F-C07 F5/F6 兼容与重出卡矩阵无测试计划（归因 F5/F6）**
需要而未声明的用例：旧决定无 artifactFingerprint 时回退 fingerprint（gate.mjs:114 现比较 decided.fingerprint，改名后双路径都要测）；reviewFingerprint 缺失时的缺省语义；人工门等待期 Challenger/Expert 改写报告 → gate 同时对比双指纹 → 自动重出卡（cli.mjs:528-556 await-decision 分支当前无重出卡用例；core.test.mjs:106-117 只覆盖制品指纹失效的 blocker 层）；同 key 重交同内容不冒充、内容真变进评审（§5.4）的 CLI 级链路。I7（人工决定绑定指纹、变化即失效）的测试目前只有制品维度，缺评审链维度。

第二轮补充核验（五包代码证据一致，本包独立复核属实）：§5.5「等待期改写报告必然重呈卡」按方案字面机制**不可达**——gate.mjs:103-118 的未结决定分支只返回「等待用户决定」、不比对任何指纹（比对只发生在 decided 存在后的 gate.mjs:114）；cli.mjs:542-555 对未决卡原样返回旧卡文本、不重算指纹；cmdDecide 在 decide 时刻才绑定指纹（cli.mjs:584）。即「decision-issued 之后、decide 之前」的修订既不会触发重出卡，decide 时还会静默绑定新评审链。该机制缺口由 requirements F-10 主责（本文件不重复登记）；coverage 侧推论：§5.5 验收用例在机制修正之前无法写出预期值。机制修正面经 Expert 第三轮扩展为三处（本包逐一复核属实）：decision-issued 事件绑定双指纹、未决分支比对评审链指纹（gate.mjs:107-113）、人工门决定查找从 find-first 改为取最新决定（gate.mjs:105 现为 decisions.find，同门多次决定时恒比对旧指纹成死循环）。F6 重出卡测试行以该机制补丁为前置条件。

**F-C08 人工门返工分支的并发/混用/重启矩阵未计划（归因 F1/F3）**
concurrency.test.mjs:35-48 只覆盖普通首派并发 run；人工门 rework 分支（现 derive.mjs:30-45 提前返回处，正是事故现场）在锁内并发 run、run 与 dispatch-plan 混用、派发落 journal 后进程重启三种形态下「只写一批、journal 不增长」的用例未列入验收（台账门槛 1 的并发与门槛 2 的重启均要求）。

### Info

**F-C09 F8 key 改 d 前缀的契约测试缺失（归因 F8）**
现有 fixture/tag 测试硬编码 w2-xxx 等 key（tag-agent-auto-register、dsh-tag-injection、intake、topology.test.mjs:305），改为 d 前缀生成后这些种子不受影响（intake 只按 journal 查 key，不校验前缀），但需要新增正向契约：key 生成格式 d<全任务递增序号>-<3字节hex>、report 文件名跟随（deliver-d9-….json），并确认 dsh/inject.js:97 的 pendingTags 查找与 dsh 插件回填对 d 前缀无假设。

**F-C10 F2 投影去重与快照同源的 unit 层夹具缺失（归因 F2）**
core.test.mjs 的 pkgDeliver/pkgReview 夹具无「同轮重复报告」构造，现有用例全部是严格递增轮次——正好是事故 3 无法被现有套件检出的结构原因。应补「两条同 round 重复报告 → 投影轮不虚增 → reviewedPackages 快照同源判定覆盖成立」的 unit 用例与 reviewedPackages 写入处（intake.mjs:213-220）的同步改造断言。

**F-C11 回归套件基线与执行方式未写明（归因 §5.8/§6.4）**
「现有全量套件保持全绿」未附对照基线（台账称相关 54 项，findings.md:64）与执行命令；建议写明以 npm test（node --test tests/*.test.mjs，含 dsh/插件/仓库契约测试）为回归口径，并列出预期需同步修订的既有断言清单（F-C04 同源）。

## 3. 覆盖视角的批准基线（本包收敛结论）

**方向判定：可批准实施，但以本包 F-C01、F-C02 两个 blocker 先决补丁与 requirements F-10（F6 机制）blocker 共同为前提。** 理由：

- 方案的修复面集中在纯函数推导层（waves/derive/gate/intake 均为纯函数模块，F3 明确「合并为一个导出的纯函数」、F6 新纯函数），单元测试可行性强；台账点名的 4 处覆盖缺口与 F1–F4 一一对应，方案 §5.8 已承诺修正名实不符测试——覆盖路径的归因是正确的。
- 两个 blocker 不解决，测试预期值无法落笔（旧形状语义、F7 文件形态），实施顺序 §6.1/§6.2 与「回归测试全量」之间的覆盖基线就无法冻结。
- 台账门槛 4（四类重复 key 恢复矩阵）在方案中无对应机制，若不补机制，覆盖视角不能认定「台账验收」达成。
- requirements F-10（F6 机制）blocker 与本包 §5.5 可测性直接相关：机制修正前覆盖视角无法验收「等待期修订必然重呈卡」，F-C07 的测试行不生效。批准前提应记为「requirements F-10 + F-C01 + F-C02」三项。

### 建议的测试矩阵（供方案第 5 节修订采纳，落点按现有文件划分）

| 修复项 | 建议落点 | 关键用例 |
| --- | --- | --- |
| F1/F3 | runtime-v3-invariants / concurrency / topology | 人工门 rework 在途幂等（serial run、serial dispatch-plan、混用、并发、重启）；多包部分交付只等剩余包；retire 全路径 |
| F2 | runtime-v3-core / runtime-v3-intake | 同轮重复报告投影轮不虚增；reviewedPackages 与判定同源；轮次耗尽按真实轮 |
| F4 | runtime-v3-topology（修复 D3 名实不符） | 三角色三次续派可解析；replace-owner 后解析新成员；stage-advanced 边界停止 |
| F5/F6 | runtime-v3-core / runtime-v3-invariants / runtime-v3-cli | 双指纹绑定与回退兼容；旧 key 冒充被识破；等待期改写报告自动重出卡（前置：requirements F-10 机制补丁，见 F-C07）；第二次 rework 不被第一次报告消费 |
| F7 | runtime-v3-intake | 同 payload 幂等 ver 不变；变 payload ver+1；report-accepted 带 ver+payloadDigest；旧报告视为 ver 1 |
| F8 | runtime-v3-intake / repository-contract | key 格式 d 前缀；report 文件名跟随 |
| F9 | 新建 tests/runtime-v3-migration.test.mjs | 合并/拆分规则；迁移幂等；跨阶段分段；投影轮验算（按 Expert 裁决现场事实断言：w22 快照已为 plan@3、迁移后覆盖即成立）；归档任务只读（重开迁移分支先删除或给出触发面） |

### unresolved（不建议猜测补全，供汇总/实施轮确认）

1. F7 ver+1 的报告文件形态与 reportId 规则（blocker F-C02）。
2. 无 waveId 旧形状事实在守卫/投影下的退化语义（blocker F-C01）。
3. 「归档任务重开时再迁移」的触发面设计（当前 CLI 无重开命令）。
4. 台账门槛 4（不同 digest 多报告的用户选择卡）是补机制还是显式后置，方案未表态。

## 4. 审查局限声明

本文件只评估测试覆盖维度；方案与模型基线的一致性、台账引用的行号精确性、安全/迁移数据完整性等其他七视角由对应包 Owner 出具。跨包汇总去重归因终稿由 summary 包出具；本文件的「去重归因」仅指 coverage 包内部发现的整理，不构成跨包汇总口径。全部行号引用基于当前工作区读数，实施时以最新代码为准复验。
