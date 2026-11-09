# 波次派发卡与规则库重构方案

状态：已批准（2026-11-06 用户确认按双层规则架构与方式 A 实施；详见第七节修订记录）。

## 需要批准什么

一句话：派单卡由一套**固定生成规则**产出，只有 **runtime 与 rules 两种填充**；规则库为 `team-work/rules/`（公共规则在 `common/`，含 `index.md` 与各场景 `<scene>.md`；角色为第一层、场景为子目录）；**Lead 不读派发卡**，由 skill 指路读对应 md、工具在固定时点反吐规则（如轮次结束汇报提醒）；同路径包内默认在前、项目补充追加在后。

请批这五条（同意或改其中一条即可实施）：

1. **规则库目录与纪律区生成规则**：库目录 `team-work/rules/`（由 `team-work/guidance/` 更名重组）：`common/`（`index.md` 公共通用规则 + 各场景 `<scene>.md` 场景公共规则）、`<角色>/README.md`（角色通用规则）、`<角色>/<场景>/`（角色×场景规则）。会进成员卡的规则文件用三个二级标题分区：`## 规范`、`## 红线`、`## 建议`，标题下直接写条目，不在条目上自标力度；空标题整段不写。成员卡按文件标题抽取后合成同样三个段，顺序为规范 → 红线 → 建议，空段省略。来源顺序为角色 → 角色×场景 → 场景公共 → 公共通用，类内按文件名排序。
2. **成员卡固定骨架与双层纪律**：段落固定为「卡头 → 本轮验收基线 → 工作流职责（TWR 固定契约）→ 规范 / 红线 / 建议 → 行动与交付」；填充只有 **runtime**（任务事实投影 + 包内锁定工作流职责）与 **rules**（可 DIY 规则库读取）。TWR 工作流必需的硬规则（成员身份与禁止越权、范围争议停手 `blocked / escalate / escalate-to-user`、评审/裁决新鲜度与工具合同、`junior` 只读助手委托边界）锁在包内 `## 工作流职责（TWR 固定契约）` 段，不可被外部目录覆盖或修改；其余角色、场景引导与执行守则放入 `team-work/rules/` 可 DIY 层，按文件同名标题合成 `## 规范` / `## 红线` / `## 建议` 三段。
3. **成员侧去掉明晰必读第二块**：`requiredGuidance` 投影与双 text 块投递删除；成员的交卷摘要与表达要求由场景规则条目明文承载（写入 `common/<scene>.md` 或 `<角色>/<场景>/` 对应条目）。
4. **Lead 的规则走独立通道**：派发卡只给成员；skill（team-work-v3）指明什么时点读 `team-work/rules/lead/` 下哪个 md；`tw` / `tw-dispatch` 在固定时点（决定点 / 派发与在途 / 进展）把 `lead/<时点>/` 的规则与根包明晰必读段反吐进返回输出。现有 PRESENTATION 常量文案搬进对应 md。
5. **方式 A（用户公共可改目录 + 项目目录按三标题合并）**：TWR 工作流硬规则已由包内锁定层承载；`team-work/rules/` 下的可 DIY 规则支持用户公共目录 `~/.team-work/rules/` 自定义修改（单文件优先读 `~/.team-work/rules/`，不存在时自动回退读包内出厂默认 `team-work/rules/`；`tw init` 按文件摘要增量同步出厂模板，用户已修改文件不覆盖、新版写 `.default.md` 旁路供参考），并在运行时与当前项目下的 `team-work/rules/` 按同名三标题追加合并。

批准后的实施范围（文件清单见第四节）：规则库目录更名重组、`runtime-v3/guidance.mjs`（随之更名 `runtime-v3/rules.mjs`）、`runtime-v3/cli.mjs`、`dsh/subagent-session.js`、`dsh/tw-dispatch.js`、skill 两处文本、相关测试、`docs/file-inventory.json` 与 `AGENTS.md` 的模块描述句。不新增角色、轮次、工具参数、任务状态或门禁；不改波次机、交付校验、选模与会话恢复；不升版、不安装、不发布。

入口即需可见的风险与开放问题（详见第六节）：

- TWR 工作流职责锁在包内不可覆盖；可 DIY 规则层通过 `~/.team-work/rules/` 支持用户直接增删改默认条目，并与项目根 `team-work/rules/` 追加合并。
- 现有五份场景文里角色句与通用句混写，逐句拆分归属与力度标记补标在实施轮逐文件完成，拆错可热改 md 纠正。
- skill 指路依赖 Lead 真去读 `lead/README.md`；工具反吐不依赖主动性但只在三类时点触发，两通道互补。

