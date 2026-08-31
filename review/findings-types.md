# 波身份与恢复方案 · 交叉评审视角 6：类型与不变量（包 types）

> 审查对象：docs/wave-identity-recovery-plan.md（下称「方案」，行号 L 引用）。
> 证据源（均已逐行读取核验）：docs/v2-e2e-findings.md 台账 V3-E2E 段；runtime-v3/{waves,derive,gate,intake,cli,store}.mjs；runtime-v3/domain/invariants.mjs；docs/team-work-runtime-model.md（模型基线）；docs/runtime-v3-charter.md（P1–P6 / I1–I10 / §5.1 文件契约）；workflow/definitions/engineering.json；team-work/policies/default.json；tests/runtime-v3-{invariants,dsh,topology}.test.mjs、tests/tag-agent-auto-register.test.mjs。
> 视角范围（八视角之 6）：边界、空值、序列化、状态机、跨层契约。测试计划、安全、成本等维度由对应视角包负责，本文件仅在「契约/不变量」意义上引用它们。

## 1. 视角结论摘要

方案的数据模型定案（waveId/唯一轮次投影/派发凭证与成员身份分离/决定双指纹/报告版本链）与模型基线（模型文档 L53-60、L116）和 charter 的 P1（目录即状态）、P4（模型只供语义）方向一致，台账 V3-E2E-01~04 的四条直接根因全部有对应修复项，引用的现状代码行号经核对与实现完全吻合（见 §5）。**本视角结论：有条件可批准**——T1、T2 是实施前必须消除的契约缺口（T2 本轮已吸收组合评审的「F6 等待期机制不可达」证据链，升级为双层缺陷：字面实施无法兑现 L68 目标场景 + 已决场景 find-first 死循环违反 I5），T3–T9 需在实施首轮把语义钉死并补契约测试，其余为措辞精度项。

## 2. Findings（blocker）

### T1 — F9 迁移的写入机制与「journal 只增不改」不变量冲突，waveId 回填方式未定义

- 严重级别：blocker
- 位置：方案 L83-85（F9「按序赋 wv1…wvN」）、L91-96（数据结构变化汇总只新增 dispatch-superseded 一种事件）、L98（「全部只增不删」）、L28（「权威状态统一在 journal」）
- 归因：类型/序列化契约缺口。方案声称「只增不删」，但 F9 把 waveId「赋」给既有 dispatched 事件，只有两条实现路径，均未被方案声明：①原地改写既有 journal 行——直接违反 charter §5.1「journal.jsonl 只增不改」与「报告/事件不可变」不变量，并破坏审计与潜在 digest；②追加新事件（如 `wave-assigned {dispatchKey, waveId}`）——则事件类型清单（L93）不完整，投影需新增 join 解析路径。
- 触发条件：对任何既有任务执行 F9 迁移工具（方案 L113-119 实施顺序第 3 步即触发）。
- 影响：journal 不可变不变量破窗（方案自身声称不引入平行权威，却可能改写唯一权威序列）；投影对「迁移前/迁移中/半迁移」三类 journal 无确定行为，跨版本恢复与重放不可审计。
- 证据：charter §5.1 表格「journal.jsonl …只增不改」「reports …不可变」；方案 L93 新事件仅 dispatch-superseded；L83「赋」字面语义即写回。
- 最小修复（二选一，需裁决）：A. 声明迁移=追加 `wave-assigned` 事件，投影 waveId 解析顺序写死为 `dispatched.detail.waveId ?? wave-assigned join`，L93 补该事件类型；B. 若选一次性重写，作为 charter §5.1 显式例外入规约（保留原文件备份、锁内原子执行、写迁移版本标记），并说明旧任务重放语义。同时补「半迁移 journal」的损坏输入推导测试（AGENTS 变更要求：迁移改动需覆盖损坏输入与恢复）。

### T2 — F6 重出卡机制两层缺陷：等待期指纹比对分支不可达（字面实施无法兑现 L68 目标场景）+ 已决场景取最旧 accept 决定形成无限重出卡

