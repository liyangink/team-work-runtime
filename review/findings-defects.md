# 波身份与恢复方案：defects 视角审查发现

> 视角：defects（方案缺陷）。结论：**有条件批准（approve-with-conditions）**——方向正确、可作为实施基线，但实施前必须先澄清 3 条 blocker 并补齐 6 条 major 设计决定与验收缺口；批准条件清单见第 5 节。

## 0. 审查范围与方法

- **对象**：`docs/wave-identity-recovery-plan.md`（波身份与恢复方案，F1-F9 + §4 数据结构 + §5 测试验收 + §6 实施顺序 + §8 后置项 + §9 关系声明）。
- **证据**（全部行级核对，每条发现带 文件:行号）：方案全文；`docs/v2-e2e-findings.md` V3-E2E 追加台账段（条目 V3-E2E-01~05、事故摘要、确定性复现、根因链、P0/P1 建议、相邻场景推演、修复验收门槛）；`docs/team-work-runtime-model.md` 模型基线；`docs/runtime-v3-charter.md`（P1-P6、I1-I10、§4 工具面、§5 目录约定、§7 测试预算）；`docs/runtime-roadmap.md` v3 里程碑与 v3.3；实现 `runtime-v3/{waves,derive,gate,intake,cli,store}.mjs` 与 `bin/tw.mjs`；测试 `tests/runtime-v3-invariants.test.mjs`（约 150-162）、`tests/runtime-v3-dsh.test.mjs`（约 285-303）、`tests/runtime-v3-topology.test.mjs`（约 319-344）、`tests/tag-agent-auto-register.test.mjs`（约 22-32）。
- **纪律**：未读取任务目录内部状态（遵守派单约束）；不臆测，无法确认处标 unresolved 并给验证建议；发现归因到方案具体条款与代码触点，附最小修正建议。

**对方案的肯定面**（支撑"有条件批准"而非退回）：根因定位与台账一致（三故障共享"波无实体身份、轮次双算法、成员身份挂一次性派发"的数据模型根因）；F2 投影 + reviewedPackages 写入处同源化是对 V3-E2E-03 双口径的正确根修；F5 用制品指纹因果取代时间戳是对 V3-E2E-04 的正确根修；F4 倒序回溯与台账 P0 建议 3 一致；F8 的 d 前缀消除旧 w 前缀与 waveId 的歧义；§8 后置项如实记录、§9 与定向委派方案的先后关系表述与 roadmap v3.3 一致。

## 1. Blocker（实施前必须修正/澄清，否则会产生新死循环、破坏核心不变量或使作废语义失效）

### B1. F6 机制按字面实施不可达：人工门重呈卡链路三处缺口，「等待期修订必然重呈卡」无法兑现

- **现象**（三处缺口，覆盖"等待期修订必然重呈卡"的完整链路；跨包已一致定 blocker——standards B1、logic L-03、types T2、impact B2 与本包 B1 同判，error-handling B2 互补）：
  1. **未结决定分支不比对指纹**：`gate.mjs:103-113` 的 `!decided` 分支只返回"人工门等待用户决定"，不比对任何指纹——决定尚未签发时评审链/制品在等待期变化不会触发失效；台账 P1-4 的 pending 子场景下，F6"等待期修订必然重呈卡"不可达。
  2. **未决卡文本不重算**：`cli.mjs:542-555` 对 pending 卡原样返回旧 `issued.detail.reason/choices`，不按当前事实重算——即使触发重呈，问题文本与选项仍是旧评审链下的。方案 F6 所称"重出卡机制现成，复用 await-decision 分支"的现成分支只覆盖"无 pending 时新签一张"，不覆盖本缺口。
  3. **已结分支 find 首个 accept 成环**：`gate.mjs:105` 的 `decisions.find` 取首个 accept；重出卡后再次 accept（decisions 只追加，`store.mjs:152-155`），旧决定仍被比对 → 指纹永不过时 → 无限重出卡（本包上一轮的原 B1）。