## 一、已核对的现状（本轮重新核对源码）

下列是当前实现事实，不是拟议。现状目录名 `team-work/guidance/` 与 `loadGuidance` 等命名为现状代码事实；拟议将其更名 `team-work/rules/`，见第二节。

### 1. 真正进成员的内容

| 渠道 | 位置 | 何时注入 | 现在给谁 |
| --- | --- | --- | --- |
| 派单正文 `prompt` / `promptFull` | `runtime-v3/cli.mjs` 的 `dispatchCard` | 首派、续派、在途重建 | 该波成员 |
| 第二文本块 `requiredGuidance` | `tw()` 出口投影 + `dsh/subagent-session.js` 的 `memberMessage` | 每次实际投递（含冷提醒） | 全体成员：明晰公共段；评审/裁决成员或 design/design-review/spec-review/code-review 的 Owner 再加审阅段 |
| 角色模板 | `team-work/guidance/roles/<role>.md` | 有文件则整份拼进正文 | 该角色所有场景 |
| 场景模板 | `team-work/guidance/scenes/<sceneId>.md` | 有文件则整份拼进正文 | 该阶段全体角色 |
| 硬编码职责边界 | `dispatchCard` 的 `memberBoundary` | 每张派单 | 全体成员（与角色模板首条重复） |
| 验收基线 / 可写范围 / 交付命令 / 返工与被审上下文 | 同函数 | 按角色与波次种类 | 见该函数现有分支 |

派单正文段序现状是：卡头 → 成员职责边界 → 角色指引 → 场景指引 → 验收基线 → 可写范围与交付。成员先读纪律、后读任务。

已有场景文件：design、design-review、code-review、implementation、test。工作流（`workflow/definitions/engineering.json`）还声明了 research、spec、spec-review、e2e、finish 五个 teamScene，没有对应文件，派发时静默跳过。roadmap 的 D2 事项已建议补 spec 场景规则。

### 2. Lead 侧与明晰段

| 渠道 | 位置 | 说明 |
| --- | --- | --- |
| `presentation` | `attachPresentation`（cli.mjs） | 决定点 / 派发 / 进展三类时点给 Lead 的返回卡拼「呈现纪律常量 + 明晰必读段」（决定点加审阅段）；进展判定含终态卡——status/stop 为 completed/archived/wait-inflight 也命中，每次查询重新附加、无已读标记，重复终态查询也在场（skill 的 guidance 参考同样明示）；机械回执不命中。挂在 `tw` / `tw-dispatch` 返回给 Lead 的卡片上，不进成员 `prompt`。 |
| 明晰必读 | `requiredGuidance` | 同时误给全体成员（成员执行实现或测试并不需要面向人的汇报规范）。 |
| 插件 `systemPrompt` | `dsh/settings.js` 的 `systemPromptSection` | 工具分工表与档位候选，面向 Lead，挂在宿主系统提示上。本轮不改。 |
| `team-work` 技能 | `skills/team-work-v3/`（SKILL.md + references） | 同时写了成员纪律与 Lead 操作规程；references/guidance.md 描述现有规则库与明晰段机制。 |

明晰必读段从根包 `skills/clarity-guidance/output-standard.md` 与 `skills/clarity-review/references/review-rules.md` 的唯一必读标记提取（`createClarityGuidanceReader` / `requiredClarityText`），避免静态副本，成员与 Lead 同源。

### 3. 覆盖机制（已有）

`runtime-v3/guidance.mjs` 的 `loadGuidance`：先读包内 `team-work/guidance/`，再读项目根同名路径，**项目同名文件整份覆盖包内默认**；目录缺失当「无自定义」；项目层单文件读失败打 stderr 警告并回退包内基线；无缓存，每次真正派发重读（惰性：只在真正派发与在途重建两个分支加载）。`tw init` 不把规则库拷进项目，默认模板始终留在包内。

### 4. 由事实推出的问题

1. 明晰汇报规范误入成员第二块（受众错位）。
2. 场景文夹角色句子：实施 Owner 会读到方案写法，方案 Challenger 读到「Owner 写完整方案」。
3. 纪律段（职责边界、角色指引、场景指引）排在验收基线之前。
4. `memberBoundary` 与 `roles/*.md` 首条重复。
5. 旧稿以维护「卡片模式登记表」的方式扩充栏目，与本任务「卡片栏目由固定规则推导、不得维护可变栏目清单」的目标冲突。

## 二、新设计

方案由三样东西构成：**规则库（数据，`team-work/rules/`）**、**成员卡生成规则（代码，固定）**、**Lead 规则通道（skill 指路 + 工具反吐，代码与数据各半）**。扩充只动数据、代码保持固定；代码变更加载面仅限三种情形：新填充方式、新骨架段、新反吐时点。

