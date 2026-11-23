# twr-framework-review-fixes 代码审查报告

- 任务：twr-framework-review-fixes-code-review · 阶段 code-review · 角色 owner · 轮次 1（wv1，key d1-b435e6）交付，轮次 2（wv3，key d3-bc66f5）按 Challenger 意见（review-d2-9f372a）修订：补入 F-9 双源返工范围接缝（G-1）与 F-10 决定视图一致性窗口（G-2）的独立复现与结论校准，并收窄轮次 1 对两项修复的关闭措辞（见 §7 核验记录）；轮次 3（wv6，key d6-90f6f6）按 Challenger 意见（review-d5-71ba5d）校准 G-2 下游影响：keep-session 孤儿行消费链经真实 CLI 端到端复现确认，「仅账本卫生」的排除性结论不成立，G-2 升级为已确认缺陷，并更正 extraRounds 消费规则的事实描述（见 §7）；轮次 4（wv9，key d9-1e4872）按 Expert 裁决（review-d8-52d893）补入 G-3（F-9 派单正文交接缺口）并更正设计引用（§3.6→§4.1:59）与 §4 标题分级（见 §7）
- 审查基线：runtime-v3/twr-framework-architecture-design.md，SHA-256 实测 `6668e09bb5686267e5f7b58040e76c18bb3b1adebaa9d7e4c9e45cfbfcb21b8b`（2026-11-20 本会话 shasum 实测），与派单声明及两份旧审查报告（docs/reviews/core-and-binding-review.md、docs-and-tests-review.md）一致——冻结基线未被修复任务改动。
- 审查性质：只读代码审查；未修改任何源码、测试、冻结设计基线或既有两份旧审查报告。

## 结论先行

四项修复的**原始缺陷场景**（F-9 accept+定点死循环、F-10 回滚事件缺 items、F-11 人工门 accept 缺前置守卫、F-2 评审新鲜度两条失真路径）与 doc-anchor 误报核对均确认修复落实并有行为级测试锁定，本会话独立复跑 241 项测试全部通过、零跳过。轮次 2 按 Challenger 意见补验后新增两条分级结论：**G-1（待裁决·中）** challenger 同 key 修订 rework 与 Expert verdict 定点并存时返工目标为双源并集（respond=[被 challenger 点名包 ∪ 被 verdict 点名包]，纯内存复现），与冻结设计 §5:115「实际技术返工目标由 verdict 的 must-fix 集合决定」的解读冲突（§5:114 的并集措辞又与实现一致——设计文本自身存在张力），无测试锁定，需设计澄清/用户裁决，非本轮审查可关；**G-2（已确认缺陷·中·既有通道语义延续，轮次 3 校准）** F-10 回滚决定视图先于 journal 写入，journal 原子替换失败时 decisions.json 残留孤儿决定行、重试产生同 ID 重复行、改选产生矛盾行（真实 CLI 故障注入三组独立复现）；**轮次 3 经真实 CLI 端到端复现进一步确认：keep-session 孤儿行可被续派换模型门消费（cli.mjs:1268-1271 不核对 journal 最终事实、rolesDigest 同配置重现即命中），回滚后再次改回同配置时免签确认卡并按旧模型派发——换模型确认门被绕过，影响升级为已确认推进缺陷**；另有 extraRounds 按行数计数在孤儿/重复行下虚高的同构源码事实；现有故障用例缺决定视图断言。修正需授权，本轮不改源码。F-9/F-10 的「关闭」结论据此收窄为「原始缺陷场景已关闭，相邻接缝如实分列」（G-1/G-2 详见 §2 与 §4）。轮次 4 按 Expert 裁决补入 **G-3（已确认缺陷·中·独立于 G-1）**：定点 Expert 必修细节（结构化 must-fix finding）不进 respond 派单正文（reworkContext 的 Expert 段只输出 verdict 三字段、不输出 findings），被点名包 Owner 据卡返工缺少必修项，违反设计 §5:114 的过滤送达要求，waves-regression:1189-1192 仅断言派给谁属测试盲区——F-9 的修复结论据此再区分为「派发目标已修、正文交接仍漏必修项」两层。另有 1 条非阻塞口径观察（D1：F-11 守卫仅覆盖 accept 选项）与 3 条低风险观察。

## 1. 实际覆盖范围

| 文件 | 审查深度 |
| --- | --- |
| runtime-v3/waves.mjs（550 行） | 全文通读；F-9 修复段（445-457、493-546）、reportOrderComparator（84-105）、pendingRecoveryRetries（276-309）、effectiveBlockedSet（230-271）逐行核验 |
| runtime-v3/gate.mjs（270 行） | 全文通读；reviewChainFingerprint（77-92）、gateCheck 评审消费点（171-194）、人工门新鲜度（222-267）逐行核验 |
| runtime-v3/store.mjs（458 行） | 全文通读；packagesEffective 投影（270-279）、loadTask 报告排序（290-300）、projectReportsFromJournal（159-228）逐行核验 |
| runtime-v3/derive.mjs（295 行） | 全文通读；多卡投影（60-124）、F5 消费规则（191-258）、stageReports 排序（138）核验 |
| runtime-v3/cli.mjs（4555 行） | 定点精读：cmdDecide（2440-2634，F-10 回滚事件 2601-2631、F-11 守卫 2507-2516）、展示层前置卡（2093-2152）、stageProgress/reworkContext（177-235）、归档 reviews 摘要（3521-3537）、at(-1) 消费点全量排查（160-3491 共 25 处逐一定位核验口径） |
| runtime-v3/intake.mjs | 定点：registerReview 的 reviewedPackages/reviewedBaseline 写入（640-676） |
| tests/runtime-v3-cli.test.mjs | F-10/F-11/F-2 用例段精读（1255-1484）+ 抽样 |
| tests/runtime-v3-core.test.mjs | F-9/F-2 用例段精读（100-290） |
| tests/runtime-v3-waves-regression.test.mjs | 定点返工/blocked/依赖接缝用例段精读（340-430、500-635、1160-1249） |
| doc-anchor 核对 | skills/team-work-v3/references/topology-and-cost.md 与 rules.md 全文标题比对 + git diff HEAD / git show HEAD 历史对照 |

