# Runtime v3 验收规约（工具中心重写）

状态：草案 v1，待维护者逐条审定后冻结。本文件是 v3 重写的**唯一验收规约**：新核心的每个设计决定、每行实现、每个测试都必须能追溯到本文的某一条；本文没有的能力不得宣称可用。

命名说明：v3 是工作名，指"工具中心"重写。它与 v2 的关系是 replace-don't-layer：不兼容 v2 的 MemberReport 契约、EvidenceVerifier 职责和 state.json 权威模型，但保留 AGENTS.md 产品边界与 v2 已验证的安全不变量。

## 0. 背景与裁决依据

V2-8 真实 E2E 台账（[`v2-e2e-findings.md`](v2-e2e-findings.md)）20 个问题中 11 个是成员在"门内"撞上报告契约的硬拒绝；修复史显示其中 8 个的修复方向都是"把确定性簿记从模型手里收回 Runtime/适配层"。同期 SPEC 腿（OpenSpec Provider：单次同步调用、对 change 目录做一次总检查）零故障。结论：**接口形状，而非模型能力，是体验与维护成本的主变量**。

v2 的病灶在架构契约而不只是实施：`runtime-v2-architecture.md` §7.3（MemberReport 要求模型回显 evidenceRefs/artifacts[].ref）、§8.6（EvidenceVerifier 七项职责）、§11（state.json 急切维护的"唯一权威快照"）共同制造了平行状态宇宙与三层不可见校验。量化伴随症状：实现 12.8k 行对测试 12.4k 行（1:1），前七大测试文件中六个测的是状态机形状而非产品规则。

v3 以已验证的 OpenSpec 形状为中心原则：**制品即状态，工具调用即检查点，门只在阶段流转**。

## 1. 设计原则（P1–P6）

- **P1 任务目录即状态**。制品、报告、人工决定凭证落在任务目录里，是事实源；一切门禁判定可从"任务目录 + 版本化 Workflow Policy"纯函数推导。不存在急切维护的平行权威状态。不可推导的易失运行状态（活动会话绑定、在途派单）允许最小落盘，但必须可从 journal 与平台重建，丢失只降级不阻塞。
- **P2 工具调用是唯一检查点**。每个工具调用内部做**单一、同步、总量**的检查：一次查完全部欠账，accept/reject 连同全量原因与修复指引当场返回。禁止异步拒绝、禁止三层校验中任何一层对模型不可见、禁止"接受了却在别处记拒绝原因"。
- **P3 门只在阶段流转**。门 = 必需制品存在 + 声明的检查通过 + 评审在场，一处、确定性、必带恢复边。房间内（成员执行期间）Runtime 只做运输（派发、投递、等待通知），不做裁判。
- **P4 模型只供语义**。工具参数只收模型才知道的东西：做了什么、产出在哪个路径、发现什么、还剩什么不确定。凡 Runtime 能从自己拥有的事实（工作图、依赖、派单、目录）推导的簿记——ID、ref、链接关系、角色差异——一律不向模型索要，也一律不由模型回显。
- **P5 指引随工具走、单一来源**。拒绝消息自带"缺什么、正确形状、下一步"；协作策略与角色指引是版本化 skill 资产，不写死在 Runtime 代码字符串里；同一事实的指引只允许一个来源，禁止系统注入与派单文本互相矛盾。
- **P6 物理边界在行动时**。写边界、只读约束、路径逃逸由平台层（沙箱/Hook）在写入发生的时刻拦截；事后校验只作为纵深第二层，用于发现与恢复，不作为第一道拒绝。

三条经实证的例外（P1–P6 覆盖不了、必须显式保留的机制）：

1. **写入拦截必须在写入时**（台账 E2E-17：提示词禁止挡不住越权 `apply_patch`）；
2. **异步执行藏在运输工具内部**（成员比单次调用活得久、宿主会重启；但模型视角必须全同步，协议不得漏到接口上）；
3. **人工决定凭证绑定**（批准无法从制品推导，必须验凭证绑制品指纹）。

## 2. 产品不变量（I1–I10）

以下不变量全部要有测试；任何实现变化不得破坏。它们源自 AGENTS.md 核心规则，措辞按 v3 形态重述：