### 1. 规则库目录（数据）

```
team-work/rules/
  README.md               ← 库根说明：目录约定、追加规则与三标题约定；仅作库文档
  common/                 ← 公共层
    index.md              ← 公共通用规则（全体成员）
    <scene>.md            ← 场景公共规则（该场景全体角色），如 design.md、implementation.md
  <角色>/                  ← 角色层（该角色所有场景）
    owner/ challenger/ expert/ lead/
    README.md             ← 角色通用规则
    <场景>/                ← 角色场景层（只进这个角色 × 这个场景的派单）
      index.md ...
  lead/                    ← Lead；其「场景」键是呈现时点，不是工作流阶段
    README.md
    dispatch/index.md  decision/index.md  progress/index.md
```

规则（固定，写进渲染器与文档）：

1. **成员卡注入来自三类目录**：`common/`、`<role>/`（根级 .md）、`<role>/<teamScene>/`。库根级散文件（含 README.md）仅作库文档；`<role>/` 下仅当前场景的子目录参与解析；场景公共规则统一放 `common/<teamScene>.md`（公共层内按场景名分文件）。
2. **`common/` 内文件按完整场景集合分两批，互不重叠**：文件名匹配工作流定义中任一 `stages[].teamScene` 的 .md 是**场景文件**（只进同名场景的派单），其余 .md 是**公共通用文件**（进所有派单；按文件名排序，`index.md` 是公共通用规则的惯例首选文件名，与外层 `team-work/rules/` 目录名清晰区分）。派单时注入三类内容：全部公共通用文件 + 当前场景的场景文件（`common/<当前 teamScene>.md`，只此一份、只注入一次）+ 角色与角色场景层（见下条）；每个场景文件只进同名场景的派单——design 派单读 `common/design.md`，implementation 派单读 `common/implementation.md`。完整场景集合直接取自 Runtime 派发时已读取的工作流定义（现状源码事实：`runtime-v3/cli.mjs` 的 `loadDefinitions` 持有 `stages[].teamScene`，定义文件 `workflow/definitions/engineering.json` 当前声明 research、design、design-review、spec、spec-review、implementation、test、code-review、e2e、finish 十个 teamScene），按该集合对 `common/` 文件名作成员判定。
3. `<role>/` 根级 .md 全部为角色规则（`README.md` 是角色层的惯例首选文件名——作为角色目录自述文件的通用浏览惯例，机制上与 `index.md` 等价：都是层内按文件名排序注入的普通 .md）；`<role>/<teamScene>/` 下全部 .md 为角色场景规则（按文件名排序）。将来若统一层内默认文件名，只需重命名数据文件，渲染器保持不变。
4. `lead/` 只服务 Lead 的两条通道：skill 指路（Lead 主动读 `lead/README.md`）与工具反吐（按呈现时点读 `lead/<时点>/`）；成员派单的注入来源是上面三类目录。Lead 的时点键 = dispatch（派发与在途）、decision（决定点）、progress（进展与轮次结束），按呈现时点而非研发阶段分子目录。
5. **三标题约定**：会进成员卡的文件用 `## 规范`、`## 红线`、`## 建议` 分区；标题下直接写条目。渲染器按标题读取，不认条目前缀。
6. `common/<scene>.md` 与 `<角色>/<场景>/` 的分工：前者放该场景全体角色都适用的规则，后者放只对该角色的规则；两者顺序合入同一规范段，不重叠内容。

### 2. 成员派发卡生成规则（代码，固定）

填充只有两种：**runtime**（从任务事实投影）与 **rules**（从规则库读取）。段落顺序固定：

| 段 | 填充 | 内容 | 相对现状的变化 |
| --- | --- | --- | --- |
| 卡头 | runtime | 派单/续派标题 + 任务行（任务、阶段、角色、轮次、包、波） | 不变 |
| 本轮验收基线 | runtime | 总目标（背景）、约束、排除、完成标准（Owner 本包 done；Challenger/Expert 各包 done） | **位置前移**：从规则段之后移到之前，成员先读任务再读纪律 |
| 工作流职责（TWR 固定契约） | runtime（包内锁定） | 按角色（owner / challenger / expert）固定输出 TWR 工作流硬规则（身份边界、争议停手/升级、评审/裁决合同与新鲜度、只读助手边界） | **包内锁定**：不读外部目录，不可被用户或项目覆盖 |
| 规范 / 红线 / 建议 | rules（可 DIY） | 从用户公共目录 `~/.team-work/rules/`（缺省回退包内默认）+ 项目 `team-work/rules/` 按同名标题抽取合成三段 | **重做**：动态扫描文件名 + 三标题合成，支持用户自定义与项目合并 |
| 行动与交付 | runtime | 可写路径、越界后果、组合评审对象、包计划、交付/评审命令、verdict 语义、返工上下文、上轮 blocked 原因、内嵌声明 | **吸收**带任务事实与波次条件的句子 |

