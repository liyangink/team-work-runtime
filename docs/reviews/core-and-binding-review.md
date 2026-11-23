# core-and-binding 包代码审查报告

> 轮次 4 修订版（key d11-2ea32c）。在轮次 3（d7-56f12c）基础上按 Expert 裁决（review-d10-d624f4）补充三项新发现并独立复现：
> **F-9 定点返工死循环**——waves.mjs:406-466：expert verdict=rework 仅点名部分包时清空全部 accepted、且 review 波排在 respond 之前，未点名包永远循环在 review、被点名包的返工波永不派发（纯函数三步复现）；
> **F-10 包模型回滚事件缺 items**——cli.mjs:2596-2601 的 re-planned 不带完整计划，packages.json 视图缺失时 store.mjs:270-278 从 journal 投影回读到的仍是回滚前的新模型（合成任务目录 + 真实 loadTask 复现）；
> **F-11 普通人工门批准缺前置卡守卫**——cli.mjs:2485-2512 无迁移/意图未决检查（展示层 2103-2108 与刷新 2189-2194、包恢复 2355-2358 均有），迁移冲突未决时 accept 仍写入决定（合成任务目录 + 真实 tw 入口复现）。
> 同时按 Challenger/Expert 建议限定 F-2 场景 B 为"同角色**不同 reportId**"遮蔽场景（同 reportId 共享锚按 at 选新版本、指纹会变化，已对照验证）。
> 未修改任何源码、测试或设计基线。

- 任务：twr-framework-re-arch-code-review · 阶段 code-review · 包 core-and-binding · 轮次 1 交付 + 轮次 2 返工修订
- 审查基线：runtime-v3/twr-framework-architecture-design.md（SHA-256 `6668e09bb5686267e5f7b58040e76c18bb3b1adebaa9d7e4c9e45cfbfcb21b8b`，与派单声明一致，轮次 1 会话实测校验）
- 审查对象：工作区未提交变更中的 runtime-v3/、policy/、dsh/ 共 13 个文件（+3470/-893 行；git diff --stat 实测）
- 审查方式：只读源码审查（逐文件通读 + 关键路径行号取证）+ 纯函数行为验证（含错误放行复现与对照）+ 既有测试套件运行。

## 1. 覆盖声明

### 实际覆盖（逐文件）

| 文件 | 审查深度 |
| --- | --- |
| policy/kernel.mjs | diff 全量 + 全文关键段 |
| runtime-v3/domain/digests.mjs | diff 全量 |
| dsh/tw-tool.js | diff 全量 |
| runtime-v3/rules.mjs | diff 全量 + 依赖函数（readRuleFile/readBaseline）源码核实 |
| runtime-v3/persistence/file-artifact-repository.mjs | diff 全量 + 与既有 readStable 防护面对比 |
| dsh/subagent-session.js | diff 全量 + 当前版全文（收单核验/创建许可/ID 匹配） |
| runtime-v3/gate.mjs | diff + 当前版全文 |
| runtime-v3/derive.mjs | diff + 多卡投影函数全文 |
| runtime-v3/waves.mjs | diff + 当前版全文（497 行） |
| runtime-v3/store.mjs | diff + 当前版全文（458 行） |
| runtime-v3/intake.mjs | diff + 当前版全文（676 行） |
| dsh/tw-dispatch.js | 当前版全文（455 行，对账链逐分支） |
| runtime-v3/cli.mjs | 关键段精读：锁与事件追加（206-221）、决定卡列表与展示（2093-2167）、刷新确认（2169-2342）、包恢复确认（2344-2422）、cmdDecide（2424-2628）、cmdRestore 快照核验（2630-2660）、cmdRefreshArtifacts（2794-2967）、verifyStageArtifacts/cmdRetire（2946-3026）、dispatchedDetail 冻结正文（1724-1747）、runTransition 派发/推进分支（1828-1973）、cmdPlan（3687-3812）、**cmdArchive 归档链（3358-3536，轮次 2 补审）**、dispatch-plan 核验链（4055-4130）、help 的 Lead 规则返回（4388-4417）。非关键渲染段未逐行 |

### 跨层契约抽查（4 项）

1. **冻结正文跨层契约**：runtime 侧 dispatchedDetail 写入 prompt/promptDigest/promptFull(+Digest)（cli.mjs:1742-1745），dispatch-plan 输出 promptFrozen:true（cli.mjs:4125-4126）；dsh 侧 frozenPromptProblem 重算 SHA-256 并逐块核对（tw-dispatch.js:112-120、308-310），subagent-session.dispatchKeyFromPrompt 只认派单首行完整 key（subagent-session.js:29-33）。实测三种首行变体（派单/续派/续派全量变体）均正确解析、非首行出现 key 不误判。
2. **派单锁跨层契约**：dsh/tw-dispatch.js:16 直接 import runtime-v3/store.mjs 的 dispatchLockPath/withOwnerLock（tw-dispatch.js:276 与 cli.mjs cmdRetire:3000-3005 使用同一路径函数与 key 字典序），先 key 投递锁、后短持任务锁、宿主 I/O 在任务锁外，与设计 §4.3-1 锁顺序一致。
3. **字节摘要跨层契约**：policy/kernel.mjs:16-28 digestBytes（sha256-bytes-v1）经 domain/digests.mjs 导出，intake（快照与实时核验）、gate（artifactVerification）、cli（refresh/restore/verifyStageArtifacts）统一消费；快照 format=bytes-v1 base64 载荷（intake.mjs:367-370），restore 双向兼容旧 content 文本快照（cli.mjs:2647-2658）。
4. **多卡投影跨层契约**：derive.pendingDecisionsOf/cardOf（derive.mjs:60-113）为唯一投影，cmdDecide（cli.mjs:2434-2475）、pendingCardLists（cli.mjs:2146-2152）、dsh decisionOutput（tw-dispatch.js:122-140）共用；多卡时省略单卡别名并置 needsDecisionId:true，单卡保留兼容。

### 本包未覆盖（由其他包或后续任务承担）