- **I1 身份与路径安全**：稳定 task-id；版本化 schema；制品路径永不逃出项目根（含符号链接）。
- **I2 活动任务解析**：显式指定 > 会话绑定 > 项目唯一活动任务；存在歧义时拒绝并说明，不猜测。
- **I3 事实源分离**：制品正文唯一存于其文件；索引与摘要可随时重建，且永不反向驱动状态。
- **I4 目录即状态**：任何门禁判定可由任务目录 + Workflow Policy 纯函数重算得出；不存在只能靠运行时内存回答的门禁问题。
- **I5 拒绝必有出路**：门禁与工具的每次拒绝都返回 blocker、证据和修复建议；每个拒绝状态至少存在一条合法恢复边。**死门是缺陷**（台账 E2E-20 的遗留死局在 v3 中非法）。
- **I6 验收不信声称**：Agent 声称完成、平台状态完成、消息送达都不等于验收；验收 = 制品在场 + 检查证据 + 非作者评审在场；核心环节需非作者 Expert 裁决；Owner 保留带证据异议权；三轮不收敛交用户。作者不自审：交付工具不向作者索要自评结论。
- **I7 人工决定**：凭证绑定签发时的制品指纹，制品变化即失效、须重确认；门禁签发后任务静止——无后台派单、无轮询、无定时推进，只能由新的用户输入恢复；终态幂等（完成后的任何调用返回同一完成卡片，不报错）。
- **I8 写边界在行动时**：越权写在平台层被拦截；受保护制品保有最后注册内容快照，检测到污染时可恢复。
- **I9 显式路由**：SPEC 与 E2E 按 `auto|required|disabled` 决策表路由；E2E 适用性是有证据的技术评估，可有据跳过；路由决定可审计。
- **I10 保留最后有效制品**：任何错误路径不破坏已登记制品；错误可诊断、可重试、可恢复。

## 3. 台账 20 课映射（重写的隐性规约）

每一条旧问题必须在 v3 中有明确处置。处置类别：**消解**（新工具形状使问题不可能发生）、**编码**（写成不变量或契约测试）、**平台**（移交 DSH 平台能力）、**保留**（v2 修复随 policy 资产保留）、**冻结**（OpenCode 特定，随插件冻结）。

| 台账 | 一句话教训 | v3 处置 | 类别 | 验收要求 |
| --- | --- | --- | --- | --- |
| E2E-01 | 人工等待是第一硬边界，检查已签发决定先于任何推进 | I7：门禁签发后一切动作入口即返回同一卡片，零副作用 | 编码 | I7 测试：签发后 open/plan/run 均无副作用 |
| E2E-02 | 用户约束必须到达执行者 | 派单文本由单一模板生成，TaskIntent 约束是必填槽位 | 编码 | 契约测试：派单文本含约束与排除段 |
| E2E-03 | 审查视角属于统一挑战位而非每个 Owner | team-work policy 数据修复随 policy 资产保留 | 保留 | policy 回归随迁 |
| E2E-04 | 平台报告形状 ≠ 顶层证据约束 | review 工具无 evidence 组装参数；链接由工具推导 | 消解 | 契约测试：review 无 evidence 参数 |
| E2E-05 | 只读角色提交 artifacts 被静默剥离 | review 工具无 artifacts 参数 | 消解 | 同上 |
| E2E-06 | retryable 网关错误需失联恢复 | 派发/通知/失联检测移交 DSH 后台任务；核心只约定派单幂等键 | 平台 | 同键重发不产生第二个成员 |
| E2E-07 | 报告 ID 事后产生，不能要求静态引用 | 回应自动挂接被回应报告（目录推导），模型不填 ID | 消解 | 契约测试：回应无需填 report id |
| E2E-08 | 派单须声明上下文已内嵌、禁止范围外扫描 | P5：指引单一来源（skill），删除矛盾系统注入 | 编码 | 一致性测试：派单模板与 skill 无冲突指令 |
| E2E-09 | recommendation 评价对象必须明示 | deliver 无自评 recommendation（I6 作者不自审）；review 的 recommendation 只评价被评审制品 | 消解 | 契约测试 |
| E2E-10 | 裸 ref 试错占用幂等键 | P4 按路径交接；幂等键 = 会话 + 轮次，由工具生成 | 消解 | 契约测试 |
| E2E-11 | 报告先于宿主 idle 的尾部竞态 | OpenCode 宿主特性 | 冻结 | — |
| E2E-12 | EventSource 监听器累积 | OpenCode 上游 | 冻结 | — |
| E2E-13 | TUI 工具行显示不足 | OpenCode 上游 | 冻结 | — |
| E2E-14 | 终态重复 run 报"未准备完成" | I7 终态幂等：完成后任何调用返回同一完成卡片 | 编码 | I7 测试 |
| E2E-15 | 可选字段隐含 create/resume 分支 | 名字寻址：目录在即状态在，create/resume 分支不存在 | 消解 | 契约测试：open 无 mode 参数 |
| E2E-16 | 同一路径被认作两个制品 | 制品两分法：输入上下文不登记，产出物路径即身份 | 消解 | 推导测试：同路径必同制品 |
| E2E-17 | 提示词禁止挡不住越权写 | P6 + I8：平台沙箱写入时拦截 + 快照恢复 | 编码 | I8 测试 |
| E2E-18 | spawn stdout 64KB 截断 | OpenCode 安装器 | 冻结 | — |
| E2E-19 | 被动探测必须容忍遗留标记 | 分层容错：被动探测零写入零报错；显式入口自愈且保留旧数据 | 编码 | 容错测试：v1 遗留目录上被动链零报错 |
| E2E-20 | 错误掩盖 + 无受控修订入口成死局 | P2 同步总检查；existing_artifacts/ENTRY_UNSATISFIED 机制类消失；intent 任何时候可修订 | 编码+消解 | I5 测试；契约测试：intent 在无待决卡片时合法 |