- 严重级别：blocker
- 位置：方案 L63-68（F6）、L108（验收门槛 5：等待期改写 → 必然重出卡）
- 归因：状态机/跨层契约缺口，两层：
  ①（等待期，未决卡）gate.mjs:105 的 `decided` 只查 `choice === "accept"`；用户尚未决定时 decisions 里没有 accept → 恒走「等待用户决定」分支（gate.mjs:107-113），**指纹比对分支（gate.mjs:114-121）不可达**；且 decision-issued 事件 detail 只有 {decisionId, gateId, reason, choices}（cli.mjs:551），**无签发时指纹锚点**。cli.mjs:542-556 的 await-decision 分支在 pending 存在时**原样返回旧卡文本**（question 取 issued.detail.reason），不重算指纹、不重签卡。因此 F6 按字面实施（把评审链比对挂在「指纹过期」blocker 上、复用 await-decision 分支）无法兑现 L68「等待期修订必然重新呈卡」——机制不可达。
  ②（已决，accept 后）一旦 F6 以任何方式兑现重出卡（无论修①还是走 I7 既有「批准后制品变化」路径），同一 gateId 出现多个 accept 决定成为常态；gate.mjs:105 的 `find()` 取**最旧** accept（derive.mjs:27 的 humanRework 却取 `.at(-1)` 最新——同一事实两种遍历方向）→ 永远比对第一个已过期决定 → 无限重出卡死循环。
- 触发条件：①人工门等待期 Challenger/Expert 以同 key 改 payload 重交（L68 点名的现场场景）；②accept 后评审链/制品变 → 重出卡 → 用户再次 accept。
- 影响：①F6 目标场景（L68）字面不可兑现，验收门槛 5 按错误预期固化；②死循环、用户再 accept 无效——**违反 I5「死门是缺陷」**。
- 证据：gate.mjs:104-121（decided 查询谓词、!decided 分支与指纹分支的结构）；cli.mjs:542-556（pending 原样返回旧卡）；cli.mjs:546-551（decision-issued 无指纹锚点）；derive.mjs:27（.at(-1) 对照）。本项与 Challenger 组合评审转述的 standards B1、logic L-03、impact B2、defects B1 一致 blocker（error-handling B2 互补），各包证据独立、本包证据如上。
- 最小修复（两层都要，缺一层即留死门）：①兑现等待期语义必须先在签发侧留锚点——decision-issued.detail 记录签发时 {artifactFingerprint, reviewFingerprint}，gate 对**未决卡**比对「当前指纹 vs 签发指纹」、变化则签新 decision-issued（旧卡 settled 后再呈新文本）；②决定查找统一改为「该 gateId 倒序最新 accept」（与 derive.mjs:27 同模式）。补用例「等待期评审改写 → 重出卡（新文本）」「accept → 评审链变 → 重出卡 → 再 accept → 门通过」。另：cmdDecide（cli.mjs:576-584）指纹公式 `artifactsFingerprint(stage 过滤集)` 与 gate.mjs:106 的 `current.length ? current : artifacts.items` 兜底不一致，F5「语义对齐改名」时收敛为同一纯函数（同源原则，呼应 F2 对轮次口径的处置）。

## 3. Findings（risk）

### T3 — F5 返工完成判定的粒度与下游评审链语义不闭合（多包全局指纹 + 「进评审」与实际状态机不符）

- 严重级别：risk
- 位置：方案 L58-61（F5）、L107（验收 4「不同内容 → 正常进评审」）
- 归因：边界/状态机缺口。①artifactFingerprint 是**阶段级全局指纹**：多包人工门 rework 派全部包（derive.mjs:33-37 现状同构），任一包交付即全局指纹变化 → 整体判「返工已执行」，未修包等在途守卫放行后带旧内容过门；②单包场景下「旧 key 重交不同内容」的实际状态机走向与方案宣称不符：交付报告 round=旧轮（≤评审快照），waves.mjs:72-88 的覆盖判定只比 round 不比 digest → 视为已覆盖；core 场景因裁决新鲜度失效（waves.mjs:95-96）走新 verdict 波（waves.mjs:172-174），**非 core 场景不派任何评审**，直接回到人工门重呈卡。方案 L60「评审链兜底落实质量」在非 core 场景不成立。
- 触发条件：多包人工门 rework 部分交付；或非 core 场景用决定前旧 key 重交不同内容。
- 影响：返工判定被未修包「搭便车」；验收门槛 4 描述的期望流与机器实际行为不符，测试将按错误预期固化。
- 证据：derive.mjs:28（全局 deliveredAfter）、33-37（owners=全部包）；waves.mjs:72-88、95-96、122、172-174；intake.mjs:220（快照仅 {package, round}，无 digest）。
- 最小修复：F5 判定改**按包投影**（每包当前制品指纹 vs 决定时该包指纹；决定需保存逐包指纹或从决定时刻 artifacts 快照重算）；验收门槛 4 按场景写死期望流（core：verdict 重裁；非 core：人工门重呈卡），或把 review 覆盖快照升级为 digest 感知（在 L131-134 后置项之外单独裁决）。