纪律区的求值规则（渲染器唯一算法）：

1. 会进成员卡的规则文件只认三个二级标题：`## 规范`、`## 红线`、`## 建议`。渲染器读取各标题下的条目，不按「红线：」「严格遵循：」等条目前缀分类。
2. 卡上合成同样三个段，顺序固定为规范 → 红线 → 建议；某一标题在所有来源下都没有条目则省略该段。
3. 每个标题内部，四类来源按「角色 → 角色×场景 → 场景公共 → 公共通用」连排：角色（`<role>/` 根级 .md，文件名排序）→ 角色场景（`<role>/<teamScene>/` 下 .md，文件名排序）→ 场景公共（`common/<当前 teamScene>.md`，仅此一份）→ 公共通用（`common/` 内文件名属于通用批的 .md，文件名排序）。每个场景文件只出现在同名场景的派单里。
4. 同一相对路径：基线层优先读用户公共目录 `~/.team-work/rules/`，若该文件在用户公共目录不存在则回退读包内出厂默认 `team-work/rules/`；项目根 `team-work/rules/` 同名路径正文追加在基线层之后（详见第 4 节）。
5. 三个标题在所有来源下都为空则整段可 DIY 纪律区省略（包内锁定的「工作流职责」段始终在场）。
6. 读失败：包内默认文件静默跳过；用户公共目录或项目目录文件存在但读取失败时打 stderr 警告并回退/跳过。规则是增强不是门禁。

工作流硬规则与 `memberBoundary` 的去向：

- TWR 工作流必需契约（成员身份与不越权、范围争议 `blocked / escalate / escalate-to-user`、评审与裁决新鲜度及工具合同、`junior` 只读助手委托边界）→ 包内锁定段 `## 工作流职责（TWR 固定契约）`（由 `rules.mjs` 的 ` lockedWorkflowContract(role)` 固定提供，不可覆盖）。
- 角色、场景引导与执行守则（怎么写方案、代码风格与最小改动、测试用例编码规范、审查方向、交付摘要写法）→ `team-work/rules/` 可 DIY 层。
- 「你仅承担本包 X」「组合评审仍覆盖本轮已交付包的组合制品」「Expert 裁决语义」等带当波任务事实的句子 → runtime 尾段。

成员的交卷摘要与表达要求：写入场景规则条目——全体角色适用的放 `common/<scene>.md`（如「交卷 summary 用一句话完整句，先给结论」），只对特定角色的放 `<角色>/<场景>/`。它们是普通规则数据：可被项目追加补充，默认写错改包内源文件。

### 3. Lead 侧：skill 指路 + 工具反吐

派发卡（`prompt`）只给成员；Lead 消费的是工具返回的状态卡与简报（机器输出，保留现状出口），规则经下面两条通道到达 Lead：

1. **skill 常驻**：`skills/team-work-v3/` 继续是 Lead 的操作规程（怎么开任务、派发、等待、汇报）。`references/guidance.md` 更名 `references/rules.md` 并重写为新目录说明，指明：Lead 读 `team-work/rules/lead/README.md`（通用推进纪律），决定点 / 派发 / 进展时点对应读 `lead/decision|dispatch|progress/index.md`。明晰规范正文仍在根包 clarity 技能文件（权威源），skill 继续链接同源文件。
2. **工具反吐**：`tw` / `tw-dispatch` 返回输出在固定时点反吐规则。时点判定**完全沿用**现有 `attachPresentation` 判定，本方案不改任何时点行为：决定点 = status/stop/transition 为 awaiting-user/blocked；派发 = transition 为 dispatch（含在途）；进展 = transition 为 advance/complete/wait-inflight、status/stop 为 completed/archived/wait-inflight（终态卡命中，重复终态查询与现状一致每次在场），以及 run 的 working+next=dispatch；机械回执不命中。反吐内容 = 对应 `lead/<时点>/` 目录下文件正文（按文件名排序）+ 明晰必读段（决定点加审阅段，仍从根包 clarity 文件提取，同源机制与诊断行保留）。

