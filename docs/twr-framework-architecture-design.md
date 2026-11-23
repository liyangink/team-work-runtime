# TWR 派发与多包状态一致性：架构设计方案

> 状态：**前几版经 Challenger 挑战要求返工；用户已明确选择完整清单、实时 SHA、Lead 授权刷新、多卡按 ID 决定及不设跨波旧 key 守卫，本版待复审、Expert 裁决及方案批准**。这是设计提案，不代表已实施；本文中的接口、事件和状态名称均为拟议内容。证据基于当前工作树，工作树已有其他未提交改动，本轮不改动这些实现。

## 1. 结论、批准范围与代价

建议保留“任务目录即事实、任务锁内推进、平台层负责实际派发”的 v3 架构，但把一张派单的**形成、消息投递、报告提交和评审覆盖**拆成可核对的事实，不能再把“已生成派单”“已有会话映射”或“会话还在”当作“该轮已收到派单”。多包仍按当前策略形成波组、并行工作；重试按每张派单分别对账，不重做已经确认的项。对账无法证明消息是否送达时必须停在明确的“待核对”，不伪装成健康等待，也不冒险另建成员。

拟议实施一次性覆盖：①调度事实与平台对账、续派竞态和部分失败；② deliver/review 的强类型协议与多包返工范围；③每包完整制品清单、文件 SHA-256、原子提交及评审新鲜度；④用户明确授权后由 Lead 受控刷新待审基线，支持多张待决卡按 ID 独立决定；⑤多包波次、依赖、重拆及取消的投影一致性；⑥ F-N2/F-N3 与旧任务切换。实施将涉及 `runtime-v3/`、`dsh/`、`tests/`、现有 Skill、项目文档及清单；**本轮只交设计文档，不实施，不修改可写范围以外文件**。本方案获用户批准前不得作为实现授权；Challenger/Expert 的结论也不能由本文预填。

代价与取舍：任务 journal 将承载新版不可变事实、报告快照和每轮冻结派单正文，文件大小及每次原子重写成本增长；每次续派可能需要一次宿主收单核验；旧任务升级要停旧写者并核对未完成波，异常旧事实需要人工确认。 journal 目前每次提交重写文件，单次工作量随历史字节量增加，累计写放大可能随事件数显著增长；应对不同包数与历史长度实测耗时和文件大小后再确定可接受界限，不虚构收益或阈值。本轮不增加压缩/数据库。冻结正文可能包含用户规则或项目上下文，与任务文件一同存储和备份，禁止附加宿主凭据，访问控制沿用项目目录而不声称加密。部分旧形状的返工评审将被同步拒绝而不是猜测；多张待决卡时输出完整卡片列表且要求指定 ID，依赖旧单卡字段的调用方需要适配。系统**不承诺分布式消息恰好一次**：宿主不能证明某次超时是否收单时，宁可给恢复卡，也不自动重投。无后台轮询、无独立权威状态库、无新模型默认值；除用户明确要求刷新后重经非作者评审及人工确认外，不改变其他流程的人工门、评审与角色决策权。