- tests/ 目录 15 个测试文件的内容审查（属 tests-and-integration 包）；本报告仅引用其运行结果与被点名断言作为行为证据。
- skills/team-work-v3/、team-work/rules/、docs/ 的文档变更（属 skills-and-docs 包）；本包仅核实 F-N2 修复的 runtime 半边（rules.mjs + cli help）。
- 真实宿主（DSH 0.2.2）实机演练、隔离宿主收单日志一致性验证（派单明确排除，属后续独立测试任务）。
- evals/ 目录新增评测资产（不在本包范围）。
- 实施期用户对 dsh-binding 的对话裁决原文核对（见 §4 F-7 的证据边界说明）。

## 2. 设计一致性核查结论

**总体结论：13 个文件的变更与设计基线的多数核心要求一致（强类型协议、完整清单、字节核验、刷新原子提交、多卡按 ID、F-N2/F-N3、锁顺序）；但存在两处需要在评审链上如实呈现的偏差——① 评审"最新"口径在个别消费点按 at 数组序且评审链指纹函数不识别新协议事件，构成有复现证据的错误放行路径（F-2，本轮已升级）；② 派发对账在 stat 未命中时的换 ID 重建/补建行为依据实施期用户裁决，与冻结设计 §4.2 表/§4.3-3 的保守措辞存在差异且裁决未合入冻结文档（F-7，待核实）。**

逐项核查（结论 + 关键证据）：

1. **摘要算法不混用（§6.2）** ✔ — digestBytes 对 Buffer 计算原始字节 SHA-256，与 digestValue（canonical JSON 文本）显式分离且注释声明不判等（kernel.mjs:16-28）；旧报告 digestAlgorithm 缺失时按旧文本口径核对、不与字节摘要判等（intake.mjs:130-133、165-172）。
2. **§5 强类型同步校验** ✔ — deliver/review/finding/scope/verdict 全部字段白名单 + 未知字段（含嵌套）一次聚合拒绝（intake.mjs:42-47、225-275、534-611）；旧 package/packages 形状明确拒绝并给替换写法（intake.mjs:556-558）；先判形状再遍历（B13，intake.mjs:236-252）；Expert verdict 必填、Challenger 禁 verdict（intake.mjs:572-601）；双结论一致性矩阵按设计表格实现（verdictCombinationError，intake.mjs:475-486）；rework 必须带显式 scope 的 must-fix、纯 accept 不得携带 must-fix（intake.mjs:592-609）。
3. **返工范围投影（§5）** ⚠ 集合计算正确、波次消化存在 F-9 缺陷 — reworkScopePackages 取 must-fix scope 并集，all-covered 覆盖全体，context 不扩大（waves.mjs:45-67）；legacy 报告（全部 finding 无 disposition/scope）回退旧口径；challenger rework 选择性点名、未被点名包视同通过（waves.mjs:388-393）；expert verdict rework 按 verdict scope 并集、不再无条件全组（waves.mjs:406-415）——**但 verdict 分支清空全部 accepted 且 review 波先于 respond 波，定点返工死循环在 review（F-9，纯函数复现），被点名包的返工波永不派发**。
4. **每包完整清单（§6.1）** ✔ — deliverBaselines 按包取 journal 提交序最新未作废 delivered 报告（waves.mjs:172-195），reportOrderComparator 以 (reportId, ver) 锚 seq、at/ver 破平（waves.mjs:90-106）；deliver --paths 语义为完整清单，回执列 added/removed（intake.mjs:413-423）；blocked 空 paths（intake.mjs:266-268）；包间互斥防迟到跨包认领（intake.mjs:292-304）；幂等 = key+payload+全部路径字节相同（intake.mjs:318-333）。
5. **journal 唯一权威（B2/§6.1）** ✔ — deliver/review/刷新/包恢复的提交都是"快照先行（刷新场景写后核验，cli.mjs:2253-2266）→ journal 单次原子替换（report-committed 携带完整事实含 payload/files）→ 视图（reports/、artifacts.json）事后重建"；loadTask/freshState 统一经 projectReportsFromJournal 以事件流投影报告、同 (reportId,ver) 冲突事实报 STATE_CORRUPT（store.mjs:161-228）；artifactsNeedRebuild 按投影序判定重建（store.mjs:230-241）。
6. **实时核验链（§6.2）** ✔（主链）—— review 接受前稳定读取各活动包基线清单磁盘字节比对并核快照自洽（intake.mjs:613-634 + verifyArtifactBytes 134-182，快照缺失/损坏 fail-closed）；人工门 accept 前核验（cli.mjs:2507-2512）；评审/裁决派单派发前核验、不一致返回 blocker 卡（cli.mjs:1871-1884）；阶段推进/完成前核验结果经 artifactVerification 传入 deriveTask→gateCheck（cli.mjs:4062-4065、gate.mjs:139-149）。**但评审链指纹的"最新"锚定存在 F-2 缺陷（两条纯函数复现路径，见 §4），人工门新鲜度在该缺陷触发时失真。**
7. **Lead 受控刷新（§6.2.1）** ✔ — 准备卡：reason 必填、多包指定单包、已批准范围为空拒绝、意图确认绑定（confirmed-intake/legacy-range 双模式）、缺省清单取当前基线否则必须显式 pathsJson、幂等返回同卡、候选变化重签（cli.mjs:2794-2916）；确认：锁内重核阶段/计划/前置卡/授权/原报告/字节一致/在途评审阻止（cli.mjs:2176-2242），快照写后重读核验（2253-2266），一次 journal 提交 decided + report-committed(origin=user-authorized-lead-refresh) + 受影响旧门 superseded（2304-2310）；受影响卡判定按绑定阶段/包指纹，同字节新基线身份也收口（R3-7 refreshFloor，2288-2302）；刷新报告不推高 Owner 投影轮（waves.mjs:204-221 projectRounds 排除 refresh 来源），形成待评审基线且依赖就绪判定不以轮次>0 卡依赖包（waves.mjs:312-314）。
8. **多卡按 ID（§6.2.2）** ✔ — 统一待决集合按签发 seq 稳定排序仅展示（derive.mjs:105-113）；同 ID 多条不同正文报损坏并停止（derive.mjs:76-83 + cli.mjs:2442-2443）；缺 ID 多卡拒绝并列全部 ID/用途（cli.mjs:2461-2473）；已决 ID 幂等重放须匹配原选项、superseded 卡不可复用（cli.mjs:2445-2457）；有效但暂不满足条件的卡保留在列表（describePendingCards blockers，cli.mjs:2093-2143）；staleDecisions 单列、不可按旧 ID 执行肯定性选择（cli.mjs:2146-2152、1634、2035）；门禁同 ID 匹配（gate.mjs:237-250 accept 必须对应同 gateId 签发卡且未被 superseded）。实测 C1/C2 同时未决时投影同时呈现两卡。
9. **人工门新鲜度（B8/F5/F6）** ⚠ 基本落地、存在 F-2 例外 — 批准/签发必须晚于全部基线报告提交序（baselineCommitFloor + decisionSeqOf/issuedSeqOf，gate.mjs:13-48、254-275；cli.mjs:2493-2504）；常规 decide 也写 journal decided 事件（cli.mjs:2589）。**但 reviewFingerprint 的评审链"最新"选取存在 F-2 两条失真路径：纯新协议下退化 at 序（同 key 改判 + at 乱序时旧指纹被误判新鲜）；旧新协议混合下带 report-accepted 锚的旧报告恒被选中，新评审修订（正常时间序）不进指纹、旧批准不失效。**
10. **F-N2（§6.3 规则路径）** ✔ — resolveLeadGeneralRules 按三层合并解析 lead/README.md（rules.mjs:289-304），tw help 返回 leadGeneralRules 并声明"不依赖技能 Base directory 猜包根"（cli.mjs:4390-4417）。
11. **F-N3（§6.3 计划回执与 blocked）** ✔ — 同内容 plan 零写：changed:false、不写 re-planned、不重签卡（cli.mjs:3783-3794）；blocked 只由 blocked-resolved 事件解除且须 seq 晚于锚并匹配 dispatchKey/reportVersion（waves.mjs:259-268）；计划进 journal 单次提交（B11，cli.mjs:3795-3797、2390-2416）；包恢复卡绑定 blocked key/ver/计划摘要，锁内重核后原子提交（cli.mjs:3692-3764、2344-2418）。**实测：设计文档 §9 红例 2/3 在当前代码上断言通过（exit 0），行为已修正。**
12. **Ghost Wave 对账（§4.2 表）** ⚠ 与冻结正文存在**已定位的行为差异**（详见 §4 F-7）——框架性分支（reported 短路、live 已收本轮才 wait-children、冷会话 reminder/增量/全量、foreign/unknown/日志回退/正文冲突一律保留原 ID 不发不建、聚合 recover 不被健康项掩盖、wait-prior-turn 仅在宿主显式提供 turnActive+notificationReachable 时返回）与设计表一致（tw-dispatch.js:103-110、270、314-315、332、342-350、377-409；subagent-session.js 收单核验）。**差异点**：续派原会话 ID 在宿主 stat 未命中（none）时换用新 key 确定性 ID 重建（fresh_rebuilt）并投全量正文（tw-dispatch.js:317-326），以及该 key 自身 ID stat 未命中时直接 allowCreate 创建（tw-dispatch.js:411-420）——冻结方案 §4.2 表第 7 行要求"宿主**可靠确认**该 sessionId 活/冷均不存在"才补建、§4.3-3 明确"仅凭……stat 未命中……不可断言对方不存在……不自动换 ID"（设计文档 72、81 行）。该行为差异的授权来源与证据边界见 F-7。
13. **retire 与写者安全（§4.3-4）** ✔ — 先 key 锁字典序、后任务锁、锁内重核波集合（cli.mjs:3000-3008）；幂等矩阵（3010-3017）；作废回退有效基线并重建索引（3018-3022）；writerSafety 未证明停写时不派重叠写范围的新 Owner（tw-dispatch.js:304-306、cli.mjs:4108、4124）。
14. **旧任务兼容（§7）** ✔ — 旧报告无 files 回退 payload.paths × 快照索引（rebuildArtifacts store.mjs:395-397、baselineFiles intake.mjs:199-202）；旧快照 content 文本格式双向兼容（cli.mjs:2652、store.mjs:370）；protocol-migrated 事件叠加新算法 files 不改写报告（store.mjs:218-226）；journal 为空/半行/非事件一律 STATE_CORRUPT 不猜重建（store.mjs:43-52）；旧 key 不新增跨波拒绝守卫（intake.mjs:287 注释明确，行为与用户裁决一致）。