统计：消解 9、编码 7、平台 1、保留 1、冻结 4（E2E-20 记编码+消解混合）。**所有"编码"条目是 v3 的强制回归测试清单；所有"消解"条目必须有契约测试证明该参数/路径确已不存在。**

## 4. 工具面契约（定案：名字寻址 + 逐步推进 + CLI 即接口）

工具是 v3 的中心设计对象。每个工具：小参数集、同步总检查、拒绝即带修复指引。**CLI 的 --help 与拒绝输出即完整 meta**——模型看到的就是全部，不存在第二层校验。

### 4.0 四条机制定案

1. **名字寻址**：任务名 = 目录名，项目内唯一。open 重名拒绝；open 用 `--name`，其余动词带 `--task`。活动任务解析、create/resume 分支、会话绑定歧义整套机制不存在——目录在，状态就在。
2. **run 推进一步**：每次调用只派发当前可派发的波次并立即返回卡片；报告到达（平台通知）后由下一次 run 消费。Lead 多次调 run 是常态：卡片即工作流推进的呈现单位，Lead 借此更新 todos、向用户汇报，并在同步点处理异常（超轮次、制品丢失、恢复）。
3. **CLI 即接口**：成员不依赖平台注册的自定义工具 schema；交付动作 = bash 调 `tw` CLI。依据：shell 是所有模型训练最充分、传参最稳的接口；CLI 的 stderr 拒绝文本（含修复指引）直接回到成员眼前，P2 天然满足；--help 即 meta。平台绑定只需把 CLI 放进成员环境。
4. **制品两分法**：
   - **流程产出物（deliverable）**：阶段合同 outputs 的实例化，由 deliver 的 paths 显式登记，digest 快照，门禁检查，下游结构化引用。唯一拥有结构化身份的制品。
   - **输入上下文（context）**：项目已有文件、用户指的范围、参考资料。由 objective/派单文本自然语言承载，无结构化身份、无登记、无存在性检查（沙箱读不到则成员自报 blocked）。派单生成时输入范围不明，第一张卡片反问；答案走 intent 语义，不走制品登记。
   - 由此 `existing_artifacts` 参数与 `ENTRY_UNSATISFIED` 机制类整体消失（E2E-16/20 病根）。

### 4.1 Lead 工具

