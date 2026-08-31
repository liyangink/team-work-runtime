# 波身份与恢复方案 · logic 视角审查（逻辑推演：状态/数据/控制流）

> 任务 wave-plan-review / 阶段 code-review / 包 logic / 视角：逻辑推演（正常与失败路径的状态、数据与控制流）。
> 审查对象：docs/wave-identity-recovery-plan.md（138 行）。证据：docs/v2-e2e-findings.md V3-E2E 段（32-122 行）、runtime-v3 波次机实现（waves/derive/gate/intake/cli，共 1657 行，全部逐行核读）、docs/team-work-runtime-model.md、AGENTS.md。
> 方法：把方案每个修复项的声明逐步映射到现状代码行，沿现场三条故障路径与迁移路径逐步推演状态/数据/控制流，找出推演断裂处。每条 finding 均带位置、归因、触发条件、影响、证据行号与最小修复。
> 修订记录（第 2 轮，响应 Challenger rework）：L-10 的 at 精度由"秒级"更正为"毫秒级"（toISOString 含毫秒，结论"以 journal seq/ver 为第一全序"不变，并补充 store.mjs:102 比较器在 at 相等时返回 1 的事实）；L-03 推演一补充未结决定分支不比对指纹的现状证据（gate.mjs:107-113、cli.mjs:552-555）。其余 finding 维持原判。
> 修订记录（第 3 轮，响应 Expert 裁决）：L-05 撤销"快照时点断言错误"推演——现场事实为 w22 评审在三条 round=3 重复交付之后接受（reviewedPackages=[plan@3]），方案 84 行成立；同步注明迁移后推进方向为裁决新鲜度失效触发的 Expert 重裁。其余 finding 维持原判。

## 1. 结论

方案对三个故障的根因归因（绕过守卫/身份挂派发/轮次双算法）与台账 71-77 行根因链一致，建模方向（波补身份、轮次唯一算法、身份倒序回溯）正确。但把声明落到代码时存在 **6 条 blocker 级推演断裂**（数据通路断裂 2 条、控制流断裂 2 条、状态推演矛盾 2 条）与 7 条 risk。当前形态不可直接批准；按第 3 节修订后可收敛。

## 2. 发现（按严重度排序）

### 2.1 Blocker

**L-01（F2）waveId 数据通路断裂：投影的去重键进不了 waves.mjs，且"按 waveId 去重"对 max(round) 冗余**
- 位置：方案 40-41 行 vs waves.mjs:38（nextWave 签名）、cli.mjs:392-404（dispatchedDetail）、intake.mjs:146/222（报告构造）、intake.mjs:158/226（report-accepted）。
- 推演：F2 声称"每包 max（交付报告 round 字段，按 waveId 去重）"。nextWave 是纯函数、输入只有 scenePolicy/reports/extraRounds/packages，waveId 唯一可能入口是报告文件字段；但现状四个事实源均无 waveId：dispatchedDetail 返回 key/kind/role/round/package/continuation/scope/writable/modelHint（无 waveId）、deliver/review 报告构造只抄 round（146/222）、report-accepted 两处 detail 形状还不一致（158 含 paths、226 含 recommendation）。方案只写"报告补 waveId（runtime 从派发事件抄写）"，未把写侧（dispatchedDetail）与两处抄写点、两处事件写点列全。
- 且 F9（83 行）给同轮重复 respond 赋**不同** waveId（package 相同各自成波），此时"按 waveId 去重"不去重任何东西，投影结果完全由 max(round) 决定——去重子句冗余且把 waveId 错误耦进轮次算法，误导实施者以为 waveId 是轮次修复的必要成分。
- 触发：迁移前旧报告 waveId 恒缺失；或实施者按字面给 waves.mjs 加 waveId 去重后发现旧数据全量退化。
- 影响：轮次投影在旧任务上无法按声明计算，V3-E2E-03 的"轮次分叉"修复依赖未闭环的数据链。
- 最小修复：方案显式声明完整抄写链（dispatchedDetail 写侧 → intake 抄入报告 → nextWave 读取）与缺失回退（无 waveId 退化为纯 max(round)）；F2 表述删去"按 waveId 去重"或注明仅防御、非轮次决定因素。