- **结论**：requirements 包 2.2 表/F-9 把台账 P1-4 判为「F6 覆盖」应改判「部分覆盖（机制不可达待修）」；F6 的批准条件应为**机制类 blocker（即本项）**，而非仅"复用现成分支"。
- **证据**：`runtime-v3/gate.mjs:103-113`（未结分支无比对）、`runtime-v3/gate.mjs:105`+`runtime-v3/gate.mjs:114`（已结分支 find 首个 + 指纹比对）、`runtime-v3/cli.mjs:542-555`（pending 原样返回旧文本）、`runtime-v3/store.mjs:152-155`（追加语义）、`docs/v2-e2e-findings.md:95`（台账 P1-4）。
- **最小修正**：① 决定**签发**事件（decision-issued）绑定签发时刻的制品+评审链指纹，gate 未结分支对比当前值与签发值，变化即作废旧卡并重签；② 重出卡从当前事实重新渲染 question/choices，不复用旧文本；③ 已结分支 decided 取最新 accept（`.at(-1)`）或只比对绑定最近一次 decision-issued 的决定；④ 方案 F6 措辞同步——"重出卡机制现成"改为"需先补上述三处，现成分支仅覆盖无 pending 重签发"。
- **验收**：等待期（决定未签与已签两态）修订评审链 → 重呈的卡文本反映最新状态且只重呈一次；再次 accept 后门禁通过、不再成环。

### B2. F1 在途守卫语义未覆盖「推导波与未结波属性不同」分支，字面实现会破坏组合评审等齐与波串行

- **现象**：F1 只定义"未结波属性相同 → 返回原在途卡，不新开波"，未定义"存在未结波但新推导波属性不同"时的行为。若按字面实现为"属性不同就新开波"，多包部分交付场景（如 respond 波 {A,B} 中 A 已交付、B 在途；重推导得到 A 的 review 波）会绕过等待直接派发 review，违反"组合评审等齐：部分交付不提前进评审/裁决"（`runtime-v3/waves.mjs:74-75` 注释）与模型基线"波与波之间永远是串行的"（`docs/team-work-runtime-model.md:60`）。
- **证据**：方案 F1（幂等语义句）；现行实现兜底语义在 `runtime-v3/derive.mjs:70-77`（尾部连续 dispatched 批次任一未交付即 wait-inflight，与波身份无关）——该"任何在途即等待"语义必须被 waveId 守卫**保留**；台账"多包只等待未交付包，不重复已交付包"（`docs/v2-e2e-findings.md:118`）同样要求此语义。
- **最小修正**：钉死为"存在任何未结波（同 waveId 的未交付派发集合非空）一律 wait-inflight；推导波与未结波属性相同仅用于决定复用/提示哪张在途卡"。同时明确 waveId 守卫在 derive、在途重建、intake 提示三消费点的统一判定。
- **验收**：多包 respond 波部分交付 + 重复推进 → 返回原在途卡、journal 不增长、不提前派 review。

### B3. F3 只定义「批次守卫过滤」作废波，superseded 波在 intake / 投影 / 身份回溯三处的消费语义全部缺失，作废可被「复活」

- **现象**：(a) `intake.mjs:27-29` 的 findDispatch 只认 `dispatched` 事件，superseded 不删除派发事件 → 成员仍可用被作废 key 交付，报告照常接受并驱动波次机——retire 不是真实取消；(b) F2 投影"按 waveId 去重"未声明排除 superseded 波（若作废波已有报告，其 round 是否计入轮次无定义）；(c) F4 倒序回溯（`cli.mjs:851-855`）的过滤条件无 superseded——被作废波若已 spawn 并有 mappings，回溯会选中被作废会话。
- **证据**：`runtime-v3/intake.mjs:100-104`、`runtime-v3/intake.mjs:173-176`（无 superseded 检查）、`runtime-v3/cli.mjs:851-855`（prevKeyOf 仅按 role/package 过滤）。
- **最小修正**：intake 拒绝 superseded key 的 deliver/review 并附修复指引（重新 run 取新卡，I5）；F2 投影与波次机状态推导排除 superseded 波；F4 回溯跳过 superseded 波的映射；retire 时忽略/清退该波映射（agents.json 关联记录保留审计）。方案 §3 F3 应补这三处消费语义。
- **验收**：retire 未结波后，旧 key 交付被拒且提示有出路；投影与续派身份不引用被作废波；无新死门。

## 2. Major（批准前必须补充的设计决定与验收缺口）

### M1. F9 迁移的持久化形态未定义，且与 journal 只增不改（I3/§5.1）冲突；waveId 计数器来源同样未定义

