
# 波身份与恢复方案交叉评审报告（summary 汇总终稿）

- 任务：wave-plan-review ｜ 阶段：code-review ｜ 包：summary ｜ 角色：owner ｜ 轮次：1
- 审查对象：docs/wave-identity-recovery-plan.md（138 行，状态：待用户批准）
- 证据事实：docs/v2-e2e-findings.md V3-E2E 段（32-122 行）；runtime-v3/{waves,derive,gate,intake,store,cli}.mjs；docs/team-work-runtime-model.md；docs/runtime-v3-charter.md；tests/ 相关测试；docs/dsh-directed-delegation-plan.md（§9 交叉核验）
- 方法：八视角（需求与变更摘要 / 缺陷与安全 / 错误处理 / 逻辑推演 / 测试覆盖 / 类型与不变量 / 规范与合规 / 影响范围）并行独立审查（互不知晓，防从众），产出 review/findings-{requirements,defects,error-handling,logic,test-coverage,types,standards,impact}.md；本包对全部 blocker 级证据行号逐一对照源码复核后汇总去重归因。全程未读取 .team-work 内部状态。
- 修订记录（v2，采纳 Expert 二轮裁决 accept / confidence=high 的三处更新）：①L84 时序分歧以现场证据终裁为「成立」（快照=plan@3，types §5-3 正确；logic L-05 / coverage F-C06 的「快照=2」为过时视图，需由对应包回写标注）；②F6 现状缺口按 Expert 独立核实口径确认为三处（gate.mjs:105 find-first / 107-113 未决分支不比对指纹 / cli.mjs:551 无指纹锚点且重出卡复用旧 reason），F6 实施必须连同三处扩展、不得降级；③Challenger findings 2-4 已核实属实（requirements 新增 F-10、standards risk 计数勘误为 R1~R18 共 18 项、defects M1 归因分歧系并行修订时序），按原定归属处置。
- 修订记录（v3，响应 Challenger rework + Expert 二轮终裁回写）：①补录 standards 包四条 risk（R9/R11/R13/R14，defects i5 同源）为 §五 R11，并在 §五末尾加口径声明（汇总不丢信息完成标准）；②B1 来源计数修正为七包（coverage F-C07 另有独立复核）；③R10 留痕 standards 计数勘误（R1~R18 实为 18 项）；④L84 裁决 1 按 Expert 裁决引用的现场证据链回写为机械事实；⑤B1 验收形态对齐 Expert 实施条件 1（等待期变化 + 同门多次决定）。
- 修订记录（v4，用户裁决返工 + Expert 终裁批准建议 + Challenger accept 残余项）：①B3（F5 返工判据）按用户裁决方向重写——结构因果替代时间/指纹判据：人工门 rework 后总是派 respond、只认 respond 波报告（决定前旧 key 重交结构性无效）、删除 deliveredAfter 自动判定、Owner blocked/僵局转 converge-user 人工仲裁、每包独立制品指纹（决定绑定包→指纹映射，替代全局复合指纹）；②其余 7 项 blocker（B1/B2/B4~B8）与 11 项 risk（R1~R11）维持 v3 结论、修订并入方案正文；③L84 按用户确认：认可现场核验、终裁成立、无需条件化（证据源披露由 Lead 随批准材料向用户呈明，用户已认可）；④复核范围：本轮仅 Challenger+Expert 两层复核，不重跑八视角交叉评审（用户裁决④）；⑤采纳注补 defects i6 过时视图标注、R5 补测试文件计数口径说明；⑥批准条件补 Expert 实施首步「回写方案文档」衔接项。
- 修订记录（v5，响应 Challenger rework（B3 消费规则未定义）+ 两层复核维持）：①B3 补「消费规则」段，写死三处触发/消费点——完成判定 = 存在绑定该 rework 决定的 respond 派发且报告 outcome=delivered（blocked 不算已交付，与 B2 投影输入集对齐）；blocked → converge-user（落点：derive 层人工门覆盖波分支复用既有 converge-user/await-decision 通道，reason 写明 Owner 无法完成返工）；每包指纹仅用于僵局检测（delivered 但该包 writable 非空且指纹较决定时未变 → 未修 → converge-user；writable 空包 → 报告存在即完成），不参与完成判定；R2 指纹公式同步每包粒度；②批准条件 9 措辞修正——过时视图回写降为后置可选项、以 summary 采纳注为终裁标注；③R5 补「实施以 summary B3 §5 验收用例为准」口径（coverage 矩阵行维持确认、未随 v4 同步）。
- 修订记录（v6，响应 Challenger rework（B3 多包混合处置未定义）+ 两层复核维持）：B3 消费规则补第④条「多包混合规则」——已改包按完成判定照常进入后续评审链（不因他包僵局挂起）；存在未修包 → 任务级 converge-user 卡，卡面列出未修包清单，选项 = 接受现状（未修包按原内容过评审链）/ 仅重派未修包（新 respond 波绑定同一 rework 决定）/ 结束任务（僵局卡不得沿用「追加一轮」，防空转循环）；§5-4 补混合验收用例；批准条件 3 同步。