**L-02（F2）轮次权威源自指：删掉计数口径后 respond/produce 的 round 无处产生，且遗漏第三处计数口径**
- 位置：方案 40-43 行 vs waves.mjs:52/168/178、derive.mjs:33-35。
- 推演：现状 round 的产生链是：waves.mjs:52 roundOf = 报告数 → 168/178 行 respond/produce 的 round = roundOf(id)+1 → dispatch.detail.round → intake.mjs:146 抄进报告 round 字段。F2 说"删除 waves.mjs 报告计数口径"、新投影"每包 max(交付报告 round 字段)"——但报告 round 字段本身来自派发事件的 round，而派发事件的 round 又由被删除的 roundOf+1 派生：删除后第 2 轮 respond/produce 的 round 由谁给值？权威源需要重定义为"该包已存在的最大 dispatch.round + 1"，方案未写。
- 另一处独立计数口径：derive.mjs:35 人工门 rework 分支的 round = 该包 owner 报告数 + 1，不在 F2"消费点全部换源（respond 轮次、review 轮次、轮次耗尽判定、依赖满足判定）"清单内——是三处计数口径中的第三处（waves.mjs:52、derive.mjs:35、其余），换源时必漏。
- 触发：实施 F2 删 roundOf 后推第二轮 respond；或人工门 rework 分支在重复报告存在时计算 round。
- 影响：投影轮无输入源或两处口径再次分叉，轮次上限与评审覆盖判定失真（验收 3/5 无法达成）。
- 最小修复：F2 明确定义新权威源（每包最大 dispatch.round 按派发事件推导，produce/respond 在其上 +1），并把 derive.mjs:35 列入消费点换源清单。

**L-03（F6）控制流两处断裂：decide 绑定指纹覆盖不了等待期改写；重出卡后二次 accept 死循环**
- 位置：方案 65-68 行 vs cli.mjs:584/591、gate.mjs:104-121、cli.mjs:542-556。
- 推演一（时序）：现场场景是"decision-issued 之后、用户 decide 之前 Expert 同 key 重交修订"（台账 94 行）。现状证据链：gate.mjs:107-113 对未结决定只返回"等待用户决定"blocker、不比对指纹；cli.mjs:552-555 对未决卡原样返回签发时的旧卡文本、不重算指纹；决定指纹在 cmdDecide 落盘时才计算（cli.mjs:584），此时读到的一定是最新报告——绑定值永远等于当前值。"决定指纹 vs 当前指纹"的比较只发生在已结决定分支（gate.mjs:114-121），等待期改写场景永远走不到该分支，"必然重新呈卡"不成立。要成立必须让 decision-issued 事件绑定**签发时**指纹，decide/gate 校验"签发指纹 vs 当前指纹"，不等则拒绝该次 decide 并重签。
- 推演二（死循环）：重出卡后用户二次 accept，decide 无条件 push 第二条 accept（cli.mjs:591），而 gate.mjs:105 用 decisions.find(accept && gateId) 恒取**第一条** accept（旧指纹）→ 与当前指纹永远失配 → 每次都进"指纹过期"blocker → cli.mjs:545-551 又签新卡 → 用户 decide → 再 push → 再失配。人工门批准无死门可出，违反 AGENTS 规则 8/I5。
- 触发：人工门 accept 后制品/评审链再变（或等待期改写后走重签路径）。
- 影响：任务卡死在 awaiting-user；F6 声称的修复效果（现场同款场景必然重新呈卡）在机制上不成立。
- 最小修复：① decision-issued 增绑签发时 artifactFingerprint+reviewFingerprint，decide 校验不等即拒绝（DECISION_STALE 指引取新卡）；② gate 的 decided 改取该 gateId 最新一条（.at(-1)）或按当前 issued decisionId 匹配；③ 补"二次 accept 后推进通过"闭环测试。