| 工具 | 参数 | 调用内检查 | 拒绝形状 |
| --- | --- | --- | --- |
| `open` | `name`、`objective`、`entry?`（缺省 research=跑全程；显式 entry=through-stage 到该阶段验收，含 scoped final-acceptance） | 名字合法且不存在；objective 非空 | 重名：列出现存任务名与创建时间，建议改名或 run |
| `run` | `task` | 无前置检查；派发当前可派发波次，返回卡片 | 无可派发且门未过：卡片列出缺口 |
| `decide` | `task`、`choice`（序号）、`note?` | 序号在当前卡片选项内；决定凭证绑定签发时制品指纹 | 序号越界：回显当前卡片与合法序号 |
| `intent` | `task`、`objective?`、`--add-constraint?`、`--add-exclusion?` | 任务未 completed | 完成后修订：建议开新任务引用旧目录 |

`plan`/`steer` 退役：目标与约束初始提交归 open，后续修订归 intent；卡片应答归 decide；干预（换 Owner、追加轮次、Expert 仲裁、升级用户）是特定情境卡片的选项，不是常设动作枚举。

| `route` | `task`、`route`(spec/e2e)、`decision`(run/skip)、`basis?` | skip 必须带可定位依据（I9）；同类路由决定后者覆盖前者 | run/skip 之外或 skip 无依据：同步拒绝并说明 |

### 4.2 成员工具

| 工具 | 使用者 | 参数 | 调用内检查 |
| --- | --- | --- | --- |
| `deliver` | Owner | `task`、`outcome`(delivered/blocked)、`summary`、`paths[]`（本轮产出物路径）、`checks[]?`、`unresolved[]?` | paths ⊆ 派单可写集；登记+快照；checks 与平台观察对账；回应场景自动挂接（不填报告 ID）；**无 recommendation**（作者不自审，I6） |
| `review` | Challenger/Expert | `task`、`findings[]?`、`recommendation`、`summary`、`verdict?`(Expert) | recommendation 只评价被审这版交付（E2E-09，写入 --help）；被审制品 digest 变化则告知并重绑；**无 paths/artifacts 参数** |

Owner 回应评审 = 再次 deliver：同路径原地修订（新 digest，旧快照保留）或纯反驳（paths 空、summary 承载证据）。交付工具是传话通道，协调责任在 Lead 与派单文本，不在工具内预埋规则。角色合同不同则 schema 不同（不取并集）。

### 4.3 检查工具（门）

`tw gate --task <name>`：对任务目录做一次总检查，返回通过或全量 blocker 清单（每条带证据与恢复边）。纯函数的可调用形式，测试主入口；不在 Lead 主循环。SPEC/E2E 路由判定复用同一形状。

`tw archive --task <name>`：显式归档（§5.2）——用户要求才触发，任意终止形态可归档。

## 5. 任务目录约定（状态推导源）

```text
.team-work/
  project.json                      # 版本标记（含 v1 遗留容错语义，E2E-19）
  tasks/<name>/                     # 活动任务（完成后归档并移除，见 5.2）
    intent.json                     # 目标与约束 + 修订历史
    scope.json                      # entry/completion 投影 + workflow 指纹
    reports/<report-id>.json        # 成员报告，一次写入不可变
    decisions.json                  # 人工与路由决定凭证（单文件数组）
    artifacts.json                  # 产出物登记索引（可重建）
    snapshots/<digest>.json         # 产出物内容快照
    journal.jsonl                   # 只增审计日志（状态事件唯一序列）
    locks/                          # 写入互斥锁（运行时产物）
  archive/<name>/                   # 已完成任务（只读）
    manifest.json                   # 摘要、时间线与压缩审查日志
    artifacts/                      # 最终版产出物内容
    decisions.json                  # 人工决定（原样保留）
    journal-summary.jsonl           # 压缩审计线索
```

### 5.1 逐文件定义