### T4 — F2 轮次投影的输入源与空值边界未定义（报告 waveId 与 journal join 双源、blocked 报告、作废波）

- 严重级别：risk
- 位置：方案 L40-43（F2）、L94（报告 +waveId）
- 归因：序列化/空值缺口。旧报告不可变（charter §5.1），F9 只迁移 journal → 旧报告无 waveId，投影必须经 dispatchKey join journal；新报告自带 waveId——**同一事实两个来源**，抄写不一致时静默分叉（正是台账 V3-E2E-03「两个状态宇宙」的同型复发）。且未定义：①outcome=blocked 的报告（intake.mjs:108 接受、L146 kind 恒为 deliver）是否参与轮次与依赖满足（现状 waves.mjs:46-52 会计入）；②dispatch-superseded 波的已交付报告是否参与投影（L47 只说守卫过滤，未说投影过滤）。
- 触发条件：任何 pre-F9 任务报告与新报告混读；Owner 以 blocked 交付；对已有交付的重复波执行 retire。
- 影响：轮次虚增/依赖被 blocked 报告错误满足/作废波残留抬高轮次——F2 的核心目标（口径唯一）落空。
- 证据：waves.mjs:47-52（kind=deliver 即计数）；intake.mjs:108、145-146；store.mjs:102（按 at 排序读入全部报告）；方案 L43 只覆盖「写入处」同源，未定义读取侧投影的完整输入集。
- 最小修复：声明投影唯一输入 =「kind=deliver 且 outcome=delivered 的报告」，waveId 一律 `dispatchKey → journal dispatched.waveId` 解析（报告上的 waveId 仅展示字段，不参与判定）；superseded 波的报告不入投影。另注：L24「（同 waveId 多条天然去重）」在每包维度冗余（每包每波至多一条派发、round 同源，max 已足够），建议措辞收敛为「max(round)」，避免实现者误解需跨包聚合去重。

### T5 — F3 守卫的匹配谓词未定义，与模型基线「波与波永远串行」存在解释空间冲突

- 严重级别：risk
- 位置：方案 L35-36（「属性相同 → 返回原在途卡，不新开波」）、L47-48（统一守卫）
- 归因：状态机缺口。方案只说「属性相同」时等待，未定义属性集合（kind/role/round/包集/causeRef 哪些参与匹配），也未定义**属性不同**时（如多包部分交付后推导出 review 而 respond 仍在途）是否新开波。模型基线 L60 明确「波与波之间永远是串行的」：任何未结波在场都不应新开波。现状实现是「尾部批次任一未交付一律等待」（derive.mjs:70-77），F3 重排若按字面实现成「仅属性相同才等」，会破坏串行不变量。
- 触发条件：多包 rework 部分交付后推进；retire 后推进；人工门 rework 与普通波推导交错。
- 影响：同阶段并发两波在途，组合评审等齐语义（模型基线 L101-102）被打破，回归 V3-E2E-01 同族缺陷。
- 证据：derive.mjs:70-77（现状全等待语义）；模型文档 L60、L101-102；方案 L35 只覆盖「属性相同」分支。
- 最小修复：守卫语义写死为「存在任何未 superseded 的未结波 → wait-inflight」，属性匹配仅决定返回哪张在途卡；同时定义 retire 作废后同逻辑波以新 waveId 重派的再派生规则。

