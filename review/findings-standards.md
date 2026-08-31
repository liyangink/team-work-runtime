# docs/wave-identity-recovery-plan.md 交叉评审汇总（standards 包）

- 任务：wave-plan-review ｜ 阶段：code-review ｜ 包：standards ｜ 角色：owner ｜ 轮次：2
- 审查对象：docs/wave-identity-recovery-plan.md（波身份与恢复方案，138 行）
- 证据事实：docs/v2-e2e-findings.md（V3-E2E-01~04 台账段）、docs/team-work-runtime-model.md（模型基线）、docs/runtime-v3-charter.md（P1–P6 / I1–I10）、runtime-v3/waves.mjs / derive.mjs / gate.mjs / intake.mjs / cli.mjs / store.mjs、workflow/definitions/engineering.json、team-work/policies/default.json、tests/ 相关套件、dsh/inject.js、docs/dsh-directed-delegation-plan.md。
- 方法：八个视角（需求与变更摘要 / 缺陷与安全 / 错误处理 / 逻辑推演 / 测试覆盖 / 类型与不变量 / 规范与合规 / 影响范围）以只读子派单形式并行独立审查（互不知晓，防从众）；owner 对全部 blocker 级证据行号逐一对照源码复核后汇总去重归因。本文件是八视角组合的证据骨架与解冲突输入（2.1 骨架供 summary 包做解冲突终稿）；standards 包视角发现以来源标注登记，不重复登记为独立视角包产物，不与 summary 终稿竞争口径。未读取 .team-work 内部状态。
- 严重级别：blocker=不修订会导致方案目标落空或引入新死门/数据损坏；risk=实施时踩坑或验收口径冲突；info=措辞/一致性小问题。

## 一、八视角结论一览

| 视角 | 结论 | 主要发现 |
| --- | --- | --- |
| 需求与变更摘要（P1） | 需修订 | F5 因果链未根除冒充；F9 缺"不同 digest 出用户选择卡"；轮次投影源措辞摇摆 |
| 缺陷与安全（P2） | 需修订 | 指纹公式三处不一致；F6 等待期窗口失效；intake 不拒作废 key |
| 错误处理（P3） | 需修订 | 迁移幂等/半迁移未定义；旧决定回退未定义；retire 部分交付处置未定义 |
| 逻辑推演（P4） | 需修订 | F1 幂等属性集合缺显式 stage/cause；F2 消费点清单遗漏 derive.mjs:35 独立计数 |
| 测试覆盖（P5） | 需修订 | retire 零测试；台账门槛 4"四类 digest 恢复"未覆盖；tag 测试修正遗漏 |
| 类型与不变量（P6） | 需修订 | F9 改写历史违背 I4/只增不改；F7 版本身份与单文件落盘不自洽；计数器来源未定义 |
| 规范与合规（P7） | 需修订 | CLI 即接口未声明（retire/迁移命令）；file-inventory/Roadmap/台账状态同步义务缺失 |
| 影响范围（P8） | 需修订 | 部署窗口期过渡契约未定义；archive 丢失 superseded 事实；agents.json 键空间迁移面未声明 |

八视角全部判定"需修订"；同时八视角对方案**根因定位、建模方向、台账引用行号的准确性**一致认可（见第四节无异议确认）。收敛结论：方案主体可批准，**批准附带 8 项 blocker 修订**（见第三节）。

## 二、汇总 findings（去重归因）

### 2.1 blocker（必须修订，共 8 项）

**B1｜F6"等待期修订必然重出卡"在机制上不可达**〔来源：P2、P4；owner 已复核〕
- 位置：方案:65-68（F6）、:108（§5 第 5 条）；对照 gate.mjs:104-121、cli.mjs:528-556
- 归因：reviewFingerprint 按方案:66"决定绑定"= 在 cmdDecide 落盘时才算；而台账记载的现场是"decision-issued 已签发、用户尚未 decide"期间 Expert 同 key 重交修订。此时 gate.mjs:107 if(!decided) 分支只回"等待用户决定"、:114 指纹过期检查仅在 accept 决定存在时触发；cli.mjs:542-544 按未决 decision-issued 原样返回旧卡文本（:555 直接取 issued.detail.choices），不重算指纹。
- 触发条件：人工门卡已签发、等待用户答复期间，Challenger/Expert 用同 key 修订报告（台账 P1-4 明确"现场曾出现"）。
- 影响：用户看到的仍是修订前的旧评审结论文本，决定却作用于新评审链——正是方案:68 宣称要消除的现象，目标落空。
- 证据：gate.mjs:107/:114、cli.mjs:542-556、方案:66/:68；台账 v2-e2e-findings.md:94（P1-4）、:111（相邻场景表"人工等待时 Expert 改写同 key verdict"）。
- 最小修复：decision-issued 事件 detail 在**签发时**落盘双指纹快照（artifactFingerprint + reviewFingerprint，含决定时路径集合）；await-decision 分支呈现卡前重算评审链指纹，与签发时不等则作废旧 decisionId 并重签新卡；§5 补"决定前 Expert 同 key 修订 → 旧卡失效并重出"用例。