未覆盖（范围界定事实，非遗漏掩盖）：

- dsh/、policy/、evals/、skills 其余文件不在本派单范围（原修复仅涉 runtime 五文件 + 三测试文件）。
- 全套 20 个测试文件中的其余 14 个未复跑（dsh-dispatch、concurrency、e2e-b-matrix、repository-contract 等）；本轮为确认修复无连带回归，额外复跑了 topology/intake/invariants 三个相邻文件。
- 真实宿主/LLM 实机演练（派单明确排除）。
- .team-work 任务内部状态（派单禁止读取）：因此**未能核对修复任务 Owner 声称的全量测试结果与交付 payload**，本报告 §5 仅记录本会话独立复跑事实。

## 2. 四项修复逐项核验

### F-9（高）Expert 定点返工死循环 — 派发目标（死循环/饿死）已修复关闭；范围接缝 G-1 与正文交接缺口 G-3 另列（轮次 2/4 校准）

- 原缺陷（core-and-binding-review.md F-9）：verdict=rework 分支清空全部 accepted 且 review 波先于 respond 波，未点名包恒落 review 循环、被点名包返工波永不派发（纯函数三步复现）。
- 修复核验：
  - waves.mjs:445-457：verdict=rework 只把被点名包（expertScope.all / ids 命中 / legacy 空 scope 保守回退全组）从 accepted 挪入 reworkP，**未点名包保留 accepted**（454 行注释即原缺陷的自述目标）；456 行补充把 expert 点名但未被 challenger 覆盖的活跃已交付包直接加入 reworkP。
  - waves.mjs:493-501：波选择优先级调整为 **respond（reworkTodo）先于 review（awaitingReview）**，并在 504 行 awaitingReview 中排除 reworkP 包——被点名包走修复，不再被未覆盖包的复审抢占。
  - 旧 verdict 重复消费路径同步关闭：A 修复重交形成新基线后 verdictFresh 失效（410-415 行 seq 锚），accepted 中保留的 B 经 522 行条件进入 verdict 重裁（continuation），A 先回 review 补评审（504 行优先于 522 行），链条收敛。
- 测试证据（行为级断言，非仅不抛错）：
  - runtime-v3-core.test.mjs:111-135（纯函数链）：challenger accept + expert verdict=rework 点名 a → respond 只含 a（"未评审的 b 不得抢先触发组合复审"）；a 修复 → review → verdict → gate 四步收敛，不再循环。
  - runtime-v3-waves-regression.test.mjs:1166-1231（CLI 全链，四包 DAG）：只重派 Expert 点名的包；点名包 blocked 后依赖包 c 不被旧基线解锁、b 的依赖 d 仍可开工（不冻结无关包）；无关包评审链继续消化；retry 确认后无关包 accept 修订不消费 a 的重试承诺（1217）；a 回应并审过后 c 才开工（1230）。
  - runtime-v3-waves-regression.test.mjs:565-625：定点裁决命中 blocked → 不退回 challenger/expert 空转，先按包恢复、轮次耗尽需授权、再仅重派目标包。
  - runtime-v3-topology.test.mjs:320-344：verdict rework 无归属 → 全组 respond 且每包派单内嵌裁决原因（另一侧语义不回归）。
- 与设计 §9「返工语义」行（232 行）判据对照："目标等于 must-fix 并集（reworkScopePackages waves.mjs:44-66）、context 不扩大、未点名已覆盖包不重派、依赖包不被误解锁"逐条落实——**但该判据仅在上表所引场景（challenger 一方为 accept）下验证成立**；challenger 为 rework 的双源场景见下方 G-1，轮次 1 将本节结论表述为无条件"关闭"属于过度声明，轮次 2 校准。

#### G-3（轮次 4 新增·已确认缺陷·中·独立于 G-1 的范围分歧）定点 Expert 必修细节（结构化 must-fix finding）不进 respond 派单正文，Owner 无从据卡完成返工

- 位置与机制（源码核验）：cli.mjs:1408 的 respond 正文（prompt 与 promptFull 全量变体共用 contextParts，1415-1423）统一走 reworkContext；reworkContext（cli.mjs:224-243）的 Expert 段（238-241）只内嵌 `verdict.outcome + rationale + recommendedAction`，**不输出 expert.payload.findings**（结构化 must-fix 的 statement/severity/scope）；236-237 行注释自述"Expert 裁决面向组合制品（verdict 无 findings 归属）……不过滤"——该假设与新协议相反：intake.mjs 强制 verdict=rework 必须携带显式 scope 的 must-fix finding（statement 即必修细节），challenger 段（232-234）则输出 findings。
- 触发条件：core 场景 Expert 以合法结构化 finding 表达必修细节（只写进 finding.statement，不重复写入 verdict.rationale/recommendedAction 文本）→ 该包 respond 派单的普通与全量正文均不含该细节；Expert 独立核验（review-d8-52d893）与本轮源码对照一致——只有把细节重复写入 verdict 建议文本时正文才可见（topology.test:320-344 断言的 prompt 含 rationale 即属此形态）。
- 与冻结设计的冲突：设计 §5:114 明确"返工内容过滤给每位 Owner 时保留针对该包及 all-covered 的必须项，并保留必要的组合上下文"——结构化 must-fix 正是该"必须项"，未送达违反此条；该缺口独立于 G-1（双源谁优先）的设计歧义：即使 G-1 裁决为 verdict 独占，点名包的必修细节同样丢失。
- 影响评估：F-9 修复后派发目标正确（点名包进入 respond、不再饿死），但被点名包 Owner 收到的正文只有 rationale 概述，缺少 finding 级必修细节——据卡返工无法完成或需向 Lead 反问；F-9 的"修复关闭"应区分为「派发目标已修」与「正文交接仍漏必修项」两层。
- 测试盲区（对轮次 1 引用的修正）：waves-regression:1189-1192 只断言"只重派 Expert 点名的包"（waves 映射），未断言派单正文包含 must-fix 细节；topology:320-344 为全组场景且细节恰写入 rationale。两处均不能证明正文交接正确。
- 结论与最小必要处置：属被审源码缺陷，修复不在本轮授权（报告只读）；修正方向：reworkContext 的 Expert 段按包过滤输出 verdict 报告的 must-fix findings（scope 命中该包或 all-covered，含 statement/severity，与 §5:114 的过滤语义一致），并补普通/全量正文回归断言。