## 3. 专项审查

### 3.1 并发与锁

- 任务锁内读-算-写：deliver/review（intake.mjs:218-221、436-439）、decide（cli.mjs:2427）、refresh/recovery/plan/retire/archive 均在 withOwnerLock(task.lock) 内锁内重读。
- key 级投递锁：dispatchLockPath 摘要文件名（store.mjs:30-35），dsh 对账与 retire 共用；后到者拿锁后重读投影与映射、不复用旧计划快照（tw-dispatch.js:276-310，inspectPlan 只读 `run` 重验——注释明确避免 dispatch-plan 推进副作用）。
- 锁顺序：retire 先投递锁（字典序逐个）后任务锁（cli.mjs:3000-3005）；tw-dispatch 单 key 投递锁内宿主 I/O 不持任务锁。未发现反向嵌套。
- 并发测试实测通过（tests/runtime-v3-concurrency.test.mjs 含 retire×run、迁移×交付并发收敛）。
- 遗留观察：dsh 侧锁路径用 resolveChildCwd(exec) 解析项目根（tw-dispatch.js:234、276），与 tw CLI 的 projectRoot 解析在"会话工作目录即项目根"前提下一致；若宿主会话在项目子目录打开，两侧 projectRoot 可能不同导致锁互斥失效。属既有部署前提，本次未验证子目录场景，记为待确认。

### 3.2 日志（journal）异常中止