**B2｜F9 迁移改写历史 journal/reports，违背"只增不改"与"报告不可变"，且迁移幂等/半迁移未定义**〔来源：P3、P6（主源）、P2（侧面提及）；owner 已复核〕
- 位置：方案:22（波=派发事件上的字段）、:81-85（F9）、:91/:94（§4）、:98（"全部只增不删"）；对照 charter:143/:148、kernel.mjs:12-14
- 归因：waveId 定位为"只做派发事件上的字段、不设独立事件"，因此给既有 dispatched 事件补 waveId 只能改写历史 journal 行；charter:148 明定 journal"只增不改"、:143 reports"一次写入不可变"。方案:98 自述"全部只增不删"与 F9 直接矛盾。同时迁移无完成标记、无幂等声明、无原子写声明，中断/重跑会重复或错乱赋号。
- 触发条件：对既有活动任务执行 F9 迁移（方案 §6 第 3 步）时改写历史 dispatched.detail 与报告文件；迁移进程中途崩溃或重复执行。
- 影响：破坏审计序列完整性与 I4"目录即状态纯投影"的前提；半迁移状态无识别手段，轮次投影与幂等守卫随即失准。
- 证据：charter:143/:148；方案:22/:83/:91/:94/:98。
- 最小修复：改为只增式迁移——新增事件（如 wave-assigned {waveId, dispatchKeys[], at}）承载历史派发→waveId 映射，运行时投影读取，不改写原 dispatched 事件与报告文件；迁移带完成标记、幂等（已迁移直接返回）、与派发同锁原子写、崩溃重跑等价。若坚持改写历史，须在方案中如实声明该例外并给出重放/幂等/归档一致性策略（当前均缺失）。

**B3｜F5 制品指纹判据未根除"旧派单冒充新返工"，且 blocked 回应路径形成无限重派**〔来源：P1；owner 复核补充 blocked 回应死循环论证〕
- 位置：方案:56-61（F5）；对照 derive.mjs:27-28、intake.mjs:130-134
- 归因：台账 P1-2（v2-e2e-findings.md:92）与验收门槛 6（:122）要求显式因果链（decisionId→waveRef→dispatchKey→reportId）：决定前派单的迟到/修订报告不得完成决定后的 rework。方案以"当前制品指纹 ≠ 决定的 artifactFingerprint"作完成判据，仍是间接代理：决定前旧 key 重交**内容真变**（例如恰好按返工要求改了）→ 指纹不同 → 放行进评审，冒充只从"同内容"收窄到"变内容"，未根除。另外（owner 复核补充）：respond 波成员以 outcome=blocked 回应（合法路径，intake.mjs:120-122 仅对 delivered 强制 paths）→ 制品指纹不变 → 恒判"未交付" → 无限重派 respond，形成 I5 死循环（对比：现状 deliveredAfter 按 at 比较会把 blocked 报告算作已回应，该死循环是 F5 指纹化新引入的）。
- 触发条件：决定前旧 key 重交不同内容；或 respond 波成员 blocked 回应返工要求。
- 影响：验收门槛 6 未满足；blocked 回应无进展语义（死循环）。
- 证据：derive.mjs:28 时间序判据；方案:59-60；台账 :53/:92/:110/:122。
- 最小修复：返工完成判定改显式因果引用为第一判据（rework 决定绑定 causeDecisionId/waveRef，只认绑定该决定的派发所产生的 reportId），制品指纹作辅助校验；显式定义三态（决定后无新交付→派 respond；有交付且指纹同→冒充重派；有交付且指纹异→进评审）并定义 blocked 报告的进展语义（转用户/Lead 决策，不无限重派）；§5 补"决定前旧 key 重交不同内容不得完成本次返工"验收。

**B4｜F7"报告身份 = key+ver"与单文件落盘、"全文留档后置"三者不自洽**〔来源：P2、P5、P6、P7；owner 已复核〕
- 位置：方案:70-74（F7）、:78（F8 文件名）、:130（后置项）；对照 intake.mjs:145/:150/:202、charter:143
- 归因：F7 声明"同 key 不同 payload → ver+1，报告身份 = key+ver"，但落盘仍是单文件 deliver-<key>.json（intake.mjs:145）且同 key 覆盖（:150）；全文版本留档被列后置。于是 ver N+1 没有正文载体，仅 journal payloadDigest 有迹可查，"报告身份=key+ver"无对应实体。同时 payload 等价判定（现状 JSON.stringify 全等，intake.mjs:131/:203）与 payloadDigest 算法（应为 digestValue=sha256(canonicalJson)，kernel.mjs:12-13）未声明同源，键序差异会误增 ver，进而使 F6 评审链指纹误变。
- 触发条件：同 key 修订交付（台账现场形态）；重交时 JSON 键序/归一化差异。
- 影响：版本链"有迹可查"（方案:74）不成立；ver 语义（修订计数 vs 内容指纹）模糊，与 F6 联动时可能误触发人工门失效重出卡。
- 证据：intake.mjs:130-134/:145/:202-205；charter:143；方案:70-74/:78/:130。
- 最小修复：二选一并写死——(a) ver 为"同 key 修订计数"，正文单文件覆盖，历史正文靠 snapshots/digest 索引，"报告身份 = key"（改方案:73 措辞）；(b) 多文件 deliver-<key>.v<ver>.json 并把全文留档移出后置项。无论哪种，幂等判定改为"同 key 同 payloadDigest"，payloadDigest = digestValue(归一化 payload)，使 ver 递增与指纹同源。

