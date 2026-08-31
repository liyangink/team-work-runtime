# 波身份与恢复方案（wave identity & recovery）

状态：**已批准为实施基线**。wave-plan-review 交叉评审终稿（`review/code-review-report.md`，八视角并行审查 + Challenger/Expert 复核 + 用户裁决）对本方案有条件批准：8 项 blocker（B1–B8）与 11 项 risk（R1–R11）的修订已并入正文（本修订即批准条件 10-② 要求的实施首步回写，是本方案不可分割部分）；L84 经现场证据终裁成立、维持原句。修订均为局部增补，不改变 §2 建模定案、F1–F9 骨架与 §6 实施顺序。

## 0. 批准与修订记录

- **批准形态**：有条件批准——8 项 blocker 修订并入方案正文后即可实施；修订完成后由 Challenger 核对落点，不重跑八视角交叉审查（用户裁决④）。八视角对方案的根因定位、建模方向、台账引用行号的准确性一致认可（评审报告第六节）。
- **L84 终裁**：Expert 以现场证据核验——三条同轮重复 respond（round=3）交付之后，接受的 Challenger 复审快照即 plan@3；迁移后投影轮=3，覆盖判定 3≤3 成立。方案 L84 全句与现场证据逐项吻合、断言成立，**无需改写**；logic L-05 / coverage F-C06 / defects i6 的「快照=2」判读为过时视图，以终裁为准（证据源披露义务由 Lead 随批准材料向用户呈明，用户已认可）。
- **Expert 实施条件（不得降级）**：① F6 连同 gate.mjs 三处现状缺口一并修（B1）；② 实施首步将 L84 机械事实、F6 扩展条件及全部 blocker/risk 修订回写方案文档——**本文件即该步产出**；③ 按 §6 顺序实施，完成后以台账复现用例 1–4 与验收门槛全量回归，并在真实 DSH 人工门 rework 场景复验。
- **blocker 落点**：B1→§3-F6、B2→§2/§3-F2/§4、B3→§3-F5、B4→§3-F9/§4/§5、B5→§3-F7/§4、B6→§3-F9/F3/§5、B7→§3-F3/§4/§5、B8→§3-F1/F3/§6。
- **risk 落点**：R1→F1/F8、R2→F5/F6、R3→F4/§5/§8、R4→F6、R5→§5、R6→§6、R7→§6、R8→§1/§8、R9→§6/§7、R10→分散（见各节标注）、R11→F8/§8/§9。
- **口径声明**：summary 终稿 R1~R11 已并入全部视角 risk 级 finding；各视角 info 级条目不构成批准条件，仅按 R10 要求对指名勘误项一并落实（拟议字段标注、dispatch-superseded detail 形状、package=null 迁移规则、「currentStageOf 两处重复」措辞、w24 泛化等）。§4 所列新字段/事件形状均为**拟议，实施以测试验形状**（AGENTS 17）；引用代码行为均基于评审阶段已读取的代码事实。

## 1. 背景与范围

一次真实任务的方案评审在人工门返工后连续暴露四个故障（详见 `docs/v2-e2e-findings.md` 的 V3-E2E-01~04 追加台账）：

1. 人工门 rework 的 Owner respond 波在未交付期间，重复推进会重复派发同内容派单（缺在途守卫）；
2. 续派两轮后报 expectedAgentIdMissing（成员身份回溯只看紧邻派发 key，映射链必断）；
3. 同轮重复交付后，波次机轮次口径分叉（报告计数 vs 报告 round 字段），评审覆盖永远判假，review 波死循环；
4. 人工门决定后，成员用决定前的旧 dispatchKey 修改并重交，Runtime 跳过应有的 Owner respond 直接进评审（deliveredAfter 只有时间关系、没有因果关系）。

另有 V3-E2E-05（八视角任务中成员在派单外递归扇出子代理、预算失控）——与上述事故无关，处置归属见 §8 后置项，不在本方案范围（R8）。

根因是数据模型层：**波没有实体身份、轮次有两个算法、成员身份挂在一次性派发上**。本方案按对齐后的模型做**根修 + 明确标注的过渡/近似项**（与 §8 后置项一一对应，见 F4/F5 的边界声明），不逐条打补丁。