| 文件 | 内容结构 | 用途 | 写入者与时机 | 更新方式 |
| --- | --- | --- | --- | --- |
| `intent.json` | `{objective, constraints[], exclusions[], revisions: [{seq, at, change}]}` | 任务语义源头；派单文本与卡片的目标/约束段由此渲染 | open 创建（revisions 空）；intent 追加修订 | 仅追加 revision，不改写历史；新派单读最新值 |
| `scope.json` | `{entry, completion, stages[], workflowDigest}` | 阶段子图投影；推导合法边与完成点 | open 一次写入 | **冻结**；创建后不可变（变更=新任务） |
| `reports/<id>.json` | `{reportId, wave, role, sessionRef, taskSha?, payload, at}`（taskSha=被审产出物 digest，review 专用） | 成员交付的不可变事实；波次收敛与门禁证据由此推导 | deliver/review 调用内一次写入 | 不可变；重派=新文件 |
| `decisions.json` | `{items: [{decisionId, gateId?/route, choice, grant?, note?, fingerprint?, proof, at}]}` | 人工与路由决定凭证；fingerprint 绑签发时产出物 digest（I7） | decide/route 调用内追加 | 数组追加；route 同类决定后者覆盖 |
| （无 gates/ 文件） | — | **门禁判定不落盘**：gate 是目录数据的纯函数（derive 时即时计算），推导即检查，制品变化自然使旧判定失效；审计由 journal 事件与 decisions 承载 | — | — |
| `artifacts.json` | `{items: [{path, digest, kind, stage, reportRef, snapshotRef}]}` | 产出物登记索引；路径即身份（E2E-16） | deliver 登记时更新 | 原子覆盖；可由 reports+snapshots 重建（I3） |
| `snapshots/<digest>.json` | `{digest, path, content, at}` | 产出物内容快照；I8 污染恢复源 + 归档取材 | deliver 登记时写入 | 不可变；同路径修订=新 digest 新文件，旧版保留 |
| `journal.jsonl` | 每行一个事件：`{seq, at, type, detail}`；type ∈ task-opened/dispatched/report-accepted/decision-issued/decided/stage-advanced/task-completed | 唯一审计序列；在途状态（已派发未交付的波次）由此推导 | 每个状态事件追加一行 | 只增不改 |
| （无 runtime.json） | — | 会话与执行实例归平台/编排层管理；runtime 只记派单事实（journal 的 dispatched 条目），不绑定具体 session；易失信息丢失最多导致重派当前波次，不阻塞门禁 | — | — |

### 5.2 归档（显式收尾，任意完成形态）

- **触发**：**仅由用户显式要求触发**（Lead 转述为 `tw archive --task <name>`）。完成 final-acceptance 的任务、只跑了部分工作流就满足需要的任务（如单独 code-review、standalone 团队讨论），都可归档；未完成且用户不再需要时同样可归档（manifest 如实记录终止形态）。run **永不自动归档**——完成后 run 幂等返回完成卡片，并提示"可归档"。
- **CLI**：`tw archive --task <name>` 进入 §4.3 同款门形检查：列出将保留/清理的内容清单，**直接执行**（用户意图已由 Lead 确认过，工具不做二次确认卡）；幂等，重复调用返回已有归档。
- **过程**：在 `archive/<name>/` 完整构建 → 校验 → 删除 `tasks/<name>/`。构建未完成时任务目录原样保留，重试安全。
- **保留**：manifest（目标、时间线、终止形态：completed | partial、已过门清单、压缩审查日志——每波角色/recommendation/findings 要点/verdict）；最终版产出物内容（自 snapshots 取最新 digest）；decisions.json 原样；journal-summary（阶段流转与决定各一行）。
- **清理**：成员报告全文、历史快照、locks 不进归档。
- **归档后**：目录只读；重开后续工作=新任务引用归档名；归档不删项目树里的产出物本体（如 CODE_REVIEW.md 留在项目原位，归档存内容副本）。
- **不变量**：归档是纯函数操作——输入任务目录，输出归档目录，可重放；归档后 `gate` 对归档目录返回只读摘要。

推导规则：当前阶段 = scope 投影 + gates 通过记录 + journal 尾部。制品身份 = 项目内路径（E2E-16）。

## 6. 模块判决（相对 v2 实现，实现期不得摇摆）

判决已逐文件代码勘察定案（§6.1–6.4），实施期间**不再重开方向讨论**，只允许保留模块内部的接口适配。v3 新代码只增文件，不改 v2 保留文件；6.2/6.3 所列 v2 文件在 v3 CLI 通过真实任务验证后一次性删除。