- 空内容/半行 JSON/非事件 → STATE_CORRUPT 保留原文件（store.mjs:43-52）；v2 任务初始化不完整 → TASK_INIT_INCOMPLETE 不猜测（store.mjs:129-141）。
- deliver 提交序列：快照（幂等、孤儿无害）→ journal 原子替换 → 视图；提交前崩溃无已生效事实，重启后以 journal 对账（intake.mjs:335-339 注释 + 实现）。
- report-committed 已提交而报告文件写前崩溃：freshState/projectReportsFromJournal 以事件流为准，重试基于已提交 ver 计算下一 ver、不重写同 ver（intake.mjs:71-73、322-326；R3-1）。
- seq 连续性：appendEventsUnlocked 与 appendReportEvent 均按 parseJournal(raw).length+1 生成（cli.mjs:210-211、intake.mjs:430），口径一致。
- 观察（见 F-5）：常规 decide 的 decisions.json（beforeAppend）先于 journal decided 事件写入，两写之间崩溃产生"视图有、事实无"窗口；后果是卡未收口需用户重新决定一次（decisions.json 留重复行），gate 由 B8 基线序兜底，无死门。刷新场景已按设计走"事实先于视图"（report-committed 进 journal 后才写视图，cli.mjs:2304-2321）。

### 3.3 归档/刷新原子性（轮次 2 补齐归档审查）

**刷新**：决定、Lead 来源报告、受影响旧门 superseded 为同一次 journal 原子替换（cli.mjs:2304-2310）；提交前任何核验失败（阶段/计划/授权/原报告/字节/在途评审）都不产生新基线（2176-2242）；提交后回执丢失经 decide 幂等重放原结果（2445-2457）；期间崩溃在快照写与 journal 写之间：孤儿快照无害（文件名即摘要、幂等）。

**归档 cmdArchive（cli.mjs:3358-3536，本轮补审）**：

- **路径与身份安全**：archiveRelativePath 拒绝逃逸/空段/../目录声明/null 字节（3359-3363）；归档父目录 realpath 后核验项目内（3366-3373）；暂存目录 mkdtemp 于真实父目录内且身份复核（3491-3494）；产物写入前 resolve 后再核不逃出 artifactRoot（3506-3508）；任务目录清理前身份复核（3529）。
- **归档前置校验（清理不可变快照前的完整性证明）**：artifactsDegraded 存在缺失项 → 拒绝归档（3478-3479）；assertArchiveBaselines 要求每个 (stage,package) 组内多候选报告都有**唯一可核实的 (reportId,ver)→journal seq 锚且锚序单调**（requireArchiveReportOrder 3376-3386，缺锚/重复/乱序 → ARCHIVE_ORDER_UNVERIFIED 拒绝发布）；基线报告 payload.paths 与产物索引双向一一对应（数量、reportRef、路径、digest/digestAlgorithm，3404-3426）；索引含无有效报告对应的路径拒绝（3426）。同路径跨阶段用 reportOrderComparator 选最新（latestArchiveArtifacts 3431-3452）。
- **发布序列（原子性核心）**：全部产物写入**本次独占的暂存目录**（mkdtemp），逐条要求摘要为 64hex、快照引用必须标准位置、readSnapshotBytes 验证快照自洽与摘要一致（3500-3505，复用 restore 同一核验函数）、路径冲突拒绝不覆盖（3510-3515）、**写入后重读字节比对**（3516-3518）；decisions/journal-summary/manifest 写入暂存后，以**同文件系统 rename 原子发布**（3525，暂存与目标同在 archive 父目录下）；published 后 syncDirectory 落盘、markTreeReadOnly、再清理原任务（3526-3530）；finally 中未发布则清除暂存（3532-3534）。
- **失败窗口与恢复**：发布（rename）前任何失败 → 暂存清除、原任务完整保留；发布后清理前崩溃 → 归档与任务并存，重跑时先验归档 manifest 完整性再检查任务在场 → ARCHIVE_INCOMPLETE 提示人工核对备份后移走旧归档重试（3457-3472、3482-3483），**不伪称幂等完成、不猜测删除**；任务清理部分完成后崩溃 → 归档 manifest 是完整凭据，taskExists 失败时幂等返回（3471）。markTreeReadOnly 失败（published 后、rm 前）同样落入"并存 → 人工恢复"路径，无死门。
- **测试佐证**：tests/runtime-v3-cli.test.mjs:2599-2628 注入发布前 rename 故障——断言原任务保留、无半成品归档、恢复后重试成功且字节一致；2630-2657 注入发布后故障——断言两边保留、重跑返回 ARCHIVE_INCOMPLETE 不伪称幂等完成。与上述代码审查结论一致。
- **归档边界遗留观察（F-8，低）**：manifest 的 reviews 摘要取 task.reports 全量（含 at 序排列的各 ver，3521），在 F-2 同源口径问题（at 乱序或旧新协议混合）下"最新评审"展示可能与 seq 序不同；仅影响归档摘要的可读性，不影响归档完整性判定（判定走 assertArchiveBaselines 的 seq 锚）。

### 3.4 普通 decide 既有边界

- 多卡缺 ID 拒绝、按 ID 定位、选项属于该卡、重放同 ID 同选项幂等、superseded/损坏账本拒绝肯定性选择（cli.mjs:2430-2459）——§6.2.2-2 落地；**但普通人工门 accept 分支缺前置卡守卫（F-11）：迁移冲突未决时仍能写入批准（cli.mjs:2485-2512 无 migrate 检查，与刷新 2189-2194/包恢复 2355-2358/展示层 2103-2108 口径不一致），违背 §6.2.2-4**。
- 意图卡指纹同钉、unresolved 拒绝确认、恢复候选计划的候选意图卡绑定（cli.mjs:2521-2551）；换模型卡三选项与配置同钉（2553-2564）。
- 人工门 accept 前实时核验脏盘拒绝、不写决定不作废卡片（2505-2512）——§6.2.2-3 的 C1/H1 语义。
- 升档审批历史卡不可答（2513-2516）。
- 常规决定保留 decisions.json 通道并新增 journal decided 事件双写（2589、2617-2625），loadTask 按 decisionId 去重合并（store.mjs:280-323）。