范围外的后置项（第 8 节）与本方案不冲突。

## 2. 建模定案（对齐结论，B2/B4 修订已并入）

| 概念 | 身份 | 形态 |
| --- | --- | --- |
| 阶段 | 独立状态 | journal `stage-advanced` 事件（现状保留，不动） |
| 波 | `waveId`，递增序号 `wv1/wv2/…` | 新派发写 `dispatched.detail.waveId`；历史迁移经只增 `wave-assigned` 事件 join 解析（F9，不改写既有行）；波的存在 = 同 waveId 的派发集合；**波与波永远串行**（模型基线，F1 守卫维护） |
| 派发 | `dispatchKey`，改形如 `d<序号>-<短随机>`（d 消除旧 w 前缀与 wave 的歧义） | 一次尝试的凭证，不承载成员身份 |
| 轮次 | 无实体，**唯一算法**：每包 max(已交付报告 round 字段)，round 由派发事件抄写（P4）；produce/respond = 该包最大派发 round + 1 | 纯投影，删除报告计数口径；去重由 max 天然完成，不另设 waveId 去重步骤 |
| 成员 | 现状 agents.json 结构不动（mappings 保留为关联记录） | 身份解析改倒序回溯（F4） |
| 制品 | 现状不变（路径+指纹+快照） | 人工门判定对象 |

权威状态统一在 journal：波身份、轮次输入、报告版本链都在事件流里；reports / decisions / artifacts / agents 四类文件结构不动（仅最小字段增补，见 F5/F6/F7/F9）。

## 3. 修复项

### F1 波身份 waveId

- `dispatched` 事件补 `waveId` 字段；生成规则：全任务递增 `wv1/wv2/…`。
- **计数器来源（R1）**：waveId 与 d 序号两个「全任务递增序号」均以 journal 内 dispatched 事件数为源（任务锁内推导，不引入平行权威；现状 journal.length+1 随事件类型跳号，废弃），迁移后新号从 max(wvN)/max(dN) 接续，断言「新派发 waveId 严格大于已赋最大值」。
- **幂等语义（B8 钉死）**：**存在任何未 superseded 的未结波一律 wait-inflight**（波与波永远串行，模型基线不变）；属性匹配仅决定复用哪张在途卡。属性集合 = kind/role/round/包集/causeRef，显式排除 key/at/modelHint/continuation。
- **同轮并发上限拆批**：runtime 现状无拆批实现（`concurrencySoftLimit` 无人消费，评审已复核）；拆批属平台编排层职责，本方案不引入。若编排层拆批，表现为同一 waveId 的多条派发，不构成新波（评审 unresolved 3 处置）。
- **崩溃窗口（R11-R13）**：dispatched 落盘与 agents.json pendingTags 回填非事务；重启重建与幂等核验一律以 journal 为权威，pendingTags 缺失回填不触发重派。
- **无 waveId 事实退化语义（B8）**：部署后迁移前，无 waveId 的每条派发各视为独立波（按 key 兜底），守卫回退现状「尾部连续批次」判定；该语义列为迁移验收「迁移前后状态等价」的一部分。

### F2 轮次唯一算法（B2：权威源/消费清单/投影输入集钉死）

- `waves.mjs` 删除 `roundOf = 交付报告计数`；唯一权威源：**每包 max(已交付报告 round 字段)，round 由派发事件抄写（P4，成员不填）**；produce/respond = 该包最大派发 round + 1。
- **投影输入集钉死**：kind=deliver 且 outcome=delivered 且非 superseded 波；blocked 报告不入投影；被作废波报告不入投影（B7）。旧报告无 waveId 回退按 dispatchKey 独立条目（与 max 口径等价，防御性）；去重由 max 天然完成，不另设 waveId 去重步骤。
- **单一数据源**：报告上的 waveId 仅作展示字段，投影判定一律经 dispatchKey join journal 解析（dispatched.detail.waveId ?? wave-assigned join），杜绝新旧双源分叉（同型复发预防）。
- 消费点全部换源：waves 内 respond/review 轮次、轮次耗尽判定、依赖满足判定，**及 derive.mjs:35 人工门 rework 分支的独立计数**（改读统一投影函数）。
- `intake.mjs` 的 `reviewedPackages` 快照**写入处**同步改为投影轮（与判定处同源，避免新形态下快照/判定再次分叉）。