现有 `PRESENTATION_DECISION/DISPATCH/PROGRESS` 三个常量文案（「向用户简报：本阶段派发了什么……」「呈现纪律：向用户说明当前要决定什么……」等）搬进对应 `lead/<时点>/` md，成为规则数据；代码只负责时点判定与拼接。反吐出口保持现状：仍挂返回卡 `presentation` 字段与人读通道的 human 路由，DSH 绑定层（`tw-dispatch.js` 透传 `plan.presentation`）结构不变。

「轮次结束汇报提醒」落点：wait-children（波次全部在途）反吐 `lead/dispatch/`——含「输出派发简报后自然结束回合、宿主会在成员完成时唤醒、唤醒后先核报告再推进」；成员完成唤醒后的推进输出反吐 `lead/progress/`——进展汇报要求。两处正文是规则数据，改提醒措辞改 md 即可。

成员侧对应删除：`tw()` 出口的成员 `requiredGuidance` 投影、`memberNeedsClarityReview` 场景判定、`memberMessage` 的第二 text 块、`tw-dispatch.js` 链上的 `requiredGuidance` 字段、人读通道的「成员 X 必读规则」块。成员消息变成单块业务正文。

### 4. 方式 A：包内锁定契约 + 用户公共可改目录 + 项目追加合并

- **包内锁定层**：`## 工作流职责（TWR 固定契约）` 固定从包内代码生成，不读任何外部目录，确保 TWR 核心工作流不被改坏。
- **可 DIY 规则层合并单位**：规则库内的相对路径（如 `owner/design/index.md`、`common/implementation.md`），按目录动态扫描文件名取并集（未预置的 `<角色>/<场景>/` 或新场景文件一旦由用户在公共目录或项目目录创建即自动生效）。
- **基线源（用户公共目录优先、包内默认回退）**：对每个相对路径，先查用户公共目录 `~/.team-work/rules/`（支持传入 `userRulesRoot` 覆盖）；若存在则采用用户公共目录版本（允许用户直接修改或删减默认条目），若不存在则自动回退读取包内出厂默认 `team-work/rules/`。
- **项目追加**：当前项目根 `team-work/rules/` 下的同名路径正文追加在基线源之后，按同名三标题（`## 规范` / `## 红线` / `## 建议`）合入同一段。
- **`tw init` 增量同步与修改保护**：释放或更新 `~/.team-work/rules/` 时，按文件摘要比对——缺失文件直接补齐；与旧出厂默认一致（用户未改过）的文件静默更新为新版默认；用户已自行修改过的文件保留用户版本不覆盖，并将新版默认写为同目录 `<name>.default.md`（加载器忽略 `*.default.md`）供用户参考合并。

### 5. 样例（拟议，用于核对理解）

任务 `export-plan`，角色 owner，场景 design，无项目补充。磁盘上：

| 文件 | 正文摘要 |
| --- | --- |
| `common/index.md` | 严格遵循：不臆造不揣测，争议先停手。建议：限定小问题可委托 junior 只读助手。 |
| `common/design.md` | 严格遵循：不套代码八视角。建议：改与不改是审查边界。 |
| `owner/README.md` | 严格遵循：你是已分配 Owner，不重建团队；对照验收基线工作。 |
| `owner/design/index.md` | 严格遵循：写完整方案，保留修改、约束、接口、顺序、失败与恢复；完整方案是唯一人工批准正文。建议：交卷 summary 用一句话完整句，先给结论。 |
| `lead/dispatch/index.md` | 派发简报要求与轮次结束提醒（只给 Lead）。 |

成员卡：

```
# 派单（key: d1-a1b2c3）
任务：export-plan；阶段：design（方案设计）；角色：owner；轮次：1；波：wv1

## 本轮验收基线
任务总目标（背景；你的职责以本派单角色、范围和完成标准为准）：……
约束：……
本包完成标准：……

## 规范
（common/index.md 原文）

（common/design.md 原文）

（owner/README.md 原文）

（owner/design/index.md 原文）

## 行动与交付
可写路径（仅限）：……
完成后调用：tw deliver --task export-plan --key d1-a1b2c3 --outcome delivered --summary <一句话> --paths docs/export-plan.md
上下文与派单已内嵌；不要读取 .team-work 内部状态，不要扫描项目外路径。
```

规范段内四类来源顺序合入、无渲染器子标题；括号注释仅为本样例标注来源，实际卡片是文件原文。

同任务场景改成 implementation：场景公共批读 `common/implementation.md`（`common/design.md` 属于 design 场景，仅进 design 派单）；`owner/implementation/` 若无文件则角色场景批为空——实施 Owner 读到的是实施场景的规则内容。

项目想给方案 Owner 追加一句「图表先于长文」：放项目根 `team-work/rules/owner/design/index.md` 只写这一句，规范段里该文件位置变成包内全文 + 项目这句；包内模板未动。