#### G-1（轮次 2 新增·待裁决·中）challenger 修订 rework 与 Expert verdict 定点并存时为双源并集，未经 verdict 点名的包仍被返工

- 触发顺序（每步均有代码/复现依据）：① A/B 两包均已交付形成基线；② challenger 提交 v1=accept（覆盖 A/B）→ verdict 波派发、Expert 在途；③ challenger 以**原 key** 修订 v2=rework 且 must-fix 仅点名 A——intake.mjs:488-531 的 reviewLocked 只校验 key 对应评审派单、波未作废、被审基线与派单冻结一致（B4 阶段归属、522-531 基线对比），**不阻止该修订**；④ Expert 提交 recommendation=accept、verdict.outcome=rework 且 must-fix 仅点名 B（intake.mjs:475-486 组合矩阵判定合法）。
- 独立复现（轮次 2，纯内存、nextWave/inflightBatch 真实导出函数）：Expert 在途时 inflightBatch 返回未结波 {waveId:'wv8', openKeys:['ke']}（先等待 Expert）；Expert 报告提交后 nextWave 返回 **respond owners=[a,b]**——waves.mjs:427-431 challenger rework 分支先把 A 加入 reworkP，445-456 expert 段只处理 accepted 集合（B 命中 verdict scope 加入 reworkP），**没有任何分支移除 challenger 已点名的 A**；最终返工目标 = 双源并集 {A}∪{B}。
- 与冻结设计的冲突（设计文本自身张力，非单边违约可断）：
  - §5:115：「实际技术返工目标由 verdict=rework 的 must-fix 集合决定」——按此解读本场景返工目标应为 {B}，A 不应返工（Expert recommendation=accept 即不认同 challenger 对 A 的返工要求）；
  - §5:114：「返工集合 = 所有 must-fix 范围的并集」——按字面并集解读 {A}∪{B}={A,B}，与实现一致；
  - §9:232「未点名已覆盖包不重派」的"点名"主体存在两解（任何评审者都未点名 vs verdict 未点名）。三处文本不能同时无歧义地裁决本场景，实现选择了 114 行口径。
- 测试缺口（对轮次 1 结论的修正）：本节上表所引 core.test:111-135、waves-regression:1184-1192 的 challenger 均为 **accept**，不能证明 challenger=rework 与 verdict 定点范围不同时的行为；全库未见该双源场景的任何断言。
- 影响评估：未获 Expert 指定的包被额外返工（范围扩张、多耗一轮 respond），不产生死循环或数据损坏；A 返工重交后走正常评审链。
- 结论与最小必要处置：本接缝的根属是设计语义未定（114 vs 115 的裁决权在设计 Owner/用户），不是审查报告可关闭的缺陷；建议 Lead 将「challenger rework 点名与 expert verdict 点名不一致时返工目标取并集还是 verdict 独占」提交设计澄清/用户裁决，并在裁决后补双源场景测试。本轮不修改源码（不在授权内）。

### F-10（中）包模型回滚事件缺 items — 原始缺陷（items 缺失）已修复关闭；决定视图一致性窗口另列 G-2（轮次 2 补充）

- 原缺陷：回滚分支 re-planned 事件不含 items，packages.json 视图缺失时 store 投影回读仍是回滚前模型；且回滚视图先于 journal 写入。
- 修复核验：
  - cli.mjs:2601-2606：rollback-model 包级分支的 re-planned 事件携带 `items: restored`（基于当前有效计划映射回滚目标包 model 后的完整计划数组），与 decided 同批 journal 提交（2622 行 appendEventsUnlocked）。
  - cli.mjs:2630-2631：packages.json 视图改到 journal 提交**之后**写（注释明确"决定与完整回滚计划先在 journal 同批提交；packages.json 只是可重建视图"），符合设计 §6.3（189 行）。
  - 消费侧 store.mjs:272-279：packagesEffective 取 journal 最后一个带 items 的 packages-planned/re-planned 事件——回滚事件生效，旧事件（无 items）回退文件的兼容口径保留。
- 测试证据：
  - runtime-v3-cli.test.mjs:1271-1311：回滚后三层断言（packages.json 视图、loadTask 投影 task.packages、journal 事件 detail.items[0].model）均为回滚后模型；重签意图确认卡（decisionId 以 intake- 开头）且 intake.packages 展示回滚后模型——**同时关闭了旧 docs-and-tests-review D11 记录的断言放宽缺口**（HEAD 旧版断言已恢复为结构化形式）。
  - :1359-1376（两包）：事件承载完整计划（含未回滚包原配置）；rollback.seq === decided.seq + 1（连续提交事实）；删除 packages.json 后以完整计划事实重建。
  - :1378-1414（故障注入，journal.jsonl / packages.json 两组）：journal 写失败 → 零回滚事件、有效计划保持新模型；视图写失败 → 事实已提交、计划已回滚；重试幂等不追加第二个回滚计划——**但两组用例均只断言计划投影与回滚事件数量，未检查 decisions.json 决定视图**（测试盲区，见 G-2）。