**B5｜多 digest 重复报告的收敛动作缺失（台账验收门槛 4 未落实）**〔来源：P1、P3、P5；owner 已复核〕
- 位置：方案:81-85（F9）、:49（F3 retire）、:110（§5 第 7 条）；对照台账 :87（P0-5）、:120（门槛 4）
- 归因：台账 P0-5/门槛 4 要求重复 key 的"零报告、一个报告、同 digest 多报告、不同 digest 多报告"四类均有"确定、可审计、无删除"的恢复结果，其中"不同 digest 多报告"必须出用户选择卡保留版本、其余作废。方案 F9 只做编波号+投影去重，retire 只允许作废未结波且未定义已交付子集的处置；§5 第 7 条只测结构合并。
- 触发条件：既有任务同轮存在 digest 互异的重复交付报告；或多包波部分交付后 retire。
- 影响：门槛 4 未满足；"哪份报告代表真实产物"无人裁决，评审快照覆盖可能落到错误版本；作废波已交付报告在轮次投影中的处置（计入/排除）未定义，投影轮可能虚增或漏计。
- 证据：台账 :52/:87/:120；方案 :49/:82-85/:110。
- 最小修复：F9/retire 补四类恢复规则（同 digest 机械合并；不同 digest 出用户选择卡、其余记 dispatch-superseded，或显式列为"迁移后待 Lead 裁决"产出）；retire 明确"仅解除未交付派发在途、已交付报告保留为审计事实"及其投影规则；§5 第 7 条按四类用例扩写。

**B6｜retire 全链路缺口：零验收、intake 不拒绝被作废 key、I5 拒绝形状未定义**〔来源：P2、P3、P5、P7；owner 已复核〕
- 位置：方案:49（F3）；对照 intake.mjs:27-29/:97-104/:170-177、cli.mjs:103-117、方案 §5:100-111
- 归因：F3 只在"批次守卫"层过滤被作废波，intake 的 findDispatch（intake.mjs:27-29）仅按 key 匹配、deliver/review 入口不检查 dispatch-superseded；§5 八条验收无一条覆盖 retire；fixHint 无 retire 错误码；执行权限未定义。
- 触发条件：retire 后成员用旧 key 调 deliver/review；retire 已结波/未知 waveId/缺 reason 等非法路径。
- 影响：被作废波可继续交卷落盘 report-accepted，作废形同虚设、影子事实重新进入推导；非法调用拒绝无针对修复指引（I5）。
- 证据：intake.mjs:27-29/:101/:174；cli.mjs:103-117；方案:49 与 §5 全节。
- 最小修复：intake 校验同步过滤 superseded（拒绝附"该波已作废，改交新 respond 波"指引）；§5 补 retire 合法/非法/部分交付/并发四类用例；fixHint 补 retire 错误码；声明仅 Lead 可执行。

**B7｜部署窗口期（F1–F8 落地与 F9 迁移之间）旧 journal 无 waveId 的过渡契约未定义**〔来源：P8；owner 已复核〕
- 位置：方案:113-119（§6 实施顺序）、:81-85（F9）；对照 derive.mjs:71-77（现状按 d.key 判在途）
- 归因：§6 步骤 5 计划"迁移后继续当前方案评审任务（Challenger 完成在途 w24 评审 → 推进）"，但未定义迁移与在途派单交割的先后边界，也未定义 derive 的 waveId 在途守卫对"迁移前已派发、无 waveId"的 dispatched 事件的判读规则；F9 合并规则（:83）未覆盖"含在途未交付派发的连续段"。
- 触发条件：代码部署后、迁移执行前，任何 run/dispatch-plan 作用于带在途派发的既有任务（当前活动任务即有在途评审波）。
- 影响：旧在途派单可能被误判为新波而重复派发（回归 V3-E2E-01），或迁移分波规则对在途段产出错误 waveId。
- 证据：derive.mjs:71-77；方案:35/:81-83/:119。
- 最小修复：§6/F9 明确过渡契约：迁移前先让在途派单交割（或迁移工具内对未结波做 wait-inflight 兜底）；显式规定"无 waveId 的 dispatched 事件在迁移后 derive 的兼容判读（视为单波/按 key 兜底）"；把"迁移前后状态等价"列为验收。