### F3 在途守卫统一 + retire 恢复边（B7/B8）

- `derive.mjs` 重排：先算波（含人工门 rework 的 respond 覆盖波）→ gate 检查不再内含派发 → converge-user → **所有派发路径统一经过 waveId 批次守卫**（守卫语义见 F1 钉死条款）；顺带清理：runTransition 的死代码分支与非 owner 派发分支并入统一守卫。
- 在途批次逻辑合并为一个导出的纯函数：derive / cli 在途重建 / intake 提示 / cli.mjs cmdPlan 重拆检查（**四处**重复）；currentStageOf 重复合一（intake.mjs 内函数 + derive.mjs 内联表达式，措辞按代码事实修正）。
- 作废恢复边：新增只增事件 `dispatch-superseded {waveId, reason}`（detail 不含 at，事件顶层已有 at）；新命令 `tw retire --task <n> --wave <wvN> --reason <…>`。
- **retire 全链路消费语义（B7）**：
  - intake 拒绝 superseded key 的 deliver/review（附「该波已作废，重新 run 取新卡」I5 指引）；
  - 投影/快照/依赖/耗尽四处统一排除 superseded 波；F4 回溯跳过 superseded；
  - retire 仅解除未交付派发在途，已交付报告保留为审计事实、不参与推导；清退该波映射（agents.json 保留审计记录）；
  - 幂等矩阵：重复 retire 幂等返回；未知 waveId/已结波/缺 reason 拒绝并附恢复指引；**仅 Lead 可执行**；
  - waveId 出卡（P4，runtime 自有事实推导）：wait-inflight 卡与 dispatch-plan 输出补 waveId；retire 拒绝输出带「当前未结波清单」指引；
  - 命令面（CLI 即接口）：retire 与迁移命令登记 helpCard 与分发表，拒绝沿用 fail()/fixHint 附恢复指引。

### F4 续派身份回溯（过渡形态，memberSlot 为终局后置）

- `cli.mjs` 的 `prevKeyOf` 改为：沿 journal **倒序**找同角色同包范围内**最近一个有映射的派发 key**；遇 `stage-advanced` 事件停止（不跨阶段串线）；跳过 superseded 波的 key。
- send_message 续派依旧不登记新 key（不需要）；replace-owner 新登记自然成为最近映射。
- **边界（R3）**：fresh 复用同一 key 时 mappings[key] 必须回填为新 childId（agent-map/插件强制，写入 resumeNote 指引），否则倒序会解析到已失效旧会话；pendingTags 覆盖残险（fresh 降级回填）显式声明为已知残险（§8）；tag 测试修正列入 §5。

### F5 人工门问题 1：返工判定改结构因果（B3，用户裁决定案——整体替换原「制品指纹判据」）

结构因果替代时间/指纹判据：

- **总派 respond**：人工门 rework 后**总是派 respond 波**（覆盖波恒为 respond，无任何自动判定前置）。
- **完成判定 = 因果绑定**：返工完成 = 存在绑定该 rework 决定的 respond 派发且其报告已交付——**只认 respond 波报告**，决定前旧 key 重交结构性无效（不绑定该决定的报告不能消费本次返工，冒充根除，不靠指纹近似）。
- **删除 deliveredAfter 自动判定**：derive.mjs:27-28 时间戳比较整体移除；判定链改显式因果引用 decisionId/waveId → dispatch → report（台账 P1-2 落地）。respond 派发写 `causeDecisionId`（runtime 抄写，P4；拟议形状）。
- **blocked/僵局 → converge-user**：Owner blocked 交付或僵局（无制品可改/文本回应无进展）转人工仲裁，不无限重派 respond（该死循环由原指纹判据引入，随判据替换结构性消除）。
- **每包独立制品指纹**：决定绑定「包 → 指纹」映射（替代全局复合指纹），多包 rework 按包独立判定，未修包不得搭便车。