## 4. 发现清单

> 每条标注：新引入 / 既有 / 历史依赖；是否本轮阻塞（均否，但 F-9/F-2/F-10/F-11/F-7 建议评审链重点裁决与后续授权修复）；最小必要修正。

**F-2（升级 · 中 · 已确认缺陷（两组纯函数复现）· 本次修改引入）——评审新鲜度存在两条失真路径**
- 位置与根因：
  1. runtime-v3/gate.mjs:83（reviewChainFingerprint 的 seqOf 只收集 `e.type === "report-accepted"` 事件，且 Map 键为 **reportId、无 ver 维度**），而新协议 intake 只写 `report-committed`（intake.mjs:671）。两个后果：① 纯新任务中评审链指纹的 seq 第一全序恒失效，退化为 at 墙钟序 + ver 破平（gate.mjs:85-91，gate.mjs:78-79 注释宣称"以 journal seq 为第一全序"与实现不符）；② **旧新协议混合时，带 report-accepted 锚的旧报告 seq 恒大于新报告的 -1，pick 永远选中旧报告**——新协议评审（无论哪个 ver）完全进不了指纹（store.mjs:159-212 同时保留旧文件报告与新事件报告，设计 §7 的旧任务升级正是该形态）。
  2. "最新 challenger/expert"的波次与门禁消费点按 **at 排序数组尾项**选取：waves.mjs:318-319（nextWave lastOf）、gate.mjs:183、195（gateCheck .at(-1)）；数组序来自 store.mjs:295、300（loadTask 按 at 排序，且该比较器相等时返回 1、非严格弱序）。对照 deliverBaselines/reviewedPackages/归档排序已统一用 reportOrderComparator（seq 序）。
- **场景 A（轮次 2 复现 · 错误放行）**：纯新协议任务，同一 review key 先 v1=accept 提交（at 晚）、人工门签发并 accept 后，同 key 修订 v2=rework（registerReview 允许 payload 变化 → ver+1，intake.mjs:636-671），且 v2 的 at 因墙钟回拨早于 v1（或 at 交错使数组序与 seq 序相反）。实测：指纹与签发时完全相同、nextWave=gate、gateCheck passed=true 无 blocker——seq 序最新的 v2=rework 被完全绕过，人工门被误放行。对照组（v2 at 正常晚于 v1）：nextWave=respond 返工、gateCheck 拒绝——**该对照仅证明场景 A 的错误放行需要 at 乱序触发，不构成对 F-2 整体危害的排他性结论**（见场景 B）。
- **场景 B（轮次 3 复现 · 正常时间序下的漏失重确认；轮次 4 限定为"同角色**不同 reportId**"遮蔽场景）**：旧新协议混合（§7 旧任务升级形态）——旧协议遗留评审（report-accepted 有锚、reportId 不同）与新协议评审（report-committed 无锚）共存，新基线后新协议评审提交 v1=accept 并签发人工门、用户 accept，随后同 key 以**严格递增的时间与提交序**修订 v2（recommendation 保持 accept、内容与风险说明变化，payloadDigest 不同）。实测（时间与 seq 全程严格递增、无任何回拨）：reviewChainFingerprint 在 v2 前后**完全相同**（pick 恒选带旧锚的旧报告，fpAtIssue === fpAfter）、nextWave=gate、gateCheck passed=true 无 blocker——**v2 的内容修订未触发重新评审/重新确认，用户未基于修订后的风险说明重新批准，旧人工门批准持续有效**。此场景下既有保护均未生效：baselineCommitFloor 只锚 deliver 基线、在途检查无在途项、reviewedPackages 覆盖判定通过。既有期望对照：tests/runtime-v3-waves-regression.test.mjs:737-750（F6-2）在**纯旧协议**下明确期望"评审保持 accept 仅内容变化 → 指纹变化 → 旧卡作废重签、旧卡直答被拒"——混合形态下该保护失效。**限定（轮次 4 对照验证）**：遮蔽前提是旧、新评审具有**不同 reportId**（gate.mjs:83 以 reportId 为键建锚）；若 report-accepted 与 report-committed 复用同一 reportId，两版本共享同一锚、later 按 at 选新版本，指纹会随内容变化（实测 fp1≠fp2）——该形态不受场景 B 影响。
- 证据性质：两组均为纯函数复现（nextWave/gateCheck/reviewChainFingerprint/artifactFingerprints 真实导出函数 + 模拟 loadTask at 排序后的 reports 数组）；**均未复现真实 CLI/宿主全链**（报告文件落盘、loadTask 装载、dispatch-plan/decide 实际调用链），也未实测真实环境中 at 乱序或旧新混合任务的发生概率。场景 B 对应设计 §7"旧任务、升级和回退"明确支持的混合数据形态，不依赖时钟异常。
- 与需求的关系：场景 A 违反设计 §6.2"报告变化后须重新评审"（rework 评审被绕过）；场景 B 违反同条及 §7 旧任务转换后"评审链与人工门仍绑定完整报告身份……报告变化或作废后须按既有新鲜度规则重新评审/确认"。直接影响本包"设计一致性"完成标准的第 6/9 项判定（⚠）。
- 最小必要修正：reviewChainFingerprint 的 seqOf 同时收集 report-committed 并按 (reportId,ver) 建锚（与 waves.reportOrderComparator 同口径）；nextWave/gateCheck 的 challenger/expert 选取改用 reportOrderComparator；store 排序比较器相等时返回 0。（修源码不在本审查任务授权内，仅记录。）