## 一、汇总结论

**有条件批准：方案可批准为实施基线，前提是先完成第 4 节 8 项 blocker 修订并入方案正文。** 修订均为局部增补（新增事件/回退语义/验收用例/命令面声明），不改变 §2 建模定案、F1–F9 骨架与 §6 实施顺序；修订完成后无需重启全量八视角审查，由 Challenger 核对修订落点即可。

八视角结论一览：八视角**全部判定「需修订」**；同时八视角对方案的**根因定位、建模方向、台账引用行号的准确性一致认可**（见第 6 节正面确认）。所有 blocker 均为「修复项之间或修复项与现状机制组合出的死循环/机制不可达/规格未定」，不质疑方案方向。Expert 二轮裁决（accept，confidence=high）已全部纳入本终稿（见第 3 节裁决 1/6 与 B1 口径）。v4 更新：第三轮 Challenger accept + Expert 终裁（建议批准进入人工门）+ 用户裁决（B3 方向定案）已纳入——B3 按用户裁决重写为结构因果方案，其余 blocker/risk 维持 v3，L84 无需条件化，本轮仅 Challenger+Expert 两层复核。v5 更新：B3 按 Challenger 意见补「消费规则」段（完成判定/blocked 优先级/每包指纹用途三处写死），批准条件 3 可确定性落笔。v6 更新：B3 消费规则补「多包混合规则」（已改包进评审链 + 未修包仲裁卡含清单与三选项），多包 rework 场景不留白。

## 二、Owner 独立复核记录（关键证据逐条亲验）