**L-04（F5）返工判定用结果论指纹替代因果锚点：旧 key 真变内容 → 进评审但轮次不前进，且与台账门槛 6 冲突**
- 位置：方案 58-60/107 行 vs 台账 52/62/121 行、derive.mjs:27-28/33-35。
- 推演：台账 V3-E2E-04 建议处置要求"人工返工派单写入 causeDecisionId（或稳定 waveRef），只有绑定该决定的派单报告才能完成本次返工"；方案改为"当前制品指纹 ≠ 决定的 artifactFingerprint 才算返工已执行"。取决定前旧 key 改内容重交：制品指纹变 → 方案判"返工已执行"→ 直接进评审——这正是台账复现 4（62 行）要拦截的冒充场景，而方案 107 行把"不同内容 → 正常进评审"称为"复现 4 的修复形态"，与台账 121 行门槛 6"决定前 dispatch 的迟到或同 key 修订报告不能完成决定后的 rework"字面冲突。
- 叠加的轮次错位：该旧 key 交付的 report.round 是旧轮（derive.mjs:33-35 的 round 只由报告数推、与 key 是否绑定决定无关），进评审但轮次不前进——"评审-轮次错位"状态，reviewedPackages 覆盖判定与轮次上限都建立在错位的 round 上。
- 触发：人工门 rework 后成员沿用决定前旧 key 修改并重交。
- 影响：冒充未被识别、因果链断裂，V3-E2E-04 声称修复实际保留原行为。
- 最小修复：返工完成判定改因果锚点（派发事件写 causeDecisionId/waveRef，derive 判定"存在绑定该决定的派发且其报告已交付"）；制品指纹只作评审链兜底；若坚持结果论，方案必须明示与台账建议处置的偏离并交用户裁决，不得静默替换。

**L-05（F9）迁移状态推演两处断裂：跨阶段误并；归档任务无事实可迁**
- 位置：方案 82-86 行 vs cli.mjs:692-695。
- 推演一（跨阶段）：F9 合并规则按"连续 dispatched 段内同 (kind,role,round) 且 package 互异"并波，段内无 stage 边界（dispatched 事件 detail 不含 stage）。相邻阶段同 (kind,role,round) 的派发若落同一连续段（如上一阶段 produce round1 未交付、advance 后新阶段 produce round1），会被误并为一波——与 F4"不跨阶段串线"原则未对齐。
- 推演二（归档）：cmdArchive 删除任务目录、journal-summary 白名单（cli.mjs:692-695）不含 dispatched，方案 85 行"归档任务重开时再迁移"没有任何派发事实可迁，且 CLI 无"重开"命令（见 3 节待确认）。
- [第 3 轮修订] 撤销第 1/2 轮"快照时点断言错误"推演：Expert 裁决核验现场 journal 确认——三条同轮重复 respond（round=3）交付**之后** challenger review w22 才被接受（reviewedPackages=[plan@3]），快照值本就是 3；迁移后投影轮=3，waves.mjs:74-80 判定 3<=3 覆盖成立，方案 84 行"快照 plan@3 覆盖成立"与现场证据逐项吻合、无需条件化。我此前"快照=2、迁移后需再派一次 review"的推演基于 w22 早于重复交付的过时时序假设，予以撤销；迁移后推进方向是核心场景裁决新鲜度失效（expert 裁决早于 round3 交付）触发的 Expert 重裁，而非死循环 review。
- 触发：既有任务迁移（跨阶段误并）/归档重开。
- 影响：迁移后 waveId 错并、投影判定失真；归档路径的迁移承诺不可执行。
- 最小修复：迁移分组加"最近 stage-advanced 之后"的当前阶段限定；归档任务明确"只读终态不迁移"或先补归档恢复机制。

**L-06（F3/验收）已落盘重复报告的收敛边缺失：retire 只作废未结波，不同 digest 的重复报告没有出口**
- 位置：台账 87/119 行 vs 方案 49/81-85 行、waves.mjs:58-59、gate.mjs:38-45。
- 推演：现场"重复 key 各交付一次以清空在途"会留下同轮多份 Owner 报告。台账验收门槛 4 要求"零报告/一个报告/同 digest 多报告/不同 digest 多报告四类均有确定、可审计、无删除的恢复结果"，其中"不同 digest 多报告出用户选择卡、其余作废"（台账 87 行）。方案的 retire 只允许作废**未结波**；已结波的多份重复报告仍全量参与推导——waves.mjs:58-59 的 lastOf 按 at 取最后一份、gate.mjs:38-45 对**全部** owner 报告聚合 checks（任何一份旧报告的 fail check 会永久阻塞门禁）。不同 digest 的重复报告没有任何收敛/选择机制，方案 §5 也没有对应测试。
- 触发：既有任务存在同轮重复 key 且交付内容不同；或 Lead 想清理已结的重复波。
- 影响：恢复边不完整（台账根因链 5 正是"恢复边不完整"）；门禁可能被历史重复报告的 fail 检查永久卡死。
- 最小修复：增补"已落盘重复报告的选择收敛"机制（digest 相同机械取一、不同出用户选择卡 + dispatch-superseded 作废其余）；gate 消费侧明确只取每包/每角色最新逻辑交付；§5 增补四类恢复与 retire 非法流转测试矩阵。