**B8｜CLI 即接口义务未声明：retire/迁移命令未声明进 tw help，迁移命令无 CLI 形态**〔来源：P7；owner 已复核〕
- 位置：方案:49（retire）、:83（"迁移工具"）；对照 cli.mjs:947-963（helpCard）、:978-1005（命令分发表）
- 归因：AGENTS 规则 9"CLI 的 --help 与拒绝输出即完整 meta，不存在第二层 schema"；方案引入两条新命令但全文未声明登记 helpCard/分发表与拒绝带 fix；F9 的"迁移工具"连命令名与参数面都没有。
- 触发条件：实施者按方案实施，新命令对模型不可见或形态自拟。
- 影响：新能力 Lead/成员无法通过 tw help 发现；迁移命令作为核心修复项的载体规格缺失。
- 证据：cli.mjs:947-963/:978-1005；方案:49/:83。
- 最小修复：F3/F9 各补一句：retire 与迁移命令登记 helpCard 与 switch 分发表、拒绝沿用 fail()/fixHint 附恢复指引；给出迁移命令的 CLI 形态（命令名、参数面、幂等返回形状）。

### 2.2 risk（建议随实施一并修订，共 18 项）

**R1｜F1 幂等属性集合未显式声明 stage 与 causeRef**〔来源：P4；owner 复核后由 blocker 降级〕
- 位置：方案:35。归因：台账 P0-2 建议 waveRef 属性 = stage+kind+role+round+package 集合+causeRef；方案只写"kind/role/round/包集"。
- 触发条件/影响：owner 复核——方案:35"journal **尾部**未结波"的尾部限定 + 波串行性（同一时刻至多一个未结波；第二次 rework 决定出现时第一次 respond 波必已结）使当前属性集合在现有拓扑下完备，跨阶段吞派发/二次返工误判均不可达；但不显式声明则实施者自行补属性时可能不一致，且与台账建议留有表面偏差。
- 最小修复：F1 显式写出完整属性集合（含 stage、causeRef=rework 决定 decisionId），作为与台账对齐的防御性声明。

**R2｜"同轮超并发上限拆两批"的阈值来源与拆批判定未定义**〔来源：P2；owner 已复核〕
- 位置：方案:36。证据：team-work/policies/default.json:8 已有 concurrencySoftLimit: 4，但 runtime-v3 全库无消费者（grep 零命中）；方案未说明拆批阈值从哪读、"批已满"如何判定、拆批后如何抑制继续拆第三批。
- 影响：实施时凭空新增并发口径（重蹈 roundOf 双算法覆辙）；每轮推进可能不断拆新批。
- 最小修复：F1 声明"拆分阈值 = policy.concurrencySoftLimit"并定义消费点；定义"未派包已含于未结波内则不再拆批"的推导规则并补验收。

**R3｜§4 删除清单只点名 waves.mjs，derive.mjs:33-37 人工门分支的独立计数口径未显式列入**〔来源：P4、P6；owner 复核后由 blocker 降级〕
- 位置：方案:96（§4"删除"行）、:42（F2 消费点清单）；对照 derive.mjs:35。
- 归因：F2:42"消费点全部换源（respond 轮次…）"在语义上覆盖该分支，但 §4 只写"删除 waves.mjs 报告计数口径"，实施者可能漏改 derive.mjs:35（stageReports.filter(...).length + 1）。
- 影响：若漏改，人工门 rework 恰是 V3-E2E-01/03 触发场景，同类轮次分叉在返工轮复发。
- 最小修复：§4 删除清单显式加入"derive.mjs 人工门 rework 分支的独立计数"，注明同样改读统一投影函数。

**R4｜旧决定的 reviewFingerprint 回退语义未定义**〔来源：P3、P6、P8；owner 已复核〕
- 位置：方案:61（仅 F5 声明回退）、:95（§4"旧决定回退兼容"）；对照 gate.mjs:114、cli.mjs:584。
- 归因：既有全部决定均无 reviewFingerprint；方案未声明缺该字段时 F6 的评审链比对是"降级为仅制品绑定（现状语义）"还是"视为失效重出卡"。
- 影响：存量任务上 F6 目标场景（等待期修订）继续漏判，或旧决定被反复判过期形成新死门。
- 最小修复：补一句：旧决定缺 reviewFingerprint 时降级为仅制品指纹比对（与现状一致），新决定启用双指纹。

**R5｜轮次投影源的措辞摇摆 + "按 waveId 去重"表述失真**〔来源：P1、P4；owner 已复核〕
- 位置：方案:24（§2 表）vs :40（F2）。
- 归因：§2:24 写"每包取关联过的 produce/respond 波的最大**派发 round**"，F2:40 写"每包 max（**交付报告 round** 字段）"，两个投影源不同；且"按 waveId 去重"在 max 投影中无实际去重效果（同波同包至多一条派发；迁移后同包重复派发各自成波、waveId 互异），真正的去重由 max 天然完成。
- 影响：实施者取错字段则轮次分叉未根治；措辞误导验收口径。
- 最小修复：统一为"每包 max(已交付报告的 round 字段)"（台账 P0-4 口径），报告 round 由 runtime 从派发抄写（P4）；把"按 waveId 去重"改为"同波多派发对同一包不产生多条交付事实"的准确表述。