Lead 在 wait-children 时收到的反吐（拟议）：`lead/dispatch/index.md` 正文 + 明晰公共必读段，挂在返回输出上，与派发简报同现。

### 6. 怎么扩充（以后）

| 想做的事 | 动什么 | 改代码？ |
| --- | --- | --- |
| 新场景（如补 e2e） | 加 `common/<场景>.md`；按需再加 `<角色>/<场景>/` | 否 |
| 新角色 | 加 `<角色>/README.md`；派单角色名对上即生效 | 否 |
| 新公共规则类别 | `common/` 加新 md；文件名与某 teamScene 同名时自动成为该场景的场景文（只进那个场景的派单），通用文件用场景名以外的文件名 | 否 |
| 改默认正文 / 改 Lead 呈现要求 / 改力度 | 改包内对应 md | 否 |
| 项目补充 | 项目根 `team-work/rules/` 同路径 md（追加） | 否 |
| 改「规范」段标题或四类来源顺序 | 改渲染器（段标题与顺序是生成规则） | 是 |
| 新反吐时点 / 新填充方式 / 新骨架段 | 改渲染器 | 是 |

规范段内容完全由目录中实际存在的文件决定：加了文件才有内容，四类全缺则整段省略。

## 三、明确不改

- 波次推进、门禁、报告 schema、选模、会话判重、`prompt`/`promptFull` 选用协议、`tw run`/`gate` 只读语义。
- 验收基线仍从 intent 与包计划原样投影；规则不改变派单授权与交付合同，与正文冲突时以派单正文为准。
- 明晰正文仍只从根包 clarity 技能文件提取（同源、无静态副本），且只到达 Lead。
- 插件 `systemPrompt` 委派表、宿主技能目录装载、仓库开发契约本轮不动（只记录）。
- 不在本轮切断子会话技能目录可见性；不为建议增加机器字段或新门禁。
- 跨项目共享自定义层（包内与项目之间再加一层）本轮不做，需要时另行提案。

## 四、实施步骤（批准后才做）

1. **规则库目录更名重组**（数据先行）：`team-work/guidance/` → `team-work/rules/`；`roles/<role>.md` 拆入 `<role>/README.md`（吸收角色插值句）；`scenes/<scene>.md` 逐句拆分：全体角色适用句入 `common/<scene>.md`，Owner/Challenger 特有句入对应 `<角色>/<场景>/`；公共纪律入 `common/index.md`，角色通用规则入 `<角色>/README.md`（命名约定见第二节规则 2、3）；交卷摘要与表达要求按场景写入 `common/<scene>.md` 或 `<角色>/<场景>/` 条目；各文件按 `## 规范` / `## 红线` / `## 建议` 分区（空标题不写）；Lead 呈现文案（PRESENTATION 常量 + 轮次结束提醒）入 `lead/`；库根 README.md 写目录约定与三标题约定。
2. **`runtime-v3/guidance.mjs` → `runtime-v3/rules.mjs`**：模块随库更名；新接口（拟议形状）`resolveMemberRules({ role, teamScene, projectRoot })` → `[{ source, name, text }]`（四类来源、类内排序、包内+项目追加、读失败诊断）；`resolveLeadRules({ kind, projectRoot })` 供反吐；`loadGuidance` 旧接口移除；惰性加载与热变语义保留；明晰提取器（`requiredClarityText` / `createClarityGuidanceReader`）原样保留于更名后模块。
3. **`runtime-v3/cli.mjs`**：`dispatchCard` 按第二节骨架重排（基线前移、`memberBoundary` 拆除、纪律区按规范 → 红线 → 建议三段合成）；`tw()` 出口删成员明晰投影与 `memberNeedsClarityReview`；`attachPresentation` 改为 lead md + 明晰段反吐，时点判定保留。
4. **DSH 绑定层**：`dsh/subagent-session.js` 的 `memberMessage` 单块；`dsh/tw-dispatch.js` 删 `requiredGuidance` 传递链。
5. **skill 修订**：`references/guidance.md` 更名 `references/rules.md` 并重写（新目录、追加语义、力度标记约定、Lead 指路、反吐说明）；`SKILL.md` 链接同步、「自动表达规则」段改为 Lead 反吐口径。
6. **测试与登记**：`tests/runtime-v3-guidance*.test.mjs` 随模块更名 `runtime-v3-rules*.test.mjs` 并更新断言（四类来源、单一规范段、追加合并、读失败）；cli 派单卡与出口测试（段序、单块、无明晰段、反吐时点与终态口径）、`tests/dsh-subagent-session.test.mjs`、`tests/dsh-dispatch.test.mjs`；同步 `docs/file-inventory.json`（`team-work/rules/` 路径、模块与测试文件名）与 `AGENTS.md` 的 Team-work 模块描述句、roadmap 条目。
7. **自检与复核**：专项与完整套件通过后，做一次小范围交叉复核（按需选少量互补视角），再交正常评审门。