### 2.2 Risk

**L-07（F1）幂等键不精确且"拆两批"前提不存在**：round 是标量（waves.mjs:156/169 取 max），选择性 rework 下同波各包轮次可异构，标量无法唯一刻画"该派什么"；"属性相同"未定义包集比较口径（未交付子集 vs 全包集，部分交付时已交付包应剔除）；迁移后同属性多未结波并存时守卫匹配哪一个未定义；"同轮超并发上限拆两批 = 同 round 两个 waveId"（方案 36 行）在现状无任何拆批实现（runTransition 一次写全批，waves.mjs:171-180 一次产出全部 owners），属未来功能，应删除或标注前提；waveId 分配时机未定（derive 是纯函数不做 I/O，分配只能在 runTransition 锁内，需与"判定与写入同锁"复核原则对齐）。修复：幂等键 = 逐包 package→round map + 未交付包集合，或按"尾部最近未结波 waveId + 未交付派发集合"查重；补部分交付与多未结波推演用例。

**L-08（F3/F4）作废语义与身份回溯的状态污染**：① dispatch-superseded 事件插入 journal 会打断"尾部连续 dispatched"扫描（derive.mjs:71-73、intake.mjs:80-83、cli.mjs:189-191、cli.mjs:766-771 四处同构——方案 F3 只列三处，漏 cmdPlan 重拆守卫），作废后前方另一批在途可能被漏判为已清空而误开新波；② retire 后成员仍持旧 key 交付，intake 的 findDispatch 不过滤 superseded，作废波报告仍可落盘污染投影——intake 对作废 key 的拒绝/审计语义未定义；③ F4 倒序回溯不过滤 superseded 波内的 key，且 fresh 重开的新 key 无 mappings 登记时回溯会穿透到被替换的旧成员（台账 77 行 fresh 场景），解析到已失效会话。修复：批次重建跳过簿记事件或按 waveId 连续；intake 拒绝作废 key 并给恢复指引；回溯跳过 superseded、fresh/replace 登记新 incarnation。

**L-09（F7×F2）版本链与存储形态的交互断裂**：同 key 不同 payload 现状是单文件覆盖写（intake.mjs:130-134/145/150/202-205/221-223），"报告身份 = key+ver"实际只存最新一份，旧 ver 全文丢失（方案 74 行自承全文留档后置），F6 的 reviewFingerprint 只能看到最新版；若 ver 以多文件落盘，waves.mjs:46-52 的 delivers 聚合会把同 key 的 ver1/ver2 各计一次，重新点燃计数口径分叉（F2 刚删除的病根）；幂等判定（131/203 行）用原始 JSON.stringify，paths/checks/findings 数组顺序是成员可控输入，同语义不同序 → ver 虚增。修复：存储形态二选一（文件名含 ver，或单文件覆盖+内嵌不可变 revisions 数组）；waves 聚合按 (package, dispatchKey) 取最大 ver 唯一化；幂等判定改 canonical 归一（排序后 digestValue，与 F5/F6 指纹同源）。

**L-10（F6）reviewFingerprint 双处独立计算与"最新"全序未定义**：指纹需在 cmdDecide 落盘（cli.mjs:584）与 gate 判定（gate.mjs:114）两处分别计算，方案只对 reviewedPackages 声明"写入处与判定处同源"（43 行），对 reviewFingerprint 无同等声明——两处"最新 Challenger/Expert"口径若不一致，绑定值与校验值分叉，重出卡误触发/漏触发（与 V3-E2E-03 同构）；且"最新"缺乏可靠全序：reports 按 at 升序（store.mjs:102，其比较器在 at 相等时返回 1 而非 0，同 at 的先后由引擎排序行为决定、不可依赖），at 为 ISO 毫秒精度（intake.mjs:137/207 的 toISOString() 含毫秒），同毫秒并发写入或同 key 不同 ver 同 at 时"最新"仍不确定。修复：reviewFingerprint 由同一导出纯函数供两处共用，"最新"以 journal seq/ver 为第一全序、at 次级破平。