**消费规则**（写死四处触发/消费点）：

1. **完成判定** = 存在绑定该 rework 决定的 respond 派发且其报告 outcome=delivered——blocked 报告不算已交付（与 F2 投影输入集「kind=deliver 且 outcome=delivered」同源对齐，判定链不双轨）。
2. **blocked → converge-user**：落点 = derive 层人工门覆盖波分支；blocked 报告复用既有 converge-user/await-decision 通道，reason 写明「Owner 无法完成本次返工，待用户仲裁」，不无限重派 respond。
3. **每包指纹的用途 = 僵局检测**（不参与完成判定，完成只看因果绑定）：report=delivered 且该包 writable 非空、该包指纹较决定时未变 → 该包实际未修（僵局）→ 同规则 2 转 converge-user；writable 为空（纯回应派单）→ 报告存在（outcome=delivered）即完成。指纹公式同步（R2）：gate.mjs:106 / cmdDecide:584 / derive 判定三处统一为一个导出纯函数、按每包子集计算（当前阶段登记制品集，可空即空集 digest，不兜底全量），消除现状三处不一致。
4. **多包混合规则**：部分包已改（满足规则 1）、部分包未修（满足规则 3 僵局）时——已改包按规则 1 完成，其交付照常进入后续评审链（不因他包僵局挂起）；存在未修包 → 任务级 converge-user 卡，**卡面列出未修包清单**（包 id + 该包指纹较决定时未变的事实），选项须含「接受现状（未修包按原内容过评审链）/ 仅重派未修包（新 respond 波绑定同一 rework 决定、只含未修包）/ 结束任务」——这是对既有 converge-user 卡 choices 的扩展（「追加一轮」对僵局包会立即再判僵局 → 用户可见空转循环，僵局卡不得沿用）。

验收见 §5 表第 5 行（含多包混合用例）；F6 双指纹评审链兜底不变。

### F6 人工门问题 2：评审链指纹 + 重出卡（B1：连同三处现状缺口一并修，不得降级）

- 新纯函数：评审链指纹 = 最新 Challenger 报告（reportId+ver+payload digest）与核心场景最新 Expert 报告的复合 digest。
- **同源与全序（R4）**：指纹在 cmdDecide 落盘与 gate 判定两处共用同一导出纯函数；「最新」以 journal seq/ver 为第一全序、at 次级破平（store.mjs:102 比较器 at 相等返回 1，同毫秒不可靠）；指纹选取加当前阶段过滤。
- 决定绑定两个指纹：`artifactFingerprint`（供 F5）+ `reviewFingerprint`（供本项）。
- **三处机制改造（B1，与 F6 一并实施）**：
  1. 已决分支：decided 查询改按 gateId 倒序取最新 accept（与 derive.mjs:27 的 .at(-1) 同模式），杜绝恒比对旧决定成环；cmdDecide 对过期卡拒绝（DECISION_STALE，指引 run 取新卡）。
  2. 未决分支：gate 未决等待分支比对「当前指纹 vs 签发指纹」，变化 → 作废旧卡重签新卡（现状该分支不比对任何指纹）。
  3. 签发锚点：decision-issued 签发时绑定 {artifactFingerprint, reviewFingerprint} 快照；await-decision 重出卡按当前事实重渲染 question/choices（不复用旧 reason）；cmdDecide 入口对未决人工门卡同样做「签发指纹 vs 当前指纹」对比，失效即拒绝。
- 效果：现场同款场景（等待期 Expert 同 key 重交修订裁决）从此必然重新呈卡。
- 旧决定兼容（R2）：缺 reviewFingerprint 时降级为仅制品指纹比对（旧语义），新决定启用双指纹。
- 验收 §5 表第 6 行双形态：「等待期评审链变化 → 重呈新文本卡且只呈一次」与「同门多次决定 → 二次 accept 后门通过、不再成环」（Expert 实施条件 1，不得降级）。

### F7 报告版本 ver（B5：落盘形态/幂等键/读取收敛钉死）