#### G-2（轮次 3 校准·中·已确认缺陷·既有通道语义延续但影响升级）回滚决定视图先于 journal 写入：孤儿决定行可被续派门消费，keep-session 孤儿行已复现绕过换模型确认门

- 代码证据链（逐行核验）：cli.mjs:2590-2593 将本次决定 push 进 existing.items（内存）→ cli.mjs:2622-2624 经 appendEventsUnlocked 的 beforeAppend 回调把含本次决定的 existing 原子写入 decisions.json → appendEventsUnlocked（cli.mjs:207-215）**先执行回调（213 行）、后原子替换 journal（215 行）**——journal 替换失败（如 EIO）时 decisions.json 已含回滚决定行而 journal 无任何 decided/re-planned 事实。store.mjs:322-323 合并时文件行保留且优先；derive.mjs:106-120 卡片未决判定只看 journal。
- 独立复现（轮次 2，真实 CLI 故障注入三组，tests/support/v3-fixtures.mjs 夹具 + 临时目录隔离 + fsPromises.rename 对 journal.jsonl 注入 EIO，与 tests/runtime-v3-cli.test.mjs:1378-1414 同法）：
  1. **孤儿决定行**：decide --choice 3 返回 {ok:false, code:"EIO"} 后，decisions.json 已含换模型卡的「回滚包模型到旧值」决定行；journal 回滚事件数为 0；该卡按 journal 仍 open（可重答）。
  2. **重试重复行**：失败（choice 3）后重试同选项成功，同 decisionId 在 decisions.json 中出现 **2 行**相同 choice；journal 仅一条 decided。
  3. **改选矛盾行**：失败（choice 3）后改选 choice 1 成功，同 decisionId 在 decisions.json 中留下「回滚包模型到旧值」+「保留原会话」**两条互相矛盾的 choice**；journal 仅一条 decided（保留原会话）。
- 消费侧影响分析（轮次 2 初判已被轮次 3 复现推翻并校准）：轮次 2 曾认为消费点均按数组尾项取值、孤儿行不被消费成事实、仅影响账本卫生——**该排除性结论不成立**，两处更正与一处已复现的消费路径如下：
  1. **事实描述更正**：derive.mjs:178 的 extraRounds 按 `decisions.filter((d) => d.grant === "extra-round").length` **行数计数**（并非轮次 2 所称 .at(-1) 尾项取值）——同一视图先行窗口下，普通 converge-user 卡"追加一轮"失败重试的孤儿/重复行会使 extraRounds 虚高、maxRounds 相应抬高（换模型卡场景不产生 extra-round 行，此为同构的相邻消费面，未单独复现，按源码事实记录）。
  2. **已复现的推进影响（轮次 3，真实 CLI 端到端）——keep-session 孤儿行可绕过换模型确认门**：触发链五步——① 续派撞上配置变更签发换模型卡（rolesDigest 记录当时 roles+packages 摘要 D）；② 用户选"保留原会话"（keep-session）→ decisions.json 先行写入该决定行（含 keptModelRef=首派旧模型、rolesDigest=D）→ journal 原子替换 EIO 失败 → **孤儿 keep 行**残留、卡按 journal 仍未决；③ 用户同卡改选"回滚包模型"成功——journal 对该 ID 只记录回滚事实，孤儿 keep 行仍留在 decisions.json（store.mjs:322-323 文件行保留）；④ 用户此后再次把包计划改回与失败前**完全相同**的新模型配置（无待决卡、无在途时 plan 允许重拆，cli.mjs:3778-3785）；⑤ 续派派发点 freshSessionGate（cli.mjs:1917-1920/1929-1930 调用）在 cli.mjs:1268-1271 按 `grant === "keep-session" && sessionId === 当前会话 && role === 卡角色` 过滤后取尾行，**不核对该 decisionId 在 journal 的最终选择**；当前配置摘要（cli.mjs:1256-1257，intakeSnapshot 只覆盖 roles+packages 模型配置）重新等于 D → 孤儿行命中 → 不签发新的换模型卡（用户未获第二次确认机会）且 card.modelRef 被改为 keptModelRef（旧模型）。本会话端到端实测（fixtures 夹具 + journal.jsonl rename EIO 注入）：步骤 ⑤ 续派返回 stop=null（无 REQUIRES_FRESH_SESSION 卡）、派发模型 = fx-junior（首派旧模型），而当前计划配置为 example/new-model——**先前失败的选择覆盖了用户回滚后再次改回新模型的最终意志，换模型确认门被孤儿行绕过，派发使用未经最终确认的模型**。
  3. 其余消费点核验维持：gate.mjs:237-241（人工门 accept）、derive.mjs:24-25（reworkBinding）按尾项取值，矛盾/重复行场景与 journal 最终事实一致；孤儿回滚行不被这些分支消费。
