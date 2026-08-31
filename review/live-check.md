# live 复验：docs/team-work-runtime-model.md 代码审查报告（live-check）

- 任务：live-rework-verify ｜ 阶段：code-review ｜ 角色：owner ｜ 轮次：4 ｜ 波：wv8
- 审查对象：docs/team-work-runtime-model.md（工作模型基线文档，135 行，未跟踪新文件）
- 证据事实（均已亲读）：runtime-v3/{waves,derive,gate,intake,store,cli}.mjs（当前工作区已含 v3.4 波身份与恢复实施）；docs/wave-identity-recovery-plan.md（已批准实施基线，8 blocker 修订并入正文）；docs/v2-e2e-findings.md V3-E2E-01~05 台账；docs/runtime-v3-charter.md（P1–P6/I1–I10）；docs/runtime-roadmap.md；workflow/definitions/engineering.json；team-work/policies/default.json；tests/runtime-v3-waves-regression.test.mjs（新增回归，1011 行）
- 实机复验：npm test 全量套件 180 项 → **179 pass / 0 fail / 1 skip**（skip 为 schemastry 环境预期跳过）；新增 waves-regression 套件覆盖波身份方案 §5 验收表第 1–14 行（台账 V3-E2E-01~04 确定性复现 + F1~F9 + 五类鲁棒性），第 15 行（真实 DSH 人工门 rework 复验）即本任务语境
- 方法：模型文档全部断言逐条对照实施后代码事实 + 已批准方案 + 台账根因，双向核验（文档→代码、方案→文档）；未读取 .team-work 内部状态

## 处置边界声明（Lead 附注确认，v3）

**本任务为审查任务，不代改被审文档。** 下列事实经交付记录与文件内容核实：

1. **可写范围**：本任务（live-rework-verify）所有波次的可写路径仅 review/live-check.md；被审文档 docs/team-work-runtime-model.md 不在本任务任何包的可写范围——deliver 会拒绝范围外路径，本报告不以任何方式代改模型文档。
2. **落实归属**：模型文档的 7 处修订已由用户裁决归 **wave-identity-recovery-plan §6 步骤 8「R6 下游文档同步收尾批次」**（该方案已批准，F7/R6 明列「模型基线两处措辞（波串行、报告不可变）」同步项），不在本复验任务内。
3. **交付物修订已完成**：本报告 v2（轮次 2）与 v1（轮次 1）内容不同——v2 新增 R3/I5~I7、补全 B1/R1/I1 修订文本、行号勘误 5 处、撤销 1 处错误断言（见修订记录）；交付 digest 可证（v1 0c6010… → v2 085fbd…）。Challenger 第二轮所述「本版与上轮被审版本逐字相同（135 行）」的对象是被审文档（模型文档恰为 135 行），非本交付物。
4. **7 条 findings 的修订文本已在 v2 齐备**（见「二、发现」各条「修订文本」），Challenger 复审请以本交付物（review/live-check.md）为核对对象，按边界确认处置即可。

## 修订记录