- **问题**：方案只给迁移归并规则，未说明既有 dispatched 事件如何获得 waveId。若改写既有 journal 行补字段，违反 charter §5.1"journal 只增不改"与 I3 事实源分离。同时"全任务递增 wv1/wv2/…"的计数器必须从 journal 纯推导（P1），不允许引入独立权威状态文件。
- **证据**：`docs/runtime-v3-charter.md` §5.1（journal 只增不改）、`runtime-v3/store.mjs:76`/`runtime-v3/store.mjs:96`（追加式读写）、方案 §4（仅列 dispatched.detail +waveId）。
- **最小修正**：声明迁移持久化形态——推荐「迁移标记事件（追加）+ 波身份惰性投影（纯函数从 journal 前缀重算）」；保证重复迁移幂等（同一批号）与失败不留半态（I10）；waveId 新号 = 投影最大号 + 1。
- **归因澄清（回应组合评审）**：defects 包对「F9 与 journal 只增不改冲突」的直接发现是本 M1（major，标题即点名冲突），并非仅 m2/i2 侧面提及；汇总表的来源标注对齐时，defects 侧应计本 M1（或在汇总中说明排除理由）。

### M2. F2「消费点全部换源」清单遗漏 derive.mjs:35 的人工门 respond 轮次计数口径

- **问题**：人工门 rework 的 respond 轮次 `runtime-v3/derive.mjs:35` 用「该包 owner 报告数 + 1」计数——是 waves.mjs:52 之外的**第二个计数口径**，且正落在本次事故的人工门路径上。同轮重复报告存在时该行会虚增轮次，与 F2 目标冲突。方案的换源清单（respond 轮次/review 轮次/轮次耗尽/依赖满足）未显式点名该处（它在 derive 而非 waves）。
- **证据**：`runtime-v3/derive.mjs:33-36`（`filter(...).length + 1`）、方案 F2 第二小条。
- **最小修正**：F2 换源清单显式列出 derive.mjs:35，改为「投影轮 + 1」，并加单测覆盖人工门 rework 后的 respond 轮次。

### M3. 台账修复验收门槛第 4 条（四类历史重复 key 的恢复结果）未映射进方案 §5

- **问题**：台账门槛要求"注入一组历史重复 key：零报告、一个报告、同 digest 多报告、不同 digest 多报告四类均有确定、可审计、无删除的恢复结果"（`docs/v2-e2e-findings.md:120`）。方案 §5 第 7 条只覆盖迁移归并两例。方案用"投影去重"设计使台账建议的"用户选择卡"不再必要（可论证：轮次/覆盖同源后不需要挑报告），但验收清单仍需证明四类输入下投影稳定、评审覆盖判定正确、无死循环。
- **证据**：方案 §5、台账修复验收门槛第 4 条。
- **最小修正**：§5 增补"四类历史重复数据注入后投影与推进的确定性验收"；若论证"不需要用户卡"，把该论证与投影去重测试一并落进验收证据。

### M4. 新增 tw retire 命令未声明与 charter 工具面的同步义务与 Lead 定位

- **问题**：retire 使 CLI 从"九命令"变十命令。charter §4.1 Lead 工具表、§8"薄 CLI（九命令）"、`bin/tw.mjs` 路由与 `tw help` 均需同步；retire 的拒绝形状（波不存在/非未结波/重复 retire 幂等）与审计（reason 必填、只增 `dispatch-superseded`）方案已隐含但未作为接口契约声明。
- **证据**：`docs/runtime-v3-charter.md:88-101`（Lead 工具表）、`docs/runtime-v3-charter.md:217`（九命令）、`bin/tw.mjs`（命令路由在 cli.mjs）。
- **最小修正**：方案声明 retire 入 charter §4.1/§8、bin/tw.mjs、--help；明确 Lead 工具定位与 reason 必填、幂等语义。

### M5. §5 验收清单缺 retire/superseded/迁移幂等/F6 防循环的负向与恢复用例，且未评估测试预算

- **问题**：AGENTS.md 要求"修改门禁、波次推进、目录结构或 intake 校验时，补齐损坏输入、非法流转、并发、恢复和幂等测试"。§5 缺：retire 非未结波拒绝（附指引）、重复 retire 幂等、superseded 三消费点（derive/cli/intake）过滤、迁移幂等、F6 重出卡不循环（防 B1）、"第二次人工 rework 不能被第一次报告消费"（台账门槛 6 的后半句）。charter §7 测试预算（测试:实现 ≤0.6）未评估。
- **证据**：方案 §5、`docs/v2-e2e-findings.md:122-123`（台账门槛 5/6）。
- **最小修正**：§5 增补上述负向/幂等用例清单，并给出预算口径。