### 6.1 保留（直接复用，允许薄适配）

| 文件 | 行数 | 复用内容 | v3 调用方式 |
| --- | --- | --- | --- |
| persistence/transactions.mjs | 118 | atomicWrite/atomicJson、withOwnerLock（孤儿锁回收）、canonicalJson | 快照/索引/凭证写入；不引入新并发原语 |
| persistence/paths.mjs | 82 | 项目相对路径校验、逃逸拒绝 | 一切路径入参的唯一校验通道 |
| persistence/file-artifact-repository.mjs | 219 | readStable（符号链接/读中变化防御）、digest | snapshots 写入与复核 |
| domain/digests.mjs → policy/kernel.mjs | — | digestValue | 全部指纹计算 |
| workflow/definitions/engineering.json | 51 | 十阶段、边、门、路由表 | gate 推导数据源，原样读 |
| team-work/policies/default.json | 71 | 角色档位、轮次上限、E2E 模板 | 派单查表；**八视角合同改为 skill 引导，不再由编译器强制**（§8） |
| spec-providers/openspec/provider.mjs | 527 | status/instructions/validate/archive | SPEC 路由门复用；DSH 下 CLI 直调 |
### 6.2 重写（v3 新文件替代）

| v2 文件 | 行数 | v3 替代 |
| --- | --- | --- |
| domain/reducer.mjs | 1715 | `runtime-v3/derive.mjs`：目录→阶段/波次/门状态，纯函数 |
| application/task-lifecycle.mjs | 1230 | `runtime-v3/intake.mjs`（deliver/review 调用内同步总检查） |
| task-lifecycle 内 planning bootstrap | — | policy 查表 + skill 引导，无 planning Owner |
| domain/stage-plan + work-graph + invariants 大部 | ~700 | `runtime-v3/waves.mjs`（policy→波次图）；不变量测试迁 §3 编码清单 |
| context-composer + decision-packet + action-card 大部 | ~500 | 卡片与派单文本生成并入 `runtime-v3/cli.mjs`（情境→卡片，拒绝即修复指引） |
| lead-control + member-delivery + contracts | ~150 | CLI 参数解析即接口（§4.0） |
| schemas/v2/ v2 专属部分 | — | 单层契约：CLI --help + §5 文件结构 |

### 6.3 删除（v3 验证后移除）

| v2 文件 | 行数 | 理由 |
| --- | --- | --- |
| application/driver + reconciler + effect-coordinator + signal-hub + spec-effect-coordinator | ~900 | run-to-stable、durable effect 状态机、in-doubt 对账——逐步 run + DSH 通知 + journal 重建取代 |
| application/human-wait.mjs | 374 | prepare-quiesce-commit 是 OpenCode autocontinue 对抗物；DSH 无宿主自动续跑；凭证绑指纹进 decisions 结构 |
| application/steering-intervention.mjs | 353 | 干预=情境卡片选项（§4.1） |
| persistence/file-store + in-memory-store + durable-reference-validator + recovery | ~800 | state.json 权威模型退役 |
| runtime/index/facade/host 装配 | ~400 | composition root 移至 cli.mjs |
| tests/v2/ 大部 + opencode 测试 | ~9k | 测机器形状；以 §3 编码清单 + I1–I10 重建 |

### 6.4 冻结

plugins/opencode/ 全部（~2.6k 行）及其测试：停止投入、留档、不进 v3 打包清单；OpenCode 支持待核心稳定后按 §4 seam 另起薄适配器。

行数账：保留 ≈1.1k；重写+删除 ≈16.4k（实现+测试）；v3 目标 ≤3k 实现 + ≤1.8k 测试。

## 7. 测试策略与预算

- **测试面**：门函数（目录夹具 → 判定）、工具契约（参数集 + 同步拒绝形状 + "消解参数确已不存在"）、I1–I10、第 3 节全部"编码"条目。
- **禁止**：测试内部状态转移边数、对抗特定平台怪癖的协议测试、以实现形状（而非规约）为准的快照断言。
- **预算**：核心实现 ≤3k 行；测试:实现 ≤0.6；此后新增测试仅当新增产品规则或修复真实缺陷。