- **v4**（轮次 4，波 wv8，响应 Challenger accept + Expert accept + 用户 rework）：① Challenger 复审 accept，1 条 info（R1 介入点混列层面）已采纳——R1 修订文本改为两层叙述（阶段波次循环内介入点 vs Lead/plan 侧审批卡），见 R1 条；② Expert 裁决 accept，三条 info 与既有 I1（L106 停波补 converge-user 出口）、R3（L102 等齐限定同波 + 补 DAG 分层语义）、I3（L116 轮次措辞对齐 F2 权威源）一一对应确认，不阻塞；「接受为工作模型基线并冻结」建议记录在案，三条表述修正并入 R6 收尾批次、不必单独返工；③ file-inventory.json:78 登记经 grep 核实属实（Expert 声明成立）；④ 用户决定 rework = 实机验证人工门返工链（只派一批 respond、Owner 续原会话修订、Expert 重裁续原 Expert、重呈人工门卡）——本轮即该验证执行载体。
- **v1**（轮次 1）：首轮审查，产出 B1/R1/R2 + I1~I4 共 1 blocker 2 risk 4 info。
- **v3**（轮次 3，响应 Challenger 第二轮 rework）：本轮 findings 为 v2 七条的原样重列（含「逐字相同」判断）；核实：v2 交付物与 v1 内容不同（digest 证据），7 条修订文本 v2 已齐备；被审文档不在本任务可写范围，落实归属 R6 收尾批次（用户裁决）——处置边界见头部声明，本轮无新增发现，v2 内容全部保留。
- **v2**（轮次 2，响应 Challenger rework，7 条 findings 逐条核实——**全部属实**，无一条被反驳）：① 新增 R3（组合评审等齐 L102 + 每包一张 L64 与实现矛盾，Challenger 两条行号引用准确）；② 新增 I5（L116 成员槽位未标注实施状态）、I6（L80 人工门只提制品指纹，漏评审链指纹）、I7（开篇叙事三件 vs 台账四件）；③ F1/F3/F4 与 v1 的 B1/I1/R1 同源，按 Challenger 更精确的修正文本补全（F3 补「未结波在途 wait-inflight」停止条件；F4 补 escalate 升级裁决卡）；④ **行号勘误（grep 逐行核对，Challenger 全部行号准确）**：v1 的 R1 引用「决定条目 model.md:78」实为 **L84**、R2 引用「门禁 model.md:82」实为 **L88**、I3 引用「轮次算法 model.md:119」实为 **L116**、I4 引用「没有后台补写 model.md:113」实为 **L112**、正面确认第 5 条引用「决定→波 model.md:78」实为 **L84**；⑤ **v1 正面确认第 9 条「组合评审等齐…不提前派 review」断言不成立**，按 R3 修正为「仅无依赖并行波成立」；v1 正面确认第 1 条补注第四件事故（I7）。

## 一、结论

**模型文档整体与修复后的系统模型高度一致，可作为工作模型基线继续使用；但存在 1 项 blocker 级事实性漂移（L68 报告不可变与已实施的 F7 版本链冲突）、3 项 risk 级准确性缺口（L102/L64 组合评审与依赖语义、L122 介入点清单、L88 门禁清单漏路由门）与 7 项 info 级精度问题。全部修订文本均已给出（见各发现「修订文本」），处置归属已明确（波身份方案 §6 步骤 8 下游文档同步），修订成本极低、不改变文档其余结论。**

**复审结论（Challenger accept + Expert accept，v4）**：Challenger 复审确认 v3 事实全部成立（179/180 测试、路由门、F5 结构因果、F6 双指纹、blocked/僵局卡、行号与修订文本齐备），7 条 findings 逐条吸收并同源标注、处置边界归属 R6 合理，无新增实质缺陷（1 条 info 已采纳，见 R1）。Expert 裁决 accept：逐项核对实现与规约后核心声明成立（四种波与串行/并行语义、组合评审等齐、轮次唯一投影、双指纹、成员续派、门禁纯推导、决定→波结构因果、最小分配单元=阶段、两条能力缺口属实、事故叙事与台账吻合、脱敏合规、file-inventory.json:78 已登记）；三条 info 级表述修正（停止派波条件补 converge-user 出口、等齐范围限定同波并补 DAG 分层、轮次投影措辞对齐 F2 权威源）与既有 I1/R3/I3 对应、不阻塞，建议接受为工作模型基线并冻结、修正并入下一次文档修订（R6 收尾批次）。用户决定 rework 为实机验证人工门返工链，本轮（轮次 4 波 wv8）即验证载体；交付后由 Expert 重裁（续原 Expert 会话）、重呈人工门卡。

## 二、发现

### B1（必须修订）｜L68「报告是事实，一经登记就不再改写」与实施后代码、已批准方案三向冲突（Challenger F1 同源确认）