### M6. 台账已新增 V3-E2E-05（成员递归扇出视角级审查），方案 §1 引用范围（01~04）滞后，批准基线需补记该缺陷的处置归属

- **问题**：台账 V3-E2E 段已追加 V3-E2E-05（`docs/v2-e2e-findings.md:54`）：包级派单原样注入任务级 objective，成员把「八个视角独立并行审查」误读为自身执行模板，在派单外递归扇出子代理（递归子代继承高成本档位，成员数翻倍、预算失控）。方案 §1 背景仍写「V3-E2E-01~04 追加台账」，§8 后置项亦未记录该缺陷。
- **判断**：V3-E2E-05 的处置为「下阶段修」——派单语境注入（包级范围与编排位置，不再原样注入任务级 objective）+ 成员层 subagent 治理 hook，其归属在派单构建层与定向委派方案 §8，不在本方案 F1-F9 波次机范围内；**不构成本方案的 blocker**。但「可批准实施基线」应覆盖全部已知 V3-E2E 条目的处置归属，否则实施后该缺陷失去挂靠、基线不完整。
- **证据**：`docs/v2-e2e-findings.md:54`（V3-E2E-05：根因 = cli.mjs:238 任务级 objective 原样注入包级派单 + 平台层无成员层派发档位治理；处置 = 派单语境 + 治理 hook，与定向委派方案 §8 合并评估）；方案 §1 第 7 行（引用「V3-E2E-01~04 追加台账」）。
- **最小修正**：方案 §1 引用更新为 V3-E2E-01~05，并在 §8 后置项补一条：「派单语境与成员层 subagent 治理（V3-E2E-05）——随定向委派方案 §8 档位上限治理合并实施，不在本方案范围」。

## 3. Minor

- **m1.** F3 称"在途批次逻辑三处重复"，实际四处：`derive.mjs:70-77`、`cli.mjs:186-198`（inflightDispatches）、`intake.mjs:78-87`（inflightHint）、`cli.mjs:766-771`（cmdPlan 重拆检查）。合并纯函数时应覆盖第四处。
- **m2.** F9"归档任务保持只读；重开时再迁移"与归档机制矛盾：归档只保留 `journal-summary.jsonl` 且过滤清单（`cli.mjs:693`）不含 dispatched 事件；重开=新任务新 journal，不存在迁移对象。建议删除该句或改为"归档任务不迁移"。
- **m3.** F5 指纹比较公式需与 gate 同源：gate 用 `artifactsFingerprint(current.length ? current : artifacts.items)`（`gate.mjs:106`，空登记兜底全量），decide 写入用 `artifactsFingerprint(current)`（`cli.mjs:577/584`，无兜底）。derive 侧 F5 比较若与 decide 侧不同源，在"决定时阶段无登记制品"边界下分叉。建议统一公式并测试。
- **m4.** F2 投影对旧报告 waveId 缺失的回退来源未定义：F9 迁移后既有报告文件无 waveId 字段，投影"按 waveId 去重"应经 journal 的 dispatchKey→waveId 解析（惰性），而非依赖报告字段；方案 §4 只写"reports 报告 +waveId（F2）"。
- **m5.** dispatch-plan waves[] 与 wait-inflight 卡未声明是否携带 waveId：编排层需要波身份做重试幂等与 retire 寻址。建议声明输出面携带 waveId。
- **m6.** F4"遇 stage-advanced 停止"必须按**原始 journal 序列**倒序扫描并在 stage-advanced 处 break 实现；若用"先过滤 dispatched 事件再取 at(-1)"实现（现 `cli.mjs:852` 的写法）会跨阶段串线。方案语义正确，实施时注意实现形态。

## 4. Info（记录性建议）