- **落盘形态**：单文件覆盖 + journal digest 链——报告身份 = key+ver，最新 ver 正文在单文件，历史版本经 journal `report-accepted` 的 ver+payloadDigest 链即时可审计，全文留档后置（§8）。
- **幂等判定 = key + payloadDigest**；payloadDigest = digestValue(canonicalJson(payload))，与 F6 评审链指纹同源同公式（键序/数组序归一化，消除现状 JSON.stringify 全等的键序敏感）。
- intake 两个注册函数：同 key 同 payloadDigest → 幂等返回（ver 不变）；同 key 不同 payloadDigest → `ver+1`。旧报告无 ver 视为 ver 1。
- **读取侧收敛规则**：一切推导取同 key 最新 ver（gate 只比对最新 ver 的 checks，旧版 fail 不阻塞新版 pass；waves 聚合按 (package, dispatchKey) 取最大 ver 唯一化）；journal `report-accepted` 补 `ver` 与 `payloadDigest`。
- 模型基线同步（R6）：模型文档「报告一经登记就不再改写」修订为「身份 = key+ver、digest 链即时可审计、全文留档后置」。

### F8 派发 key 命名

- 生成规则改为 `d<序号>-<3字节hex>`；**序号 = 锁内 dispatched 事件数 + 1**（R1/U-2：废弃 journal.length+1 口径；唯一性仍由随机后缀保证，序号不承担幂等键职责）；报告文件名跟随（`deliver-d9-….json`）。
- 既有 w 开头报告文件不动（既有任务继续用原文件）；新 key 前缀 d 消除与 waveId 的混淆。
- **agents.json 键空间迁移面（R11-R9）**：旧 w 键保留只读（既有映射继续可用），新 key 用 d 键；F4 回溯与映射查找按 key 精匹配；补跨版本 w/d 混存断言（回溯与 expectedAgentId 不因键前缀混存断链）。

### F9 既有任务迁移（B4 追加式 + B6 四类恢复；用户裁决：A 一次性补写）

- 迁移规则：journal 里**连续 dispatched 段**（以最近的 stage-advanced 事件为起点，不跨阶段并波）中，同 (kind, role, round) 且 package 互不相同的合并为一个波；package 相同（同轮重复派发）各自成波；**package=null 的派发一律各自成波**（R10-T13，规则表述不留歧义）；按序赋 wv1…wvN。
- **持久化形态（B4 追加式，推荐方案）**：迁移 = 追加 `wave-assigned {waveId, dispatchKeys[], at}` 映射事件 + 投影 join 解析（**不改写既有 journal 行与报告文件**，与 journal 只增不改、报告不可变一致）；新事件类型入 §4 清单。迁移在任务锁内执行、幂等（已赋号派发跳过，重跑不重复赋号）、中断重跑等价（半迁移 journal 可续跑至完整）；半迁移 journal 损坏输入测试（AGENTS 变更要求）。
- **四类恢复规则（B6）**：零报告/单报告按投影自然收敛；同 digest 多报告机械合并；**不同 digest 多报告 → 出用户选择卡保留一版、其余写 dispatch-superseded**（未经评审的内容不得混入收敛基线）。验收见 §5 表第 8 行四类矩阵用例。
- 当前活动方案评审任务迁移后：三条同轮重复 respond 成为三个波、投影轮 = 3，评审快照 plan@3 覆盖成立，波次机恢复正常推进。（L84 维持——Expert 现场证据终裁成立；迁移工具仍输出「迁移前后投影对比」作为现场机械验收证据）
- 归档任务保持只读、**不迁移**（归档目录不保留 dispatched 事实，不存在迁移对象；原「重开时再迁移」句删除）。

## 4. 数据结构变化汇总