- 定性与归因（轮次 3 校准）：decisions.json 先写是 appendEventsUnlocked 的既有通道语义（旧 core-and-binding-review F-5 已观察该"视图有、事实无"窗口并评估为无死门——该"无死门"评估对 keep-session 消费链**不成立**），**非本次修复引入**；但 F-10 修复将 packages.json 移到 journal 提交之后写（2630-2631）实现计划视图正确顺序时，未同步处理 decisions.json（仍在 beforeAppend 先写），回滚/keep 场景下该窗口继续存在，且现有故障注入用例（cli.test:1378-1414）未覆盖决定视图断言。影响评级由轮次 2 的"非阻塞·账本卫生"升级为**已确认缺陷·中**：换模型确认门可被孤儿行绕过（真实 CLI 端到端复现），违反冻结设计 §4.1:59「原会话模型与本轮任务级/包级模型不一致时，先沿用已有换模型确认卡及用户选择，不以『原会话可访问』绕过确认」的要求——用户第二次改回新模型的意图未经确认即被旧模型派发覆盖。
- 结论与最小必要修正：F-10 的「已修复」结论限定于原缺陷（事件缺 items 与 packages.json 顺序）；决定视图一致性为**已确认未关闭的缺陷**（keep-session 消费链已端到端复现；extra-round 计数虚高为同构源码事实、未单独复现）。最小必要修正方向（不在本轮授权，需 Lead/用户安排修复）：① 决定事实以 journal 为准——decisions.json 移到 journal 提交后写、或消费点（freshSessionGate 的 keep 过滤、extraRounds 计数等）改为只认有对应 journal decided 事实的行；② cli.test 故障用例补决定视图断言（孤儿/重复/矛盾三态）与 keep-session 孤儿行的续派门行为断言。

### F-11（中）普通人工门批准缺前置卡守卫 — 已修复（accept 路径），一条非阻塞观察

- 原缺陷：迁移冲突卡未决时按人工门卡 ID decide accept 仍写入决定（真实 tw 入口复现）。
- 修复核验：cli.mjs:2507-2512：人工门 accept 分支在任务锁内过滤未决 migrate / INTAKE_GATE 前置卡，存在即 `fail("USAGE")` 拒绝并列出卡 ID 与类型，与刷新确认（2189-2194）、包恢复确认（2355-2358）、只读展示层（2103-2108）同口径；拒绝发生在任何写入之前。
- 测试证据：runtime-v3-cli.test.mjs:1436-1457：migration / intent 两种前置卡 × 两种状态——未决时 decide 被拒且 journal 与决定视图**逐字节零写入**（1444-1445）；前置卡收口后同一人工门卡可继续批准。:1459-1463：迁移未决时"结束任务"仍可明确选择（安全结束逃生门不受守卫影响，与展示层 blockers 不拦结束一致）。
- 非阻塞观察（本报告 D1，见 §4）：守卫条件限定 `picked.label === "accept"`；展示层对 human-gate 整卡标 PREREQUISITE 不区分选项。rework 选项在迁移/意图未决时仍可写入决定——但写入后 derive 因未决卡静止（derive.mjs:152-177，migratePending 优先），respond 派发不会发生；迁移收口后 F5 reworkBinding 消费时按当期事实重新推导，评审链在新基线上重走。未发现直接绕过门禁的路径；是否将 rework 也纳入拒绝属口径取舍，建议后续与展示层对齐。

### F-2（中）评审新鲜度两条失真路径 — 已修复，缺陷关闭

- 原缺陷：reviewChainFingerprint 的 seq 锚只收集 report-accepted 且无 ver 维度（纯新协议退化 at 序；旧新混合时旧锚报告恒被选中）；nextWave/gateCheck 的 challenger/expert 按 at 排序数组尾项选取；store.loadTask 按 at 排序且比较器相等返回 1。
- 修复核验：
  1. waves.mjs:84-105：reportOrderComparator 成为共享导出——journal seq（report-accepted **与** report-committed 双事件源、(reportId, ver) 双键锚、缺锚回退该 reportId 最大 seq）第一全序，at 次级破平，ver 再破平；相等返回 0（非严格弱序问题同步修复）。
  2. gate.mjs:80-92：reviewChainFingerprint 的 pick 改用该比较器；part() 纳入 ver 维度（同 reportId 不同 ver 指纹不同）。
  3. 消费点统一排查（本会话逐一定位）：waves.mjs:355-357（nextWave）、gate.mjs:174/186（gateCheck）、store.mjs:295+300（loadTask 报告排序）、derive.mjs:138（stageReports）+ 195/219（filter 保序取尾）、cli.mjs:179-228（stageProgress/reworkContext 基于 task.reports 排序保序取尾）——未发现残留的 at 序评审消费点。
- 测试证据：
  - runtime-v3-core.test.mjs:213-218：比较器自反性（compare(r, r) === 0）。
  - :220-250（场景 A，challenger/expert 双角色参数化）：同 key v2=rework 以回拨 at 提交后——指纹变化、gateCheck 拒绝（"指纹已过期" + 评审 blocker）、nextWave 返回 respond；修订前批准有效的对照组在前。
  - :252-278（场景 B，双角色参数化）：legacy（report-accepted 锚、不同 reportId）与 modern（report-committed）混用，modern v2 内容修订后——指纹变化（"旧协议报告不得遮蔽新协议修订"）、gateCheck 拒绝。
  - runtime-v3-cli.test.mjs:1313-1329（CLI 层）：真实 loadTask 重建同 key v1(at 晚)/v2(at 回拨早) 后报告序仍为 [1, 2]（"墙钟回拨不能让旧版本成为最新"）。
- 连带修正确认（旧 F-8 同源观察）：cli.mjs:3527 归档 manifest reviews 摘要消费 task.reports，数组序已随 store 排序修复变为 seq 序——旧报告 F-8 建议的"顺带对齐"已实现，无需另行处理。

### doc-anchor 原误报核对 — 确认为误报，链接有效