- **i1.** F1"同轮超并发拆两批 = 同 round 两个 waveId"与模型基线"波=一次动作、一次只推出一个波、波与波串行"（`docs/team-work-runtime-model.md:60/64`）存在定义张力：同一逻辑动作被拆成两个身份。方案 §2 已接受该建模，但模型基线文档需同步补充分批语义（或改"一个波两批派发"）。
- **i2.** F7"同 key 不同 payload → 覆盖 + ver+1"与 charter §5.1 reports"一次写入不可变；重派=新文件"措辞冲突。应同步修订 charter §5.1 的报告文件模型（每 key 一文件 + ver 版本链 + journal digest 链），或改采台账 P1 建议的替代"payload 变化拒绝并要求新派单"。
- **i3.** 归档 journal-summary 过滤清单（`cli.mjs:693`）不含 `dispatch-superseded` 与迁移事件——作废与迁移事实不进归档摘要，审计链不完整。建议纳入。
- **i4.** 残余风险如实记录：后置项 4（pendingTags 覆盖语义）与 F4 并存——台账 V3-E2E-02 明确"pendingTags 覆盖成最新 key，fresh 降级后可能回填给新 Owner"；F4 只修 dispatch-plan 的 expectedAgentId 导出，插件侧标签语义未动。§6 step 5（迁移后继续当前任务）的续派注入需真机验证，建议在方案中把该项标为"已知残余风险"而不仅是后置项。
- **i5.** 裁决新鲜度仍用时间戳（后置项 5）与 F6 评审链指纹并存：与 F2"唯一算法"原则存在残余张力。等待期 Expert 修订由 F6 在 gate 层兜底，waves 层 `verdictFresh`（`waves.mjs:95-96`）仍为时间戳。实施时明确两层职责边界（waves 层裁决消费 vs gate 层指纹失效），避免混用。
- **i6.** 方案 §3 F9 对当前活动任务的断言（`docs/wave-identity-recovery-plan.md:84`）需按精确时序表述：「投影轮 = 3」的前提是三条 respond 均为同轮（round 3，与事故摘要一致）；但「评审快照 plan@3 覆盖成立」的时机需精确化——迁移只动 journal 波身份，不改写既有报告的 reviewedPackages 快照（快照由 review 提交时按当时口径写入，`intake.mjs:213-220`），旧已接受 review 的快照值是现场数据（本审查按纪律未读任务目录状态，无法断言其值）。确定成立的是：迁移后首次推进由在途 review（方案 §6 step 5 的 w24）按新投影重写快照，其后覆盖成立——建议方案该句改为「迁移后首次推进再派一次 review（含在途 w24 完成）后快照按新投影成立」。同时保留建议：迁移工具输出"迁移前后投影对比"供现场核对。

## 5. 批准条件（实施前必须完成的方案修订/澄清）

1. **B1**：F6 机制三处缺口修复——decision-issued 绑定签发时刻制品+评审链指纹、gate 未结分支比对并重签、重出卡文本按当前事实重算、已结分支 decided 取最新 accept（防成环）；防重出卡循环回归测试。requirements 包 2.2 表该行同步改判「部分覆盖（机制不可达待修）」。
2. **B2**：F1/F3 钉死在途守卫语义——任何未结波存在一律 wait-inflight，属性相同仅决定复用哪张卡。
3. **B3**：F3 补 superseded 波三处消费语义——intake 拒绝（附 I5 指引）、投影/波次机排除、F4 回溯跳过；retire 清退映射。
4. **M1**：F9 声明迁移持久化形态（推荐追加迁移标记事件 + 惰性投影）与 waveId 计数器的 journal 纯推导来源；迁移幂等。
5. **M2**：F2 换源清单显式包含 derive.mjs:35。
6. **M3**：§5 补台账门槛 4 的四类历史重复数据投影验收。
7. **M4**：retire 命令面同步 charter §4.1/§8、bin/tw.mjs、--help。
8. **M5**：§5 补负向/幂等用例清单（retire 拒绝与幂等、superseded 三消费点过滤、迁移幂等、F6 防循环、F7 ver、跨阶段串线）。
9. **m2/m3/m4/m5/m6**：按第 3 节各条澄清（归档句删除、F5 指纹公式同源、旧报告 waveId 解析来源、dispatch-plan 携带 waveId、F4 实现形态）。
10. **i2/i3** 文档同步：charter §5.1 报告文件模型修订、归档过滤清单纳入 superseded/迁移事件。
11. **M6**：方案 §1 引用更新为 V3-E2E-01~05；§8 后置项补记 V3-E2E-05 处置归属（派单语境 + 治理 hook，随定向委派方案 §8，不在本方案范围）。
12. **i6**：方案 §3 F9「评审快照 plan@3 覆盖成立」改精确时序表述——迁移后首次推进、在途 review 按新投影重写快照后成立。

## 6. unresolved 与验证建议

- 方案 §3 F9 对当前活动任务的「投影轮 = 3」与既有快照值断言：受派单纪律约束未读取任务目录状态；实施时以迁移工具输出的迁移前后投影对比核对，并验证在途 review 按新投影重写快照后覆盖成立（i6）。
- 无其他 unresolved：本文件全部发现均带文件行号证据。