## 8. DSH 绑定（首个平台）

- **唯一 skill**：`team-work`——不再区分 lead/member 两个 skill。skill 内容：工具用法（open/run/decide/intent/archive + deliver/review）、卡片转述规范、门禁静止语义、写边界与"上下文已内嵌"纪律（E2E-08）。**阶段触发、是否组团、是否要求八视角完整审查，由 Lead 依据用户语义判断；skill 提供判断指引**（何种目标对应哪个 entry、何时 solo 何时 team、何时要求完整视角合同、何时允许轻量抽查），不由编译器强制。成员派单文本由 Lead 生成：从 policy 查角色档位，按 skill 指引组装完成条件与边界。
- **薄 CLI（九命令）**：`tw open / run / decide / intent / route / archive / deliver / review / gate`（open 用 `--name` 寻址，其余动词带 `--task`），Lead 与成员经 bash 调用；CLI 是工具契约的参考实现。
- **派发与拓扑**：团队拓扑由 DSH 编排工具（workflow：`agent/pipeline/parallel`）在平台层执行——`tw dispatch-plan` **按波组导出**波次事实（`multi-wave` 多包波带 owners、`continuation` 增量续派、challenger findings 包归属选择性重派、`expectedAgentId` 续派映射、`weight` 成本权重）。tier→模型唯一来自 DSH 全局 settings 的 `team-work-dsh.tiers`（DSH Web“插件配置”页）：档位兼容单对象与候选数组，provider/model 必填，family 与 effort 可选；同波按候选池优先不同家族选择，并将 modelHint 快照记入派发事实。项目 `.team-work/platform/dsh.json` 不再读取或创建，`agents.json` 只保存项目内 child 映射与快照。编排脚本按该 modelHint 以 `agent(prompt, {provider, model})` 派发成员，推进到人工门即终止返回卡片；成本控制的本质是该映射：简单任务廉价模型、复杂任务高预算，`costWeights` 为映射权重标注（详见 Roadmap v3.1）。runtime 不实现派发循环与 DAG 调度。
- **v3.2 拓扑进度**：`tw plan` 包定义登记与机械验收、波次机波组化与选择性重派、邻派映射（`tw agent-map`）已随 v3.2 第一批实施；八视角并行独立审（视角包 tier + 组合评审）、e2eTemplate 物化、升档审批卡已随 v3.2 第二批实施；**Phase 3 DSH 插件能力（`dsh/`：childId 寻址注入、skill 注册、tw 原生工具、席位徽标）已实施并随唯一根市场制品发布**——自动验证层（cordis 装载/功能矩阵/实机 boot 链）全绿，真实 LLM 注入效果待用户实机确认（根 README 的 DSH 节）；Phase 2 成本投影维持用户否决。详 Roadmap 与 docs/phase3-acceptance.md。
- **人工门禁**：任务静止由 DSH 语义天然保证（无宿主自动续跑）；决定凭证绑定制品指纹。

## 9. 完成标准（Definition of Done）

1. 第 3 节全部"编码"条目有回归测试，全部"消解"条目有契约测试；
2. I1–I10 各有测试；
3. 第 7 节预算达标；
4. 一个真实任务在 DSH 上完成全链路：从 code-review 介入，Owner 交付 → Challenger/Expert 评审 → Owner 回应 → 人工门禁 accept → completed，全程无模型因参数形状被拒超过一次；
5. 归档链路实测：completed 任务与部分工作流任务各归档一次，重放安全、归档目录只读、原任务目录清理；
6. Roadmap 记录 pivot 决定与 OpenCode 冻结声明；file-inventory 同步。

## 10. 与既有文档的关系

- AGENTS.md：产品边界不变，继续作为唯一事实源；
- runtime-v2-architecture.md：其 §7.3、§8.6、§11 由本文替代；其余条款在明确废止前继续参考；
- v2-e2e-findings.md：继续作为回归台账，本文第 3 节是其处置台账；
- runtime-roadmap.md：待本文冻结后记录 pivot 与里程碑。