## 五、验收（批准后）

- 成员卡每一段能指认来源：runtime 投影或四类来源某路径（渲染单测按来源类与文件名断言）。
- 加一个夹具 md（如 `owner/design/notes.md`）不改代码即出现在规范段对应位置；删掉即消失——证明栏目完全由目录内容推导。
- 纪律区为「## 规范」「## 红线」「## 建议」三个标题（空段省略），条目来自规则文件同名标题下的正文。
- 默认库条目带力度标记；各已有场景的规则文件含交卷摘要/表达条目（`common/<scene>.md` 或 `<角色>/<场景>/`）。
- 实施场景的规则内容只覆盖实施（方案写法仅出现在 design 场景的规则文件中）；方案 Owner 读到方案写法。
- **场景隔离**：以两个既有场景夹具验证——design 派单的规范段来源 = 公共通用批 + `common/design.md` + 角色层 + `owner/design/`，implementation 派单同理只含 `common/implementation.md` 与实施场景的角色文件；场景文件只进同名场景的派单且只注入一次，公共通用批由场景名以外的文件构成。
- 成员消息为单块业务正文，明晰段只随 Lead 反吐出现；Lead 反吐出现在决定点 / 派发与在途 / 进展时点，机械回执保持原样、终态幂等查询与现状一致每次在场（反吐时点判定与现状完全一致，本方案无时点行为变更）；决定点反吐含审阅段。
- 项目同路径追加生效；项目文件读失败警告且包内默认完整；包内读失败静默跳过。
- 规则仍只在真正派发与在途重建时加载（惰性不变）。
- 规则正文质量与缺失场景（research/spec/spec-review/e2e/finish）的内容补齐另行安排：缺失场景文件按现状语义静默跳过，本轮验收只覆盖机制，内容按场景需要另行补写。

## 六、风险与开放问题

1. **项目无法关闭默认条目**：追加语义下项目只能补充文本，不能删除或关闭包内默认规则。这是第 5 条决策的直接代价；若将来确需「关闭」能力，须另行提案（新机制，本轮不做）。
2. **场景文拆分与力度标记迁移**：现有五份场景文里角色句与通用句混写，逐句拆分归属与力度补标在实施轮逐文件判断；拆错可热改 md 纠正（数据热变），不构成返工风险沉淀。
3. **Lead 主动读 md 的依从性**：skill 指路依赖 Lead 真去读 `lead/README.md`；反吐通道不依赖主动性，但只在三类时点触发。两通道互补，覆盖不了「Lead 自行选择时点」的场景——这本来就是判断指引而非强制，与现状 skill 性质一致。

## 七、修订记录（未批准草稿的设计轮修订）