**R6｜waveId 与 dispatchKey 两个独立递增序的计数器来源与接续未定义**〔来源：P1、P4、P6；owner 已复核〕
- 位置：方案:34（wv1/wv2…）、:78（d<全任务递增序号>）、:83（按序赋 wv1…wvN）；对照 cli.mjs:432/:442/:483（现状序号 = task.journal.length + 1，非派发计数）。
- 归因：两个"全任务递增序号"均未说明持久来源；迁移赋到 wvN 后新波从 wvN+1 起的接续规则未写；现状序号随 journal 条目数变化（report-accepted 等事件也计入）。
- 影响：并发/迁移后可能撞号，破坏 waveId 唯一性前提；I4 纯投影要求序号可从 journal 重算。
- 最小修复：写明两个计数器均以 journal 内 dispatched 事件数为源、迁移后从 max(wvN)/max(dN) 续，并断言"新派发 waveId 严格大于已赋最大值"。

**R7｜tag-agent-auto-register 测试固化的 pending key 覆盖缺陷未列入 §5 修正，pendingTags 生命周期错位残险未显式声明接受**〔来源：P1、P5；owner 已复核〕
- 位置：方案:111（§5 第 8 条）；对照 tests/tag-agent-auto-register.test.mjs:22-32、台账 :69/:51。
- 归因：台账点名四处测试缺口，§5 第 8 条只点名 topology；tag-agent-auto-register:22-32 固化"续派覆盖最新 key"且未验证 send_message 不触发新 key 回填，未列入。方案把 memberSlot 移入后置（:131），但"fresh 降级时 pendingTags 回填错误 Owner"的过渡期残险未作为显式决策点呈现。
- 影响：身份链修复只锁 cli.mjs prevKeyOf 半边，tag 层生命周期错位在 fresh 降级场景仍可能漂移。
- 最小修复：§5 第 8 条补 tag 测试修正（send_message 续派不触发回填、pendingTags 不覆盖为最新重复 key）；方案中显式声明"memberSlot 本次不做、F4 为过渡形态、fresh 回填残险为已知残险"的取舍。

**R8｜台账相邻场景的关键失败路径未转为必测项**〔来源：P5；owner 已复核〕
- 位置：方案:104-105（§5 第 1/2 条）；对照台账 :106（崩溃重放不扩大波次）、:108（replace-owner 后取最新 incarnation）、:102-113。
- 归因：§5 只测并发幂等与三角色三次续派，未含"重启重放原 key/prompt 不扩大波次""replace-owner 后旧 incarnation 只留审计"。
- 影响：F1 幂等与 F4 回溯的高危边界无断言背书。
- 最小修复：§5 补这两条必测项（含"派发落 journal 后进程崩溃、平台未建成员"的重放用例）。

**R9｜F8 前缀 w→d 的 agents.json 键空间迁移面未声明**〔来源：P8；owner 已复核〕
- 位置：方案:77-79；对照 cli.mjs:42（pendingTags[tag]=key）、:802（mappings[key]=agent）、dsh/inject.js:97-101。
- 归因：dispatchKey 是 agents.json 的一等键；F8 只提"报告文件名跟随、既有 w 文件不动"，未提既有任务的 mappings/pendingTags 键如何迁移或混存处理。
- 影响：同 tag 键空间内 w/d 键混存，prevKeyOf 回溯与 mappings 键对不上时 expectedAgentId 回退 missing（回归 V3-E2E-02 断链）。
- 最小修复：F8/F9 补"旧 w 键保留只读、新 key 用 d 前缀、回溯按 key 精匹配"或"迁移工具一并改写 agents.json 键"；补跨版本混存断言。

**R10｜archive 的 journal-summary 过滤清单不含 dispatch-superseded，作废事实归档后丢失**〔来源：P8；owner 已复核〕
- 位置：方案:49/:85；对照 cli.mjs:692-694（过滤白名单）、charter §5.2。
- 归因：journal-summary 只保留 task-opened/stage-advanced/gate-passed/decision-issued/decided/task-completed/report-rejected，不含新事件；方案:85"归档只读、重开再迁移"与 charter §5.2"重开=新任务引用归档名"存在张力——归档目录无完整 dispatched 事实，重开无法"再迁移"。
- 影响：归档重开重算投影时作废事实不可重建，口径漂移且不可审计。
- 最小修复：明确 journal-summary 是否保留 dispatch-superseded（建议保留），或改写:85 措辞——归档任务重开以迁移时刻状态为准、不再迁移。

**R11｜§9"不改变定向委派方案结论"未点破与二阶段清理的交叉**〔来源：P8；owner 已复核〕
- 位置：方案:136-138；对照 docs/dsh-directed-delegation-plan.md（二阶段删除 persistTagHints/modelHints 落盘）、cli.mjs:29-50/:796-805。
- 归因：F8 改 key 前缀会改变 persistTagHints 写入的 pendingTags 值，落在定向委派二阶段"停止写 tagHints/pendingTags/modelHints"的写端交集上，§9 未说明依赖顺序。
- 影响：两方案实施顺序衔接时测试/写端清理可能假设 w 前缀，产生不一致。
- 最小修复：§9 增一句：F8 的 key 变更落在 persistTagHints 写端与定向委派二阶段清理的交集上，明确"清理代码无需再兼容 w"。