### T6 — retire 的 waveId 对 Lead 不可发现（CLI 契约缺口，违反 P4）

- 严重级别：risk
- 位置：方案 L49（tw retire --wave <wvN>）
- 归因：跨层契约缺口。Lead 必须能拿到当前未结波的 waveId 才能调用 retire，但 wait-inflight 卡与 dispatch-plan stop 卡均不输出 waveId（现状无此字段）。
- 触发条件：Lead 需要作废一个卡死的在途波（retire 的唯一使用场景）。
- 影响：retire 形同虚设，恢复边（I5 的核心承诺）不可执行；Lead 被迫读 .team-work 内部状态（违反产品边界，台账根因链第 5 条点名的问题）。
- 证据：cli.mjs:515-526（wait-inflight 卡字段）、cli.mjs:896（planStop 透传卡）；方案 L49 未声明 waveId 的出卡渠道。
- 最小修复：wait-inflight 卡与 dispatch-plan 输出增加未结波 waveId（及 package 集）；retire 拒绝输出带「当前未结波清单」指引。

### T7 — F7 只定义了写入侧：读取侧契约（幂等查找、版本序、gate/波次机消费）未定义

- 严重级别：risk
- 位置：方案 L72-74（F7）、L92-93（reports +ver、journal +payloadDigest）
- 归因：序列化/空值缺口。①intake 现状幂等读取固定路径 `deliver-<key>.json`/`review-<key>.json`（intake.mjs:130、202），报告身份改为 key+ver 后该路径失效；且「同 key 同 payload 幂等」要求按 payloadDigest 跨版本查重（重试 v1 内容时不得误生成 v3）。②版本序依赖 at 排序（store.mjs:102），同毫秒两版本排序不稳定——F7 已有数值 ver，应以 ver 为同 key 主序。③所有读取点需「同 key 只取最新 ver」收敛规则：gate.mjs:38-45 会扫出旧版本 fail check 阻塞新版本 pass；waves.mjs:58-59 的 challenger/expert 取 lastOf 依赖 at。④payloadDigest 公式未指定（应固定 `digestValue(canonicalJson(payload))`，persistence/transactions 已有 canonicalJson，charter §6.1）。
- 触发条件：任何同 key 修订重交（F7 的目标场景本身）。
- 影响：幂等键失效（重试生成新版本噪音）、旧版本 fail 阻塞门禁、版本序不稳定导致评审链指纹抖动（F6 依赖其稳定）。
- 证据：intake.mjs:130-133、202-205；gate.mjs:38-45；store.mjs:96-102；方案 L72-74 仅描述注册函数行为。
- 最小修复：在方案中补「报告读取契约」一小节：同 key 按 ver 取最新参与一切推导；幂等匹配按 key+payloadDigest 查全部版本；payloadDigest=digestValue(canonicalJson(payload))；补「v1 fail + v2 pass → 门按 v2」契约测试。

### T8 — F4 倒序回溯的失效成员边界未定义（fresh 复用同一 key 时旧映射仍会被解析到）

- 严重级别：risk
- 位置：方案 L53-54（F4）、L131/L134（后置项：memberSlot、pendingTags）
- 归因：边界缺口。台账相邻场景推演第 7 行明确要求「send_message 失败后 fresh：fresh 明确创建新 incarnation，并作废旧成员映射/未结尝试」（findings.md L107），方案把 pendingTags/成员槽位整体推迟到后置项（L131-132），但对 F4 过渡形态未声明：fresh 复用同一 pending key 时，若 mappings[key] 未被回填为新 childId，倒序会解析到已失效的旧 childId——与 V3-E2E-02 同型断链，只是从「找不到」变成「找错人」。
- 触发条件：send_message 失败 → Lead 按 resumeNote 开 fresh 新会话 → 未执行 tw agent-map（或插件未回填）→ 下一轮续派。
- 影响：续派打到已失效会话，成员上下文丢失，且错误不易察觉（比 expectedAgentIdMissing 更隐蔽）。
- 证据：cli.mjs:867-868（resumeNote 建议 fresh）；cli.mjs:851-855（现状 prevKeyOf 只看紧邻 key）；findings.md L107、L85-88（台账 P1-1 memberSlot 建议）；方案 L54 只覆盖 replace-owner 新登记场景。
- 最小修复：声明 fresh 复用 key 时 mappings[key] 必须被回填（agent-map/插件强制，写入 resumeNote 指引），或倒序回溯跳过「已被同 key 重新登记覆盖过的旧映射」（以 agents.json 写入时间为证）；把台账相邻场景第 7 行纳入 F4 验收用例。