- 旧 docs-and-tests-review.md D2 声称：topology-and-cost.md 尾部链接锚点 `rules.md#lead-通道skill-指路与工具反吐` 因"rules.md 对应标题已改为 Lead 规则通道（help 读取 + 工具反吐）"而失效。
- 本会话核对：rules.md:74 的标题在 **HEAD 与当前工作区均为** `## Lead 通道：skill 指路与工具反吐`（git diff HEAD 确认本次修改只改标题下第 1 条内容——"skill 指路"改为"help 通道"——标题本身未动，从未改名为 D2 所述形式）。按 GitHub slug 规则（小写、移除全角冒号、空格转连字符），该标题生成的锚点恰为 `lead-通道skill-指路与工具反吐`，与 topology-and-cost.md:43 的链接锚点完全一致。
- 结论：D2 属误报（把标题下内容的修改误判为标题改名），链接有效，无需修改；旧报告该条建议作废。

## 3. blocked / retry / 依赖接缝核验

- pendingRecoveryRetries（waves.mjs:276-309）：retry 确认后仅该决定之后的新 Owner 派单及其已提交报告能消费；旧评审、旧 key 迟到报告、作废波均不消费。测试 waves-regression:1213-1217（无关包旧评审 key 合法修订为 accept 也不消费 a 的重试承诺）。
- 依赖接缝：reworkTodo 排除 blocked 包与依赖未满足的 retry 包（496-497）；dispatchable 排除 blocked 依赖与未回应 retry 的依赖（528）；B10 依赖就绪按有效基线（含刷新来源）判定（349-351）。测试 waves-regression:1196（a 旧基线不解锁 c、b 的依赖 d 正常开工）、1230（a 回应审过后 c 才开工）。
- blocked 静止与定点返工交汇：expert 定点返工命中 blocked 包时 packageRecoveryRequired 标记走 §6.3 按包恢复，不退回整波人工门重派（waves.mjs:543-546、derive.mjs:193-199 让位检查）。测试 waves-regression:606-624。
- 并发恢复（retire×run、迁移×交付）在 waves-regression:1233+ 有锁串行化收敛断言（该文件本会话复跑通过）。

## 4. 发现清单（G-1 待裁决；G-2/G-3 为已确认代码缺陷待授权修复；其余非阻塞）

- G-1（待裁决·中·本次修复范围相邻接缝，详见 §2 F-9 节内专段）：challenger 同 key 修订 rework 点名 A 与 Expert verdict=rework 仅点名 B 并存时，返工目标为双源并集 {A,B}（纯内存独立复现 respond owners=[a,b]）；触发条件：challenger v1=accept 后 Expert 在途期间 challenger 原 key 修订 v2=rework（intake.mjs:488-531 不阻止），随后 Expert 提交 recommendation=accept + verdict 定点 B；影响：未经 Expert 指定的包被额外返工（范围扩张、多耗一轮），无死循环或数据损坏；证据与需求冲突：设计 §5:115「实际技术返工目标由 verdict 的 must-fix 集合决定」的解读被违反，但 §5:114「返工集合 = 所有 must-fix 范围的并集」字面又与实现一致、§9:232「未点名」主体存在两解——设计文本自身张力，无法单边断为违约；最小必要修正：Lead 将该语义提交设计澄清/用户裁决（并集 vs verdict 独占），裁决后补双源场景测试；本轮不修改源码。
- G-2（已确认缺陷·中·既有通道语义延续，轮次 3 校准，详见 §2 F-10 节内专段）：回滚决定视图先于 journal 写入，journal 原子替换失败时 decisions.json 残留孤儿决定行、重试产生同 ID 重复行、改选产生矛盾行（真实 CLI 故障注入三组独立复现）；推进影响已复现：keep-session 孤儿行在「失败 → 同卡改选回滚 → 再次改回完全相同配置 → 续派」链上命中 cli.mjs:1268-1271（grant/sessionId/role 过滤 + rolesDigest 同配置重现即匹配，不核对 journal 最终事实），免签换模型确认卡并按旧模型派发（端到端实测 stop=null、派发 fx-junior 而当前配置为 new-model）；另有 derive.mjs:178 extraRounds 按行数计数在孤儿/重复行下虚高（同构源码事实，未单独复现）；归因：旧报告 F-5 已观察的既有窗口，非本次修复引入，但 F-10 修 packages.json 顺序时未同步 decisions.json，且 F-5 的「无死门」评估未覆盖此消费链；最小必要修正：决定事实以 journal 为准（视图后写或消费点只认有 journal 事实的行）+ 故障用例补决定视图与 keep 门断言；需修复授权，本轮不改源码。后续修复设计约束（Challenger/Expert 共同提醒，轮次 4 补记）：仅按 decisionId 判断 journal 存在 decided 事件不足——本反例中失败的 keep 与成功的回滚共用同一 ID，消费点须核对具体选择与决定内容；若将决定视图移到 journal 后写，还需验证完整决定可由 journal 重建及提交后重试幂等。
- G-3（已确认缺陷·中·本次修复引入的交接缺口，轮次 4 新增，详见 §2 F-9 节内专段）：定点 Expert 必修细节（结构化 must-fix finding 的 statement/scope）不进 respond 派单正文——reworkContext 的 Expert 段（cli.mjs:238-241）只输出 verdict.outcome/rationale/recommendedAction、不输出 findings，其"verdict 无 findings 归属"注释与新协议 intake 强制携带显式 scope must-fix 相悖；触发条件：Expert 只把必修细节写进 finding.statement（合法且被协议要求的用法）；影响：被点名包 Owner 据卡返工缺少必修细节（普通/全量正文均缺，Expert 独立核验与本轮源码对照一致）；违反设计 §5:114「返工内容过滤给每位 Owner 时保留针对该包及 all-covered 的必须项」；独立于 G-1 的双源歧义；测试盲区：waves-regression:1189-1192 仅断言派给谁、未断言正文含必修细节，topology:320-344 细节恰写入 rationale 不能证明交接；最小必要修正：Expert 段按包过滤输出 must-fix findings 并补正文回归；修复不在本轮授权。
- D1（口径差异·低·本次修复引入）：F-11 写入口守卫仅覆盖 accept 选项（cli.mjs:2507），展示层对 human-gate 整卡标 PREREQUISITE（cli.mjs:2105-2108）不区分选项；迁移/意图未决时 rework 选项仍可写入决定。触发条件：迁移冲突卡未决 + 对人工门卡 decide 选 rework；影响：决定被记录但任务静止（migratePending 优先）、派发不发生，迁移收口后按当期事实重新推导，无直接绕过门禁路径；最小必要修正：守卫条件纳入 rework 或展示层按选项区分，与设计 §6.2.2-4"肯定性决定"口径对齐（是否将 rework 视为肯定性决定属语义取舍，建议后续小任务处理）。
- D2（顺手收益·记录）：旧 F-8（归档 manifest reviews 摘要可能按 at 序失真）已随 F-2 的 store 排序修复连带解决，无需动作。
- D3（观察·无需动作）：waves.mjs:456 将 expert 点名但未被 challenger 覆盖的包直接加入 reworkP（不经 challenger 复审直接返工）——语义符合设计 §5"返工目标 = must-fix 并集"（Expert 裁决优先于形式评审）；core.test:111-122 断言的是未点名包不抢复审，与本行为不冲突。
- D4（观察·无需动作）：intake.mjs:658 reviewedPackages 仍记录全部基线包（覆盖快照语义）——F-9 修复在 waves 消费端，此快照语义本身正确（覆盖判定需要全量基线），非缺陷。