- **文档断言**（model.md:68）：报告一经登记就不再改写。
- **代码事实**（intake.mjs，F7 已实施）：同 key 同 payloadDigest → 幂等返回（ver 不变、不追加事件）；同 key 不同 payload → **ver+1 覆盖单文件报告**，journal 追加 report-accepted（detail 带 ver + payloadDigest）。报告身份 = key+ver，历史版本经 journal digest 链即时可审计（全文留档后置）。「不可改写」已不成立——报告正文可被修订（ver 递增），不可变的是 journal 事件流与已登记快照。
- **方案事实**（wave-identity-recovery-plan.md F7/R6，已批准）：明确要求模型基线同步修订为「身份 = key+ver、digest 链即时可审计、全文留档后置」，列为 §6 步骤 8 下游文档同步项（「模型基线两处措辞（波串行、报告不可变）」）。
- **漂移状态确认**：代码已合入 F7、方案已批准（§6 步骤 1 完成），但模型文档 L68 仍未修订——文档滞后于代码。
- **修订文本（方案 F7 已给出）**：「报告是事实：身份 = key+ver，最新版正文落单文件，历史版本经 journal 的 ver+payloadDigest 链即时可审计；全文留档为后置项」。L60「波与波之间永远是串行的」与 F1 守卫一致（存在任何未 superseded 未结波一律 wait-inflight），无需改动——此即方案所说「两处措辞」中已一致的一处。
- **处置归属**：wave-identity-recovery-plan §6 步骤 8（下游文档与清单同步）；本任务可写范围仅 review/live-check.md，此处只报告不代改。

### R1（建议修订）｜L122「用户只在两个点上以决定形式介入」与现状不符且与文档自身术语表矛盾（Challenger F4 同源确认）

- **文档断言**（model.md:122）：用户只在两个点介入——轮次耗尽卡（追加一轮或结束）和人工门卡（接受或返工）。
- **文档内部矛盾**：术语表「决定」条目（model.md:84）自己就列了「人工门接受或返工、**升档审批**、追加轮次」——正文 L122 却称只有两个点。
- **代码事实**：现状用户以决定形式介入的点至少八个：① 轮次耗尽卡（converge-user：追加一轮/结束）；② **升级裁决卡**（waves.mjs escalateP 分支：challenger 建议升级用户裁决 / expert 结论为非 accept|rework → converge-user，Challenger F4 点名，v1 漏列）；③ 人工门卡（accept/rework）；④ 升档审批卡（v3.2 已有：批准升档/降回默认档）；⑤ 路由判定卡（E2E/SPEC route，gate blocker awaitingUser）；⑥ F9 迁移冲突卡（异 digest 多报告选择保留版本）；⑦ F5 返工僵局卡（接受现状/仅重派未修包/结束任务）；⑧ F5 blocked 仲裁卡（重派 respond/结束任务）。
- **修订文本（采纳 Challenger 复审 info，v4 分层叙述消除层面混淆）**：分两层——① **阶段波次循环内介入点（运行期用户卡）**：轮次耗尽卡、升级裁决卡（escalate）、人工门卡、F5 僵局卡、F5 blocked 卡、F9 迁移冲突卡；② **Lead/plan 侧审批卡**：升档审批卡、路由判定卡（E2E/SPEC route）。两层性质不同（前者由波次推进自动呈卡并等待 decide，后者由 Lead 发起或代用户回答），L122 按两层分别叙述，避免把运行期卡片与审批类操作混列为同一清单。

### R2（建议修订）｜门禁定义遗漏路由门（v1 行号勘误后）