| 位置 | 变化 |
| --- | --- |
| journal `dispatched.detail` | +waveId（F1）；key 前缀改 d（F8）；人工门 rework 的 respond 派发 +causeDecisionId（F5，拟议） |
| journal `report-accepted.detail` | +ver、+payloadDigest（F7） |
| journal 新事件类型 | `dispatch-superseded {waveId, reason}`（F3，detail 不含 at）；`wave-assigned {waveId, dispatchKeys[], at}`（F9 迁移） |
| reports 报告 | +waveId（F2，展示字段）、+ver（F7） |
| decisions 决定 | 人工门决定 fingerprint 拆为 artifactFingerprint（每包「包→指纹」映射）+ reviewFingerprint（F5/F6；旧决定回退兼容：缺 reviewFingerprint 降级仅制品指纹；route 决定结构不变） |
| 删除 | waves.mjs 报告计数口径 + derive.mjs:35 人工门 rework 分支独立计数（F2，统一读投影函数）；derive.mjs:27-28 deliveredAfter 时间戳判定（F5） |

**行为/算法变化**（同属变更面，实施落点点名）：

- derive：deliveredAfter 移除、rework 覆盖波 round 换投影（F5/F2）；所有派发路径统一过守卫（F3）。
- gate：人工门检查双指纹；已决分支取最新 accept；未决分支比对签发指纹（F6）。
- intake：报告幂等键改 payloadDigest、ver 递增（F7）；reviewedPackages 快照写入源换投影（F2）；拒绝 superseded key（F3）。
- cli：prevKeyOf 倒序回溯（F4）；await-decision 重出卡按当前事实重渲染（F6）；wait-inflight 卡与 dispatch-plan 输出补 waveId（F3）。
- 命令面：`tw retire` 与迁移命令登记 helpCard 与分发表（F3/F9）。

全部只增不删（除两处计数口径与时间戳判定），无平行权威引入。新字段/事件形状均为**拟议，实施以测试验形状**。

## 5. 测试与验收