## 5. 验证记录（本会话独立复跑）

| 验证 | 结果 |
| --- | --- |
| 设计基线 SHA-256 | `6668e09b…21b8b`，与派单声明及两份旧审查一致（冻结未动） |
| node --test runtime-v3-core + waves-regression | 62/62 通过（12.4s） |
| node --test runtime-v3-cli | 119/119 通过（30.6s） |
| node --test runtime-v3-topology + intake + invariants（连带回归确认，超出派单三文件的补充复跑） | 60/60 通过（9.4s） |
| 五个源文件 SHA-256（waves d9de8e2d…、gate 5b2a4371…、store 6953949c…、derive caf8e663…、cli 7c6fab8a…） | 已记录，供后续对账 |
| G-1 纯内存复现（轮次 2）：A/B 交付 + challenger v1 accept（Expert 在途）+ challenger 原 key v2=rework 点 A + expert recommendation=accept/verdict=rework 点 B；nextWave/inflightBatch 真实导出函数 | Expert 在途时 inflight={wv8, open:[ke]}；收齐后 nextWave=respond owners=[a,b]（exit 0） |
| G-2 真实 CLI 故障注入三组（轮次 2，fixtures 夹具 + 临时目录 + journal.jsonl rename EIO 注入） | ① decide 失败后 decisions.json 已含回滚行、journal 零事件、卡仍 open；② 重试同选项后同 ID 决定行 ×2；③ 改选后同 ID 留「回滚包模型到旧值」+「保留原会话」矛盾行、journal 仅一条 decided |
| G-2 keep 孤儿行端到端复现（轮次 3，真实 CLI 全链，fixtures 夹具 + journal.jsonl rename EIO 注入） | 换模型卡 keep-session 失败（孤儿行）→ 同卡改选回滚成功 → 再次 plan 回相同新模型配置 → 续派返回 stop=null（无 REQUIRES_FRESH_SESSION 卡）、派发模型 fx-junior（首派旧模型）而当前配置为 example/new-model——孤儿 keep 行被消费，换模型确认门被绕过 |

- 独立复跑合计 241 项，0 失败、0 跳过；本轮复跑的 6 个文件均无 DSH_TEST_HOST 类宿主条件跳过项。
- 未运行的验证：全套其余 14 个测试文件；真实宿主收单/通知语义（派单排除）；修复任务 Owner 声称的全量测试结果未能核对（不读取 .team-work 内部状态，无其交付 payload 可见渠道）——如需对账由 Lead 以任务事实补充。

## 6. 审查边界与未验证事项

- 本报告结论仅覆盖 §1 列出的实际审查范围；dsh/、policy/、evals/、skills 其余改动与全套测试未下结论。
- 四项修复的正确性证据为源码逻辑核验 + 内存夹具/CLI 测试层独立复跑；真实宿主全链、跨进程崩溃窗口的实机行为未验证（与派单排除项一致）。
- F-7（宿主对账 stat 未命中换 ID 重建与冻结方案差异）不在本次修复范围，状态维持旧报告"待 Lead 核对用户裁决原文"；本报告未对其下新结论。

## 7. 轮次 2 核验与修订记录（key d3-bc66f5 / d4-c5485b，按 Challenger review-d2-9f372a）

对 Challenger 两条 blocker 意见的独立核验结论（复现脚本与中间态输出见 §5 验证记录）：