### T9 — F5 指纹判定对「无制品变化的文本式回应」永不判返工完成，消耗真实轮次预算

- 严重级别：risk
- 位置：方案 L59（F5 判定）、L107（验收 4）
- 归因：边界缺口。F5 的完成证明只有指纹变化一条路径。当 respond 波无制品可改时（Lead 以 `--writable none` 重派，cli.mjs:437/441；或 Owner 以 outcome=delivered 且 paths 空交付——intake.mjs:120-121 仅在 writable 非空时拒绝空 paths），指纹恒不变 → 永远判「未交付」→ respond 循环，直到轮次耗尽出 converge-user 卡。默认 workflow 中两个 required 门阶段（design-review/finish）outputs 均非空，但判定链不依赖 outputs，路径仍可达。
- 触发条件：人工门 rework 后 Owner 以文本回应（反驳/说明无需改文件）交卷。
- 影响：返工被浪费三轮、converge-user 提前触发，与方案 L124「轮次上限按真实轮消耗」的承诺叠加劣化；若用户连续授权追加轮次则无限空转。
- 证据：intake.mjs:120-121、145-146（无路径交付被接受且 kind=deliver）；cli.mjs:437/441；workflow/definitions/engineering.json L7-8、L13、L20。
- 最小修复：对无 writable 的 respond 波声明「完成证明 = 该波报告存在（绑定 waveId/causeDecisionId），指纹不参与」；或在派单卡写明「文本回应不视为返工完成」，避免成员空转。

## 4. Findings（info）

### T10 — F8 派发 key 序号来源未定义，现状序号并非全任务递增

- 严重级别：info
- 归因：命名/序列化精度缺口。
- 位置：方案 L78；证据：cli.mjs:432/442/483（`'w' + (task.journal.length + 1)`——同批多卡共享同一序号，journal.length 是事件总数而非派发计数，唯一性实际由 3 字节随机保证）。
- 最小修复：声明序号 = 锁内 dispatched 事件数 + 1（真正单调），或明确其为展示序号（唯一性归随机后缀），勿让实现者误以为序号可作幂等键。

### T11 — 事件形状细节：dispatch-superseded 的 detail.at 与事件顶层 at 重复；waveId 解析无损坏输入策略

- 严重级别：info
- 归因：序列化形状与边界策略缺口。
- 位置：方案 L49、L93；证据：charter §5.1（journal 行统一 {seq, at, type, detail}，现有事件 detail 均不含 at）。
- 最小修复：detail 只放 {waveId, reason}；声明解析 `wv\d+` 取 max+1 时遇格式损坏的失败策略（STATE_CORRUPT 或跳过并警告），补损坏 journal 用例。

### T12 — F9「归档任务保持只读；重开时再迁移」与归档终态语义矛盾

- 严重级别：info
- 归因：与模型基线/CLI 契约的措辞矛盾。
- 位置：方案 L85；证据：charter §5.2「归档后只读；后续工作=新任务引用归档名」，CLI 无「重开」动词（cli.mjs:293-301 archivedCard 只读摘要）。
- 最小修复：删除「重开时再迁移」或改为「归档任务不迁移（只读、不可 run）」，避免与模型基线冲突。

### T13 — F9 合并规则对 package=null 波（challenger/expert 派发）的适用性未定义

- 严重级别：info
- 归因：迁移规则的空值分支未定义。
- 位置：方案 L83；证据：dispatchedDetail 对无包派发写 package=null（cli.mjs:398），台账 V3-E2E-03 的重复 review 派发即此类。规则「package 相同 → 各自成波」把两个同轮 null 包 review 派发各自成波（与现场三条 respond 同款处理，投影不受影响），但「合并为一个波」分支对 null 包永不可达——规则表述需写明 null 包一律各自成波，防止迁移实现歧义。