- **文档断言**（model.md:88，v1 误引 82）：门禁 = 产出物在场、检查通过、非作者评审在场、核心场景有 Expert 裁决、人工门凭证。
- **代码事实**（gate.mjs gateCheck）：门禁共六类检查，除上述五项外还有第 5 项**路由门**——阶段带 route（e2e/spec）时显式判定，未决时产生 awaitingUser blocker（route: "e2e"/"spec"），skip 必须带可定位依据（AGENTS 规则 15）。
- **修订文本**：门禁条目补「路由门（SPEC/E2E 显式判定，skip 需可定位依据；仅路由阶段）」。
- **说明**：模型文档面向「工作模型」概念层，路由门此前未列入可视为省略；但门禁是逐项列举，遗漏一项会低估门禁构成，建议补齐。

### R3（新增，Challenger F2）｜L102「组合评审等全部包交付后才派」与 L64「每包一张」在依赖场景下与实现矛盾

- **文档断言**（model.md:102）：Challenger 的组合评审**等全部包交付后才派**……先交的包什么都不亏，后面只是等同伴；（model.md:64）多包时一个波产生多张——每包一张。
- **代码事实**（waves.mjs）：波选择优先级 **1) awaitingReview（已交付、未过评审、未被点名的活跃包 → 组合评审）先于 4) pending（未交付且依赖已满足 → produce）**（waves.mjs:259-266 vs 284）；produce 波只派 depsOk 的包（依赖未解锁的包不在派发之列）。因此：无依赖的并行波（一次派发全部包 + inflight 守卫同波内等齐）下「等全部包交付」成立；**有依赖时，先交付的包会在下游包解锁交付前被单独组合评审**，「等全部包」不成立；「每包一张」仅对已解锁包成立。
- **验证**：waves-regression 测试「门槛 2：多包部分交付」只覆盖无依赖波；依赖场景（DAG 分层）由 waves.mjs 优先级 1>4 直接决定，无反向证据。
- **修订文本**：L102 改为「组合评审等待当前波内全部派发包交付后才派；依赖未解锁、尚未派发的包不在等待之列（评审反馈优先于开新范围，DAG 分层解锁）」；L64 限定「多包时一个波产生多张——每个已解锁/被包含的包一张，这些派发并行执行」。
- **说明**：v1 正面确认第 9 条据此撤销（原断言「不提前派 review」仅对无依赖波成立）。

### I1（更新，Challenger F3）｜L106「波次机只在一种情况下停止派波：没有活跃包了」不精确

- **代码事实**（waves.mjs）：停止派波三种情况——① 无活跃包（kind=gate，随后门禁检查）；② 需用户仲裁（kind=converge-user：轮次耗尽 / escalate / 裁决非 accept|rework / F5 blocked / 僵局 / F9 迁移冲突待决）——此时**活跃包仍在**但停波等用户；③ 存在未结波在途（wait-inflight，波与波串行，重复 run 返回在途卡）。
- **修订文本**：改为「波次机在三种情况下停止派波：无活跃包（转门禁）、需用户仲裁（converge-user，等用户决定）、存在未结波在途（wait-inflight）。波结束不等于阶段结束——阶段要等门禁通过，才流转到下一阶段」。「门禁是阶段流转的唯一出口」仍成立（converge-user/wait-inflight 均不流转阶段）。

### I2｜L53「波……一共四种」宜注明边界

- **代码事实**：nextWave 的 kind 集合 = produce/respond/review/verdict 四种**派发波** + gate/converge-user 两种**停止派波状态**。文档把波定义为「该谁干活、干什么」的派发动作，口径自洽，但「一共四种」字面会让人以为波次机只输出四种 kind。
- **修订文本**：加注「另有 gate 与 converge-user 两种停止派波状态」。

### I3｜L116「轮次只有一种算法（从波投影）」措辞与实现细节有偏差

- **代码事实**（waves.mjs projectRounds，F2）：轮次唯一算法 = 每包 max(已交付报告 round)；round **由派发事件抄写**（P4，成员不填），produce/respond = 该包最大派发 round + 1；waveId 经 dispatchKey join journal 解析（同 key 多 ver 取最大 ver 防御）。「从波投影」方向正确（纯投影、无第二算法），但轮次值的来源是「派发抄写 + max 投影」。
- **修订文本**：改为「轮次只有一种算法：每包 max(已交付报告 round)，round 由派发事件抄写（P4）」。