**F-7（新增 · 中 · 实现与冻结设计正文的行为差异 + 授权证据未合入 · 差异为本次实现既有，裁决来源待核实）**
- 位置：dsh/tw-dispatch.js:317-326（续派原会话 ID 宿主 stat 未命中 → 换用新 key 确定性 ID 重建并发全量正文，priorAgentId 保留）、411-420（该 key 自身 ID stat 未命中 → allowCreate:true 直接创建）；stat 未命中映射为 status="none" 的来源 dsh/subagent-session.js:6-11（sessions.get 未命中 → coldSessionStatus → persistence.stat 未命中 → none）。
- 与冻结设计的差异：设计文档 §4.2 表第 7 行（72 行）要求"宿主**可靠确认**该 sessionId 活/冷均不存在"才"原 ID 登记不变，以该 ID 创建"；§4.3-3（81 行）明确"仅凭进程锁过期、**stat 未命中**或本地映射不可断言对方不存在……保留同一 ID 并返回 recover……**不自动换 ID**、删除会话或无证重投。只有在隔离宿主中证明该状态/日志对该场景足以排除迟到接收时，才将对应缺失情况用于自动恢复"。实现以 stat 未命中（当前观察）执行换 ID 重建与创建，**宽于冻结正文的保守要求**。
- 授权来源（按 Lead 轮次 2 指示记录）：该行为源自**实施期间用户在对话中对 dsh-binding 的明确裁决**（允许 state.status===none 时切换新 ID / fresh_rebuilt / 补建重试）；仓内佐证：tests/dsh-dispatch.test.mjs:2135 测试名即"**用户裁决下**当前不可见的创建可重试"，2146 行断言消息自述"模拟的不可见状态下允许重试**但不证明真实宿主无重复**"；1988-1998 明确断言 fresh_rebuilt 行为。**证据边界：该裁决尚未合入冻结设计文档（SHA 6668e09b 的 §4.2/§4.3-3 仍为保守措辞），裁决原文在实施期对话中、本包审查未直接核验其原文与适用范围——标为待核实**，需 Lead 提供可定位裁决证据或将裁决合入设计文档后重签基线。
- 遗留风险（如实标注）：stat 未命中不能排除旧调用迟到或仍在途 → 换 ID 重建/补建存在**重复投递**（旧会话稍后收到迟到的创建/正文）与**双会话并存**风险；mock 测试断言不构成真实宿主无迟到/无重复的证明（测试自述）。真实宿主验证属后续独立测试任务。
- 与需求的关系：不构成对冻结基线的"实现 bug"（有实施期用户裁决背书），但构成**设计文档与实现的一致性缺口**——在裁决合入冻结文档或提供可定位证据前，本包对 §4.2/§4.3 的"设计一致性"判定对该两分支记为**差异待裁决**而非通过。
- 最小必要修正（文档面）：将实施期裁决合入设计文档（更新 §4.2 表与 §4.3-3 措辞并重走批准），或由 Lead 附可定位裁决证据供评审链核对；实现面是否收敛回保守分支由用户/Lead 决定，不在本审查授权内。

**F-4（低 · 待确认风险 · 本次修改引入的新依赖面）**
- 位置：dsh/subagent-session.js:29-33（dispatchKeyFromPrompt 只解析 text 块首行）。
- 触发条件：宿主在派单正文 text 块前拼接引导文本（key 不在块首行）。
- 影响：该块收单漏判 → 冷会话被判定未收本轮而自动补投同一正文（重复投递，非漏投）；设计不承诺恰好一次，方向保守。
- 证据性质：代码结构推导；是否发生取决于宿主消息块实际形态，需真实/隔离宿主实测（后续独立测试任务）。

**F-1（低 · 非阻塞 · 本次修改引入）**
- 位置：runtime-v3/rules.mjs:299-301——来源标注用"与包内文本比较"推断，用户层与包内文本巧合相同时误标 "package"。仅 sources 展示标签误差，注入 text 内容一致。

**F-3（低 · 非阻塞 · 本次修改引入的性能注意）**
- 位置：runtime-v3/gate.mjs:15-28（baselineCommitFloor 双重线性扫描 O(基线数×journal 长度)），gate/decide 每次判定执行。功能正确。

**F-5（低 · 观察项 · 既有通道语义的延续，本次以 B11 注释显式化）**
- 位置：runtime-v3/cli.mjs:2617-2625（常规 decide：decisions.json 先写、journal decided 后写）。两写之间崩溃时卡未收口、decisions.json 留重复行、该批准被 B8 基线序判过期，用户重新 decide 即恢复，无死门。

**F-6（信息 · 验证方法说明）**
- 设计文档 §9 红例 1（Ghost Wave 模拟）在当前代码上需要真实任务目录（新增投递锁），裸 node 跑 ENOENT 属预期防护而非行为回归；其行为断言由 tests/dsh-dispatch.test.mjs 的 mock 夹具覆盖，真实宿主对账仍待独立测试任务。

**F-8（低 · 非阻塞 · 轮次 2 新增观察，与 F-2 同源）**
- 位置：cli.mjs:3521（归档 manifest 的 reviews 摘要按 task.reports 数组序取各字段）。at 乱序或旧新协议混合时归档摘要中"最新评审"的展示序可能与 seq 序不同；不影响归档完整性判定（判定走 requireArchiveReportOrder 的 seq 锚）。F-2 修复时顺带对齐即可。