对照台账「修复验收门槛」七条（`docs/v2-e2e-findings.md` 114-122 行）与评审补充用例。回归基线：`npm test`（node --test tests/*.test.mjs）；实施前先盘点 fixtures 形状（17 个 .test.mjs + 1 个 support fixture，约 119 处 key/round 引用）。

| # | 验收用例 | 对应门槛/来源 |
| --- | --- | --- |
| 1 | 人工门 rework 后首次推进只写一批；随后任意次 run / dispatch-plan / 混用 / Promise.all 并发均返回同一 wait-inflight，journal 不增长；派发落 journal 后进程崩溃重启，重放原 key/prompt 不扩大波次 | 台账门槛 1（复现 1）+ 门槛 2 重启 |
| 2 | 单包/多包/部分交付均满足「一逻辑波一批」；多包 respond 波部分交付 + 重复推进 → 返回原在途卡、不提前派 review、不重派已交付包 | 台账门槛 2 |
| 3 | Owner/Challenger/Expert 各连续三次派发，原成员始终可解析；replace-owner 后解析新成员；fresh 复用 key 回填新映射；不跨阶段串线 | 台账门槛 3（复现 2） |
| 4 | 同轮重复派发各交付后：投影轮不虚增、Challenger accept 后不再重复派 review、轮次上限按真实轮消耗 | 台账门槛 5（复现 3） |
| 5 | 返工判定（B3）：旧 key 重交同/异内容均不能完成返工；绑定 rework 决定的 respond 波报告（outcome=delivered）完成返工；blocked → converge-user（不无限重派）；每包指纹独立判定；第二次 rework 不能被第一次报告消费；多包混合（部分已改/部分未修 → 仲裁卡含未修包清单、已改包交付进入评审链、不再空转） | 台账门槛 6 + B3 |
| 6 | F6 双形态：人工门等待期改写 Challenger/Expert 报告 → 指纹失效重呈新文本卡且只呈一次（旧卡直答被拒 + 指引闭环）；同门多次决定 → 二次 accept 后门通过、不再成环；旧决定缺 reviewFingerprint 降级仅制品指纹 | B1 双形态（Expert 条件 1）+ R2 |
| 7 | F7：同 key 同 payload 幂等（ver 不变）；不同 payload ver+1 且 report-accepted 带 digest；旧报告视为 ver 1；v1 fail + v2 pass → 门按最新 ver 判定 | B5 |
| 8 | 四类历史重复 key 注入：零报告/单报告/同 digest 多报告/不同 digest 多报告均有确定、可审计、无删除的恢复结果（异 digest 出用户选择卡、其余 dispatch-superseded） | 台账门槛 4（B6） |
| 9 | F8 契约：key 格式 d<序号>-<3字节hex>、report 文件名跟随；agents.json 旧 w 键只读保留、新 d 键、跨版本 w/d 混存断言 | F8/R11 |
| 10 | 迁移（F9）：连续同属性不同包合并一波、同包重复各自成波、package=null 各自成波；迁移幂等（重跑不重复赋号）；中断重跑等价；半迁移/损坏 journal 输入；跨阶段不误并；输出迁移前后投影对比且状态等价 | B4/B6/R10-T13 |
| 11 | retire：合法作废未结波；重复 retire 幂等；未知 waveId/已结波/缺 reason 拒绝附指引；部分交付后 retire（已交付报告保留审计、投影排除）；retire×run 并发；retire 后旧 key 交付被拒附指引；superseded 波在投影/快照/依赖/耗尽/F4 回溯五处排除 | B7 |
| 12 | 未迁移任务 + 新代码混合态：无 waveId 派发按 key 兜底、守卫回退尾部连续批次，不重复派发 | B8 |
| 13 | 损坏输入/非法流转/并发/恢复/幂等五类（AGENTS 变更要求）：含损坏 journal、retire 非法矩阵、迁移×交付并发、superseded 迟到交付、重复 decide | R5 |
| 14 | 现有全量套件保持全绿；修正测试名与正文不符处：topology expectedAgentId 断言补齐（正文构造同角色二次续派并断言）、tag-agent-auto-register 由固化「同标签续派覆盖最新 key」改为验证 send_message 不触发回填 | 台账门槛 7 + R3 |
| 15 | 真实 DSH 人工门 rework 复验（§6 第 7 步，判据见 §6；收尾必做、不阻塞代码验收） | 台账门槛 7（R7） |

**F#→测试文件映射**（建议落点，实施按现状盘点调整；F5/F6 用例以 B3 本表第 5/6 行为权威口径）：

| 修复项 | 建议落点 | 关键用例 |
| --- | --- | --- |
| F1/F3 | runtime-v3-invariants / concurrency / topology | 人工门 rework 在途幂等（serial run、serial dispatch-plan、混用、并发、重启）；多包部分交付只等剩余包；retire 全路径 |
| F2 | runtime-v3-core / runtime-v3-intake | 同轮重复报告投影轮不虚增；reviewedPackages 与判定同源；轮次耗尽按真实轮 |
| F4 | runtime-v3-topology | 三角色三次续派可解析；replace-owner 后解析新成员；stage-advanced 边界停止 |
| F5/F6 | runtime-v3-core / invariants / cli | 双指纹绑定与回退兼容；旧 key 冒充被识破；等待期改写报告自动重出卡（B1 机制前置）；第二次 rework 隔离 |
| F7 | runtime-v3-intake | 同 payload 幂等 ver 不变；变 payload ver+1；report-accepted 带 ver+payloadDigest；旧报告视为 ver 1 |
| F8 | runtime-v3-intake / repository-contract | key 格式 d 前缀；report 文件名跟随 |
| F9 | 新建 tests/runtime-v3-migration.test.mjs | 合并/拆分规则；迁移幂等；跨阶段分段；投影轮验算；四类恢复矩阵 |

## 6. 实施顺序

前置（R9）：**实施期现场任务冻结**——迁移执行前，现场活动任务不产生新派发；迁移先经副本/回归验证，再作用于活动任务。

1. **（本步已完成）回写方案文档**：L84 机械事实、F6 扩展条件与全部 blocker/risk 修订回写本方案（批准条件 10-②；本次 plan-rev 轮产出）。
2. F1/F8（waveId + 命名）→ F2（投影）→ F3（守卫 + retire）→ F4（回溯）为一批，runtime 波次机改动。
3. F5/F6/F7 为一批，gate / intake / decide 改动。
4. F9 迁移工具（追加式 wave-assigned）+ 对当前活动任务执行迁移（先副本验证，输出迁移前后投影对比）。
5. 回归测试全量（npm test 基线）+ 台账复现用例 + §5 五类测试与矩阵用例。
6. 迁移后继续当前方案评审任务：Challenger 完成在途评审 → 推进 → Expert 重裁 → 人工门批准卡（原「w24」环境特定表述已泛化）。
7. **真实 DSH 人工门 rework 复验**（台账门槛 7，收尾必做、不阻塞代码验收）：判据 = 首次推进只写一批；任意次 run/dispatch-plan 混用与并发返回同一 wait-inflight 且 journal 不增长；续派解析原 Owner。
8. 下游文档与清单同步（R6）：charter §5.1（journal 类型集合/report-accepted detail/reports 结构）与 §4.1 工具表、模型基线两处措辞（波串行、报告不可变）、docs/file-inventory.json、runtime-roadmap、台账 V3-E2E-01~04 状态行（已修复+回归证据）、SKILL/dsh-orchestration retire 规程、helpCard。

## 7. 影响评估

- **Lead 自由度：增强**。重复推进/重试/并发是合法用法（返回同一在途卡）；retire 提供明确的作废恢复边（不再被迫读源码或开 fresh）；续派身份稳定。
- **工作流灵活度**：波次机语义、门禁、人工门流程不变；轮次上限按真实轮消耗，修复误触发耗尽卡。
- **可靠性**：改动集中在纯函数推导层；持久化只增字段（迁移为追加事件，不改写历史）；旧任务迁移后投影可重算。
- **安全性**：无文件系统权限面变化；retire 只允许作废未结波且只增记录。
- **回滚（R9）**：artifactFingerprint 改名后旧版 runtime 读新决定得 undefined → 人工门恒过期；新→旧回滚需双写 fingerprint 或声明不支持并附数据修复指引（实施时定案并写回）。
- **部署窗口（R9/B8）**：迁移前无 waveId 事实按 F1 退化语义运行；「迁移前后状态等价」列为验收，保证旧在途派单不被误判为新波。

## 8. 后置项（本次不做，如实记录）

- 报告全文版本留档（ver 已就绪、digest 链即时可审计，多文件历史留待真实追溯需求）。
- 成员槽位结构化（memberSlot）——建议与定向委派二阶段的 sessionId 登记合并实施；F4 为过渡形态。
- expert 裁决报告 kind 与派发 kind 不一致（类型命名卫生）。
- 插件侧 pendingTags 覆盖语义（二阶段重构注入链时处理）——fresh 降级回填为**已知残险**（R3）。
- 裁决新鲜度仍用时间戳（本次不动）——与投影轮并存为**已知残险**（R11-R14）：F6 在 gate 层兜底等待期修订，waves 层裁决消费仍按时间戳，两层职责边界在实施时写明并补回归提示。
- 派单语境与成员层 subagent 治理（V3-E2E-05）——随定向委派方案 §8 档位上限治理合并实施，不在本方案范围（R8）。
- Expert accept 语义补强（guidance 层，台账 P1-5）——随 guidance 维护处理，不在本方案范围。

已由本修订落实、不再后置（R10 勘误）：台账 P1-2 显式因果链——F5 结构因果引用 decisionId/waveId → dispatch → report 落地；台账 P0-5 用户选择卡——F9 四类恢复规则落地。

## 9. 与定向委派方案的关系

本方案不改变 `docs/dsh-directed-delegation-plan.md` 的结论；waveId 为二阶段「sessionId 登记到稳定槽位」预留模型基础（F4 的倒序回溯是过渡形态，memberSlot 是终局；memberSlot 是否与定向委派二阶段合并实施，留待后续裁决，以定向委派方案实际范围为准）。两方案实施顺序：本方案先行（修复波次机地基），定向委派一阶段在其上实现。

- 写端交集（R11-R11）：F8 的 key 前缀变更落在 persistTagHints 写端与定向委派二阶段「停止写 tagHints/pendingTags/modelHints」清理的交集上——本方案先行实施，定向委派二阶段的清理代码**无需再兼容 w 前缀**。