**R12｜规约与文档同步义务未列入实施范围**〔来源：P6、P7；owner 复核后 P6-1 由 blocker 降级（charter 与实现已有多处漂移、非强制 gate）〕
- 位置：方案:89-98（§4）；对照 charter:143/:148（报告结构、journal 类型枚举与实现已漂移：实现含 dispatchKey/round/package/kind/stage，charter 写 wave/sessionRef）、charter:229（DoD#6）、docs/file-inventory.json、台账 :145（跟踪规则 2）。
- 归因：方案新增事件类型（dispatch-superseded）、报告字段（waveId/ver）、决定字段（双指纹）均未声明同步 charter §5.1；file-inventory.json（若新增 migrate 模块）、runtime-roadmap.md 里程碑、台账 V3-E2E-01~04 状态行（"已定位、待修复"→"已修复"+回归证据）均未列入实施范围。
- 影响：验收规约与实现第三处漂移；新能力无规约锚点；进度与台账不可追溯。
- 最小修复：§6/§7 增补同步义务清单：charter §5.1（journal 类型集合、report-accepted detail 字段清单、reports 结构以实际实现为基线统一 waveId 命名）、file-inventory、Roadmap 里程碑、台账状态行与回归证据列；§5 补测规模对照 charter §7 预算声明（新增测试属"修复真实缺陷"豁免）。

**R13｜派发双写（dispatched 事件 + agents.json pendingTags）的崩溃窗口未纳入幂等守卫**〔来源：P3；owner 已复核〕
- 位置：方案:46-49；对照 cli.mjs:479-480/:487-488（先 appendEventsUnlocked 后 persistTagHints，后者降级 warn 不阻塞，:44-48）。
- 归因：两写非事务；介于其间崩溃则 journal 有 dispatched 而 pendingTags 缺失，插件按标签寻址回退 childId 补读，F4 依赖的最近映射可能缺失。
- 影响：重建/补派路径可能重复创建成员或断链。
- 最小修复：声明幂等守卫重建以 journal（权威）为准、agents.json 缺失由重放路径回填而非重派；补对应崩溃恢复用例。

**R14｜裁决新鲜度时间戳与投影轮并存残险**〔来源：P3；owner 已复核〕
- 位置：方案:134（后置项 5）；对照 waves.mjs:95-96（verdictFresh 时间戳比较）。
- 归因：方案已如实记录"本次不动"，但 F2 后轮次与覆盖同源、裁决新鲜度仍是时间戳，同形双宇宙风险保留在真实 E2E 中。
- 影响：已知技术债，不构成本次 blocker。
- 最小修复：§8 措辞把"裁决新鲜度同源化"标注为已知残险并在 §5 加一条回归提示（至少保证单包场景投影轮与时间戳不冲突）。

**R15｜F5 指纹判定在多包下的粒度未定义**〔来源：P4；owner 已复核〕
- 位置：方案:56-61；对照 gate.mjs:8-10（artifactsFingerprint 全阶段制品）、cli.mjs:577（仅按 stage 过滤不按 package）。
- 归因：多包任务 rework 常只涉及部分包；全阶段指纹使"任一包制品变 = 全部包返工已执行"。
- 影响：未返工包直接进评审，破坏"冒充被识破"精度（评审链兜底可缓解）。
- 最小修复：F5 指纹按包粒度计算（每包制品子集），或在方案中显式声明"多包下按包判定"的投影定义；若保持全阶段口径，写明为已知精度折损。

**R16｜实施顺序把"迁移活动任务"置于全量回归之前 + §6 引用环境特定信息**〔来源：P1；owner 已复核〕
- 位置：方案:115-119。
- 归因：迁移在回归全量（步骤 4）之前执行（步骤 3），迁移工具缺陷无回归兜底即作用于真实活动任务；:119"w24"是环境特定事实，违反文档脱敏约定。
- 影响：实施顺序风险 + 信息口径问题，不改变批准结论。
- 最小修复：迁移工具先在临时目录/副本经自动回归（含台账复现）验证，再作用于活动任务；:119 改为"当前在途评审波"泛化表述。

**R17｜拟议字段以"对齐结论/定案"口吻陈述，无"拟议/伪代码"标注**〔来源：P7；owner 已复核〕
- 位置：方案:17-28（§2）、:89-98（§4）。
- 归因：AGENTS 规则 17 要求拟议内容明确标为伪代码或建议；方案以"建模定案（对齐结论）""数据结构变化汇总"定案口吻陈述 waveId/dispatch-superseded/双指纹等拟议字段。
- 影响：降低批准基线的可审查性，易被误读为已定接口。
- 最小修复：§2 表头或 §4 加一句"以下字段名/事件名为拟议，实施以测试验形状"。

