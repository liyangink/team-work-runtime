# TWR 架构重构验收结果

**实机验收未通过安全前置，已停止；独立 DSH 会话和真实模型请求均为 0。** 第二轮以同一源码基线复跑 TWR CLI 合成场景，**7/7 通过**，新增同 key 和跨 key 漏列对照，并收紧 F-N1 断言；第一轮已复跑 18 个相关自动测试文件，**467 项：458 通过、0 失败、9 跳过**。这些证据覆盖七组验收要求的可离线部分，不证明真实成员接单或整次实机验收通过。

## 1. 实机为何停止，验证了哪个版本

| 检查 | 实际结果 |
| --- | --- |
| 历史 DSH 无 Web 入口 | 原样执行固定拒绝入口，返回 `DISABLED` / 退出码 2；没有启动 DSH。未修改或绕过入口。见[安全原始结果](code/safety-evidence.md)。 |
| 真实仓库与 HOME 写保护 | 当前外层 Bash 子进程可对真实仓库已有普通文件做写模式打开；没有写字节。真实仓库的拒写前提不可证，未继续对真实 HOME 做探测，也未验证实际 DSH 子进程继承。离线子、孙 Node 进程的虚构项目写入和合成 HOME 继承只作正对照。 |
| 工作树与实际测试加载 | Git 基线 `adc94e183f3501d26a2cfd4eb40d255506a35f3c`，取其上当前未提交源码，包声明 1.1.5；批准设计 SHA-256 为 `6668e09bb5686267e5f7b58040e76c18bb3b1adebaa9d7e4c9e45cfbfcb21b8b`。81 个指定包文件逐一与副本一致，两种运行模式的包树摘要均为 `fda98038f0120992cd646efd315ba554a013859973010170a3056bc25836d723`，运行前后取样范围内源/副本字节一致。Node v24.15.0 / Darwin arm64；直接调用副本入口。见 [CLI 起始指纹](code/cli-evidence.jsonl#L1)、[结束复核](code/cli-evidence.jsonl#L153-L155)、[自动套件首行](code/automated.tap.txt#L1)；**实机所加载的插件版本/摘要未核验**，不能用声明版本或离线摘要补填。 |
| 模型权限、请求头与角色登记 | 内层 Lead、Owner A/B、Challenger、Expert 的精确 GLM-5.3/max 宿主权限均**未核验**，这些角色的实际 request/header 和真实任务角色登记均**不存在本轮样本**。CLI 的三个角色条目、包模型、派发快照和映射都是虚构数据，不作实机模型证据。外层当前测试 Owner 和后续独立 Challenger 使用用户另批的 GPT-6.2-Sol/max；不派外层 Expert，不把 Web 协调会话计为被测 Lead。 |

## 2. 七组验收要求与已观察结果

这里的 **CLI** 是进程级真实 Node/TWR CLI 入口、虚构项目及脚本输入；**模拟**是实际 DSH 绑定逻辑对可控宿主替身；**自动**是本轮重跑的既有纯函数、CLI 调用函数或文件夹具用例。三者均未调用真实模型。两轮 ID/原文可在[首轮 CLI 回执](code/cli-evidence.jsonl)和[第二轮 CLI 回执](code/cli-round2.jsonl)按步名复查；两轮包树摘要相同，第二轮未改产品、未重跑既有自动套件。回执中的卡片选择只发生于虚构用例。

| 组 | 目标问题与受影响流程 | 本轮证据及结论 |
| --- | --- | --- |
| ① 派单与恢复 | 原波首派/登记/收单解耦；Ghost Wave、活/冷续派、冻结原文、不确定恢复 | **CLI**：首波 A/B 手工登记、同 key 同映射幂等；部分交付时同波等待、未先派评审。修改虚构项目的 Owner 规则后，在途重入的普通/全量两份原文及 SHA 逐字节等于派出时，新派单才含新规则。[CLI 9–30、39–40](code/cli-evidence.jsonl#L9-L40)。**模拟**：首派及逐项收单/活冷/异主/未知见 [TAP 70–94](code/automated.tap.txt#L427-L571)。实机映射、实际成员/通知与冷持久化时序未测；F-7 另列。 |
| ② 强类型与返工 | deliver/review 协议、F-N1、按包/全组范围、F-9 定点、G-3 正文交接 | **CLI**：无效 checks 汇总三处错误；`findings[].packages` 是合法 finding 中唯一额外字段，CLI 返回 INTAKE_REJECTED 和该字段的专项拒绝；原评审 key 留在途，只删该字段即可在原 key 首次登记。[第二轮 F-N1 回执](code/cli-round2.jsonl#L25-L27)。Expert 缺 verdict 拒绝。同一 Challenger 评审的 A/B 具名项和 all-covered 项：两包各含自己与全组原文，不含另一包条目。Expert 在 Challenger 接受后只点 A：下一波只有 A，正文含原始 finding；另案 Expert 的 A/B 具名 + all-covered 同样逐包正确，非必修背景不混入。两种正文均核对，Challenger/Expert 摘要故意不重复 finding 原文。[CLI 17–28、35–40、72–74](code/cli-evidence.jsonl#L17-L74)。**自动**：F-9 阻塞与依赖组合见 [TAP 433、452](code/automated.tap.txt#L2672)，[依赖完整链](code/automated.tap.txt#L2786)。实机成员收到并据此工作未测；遗留提示用语另列。 |
| ③ 完整清单/新鲜度 | 原始字节、同 key 幂等、内容/清单变化、评审与人工批准 F-2 | **CLI**：A 交两文件，其中一个含 NUL、无效 UTF-8 与 CRLF；从原始字节独立复算 SHA；同 key、同字节重排路径幂等，改变字节升版，多轮重列的 Y 摘要不变。同 key 修订和跨 key 返工只交 X 时，Y 移出有效清单，原磁盘字节不变；之后改写 Y 仍可按不含 Y 的新清单评审。[同 key](code/cli-round2.jsonl#L67-L74) · [跨 key](code/cli-round2.jsonl#L89-L99)。磁盘变化后旧人工门拒绝，待决未取消。[CLI 14–23、32–34、97–105](code/cli-evidence.jsonl#L14-L34)、[漂移回执](code/cli-evidence.jsonl#L97-L105)。**自动**：F-2 同 key 回拨、旧新评审不同 ID 混合均使指纹/旧批准失效，[TAP 177](code/automated.tap.txt#L1069)、[272–276](code/automated.tap.txt#L1706-L1730)；原始二进制恢复 [217](code/automated.tap.txt#L1376)。并发文件读后变化/ABA 及真实评审者所读版本未测。 |
| ④ 授权刷新、多卡与前置 | 旧门与 A/B 刷新同时待决，按卡 ID、F-11 前置门、刷新原子性 | **CLI**：三卡并存静止、缺 ID 列全，磁盘不符拒批原门但保留卡；先确认队尾 B，只收口其卡和受影响旧人工门，不误答 A；B 重放不重复提交、不消费 A，最后 A 按自身 ID 确认，重审、重裁并签新人工门，且留其待决。[CLI 94–117](code/cli-evidence.jsonl#L94-L117)。**自动**：迁移/意图未决阻止批准并零写入、收口后可批 [TAP 181–185](code/automated.tap.txt#L1093-L1117)；刷新写错、回执丢失为合成注入 [213–214](code/automated.tap.txt#L1352-L1358)。未验证真实用户与宿主的角色鉴权；caller-reported 不是鉴权。 |
| ⑤ 计划与按包恢复 | F-N3 相同计划/异包变化不解阻，按包单独决策；F-10 包模型回滚重建 | **CLI**：两包 blocked，blocked 带路径先被拒绝；同计划报告不变且引用不变；只改 B、重新确认意图后两包仍阻塞；两卡中先确认 A、只取消 B，重派 A 并带上前轮阻塞原文。[CLI 132–149](code/cli-evidence.jsonl#L132-L149)。**自动**：F-10 两包模型回滚、删视图重建完整计划及定点写失败幂等通过 [TAP 178–180](code/automated.tap.txt#L1075-L1087)；这些模型值只作为测试数据，未发给任何 provider。G-2 排除，不能推断决定视图风险已关闭。 |
| ⑥ 作废、迁移与 F-N2 | 作废回退旧制品、历史快照、旧任务兼容、Lead 不猜 Skill 基目录 | **CLI**：虚构 HOME 下 `tw help` 从包内回退、以用户层覆盖并叠加同名项目规则。[CLI 150–152](code/cli-evidence.jsonl#L150-L152)。**自动**：部分交付后作废、迟到 key 拒绝 [TAP 448–449](code/automated.tap.txt#L2762-L2768)，历史与当前快照 [209、217](code/automated.tap.txt#L1328-L1376)，旧字节迁移与增量歧义 [215–216](code/automated.tap.txt#L1364-L1370)，三层规则和 Lead 专道 [371–375](code/automated.tap.txt#L2300-L2324)。真实宿主复制型技能的 help 选源、真实旧写者、跨版本回退未执行。 |
| ⑦ 多包闭环 | 两包交付、审查、选择性返工、重审/裁决与人门 | **CLI**：两包交付 → Challenger 要求两包按规则返工 → 两包重新完整交付 → Challenger 接受 → Expert 仅点 A → A 重交两件 → Challenger 新审 → Expert 新裁 → 虚构用户卡前静止，模拟答复后完成。E2E 仅验证合成项目显式跳过路线，不运行产品 E2E。[CLI 9–52](code/cli-evidence.jsonl#L9-L52)。**自动**：依赖汇总与收敛直通 [TAP 139](code/automated.tap.txt#L841)，定点返工不误解锁依赖 [452](code/automated.tap.txt#L2786)；同一案例未联合验证定点返工、依赖汇总和用户门。**没有真实成员连续跑完该闭环。** |

## 3. 设计 §9 逐项矩阵

判定只适用于列出的运行。没有观察到的故障不算通过。表中所报项沿用[冻结设计的 28 个矩阵主题](../../runtime-v3/twr-framework-architecture-design.md#L207-L240)。

| 设计主题 | 已执行证据与判定 | 限制或缺口 |
| --- | --- | --- |
| Ghost Wave | 模拟，活会话只见旧轮时不重投；明确旧活动及通知才等旧轮，未知则 recover；[TAP 76–79](code/automated.tap.txt#L463-L481)。 | 未验证这些证明字段在真实宿主是否可获、旧轮结束后通知是否恢复顶层会话。 |
| 同 key 重试 | CLI 登记幂等；模拟同 ID，对已报告/已收等不重复正文、冷恢复有三种变体；[TAP 38–43、87–91](code/automated.tap.txt#L529-L553)。 | 未证实际宿主同 ID 创建原子性/迟到；当前不可见不等于绝无旧动作。 |
| 并发 | 模拟同 key 锁、不确定项与已成功项分开、旧写者未证停写不投；实 Node 两进程争用锁与任务锁交叉用例；[TAP 71–82](code/automated.tap.txt#L433-L499)、[93–94](code/automated.tap.txt#L565-L571)、[453](code/automated.tap.txt#L2792)。 | 非真实两宿主竞争；未将真实旧成员与新成员并行写，也不证明进程中断后没有迟到投递。 |
| 宿主直接对账 | 模拟登记后未创建、回执丢失、完整/冲突正文、继承前缀、异主、读错、截断及关闭失败；不确定保留 ID；[TAP 74–91](code/automated.tap.txt#L451-L553)、[冷日志用例](code/automated.tap.txt#L769-L799)。 | 不代表真实日志完整、回执丢失、会话晚到和重新收件的结果；F-7 明列。 |
| 波事实 | CLI 部分交付保持同一在途波，自动并发推进/多成员日志读失败无半波；[CLI 23](code/cli-evidence.jsonl#L23)、[TAP 237–252](code/automated.tap.txt#L1496-L1586)。 | 未做发布原子替换前/后的真正 kill，读错模拟不证明断电或进程崩溃。 |
| Deliver | CLI 同 key 三步（首交/同字节/变字节）与 blocked 附路径拒绝；自动二进制快照及事务阶段故障注入；[CLI 17–22](code/cli-evidence.jsonl#L17-L22)、[132–134](code/cli-evidence.jsonl#L132-L134)、[TAP 233–235](code/automated.tap.txt#L1472-L1484)。 | 未用真实并行成员在读取时改文件；并发读后改写不由一次校验保证。 |
| Lead 授权刷新 | CLI A、B 完整清单各自绑定当前字节，决定后重开评审；自动评审前漂移与旧证据不足引导；[CLI 94–117](code/cli-evidence.jsonl#L94-L117)、[TAP 207–208、216](code/automated.tap.txt#L1316-L1370)。 | 已证明合成调用方约定，不证明 DSH 强鉴权、真实 Lead 未越权；真实评审在途的等待/作废未执行。 |
| 多卡按 ID 决定 | CLI 三卡同时呈现、缺 ID 拒绝列全、H2 时 C1 拒但仍待决，再按实际 B ID 完成；[CLI 101–105](code/cli-evidence.jsonl#L101-L105)。 | 非真实用户答复。 |
| 刷新后旧门收口 | CLI 受影响 C1 作废、晚答拒绝并重签人门；自动快照/journal 失败与提交后回执故障 [TAP 210、213–214](code/automated.tap.txt#L1334-L1358)。 | 前后故障为定点注入，未杀实机进程。 |
| 恢复 C1 与取消 C2 | 自动恢复 H1 后原 C1 独立批准，C2 只取消自身、不产报告；[TAP 211](code/automated.tap.txt#L1340)。 | 非 DSH/真实用户。 |
| 刷新卡重签 | 自动候选文件再次变化拒绝旧卡并重签；CLI 旧人工门和重复同 ID 分开；[TAP 208](code/automated.tap.txt#L1322)、[CLI 106–109](code/cli-evidence.jsonl#L106-L109)。 | 未在同一个 CLI 用例联合演练 H2→H3、C1 留在场、旧 C2 安全取消、同候选重签全序。 |
| 多包多卡和前置门 | CLI B 后签先答、A 不受影响；自动未决意图/迁移阻止普通人工门批准（F-11），且候选计划实际变化可令绑定的刷新卡过期；[CLI 101–110](code/cli-evidence.jsonl#L101-L110)、[TAP 181–185](code/automated.tap.txt#L1093-L1117)、[232](code/automated.tap.txt#L1466)。 | 本轮 CLI 按顺序答卡，未注入两操作者同时决定 A/B；实际宿主用户卡前置未测。 |
| 多卡兼容与故障 | A/B 的重放、缺 ID 和旧 ID，既有首卡迟答和日志损坏、静止旧卡等；[CLI 101–109](code/cli-evidence.jsonl#L101-L109)、[TAP 151–156](code/automated.tap.txt#L913-L943)、[239–244](code/automated.tap.txt#L1508-L1538)。 | 不用这组证明端到端网络重放、任意账本损坏或 G-2 已消失。 |
| 刷新授权和原子性 | CLI 确认前只展示 SHA；自动无 reason/候选变化、注入提交前后失败；[CLI 99–110](code/cli-evidence.jsonl#L99-L110)、[TAP 207–214](code/automated.tap.txt#L1316-L1358)。 | 不证明能防止冒充用户；真实故障下无万能事务保证。 |
| 旧 key 用户取舍 | 自动相同 key 幂等、非作废旧 key 不默认拒绝、作废 key 拒绝；[TAP 440–441、448](code/automated.tap.txt#L2714-L2762)。 | 未加旧 key 守卫（G-1 排除）；未把 d1=X→d2=X/Y→迟到 d1=X 与刷新/旧卡失效联合做一个进程级 CLI 用例。 |
| 历史快照恢复 | 自动默认当前快照、列可选非作废历史、显式恢复旧内容不改变基线、字节无损；[TAP 209、217](code/automated.tap.txt#L1328-L1376)。 | 未访问真实任务快照。 |
| 报告事务 | 自动模拟 journal、快照、索引异常与重试；缺损不凭旧快照伪造新内容；[TAP 165](code/automated.tap.txt#L997)、[233–235](code/automated.tap.txt#L1472-L1484)。 | 未实际中断进程或系统，不能推断所有写入可恢复。 |
| 每包完整清单 | CLI [重列 X/Y 仍保留两项](code/cli-evidence.jsonl#L18-L42)；[同 key 修订](code/cli-round2.jsonl#L67-L74)和[跨 key 返工](code/cli-round2.jsonl#L89-L99)只列 X 均使 Y 移出有效清单，实读磁盘 Y 字节不变；随后改写磁盘 Y，新的组合评审只覆盖 X 与乙包 Z，评审仍成功登记。 | 未执行这两种漏列场景的索引缺失/损坏重建等价，以及漏列后直接验证人工门；归档用例不替代它们。跨 key 回执的增删展示差异见下文。非真实成员自行选择清单。 |
| 作废波完整回退 | 自动部分交付后作废、投影不计作废报告、据历史非作废版本恢复；[TAP 448–449](code/automated.tap.txt#L2762-L2768)、[209](code/automated.tap.txt#L1328)。 | 未联合触发 A=X2/Y1、B未交、作废后评审/裁决/批准全部入口的单一脚本；真实旧写者无法继续写未证。 |
| 旧任务和摘要转换 | 自动旧 `digestValue`→字节 SHA；旧增量/证据缺失保留并提示刷新；[TAP 215–217](code/automated.tap.txt#L1364-L1376)。 | 只使用合成旧任务，不读外层或历史真实任务内部状态。 |
| 协议与 Expert | CLI [F-N1 单变量负例与原 key 修正](code/cli-round2.jsonl#L25-L27)、[checks 与 Expert 缺 verdict、accept+rework](code/cli-evidence.jsonl#L17-L40)；既有协议校验含旧入口和类型边界。 | 未把所有 recommendation×verdict 组合和非法嵌套逐一经真实 DSH 原生工具执行；线上模型是否被旧用语误导未测。 |
| 返工语义 | CLI 本包/全组必修原文与他包不混入、F-9 只重派 A；自动依赖不误解锁；[CLI 25–40、72–74](code/cli-evidence.jsonl#L25-L74)、[TAP 452](code/automated.tap.txt#L2786)。 | 不裁定两份争议报告同时把目标指向不同包时的优先权。 |
| 原始字节 SHA 与新鲜度 | CLI NUL/非法 UTF-8 清单、评审后漂移拒批；自动历史算法区分、F-2、旧卡失效与只读入口；[CLI 14–22、97–105](code/cli-evidence.jsonl#L14-L22)、[漂移](code/cli-evidence.jsonl#L97-L105)、[TAP 272–276](code/automated.tap.txt#L1706-L1730)。 | 未证明检查后改写与 ABA，不宣称外部写者受任务锁控制。 |
| 按包阻塞恢复 | CLI F-N3 两包单独恢复/取消；自动新 blocked 版本不能被旧恢复覆盖、计划/范围交叉及锁；[CLI 132–149](code/cli-evidence.jsonl#L132-L149)、[TAP 431](code/automated.tap.txt#L2660)、[258](code/automated.tap.txt#L1622)。 | 删除/改名 blocked 包的真实用户审批未执行。 |
| 规则路径 | CLI 不依赖 Skill 基目录，包内回退、用户覆盖、项目追加；自动三层规则与时点；[CLI 150–152](code/cli-evidence.jsonl#L150-L152)、[TAP 371–375](code/automated.tap.txt#L2300-L2324)。 | 实际 DSH 复制型 Skill、不可读文件在其真实链上的回退/告警未测。 |
| 迁移与回退 | 自动旧波身份无损与模拟半迁移续跑、新旧切换和迁移×交付串行；[TAP 443–446](code/automated.tap.txt#L2732-L2750)、[453](code/automated.tap.txt#L2792)。 | 未运行旧版/新版双写或从真实备份恢复，也未验证长在途旧宿主的安全切换。 |
| 开销和保密 | 夹具未注入真实凭据，保留的正文是合成输入和包内规则；不据此保证实机收单永远无凭据。 | **未执行**不同包数/历史长度的 journal 大小、写入/重放耗时基准；不承诺成本或性能。 |
| 集成验收 | CLI 两包、双角色评审、返工、重审/裁决与人工门；依赖汇总由既有自动直通用例补证；[CLI 9–52](code/cli-evidence.jsonl#L9-L52)、[TAP 139](code/automated.tap.txt#L841)。 | 真宿主整合为 0；没有在同一场景结合真实定点返工、依赖汇总和人工门。 |

## 4. 失败、保留风险、跳过与后续条件

- **安全前置未通过。** 需要可信隔离宿主或由宿主提供经独立验证的真实仓库/HOME 拒写、虚构项目可写及完整派生链继承证据。随后才验证该宿主能选精确 GLM-5.3/max，确认独立 CLI 加载源码指纹与四类角色的实际请求头；现有 GUI 的模型配置、历史轨迹和角色登记都不是替代。
- **F-7 尚缺真实宿主证据。** 据外层 Lead 从原始会话核验并转述，实施期说明第 1.5 节（assistant/message seq=10203），将宿主确认活冷均不存在的 `none` 用于两条路径：首派/崩溃重入以原确定性 ID 创建或补建；未登记的新续派遇原 ID 明确断链，按新 key 的确定性 ID 建立并投全量；随后用户原文“1”（user/message seq=10210）确认该清单。本 Owner 未读项目外日志。当前[状态实现](../../dsh/subagent-session.js#L6-L28)将活未见且 `stat` 未命中归 `none`，[绑定层](../../dsh/tw-dispatch.js#L312-L326)据此允许上述续派重建；已登记项不会因此覆盖原映射。冻结[设计 §4.2–4.3](../../runtime-v3/twr-framework-architecture-design.md#L64-L82)要求可靠排除旧调用迟到，严于只看当前未命中。模拟测试只证明当前分支按设定执行，不证明迟到、同 ID 去重、双会话或重复正文不会发生，不能承诺恰好一次。
- **一处可观察的提示残留，未测模型影响。** [Challenger 合成派单](code/cli-evidence.jsonl#L24)仍说“findings 请标注 package 归属”；[实际拒绝](code/cli-round2.jsonl#L25)和新版协议用的是 `scope`，语义要求说明包归属，但旧字段暗示可能误导。未观察到真实模型因此出错；只交证据，不改产品或扩大修订范围。
- **跨 key 的回执提示与有效结果不同。** [新返工 key 的交付回执](code/cli-round2.jsonl#L94)没有列出被移出的 Y，且把上次清单已含的 X 列作新增；[磁盘和后续评审证据](code/cli-round2.jsonl#L95-L98)则确认 Y 已退出有效清单。按[设计 §6.1](../../runtime-v3/twr-framework-architecture-design.md#L136-L140)记为回执增删展示差异，未更改产品。
- **设计边界未扩大。** G-1 不新增旧 key 守卫，不裁定双源冲突；G-2 不更改决定权威，既有风险不因 F-10 用例通过而关闭。普通运行不是崩溃、回执丢失、网络迟到和竞争的证据；这些只按表标注模拟/自动或未执行。
- **跳过与失败清单。** [第二轮 CLI 7 个最终用例](code/cli-round2.jsonl#L200-L202)无失败或跳过，预期的协议/门禁拒绝为通过断言；[试跑修正](code/pilot-diagnostics.md)单列。自动套件 9 个 `DSH_TEST_HOST` 用例原样跳过（[兼容、创建入口、Cordis、Skill、冷日志、ConfigForms](code/automated.tap.txt#L577-L620)，[bundle/schema](code/automated.tap.txt#L859)）；历史评测框架与整仓静态契约共两个测试文件未纳入所报 18 文件，故不是完整 `npm test`。未执行的矩阵项见上表；没有已验证的实机通过项。外层任务最终人工门未自动接受。