### I4｜L112「没有后台补写，没有异步对账」宜补 agents.json 边界声明

- **代码事实**：任务目录内除推导事实文件（scope/intent/artifacts/reports/decisions/journal/packages）外，还有任务级 agents.json（平台绑定注册表：mappings/modelHints/tagHints/pendingTags）。插件对 pendingTags→mappings 的回填是 fire-and-forget 异步写（失败降级 warn、不阻塞派发）。该文件**不参与状态推导**（推导只读 journal/reports/artifacts/decisions/scope/intent），字面与「没有后台补写」不冲突，但读者易误解「任务目录里没有异步写」。
- **修订文本**：在「底层设计」一节补一句边界声明：agents.json 属平台绑定映射（成员会话寻址/模型快照），不参与状态推导，回填失败只降级不阻塞。

### I5（新增，Challenger F5）｜L116「成员有独立槽位」未标注实施状态，读者会误认为已存在

- **文档断言**（model.md:116）：建模方向是给概念补上实体身份：波有稳定波身份，**成员有独立槽位**，轮次只有一种算法。
- **代码/方案事实**：memberSlot 是**后置项**（wave-identity-recovery-plan §8「成员槽位结构化（memberSlot）——建议与定向委派二阶段合并实施」、§9「F4 的倒序回溯是过渡形态，memberSlot 是终局」）；现状为 agents.json 映射 + F4 倒序回溯（沿 journal 倒序找同角色同包最近有映射的 key）的过渡形态。波身份（waveId，F1）与轮次唯一算法（F2）已实施，成员槽位未实施——三者并列叙述会误导读者。
- **修订文本**：L116 补标注「成员身份现状为 agents.json 映射 + 倒序回溯过渡形态，独立槽位（memberSlot）为终局后置项」。

### I6（新增，Challenger F6）｜L80 人工门只提制品指纹，漏评审链指纹

- **文档断言**（model.md:80）：评审和人工门绑定的是当时那一版的指纹——制品变了，旧结论自动失效。
- **代码事实**（gate.mjs，F6）：人工门决定绑定**双指纹**——artifactFingerprint（每包「包→指纹」映射）+ reviewFingerprint（评审链复合 digest：最新 Challenger 报告与核心场景最新 Expert 报告的复合，以 journal seq 为第一全序）；等待期 Challenger/Expert 报告同 key 修订（ver+1）同样使旧决定失效并重呈卡（humanDecisionFresh + 未决分支签发指纹比对，测试 F6-2「等待期改写 Challenger 报告 → 旧卡自动作废、重签新卡」实证）。文档只提制品指纹不完整。
- **修订文本**：L80 补一句「人工门同时绑定评审链指纹（reviewFingerprint），等待期评审报告变化同样使旧决定失效并重呈卡」。

### I7（新增，Challenger F7）｜开头叙事「三件事」与台账四件事故口径不一致

- **文档断言**（model.md:7）：一个方案评审任务……发生了三件看起来互不相干的事。
- **台账事实**（v2-e2e-findings.md V3-E2E-01~04，wave-identity-recovery-plan §1 明说）：一次真实任务的方案评审在人工门返工后连续暴露**四个**故障——第四件（V3-E2E-04）为「人工门决定后，成员用决定前的旧 dispatchKey 修改并重交，Runtime 跳过应有的 respond 直接进评审」；其教训恰是文档 L84「决定 → 波的因果，而不是时间上的先后」的实证来源（deliveredAfter 时间判据被 F5 结构因果替代）。
- **修订文本**：L7 补注「另有第四件故障（决定前旧 key 重交被误认返工完成、跳过 respond），其教训见下文「决定」条目」——避免读者误以为事故全集为三件。

## 三、正面确认（逐条亲验，全部属实）