**R18｜台账验收门槛 7（真实 DSH 人工门 rework 复验）未在方案 §5/§6 落点，跨包统一定级为 risk**〔跨包统一定级：原 requirements F-1=blocker / test-coverage F-C03=risk / standards 2.4-7=待确认三档并存；按"台账七条验收门槛之一、方案 §5/§6 无显式落点、§6 仅部分承接"统一为 risk，summary 终裁〕
- 位置：方案:100-111（§5）、:113-119（§6）；对照台账 v2-e2e-findings.md:123（验收门槛 7）
- 归因：台账验收门槛 7 要求"高风险状态恢复完成后再做一次真实 DSH 人工门 rework 复验"；方案 §5 八条验收无对应条目、§6 实施顺序无该步骤——该门槛属真实链路复验而非自动化用例，但不落点则修复验收链条不完整。
- 触发条件：实施完成收尾时直接按 §6 顺序结束，跳过真实 DSH 复验。
- 影响：V3-E2E 系列修复只被自动化回归背书，人工门 rework 真实链路（含 DSH 编排层交互）未经复验，与台账跟踪规则"高风险状态机/门禁问题还要在下一次真实 E2E 中复验"（:145）不符。
- 证据：台账 :123、:145；方案:100-119。
- 最小修复：§6 实施顺序补一步"真实 DSH 人工门 rework 复验"（置于回归全量之后、任务收尾之前），§5 或 §6 注明该门槛为真实复验步骤、非自动化用例。

### 2.3 info（措辞与一致性，共 6 项）

- **I1**〔P1〕方案:48"currentStageOf 两处重复"措辞失实：实际是 intake.mjs:230 的函数 + derive.mjs:16 的内联表达式（"当前阶段推导两处重复"）。修正措辞即可。
- **I2**〔P1〕方案:78"3字节hex"易误读（应为"随机 3 字节 → 6 个 hex 字符"）；d 前缀与 wv 前缀仍靠人工区分，应声明两序列各自独立递增。
- **I3**〔P8〕docs/dsh-phase1-plan.md:20 硬编码 "dispatchKey": "w4-0ab813" 示例在 F8 后过时（该文档已标注仅供追溯，可后置处理）。
- **I4**〔owner〕F4 回溯边界只写"遇 stage-advanced 停止"（方案:53），未提 re-planned/packages-planned 重拆边界（cli.mjs:774）；重拆后同名包语义变化，建议回溯同样在该类事件处停止。
- **I5**〔P6〕方案:84"投影轮=3"与 :106"投影轮不虚增"表面冲突：真实语义是"三条 round=3 重复 respond 去重后投影轮仍=3（不虚增为 6）"，建议改文案以免误导验收断言。
- **I6**〔owner〕F9 迁移合并规则（:83）仅适用于新实现落地前的历史数据——新实现的"同轮超并发上限拆两批 = 同 round 两个 waveId"若两批连续落盘，按该规则会被误合并；应注明规则的适用边界。

### 2.4 待确认风险（无证据/需实施期定案，不阻塞批准）

1. **F5 决定时刻路径集合快照**：decide 目前只存 digest 字符串（cli.mjs:584）；若按 R15 改为按包指纹，决定时需同时落盘 path 集合而非仅 digest，否则制品被替换后无法回溯决定时快照（P2）。
2. **F2 报告 waveId 的落盘方式**：方案:41"runtime 从派发事件抄写"未说明是改报告文件还是读取时反查投影——前者触及"报告不可变"，后者无需改文件（P2）。
3. **F6 复合 digest 算法**：方案:65"reportId+ver+payload digest 的复合 digest"未指定算法，需与 kernel.mjs digestValue(canonicalJson) 对齐（P6）。
4. **拆批后的投影推演**：同 round 两个 waveId 时，"每包 max(report.round) 按 waveId 去重"对评审覆盖与轮次耗尽的相互作用未推演（P6）。
5. **F6 重出卡时 artifactFingerprint 的重快照时点**：重签新卡时重新计算当前制品指纹还是复用原决定指纹未定义；复用则制品在决定与重签间变化时可能永远无法批准（P3）。
6. **方案:84 的时序断言已被 Expert 终裁证实，本条目撤销（原采纳的 logic L-05 时序为过时视图）**：Expert 以现场 journal 证据链核验——三条同轮重复 respond（round=3）迁移后各自成波、已接受的 challenger review 其 reviewedPackages 快照即为 plan@3、waves.mjs 覆盖判定成立，L84 全句与现场事实吻合，无需条件化表述；logic L-05/coverage F-C06 依据的快照=2 系该 review 之前的过时视图。本审查按纪律不读取 .team-work 内部状态，未独立验证该现场证据；迁移验收仍应以实际数据机械断言投影值。

## 三、收敛结论：可批准的实施基线（附条件）

**结论：方案可批准。** 批准前提是以下 8 项 blocker 修订并入方案后形成实施基线；修订均为局部增补（新增事件/回退语义/验收用例/命令声明），不改变 §2 建模定案、F1–F9 骨架与 §6 实施顺序，修订完成后无需重启全量八视角审查，由 Challenger 核对修订落点即可。