本文交付暂放 `runtime-v3/` 是派单写入限制，不意味着这是产品长期文档位置；[package.json:43–48](../package.json#L43-L48) 当前包含整个 `runtime-v3/`，未来打包可能携带此文。获批实施后应把长期设计文档按仓库规范安排至文档目录并同步文件清单；此轮不改包规则或清单，也未运行打包验证。

## 2. 证据与根因

### 2.1 派单已存在，不等于新一轮有人执行

- [cli.mjs:1723–1757](../runtime-v3/cli.mjs#L1723-L1757) 在任务锁内为波组生成多个 key，并一次写入派发事件；[cli.mjs:168–175](../runtime-v3/cli.mjs#L168-L175) 将同批事件写入一次 journal 原子替换。任务锁保护了**生成波次**，但 [tw-dispatch.js:201–203](../dsh/tw-dispatch.js#L201-L203) 获取计划后，登记、创建/发送发生在锁外，且逐项进行；任务锁不覆盖平台外部副作用。这里不是“每个包各自写 journal 所致”的部分波原子性问题。
- 历史用户终裁要求“活会话统一等待、不向活会话重投”，并预期原会话结束后由通知触发冷续派（[历史裁决:211–230、241–247](dsh-dispatch-tool-plan.md#L211-L230)）；[后续适配方案:90–106](dsh-020-adaptation-plan.md#L90-L106) 仍保留活会话等待，并将冷恢复不确定性显式化。本方案保留该裁决，不把模拟红例当作推翻历史决定的授权。需要重新验证的是通知链、活/冷判定及回执语义，而非默默改成对活会话发消息。
- 原续派会话只要被 `sessions.get` 返回、父级相同，即判 `live`（[subagent-session.js:18–24](../dsh/subagent-session.js#L18-L24)）。对**新一轮 key**，[tw-dispatch.js:219–237](../dsh/tw-dispatch.js#L219-L237) 登记映射后不检查该轮正文是否收到、不发送，直接返回 `wait`；[85–101](../dsh/tw-dispatch.js#L85-L101) 又将其算作健康等待。原会话可能只有上一轮正文：现有 [dsh-dispatch.test.mjs:641–661](../tests/dsh-dispatch.test.mjs#L641-L661) 正是此夹具，并断言不发送；这是已有行为测试，不是对该语义正确性的证明。
- 本轮在内存用真实绑定层、模拟宿主执行新 key 续派，调用序列仅 `dispatch-plan → agent-map`，无 `sendMessage`，却返回 `action=wait`、`nextAction=wait-children`；针对“未送却声称本轮健康在途”断言的命令退出码为 **1（预期红例）**。现有对应回归 `node --test --test-name-pattern="continuation 且有 expectedAgentId" tests/dsh-dispatch.test.mjs` 本轮运行 **1/1 通过**，它恰好锁定了上述现状。这里直接证明的是**模拟宿主条件下本轮未投递但被表述为健康等待**；历史裁决允许先等上一轮结束，该红例并不证明应对活会话立即补投，也没有真实宿主跟踪证明本次评测事故必然由此触发。真实宿主的活会话含义、收件日志一致性及消息去重能力须在实施前核实（§8）。
- [waves.mjs:178–193](../runtime-v3/waves.mjs#L178-L193) 将有派发但无报告的 key 判为在途；[derive.mjs:205–216](../runtime-v3/derive.mjs#L205-L216) 等待未结波。因此漏投的派单会保持在途，后续波无法前进；现有在途补救仍可能再次把同一个活会话判为等待（[tw-dispatch.js:318–374](../dsh/tw-dispatch.js#L318-L374)）。这类“账上有派单，成员未收到”的状态在本文称为 Ghost Wave。
- 当前先登记确定性会话 ID 是有价值的恢复锚，冷会话也会检查已收文本（[subagent-session.js:27–65](../dsh/subagent-session.js#L27-L65)）；但“查到没有 → 发/建”跨任务锁，两个进程可同时观察到同一缺口。`isConcurrencySafe: false`（[tw-dispatch.js:151–155](../dsh/tw-dispatch.js#L151-L155)）不足以证明跨进程、重启或独立调用的串行，宿主是否对同 ID 创建原子去重也尚无本轮源码/实测依据。不能仅凭确定性 ID 断言绝不重复。
- 当前在途派单根据 journal 信息**重新生成**正文及规则（[cli.mjs:390–416](../runtime-v3/cli.mjs#L390-L416)），而冷收单按正文精确匹配。任务、规则热变或渲染逻辑升级后，本轮重建正文可能与原发送正文不同；这是可从代码推导的风险，未证明本轮已发生。

### 2.2 报告、制品和返工范围的事实不一致

- 评测报告的 F-N1：错误字段 `findings[].packages` 未被拒绝，按未点名全组返工；真实三轮中前两轮恰好两包都需修，第三轮单包意图受轮次上限限制而未再派（[测试报告:160–165](../evals/glm53-latest-eval/results/test-report.md#L160-L165)）。评测记录的隔离复现输出显示只意图点名一包却实际重派两包（[记录:1–26](../evals/glm53-latest-eval/results/raw/repro-finding-package-field-safe.txt#L1-L26)）；本轮没有重跑其要求项目外隔离根的脚本。该评测本身是安全前置不足的受限观察，不是全面宿主验收（[测试报告:5–14](../evals/glm53-latest-eval/results/test-report.md#L5-L14)）。
- 直接原因是 [intake.mjs:222–265](../runtime-v3/intake.mjs#L222-L265) 只验证部分字段，允许未知字段；[waves.mjs:37–39、261–284](../runtime-v3/waves.mjs#L37-L39) 只读取 `package`，且空点名集合解释为全组。具名与未具名 finding 混用时，后者也不会使全组返工；模型原意无法机械可靠推断。当前 Expert rework 明确全组（[waves.mjs:293–300](../runtime-v3/waves.mjs#L293-L300)），不是选择性返工。
- [intake.mjs:120–141、222–231](../runtime-v3/intake.mjs#L120-L141) 的数组类型检查与遍历并非统一先验：错误值可能产生字符遍历、裸异常或不完整拒绝。`recommendedAction` 被错误提示要求但 [intake.mjs:232–240](../runtime-v3/intake.mjs#L232-L240) 未检查它。新版协议需在任何遍历和写入前校验形状，而非仅补一个字段名。
- [intake.mjs:143–165](../runtime-v3/intake.mjs#L143-L165) 在读取交付文件内容之前，仅凭路径/摘要等 payload 比较幂等。相同 key、相同声明但文件内容改变时，代码路径可直接返回旧结果，不会计算新内容摘要；这是源码可见的错误风险，本轮未运行文件级复现。评审同 payload 也在计算当前被审制品摘要之前返回旧回执（[intake.mjs:268–283](../runtime-v3/intake.mjs#L268-L283)）。
- 一次 deliver 先后写快照、报告、产物索引、journal（[intake.mjs:158–195](../runtime-v3/intake.mjs#L158-L195)）；review 先写报告再写 journal（[intake.mjs:278–295](../runtime-v3/intake.mjs#L278-L295)）。[transactions.mjs:16–35](../runtime-v3/persistence/transactions.mjs#L16-L35) 是**单文件**原子替换，不是跨文件事务。中断时报告和 journal 可能不一致；[store.mjs:162–167、236–253](../runtime-v3/store.mjs#L162-L167) 还会读取报告文件及补入无事件的报告。不能把“原子写文件”说成“整次交付原子”。
- 当前正常交付按路径增量替换：只移除本次登记的路径并追加新值（[intake.mjs:184–195](../runtime-v3/intake.mjs#L184-L195)），因此同包先交 X/Y、后只交 X 时 Y 应保留。现有重建按 reportId 从单文件取最新报告，再取其 payload.paths（[store.mjs:236–267](../runtime-v3/store.mjs#L236-L267)）；同 key 的报告文件已被新版覆盖时，旧版独有路径可能消失。第三轮在本项目内独占临时夹具中直接调用现有 `rebuildArtifacts`：以现有 `digestValue` 生成 X1/Y1/X2 的内容摘要和对应快照文件，v1 的 journal 含 X/Y、v2 只含 X、报告文件只保留 v2，观察到只重建 X 且 `degraded=[]`；期望 X/Y 的断言退出码 1（预期红例），夹具已核对并清理。当前测试的同 key v1/v2 都只交同一路径，未覆盖该组合（[测试:87–98](../tests/runtime-v3-invariants.test.mjs#L87-L98)）。这是现有**旧增量语义**的受控夹具实测，非真实宿主或全链验证；用户现已明确选择新完整清单语义，在新协议中 v2 只交 X 就代表 Y 不再属于该包，此旧红例不再是新协议的通过判据。
- 对已交付但磁盘内容变化的包，现有 [waves.mjs:323–335](../runtime-v3/waves.mjs#L323-L335) 仅依报告选择下一波，不检查磁盘；[cli.mjs:1691–1702](../runtime-v3/cli.mjs#L1691-L1702) 的额外恢复分支只针对真实 Owner blocked。本轮以内存夹具核对：现有 `nextWave` 在评审尚未派发、以及未结评审波已作废两种情形均返回 `review`，期望能直接得到重交恢复波的断言退出码 1；这是纯函数现状，并非新版实现或真实宿主验证。用户随后明确选择由 Lead 获授权刷新作为恢复入口，而不是追加跨波旧 key 限制。
- [waves.mjs:240–267](../runtime-v3/waves.mjs#L240-L267) 的挑战覆盖主要按包轮次、专家新鲜度按墙钟，而同一 key 可以修订、同轮内容可能变更；[store.mjs:162–167](../runtime-v3/store.mjs#L162-L167) 对报告按 `at` 排序。[gate.mjs:39–63](../runtime-v3/gate.mjs#L39-L63) 却优先使用 journal seq。不同消费者的“最新”和“覆盖”口径不同，存在同毫秒、时钟回拨及同轮修订风险；这是源码推导，具体事故未实测。

### 2.3 F-N2/F-N3 不只是文字

- F-N2：Skill 让 Lead 读包根相对路径，但技能目录不一定是包根（[SKILL.md:80](../skills/team-work-v3/SKILL.md#L80-L80)，[测试报告:167–171](../evals/glm53-latest-eval/results/test-report.md#L167-L171)）。运行时已有三层规则解析，[rules.mjs:289–310](../runtime-v3/rules.mjs#L289-L310) 的时点规则读取不包含 Lead 根 README。不能简单把路径加 `../../` 并假设所有安装和复制布局一样。
- F-N3：相同计划也会写 `re-planned` 且返回 `replanned: true`（[cli.mjs:2461–2477](../runtime-v3/cli.mjs#L2461-L2477)），[waves.mjs:124–173](../runtime-v3/waves.mjs#L124-L173) 又把任何后续重拆视为解除 blocked 的新承诺。本轮纯函数内存红例：相同包集的 `re-planned` 从 `converge-user` 变为 `produce`，退出码 **1（预期红例）**；这比评测记录的误导性回执更严重。该红例没有模拟完整 CLI 任务，但读写路径已由上述源码对应。

## 3. 方案比选与模块分工

1. **只修 live 分支与禁止未知字段**：改动较小，能覆盖最明显的两条路径，但不能解决发送回执丢失、跨进程重复调用、旧报告同轮修订、跨文件半提交或 F-N3 解除阻塞，排除。
2. **新建独立调度数据库/常驻服务**：可能集中状态，但需要双写迁移和新部署，违反任务目录即事实、standalone 及当前范围；排除。
3. **推荐：现有任务目录内的版本化事实 + 每 key 对账**：只把本需求所需的提交事实收敛到现有 journal，索引可重建；CoreRuntime 决定可执行的波和校验报告，PlatformBinding 负责会话/消息状态，不把宿主状态包装成报告，也不把平台派发循环塞回 CoreRuntime。代价是必须明确事件协议、故障边和旧任务切换。

这不是另造通用事件总线或治理平台。对外仍是现有 `tw`/`tw-dispatch` 深接口；状态计算和严格校验集中在 Runtime，平台具体读会话、投递和错误映射集中在绑定层。单 Owner 是匿名覆盖项而非虚构包，组合评审与 Expert 裁决仍由现有策略决定。

## 4. 派发状态机与并发约束（拟议：以宿主会话为准）

### 4.1 唯一对账依据和身份

依用户补充方向，保留现有的波次事实和 `dispatchKey → sessionId` 映射；**是否已创建会话、是否收到本轮正文，唯一以该 sessionId 对应的 DSH 宿主会话和收单日志核验**。不再设计 Runtime 内部的“先记投递尝试、再记成功或负向结算”的两阶段投递账本；不存在需人工清理的另一本派发状态。有效成员报告是任务工作完成事实，但会话对象、映射或通知本身均不等于报告、评审或验收通过。

现有 [subagent-session.js:6–24、27–60](../dsh/subagent-session.js#L6-L60) 已用 `sessions.get` 判断活会话、`sessionPersistence.stat(sessionId)` 判断冷存在和父级、`open(sessionId, "read")` 读取 `agent/inbox/spliced` 并在 `finally` 关闭；冷路径比较收到的增量/全量正文。当前 live 分支只按会话存在等待，尚未核对本轮收单。历史活会话“等待、不重投”用户裁决保持不变（[历史裁决](dsh-dispatch-tool-plan.md#L211-L230)）。

- 任务锁内生成的同波各条现有 `dispatched` 事件仍作为一批原子写入 journal；无新“派发已接受”事件。每条包含已有 key、waveId、角色、包、模型、可写集，拟补充该 key 首次实际生成的增量/全量派单正文及摘要。恢复以冻结正文核对；规则热更只影响后续新波。新增字段是派单内容快照，**不是**消息是否送达的事实。已有映射优先；首派无映射时按现有确定性算法计算 sessionId，先锁内登记再创建。重入只用已登记或同一确定性 ID；映射相同为幂等，不同映射不得静默覆盖。确需更换已登记会话时，只有宿主可靠证明原会话不存在且不再可能执行后，才按已有断链恢复路径在任务锁内比较并替换映射；不确定或异主均保留原映射并返回恢复卡。原会话模型与本轮任务级/包级模型不一致时，先沿用已有换模型确认卡及用户选择，不以“原会话可访问”绕过确认，也不偷偷重建成另一模型。
- 对当前 sessionId 验证直接父级归属；读取其**自身事件**时排除继承前缀。只把 `agent/inbox/spliced.data.inserted` 内的成员派单消息作为收单证据：当前正文首行含完整、精确的当前 key，且增量或全量正文完整匹配冻结版本；若相同 key 已出现但正文与两种冻结版本均不一致，视为冲突，不能推断未投递后重发。历史正文无冻结快照时只能在可证明原始正文的情况下比较；否则保守给恢复卡，不伪造快照。不要把仅在继承历史或无关文字中出现的 key 当成当前成员收单。`dispatchCard` 确实把 key 写在派单首行（[cli.mjs:1251–1255、1303–1315](../runtime-v3/cli.mjs#L1251-L1255)）；日志完整性、消息边界和 live 事件读取方法仍须实测，不能凭测试桩补造宿主语义。

### 4.2 每项对账与状态转移

| 宿主观察 / 任务事实 | 拟议动作 | 返回 |
| --- | --- | --- |
| 当前 key 已有有效报告 | 不再发送，不依赖会话状态 | 该项 reported，保留报告/制品验收链 |
| 同父 live，日志确认完整本轮正文 | 不重发正文，等待报告/通知 | wait-children；仅证明宿主收单 |
| 同父 live，只见旧轮或不能证明本轮已收 | 不向活会话投递；可靠证明旧轮仍运行且通知可达时等待旧轮结束，否则提示核对 | wait-prior-turn 或 recover，均不得说本轮已送达 |
| 同父 cold，完整日志已含本轮正文 | 不重复本轮正文；可沿用既有轻量续行提醒使冷会话继续 | followup/reminder，仍等有效报告 |
| 同父 cold，可靠完整日志不含本轮，只有旧上下文 | 按同一 sessionId 投冻结的本轮增量 | 自动补投，核对其收单结果 |
| 同父 cold，可靠完整日志无旧上下文 | 按同一 sessionId 投冻结的本轮全量变体 | 自动补投，核对其收单结果 |
| 宿主可靠确认该 sessionId 活/冷均不存在 | 原 ID 登记不变，以该 ID 创建并投完整正文 | 自动补建；创建冲突按同 ID 重新查询，不换 ID 绕过 |
| 异主、读取失败/截断、收单不确定、同 key 内容冲突或宿主状态无法判定 | 不发、不建、不改映射 | recover，列 sessionId、key、原因和核对路径 |

`planned`、`waiting-prior-turn`、`delivered-to-host`、`reported`、`superseded` 是**由任务派单/报告事实及上述实时宿主观察导出的描述**，不是另行落盘的状态表。每次 Lead 正常调用 `tw-dispatch`，包括得到 wait-inflight 的重入，逐条查询未结项；成功项不回滚，能由宿主确认缺失的失败项在本次或下次正常推进时自动恢复。无定时器、无后台轮询，人工门静止时不派发。待完成项均有本轮收单证据才可称 `wait-children`；仅在有可靠旧轮活动及通知证据时返回 `wait-prior-turn`，其余不确定项返回 `recover`。`wait-prior-turn` 是拟给 `tw-dispatch.nextAction` 新增的明确枚举，同时更新其输出 Schema、描述、Lead 指引与调用方兼容处理；对应 `stop` 仍为 `wait-inflight`，汇报“等原轮结束，当前新轮未送”，有可靠通知时正常结束回合，不轮询。不同状态混合时逐项列出，任何 unknown/失败使聚合为 recover，不能被健康项掩盖。本轮首次派单与同 key 重试走同一对账函数，不把“登记了映射”误称“消息已送”。

### 4.3 并发、崩溃和宿主能力边界

1. 波次生成继续在任务锁内读—算—写；同波全部条目一次 journal 原子替换，不是逐条写造成部分波。绑定层复用现有文件锁原语，为同一任务、同一 key 的“查宿主 → 必要时登记 → 创建/发送 → 再核对”持有短时互斥锁；该锁只防并发，不记录/决定收单，也不是持久状态。任务锁仅短持用于重查波有效性和映射，不在持任务锁时等待宿主；锁顺序为先投递锁后任务锁。并发对同 key 的后到者等待/返回可重试，重新查询相同 sessionId，不新造派单或会话。不同 key 各自对账。
2. 进程在登记前、登记后、创建前后、发送后/回执丢失时崩溃，重启直接以原 sessionId 查宿主和收单日志，不需要“关闭上次尝试”的 Runtime 事件；日志可靠确认已收到则不重复正文，可靠确认不存在/未收到则按上表补建或补投。同一轮重复恢复结果应收敛，日志中相同 key 却不同正文必须报告冲突。测试需包含“上一版设计的 attempted 前置步骤已不存在，因此不会因缺少负向结算事件卡住”的对应故障窗口。
3. **不夸大宿主能力**：缺少可用服务、日志不完整、写入可能仍在途或读取一致性不能证明缺失时，短暂未查到记录不等于安全未发送；此时仅凭进程锁过期、`stat` 未命中或本地映射不可断言对方不存在。保留同一 ID 并返回 recover，由原会话/Lead 按宿主实际状态核对；不自动换 ID、删除会话或无证重投。只有在隔离宿主中证明该状态/日志对该场景足以排除迟到接收时，才将对应缺失情况用于自动恢复。现有适配方案已明确 `sendMessage` 无调用方幂等键及接收与日志可见之间的窗口（[适配方案:90–106](dsh-020-adaptation-plan.md#L90-L106)）；因此该设计不承诺跨崩溃消息恰好一次。真实宿主的 live/冷状态、收单日志一致性和是否存在仍在途调用须先验证，不能用 fake 测试替代。
4. `retire` 与在途对账要重核同一波；整波作废先按 key 排序获取投递锁，再短取任务锁，持任务锁时不得反向等待投递锁。未确认旧写者停止或写权限撤销时，不能向新 Owner 派重叠写范围；仅拒绝旧 key 的迟到报告不能阻止旧成员写工作区。无法证明时保留旧事实和文件并提示人工核对。无插件终端继续用 `dispatch-plan` 手工派发、按有效 key 提交报告；因无宿主查询而未知时只能提示人工核对，不能自动假设未送。

## 5. 强类型报告与多包契约（拟议）

单一版本化 Schema 及其同步校验器由 CLI/原生工具共用；以下是**类型示意，不是现有接口**。CLI 仍使用 `--outcome`、`--paths`、`--checks`、`--findings`、`--verdict`；新版任务协议由 Runtime 识别，不让模型填写簿记版本。help、拒绝结果、派单示例和宿主工具参数说明必须同源。

```ts
type Scope = { kind: "all-covered" }
  | { kind: "packages"; ids: [string, ...string[]] };
type Finding = {
  severity: "info" | "risk" | "blocker";
  statement: string;                       // 非空
  disposition?: "must-fix" | "context";   // 返工时必填；其他情况可省
  scope?: Scope;                           // must-fix 必填
};
type Delivery = {
  outcome: "delivered" | "blocked"; summary: string;
  paths: string[]; checks?: { name: string; result: "pass" | "fail" | "not-run" }[];
  unresolved?: string[];
};
type Verdict = { outcome: "accept" | "rework" | "choose-option" | "need-more-evidence" | "escalate-to-user";
  rationale: string; confidence: "low" | "medium" | "high";
  recommendedAction: string; risks?: string[] };
type ReviewBody = { summary: string; recommendation: "accept" | "rework" | "escalate";
  findings?: Finding[] };
// role 是 Runtime 从派单读取的内部判别值，不作为模型提交字段。
type Review = (ReviewBody & { role: "challenger"; verdict?: never })
  | (ReviewBody & { role: "expert"; verdict: Verdict });
```

- `paths` 是本包当前阶段的**完整**交付文件集，而不是本次改动的增量；要保留旧文件须重新列入。所有对象只接受声明的字段（包含嵌套对象）；必要字符串非空，数组元素类型、重复值、空值、非数组和未知枚举一次同步汇总拒绝。`checks.name` 非空且同名冲突拒绝；路径是项目内安全相对路径并经现有防逃逸/可写范围检查；`blocked` 的 paths 必须为空且不覆盖上次有效清单；`delivered` 有可写产物时必须登记完整路径，无产物阶段可按授权提交空清单，但空清单就是当前完整清单，不代表继承旧文件。不存在/不可读/变化中文件给针对路径的拒绝，不留提交事实。
- finding 的返工范围是**模型的语义判断**，不是 Runtime 能凭路径猜出的簿记：只允许 `scope.kind=all-covered` 或非空、唯一的 `packages.ids` 数组。每个 ID 必须精确属于本次派单冻结的、当前仍有效的被审包集合；匿名单 Owner 只用 `all-covered`。字符串拼接、空 ID、重复、大小写误差、未知/未交付/未被本次评审覆盖的 ID 同步拒绝，提示可选 ID、示例及原 key 重试。`findings[].packages`、`package` 等旧形状在**新版**明确拒绝并指出替换写法，绝不静默当成全组；不猜模型意图。
- Challenger 的 `recommendation=rework` 或 Expert 的 `verdict.outcome=rework` 必须有至少一条 `must-fix` finding，每条显式 scope。返工集合 = 所有 `must-fix` 范围的并集；任何一条 `all-covered` 即覆盖本次被审全体；`context` 不改变返工范围。一个 finding 可以点多个包，一包也可有多条 finding。返工内容过滤给每位 Owner 时保留针对该包及 `all-covered` 的必须项，并保留必要的组合上下文，不把非阻塞项变为其他包的返工。这样“一个全局 + 一个具名”不会丢失全局要求。
- **Expert 必须填写完整 verdict，Challenger 禁止 verdict**；角色由锁内派单确定，模型不提交 role，禁止靠调用者自报绕过角色校验。Expert 缺失、`null`、非对象、未知字段、任一必需字段缺失或非法均同步聚合拒绝，`rationale/recommendedAction` 非空、`confidence` 必须合法；拒绝不写报告、不关闭该波，可在原 key 修正后提交，重复合法提交按既有幂等规则处理。Expert 对交付的 `recommendation` 和技术裁决 `verdict` 是不同判断，现有“recommendation=accept、verdict=rework”允许；实际技术返工目标由 verdict=rework 的 must-fix 集合决定，而不是沿用当前无条件全组。`choose-option/need-more-evidence/escalate-to-user` 返回用户决策，不当作 accept。为避免互相矛盾的双结论被静默消费：Expert 的 verdict=accept 只接受 recommendation=accept；verdict=rework 接受 recommendation=accept 或 rework；recommendation=escalate 只能搭配三种待决 verdict。纯 accept 的评审不得携带 must-fix（Expert 的 verdict=rework 例外）；非返工的 finding 可提供有效 scope 作定位，但不触发返工。违反上述组合时同步拒绝并说明，不猜优先级。

  | Expert recommendation | verdict=accept | verdict=rework | verdict=choose-option / need-more-evidence / escalate-to-user |
  | --- | --- | --- | --- |
  | accept | 合法，按 accept 流转 | 合法，须有明确范围的 must-fix，按 verdict 返工 | 合法，不当成 accept，进入对应用户决定 |
  | rework | 拒绝（互相矛盾） | 合法，须有明确范围的 must-fix | 合法，按 verdict 等用户决定，不私自重派 |
  | escalate | 拒绝（互相矛盾） | 拒绝（互相矛盾） | 合法，按 verdict 等用户决定 |

- 新版提交应是一个同步检查点：先完整解析和聚合形状错误，再在任务锁内重读派单、版本、覆盖快照和授权，核对后一次提交；拒绝不写报告/派单事实。参数校验不以“模型应当懂”为前提。涉及本方案的 deliver/review/plan 参数解析必须拒绝未知或重复的单值 flag，保留现有明确允许的多值 flag；错误列位置、原因、可用值和修复示例。 校验通过后规范化时对象键排序；不含重复值的 paths、scope.ids 按集合排序，findings 保序，计划中的包、完成标准等有序数组保序；相同键序变化不产生新版本，重排有序数组视为内容变化。
- 样例：`--findings '[{"severity":"blocker","statement":"接缝不一致","disposition":"must-fix","scope":{"kind":"packages","ids":["draft","merge"]}}]'`。整组返工将 scope 改为 `{"kind":"all-covered"}`，不再由省略字段暗示；具体包 ID 来自该次实际派单。

### 5.1 评审接口的三种形状及取舍

- **沿用隐式归属**：`review({recommendation, findings:[{statement, package?}]})`；调用最短，但缺失、拼错、全局与局部混合无法无歧义区分，且一个问题涉及多包需复制多条；拒绝作为新版契约。
- **整份评审一个总目标**：`review({recommendation, target:{kind, ids?}, findings:[{statement}]})`；组合简单、模型容易填，但不同 finding 的必须修复范围和上下文不能分开表达，可能把一个局部问题扩大到全部总目标；若再加入逐条例外，相当于增加两套相互矛盾的范围来源，因此不选。
- **推荐逐条范围与处置**：`review({recommendation, findings:[{statement, disposition, scope}]})`；范围并集、全局覆盖和非阻塞上下文都有唯一含义，校验器隐藏合法包集、快照与重派计算。代价是每条返工意见多填两个语义字段、旧提交形状须明确转换；这些输入确属审查者判断，不让模型回填可从任务推导的报告 ID 或版本。

## 6. 报告提交、波次投影与恢复

### 6.1 每包完整清单与有效报告

**用户已选定：`tw deliver --paths` 是本包当前阶段的完整交付清单，不再是增量清单。**某包的有效清单恰为该阶段、该包按 journal 提交序选择的**最新一条未作废且 `outcome=delivered` 的报告**中列出的全部路径及其 digest；单 Owner 使用匿名包。报告来源可为正常 Owner 交付，或用户本次明确授权的 §6.2.1 Lead 受控刷新；后者明确记录 Lead/用户决定，不冒充 Owner 声称。`blocked` 报告不替换此前成功清单，但依原 blocked 规则阻止推进，不得借旧清单绕过阻塞；没有符合条件的报告就是尚未交付。

- 例：A 先交 `X,Y`，返工后仍要保留两者就必须再交 `X,Y`；Y 未变时复用相同 digest/快照。新报告只写 `X` 就明确表示 Y **不再是该包的有效交付制品**，不是自动继承、不是待修路径；Y 文件不会因此被自动删除，历史报告和快照仍保留审计。若清单变化同时改变用户批准的产品目标或范围，仍按既有人工确认处理。合法无产物阶段可以空清单，`blocked` 必须空清单；不能用空清单的“纯回应”隐式保留旧文件。
- 每个报告保留其完整规范化路径集及每条 `{path, digestAlgorithm, digest, kind, snapshotRef}`，和报告的 `{stage, package, reportId, ver, commitSeq, origin}`；Owner 来源包含 dispatchKey，Lead 受控刷新来源包含 decisionId，不伪造对方字段。路径重复须拒绝、校验后按路径排序，且必须在该包可写范围内；包间可写集维持现有互斥，相同路径不能被两个活动包同时认领。阶段入口与产物要求仍由既有 Workflow 决定，不要求补齐历史阶段产物。派单、`deliver --help`、错误提示和示例必须明确“清单是完整集合”，避免成员误以为只需传本次修改的文件。Owner 首派/续派正文应由 Runtime 列出该包上一条未作废有效报告的完整路径清单；不存在则明确为空，事实损坏时报告无法确定而不猜。交付成功回执同时列出新完整清单及相对上一份的新增/移出路径；移出只是报告事实，不删除文件，必要的需求范围变更仍由已有确认门处理。
- 报告结算在任务锁内完成同步全量校验：先稳定读取清单全部文件并生成快照，然后一次原子写入包含完整清单的 `report-committed` 事实；`reports/` 和 `artifacts.json` 为可重建视图。相同 key、规范化 payload 和全部路径内容均相同的重试幂等；文件内容或清单变化则是新版本。**用户明确裁决不新增跨波旧 key 禁止守卫**：不能因为 key 的波已被消费或之后已有新波就自动拒绝；异常迟到重交可形成更新版本，由 Lead 检查报告版本链及清单变化并在必要时请用户裁决，不能将这一选择包装成已保证不会覆盖最新清单。报告阶段归属仍取原派单事实而不伪称来自当前新阶段，这不是跨波拒绝。只取最新报告的**整个清单**，不从老报告继承个别路径，也不建立逐路径跨版本来源状态。快照缺失或损坏时保持报告及路径可见，阻止依赖它的评审/门禁并指出恢复方法；不可用旧摘要冒充当前快照。
- `retire` 作废整波时，该波报告整体忽略；受影响包自动回到该包上一条未作废的 `delivered` 报告的完整清单，没有上一条则回到未交付。旧报告、作废报告和快照仍保留审计。该回退只改变**有效基线**，不会自动改写工作区；如作废波曾将 X1 改成 X2，随后实时核验会发现工作区 X2 与回退基线 X1 不一致并阻止通过。若之后新报告只声明 Y，则 Y 是新完整清单，X 不再属于该包，不能把 X 视为继承的待修项；如用户仍需 X，后续完整交付或经用户确认的 Lead 刷新必须把 X 和 Y 一并列出。

#### 已消费旧 key 的明确取舍

用户明确要求：**不按“已消费、跨波或更早 key”新增代码禁止守卫**。现有代码只拒绝不存在、角色不符或已作废的 key（[intake.mjs:105–116](../runtime-v3/intake.mjs#L105-L116)），现有回归也允许未作废旧 key 异内容重交并生成新版本（[回归:386–404](../tests/runtime-v3-waves-regression.test.mjs#L386-L404)）。认为正常串行波中迟到重交很少，若异常出现，Lead 查看版本链与历史快照，必要时请用户决定；不以自动拒绝代替这个人工处置。这里是用户选定的取舍，不是“旧 key 不可能迟到”的事实保证。

例如 d1 交 `[X]`，后续 d2 交 `[X,Y]`，d1 又携 `[X]` 重交且 X 内容已改变：按已选规则 d1 可产生较新的 delivered 版本，其完整清单变成 `[X]`，Y 不再属于当前清单。此后必须按新报告身份使旧评审和人工卡失效，重新走评审/人工门；但不自动补回 Y 或拦截该旧 key。交付回执展示当前清单、版本及相对上一份的增删，便于 Lead 发现异常；若用户仍要 `[X,Y]`，可按 §6.2 用户授权刷新完整清单，或选择历史有效快照处理。相同 key/payload/字节重试仍幂等，直接重显其原报告回执并注明当前有效报告，不从后来索引混装旧回执；历史报告和快照不覆盖、不删除，供追溯。上述风险是按拟议完整清单规则的推演，尚非新版实现实测。

### 6.2 评审、人工门与实际文件 SHA-256

评审和裁决冻结每个活动包的**同一份最新有效完整报告** `{package, reportId, ver, origin, files:[{path,digestAlgorithm,digest,kind,snapshotRef}]}`，其中 origin 要么是真实 Owner dispatchKey，要么是经用户确认的 Lead 刷新 decisionId。全部路径均由该报告提供；评审/裁决派单冻结前，以及 `review`、Expert verdict、`gate`、`decide` 和真正阶段推进/完成前，稳定读取清单中的实际磁盘文件，逐项计算**原始文件字节的 SHA-256**，与报告快照中的 digest 比较。文件缺失、不可读、路径越界/符号链接、读中变化或摘要不一致时，普通评审、普通人工批准和阶段推进同步拒绝通过，列包名、路径、期望/实际摘要（若可靠取得）与恢复指引；不得把未通过项过滤后靠其他文件的 kind 过门。唯一的受控恢复例外是 §6.2.1 的刷新确认：它在锁内与用户实际确认卡的**新候选 SHA** 比较，而非要求已知不一致的旧基线先相等；成功只登记待审内容，不代表旧基线通过或阶段批准。`run`/`gate` 保持只读；需要提交决定或推进的调用在任务锁内重读任务事实，检查失败不写接受报告、不批准、不推进。评审链与人工门仍绑定完整报告身份和清单摘要，报告变化或作废后须按既有新鲜度规则重新评审/确认。

- **摘要算法不能混用**：现有 [intake.mjs:64–68](../runtime-v3/intake.mjs#L64-L68) 对 UTF-8 文本调用 `digestValue`，而 [kernel.mjs:3–13](../policy/kernel.mjs#L3-L13) 先做 JSON 序列化后 SHA-256；它不是磁盘原始字节 SHA-256。本轮以同一文本做纯内存核验，两者不相等。新版报告须显式标记 `digestAlgorithm=sha256-bytes-v1`，对无损读取的磁盘字节计算 64 个十六进制字符（256 位）的摘要；快照保存可无损恢复的原始字节（例如带格式版本的 base64 字段）。复用现有稳定读取、防路径逃逸和防符号链接保护，但读取和恢复链须支持字节而非先转文本；不声称旧摘要可直接与新版摘要相等，旧数据转换见 §7。
- **恢复按有效报告选版本**：当前 [cmdRestore](../runtime-v3/cli.mjs#L2031-L2039) 根据全局最后登记索引选快照，作废波后可能指向 X2。拟调整同一个 `tw restore --task <名> --path <路径>`：默认从该路径所属的**最新未作废有效报告**查快照，先验证快照自身摘要再按该版本恢复原始字节。为按用户裁决保留历史有效版本的人工处理能力，拟增加只读 `--list` 列出该路径可验证的非作废报告版本/摘要，用户明确选择后 Lead 可用 `--source <所选报告版本标识>` 恢复指定版本；不可选作废波或其他任务的快照。恢复历史版本只写文件，不改变或重新加入当前有效清单，回执须明确“历史内容，当前基线未变”；如其字节不同于当前基线，后续门禁仍不通过，须恢复当前快照或按 §6.2.1 获授权刷新。无可证有效报告、归属不唯一或快照缺损时同步拒绝并列原因，不猜版本。该操作会覆盖工作区，须先由用户明确选择并保留需要的修改；恢复后重新计算磁盘 SHA-256。用户也可按 §6.2.1 明确授权 Lead 受控刷新完整清单和当前字节，形成新的待审基线，再走评审/人工门。不能把已作废的 X2 当成 X1 的有效快照，也不能替用户自动覆盖文件。
- **无附加污染状态机**：实时比较结果直接决定该次检查能否通过，不维护“作废文件待修复”的独立账本，也不靠未交路径继承制造待修项。已通过评审、当前报告身份及完整清单未变，且磁盘已恢复到该报告摘要时，既有评审/批准是否仍有效按其绑定指纹决定；新 deliver 或作废导致绑定报告改变时，旧评审和人工卡失效。若用户选择结束任务，仍可安全结束，不能把结束记为批准。
- **并发边界**：稳定读取（包括读前后文件身份/元数据核对）能检测读中变化，但任务锁不控制外部写者；最后一次读取后修改、多个文件之间交替变化或修改后还原（ABA）不能靠检查点完全排除，也不能证明评审者始终读到同一内容。本方案不引入后台监控、不可变工作区或持久污染状态；更强的全过程一致性需要另行授权及宿主能力验证。

### 6.2.1 用户授权的 Lead 受控刷新入口（拟议）

这是用户明确批准的**最小恢复能力**：只把用户确认的当前磁盘字节登记为待审基线，不替 Owner 编写文件、不声称技术正确，也不代替评审或人工批准。它统一解决评审前磁盘变化、评审在途变化以及旧任务无法自动转换；与“按用户选择用 `tw restore` 恢复有效快照”是并列恢复边，不再以未定义的“派 Owner 重交”作为必经恢复手段。

1. **准备卡与接口**：Lead 在收到用户希望刷新的新输入后，调用拟议命令 `tw refresh-artifacts --task <任务> [--package <包>] [--paths-json '<完整路径 JSON 数组>'] --reason <说明>`。单 Owner 不填 package；多包须明确选择一个活动包，不能自动扩大到其他包。若可验证的当前有效报告存在，省略 paths 时使用并展示其完整路径集；如旧任务无法确定完整集、或用户希望改变清单，必须明确提供完整 `--paths-json`，不能扫描目录自行猜测。命令锁内核对当前阶段、包及已批准可写范围、路径安全/去重和产物合同，稳定读取每条文件的原始字节 SHA-256，向用户展示旧报告/旧清单（可确定时）、新完整清单、各路径 SHA、增删、原因及“仅刷新待审基线，不代表通过”。超出已批准范围、文件缺失/不可读、计划损坏或用户尚未给方向时拒绝并给修复指引，不修改文件或交付事实；若清单涉及产品范围变化，仍须现有意图确认门。
2. **等待明确确认**：准备只通过现有 `decision-issued` 机制签发绑定该包、阶段、当前有效报告身份/版本（旧任务不可得则明确标记缺失）、计划指纹、完整路径和 SHA 的确认卡，不改基线。允许与已有人工门卡及其他包的刷新卡同时待决，不因签发刷新卡而作废或批准原卡；这些卡各自按 §6.2.2 的前提核验。重复准备相同卡返回同一标识；条件变化则只令本刷新卡失效、重签并等待新用户输入，不代答。用户实际查看并明确选择后，Lead 才使用现有 `tw decide --task <任务> --decision-id <实际答复的卡> --choice <确认项>`；拒绝/结束按既有卡流程处理，不产生刷新。`reason`、卡 ID 或模型自行声称“已获授权”本身均不能替代用户的新输入。例如先执行 `tw refresh-artifacts --task demo --package a --paths-json '["docs/X.md","docs/Y.md"]' --reason "用户要求刷新待审清单"` 展示卡；仅在用户确认该卡后，才以实际展示的 decision-id 和确认序号调用 `tw decide`。
3. **锁内原子提交与幂等**：确认分支在任务锁内重读卡、计划、当前报告及全部磁盘文件，只有当完整清单和原始字节 SHA 与卡完全一致、范围仍获授权、无冲突写者时才继续。受影响评审仍在途时，本次决定不得提交：Lead 在持任务锁之外等其安全结束，或按既有 `tw retire` 作废未结评审波后重试；已结评审不强行 retire。`decide` 锁内再次检查无在途冲突，若 reviewer 恰好先结束则重算当前报告/清单；若 retire 改变被绑定的有效报告或计划，旧卡失效并须重新确认，不在持锁时嵌套调用 `retire`。快照先写并核验，再以**一次 journal 原子替换**同时提交该卡的用户决定和一个新完整 `delivered` 报告；刷新事实与决定同一提交，不出现仅授权未刷新或已刷新无授权的成功态。具体为同一次原子替换写入带完整授权数据的 `decided(C2)`、对应 `report-committed`，以及本次新基线导致指纹失效的尚未决定卡的 `decided:superseded` 事件；例如受影响人工门 C1 在同一提交中收口，刷新同意绝不冒充 C1 的批准。只依据各卡实际绑定的阶段/包/报告与评审指纹判断失效，不作废无关卡；详情见 §6.2.2。本次刷新的决定事实以该 journal 提交为准，既有其他决定仍按原 `decisions.json` 事实读取，`loadTask/gate/derive` 合并时按 decisionId 去重，不能先单独写 `decisions.json` 冒充原子提交；刷新相关的 reports/artifacts 视图可重建。提交前失败无新基线；对尚未提交的卡，文件/计划/清单变化时拒绝并重新展示，不能拿旧卡授权新内容。提交后回执丢失时，同一 decisionId 和相同选择只重显原报告/摘要、不重复刷新，同时返回当前有效基线及提示后续仍须核验磁盘；即使文件后来变化，也不把这次重显当作新确认。已提交卡被改选项或重用为不同清单时拒绝。正常读写采用现有 task lock 和原子文件原语，外部写入的剩余竞态见 §6.2。
4. **报告身份与后续门禁**：刷新报告的 `kind=deliver`、`outcome=delivered`，来源显式标为 `user-authorized-lead-refresh`，作者为 Lead，`payload.outcome=delivered`、`payload.paths` 为完整清单，并携带 `decisionId`、被替换报告引用（可知时）及每条文件的 SHA/快照；报告 ID 固定为 `refresh-<decisionId>`、ver 为 1；同一 ID 若出现不同内容则报事实冲突，不伪造 Owner dispatchKey、Owner 技术结论或测试通过。该报告由用户决定直接产生而非成员波次；作废其他评审波不作废它，后续以新的合法报告取代。它与普通 Owner deliver 一样参加“本包最新未作废 delivered 报告”选择，但不充当 Owner 新一轮派单或消耗自主 Owner 轮次；`waves/derive/gate` 须识别该来源并按报告身份判断该包已形成**待评审**基线，而不能只筛 `role=owner`、以 Owner 轮次是否大于零判有无基线、或要求它带假 Owner round。刷新触发的 Challenger 展示轮号由当前阶段已登记 Challenger 派单波数量加一确定，Expert 沿用该轮号；它仅是评审序号，不计入 Owner 自主轮次或额外预算，评审覆盖以报告身份/完整清单而非该展示号判定，其他普通流程的轮次规则不变。journal/波身份损坏到无法确定序号时明确报损坏，不猜。刷新不运行检查，不继承或伪报旧内容上的测试通过；既有未解决的失败检查仍按规则阻止，不因刷新消失。刷新后旧 Challenger、Expert 与人工批准指纹失效，必须由非作者 Challenger、Expert 重新评审并重新取得人工确认；缺模型或阶段所需门配置不可用时明确 unresolved 并请用户处理，不自行降级或声称通过。正常非刷新流程的既有拓扑不因此整体更改。
5. **权限边界**：只有 Lead 按用户实际授权发起和确认，成员职责仍仅为 deliver/review；该能力不赋予 Lead 直接更改代码或改写成员结论的权力。当前 [tw-tool.js:19–21、63–77](../dsh/tw-tool.js#L19-L21) 仅透传 CLI 参数，现有人工决定的 `proof.mode` 是 [caller-reported](../runtime-v3/cli.mjs#L1972-L1989)，并无可证实的 CLI 调用者角色强鉴权；因此本方案是**工作流授权与可审计绑定**，不声称能抵抗恶意成员伪造调用或伪造用户输入。DSH 若能提供可验证调用者身份，可在绑定层限制该入口；能力未证实时不得猜测，独立终端依赖可信操作者及项目文件权限。新增通用认证/ACL 不在本轮。

### 6.2.2 多张待决卡的定位、独立核验与收口（用户明确要求）

**不再把最早一张未决卡当成唯一可答卡。**现有 [derive.mjs:78–84](../runtime-v3/derive.mjs#L78-L84) 使用 `openDecisions[0]`，[cli.mjs:1613–1618、1910–1917](../runtime-v3/cli.mjs#L1613-L1618) 也先选最早卡再比较 ID。本轮纯内存夹具直接调用现有 `deriveTask`：C1/C2 同时未决时只返回 C1，收口 C1 后才返回 C2，且无待决列表；对“应同时呈现两卡”的断言退出码 1（预期红例）。这是现状实测，非新版实现已通过。用户已明确授权将其改为以下模型：

1. **统一集合与展示**：从 `decision-issued` 减去该 ID 的 `decided`/`superseded` 事实，派生该任务当前所有结构有效的待决卡，按签发 seq 稳定排序仅用于展示，不赋予第 0 张审批优先权。同一 ID 的不同正文、重复冲突结论或账本损坏要报告状态损坏，不能靠顺序猜测。`deriveTask`、`tw run`、`dispatch-plan/tw-dispatch` 和 `tw decide` 共用同一纯投影；`run` 零写，`dispatch-plan` 在有待决卡时保持 `awaiting-user`，不派发或推进。机器输出 `pendingDecisions:[{decisionId,kind,stage,package?,question,choices,binding,readiness,blockers}]`，每项展示用途、绑定前提/范围、选项与暂时阻碍；人读卡也呈现完整列表。仅一张时可同时保留旧的 `decisionId/card/choices` 兼容字段；多张时省略单卡别名、返回 `needsDecisionId:true`，不得默默把第一张当主卡。尚未落盘收口但自身绑定已失效的卡另列 `staleDecisions` 与重签/取消指引；不可按旧 ID 执行肯定性选择，但允许用户明确选择仅收口该卡的安全取消，必须显式提供该卡 ID；即使有效列表暂时为空，只要存在这类未收口卡，仍返回等待/恢复状态而不推进。临时因文件不符或前置门未决而阻塞但仍可恢复的卡仍计入有效列表和多卡数量。只读展示的实时 SHA 可能随外部写入变化，读取不稳定时标记未知；最终选择必须在写锁内重新核验。相应更新 CLI help、输出 Schema、Lead 指引和 DSH 消费方；多卡输出是用户明确批准的接口变化。
2. **按 ID 定位，不按队首猜**：`tw decide --decision-id <ID> --choice <序号>` 在任务锁内直接定位本任务该 ID，验证卡仍未决、选项属于该卡、所需条件及用户实际答复；不存在/已决定的 ID 返回 `DECISION_STALE` 和修复指引；结构失效卡不得执行旧批准或刷新，但可按其原 ID 明确取消或走重签通道；不拿同序号套用别的卡。**多张有效待决卡时，无论其中几张暂时可执行，只要缺 ID 就同步拒绝并列出全部有效卡 ID/用途**；只有一张时，普通历史卡可保留原无 ID 兼容，意图卡和刷新卡仍必须携带实际被答复的 ID。不同卡独立授权，不把某卡选择解释为另一卡的批准；重复成功的相同 ID/选项幂等重显自身结果，不得重复提交或消费其他卡。
3. **有效但暂时不满足条件 ≠ 已作废**：人工门 C1 绑定 H1，磁盘暂时为 H2 时，C1 仍在待决列表，标明“当前文件与 H1 不符”；尝试批准 C1 时执行 §6.2 实时 SHA 校验并拒绝，不写决定。用户将文件按授权恢复为 H1 后，只要 C1 的报告/评审指纹及其他前提未变，就可用 C1 自己的 ID 批准；同时开放的刷新卡 C2 不能阻止它。C2 则以自身绑定的 H2 与完整清单校验；C2 是 `kind=artifact-refresh`，不得误套普通人工门“必须先等于旧 H1”的判断。磁盘不可读/状态未知时呈现可定位 blocker，不将未知当作匹配，也不擅自作废其他卡。
4. **必要前提不能绕过，但不恢复队首制**：未解决迁移冲突涉及任务事实时，其他依赖该事实的肯定性决定（含刷新和人工批准）显示 `blockedBy` 并拒绝执行；可验证且互不依赖的迁移卡仍各自按 ID 处理。待确认的意图/角色/包计划是相关推进和刷新提交的先决条件，未确认不能凭另一卡绕过；能安全准备的卡仍展示并标注被哪张卡阻挡，确认意图后重新核验各自绑定。若冲突使包范围不可证明，刷新准备直接拒绝而不是猜范围。安全取消仅收口所选刷新卡、不授权推进，可以在不改变被保护事实的情况下处理；任务、阶段与不可跳过门仍按 Workflow 重新判定。这是固定门禁前提，不引入通用卡片调度器。
5. **刷新确认的单次原子提交**：Lead 对 C2 的真实用户确认到达后，在同一任务锁内按 ID 重读 C2、当前阶段/计划/该包报告、候选路径 SHA、在途波及全部未决卡；待满足迁移/意图等先决条件后，先预计算新报告提交后的各卡绑定指纹。一次原子 journal 写入 `decided(C2=refresh)`、Lead 来源的 `report-committed(H2)`、以及**所有因本次新基线而实际失效的未决卡**的 `decided:superseded`；其中覆盖受影响包的阶段人工门 C1 必须被收口，不写 `accept(C1)`，其旧批准更不能复用。已决定的历史人工门保留审计，但因报告/评审指纹变化不得复用；重新经过 Challenger、Expert 后才签发新的人工门。提交前失败保留旧卡和旧基线，提交后丢回执重试仅重显原结果。旧卡答复、缺 ID、多卡竞态及刷新/签门并发均锁内复核，绝不跨卡消费。
6. **取消、过期和多包隔离**：选择取消 C2 只追加 `decided(C2=cancel)`，不写报告、不取消 C1 或其他有效卡；返回仍待决卡与各自阻碍。C2 确认前文件从 H2 再变时，旧 C2 不能确认，但用户可按旧 ID 选择仅取消该卡；在用户新输入触发的写通道内原子收口旧 C2 并签 C2′、等待用户重新查看/确认，只改变 C2 自身，不把新文件当已授权，也不关闭 C1。相同范围、报告、计划和候选 SHA 的重复准备返回原 C2；并发准备依锁内事实幂等。A、B 的刷新卡按各自包的报告、路径 SHA 和共享必要计划/意图前提绑定：确认 A 只收口其自身及真正依赖 A 而失效的门卡；B 的报告、文件和共享前提未变时，B 卡仍可按自己的 ID 决定。若 B 卡确实绑定了变化的全局前提，则明确标为过期并按其自身重签；不可把“另一张卡先决定”本身当失效理由。任一卡仍待决时任务不派发、不越过人工门；用户确认后仍待非作者审查和新人工门。

7. **门禁与全部消费者同源**：现有 [gate.mjs:174–198](../runtime-v3/gate.mjs#L174-L198) 分别取某门“最新签发”和“最新 accept”，多卡时不能把不同 ID 的卡和答复拼成一组。新投影只把 `accepted decisionId → 对应 issued 卡 → 该卡 gateId/范围/指纹` 完整匹配且对当前事实仍新鲜的批准用于门禁；`superseded/cancel` 不算 accept，C2 的刷新决定也不满足 C1 的门。所有需要签卡、重签或查未决卡的路径（包括意图卡、角色/模型卡、`plan`、迁移、`run`、`dispatch-plan` 与 `decide`）都按卡类型和 ID 查询同一集合；不再调用隐式“最早卡”或把最新的另一种卡当自身卡。纯 `derive/gate` 接收同一事实投影和只读文件核验结果，写入口在锁内重新核验。即使已有一张批准，只要其他有效/待收口卡或其 Workflow 必需条件未解决，阶段仍不推进。

### 6.3 F-N2 与 F-N3

- **规则**：不再指示模型根据不确定的技能 Base directory 猜包根。复用现有 `tw help` 路径，在其 Lead 指引中由运行时按既有“用户公共优先、包内回退、项目追加”规则解析并返回 Lead 通用 README；对应时点继续输出时点规则，成员卡不注入 Lead 正文。Skill 改为“先调用 help 读取返回的 Lead 通用规则，具体时点以工具返回为准”，不新增并行规则副本。缺失/不可读沿用现有警告和回退，不猜绝对路径。以真实包布局、技能复制布局及无插件终端夹具验证；若需要改变现有规则层优先级，超出本方案须另行批准。
- **计划回执与 blocked**：锁内将完整、已物化的计划规范化比较；同内容普通 `plan` 返回 `changed:false`、原计划摘要及“未变更”，不写 `re-planned`、不重签卡、也不解除 blocked。真正变化返回 `changed:true` 并提交新计划，**计划变更本身不构成任何 blocked 包的恢复授权**：对照计划计算包级增删改只作展示和检查，修改 B、增加依赖包、甚至单独修改 A 的定义都不会自动解除 A 的 blocked；被恢复的包必须由已获用户明确方向的 Lead 显式选择。现有 [waves.mjs:137–148、165–173](../runtime-v3/waves.mjs#L137-L148) 以全局重拆 seq 解除所有包，必须移除该口径。
- **按包恢复卡（拟议）**：现有 `produceBlocked` 是非决定型静止提示（[cli.mjs:1813–1821](../runtime-v3/cli.mjs#L1813-L1821)）。新模型先把每包 blocked 报告与计划版本作为只读 `blockedPackages` 证据展示，并与已有 `pendingDecisions` 并列返回，不隐藏其他卡；收到用户对某包的明确方向后，Lead 用 `tw plan --resolve-blocked '<JSON>' --blocked-ref <展示的阻塞引用>` 准备该包候选。JSON 为 `{ "package":"a", "action":"retry", "reason":"方向说明" }`，action 为 `retry|remove`；候选重拆计划（如有）由现有 `--packages` 提供。每次只准备一个包，不填不解除任何其他包；单 Owner 保留 `tw-dispatch` 的 writables / `tw dispatch-plan --writable` 通道，但也必须绑定其实际 blocked 报告和用户方向，不强造包 ID。
- 准备只在锁内核验目标 blocked 报告 key/ver、当前计划及候选计划，签发 `kind=package-recovery` 的 `decision-issued`，不提交计划或解除 blocked；该卡是 §6.2.2 的正式待决卡，和其他包恢复卡/刷新卡一起展示，用户确认后以其实际 `decisionId` 调 `tw decide`，不再由 `plan` 绕开 ID 决定直接生效。恢复卡绑定目标包、blocked key/ver、原计划版本、候选计划/范围和动作，锁内再核实时不依赖任务中最早的另一张卡。多包各自卡可按 ID 任意决定；若某次改变了另一卡实际依赖的共享计划/意图前提，后者提示失效或先完成意图确认，不能被静默重套到新范围。
- **范围、原子与幂等**：`retry` 的目标包须存在于新计划，且正常依赖满足后才能派发；删除或改名 blocked 旧包须用户明确批准范围变化并用 `remove` 精确点名，原报告/快照保留审计，新名称不继承旧包制品。确认时在任务锁内按选中 ID 重读 blocked、计划及权限，原子提交该卡 `decided`、必要的完整计划和仅针对所选包的 `blocked-resolved {decisionId, package, dispatchKey, reportVersion, action, planDigest}`；卡过期、报告版本变化、动作冲突、引用不存在或任一检查失败时不写这些事实。若计划变化触发既有意图确认，恢复事实先待确认，确认前不解除 blocked 或派发；其他包不受影响。相同卡与选择重试返回原回执，不能把旧授权套给新的 blocked 版本；取消只收口该卡。计划未变化但恢复获确认时返回 `changed:false` 与该包结果，不声称计划更新。
- `blocked-ref` 来自展示的阻塞证据，绑定阶段、包、报告 key/version 和计划 seq；它只为避免迟到回复被误配，不要求用户手抄底层簿记，也不证明用户授权。卡的 `decisionId` 属于统一待决集合；重复准备相同候选返回同一卡，候选变更只重签相关卡。范围有争议或并发使计划不可证明时保留原事实，返回最新证据和恢复指引。
- 计划快照与 `re-planned` 当前也是分文件写（[cli.mjs:2461–2465](../runtime-v3/cli.mjs#L2461-L2465)），新版同样将完整计划作为 journal 一次提交的事实，`packages.json` 变可重建视图。否则崩溃于两次写之间仍会造成包事实和 blocked 恢复口径分裂。

## 7. 旧任务、升级和回退

1. 新任务直接使用完整清单和 `sha256-bytes-v1`；旧任务保留原始报告、journal 和旧快照，不把旧的增量 `paths` 直接伪装成完整清单，也不把旧 `digestValue` 当作文件字节哈希。已经完成的历史任务不因升级自动重新打开。
2. 升级前停止旧版写者及未完成的外部调用，并在获授权的隔离环境备份。对仍在进行的旧任务，在静止且无未决人工卡时核对**当前阶段、活动包**的最新未作废报告、原 `artifacts.json`、历史已接受事件及快照：只有原报告清单与可验证的当前登记清单一致，且旧 journal 中没有该活动包被遗漏的已登记路径，才可把它作为既有报告的完整清单候选；不据当前工作区补造清单，也不把旧快照按时间猜到新报告。旧索引缺失/损坏、报告被覆盖、候选集合不一致、相关旧事件缺少 paths 或证据不全时，保留旧任务不推进；若项目范围及活动包计划仍可验证，Lead 可在用户明确方向后依 §6.2.1 提供完整路径并签发刷新确认卡，不猜旧清单、不伪造 Owner 交付。若任务范围/计划本身不可读而无法验证权限，仍须先由用户处理该阻碍。该核对只用于安全切换，不保留跨轮逐路径继承机制。
3. 旧快照是 UTF-8 文本：先用原 `digestValue(snapshot.content)` 验证旧 digest，再把已验证快照文本编码为 UTF-8 字节，计算其 `sha256-bytes-v1`，并与实际磁盘字节核对。只有清单及每条快照均可验证且当前文件字节一致，才将该旧报告以相同报告身份映射为新版有效完整基线；保留旧指纹及可审计的算法转换信息，不能直接修改旧报告或用当前文件反推历史快照。若原始字节无法由旧文本快照还原、文件不一致或 snapshot 缺损，则拒绝自动转换，给出经授权恢复已知快照或由 Lead 按 §6.2.1 获用户确认后刷新完整清单的方向。不能验证的旧文件不猜补。
4. 算法/清单转换改变绑定指纹时，原评审链和人工批准按既有新鲜度规则重新评审/确认；不将旧批准静默挪给不同摘要。派发在途、旧卡待决或宿主收单不明时先按原事实恢复，不能确定则暂停；用户尚未批准范围或没有安全写权限时不自动迁移。
5. 证据完整可自动切换时，以一次版本化迁移事实固定旧报告身份、新算法摘要和完整清单，索引可由事实重建。若旧事实不足而用户确认 Lead 刷新，将必要的协议切换标记、用户决定及该包新完整 delivered 报告一次原子追加，不能先假装旧基线已确认；原旧事实留存，新报告来源为 Lead 刷新，后续按同一 decisionId 幂等恢复。切换后不承诺旧代码可安全回写：回退须停止写者并基于实施前备份恢复或另建任务，不让旧代码覆盖新版事实。异常旧数据、备份恢复与新旧版本互斥必须先在隔离副本测试。

## 8. 实施顺序和受影响位置

1. **先拿宿主事实并建立回归红例**：在获授权的隔离环境验证会话可读状态、live 是否可接收、收单日志何时持久、查询一致性、相同 ID 并发创建、发送回执丢失后的行为。已有 [subagent-session.js](../dsh/subagent-session.js) 和 [dsh-dispatch.test.mjs](../tests/dsh-dispatch.test.mjs) 的 mock 不是实际宿主保证；登记映射后、调用宿主之前或之后崩溃时，不借助 Runtime 的投递结算事件，直接以原 sessionId 对账；宿主状态无法可靠证明未接收或旧调用不会迟到时仍是 unknown；无可靠证据的分支维持 unknown，不强推自动发送。先把 §2 的派发/重拆红例、F-N1 和多包报告中断写成正式测试；旧“同 key 增量重建”红例作为迁移证据保留，新协议改按完整清单的用户裁决编写预期。
2. **定义版本化 Schema 与事实投影**：在 `runtime-v3/intake.mjs`、`store.mjs`、`waves.mjs`、`derive.mjs`、`gate.mjs` 和 CLI 建立共享校验/提交/最新完整报告投影；实现 `refresh-artifacts` 准备卡、待决卡集合与按 ID 决定、刷新及受影响旧门的同一原子提交、Lead 来源报告和历史 `restore` 查询，更新帮助和派单；刷新报告参与待评审判定但不伪造 Owner 轮次。旧 key 按用户裁决不增加跨波拒绝。明确新增内部模块及文件清单，在新版模式先让旧的错误形状红，再修复至绿。所有拒绝走现有同步工具返回，不以第二层隐藏校验替代。
3. **对账与有界恢复**：`dsh/tw-dispatch.js`、`dsh/subagent-session.js` 对接冻结派单与逐 key 串行，区别首次发送/重试/live/cold/foreign/unknown；只在可靠条件下自动补发。更新输出 Schema、失败卡和 Lead 指引，不新增普通定时器。
4. **计划/规则修正及旧任务切换**：`cli.mjs`、`rules.mjs` 和 `skills/team-work-v3/` 修复 F-N2/F-N3；旧任务读取和迁移按 §7 执行。涉及新增长期文件或移动文档时同步 `docs/file-inventory.json`；同步仓库规范/帮助描述，避免对旧格式或已部署宿主作无证兼容承诺。
5. **交叉集成**：将多包 DAG、重新评审、人工门、作废与故障恢复串起来；复核最终 diff 不覆盖已有工作，再运行定向、完整套件和获授权的隔离宿主接缝。实施前不能声称实施测试通过或承诺上线版本、耗时、人力成本。

## 9. 验证矩阵（实施阶段拟执行，除 §2 已写明的测试外均未运行）

| 主题 | 故障/输入与触发顺序 | 通过判据 |
| --- | --- | --- |
| Ghost Wave | 原会话 live 但只有上一轮正文；新 key 续派 | 不对活会话重投；有可靠旧轮活动/通知证据时 `wait-prior-turn`，结束后冷续派；无证据时 unknown/recover；禁止未收本轮却 `wait-children` |
| 同 key 重试 | 已收本轮、已报告、已登记未创建、冷会话已有/无上下文 | 对账同 ID；不重复整轮；可证明缺失的项自动恢复，已报告项不重做 |
| 并发 | 两进程屏障同时创建/发送同 key；续派与 retire 同时发生；同波两包一成一败；旧成员报告后仍尝试写文件 | 每 key 最多一个活动投递尝试；不误重建；成功项保留，仅失败项恢复；未证实旧写者停写或写权撤销前不派重叠写范围的新 Owner |
| 宿主直接对账 | 映射登记后调用宿主前崩溃；宿主接收后回执丢失；活/冷日志只含旧 key、本轮 key、同 key 不同正文；宿主读错、异主、超时、晚到 | 仅查询原 sessionId 的会话与收单事件；可靠缺失且旧调用不可能继续时自动补发，不依赖本地负向结算；已收不重发正文，冲突/未知为 recover |
| 波事实 | 波组提交前后 kill，journal 原子替换及损坏输入 | 完整原波或无波；同一次推进不生成第二波；不出现只含部分成员的波 |
| Deliver | 重复相同 payload/相同内容；同 payload 内容变化；不同路径同 digest；文件中途变化；blocked 带路径 | 前者同回执，内容变更新 ver；路径归属正确；后两类同步拒绝且无错误提交 |
| Lead 授权刷新 | 评审前 SHA 不符；未结评审期间变化并等待或 retire；旧任务元数据不足但包范围可证 | `tw refresh-artifacts` 展示完整清单与候选 SHA，用户明确答复卡后一次产生 Lead 来源待审报告；不要求不可达的新 Owner 波；正常 Challenger、Expert 及人工门不能跳过 |
| 多卡按 ID 决定 | 原人工门 C1=H1 与刷新 C2=H2 同时待决；先分别尝试缺 ID、C1 与 C2 | run/dispatch-plan 列出两卡并静止；缺 ID 同步拒绝列全部 ID；磁盘 H2 时 C1 拒绝但不作废；C2 可按其 ID 独立确认 |
| 刷新后旧门收口 | C1 与 C2 同时有效，用户确认 C2，故障注入在单次 journal 替换前后 | C2 决定、新基线及受影响 C1 superseded 要么均无、要么同时可见；不得把 C2 同意记为 C1 批准；重新 Challenger、Expert 和新人工门，旧 C1 迟到答复拒绝 |
| 恢复 C1 与取消 C2 | C1=H1、C2=H2；用户选择将磁盘恢复 H1 并答 C1，再取消 C2 | C1 以原 ID 可批准且不自动批准/取消 C2；C2 取消只落自身决定，不改变 C1；仍有未收口卡时不推进 |
| 刷新卡重签 | C2 准备后磁盘 H2 变 H3；重复准备相同卡、取消或重签；C1 同时未决 | 旧 C2 不可确认，但可按旧 ID 安全取消；同一候选重复准备返回相同 ID；重签只收口 C2 并签 C2′，须用户重新确认；C1 保留并按 H1 自身条件核验 |
| 多包多卡和前置门 | A/B 各有刷新卡，交叉并发确认；另设未决意图卡或迁移冲突卡 | A/B 无共享变化时各自 ID 可确认且互不作废；只关闭真正受影响的阶段门；意图/迁移未解决时相关肯定决定拒绝并显示 blockedBy，不因选择别卡绕过 |
| 多卡兼容与故障 | 单张普通/意图/刷新卡、多张含暂时阻塞卡；重复选择、错误 ID、旧 ID、序号碰撞、journal 损坏 | 单张普通卡保留无 ID 兼容，意图/刷新卡仍需 ID；多卡缺 ID 返回完整候选并拒绝；不同卡不得互相消费，损坏明确停止不猜 |
| 刷新授权和原子性 | 未调用确认、旧卡重放、路径/内容/计划在确认前变化、跨包/越权路径、快照写失败、journal 写前后中断 | 未确认/过期/越权均无新基线；成功时决定与报告同一原子提交；同 decisionId 重试返回同一报告；无虚构 Owner、无伪造测试通过；现有 caller-reported 不证明能自动防伪用户输入 |
| 旧 key 用户取舍 | d1 交 X，d2 交 X/Y 后 d1 迟到以新 X 交 X；重复同 payload 且同文件字节 | 不因跨波自动拒绝，d1 新版本可成为最新完整清单 X 且 Y 移出；旧评审/人工指纹失效，Lead 从可审计版本链核查，用户可选择历史恢复或授权刷新；相同字节重试只重显原回执 |
| 历史快照恢复 | 已作废波覆盖工作区；当前路径存在但用户选择更老非作废报告；候选损坏/归属冲突 | 默认恢复当前有效报告，`--list/--source` 只允许明确选择可验证的非作废历史；恢复历史不自动更改有效清单；损坏/歧义拒绝并保留文件 |
| 报告事务 | 对快照、journal、索引每一步注入写错/崩溃；提交后回执丢失 | 未提交不改变有效态；已提交可同 key 对账；索引损坏重建等价；缺快照明确阻塞，不回退假内容 |
| 每包完整清单 | A 的 k1/v1 交 X/Y；同 key v2 及跨 key 返工分别交 X/Y 或仅交 X；损坏/删除索引后重建 | 写 X/Y 才保留两项且未变 Y 复用 digest；仅写 X 时有效集合仅 X，Y 磁盘文件不自动删除；重建结果与最新有效整份报告一致 |
| 作废波完整回退 | A 原交 X1/Y1；并行波 A 交 X2/Y1、B 尚未交付时整波作废；B 后续完成且 X2 仍在磁盘 | A 整包回到原 X1/Y1；review/verdict/gate/decide 均检查实际 X，发现 X2 ≠ X1 即拒绝；默认 restore 恢复 X1，或用户确认后 Lead 完整刷新 X/Y 并重新评审；新报告明确只交 Y 则 X 不再属于该包，不删除磁盘文件 |
| 旧任务和摘要转换 | 原报告清单与旧索引一致；旧增量 v1=X/Y、v2=X；索引缺失、快照被覆盖/损坏；旧 UTF-8 文本和当前磁盘字节不一致 | 仅对证据完整且一致者验证旧 digest 后换算原始字节 SHA-256；其他保留不确定，范围可核验时由用户确认 Lead 完整刷新，不把旧增量报告当完整清单 |
| 协议与 Expert | findings 旧字段/拼接名/非数组、非法 checks；Expert 缺 verdict、null、缺字段、非法枚举，Challenger 带 verdict；所有合法及矛盾双结论组合 | 同步聚合拒绝，不写报告或关闭波；同 key 修正后通过；Expert 的 accept recommendation + rework verdict 仍合法并精确返工 |
| 返工语义 | 单包、多包、全组、全组+具名混合、context 与 must-fix 混合；Expert rework | 目标等于 must-fix 并集，context 不扩大；未点名已覆盖包不重派；依赖包不被误解锁 |
| 原始字节 SHA 与新鲜度 | 比较 SHA-256(磁盘字节) 与旧 digestValue(JSON 字符串)；交付后直接改文件、批准等待期改写、读取中变化/缺失/符号链接、恢复后重试及 ABA | 两算法显式区分；评审/裁决/人工门检查整份有效清单，差异或不可读拒绝且指出路径；run/gate 零写；如实报告读取后的竞态与 ABA 限制 |
| 按包阻塞恢复 | A blocked 仅改 B；改 A 但未指定恢复；明确选择 A retry；A、B 均阻塞只选 A；同卡重放/旧卡迟到/新 blocked 版本；删除或改名 A；同内容普通重拆；并发 plan/review | 只改 B 或未选 A 时 A 继续阻塞；分别准备 A/B 的 `package-recovery` 卡并按各自 decisionId 确认，仅被选且 key/version 匹配的包解除；其他包仍阻塞；重放不消费新版本，删除须显式确认；普通同内容零恢复事实 |
| 规则路径 | 包内、复制型 Skill、无插件终端、用户覆盖、项目追加及缺文件 | 不依赖 cwd/猜相对路径；help 返回正确层级通用规则，成员不收 Lead 正文；回退和警告可见 |
| 迁移与回退 | 静止旧任务、未决卡、旧未结波、损坏报告/缺快照、迁移前后中断、并发旧写者 | 可证明者切换并保持投影；不确定者保留原件且给恢复；重跑幂等；旧写者停用才能切换 |
| 开销和保密 | 合成不同包数和历史长度的任务，反复投递/写报告；检查冻结正文 | 记录 journal 大小、重放/写入耗时及环境；不声称达到未约定指标；无新增宿主凭据进事件 |
| 集成验收 | 两个并行包（A 先交 X/Y，返工仍需两者故完整提交 X/Y）→ 挑战选择性返工 → Expert → 依赖汇总 → 组合复审 → 人工门 | 清单与字节摘要在整条链一致；漏写 Y 明确表示移出清单，绝不伪称继续覆盖；无提前过门；静止门不派发，用户确认后才推进；全套报告实际成功/失败/跳过数 |

待获取的证据：真实宿主对 live、已完成/空壳状态和事件日志的定义；查询能否证明“某次发送绝不会再落地”；是否提供按 key 幂等收件或持久消息 ID。验证必须使用经批准的隔离项目与非真实用户数据，先证明真实工作区/HOME 的写保护；不复用此前安全前置不满足的模型演练入口。若宿主不支持可靠判定，仍可安全工作，但 unknown 需要原会话或用户协助核对，不能承诺全自动恢复。

### 可复现的三个纯内存红例

下面的命令在仓库根执行，不创建项目文件；它们的退出码 1 是针对现状的**预期断言失败**，而非修复已经通过。第一个使用真实绑定层但宿主为最小桩，后两个是纯函数夹具；不能替代宿主实测或 CLI 全链测试。

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { twDispatchDefinition } from './dsh/tw-dispatch.js';
const calls=[];
const wave={dispatchKey:'d2-new',waveId:'wv2',kind:'respond',role:'owner',package:'a',round:2,continuation:true,expectedAgentId:'child-old',prompt:'SECOND ROUND',modelRef:{provider:'p',modelName:'m'}};
const ctx={sessions:{get:id=>id==='child-old'?{header:{parentSession:'parent'}}:null},subagents:{sendMessage:async()=>{calls.push('send');return 'msg'}},sessionPersistence:{}};
const runTw=async args=>{calls.push(args[0]);return args[0]==='dispatch-plan'?{ok:true,task:'demo',stage:'design',stop:null,waves:[wave]}:{ok:true}};
const out=await twDispatchDefinition(ctx,{runTw}).execute({task:'demo'},{agent:{id:'parent',session:{header:{cwd:process.cwd()}}}});
console.log(JSON.stringify({calls,action:out.dispatched?.[0]?.action,nextAction:out.nextAction}));
assert.notEqual(out.nextAction,'wait-children','本轮未收单却宣称健康在途');
NODE
```

实测输出是 `calls=["dispatch-plan","agent-map"]`、`action="wait"`、`nextAction="wait-children"`。新设计允许明示等待原轮或报告 unknown，但保留“活会话不投递”的既有用户裁决。

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { nextWave } from './runtime-v3/waves.mjs';
const packages=[{id:'a',dependsOn:[]}], sp={core:false,maxRounds:3};
const reports=[{reportId:'deliver-d1',dispatchKey:'d1',role:'owner',kind:'deliver',package:'a',round:1,payload:{outcome:'blocked',summary:'原范围无法完成'},at:'t'}];
const journal=[{seq:1,type:'dispatched',detail:{key:'d1',waveId:'wv1',role:'owner',package:'a'}},{seq:2,type:'report-accepted',detail:{reportId:'deliver-d1',dispatchKey:'d1'}}];
const before=nextWave({scenePolicy:sp,packages,reports,journal});
const after=nextWave({scenePolicy:sp,packages,reports,journal:[...journal,{seq:3,type:'re-planned',detail:{packages:['a']}}]});
console.log(JSON.stringify({before:before.kind,after:after.kind,afterOwners:after.owners}));
assert.equal(after.kind,'converge-user','同内容重复登记不应解除 blocked');
NODE
```

实测输出 `before="converge-user"`、`after="produce"`，即仅附加重拆事件即可改变纯函数投影；具体同计划 CLI 调用写该事件的证据见 §2.3。

第三项只改变包 B 的定义，A 的 blocked 报告保持不变：

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { effectiveBlockedSet } from './runtime-v3/waves.mjs';
const oldPlan=[{id:'a',done:['a 不变']},{id:'b',done:['b 旧']}];
const newPlan=[{id:'a',done:['a 不变']},{id:'b',done:['b 新']}];
const reports=[{reportId:'r-a',dispatchKey:'d-a',role:'owner',kind:'deliver',package:'a',payload:{outcome:'blocked',summary:'阻塞'},at:'t'}];
const journal=[{seq:1,type:'dispatched',detail:{key:'d-a',role:'owner',package:'a',waveId:'wv1'}},{seq:2,type:'report-accepted',detail:{reportId:'r-a',dispatchKey:'d-a'}}];
const before=[...effectiveBlockedSet({journal,reports,packages:oldPlan}).keys()];
const after=[...effectiveBlockedSet({journal:[...journal,{seq:3,type:'re-planned',detail:{packages:['a','b'],changed:['b']}}],reports,packages:newPlan}).keys()];
console.log(JSON.stringify({before,after}));
assert.deepEqual(after,['a'],'只改 B 不应解除 A 的阻塞');
NODE
```

第二轮实测输出 `{"before":["a"],"after":[]}`、退出码 1。它验证现有纯函数会被任一重拆事件影响；本轮没有运行含真实包计划写入的隔离 CLI 全链。

## 10. 本次设计验证与尚未覆盖

第一轮已阅读源码及评测证据，运行两项不写文件的纯内存红例（Ghost 续派接缝、同计划重拆解除 blocked，退出码均为 1，属有意断言失败）及现有 live 续派回归 1 项通过；第二轮另外运行了“只改 B 导致 A blocked 消失”的纯函数红例（退出码 1，属有意断言失败），并根据用户补充方向将投递恢复改为直接核验宿主 sessionId 与收单日志；第三轮使用真实摘要与独占夹具复现旧增量语义下同 key 多路径重建漏 Y（退出码 1，属有意断言失败）；第四轮根据用户决定改为完整清单，并用纯内存校验确认旧 `digestValue` 与原始文件字节 SHA-256 不相等；第五轮独立运行 `nextWave` 纯函数夹具，评审派发前及评审波作废后均返回 review（期望直接派重交的断言为预期红例），用户随后决定由 Lead 获授权刷新、且不增加跨波旧 key 守卫；第六轮纯内存核验 C1/C2 同时未决时现有投影只返回 C1、收口后才返回 C2（要求同时列出两卡的断言为预期红例），用户随后明确要求按 decisionId 独立审批多卡；没有运行实施后的验证矩阵。没有重跑评测的项目外脚本，没有修改产品代码、运行全量套件、启动真实模型或验证真实宿主；前序方案经过 Challenger 挑战并返工，本版尚待复审、Expert 裁决和人工批准。以上未验证事项是后续验收工作，不应表述为已通过。