1. **开篇事故叙述与台账对应**：L7–L11 三件与 V3-E2E-01（返工单重复派发，缺在途守卫）、V3-E2E-02（续派断链，身份回溯只看紧邻 key）、V3-E2E-03（评审覆盖判假死循环，轮次口径分叉）吻合；L13 根因叙述（波/成员/轮次无实体身份、靠偶然一致字段代偿）与台账根因一致。**注**：台账实为四件（V3-E2E-04），见 I7。
2. **波定义与实现一致**：L53–L58 四种派发波（produce/respond/review/verdict，verdict 仅核心场景）与 waves.mjs nextWave 一致；L60「波与波永远串行」与 F1 统一守卫（inflightBatch）一致，且被波身份方案 §2 引用为模型基线；L64「多包时一个波产生多张、并行执行」与 wave.owners 多包共享 waveId 一致（依赖限定见 R3）。
3. **轮次定义与实现一致**：L72「轮次绑定包、打磨代次、上限三轮」与 policy maxAutonomousRounds=3、F2 投影一致；「报告数可被重复提交污染，循环数不会」在 F7 幂等 + F2 max 投影下成立（重复提交不抬轮）。
4. **制品指纹绑定与实现一致**：L80「制品变了，旧结论自动失效」与 F5/F6 双指纹一致（评审链指纹部分见 I6）；评审覆盖判定（reviewedPackages 投影快照 + 裁决新鲜度）同源成立。
5. **决定→波因果与实现一致**：L84「一次返工决定会引发新一轮返工波」与 F5 reworkBinding（causeDecisionId 结构因果引用 decisionId → dispatch → report，决定前旧 key 重交结构性无效）一致；台账 P1-2 落地。
6. **门禁推导性与实现一致**：L88「门禁没有实体、每次从事实推导」与 gateCheck 纯函数一致（路由门遗漏见 R2）。
7. **成员模型与过渡形态一致**：L76「成员持续存在、续派=同一个人、平台层对应可续聊子会话」与 F4 倒序回溯 + DSH send_message 续派一致；memberSlot 为方案后置终局（实施状态标注见 I5）。
8. **能力边界两缺口均属实**：L128「只跑一轮无法表达」（现状仅策略常量 3 + extra-round 追加制，无预算参数）；L130「介入阶段与验收终点绑成一个参数」（open --entry → completion=through-stage，中间介入+走完需另开任务）——与 cli.mjs cmdOpen 一致。
9. **组合评审等齐（限定版）与轮次真实语义**：无依赖并行波下「等当前波内全部派发包交付」成立（inflight 守卫 + awaitingReview 判定）；依赖场景见 R3。波结束≠阶段结束成立。
10. **脱敏合规**：全文无项目名、provider、账号、内网地址等环境特定信息（AGENTS 文档脱敏要求满足）。
11. **实机复验**：当前工作区 runtime-v3 已含 v3.4 实施（waves/derive/gate/intake/cli 均有 F1–F9 注释与实现），全量测试 179/180 绿；本任务派单即波身份方案 §6 步骤 7 真实复验载体（d 前缀 key + waveId 出卡 + 续派身份解析，均符合 F1/F8 形态）。

## 四、未决与归属

1. B1 修订归属波身份方案 §6 步骤 8（下游文档同步）；建议随步骤 8 一并执行，或在步骤 8 前先行修订以消除误导（方案已批准、代码已合入，无技术障碍）。
2. R1/R2/R3 与 I1–I7 属文档自身完备性，无代码影响；若采纳，建议一并放入步骤 8 同步批次。R3 修正同时涉及 L64 与 L102 两处，与 B1（L68）同批执行。
3. 本报告未读取 .team-work 内部状态，任务自身波次历史不影响上述结论；文档审查证据全部来自仓库内代码、方案、台账与测试事实。
4. 本报告行号均已用 grep 逐行核对（L64/L68/L80/L84/L88/L102/L106/L112/L116/L122）；v1 的两处行号引用错误已在修订记录④中勘误。