## 5. 已核验一致项（正面确认）

1. 台账行号引用与实现逐一吻合：derive.mjs:30-45（人工门分支内嵌派发）、derive.mjs:67-77（在途检查）、cli.mjs:851-868（prevKeyOf 只看紧邻 key）、waves.mjs:48-54（roundOf=报告计数）、intake.mjs:213-220（reviewedPackages 快照）——方案据此描述的现状全部属实。
2. 台账四处测试缺口核实属实：runtime-v3-invariants.test.mjs:150-162 只测 rework 后**第一次**派 respond；runtime-v3-dsh.test.mjs:297-303 只覆盖普通波重复 dispatch-plan；runtime-v3-topology.test.mjs:319-344 测试名声称 expectedAgentId 但正文无任何断言；tag-agent-auto-register.test.mjs:22-32 只固化「续派覆盖最新 key」。
3. 方案 L26「agents.json 结构不动（mappings 保留为关联记录）」与现状 cmdAgentMap（cli.mjs:798-804）一致；F8「既有 w 开头报告文件不动」与现状 reportId 构造（intake.mjs:145、221）一致。
   F9 现场迁移例（三条同轮 respond 各自成波 → 投影轮=3 → 快照 plan@3 覆盖成立）与台账事故序列推演吻合，时序论证如下（回应组合评审 types↔logic 分歧）：事故中三张重复 respond 同 round=3（derive.mjs:35 现状口径：owner 交付数 2 + 1）；台账 L53「review 已接受后仍重复派 review」证明**重复交付之后**存在一份被接受的 review，其 reviewedPackages 快照按 intake.mjs:213-220 写入提交时刻每包 max(report.round)——此时三条 round-3 交付均已在场 → 快照 = plan@3；waves.mjs:58、72-88 的覆盖判定取最新 challenger review 的快照；F9 迁移不改报告（方案 L79）；迁移后投影轮 = max(round) = 3，3 ≤ 3 覆盖成立——方案 L84 断言成立。据此不采纳「快照以当时 max round=2 写入」的判读：该判读与台账 L53 的时序冲突（若被接受的仅是人工门前的旧 review，则无法解释「重复交付后被接受的 review 仍被判定未覆盖」的死循环），除非存在台账之外的现场 journal 证据表明最新已接受 review 的快照实为 2——如有，以现场证据为准。建议 summary 终裁采用精确表述：「迁移后投影轮 3 与最新已接受 review 的快照 3 相等，覆盖即成立；快照是提交时刻事实，不因迁移改写」。
4. 方案 L43「reviewedPackages 写入处改投影轮（与判定处同源）」、L40「删除报告计数口径」、L98「无平行权威引入」均与 P1/I4 不变量同向；F1 幂等、F4 回溯、F6 双指纹均为 P4 合规（簿记由 runtime 推导，不向模型索要）。
5. 后置项清单（L128-134）与台账 P1 建议（memberSlot、因果链、裁决新鲜度）的边界划分诚实，未发现把已声明后置项误标为已实施。

## 6. 待裁决项（unresolved）

- T1 的迁移写入机制（追加 wave-assigned 事件 vs 一次性重写例外）需用户/维护者裁决后写入方案；
- T3 的「评审链兜底」在非 core 场景的语义（现状为人工门重呈卡兜底）需要方案作者确认意图；
- 方案 L84 时序表述的精确化（§5-3）供 summary 终裁：本文件给出「快照 plan@3 成立」的台账+代码证据链；若终裁采信 logic L-05 的「快照 max round=2」判读，需先解释台账 L53「重复交付后被接受的 review」的时序，并以现场 journal 证据为准；
- 本视角未覆盖：测试计划完整性（视角 5）、retire 的安全面（视角 2）、实施顺序的依赖风险（视角 4/8）——由对应视角包与汇总包交叉归因。

## 7. 本视角可批准性

在 T1、T2 获得裁决并写入方案、T3–T9 语义钉死（含契约测试）的前提下，本视角（类型与不变量）认为方案可作为实施基线。无发现足以推翻方案的数据模型方向。