| 方案/台账关键断言 | 代码事实 | 复核 |
| --- | --- | --- |
| V3-E2E-01 根因：人工门分支提前 return 绕过在途守卫 | derive.mjs:30-45 在 gate 分支内直接返回 dispatch，67-77 守卫在其后 | ✅ 属实 |
| V3-E2E-02 根因：prevKeyOf 只看紧邻上一派发 | cli.mjs:851-855 取最后一条同角色/包派发，不查 mappings | ✅ 属实 |
| V3-E2E-03 根因：roundOf 报告计数 vs reviewedPackages max-round 双口径 | waves.mjs:48-54 vs intake.mjs:213-220 | ✅ 属实 |
| V3-E2E-04 根因：deliveredAfter 时间戳比较 | derive.mjs:27-28 r.at > humanRework.at | ✅ 属实 |
| F6「重出卡机制现成」不成立 | gate.mjs:103-113 未决分支无比对；:105 find 取首个 accept；:114-121 仅已 accept 后可达；cli.mjs:542-556 未决卡原样返回旧文本 | ✅ 属实 |
| 台账点名四处测试缺口 | invariants:150-162 只测首派；dsh:297-303 只测普通波；topology:319-344 测试名含 expectedAgentId 但正文零断言；tag:22-32 固化续派覆盖最新 key | ✅ 逐处属实 |
| charter「journal 只增不改 / reports 不可变」 | runtime-v3-charter.md:148/:143（:124 同） | ✅ 属实 |
| 归档无重开、摘要不含派发事实 | cli.mjs:692-695 白名单无 dispatched/report-accepted + rm 目录；:697 归档只读 | ✅ 属实 |
| concurrencySoftLimit 无人消费 | team-work/policies/default.json:8 存在；runtime-v3 grep 零命中 | ✅ 属实 |
| store.mjs 报告排序比较器 at 相等返回 1 | store.mjs:102 (a.at < b.at ? -1 : 1) | ✅ 属实 |
| runtime-v3 尚无 waveId/superseded/retire | 全库 grep 零命中 | ✅ 属实 |
| dsh/ 插件无 w 前缀硬编码 | grep 零命中 | ✅ 属实 |
| tests 目录规模 | tests/*.test.mjs 共 17 个文件 | ✅ 属实 |

## 三、跨包分歧裁决（summary 终裁）

1. **方案 L84 时序断言（types 与 logic/standards/coverage 分歧）——Expert 二轮裁决以现场证据终裁为机械事实**：现场任务（dsh-directed-delegation）journal seq16/17/18 为三条同轮重复 respond（w16/w17/w18，round=3，pkg=plan，连续 dispatched、package 相同——按 F9 规则各自成波），三份交付 round 字段均为 3，迁移后投影轮=3；重复交付之后存在已接受的 Challenger 复审 review-w22-c98961（rec=accept，reviewedPackages=[plan@3]），waves.mjs:74-80 覆盖判定 3<=3 成立；迁移后推进方向为核心场景裁决新鲜度失效（expert w11 at 04:20 早于 round3 交付 at 04:56）触发的 Expert 重裁，而非死循环 review。旁证：challenger 派发 round=5（=owner 报告计数 5）而真实轮 3，正是 V3-E2E-03 计数口径虚增的现场实证；在途 w24 为重复派发残留，方案 §6 步骤 5 选择完成而非 retire，与批次守卫自洽。**终裁**：types §5-3 正确，方案 L84 全句与现场证据逐项吻合、断言成立——本报告 v1 的「条件化表述」作废，L84 无需改写；logic L-05 与 coverage F-C06 的「快照=2」判读为 w22 之前的过时视图，需由对应包回写标注。迁移工具仍应输出「迁移前后投影对比」作为现场机械验收证据（现场证据链引自 Expert 对现场 .team-work journal 的核验，超出成员派单纪律范围；本包遵守纪律未亲读）。证据源披露义务：由 Lead 向用户交付批准基线时显式呈明该证据获取方式并请用户确认——用户已在本轮裁决③明确认可现场核验，故 L84 维持终裁成立、无需回退 v1 条件化表述。
2. **台账门槛 7「真实 DSH 人工门 rework 复验」定级**：requirements（已修订降级）/standards/coverage 三包统一为 **risk**，summary 确认。批准条件：§6 显式补该复验步骤与判据（首次推进只写一批；任意次 run/dispatch-plan 混用与并发同 wait-inflight 且 journal 不增长；续派解析原 Owner）。
3. **台账 P1-4 覆盖判定**：requirements 2.2 表改判「部分覆盖（机制不可达待修）」；F6 机制缺陷归入本报告 B1。
4. **blocked 回应死循环判据归属**：采纳 impact B1 精确判据——现状时间判据下 blocked 报告 at 刷新可过关，F5 指纹化后该出路消失、死循环属 F5 新引入；归入本报告 B3。v4 消解：B3 按用户裁决改为「blocked/僵局 → converge-user 人工仲裁」，该死循环结构性消除。
5. **F5「根修」措辞**：采纳 requirements F-5——§1 改为「根修 + 明确标注的过渡/近似项」，与 §8 后置项一一对应。
6. **Challenger findings 2-4 核实属实（Expert 裁决确认）**：requirements 新增 F-10（已并入 B1 来源，defects B1/impact B2 的改判要求已满足）；standards risk 计数勘误为 R1~R18 共 18 项（本报告引用编号有效，R10 行留痕）；defects M1 归因分歧系并行修订时序——M1 计入 B4（F9 只增不改 blocker）直接来源，其余按原定归属处置，不改变本终稿结论。

## 四、去重归因后的 Blocker（批准前必须修订并入方案，共 8 项）

### B1｜F6 重出卡机制不可达 + 已决分支死循环（机制缺陷）
- **来源**：standards B1、defects B1、logic L-03、types T2、impact B2、error-handling B2、requirements F-10——七包 blocker/互补证据一致（coverage F-C07 另有独立复核；requirements F-10 已满足 defects B1/impact B2 的改判要求，见裁决 3/6）。
- **证据**（F6 现状缺口，Expert 二轮独立核实确认为三处；F6 实施必须连同这三点扩展、不得降级）：①gate.mjs:105 decisions.find-first——同门多次 accept 只追加（cli.mjs:591），find 恒取最旧决定 → 重出卡后二次 accept 恒比对旧指纹 → 无限重出卡（I5 死门）；②gate.mjs:107-113 未决等待分支不比对任何指纹（指纹比对在 :114-121，仅 accept 决定存在后可达）；③cli.mjs:551 decision-issued detail 无指纹锚点，且 cli.mjs:542-556 重出卡复用旧 reason/choices 文本。台账 P1-4（findings.md:94-95）。
- **修订**（一一对应三处缺口，已列入实施条件、不得降级）：缺口①→decided 查询改 gateId 倒序最新 accept（与 derive.mjs:27 的 .at(-1) 同模式）+ cmdDecide 对过期卡拒绝（DECISION_STALE 指引 run 取新卡）；缺口②→gate 未决分支比对「当前指纹 vs 签发指纹」，变化 → 作废旧卡重签新卡；缺口③→decision-issued 签发时绑定 {artifactFingerprint, reviewFingerprint} 快照、await-decision 重出卡按当前事实重渲染 question/choices（不复用旧 reason）。§5 验收 5 用例须显式含两个形态：「等待期评审链变化 → 重呈新文本卡且只呈一次」与「同门多次决定 → 二次 accept 后门通过、不再成环」（Expert 裁决实施条件 1，不得降级）。

### B2｜F2 轮次投影未闭合：权威源、消费清单、投影输入集三处缺口
- **来源**：logic L-01/L-02、impact B3、defects M2、standards R3/R5、types T4、error-handling R3。
- **证据**：waves.mjs:52 roundOf=报告计数是 respond/produce round 的来源（:168/:178 用 roundOf+1），删除后新权威源未定义；derive.mjs:35 人工门 respond 独立计数（filter(...).length + 1）不在 F2 消费清单；§2:24「最大派发 round」vs F2:40「交付报告 round 字段」两口径；「按 waveId 去重」在 max(round) 投影中冗余（F9 同轮重复各自成波、waveId 互异，不去重任何东西）；blocked 报告（intake.mjs:108 放行）与 superseded 波报告是否参与投影未定义。
- **修订**：定义唯一权威源「每包 max(已交付报告 round)，round 由派发事件抄写（P4）；produce/respond = 该包最大派发 round+1」；derive.mjs:35 显式列入换源清单；「按 waveId 去重」删除或注明仅防御；投影输入集钉死「kind=deliver 且 outcome=delivered 且非 superseded 波」；旧报告无 waveId 回退按 dispatchKey 独立条目。

### B3｜F5 返工判据按用户裁决重写：结构因果替代时间/指纹判据
- **来源**：standards B3、impact B1、logic L-04、requirements F-3、types T9/T3；v4 方向 = 用户裁决（本轮派单①），不再二选一。
- **证据**（原判定缺陷）：①原 F5 指纹判据下决定前旧 key 重交**不同内容**（指纹变）仍冒充成功，与台账门槛 6（findings.md:121）字面冲突；②outcome=blocked（intake.mjs:108 放行、120-122 不要求 paths）与 --writable none 文本回应均不改指纹 → 恒判「未交付」→ 覆盖波无限重派 respond（分支在 gateCheck 前 return，用户到不了 decide 卡）；③多包全局指纹：任一包变化 → 全部包判返工已执行（未修包搭便车，derive.mjs:33-37 owners=全部包）。现状 derive.mjs:27-28 为 deliveredAfter 时间戳比较（V3-E2E-04 根因，第二节复核属实）。
- **修订**（用户裁决定案——结构因果替代指纹/时间判据）：①人工门 rework 后**总是派 respond 波**（覆盖波恒为 respond，无任何自动判定前置）；②返工完成 = 存在绑定该 rework 决定的 respond 派发且其报告已交付——**只认 respond 波报告**，决定前旧 key 重交结构性无效（不绑定该决定的报告不能消费本次返工，冒充根除，不靠指纹近似）；③**删除 deliveredAfter 自动判定**（derive.mjs:27-28 时间戳比较整体移除），判定链改显式因果引用 decisionId/waveId → dispatch → report（台账 P1-2 落地）；④Owner blocked 交付或僵局（无制品可改/文本回应无进展）→ **转 converge-user 人工仲裁**，不无限重派 respond；⑤**每包独立制品指纹**：决定绑定「包 → 指纹」映射（替代全局复合指纹），多包 rework 按包独立判定，未修包不得搭便车。§5 验收对应：「旧 key 重交同/异内容均不能完成返工」「respond 波报告完成返工」「blocked → converge-user」「每包指纹独立判定」；F6 双指纹评审链兜底不变。
- **消费规则**（v5 补，写死三处触发/消费点，批准条件 3 据此确定性落笔）：①**完成判定** = 存在绑定该 rework 决定的 respond 派发且其报告 outcome=delivered——blocked 报告不算已交付（与 B2 投影输入集「kind=deliver 且 outcome=delivered」同源对齐，判定链不双轨）；②**blocked → converge-user**：落点 = derive 层人工门覆盖波分支（derive.mjs:30-45，该分支在 gateCheck 前 return），blocked 报告复用既有 converge-user/await-decision 通道（derive.mjs:63-65 同构），reason 写明「Owner 无法完成本次返工，待用户仲裁」，不无限重派 respond；③**每包指纹的用途 = 僵局检测**（不参与完成判定，完成只看因果绑定）：report=delivered 且该包 writable 非空、该包指纹较决定时未变 → 该包实际未修（僵局）→ 同②转 converge-user；writable 为空（纯回应派单）→ 报告存在（outcome=delivered）即完成。R2 同步：决定绑定「包 → 指纹」映射时，gate.mjs:106 / cmdDecide:584 / derive 判定三处指纹公式统一按每包子集计算（消除现三处不一致）。④**多包混合规则**（v6 补，对应台账门槛 2 多包部分交付语义）：部分包已改（满足①）、部分包未修（满足③僵局）时——已改包按①完成，其交付照常进入后续评审链（不因他包僵局挂起）；存在未修包 → 任务级 converge-user 卡，**卡面列出未修包清单**（包 id + 该包指纹较决定时未变的事实），选项须含「接受现状（未修包按原内容过评审链）/ 仅重派未修包（新 respond 波绑定同一 rework 决定、只含未修包）/ 结束任务」——这是对既有 converge-user 卡 choices 的扩展（cli.mjs:548-550 非人工卡现为「追加一轮/结束任务」，其中「追加一轮」对僵局包会立即再判僵局 → 用户可见空转循环，僵局卡不得沿用）。§5-4 验收补混合用例：多包部分已改/部分未修 → 仲裁卡含未修包清单、已改包交付进入评审链、不再空转。

### B4｜F9 迁移：改写历史 vs journal 只增不改 + 迁移幂等/原子/回滚未定义
- **来源**：standards B2、types T1、error-handling B1、defects M1、impact R1。
- **证据**：charter:148 journal 只增不改、:143 reports 不可变；方案:22 waveId「只做派发事件上的字段」→ 迁移只能改写既有行；方案:98「全部只增不删」自相矛盾；无完成标记/幂等/备份/半迁移损坏输入策略。
- **修订**（二选一，推荐追加式）：①迁移=追加 wave-assigned {waveId, dispatchKeys[], at} 映射事件 + 投影 join 解析（新事件类型入 §4 清单）；或②改写式须 charter §5.1 显式例外 + 先备份 + 锁内原子 + 迁移版本标记。两者都必须：迁移幂等（重跑不重复赋号）、中断重跑等价、半迁移 journal 损坏输入测试（AGENTS 变更要求）。

### B5｜F7 报告版本链：落盘形态/幂等键/payloadDigest 未定义
- **来源**：standards B4、coverage F-C02、types T7、impact R6、logic L-09。
- **证据**：intake.mjs:130-134/202-205 单文件覆盖 + JSON.stringify 全等幂等（键序敏感）；「报告身份 = key+ver」与单文件形态不自洽（ver>1 无正文载体）；payloadDigest 公式未定义；读取侧「同 key 取最新 ver」收敛规则未定义（gate.mjs:38-45 会扫出旧版 fail check 阻塞新版 pass）。
- **修订**：落盘形态二选一（单文件覆盖 + journal digest 链，或每 ver 一文件）；幂等判定 = key+payloadDigest，payloadDigest = digestValue(canonicalJson(payload))，与 F6 评审链指纹同源同公式；一切推导取同 key 最新 ver；模型基线「报告一经登记就不再改写」（model.md:68）同步修订为「身份 = key+ver、digest 链即时可审计、全文留档后置」。

### B6｜重复报告四类恢复 + 不同 digest 用户选择卡缺失
- **来源**：standards B5、requirements F-2、logic L-06、defects M3、error-handling R8、impact R8、coverage F-C03。
- **证据**：台账 P0-5（findings.md:87）与门槛 4（:119）要求四类恢复（零报告/单报告/同 digest 多报告/不同 digest 多报告）均有确定、可审计、无删除的结果；方案 F9 只有成波合并规则、retire 只作废未结波；不同 digest 多报告无收敛机制（intake.mjs:151-155 同路径静默覆盖），未经评审的内容可能混入收敛基线。
- **修订**：F9/retire 补四类恢复规则（同 digest 机械合并；不同 digest 出用户选择卡、其余记 dispatch-superseded；或显式声明「迁移后待 Lead 裁决」并回写台账处置说明，不得既不实现也不记录）；§5 第 7 条扩为四类矩阵用例。

### B7｜retire/superseded 全链路消费语义与命令面缺失
- **来源**：standards B6、defects B3、coverage F-C05、error-handling R5、types T6、logic L-12/L-08。
- **证据**：intake.mjs:27-29 findDispatch 不检查作废 → 作废 key 可继续交付落盘；投影/快照/依赖/耗尽四处对被作废波报告的口径未定义；wait-inflight 卡（cli.mjs:519-525）与 dispatch-plan waves[]（:863-877）无 waveId → Lead 无从寻址 wvN；retire 命令面（helpCard:944-969/分发表/charter §4.1 工具表/bin/tw.mjs）未声明；§5 零 retire 用例。
- **修订**：intake 拒绝 superseded key（附「该波已作废，重新 run 取新卡」I5 指引）；投影/快照/依赖/耗尽四处统一排除 superseded 波；F4 回溯跳过 superseded；retire 清退该波映射（agents.json 保留审计）；wait-inflight 卡与 dispatch-plan 输出补 waveId（runtime 自有事实推导，P4）；retire 幂等矩阵（重复 retire/未知 waveId/已结波/缺 reason）+ 拒绝文案附指引；声明仅 Lead 可执行；§5 补 retire 合法/非法/部分交付/并发四类用例。

### B8｜在途守卫语义未钉死 + 旧形状/部署窗口过渡契约未定义
- **来源**：defects B2、types T5、standards B7、coverage F-C01、error-handling R1、logic L-07。
- **证据**：方案:35 只定义「属性相同 → 返回原在途卡」，属性不同分支未定义——按字面「不同则新开波」会破坏模型基线「波与波永远串行」（model.md:60）与组合评审等齐（derive.mjs:70-77 现状任何在途即等待）；F1「同轮超并发上限拆两批」前提不存在（concurrencySoftLimit 无消费，已复核）；部署后迁移前无 waveId 旧派发的判读未定义。
- **修订**：钉死「存在任何未 superseded 未结波一律 wait-inflight；属性匹配仅决定复用哪张在途卡」；属性集合显式化（kind/role/round/包集/causeRef，显式排除 key/at/modelHint/continuation）；「拆两批」句删除或注明归属编排层；定义无 waveId 事实退化语义（每 key 独立波、按 key 兜底）并列为迁移验收「迁移前后状态等价」。

## 五、Risk（随实施一并落实，共 11 项）

| 编号 | 内容 | 来源 |
| --- | --- | --- |
| R1 | waveId 与 d 序号两个「全任务递增序号」的计数器来源与迁移后接续未定义（现状 cli.mjs:432/442/483 用 journal.length+1，非派发计数） | standards R6、types T10、requirements U-2、impact I3 |
| R2 | F5/F6 指纹公式同源与旧决定回退：gate.mjs:106 空集兜底全量 vs cmdDecide:584 无兜底三处不一致；旧决定缺 reviewFingerprint 时降级为仅制品指纹（旧语义） | defects m3、error-handling R4、impact R4、logic L-11、standards 2.4-1/5 |
| R3 | F4 回溯边界与残险：re-planned 边界停止（standards I4）；fresh 复用 key 时旧映射解析风险；pendingTags 覆盖残险显式声明为已知残险；tag 测试修正列入 §5-8 | standards R7/I4、types T8、defects i4/m6、logic L-08 |
| R4 | F6 评审链指纹同源与全序：两处独立计算共用同一导出纯函数；「最新」以 journal seq/ver 为第一全序（store.mjs:102 比较器 at 相等返回 1，同毫秒不可靠）；指纹选取加当前阶段过滤 | logic L-10、impact I2 |
| R5 | 测试与验收补全：AGENTS 五类（损坏输入/非法流转/并发/恢复/幂等）；retire 矩阵；迁移测试落 tests/runtime-v3-migration.test.mjs；F#→测试文件映射表；fixtures 盘点（17 个 .test.mjs、约 119 处 key/round 引用；口径注：coverage 包头注「18 个测试文件」为含 tests/support fixture 的全量 .mjs 计数，实施盘点以 17 个 .test.mjs + 1 个 support fixture 为准）；回归基线声明 npm test；F5/F6 用例以 summary B3 §5 验收为准（coverage 包矩阵行维持确认、未随 v4 新方向同步，实施前以 B3 验收用例为权威口径） | defects M5/R9、standards R8、coverage F-C04~C11、impact I1 |
| R6 | 下游文档与清单同步：charter §5.1（journal 类型集合/report-accepted detail/reports 结构）、§4.1 工具表；模型基线两处措辞（波串行、报告不可变）；file-inventory；roadmap；台账 V3-E2E-01~04 状态行（已修复+回归证据）；SKILL/dsh-orchestration retire 规程；helpCard | standards R12、defects M4/i2/i3、impact R5、error-handling I1 |
| R7 | 台账门槛 7「真实 DSH 人工门 rework 复验」：§6 显式补步骤与判据（跨包统一 risk，见裁决 2） | requirements F-1、standards R18、coverage F-C03 |
| R8 | V3-E2E-05 台账引用与处置归属：§1 引用更新为 01~05；§8 注记「派单语境 + 成员层 subagent 治理随定向委派方案 §8 合并，不在本方案范围」 | defects M6 |
| R9 | 回滚与部署前置：artifactFingerprint 改名后旧版 runtime 读新决定得 undefined → 人工门恒过期（新→旧回滚需双写或声明不支持）；§6 声明实施期现场任务冻结前置条件；迁移先经副本/回归验证再作用于活动任务 | impact（回滚/部署）、standards R16 |
| R10 | 措辞与精度：拟议字段标注「拟议，实施以测试验形状」（AGENTS 17）；§1「根修」校准为「根修+过渡/近似项」；§8 补两条无声遗漏——P1-2 因果链已由 B3 v4 结构因果引用落实；P0-5 用户选择卡若 B6 未落实仍须补记；L84 已由 Expert 现场证据终裁为成立（logic/coverage 过时视图回写标注）；dispatch-superseded detail 去重 at 字段（types T11）；F9 迁移规则声明 package=null 波各自成波（types T13）；「currentStageOf 两处重复」措辞修正（standards I1）；「w24」环境特定表述泛化（脱敏）；跨包勘误留痕：standards 第三节「R1–R18（17 项 risk）」实为 18 项（编号 R1~R18，本报告与附录按 18 项引用） | requirements F-5/F-6/U-4、standards R17/I1/I2、types T11/T13、logic info |
| R11 | standards 四条 risk 补录（v3，Challenger 点名丢信息）：R9 F8 前缀 w→d 的 agents.json 键空间迁移面（旧 w 键只读保留、新 d 键、回溯按 key 精匹配、跨版本混存断言）；R11 F8 key 变更与定向委派二阶段 persistTagHints/modelHints 清理的写端交集与依赖顺序（§9 增注「清理代码无需再兼容 w」）；R13 派发双写 dispatched 事件 + agents.json pendingTags 非事务、崩溃窗口未纳入幂等守卫（重建以 journal 权威为准、缺失回填不重派）；R14 裁决新鲜度时间戳与投影轮并存残险（defects i5 同源；§8 标注已知残险、§5 加回归提示） | standards R9/R11/R13/R14、defects i5 |

> 口径声明（汇总不丢信息）：本表 R1~R11 已并入全部视角包 risk 级 finding（standards R9/R11/R13/R14 为本轮补录）；各包 info 级条目不逐一并入本表、以 §9 索引为准——info 不构成批准条件，此句即降级声明。

## 六、正面确认（八视角一致认可，无需改动）

1. 台账 V3-E2E-01~04 的根因定位与代码行号引用全部准确（第 2 节复核表，owner 逐行亲验）。
2. 台账点名的四处测试缺口属实（owner 逐处亲验）。
3. §2 建模定案与模型基线对齐：波/派发/成员/轮次/决定/门禁定义一致；「轮次 = 打磨循环数、报告数可被重复提交污染」口径正确。
4. 设计方向获认可：F4 倒序回溯 + 遇 stage-advanced 停止、F7 轻量版本链、F3 在途守卫统一为导出纯函数、retire 只增事件、F9 无损迁移方向，与 I4/I5/P1/P4 一致。
5. 波及面判断成立：F1/F4/F8 不触及 dsh/ 插件直接代码路径（已 grep 证实无 w 前缀硬编码）；archive 主链不受报告 +waveId/+ver 影响；无新配置项，tier→模型映射与升档审批不受影响；F4/F2/F6 复杂度线性，性能无实质风险。
6. 合规：方案文档无环境特定信息泄露；F2 waveId 由 runtime 抄写、成员不填（P4）；F5/F6 强化指纹绑定方向与 AGENTS 17/charter I7 一致；§8 后置项边界划分诚实。

## 七、批准条件清单（可操作核对）

实施前必须完成（并入方案正文后 Challenger 核对落点）。用户裁决确认：B1/B2/B4~B8 与 R1~R11 按 v3 终稿修订并入方案正文；L84 终裁成立、无需条件化；本轮仅 Challenger+Expert 两层复核、不重跑八视角交叉评审：

1. B1：F6 三处机制改造 + 防循环用例（§3-F6、§5-5）；
2. B2：F2 轮次权威源/消费清单/投影输入集钉死（§2 表、§3-F2、§4）；
3. B3：F5 按用户裁决重写——总派 respond + 只认 respond 波报告（旧 key 结构性无效）+ 删除 deliveredAfter + blocked/僵局转 converge-user + 每包独立制品指纹 + 消费规则段（完成判定/blocked 优先级/僵局检测/多包混合规则写死，见 B3；§3-F5、§5-4）；
4. B4：F9 迁移持久化形态 + 幂等/原子/回滚 + 半迁移测试（§3-F9、§4、§5）；
5. B5：F7 落盘形态 + payloadDigest 公式 + 读取侧收敛规则 + 模型基线同步（§3-F7、§4）；
6. B6：四类恢复规则与不同 digest 收敛动作 + 四类矩阵验收（§3-F9/F3、§5-7）；
7. B7：retire 全链路消费语义 + waveId 出卡 + 命令面声明 + retire 用例（§3-F3、§4、§5、charter 工具表）；
8. B8：守卫「任何未结波一律等待」语义 + 属性集合 + 无 waveId 退化语义 + 迁移前后等价验收（§3-F1/F3、§6）；
9. 裁决项：L84 已终裁成立（快照=plan@3，现场证据链见第三节裁决 1，方案无需改写）；过时视图（logic L-05 / coverage F-C06 / defects i6）以 summary 采纳注为终裁标注，视图包文件内回写为后置可选项（logic/coverage 已在第三轮完成回写）；§6 真实 DSH 复验步骤、§1 V3-E2E-01~05 引用与 §8 注记、§1「根修」措辞校准仍为批准条件。
10. Expert 终裁三项实施条件（不得降级）：①F6 连同 gate.mjs 三处现状缺口一并修（决定查找改最新、未决等待期指纹锚点、重出卡文本刷新），验收 5 含等待期变化与同门多次决定两形态（已并入 B1）；②实施首步将 L84 机械事实（快照=plan@3）与 F6 扩展条件及全部 blocker/risk 修订回写进 docs/wave-identity-recovery-plan.md（作为其不可分割附件，避免方案文档与批准基线漂移）；③按方案 §6 顺序实施，完成后以台账复现用例 1-4 与验收门槛全量回归，并在真实 DSH 人工门 rework 场景复验。

## 八、Unresolved（如实标注，不猜测补全）

1. 现场活动任务的迁移结果：已由 Expert 二轮裁决以现场证据终裁（投影轮=3、最新已接受 Challenger 复审快照=plan@3、覆盖判定成立；迁移后首推方向为裁决新鲜度失效触发的 Expert 重裁，非评审死循环）。本包遵守派单纪律未亲读 .team-work，采纳裁决结论；迁移工具仍输出「迁移前后投影对比」作为机械验收证据。
2. 「归档任务重开时再迁移」触发面：CLI 无重开命令、归档目录只读——建议直接删除该句（改为「归档任务只读不迁移」），除非另行设计重开能力。
3. 「同轮超并发上限拆两批」的归属：runtime 无该实现，若属平台编排层需在方案注明，否则删除。
4. F5 多包指纹粒度取舍：v4 已消解——B3 按用户裁决改因果锚点 + 每包独立制品指纹（包→指纹映射）。
5. 无 gateId 的 rework 决定是否真实存在：v4 基本消解——rework 覆盖波仅由带 gateId 的人工门决定触发（cli.mjs:549 人工门卡仅 accept/rework 选项）；实施前仍核验既有 decisions 数据以防反例。

## 九、附：视角 findings 索引

- review/findings-requirements.md（需求与变更摘要：F-1~F-10、U-1~U-5）
- review/findings-defects.md（缺陷与安全：B1~B3、M1~M6、m1~m6、i1~i6）
- review/findings-error-handling.md（错误处理：B1~B3、R1~R9、I1）
- review/findings-logic.md（逻辑推演：L-01~L-13）
- review/findings-test-coverage.md（测试覆盖：F-C01~F-C11）
- review/findings-types.md（类型与不变量：T1~T13）
- review/findings-standards.md（规范与合规：B1~B8、R1~R18、I1~I6）
- review/findings-impact.md（影响范围：B1~B3、R1~R9、I1~I5）

采纳注：requirements 包已新增 F-10 并并入本报告 B1 来源；standards risk 计数为 R1~R18 共 18 项；logic L-05、coverage F-C06 与 defects i6 的「快照=2 / 迁移后需再派 review」判读均基于旧口径，已由 Expert 现场证据终裁为过时视图（以终裁为准，见第三节裁决 1），由对应包回写标注。测试文件计数口径：17 个 .test.mjs（见 R5 行）；coverage 包头注「18」为含 tests/support fixture 的全量 .mjs 口径。