批准条件（blocker 修订清单）：
1. **B1**：decision-issued 签发时落盘双指纹快照；await-decision 呈现前重算评审链指纹，不等则作废旧卡重签（补齐 F6 的等待期语义）。
2. **B2**：F9 改为只增式迁移（wave-assigned 映射事件）并声明完成标记/幂等/原子写；或显式声明改写例外并给出一致性策略。
3. **B3**：返工完成判定改显式因果引用（causeDecisionId/waveRef）为第一判据，指纹为辅助；定义三态与 blocked 回应进展语义；§5 补"决定前旧 key 重交不同内容不得完成返工"。
4. **B4**：F7 二选一定案（单文件覆盖+journal 版本链 或 多文件 v 后缀）；payloadDigest=digestValue(归一化 payload)，幂等判定按 payloadDigest。
5. **B5**：补台账门槛 4 四类恢复规则与用户选择卡（或显式"迁移后待 Lead 裁决"）；retire 已交付报告处置与投影规则。
6. **B6**：intake 拒绝被作废 key；§5 补 retire 用例；fixHint 补错误码；声明 Lead-only。
7. **B7**：定义部署窗口期过渡契约（在途交割边界 + 无 waveId 事件的下沉兼容判读 + "迁移前后状态等价"验收）。
8. **B8**：retire 与迁移命令登记 helpCard/分发表/拒绝指引，给出迁移命令 CLI 形态。

建议随实施采纳：R1–R18（18 项 risk，见 2.2），其中 R3/R4/R5/R6/R12 建议在方案修订时一并落笔；2.4 待确认 6 项在实施前定案（台账门槛 7 缺口已按跨包统一定级升入 R18）。

## 四、无异议确认（八视角一致认可、无需改动的部分）

1. **根因与代码行号引用准确**：derive.mjs:30-45 人工门分支提前返回绕过 :67-77 在途守卫（V3-E2E-01）；cli.mjs:851-855 prevKeyOf 只取紧邻 key（V3-E2E-02）；waves.mjs:52 报告计数口径 vs intake.mjs:213-220 快照 max-round 分叉（V3-E2E-03）；derive.mjs:27-28 时间戳判据（V3-E2E-04）——均与现状代码一致（owner 逐行复核）。
2. **台账点名的四处测试缺口属实**：runtime-v3-invariants.test.mjs:150-162 只测人工门首次调用、runtime-v3-dsh.test.mjs:297-303 未覆盖人工门分支、runtime-v3-topology.test.mjs:319-344 测试名与正文不符（无 expectedAgentId 断言）、tag-agent-auto-register.test.mjs:22-32 固化 pending key 覆盖（owner 逐处核验）。
3. **建模定案与模型基线一致**：§2 的波/派发/成员/轮次/决定/门禁定义与 docs/team-work-runtime-model.md 对齐；"轮次 = 打磨循环数、报告数可被重复提交污染"的口径正确。
4. **设计方向获认可**：F4 倒序回溯 + 遇 stage-advanced 停止（不跨阶段串线）、F7 轻量版本链、F3 在途守卫统一为导出纯函数、retire 只增事件、F9 无损迁移方向，与 I4/I5/P1/P4 一致。
5. **波及面判断**：F1/F4/F8 不触及 dsh/ 插件直接代码路径（inject.js 只读 agents.json，不消费 journal dispatched 事件）与 dsh-map.mjs；archive 主链不受 report +waveId/+ver 影响。
6. **合规**：方案文档无环境特定信息泄露，脱敏合规；F5/F6 强化指纹绑定方向与 AGENTS 规则 17 / charter I7 一致；F2 的 waveId 由 runtime 抄写、成员不填，符合 P4。

## 五、证据事实对照表（owner 复核记录）

| 方案断言 | 代码/文档事实 | 核验 |
| --- | --- | --- |
| F3"在途批次逻辑三处重复" | derive.mjs:70-77 / cli.mjs:186-198 inflightDispatches / intake.mjs:78-87 inflightHint | 属实 |
| F3"currentStageOf 两处重复" | intake.mjs:230 函数 + derive.mjs:16 内联表达式（非同名函数） | 措辞失实（I1） |
| F5"现 cmdDecide 已有 fingerprint 字段" | cli.mjs:577/:584（仅 gateId 决定绑定） | 属实 |
| F5 指纹公式"语义对齐" | gate.mjs:106 有 current.length?current:artifacts.items 兜底；cli.mjs:584 与 intake.mjs:210 无兜底 | 三处不一致（风险，见 B3 关联与 §2.4-1） |
| F2"消费点全部换源" | waves.mjs:52/:54/:137/:156/:168 + derive.mjs:35 独立计数 | derive.mjs:35 未显式列入（R3） |
| F9"全部只增不删" | charter:148 journal 只增不改；F9 补写历史 waveId 需改写既有行 | 自相矛盾（B2） |
| 台账四处测试缺口 | 对应测试行号逐一核验 | 属实 |
| concurrencySoftLimit 有消费 | default.json:8 存在；runtime-v3 全库无消费 | 无人消费（R2） |
| F6"重出卡机制现成" | cli.mjs:542-556 按未决 decision-issued 返回旧卡，指纹过期分支仅在 accept 决定后触发 | 机制不可达（B1） |