**F-9（轮次 4 新增 · 高 · 已确认缺陷（纯函数三步复现）· 本次修改引入）——Expert 定点返工死循环在 review，被点名包的返工波永不派发**
- 位置：runtime-v3/waves.mjs:406-466。verdict=rework 分支（406-416）对 accepted 集合的处理：被点名包进 reworkP 后 `accepted.clear()` **清空全部**（含未被点名的包），未点名包既不在 accepted 也不在 reworkP；波选择顺序上 awaitingReview（449 行）先于 reworkTodo（463 行）——未点名包恒落入 review 波。
- 触发条件：core 场景多包任务，challenger 组合评审 accept 覆盖全部包后，expert 提交 recommendation=accept、verdict.outcome=rework 且 must-fix scope 仅点名部分包（§5 定点返工的合法形态，intake.mjs:592-593 强制要求显式 scope）。
- 已有保护为何不足：reviewedPackages 快照与 seq 新鲜度只保证评审覆盖判定正确，不区分 expert 已定点返工的包；verdictFresh 只锚 deliver 基线（被点名包未修复重交，基线不变，旧 verdict 恒新鲜）；每次 challenger 重新 accept 后旧 verdict 被重复消费，再次清空 accepted。
- 影响（纯函数三步复现，nextWave 真实导出函数）：两包 A/B 交付并 challenger accept、expert verdict=rework 仅点名 A 后——nextWave#1 返回 review（评 B）；B 评审 accept 提交后 nextWave#2 仍返回 review；再评再 accept 后 nextWave#3 仍返回 review。**A 的 respond 返工波在三次推进中从未出现**：B 的 accept 使 A/B 同时进 accepted（intake.mjs:658 的 reviewedPackages 记录全部基线包），旧 expert 裁决再次清空 accepted 把 B 挪回 awaitingReview，循环往复；被点名包 A 无法进入修复流程，任务在 review 波内不收敛。违反设计 §5 返工范围语义与 waves.mjs:412 注释自述目标（verdict 未点名的包不因其他包返工被误重派）——实际效果是未点名包被误重派 review、被点名包被饿死。
- 证据性质：纯函数复现；未验证真实 CLI 全链中轮次上限、converge-user 是否打断循环——即使被轮次上限打断，结果也是误触用户卡而非定点返工收敛。
- 最小必要修正（按 Expert 建议方向记录，不实施）：verdict=rework 分支保持未点名包的 accepted 状态（只把被点名包从 accepted 挪入 reworkP），使定点返工消费后 respond 波先于对未点名包的重复 review；或 awaitingReview 判定排除已被最新 expert verdict 定点返工覆盖的包。修源码不在本审查授权内。

**F-10（轮次 4 新增 · 中 · 已确认缺陷（合成任务目录 + 真实 loadTask 复现）· 本次修改引入）——包模型回滚的 re-planned 事件缺 items，journal 投影回读仍是回滚前模型**
- 位置：runtime-v3/cli.mjs:2596-2601（cmdDecide 的 rollback-model 包级分支）：写入的 re-planned 事件 detail 只含 packages（ID 列表）、source、package、modelRef、decisionId，**不含 items（完整计划数组）**；而 B11 计划事实投影（runtime-v3/store.mjs:270-278）只认 Array.isArray(e.detail?.items) 的计划事件。
- 触发条件：包级换模型确认卡用户选择回滚（rollback-model）后，packages.json 视图缺失或损坏（崩溃、外部删除），loadTask/freshState 走 journal 投影重建计划。
- 已有保护为何不足：回滚的模型变更只落 packages.json 视图（cli.mjs:2620 beforeAppend 写入）与无 items 的事件；journal 中最后一次**带 items** 的计划事件仍是换模型时的事实。
- 影响（复现）：合成任务目录 journal 含 packages-planned(items, model=M0) → re-planned(items, model=M1 换模型) → re-planned(**无 items**，cli.mjs:2601 形状回滚到 M0) + decided，删除 packages.json 后用真实 loadTask 读取——投影结果 a.model=M1（回滚目标 M0），**回滚丢失，日志重读到新模型**。违反 B11 完整计划是 journal 一次提交的事实、packages.json 是可重建视图的约定（§6.3 与设计文档 189 行）。
- 证据性质：合成内存文件替身 + 真实 loadTask 入口；未在真实 CLI 会话中触发 packages.json 损坏。
- 最小必要修正（按 Expert 建议方向记录，不实施）：回滚分支的 re-planned 事件携带回滚后的完整 items，且与 decided 同一 journal 提交、其后才更新 packages.json 视图（当前 beforeAppend 先写视图）。

**F-11（轮次 4 新增 · 中 · 已确认缺陷（合成任务目录 + 真实 tw 入口复现）· 本次修改引入）——普通人工门批准入口缺少前置卡守卫，迁移冲突未决时仍能写入 accept**
- 位置：runtime-v3/cli.mjs:2485-2512（cmdDecide 普通卡分支：指纹、基线序、accept 实时核验，但**无未决 migrate/意图前置卡检查**）；对照：刷新卡确认分支有（2189-2194）、包恢复卡确认分支有（2355-2358）、只读展示层对 human-gate 也列 PREREQUISITE blocker（2103-2108）。
- 触发条件：迁移冲突卡（decision-issued 带 migrate 字段）未决的同时，按人工门卡的实际 decisionId 调 tw decide --choice 1（accept）。
- 已有保护为何不足：deriveTask 在 migrate 未决时静止（不推进阶段，derive.mjs migrate 分支），但静止只阻止过门、不阻止决定写入；写入口与展示口径不一致（展示标 blocker、执行不复查）。
- 影响（复现）：合成任务目录 journal 含未决迁移卡 mig-1 与人工门卡 hg-1，真实 tw(['decide',...,'--decision-id','hg-1']) 返回 ok=true，decisions.json 与 journal 均写入 hg-1 的 accept、mig-1 仍 open——**迁移冲突未决期间人工批准被记录**；迁移卡事后处理时该 accept 已在场，若指纹/基线序检查通过则直接过门，用户在任务事实不确定期间做出的批准被消费。违反设计 §6.2.2-4 未解决迁移冲突时其他肯定性决定（含人工批准）应显示 blockedBy 并拒绝执行的要求。
- 证据性质：合成内存文件替身 + 真实 tw/cmdDecide 入口；未验证真实宿主全链。
- 最小必要修正（按 Expert 建议方向记录，不实施）：普通批准分支在锁内与刷新共用前置卡核验（未决 migrate/意图卡在场时拒绝肯定性选择并列出 blockedBy），保持与展示层同口径。

### 范围外发现（记录备查，不在本轮处理）

- tests/support/v3-fixtures.mjs 与各测试文件的断言质量属 tests-and-integration 包职责（Challenger 第 4 条意见指向该包）。
- skills/team-work-v3/SKILL.md 的 F-N2 文案半边未在本包核验（skills-and-docs 包）。

## 5. 验证记录（本会话实际运行）