| 意见 | 独立核验结论 | 处置 |
| --- | --- | --- |
| F-9 定点范围结论遗漏反例（challenger 修订 rework 点 A + expert verdict 仅点 B → respond=[A,B]） | **成立**：纯内存复现与 Challenger 实测一致（inflightBatch 先等待 Expert、收齐后 respond owners=[a,b]）；intake.mjs:488-531 确认原 key 修订路径可达（只查 key 有效/未作废/基线一致）；waves.mjs:427-431 先加 A、445-456 只追加 B 而无移除分支；轮次 1 所引 core.test:111-135 与 waves-regression:1184-1192 的 challenger 均为 accept，确不能证明双源场景 | F-9 结论由"关闭"收窄为"原始缺陷场景关闭"；新增 G-1（待裁决·中，§2 F-9 节专段 + §4）；设计 §5:114/115、§9:232 文本张力如实呈现，裁决权交 Lead/用户，不改源码 |
| F-10 故障恢复与幂等遗漏决定视图（journal 失败后孤儿决定、重试重复、改选矛盾） | **成立**：代码链核验（cli.mjs:2590-2593 push → 2622-2624 beforeAppend 先写 decisions.json → appendEventsUnlocked:213 回调先于 215 journal 替换）+ 真实 CLI 故障注入三组复现全部命中（孤儿行/同 ID 重复行/矛盾行）；cli.test:1378-1414 确只断言计划投影与回滚事件数、无决定视图断言 | F-10 结论区分"已修复的 items 缺失"与"待验证的决定一致性窗口"；新增 G-2（非阻塞·中·既有 F-5 通道语义延续，§2 F-10 节专段 + §4）；消费侧分析确认无绕过门禁路径；修正方向记录备查，不改源码 |

修订范围声明：轮次 2 仅修改本报告文档（可写路径内），未修改任何源码、测试、冻结设计基线或既有交付；轮次 1 的独立复跑记录（§5 前五行）与四项修复主场景核验结论（§2）不变，变更是补充两处接缝的证据与分级、并收窄过度声明的关闭措辞。宿主实机验证维持派单排除项声明，本轮未运行。

### 轮次 3 记录（key d6-90f6f6，按 Challenger review-d5-71ba5d）

对 Challenger 第二轮 blocker 意见（G-2 下游消费结论被源码对照反驳）的独立核验结论：

| 意见点 | 独立核验结论 | 处置 |
| --- | --- | --- |
| keep-session 孤儿行可被续派门消费（反向改选接缝：keep 失败 → 同卡回滚 → 计划改回同配置 → 免确认旧模型派发） | **成立且已独立端到端复现**（Challenger 为源函数内存对照，本轮补齐真实 CLI 全链）：cli.mjs:1268-1271 的 keep 过滤只比对 grant/sessionId/role 与 rolesDigest（1256-1257，intakeSnapshot 仅覆盖 roles+packages 模型配置），不核对该 decisionId 的 journal 最终选择；rolesDigest 同配置重现即命中；实测续派 stop=null、派发模型=首派旧模型而当前配置为新模型——轮次 2「未发现绕过门禁路径、仅账本卫生」的排除性结论被推翻 | G-2 影响评级由「非阻塞·账本卫生」升级为「已确认缺陷·中」（§2 G-2 消费侧分析重写、§4 同步）；旧 F-5「无死门」评估对该消费链不成立的说明已补记；修正方向更新为「决定事实以 journal 为准」 |
| derive.mjs:178 extraRounds 按行数计数，并非报告所称取 .at(-1) | **成立**：源码为 filter().length 行数计数；同一视图先行窗口下孤儿/重复 extra-round 行会使 maxRounds 虚高（换模型卡场景不产生该 grant，同构相邻消费面，按源码事实记录、未单独复现） | §2 G-2 事实描述更正；影响如实标注 |

修订范围声明：轮次 3 仅修改本报告文档（可写路径内），未修改任何源码、测试、冻结设计基线或既有交付；G-1（待裁决）与四项修复主场景核验结论（§2）不变，变更集中于 G-2 的影响校准、一处消费规则事实更正与验证记录补充。宿主实机验证维持派单排除项声明，本轮未运行。

### 轮次 4 记录（key d9-1e4872，Challenger accept + Expert 裁决 rework）

| 意见来源 | 要点 | 独立核验结论 | 处置 |
| --- | --- | --- | --- |
| Expert（唯一报告阻塞） | F-9 交接缺口：定点 Expert 必修细节在普通/全量 respond 正文中丢失，Owner 无从据卡返工；独立于 G-1 | **成立**（源码对照：cli.mjs:1408 respond 正文走 reworkContext，238-241 Expert 段只输出 verdict.outcome/rationale/recommendedAction、不输出 payload.findings；236-237"verdict 无 findings 归属"注释与 intake 强制显式 scope must-fix 相悖；与 Expert review-d8-52d893 的独立核验一致） | 新增 G-3（§2 F-9 节专段 + §4 条目）；F-9 结论区分为「派发目标已修」与「正文交接仍漏必修项」；测试盲区（waves-regression:1189-1192 仅断言派给谁）如实补记 |
| Challenger info（非返工要求，顺手更正） | 报告引用的"冻结设计 §3.6"不存在，正确位置为设计 §4.1 第 59 行 | **成立**：设计文档无 §3.6 小节；§4.1:59 即换模型确认卡要求原文 | G-2 定性段引用更正为 §4.1:59 |
| Challenger info | §4 标题仍把 G-2 列入"非阻塞"字样，与正文已确认缺陷的分级不一致 | **成立** | §4 标题改为「G-1 待裁决；G-2/G-3 为已确认代码缺陷待授权修复；其余非阻塞」 |
| Challenger/Expert 修复设计约束 | 后续修复 G-2 时仅按 decisionId 匹配 journal decided 事件不足（同 ID 双选择），须核对具体选择与决定内容；视图后移需验证完整决定可重建与提交后重试 | 记录采纳（本反例中失败的 keep 与成功的回滚共用同一 ID，证实必要性） | 补入 §4 G-2 条目的修正方向段 |

修订范围声明：轮次 4 仅修改本报告文档（可写路径内），未修改任何源码、测试、冻结设计基线或既有交付；G-1/G-2 细粒度结论、四项修复主场景核验与全部独立复现/复跑记录不变。宿主实机验证维持派单排除项声明，本轮未运行。