- **轮次 2（2026-11-03）**：修正反吐时点口径的自相矛盾。轮次 1 稿在第二节3 写「幂等终态查询不重复附段」、第六节写「幂等终态查询不出现」，而源码现状（`cli.mjs` 的 `attachPresentation` 进展判定含 status/stop 为 completed/archived/wait-inflight，每次查询重新附加，无已读标记；skill guidance 参考 L23 同述）是终态幂等查询每次在场。经独立核对源码属实，统一三处（现状表、第二节3、第六节）为「完全沿用现有判定：终态幂等查询与现状一致仍在场，本方案无时点行为变更」。未采纳「改为不出现」的备选：那是一个未列入五条批准项的行为变更，无需求驱动，须用户显式批准后另行修订。
- **轮次 3（2026-11-03，用户人工门三条修订）**：(1) 公共层改目录：废除库根并列的 `<场景>/` 目录，场景公共规则并入 `common/<scene>.md`（与公共通用文同在 `common/`）；卡上公共场景文与角色场景文合成单一「规范」段，不再有四层轻标题。(2) 库目录 `team-work/guidance/` 更名 `team-work/rules/`，填充枚举 guidance → rules，卡上纪律区标题用「规范」不用指引/引导，条目力度由正文标记（严格遵循、红线、建议、提倡），标题不代替力度；模块与测试文件名随实施清单同步更名。(3) 删除「成员摘要可读性待真实任务验证」类悬置表述；交卷摘要与表达要求改由场景规则条目明文承载（`common/<scene>.md` 或 `<角色>/<场景>/`）。同步修改五条批准项、目录树、生成规则、样例、实施清单、验收与风险列表。Expert 裁决对轮次 2 版为 accept（含 15/15 判定内存探针，非全套测试）；用户在人工门决定按上述三条修订正文。
- **轮次 3 增补（2026-11-03，用户增量）**：公共层默认文件由 `common/rules.md` 改为 `common/index.md`——`rules.md` 与外层 `team-work/rules/` 目录名撞车且不统一；各场景公共文仍为 `common/<scene>.md`。角色层默认文件未点名，维持 `README.md` 并在第二节规则 3 写清命名差异理由（无撞车问题、目录自述通用惯例、机制等价，统一命名仅是数据重命名）。库根说明文件维持 `README.md`。本条并入轮次 3 返工稿，不另开范围。本版为修订后待批准稿。
- **轮次 4（2026-11-04，Expert 裁决返工）**：修正公共规则分类的跨场景注入缺陷。轮次 3 稿第二节规则 2 写「文件名等于当前 teamScene 的是场景规则，**其余根级 .md 是公共通用**」，该算法会把其他场景的场景文件（如 design 派单时的 `common/implementation.md`）当作通用文注入当前派单，与样例「同场景改 implementation 后 design.md 不再命中」及验收「实施无方案写法内容」的场景隔离要求矛盾；Expert 以三个夹具文件对 design/implementation 两场景按正文算法推演出双向跨场景注入，缺陷属实。修正（原授权内，不新增设施）：场景文件按**完整 teamScene 集合**判定（文件名匹配任一 `stages[].teamScene` 即场景文件），公共通用批 = `common/` 内不属于任何 teamScene 的 .md，公共场景批只读 `common/<当前 teamScene>.md` 一份且只注入一次，其他场景的场景文件完全不进当前派单；完整场景集合的事实来源为 Runtime 派发时已读取的工作流定义（`loadDefinitions` 持有 `stages[].teamScene`，现状源码事实，不需要登记表）。同步修改第二节规则 2、生成规则 1、样例场景切换说明、扩充表「新公共规则类别」行，验收新增「场景隔离（跨场景零注入）」夹具项。用户已定决策（`team-work/rules/` 目录、runtime/rules 两种填充、`common/index.md` + `common/<scene>.md`、单一「规范」段、力度正文标记、场景规则承载交卷摘要、反吐时点完全沿用现状）全部保持；批准前仍不改 Runtime、规则文件、skill 或测试。
- **轮次 5（2026-11-04，用户人工门措辞修订）**：批准正文改为只陈述现行约定——删除把修订过程否掉叫法写成长期禁令的否定句（如「纪律区标题不含指引/引导」「不用 rules.md」「不设库根并列场景目录」「不建 Lead 表」「没有卡片模式这个概念」等），删除整节「相对旧草稿推翻了什么」（该信息由本修订记录承载），章节由八节并为七节；算法性排除陈述改为正面表述（场景文件只进同名场景派单、库根散文件仅作库文档、渲染器只产生单一规范段标题等）；状态行补齐轮次计数（原滞后于第八节实际记录）。五条决策与全部技术口径（runtime/rules 两种填充、common/index.md + common/<scene>.md、完整 teamScene 集合判定、反吐时点完全沿用现状含终态口径）均保持轮次 4 版原样。
- **轮次 6（2026-11-04，用户修订生成规则）**：去掉「单一规范段 + 条目自标力度」；规则文件用 `## 规范` / `## 红线` / `## 建议` 三个标题分区，渲染器按标题读取条目（不按条目前缀筛选）；卡上同样三段，顺序规范 → 红线 → 建议，空段省略。来源顺序改为角色 → 角色×场景 → 场景公共 → 公共通用。`lead/` 时点文案不套这三标题。
- **轮次 7（2026-11-06，用户拍板双层架构与方式 A 并批准实施）**：(1) 区分「TWR 工作流必需引导」与「角色/场景执行守则」：前者锁在包内 `## 工作流职责（TWR 固定契约）` 不可覆盖；后者放在 `team-work/rules/` 可 DIY 层。(2) 可 DIY 层采用方式 A：单文件优先读用户公共可改目录 `~/.team-work/rules/`、不存在时回退读包内出厂默认，再与项目根 `team-work/rules/` 按三标题合并；`tw init` 支持增量释放与已修改文件保护（写 `.default.md` 旁路，不覆盖用户修改）；加载器按文件名动态扫描，空缺的角色×场景文件由用户创建后即自动生效。(3) 规则内容定稿：实施场景合入测试用例编码规范、方案设计去掉批准后冻结条款、代码审查收紧为只交审查报告不修改产品代码、Expert 角色层与角色×场景层去重。