| 验证 | 结果 |
| --- | --- |
| 设计文档 SHA-256 | 与派单一致（6668e09b…b8b，轮次 1 实测） |
| 红例 2（同内容重拆不解除 blocked） | 断言通过（exit 0） |
| 红例 3（只改 B 不解除 A blocked） | 断言通过（exit 0） |
| 多卡投影（C1/C2 同时呈现）+ 派单首行 key 解析三变体/非首行不误判 | 断言通过（exit 0） |
| **F-2 场景 A 复现（轮次 2 · 错误放行）**：同 key v1=accept(at 晚)→人工门签发+accept→v2=rework(at 回拨早)；真实导出函数 nextWave/gateCheck/reviewChainFingerprint/artifactFingerprints + 模拟 loadTask at 排序数组 | **指纹不变（fpAtIssue===fpAfter）、nextWave=gate、gateCheck passed=true、blockers=[]**（exit 0） |
| F-2 场景 A 对照组（v2 at 正常晚于 v1） | nextWave=respond（返工）、gateCheck 拒绝（"非作者评审未接受当前交付"）——仅证明场景 A 的错误放行需 at 乱序触发，**不构成 F-2 整体危害的排他性结论** |
| **F-2 场景 B 复现（轮次 3 · 正常时间序漏失重确认）**：旧 report-accepted 锚评审 + 新 report-committed 评审共存；v1=accept→人工门签发+accept→同 key v2=accept 内容变化（payloadDigest 不同）；**时间与 seq 全程严格递增** | **指纹不变（fpAtIssue===fpAfter）、nextWave=gate、gateCheck passed=true、blockers=[]**——pick 恒选带旧锚的旧报告，新评审修订不触发重确认（exit 0） |
| F-2 场景 B 既有期望对照（只读核对 tests/runtime-v3-waves-regression.test.mjs:737-750，F6-2） | 纯旧协议下"评审保持 accept 仅内容变化→旧卡作废重签、旧卡直答被拒"——混合形态下该保护失效 |
| **F-9 定点返工死循环复现（轮次 4）**：A/B 两包 challenger accept + expert verdict=rework 仅点名 A；B 两次重新 accept 之间共三次调用 nextWave（真实导出函数） | 三次均返回 review（评 B）；A 的 respond 返工波从未出现——循环在 review、被点名包被饿死 |
| **F-10 回滚投影复现（轮次 4）**：合成任务目录 journal 含带 items 的 M0→M1 计划事件 + 无 items 的回滚事件（cli.mjs:2601 形状），删除 packages.json 后真实 loadTask 读取 | 投影结果 a.model=M1（回滚目标 M0）——回滚丢失，日志重读到新模型 |
| **F-11 普通批准写入复现（轮次 4）**：合成任务目录 journal 含未决迁移卡 mig-1 + 人工门卡 hg-1，真实 tw(['decide','--choice','1','--decision-id','hg-1']) | ok=true，decisions.json 与 journal 均写入 accept、mig-1 仍 open——迁移冲突未决期间人工批准被记录 |
| F-2 场景 B 同 reportId 对照（轮次 4）：report-accepted 与 report-committed 复用同一 reportId、at 严格递增 | fp1≠fp2 指纹变化（两版本共享锚按 at 选新版本）——场景 B 遮蔽前提限定为不同 reportId |
| node --test runtime-v3-core + waves-regression + invariants（轮次 1） | 78/78 通过 |
| node --test runtime-v3-concurrency + dsh-dispatch + dsh-subagent-session（轮次 1） | 120/120 通过 |
| node --test runtime-v3-intake + topology + cli（轮次 1） | 147/147 通过 |
| 归档故障注入断言核对（轮次 2，只读核对 tests/runtime-v3-cli.test.mjs:2599-2657） | 发布前故障保留原任务/无半成品/重试成功；发布后两边保留/ARCHIVE_INCOMPLETE 不伪称幂等——与补审结论一致 |
| 对账差异测试断言核对（轮次 2，只读核对 tests/dsh-dispatch.test.mjs:1988-1998、2135-2146） | fresh_rebuilt 换 ID 断言、"用户裁决下……可重试但不证明真实宿主无重复"断言——F-7 证据 |

**未运行的验证**：全套仓库测试其余文件（repository-contract/e2e-b-matrix/tag-hints/rules 等——属 tests-and-integration 包验证面）；F-2 的真实 CLI 全链复现（报告文件落盘 + loadTask 装载后走 cmdDecide/run，本轮为纯函数层证据）；真实宿主收单日志、live/cold 语义、stat 迟到/重复投递实测（派单明确排除，属后续独立测试任务）。

## 6. 结论

对照已批准设计基线，本包范围（runtime-v3/、policy/、dsh/ 共 13 文件）的实施在强类型协议、每包完整清单、字节摘要与实时核验主链、Lead 受控刷新原子提交、多卡按 ID 决定（写入口存在 F-11 例外）、F-N2/F-N3 修复、retire/归档的锁序与原子发布上与方案一致并有测试与行为验证支撑；**五项需要在评审链呈现的实质缺口（均已独立复现）**：F-9（高）Expert 定点返工死循环在 review——verdict=rework 清空全部 accepted 且 review 先于 respond，被点名包的返工波永不派发（纯函数三步复现）；F-2（中）评审新鲜度两条失真路径——场景 A（纯新协议 + at 乱序：rework 被绕过、人工门误放行）与场景 B（旧新混合 + 严格递增时序 + 同角色不同 reportId：新评审修订后指纹不变、旧批准不失效；同 reportId 形态已对照排除）；F-10（中）包模型回滚事件缺 items，journal 投影回读仍是回滚前模型；F-11（中）普通人工门批准缺前置卡守卫，迁移冲突未决时仍写入 accept（真实 tw 入口复现）；F-7（中）派发对账 stat 未命中换 ID 重建/补建宽于冻结设计 §4.2/§4.3-3，依据实施期用户裁决（仓内测试名佐证）但裁决未合入冻结文档、原文待 Lead 核对。F-9/F-10/F-11/F-2 的证据分别为纯函数或真实入口的内存复现，均未跑真实宿主或全套；归档链（cmdArchive）补审确认无死门。其余低风险观察项（F-1/F-3/F-4/F-5/F-8）不阻塞本轮。