**L-11（F5 边界）指纹判定的三个边界未定义**：① 旧决定回退口径——decide 写当前阶段制品指纹（cli.mjs:577/584），gate.mjs:106 却有"current 为空回退全量 items"的分叉，F5 声称"回退既有 fingerprint 字段"但未定义口径对齐；② 多包复合指纹粒度——respond 波带全部活跃包（derive.mjs:33-37），无关包的制品变化也会改变复合指纹、误判"返工已执行"（建议按包指纹，或随 L-04 一并改因果锚点）；③ 空制品阶段/纯回应派单（intake.mjs:120-122 允许）的指纹恒等语义未定义。

**L-12（接口）waveId 对 Lead 不可寻址**：waveId 只进 journal（方案 36 行），而 dispatch-plan 的 waves[]（cli.mjs:856-877）、wait-inflight 卡、helpCard（944-968）与用法提示（1005）均无 waveId/retire——Lead 执行 tw retire --wave wvN 无从知道 wvN，被迫读 journal，违反台账根因链 5 与 AGENTS 规则 18。修复：waves[] 与在途卡增补 waveId；helpCard/roadmap/编排参考同步。

**L-13（F7 兼容）模型基线错位**：模型基线 68 行声明"报告一经登记就不再改写"，F7 的同 key 覆盖写（带 ver）与之一致性存疑；基线 116 行把"成员独立槽位"列为建模方向，方案以 F4 倒序回溯为过渡形态——两处均需在批准时同步修订或标注，避免"报告不可变"与"槽位终局"的既有表述误导后续实现。

### 2.3 Info

- [info] F8"全任务递增序号"与现状 key 序号基准（cli.mjs:432/442/483 用 task.journal.length+1，同批多包同序号）口径不一致，需统一并明确同批是否互异；journal.length+1 在并发锁内正确，但"全任务递增"需要独立计数器。
- [info] 归档 journal-summary 白名单（cli.mjs:693）不含 dispatched/superseded——若按 L-05 采纳"归档不迁移"，归档摘要不保留过程事实可接受，需在方案明示。
- [info] 方案 116-119 行实施顺序第 5 步依赖现场一次性状态（"在途 w24 评审"），建议改为通用表述，避免文档时效性漂移。
- [info] F6"自动重出卡"应澄清为"下次 run/推进时检测签发指纹过期驱动"，不违反规则 6 awaiting-user 静止。

## 3. 待确认（unresolved）与验证建议

1. "归档任务重开"的操作形态：CLI 无 unarchive/reopen 命令、归档目录只读（cmdArchive markTreeReadOnly）。请确认"重开"是已规划能力还是笔误；若不存在，方案 85 行应改为"归档任务只读终态，无需迁移"。
2. 无 gateId 的 rework 决定是否真实存在：cmdDecide 的人工门卡 choices 仅 accept/rework（cli.mjs:549），converge-user 卡无 rework 选项，理论上 rework 必带 gateId；请核验既有任务 decisions.json 是否有反例，决定 F5 回退链（L-11①）是否需要覆盖无指纹决定。
3. F6 指纹绑定时机（decision-issued vs decide）以 L-03 修订为准，实施前与方案作者对齐。
4. F5 多包复合指纹粒度取舍（L-11②）：若随 L-04 改因果锚点则自然消解；若保留指纹判定，需明示按包指纹还是复合指纹及冒充风险接受度。

## 4. 现场断言核验实录（方案对现状的描述准确性）

- derive.mjs:30-45 人工门 rework 分支提前 return dispatch、跳过 67-77 在途守卫 ✅（V3-E2E-01 根因属实）；
- derive.mjs:27-28 deliveredAfter 用 r.at > decision.at 时间戳比较 ✅（V3-E2E-04 根因属实）；
- waves.mjs:52 roundOf = 交付报告计数、intake.mjs:213-220 reviewedPackages 取 max(report.round) ✅（V3-E2E-03 双口径分叉属实）；
- cli.mjs:851-855 prevKeyOf 只取紧邻上一派发 key、不查映射 ✅（V3-E2E-02 根因属实）；
- tests/runtime-v3-topology.test.mjs:319-344 测试名声称 expectedAgentId 但正文无该断言 ✅；invariants:150-162 只测人工门首派 respond 未再推进 ✅；tag-agent-auto-register.test.mjs:22-32 固化 pendingTags 覆盖最新 key ✅。
- 结论：方案对现状与台账的描述诚实、无虚构；缺陷集中在"新机制的实现细节与数据通路"，而非事实陈述。