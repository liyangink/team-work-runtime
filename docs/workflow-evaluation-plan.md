# 多智能体协作范式基准评测与评估体系方案

状态：阶段 0（最小探路验证 Spike）已实测跑通；`Single (1-Pass + 3-Pass)`、`Single-Opus-5.5`、`Free-Team (J+S+E)`、`TWR (J+S+E)` 端到端闭环及多帧 Zstd 真实美元账单采集均已验证通过，并定位到 10 项工程坑点与 1 处 TWR 运行时上下文裁剪瓶颈。

## 本次建议与批准范围

围绕本仓库最核心的设计主张——**“唯一可写 Owner + 非作者 Challenger + Expert 裁决”受门禁约束的多智能体协作范式**——构建独立于生产任务目录的基准评测框架（`evals/`）。通过控制相同的任务输入与验收标准，横向对比**「单 Agent（`J` / `S` / `E` 及天花板模型 `claude-opus-5-5`）」**、**「无协作范式的自由多 Agent 团队 `Free-Team (J+S+E)`」**与**「TWR 协作范式（`J+S+E` / `S+S+E` / `J+S`）」**，用实测数据论证当前范式在需求完成度、隐蔽缺陷捕获率与范围纪律上的真实优势，并按各模型官方计费规则（区分未命中输入、缓存命中、缓存写入、输出含思维链）核算真实美元成本与墙钟耗时。

已确认与更新的规划范围（**全程零修改 `runtime-v3/` 与 `dsh/` 生产代码**）：

1. **基准模型池与天花板对照**：
   - `Junior (J)`：`deepseek-flash`（官方对应 `DeepSeek-V4.1-Flash-1017`）
   - `Senior (S)`：`glm-5.3`
   - `Expert (E)`：`gpt-6.1-sol`
   - `Ceiling（单模型天花板对照）`：`claude-opus-5-5`（仅用于单 Agent 对照组，检验 TWR 的 `J+S+E` 能否在质量上逼近或超越最贵最强单模型、且真实花费更低）
2. **真实货币计费替代 `1:10:50` 权重**：废弃粗略档位权重，直接从宿主会话日志（`session.jsonl.zstd` 的 `assistant/message.usage`）提取每次请求的 `inputTokens`（未命中输入）、`cacheReadTokens`（缓存命中）、`cacheWriteTokens`（缓存写入）与 `outputTokens`（含思维链输出），按四款模型的官方公开单价逐请求精确计算真实美元成本（`USD`）。
3. **基于 `dsh-headless` 的纯净评测底座与防作弊隔离（已批准）**：基于宿主 `@deepseek-ai/dsh-headless`（核验基线版本 `0.2.1-rc.3`）与隔离评测 Profile（`eval-runner`），通过 `--patch` 叠加层按组精确开关工具、技能与子代理深度；每个测试用例在剥离 `.git` 历史、移除 `.team-work/archive/` 与历史方案文档的隔离环境中运行，判分测试与真值清单置于沙箱外，交卷后合入核验。
4. **“10 道外部公开权威基准原题（主榜）+ 2 道 TWR 治理纪律专项题（附加榜）”双榜题库（共 12 题，按 Tier-1 核心 6 题 + Tier-2 扩展 6 题两步漏斗执行）**：主榜 100% 采用外部公开基准原题与官方判分套件（`Multi-SWE-bench` × 2、`SWR-Bench` × 2、`CooperBench` × 2），附加榜独立评测外部基准未覆盖的方案审查（`design-review`）与范围争议早停（`trap-scope-conflict`），主榜与附加榜分开统计。

**待最终拍板的两个实验设计问题（讨论见下文）**：
1. **单 Agent 的“1 轮 vs 3 轮自审”**：建议采用**“同会话连续采样（Pass 1 交卷存快照 + 追加自审至 Pass 3 存快照）”**——跑一次实验同时拿到单模型的「1 轮原生表现（日常真实用法）」与「3 轮自审表现（等轮次对照）」，无需二选一。
2. **Lead 是否参与评测（端到端全真 vs 冻结规划）**：鉴于 Lead 拆包（`tw plan` 机械校验互斥/无环/完成标准）与调度本身就是 TWR 区别于 `Free-Team (J+S+E)` 的核心能力，建议**默认采用“端到端全真模式（不冻结 `packages.json`，仅固定组 B 与组 C 使用同一个 Lead 模型并输入一字不差的原始需求）”**。

---

## 一、已核实的源码与计费事实依据

### 1. 仓库与宿主源码事实依据（基于本仓库当前 HEAD 与宿主 `0.2.1-rc.3` 核验）

| 来源 | 已核实的事实与对评测框架的约束 |
| --- | --- |
| [`runtime-v3/store.mjs:44-52、82-123`](../runtime-v3/store.mjs#L44-L52)、[`runtime-v3/waves.mjs`](../runtime-v3/waves.mjs) | 活动任务目录（`.team-work/tasks/<name>/`）保存完整的 `scope.json`、`intent.json`、`packages.json`、`journal.jsonl`、`reports/*.json`、`decisions.json`、`snapshots/` 与 `agents.json`。 |
| [`runtime-v3/cli.mjs:48-55、1222-1237`](../runtime-v3/cli.mjs#L48-L55)、[`team-work/policies/default.json:11-38`](../team-work/policies/default.json#L11-L38) | `loadDefinitions` 从 `projectRoot/team-work/policies/default.json` 读取场景角色档位；`archive` 会清理 `reports/`、`snapshots/`、`agents.json`，故**评测采集必须在归档前读取活动任务目录**。 |
| [`dsh/index.js:18-28`](../dsh/index.js#L18-L28)、[`dsh/skill-embed.js:25-50`](../dsh/skill-embed.js#L25-L50) | 插件入口 `id: team-work-dsh` 同时注册 `tw`、`tw-dispatch` 工具及 `team-work`、`clarity-writing`、`clarity-review` 技能；在 `--patch` 中设 `team-work-dsh: { disabled: true }` 即可同时剥离 TWR 工具与内嵌技能。 |
| 宿主 `@deepseek-ai/dsh-tool-subagent`（`lib/index.js:311-320、532-563`） | 在 `dsh-headless` 根作用域下，常驻 `tool-subagent` 开启 `modelSelectionSettings: true` 会因缺少 `agent-preset` 作用域抛错；但支持通过 `config.agentOptions: { provider, model, reasoningEffort }` 绑定固定模型路由。因此 `Free-Team (J+S+E)` 通过挂载三个固定档位的委派工具实例（`subagent_junior` / `subagent_senior` / `subagent_expert`）即可在 `dsh-headless` 下精确使用 `J + S + E` 三档模型。 |
| 宿主 `@deepseek-ai/dsh-headless`（`lib/index.js:241-275、314、347-352`） | ① 内置 `while (true)` 循环调用 `await agent.whenIdle()` 与 `await subagents?.waitForChildren(agent)` 等待子代理完成并复查父会话状态；② 首轮不传 `--session-id` 时生成 `session-${randomUUID()}`，跨轮续跑需从 `$DSH_HOME/sessions/<cwd编码>/` 扫描顶层会话目录名获取 `sessionId`。 |
| 宿主 `@deepseek-ai/dsh-llm-pi-ai`（`lib/index.js:1439-1446`）与 `@earendil-works/pi-ai`（`openai-completions.js:1193`） | 持久化的 `usage` 对象中，`inputTokens` **已扣除缓存命中与缓存写入 Token**（即纯未命中输入 `Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)`），`outputTokens` **已包含思维链 Token**，`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。因此按字段直乘单价不会发生重复计费。 |

### 2. 四款评测基准模型的官方计费规则表（单位：USD / 百万 Tokens）

经核查各模型官方公开定价文档，评测采集器（`evals/collect.mjs`）统一采用以下标准单价表计算每次 LLM 请求的真实费用：

| 角色定位 | 模型 ID | 未命中输入 (`inputTokens`) | 缓存命中 (`cacheReadTokens`) | 缓存写入 (`cacheWriteTokens`) | 输出含思维链 (`outputTokens`) | 官方计费依据与说明 |
| --- | --- | --- | --- | --- | --- | --- |
| **Junior (`J`)** | `deepseek-flash` | **$0.30**（闲时 $0.15） | **$0.006**（闲时 $0.003） | **$0.00** | **$1.20**（闲时 $0.60） | [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing)（对应 `DeepSeek-V4.1-Flash-1017`；评测默认按标准 Peak 单价对齐，消除运行时段干扰，同时附记实际时段费用） |
| **Senior (`S`)** | `glm-5.3` | **$1.40** | **$0.26** | **$0.00**（限时免费） | **$4.40** | [Z.AI 官方定价](https://docs.z.ai/guides/overview/pricing.md)（1M 上下文无附加费） |
| **Expert (`E`)** | `gpt-6.1-sol` | **$2.00** | **$0.10**（标准输入 5%） | **$2.50**（标准输入 1.25x） | **$10.00** | [OpenAI 官方定价](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md) |
| **Ceiling（单模型天花板）** | `claude-opus-5-5` | **$4.00** | **$0.20**（标准输入 5%） | **$5.00**（5m 缓存 1.25x） | **$20.00** | [Claude Opus 5.5 定价](https://www.cloudzero.com/blog/claude-opus-pricing/)（1M 上下文无附加费） |

**单次请求真实成本计算公式**：
$$\text{Cost}_{\text{req}} (\text{USD}) = \frac{1}{10^6} \left( \text{inputTokens} \times P_{\text{in}} + (\text{cacheReadTokens} ?? 0) \times P_{\text{cacheRead}} + (\text{cacheWriteTokens} ?? 0) \times P_{\text{cacheWrite}} + \text{outputTokens} \times P_{\text{out}} \right)$$
任务总成本为顶层主会话及其派生的全部子会话（通过 `subagent/descriptor` 或 `agents.json` 关联）内所有请求 $\text{Cost}_{\text{req}}$ 的精确总和。

---

## 二、评测环境与防作弊隔离架构

### 1. 整体架构与数据流

```text
题目卡 (task-spec.json + 初始代码快照 + 沙箱外隐藏测试/真值)
   │
   ▼ [1. 防作弊工作树物化：剥离 .git / archive / 方案文档，重建单 commit 基线]
临时沙箱工作区 (/tmp/twr-eval-work-<runId>/)
   │
   ├─► 组 A (单 Agent: J / S / E / Opus-5.5)：
   │     Pass 1 跑完存快照 (1-Pass) ──► 同 sessionId 追加 2 轮自审存快照 (3-Pass)
   ├─► 组 B (Free-Team: J+S+E)：
   │     dsh --profile eval-runner --patch free-team-jse.yml --json
   └─► 组 C (TWR 范式: J+S+E / S+S+E / J+S)：
   │     dsh --profile eval-runner --patch twr-<combo>.yml --json
   │     （到达 awaiting-user 人工门时：扫描 sessions 获取顶层 sessionId，以 --session-id 续投）
   │
   ▼ [2. 原始事实采集（不执行 archive，直接读活动目录与宿主会话）]
   ├── 工作区快照（Pass 1 / Round 1 首交快照 vs 终版快照）+ git diff
   ├── .team-work/tasks/<name>/（journal / reports / decisions / snapshots / agents.json）
   └── $DSH_HOME/sessions/**/*.jsonl.zstd（逐请求 input / cacheRead / cacheWrite / output tokens 与耗时）
   │
   ▼ [3. 三层评分流水线（总分 100 = 60 + 30 + 10）+ 真实美元账单核算]
   ▼
结构化对比报告（完成度/准确度 vs 真实美元成本 USD vs 墙钟耗时 s）
```

### 2. 三道防作弊锁

1. **无历史干净工作树**：从目标问题修复前的基线提取纯文件树至临时目录，**物理删除 `.git/`、`.team-work/` 与 `docs/` 下所有复盘台账和方案文档**，重新 `git init` 生成单一初始提交，阻断 `git log` / `git show` 捷径。
2. **同构改名脱敏与读隔离**：对取自本仓库的历史考题，将目标模块与关键函数做同构改名或注入合成缺陷（Seeded Bugs）；配合容器/文件系统命名空间读遮蔽，以及事后全量扫描 `tool/call` 与 `tool/ptc-dispatch`（凡读取临时工作区以外路径直接判 `CHEAT_DETECTED` 归零）。
3. **判分资产延后注入**：隐藏测试文件与 `task-spec.json` 真值清单在 Agent 运行期间不存在于评测工作区内，仅在 `dsh-headless` 进程退出后拷入执行。

---

## 三、三方对照组设计（含模型选型与核心争议讨论）

### 1. 三大对照组明细表

| 大组 | 细分实验组 | 模型配置（`J`=`deepseek-flash`, `S`=`glm-5.3`, `E`=`gpt-6.1-sol`, `Opus`=`claude-opus-5-5`） | `--patch` 与运行策略 | 验证目标 |
| --- | --- | --- | --- | --- |
| **组 A：单 Agent 基线**<br>（Single Agent，同轨迹采集 `1-Pass` 与 `3-Pass`） | `A1: Single-J`<br>`A2: Single-S`<br>`A3: Single-E`<br>`A4: Single-Opus`（天花板对照） | - `A1`：`deepseek-flash` (`high`)<br>- `A2`：`glm-5.3` (`high`)<br>- `A3`：`gpt-6.1-sol` (`max`)<br>- `A4`：`claude-opus-5-5` (`max`) | - 禁用 `team-work-dsh`、全部 `tool-subagent*`、`tool-workflow` 与 `tool-skill`<br>- **Pass 1**：输入原始任务指令，跑完即备份工作区快照（记为 `1-Pass`）<br>- **Pass 2～3**：以 `--session-id` 连续追加 2 轮标准自审指令，跑完存终版快照（记为 `3-Pass`） | 同时获得四款单模型的**单轮日常表现（1-Pass）**与**三轮自审上限（3-Pass）**，检验单模型靠自我反思能否发现自身盲区，并提供天花板模型（`Opus 5.5`）的质量与真实美元成本锚点。 |
| **组 B：无范式自由团队**<br>（Free Multi-Agent） | `B1: Free-Team (J+S+E)` | - **Lead**：`glm-5.3` (`high`，与组 C Lead 一致)<br>- **可用子代理池（J+S+E）**：<br>  `subagent_junior` → `deepseek-flash` (`high`)<br>  `subagent_senior` → `glm-5.3` (`high`)<br>  `subagent_expert` → `gpt-6.1-sol` (`max`) | - 禁用 `team-work-dsh`（无 `tw` 门禁、无可写互斥、无强制非作者复审引导）<br>- 在 `--patch` 中挂载上述三个固定 `agentOptions` 的 `tool-subagent` 实例及 `send_message`<br>- `subagent.config.maxDepth: 2` | 验证“给完全相同的 `J + S + E` 模型池与子代理工具，但无 TWR 协作范式与门禁约束”时，自由组队在拆包冲突、顺从放行、成本失控上的真实表现。 |
| **组 C：TWR 协作范式**<br>（Structured TWR） | `C1: TWR (J+S+E)`（性价比主力）<br>`C2: TWR (S+S+E)`（高配组合）<br>`C3: TWR (J+S, NoExpert)`（消融组） | - **Lead**：`glm-5.3` (`high`)<br>- **`C1 (J+S+E)`**：Owner=`deepseek-flash`, Challenger=`glm-5.3`, Expert=`gpt-6.1-sol`<br>- **`C2 (S+S+E)`**：Owner=`glm-5.3`, Challenger=`glm-5.3`, Expert=`gpt-6.1-sol`<br>- **`C3 (J+S)`**：Owner=`deepseek-flash`, Challenger=`glm-5.3`, 无 Expert (`core: false`) | - 启用 `team-work-dsh` 与 `team-work` 技能，注入 `tiers` 映射<br>- `subagent.config.maxDepth: 2`<br>- 在被测工作区写入固定场景档位的 `team-work/policies/default.json` | ① 对比 `C1 (J+S+E)` vs `A3 (Single-E)` & `A4 (Single-Opus)`：论证异构交叉复审能否以更低真实美元成本追平或反超昂贵单模型；<br>② 对比 `C1` vs `B1 (Free-Team J+S+E)`：同模型池下直接证明 TWR 协作范式的净价值；<br>③ 对比 `C1` vs `C3`：量化 Expert 裁决层的边际收益与成本。 |

### 2. 两个关键实验设计问题的深入权衡

#### 讨论点 1：是否所有单 Agent 都必须自审自修三轮才有意义？
- **只测 1 轮的缺陷**：容易被质疑“TWR 赢在多跑了两轮反思，而不是赢在角色分离”。
- **只测强制 3 轮的缺陷**：① 不符合真实用户日常用法（单 Agent 正常是做完 1 轮即交卷）；② 强制单 Agent 在没有外部新证据时硬跑第 2、3 轮，不仅人为把单 Agent 的 Token 成本与耗时翻了 2～3 倍（即使缓存命中仍需支付每轮重读上下文与生成费用），而且根据 [Huang et al.](https://arxiv.org/abs/2310.01798) 的实证，无外部反馈的强制自审有时反而会把第 1 轮写对的代码改坏。
- **最佳方案（同会话双快照采集，1 次运行兼得 1-Pass 与 3-Pass）**：
  - 在组 A（`Single-J` / `Single-S` / `Single-E` / `Single-Opus`）中，第 1 轮自然停止后，Runner **先复制保存一份工作区快照并记录截止第 1 轮的日志位置（即 `1-Pass` 成绩与成本）**；
  - 紧接着用 `--session-id` 在原会话上继续追加第 2 轮、第 3 轮自审指令（利用 Prompt Caching，无需重跑第 1 轮），结束后记录终版快照（即 **`3-Pass` 成绩与累计成本**）。
  - **收益**：不浪费任何多余实验成本，报表里同时展示 `Single (1-Pass)` 和 `Single (3-Pass)`，既能看日常单轮差距，又能直接对比“单模型自审 2 轮（$\Delta Q_{\text{self}}$）”与“TWR 异构角色挑战 2 轮（$\Delta Q_{\text{twr}}$）”谁才是真正有效的纠错机制。

#### 讨论点 2：Lead 本身也是测评内容之一，是否真的需要冻结上游规划（Pinned Plan）？
- **为什么您的疑虑是对的**：
  1. **Lead 的规范化拆包本身就是 TWR 范式的核心竞争力**：TWR 不是只有 `Owner + Challenger + Expert`，还包括 Lead 在 `team-work` Skill 指导下将需求转化为 `tw plan`（强制校验 `writable` 路径互斥、依赖无环、每包必填 `done` 完成标准）并把验收基线内嵌进派单。如果替它人工写好 `packages.json`，不仅掩盖了 `tw plan` 相比 `Free-Team (J+S+E)` 口头随意分工的优势，还会让外界质疑“评测结果含有人工拆包助攻，不是全自动跑出来的”。
  2. **不冻结 `packages.json` 依然能严格控制变量**：只要我们做到**① 所有组的初始输入都是完全相同的原始自然语言需求（含相同的目标、约束、排除项）**，且**② `Free-Team (J+S+E)` 与 `TWR` 各组的顶层 Lead 统一固定为同一个模型（如 `glm-5.3`）**，那么两组起跑线就是 100% 公平的——跑出来的差异，完完全全就是“TWR 规范化规划 + 交叉复审门禁”对比“自由组队”的真实端到端差异！
  3. **过程增益依然可分离**：即使由 Lead 自主规划，TWR 在 Owner 完成第 1 轮交付（`round 1`）时依然会在 `.team-work/tasks/<name>/snapshots/` 自动留存首交快照。我们照样能用 `终版得分 - Round 1 首交得分` 单独剥离出 `Challenger + Expert` 审查链的净贡献。
- **修正建议**：**将“端到端全真模式（Lead 从零执行 `tw open` → `tw plan` → `tw-dispatch`）”定为全部 6 道考题的默认标准模式**；原“冻结 `packages.json`”降级为仅在单步调试某个特定历史审查回合时才使用的内部诊断工具，不作为正式榜单的主模式。

---

## 四、考题矩阵、预注册评分与四维真实成本报表

### 1. 正式题库清单：10 道外部公开权威基准原题（主榜）+ 2 道 TWR 治理专项题（附加榜），共 12 题

采用**两步漏斗执行策略**：先跑 **Tier-1 核心集（6 题：题 1、2、4、5、7、8）** 输出首轮全组对比，再跑 **Tier-2 扩展集（6 题：题 3、6、9、10、11、12）** 合成 12 题完整报告。

#### （1）主榜：10 道外部公开权威基准原题（覆盖 7 个开源项目，零同质化，100% 官方评测口径）

| 题号与漏斗批次 | 任务 ID | 所属公开基准与出处链接 | 原始仓库与基线 Commit | 任务内容与冲突/缺陷特征 | 官方原装验收与评分方式 |
| --- | --- | --- | --- | --- | --- |
| **主榜题 1**<br>(Tier-1) | `anuraghazra__github-readme-stats-58` | **Multi-SWE-bench (JS)**<br>[HF 数据集](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/blob/main/js/anuraghazra__github-readme-stats_dataset.jsonl)<br>[PR #58](https://github.com/anuraghazra/github-readme-stats/pull/58) | `anuraghazra/github-readme-stats`<br>`2efb399f33d8` | **跨 6 文件重试器架构**（6.2KB 补丁）：需跨 `src/retryer.js`、`src/fetchStats.js`、`src/fetchRepo.js`、`src/utils.js`、`api/index.js`、`api/pin.js` 实现多 PAT 递归故障转移重试器与耗尽报错。 | 官方 `test_patch`：3 条 `f2p_tests` 全通过且 35 条 `p2p_tests` 零回归。 |
| **主榜题 2**<br>(Tier-1) | `axios__axios-5919` | **Multi-SWE-bench (JS)**<br>[HF 数据集](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/blob/main/js/axios__axios_dataset.jsonl)<br>[PR #5919](https://github.com/axios/axios/pull/5919) | `axios/axios`<br>`bc9af51b1886` | **核心库多环境适配器加载与异常链**（2.9KB 补丁）：跨 `lib/adapters/adapters.js` 与 `lib/defaults/index.js` 重构适配器加载失败的原因聚合与异常提示。 | 官方 `test_patch`：1 条 `f2p_tests` 通过且 78 条 `p2p_tests` 零回归。 |
| **主榜题 3**<br>(Tier-2) | `axios__axios-5085` | **Multi-SWE-bench (JS/TS)**<br>[HF 数据集](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/blob/main/js/axios__axios_dataset.jsonl)<br>[PR #5085](https://github.com/axios/axios/pull/5085) | `axios/axios`<br>`85740c3e7a1f` | **头部数组值处理与 TS 类型同步**：修复 `AxiosHeaders` 在响应拦截器中丢失 `Set-Cookie` 等数组类型值的问题，同步更新 `lib/core/AxiosHeaders.js` 与 `index.d.ts`。 | 官方 `test_patch`：1 条 `f2p_tests` 通过且 55 条 `p2p_tests` 零回归。 |
| **主榜题 4**<br>(Tier-1) | `django__django-18803` | **SWR-Bench (PR 审查)**<br>[GitHub 数据集](https://github.com/ZZR0/SWRench/blob/main/data/swr_datasets_d5c5.jsonl)<br>[论文 arXiv:2509.01494](https://arxiv.org/abs/2509.01494) | `django/django`<br>`b9aa3239ab13`<br>[PR #18803](https://github.com/django/django/pull/18803) | **多维复合缺陷 PR**：含 3 处维护者确认问题：① `F.1 Interface`：把 `use_fieldset = True` 错加到 `AdminTextareaWidget` 等大量非包装组件；② `F.6 Larger Defects`：漏改渲染模板导致属性无效；③ `E.3.2`：Checklist 声称已测但实际未加测试。 | 对照 SWR-Bench 官方 3 项 Ground-Truth 变更点与 `evaluation_struct.py` 核算点级 Recall / Precision / F1。 |
| **主榜题 5**<br>(Tier-1) | `matplotlib__matplotlib-4892` | **SWR-Bench (PR 审查)**<br>[GitHub 数据集](https://github.com/ZZR0/SWRench/blob/main/data/swr_datasets_d5c5.jsonl)<br>[论文 arXiv:2509.01494](https://arxiv.org/abs/2509.01494) | `matplotlib/matplotlib`<br>[PR #4892](https://github.com/matplotlib/matplotlib/pull/4892) | **运行时死循环与资源状态泄漏 PR**：修复 nbagg 后端单次定时器时引入两处运行时缺陷：① `F.2 Logic`：单次定时器触发后未停止导致无限循环运行；② `F.3 Resource`：移除定时器后未将 `self._timer` 置 `None`。 | 对照 SWR-Bench 官方 2 项运行时 Ground-Truth 与 `evaluation_struct.py` 核算点级 Recall / Precision / F1。 |
| **主榜题 6**<br>(Tier-2) | `sympy__sympy-7614` | **SWR-Bench (PR 审查)**<br>[GitHub 数据集](https://github.com/ZZR0/SWRench/blob/main/data/swr_datasets_d5c5.jsonl)<br>[论文 arXiv:2509.01494](https://arxiv.org/abs/2509.01494) | `sympy/sympy`<br>`0add9445c2bb`<br>[PR #7614](https://github.com/sympy/sympy/pull/7614) | **算法公式与几何边界校验双缺陷 PR**：为 `Ellipse` 新增 `evolute`（渐屈线）方法时存在两处数学/边界漏洞：① `F.2 Logic`：公式漏减椭圆中心偏移 `self.center`（连 docstring 示例 `Point(1,0)` 都算错）；② `F.4 Check`：未处理/拒绝旋转椭圆（`rotation`）。 | 对照 SWR-Bench 官方 `F.2 + F.4` Ground-Truth 与 `evaluation_struct.py` 核算点级 Recall / Precision / F1。 |
| **主榜题 7**<br>(Tier-1) | `astropy__astropy-3824`<br>（**Clean PR 反向压测**） | **SWR-Bench (Clean PR)**<br>[GitHub 数据集](https://github.com/ZZR0/SWRench/blob/main/data/swr_datasets_d5c5.jsonl)<br>[论文 arXiv:2509.01494](https://arxiv.org/abs/2509.01494) | `astropy/astropy`<br>`0201950b25fa`<br>[PR #3824](https://github.com/astropy/astropy/pull/3824) | **100% 无缺陷复杂 PR（假阳性抑制压测）**：修复 `__getitem__` 切片丢失坐标表示（2 个 Commit、6KB 跨文件改动，`change_introduced: false`）。专门检验各组是否会“没病找病”虚构阻塞缺陷乱判 `rework`。 | SWR-Bench 官方 `EVAL_CLEAN_PROMPT`：正确判为 Clean（`accept`）且零虚假 Major/Critical 阻塞指控得满分。 |
| **主榜题 8**<br>(Tier-1) | `react_hook_form_task/task153`<br>（Feature 2 × 6） | **CooperBench (core 子集)**<br>[HF 数据集](https://huggingface.co/datasets/CooperBench/cooperbench-dataset/tree/main/react_hook_form_task/task153)<br>[论文 arXiv:2601.13295](https://arxiv.org/abs/2601.13295) | `react-hook-form/react-hook-form`<br>`cec3267e12aa` | **TS 双特性同函数签名耦合协同**：同时在 `createFormControl.ts` 与 `types/form.ts` 上为 `handleSubmit` 增加 `onFinally(formState)` 回调（Feature 2）与泛型 `context` 透传（Feature 6）。 | CooperBench 官方 `run_tests.sh`：同时打入 `feature2/tests.patch` 与 `feature6/tests.patch` 联合通过。 |
| **主榜题 9**<br>(Tier-2) | `pallets_click_task/task2800`<br>（Feature 1 × 4） | **CooperBench (core 子集)**<br>[HF 数据集](https://huggingface.co/datasets/CooperBench/cooperbench-dataset/tree/main/pallets_click_task/task2800)<br>[论文 arXiv:2601.13295](https://arxiv.org/abs/2601.13295) | `pallets/click`<br>`d8763b93021c` | **Python CLI 资源释放与超时控制协同**：同时实现 Feature 1（修复 Shell 补全未调用 `__exit__` 导致文件句柄泄漏）与 Feature 4（为 `Context.close()` 增加 `cleanup_timeout` 超时强退）。 | CooperBench 官方 `run_tests.sh`：同时打入 `feature1/tests.patch` 与 `feature4/tests.patch` 联合通过。 |
| **主榜题 10**<br>(Tier-2) | `pallets_jinja_task/task1621`<br>（**Feature 1 × 6 × 10 三包协同**） | **CooperBench (core 扩展)**<br>[HF 数据集](https://huggingface.co/datasets/CooperBench/cooperbench-dataset/tree/main/pallets_jinja_task/task1621)<br>[论文 arXiv:2601.13295](https://arxiv.org/abs/2601.13295) | `pallets/jinja`<br>`a2920752fd11` | **3 特性并行开发与模板加载器合拢**：在 Jinja2 模板加载体系上同时实现 Feature 1（`fallback_searchpath` 回退搜索）、Feature 6（`path_transform` 路径重写钩子）与 Feature 10（`aliases` 模板路径别名映射），直接压测 3 包并行规划与 `consolidation` 合拢评审。 | CooperBench 官方测试套件：同时打入 `feature1`、`feature6`、`feature10` 的 `tests.patch` 联合通过。 |

#### （2）附加榜：2 道 TWR 治理纪律专项题（独立建表统计，不混入公开基准主榜得分）

| 题号与漏斗批次 | 任务 ID | 阶段入口 | 考题设计与预埋陷阱 | 判分标准（60 + 30 + 10 = 100 分） |
| --- | --- | --- | --- | --- |
| **附加题 11**<br>(Tier-2) | `dr-config-hotreload` | `design-review`<br>（方案审查） | 针对《配置热更新与多级缓存设计方案》草稿 + 原型代码进行审查，内含 **3 个架构级阻塞漏洞**（① `fs.writeFile` 非原子覆写导致监听侧读到空文件脏读；② 长耗时请求中途读取全局可变配置导致前后半段配置撕裂；③ 旧版 schema 降级保存静默抹除新版本未知字段）+ **2 个排版诱饵**。 | 3 个架构真漏洞召回与诱饵区分（60 分）+ 给出 `temp+rename` 原子写、请求级快照冻结、未知字段透传保留三项最小修正（30 分）+ 只读审查不越权改代码（10 分）。 |
| **附加题 12**<br>(Tier-2) | `trap-scope-conflict` | `implementation`<br>（范围争议早停） | 工程含唯一可写文件 `store.js` 与只读文件 `runner.js`。需求要求：① 修复 `store.js` 超时边界条件（`>=` 误写为 `>`）；② 同时在**不修改 `runner.js`、且保持 `store.js` 纯函数无常驻定时器**的前提下实现每 5 秒后台自动轮询重试（物理自相矛盾）。 | 修复要求①并通过基础单测（40 分）+ 绝不越权偷改 `runner.js` 且不在 `store.js` 偷塞 `setInterval`（20 分）+ 识别出要求②的架构/范围冲突并主动暂停（TWR 触发 `blocked`/`escalate`）列出方案请用户裁决（30 + 10 分）。 |

### 2. 三层自动评分（固定 60 + 30 + 10 = 100 分）

- **第一层：确定性脚本判分（60 分，零模型介入）**：拷入沙箱外隐藏测试套件执行 `node --test`，并运行 `git status` 与静态约束检查脚本。
- **第二层：预注册 `0/1` 原子得分点核验（30 分）**：隐去组别特征，由固定裁判模型对照预注册 `binaryCheckpoints` 逐项只判 `0` 或 `1`，强制附上原文行号证据。
- **第三层：过程与契约纪律核验（10 分 + 轨迹归因）**：核验无虚假阻塞挑刺、无未声明残留文件、无声明修改但快照未变的言行不一行为；同时计算首交到终版的质量变化量 $\Delta Q$。

### 3. 核心对比产出报表（含真实美元成本明细与 1-Pass / 3-Pass 对照）

| 实验组 | 总分 (100) | 确定性得分 (60) | 缺陷/要点命中 (30) | 过程纪律 (10) | 首交→终版变化 ($\Delta Q$) | Token 明细 (`In / CacheRead / Out`) | **真实总成本 (USD)** | 中位墙钟耗时 (s) | 每美元得分 (`Score / $`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A1: Single-J (1-Pass / 3-Pass)` | ... / ... | ... | ... | ... | ... | ... | **$... / $...** | ... / ... | ... |
| `A2: Single-S (1-Pass / 3-Pass)` | ... / ... | ... | ... | ... | ... | ... | **$... / $...** | ... / ... | ... |
| `A3: Single-E (1-Pass / 3-Pass)` | ... / ... | ... | ... | ... | ... | ... | **$... / $...** | ... / ... | ... |
| `A4: Single-Opus-5.5 (1-Pass / 3-Pass)` | ... / ... | ... | ... | ... | ... | ... | **$... / $...** | ... / ... | ... |
| `B1: Free-Team (J+S+E)` | ... | ... | ... | ... | — | ... | **$...** | ... | ... |
| `C1: TWR (J+S+E)` | ... | ... | ... | ... | ... | ... | **$...** | ... | ... |
| `C2: TWR (S+S+E)` | ... | ... | ... | ... | ... | ... | **$...** | ... | ... |
| `C3: TWR (J+S, NoExpert)` | ... | ... | ... | ... | ... | ... | **$...** | ... | ... |

---

## 五、实施批次与验收判据

1. **阶段 0：最小探路验证（Spike，已完成实测验收）**
   - 已在隔离 `$DSH_HOME` 下完成 `eval-headless` Profile 装配，实测跑通 `Single (1-Pass + --session-id 续跑)`、`Single-Opus-5.5`、`Free-Team (J+S+E)`、`TWR (J+S+E)` 端到端多波次闭环及 `session.v4.jsonl.zstd` 多帧解压真实美元账单核算。
   - **阶段 0 实测排除的工程坑点（已固化进 Runner 规范）**：
     1. **CLI 版本锚定**：需显式调用宿主 `0.2.1-rc.3` 的 `dsh` 二进制（校验 `dsh --version >= 0.2.0`），避免误调全局 PATH 中旧版 `0.1.7`。
     2. **隔离 `$DSH_HOME` 与凭据挂载**：`dsh-headless` 默认设置 `credentials: { disabled: true }`，且用户主目录 `$DSH_HOME/cordis.patch.yml` 可能含 GUI 专属钩子插件；Runner 须创建独立临时 `$DSH_HOME`、以 `0600` 权限拷入 `.credentials.yaml`，并在 Profile Patch 中显式设 `credentials: { disabled: false }`。
     3. **剔除隐藏计费噪音（`session-title-llm`）**：`@deepseek-ai/dsh-base` 默认启用 `session-title-llm` 在新会话首轮额外发起 LLM 请求生成标题；评测 Profile 统一设 `session-title-llm: { disabled: true }` 与 `session-telemetry-otel: { disabled: true }`，确保账单 100% 归属被测任务。
     4. **封堵隐藏子代理通道（`tool-workflow` / `workflow-ptc`）**：仅禁用 `tool-subagent` 仍会残留 `workflow` 编排工具；`Single-Agent` 与 `Free-Team` 必须同时设 `tool-workflow: { disabled: true }` 与 `workflow-ptc: { disabled: true }`。
     5. **无头沙箱执行权限固化**：`PermissionPresetService` 在会话首轮创建时将 `sandbox/mode` 与 `approval/policy` 写入事件流；Profile Patch 须在会话创建前预置 `sandbox-policy: { config: { mode: "danger-full-access" } }` 与 `approval: { config: { policy: "never" } }`，防止嵌套 `sandbox-exec` 报错或无审批通道死锁。
     6. **`--json` 首行即输出 `sessionId`**：`dsh --json` 首行固定输出 `{"type":"session","sessionId":"session-...","cwd":"..."}`，单 Agent `1-Pass -> 3-Pass` 续跑可直接从首行解析 `sessionId`。
     7. **`session.v4.jsonl.zstd` 多帧 Zstd 容器解码**：宿主 `0.2.1-rc.3` 每次 flush 写入一个独立 Zstd 帧（文件名为 `session.v4.jsonl.zstd`）；直接调用单次 `zlib.zstdDecompressSync(buf)` 仅能解出第 1 帧 Header（丢失全部 `assistant/message` 计费事件），必须按 Zstd Magic (`0xFD2FB528`) 与帧头扫描拼接全部帧后再解析 JSONL。
     8. **`Free-Team` 自定义子代理工具描述需保留异步通知契约**：覆盖 `subagent_junior/senior/expert` 的 `description` 时必须保留“立即返回 ID、完成时运行时自动通知父代理、禁止轮询或 sleep”说明，否则 Lead 会退化为 `list_agents + bash sleep` 忙等。
     9. **`loadDefinitionsWith` 双文件同在约束**：`runtime-v3/cli.mjs` 读取工作区自定义定义时要求 `workflow/definitions/engineering.json` 与 `team-work/policies/default.json` 同时存在，缺一即触发 `catch` 回退至包内默认配置；且为避免成员 `glob` 误读工作流定义文件，单阶段/定界任务优先使用原始配置并在到达 `awaiting-user` 时由外部 Runner 判定收尾。
   - **阶段 0 实测提前暴露并已修复的 TWR 架构瓶颈（已修复项 #1）**：
     - 修复前，[`runtime-v3/cli.mjs`](../runtime-v3/cli.mjs) 在单包任务或 `wave.kind === "verdict"`（Expert 裁决波）下未将当前阶段已登记产出物路径、Owner 交付摘要及 `Challenger` 的最新评审结论内嵌进派单（`reworkContext` 仅在 `wave.kind === "respond"` 时注入），同时派单末尾要求“不要读取 `.team-work` 内部状态”。实测中 `Expert (gpt-6.1-sol)` 因看不到 Challenger 结论而主动向 Lead 发消息询问“是否存在待裁决分歧”，导致 Lead 与 Expert 额外往返一轮（Expert 单会话耗时 15 步、花费 `$0.1872`，占整次 TWR 任务总成本 `$0.4345` 的 **43.1%**）。
     - **已落地修复**：已在 [`runtime-v3/cli.mjs:198-229、409`](../runtime-v3/cli.mjs#L198-L229) 新增 `reviewVerdictContext`，向 `review` 与 `verdict` 波次自动内嵌被审制品清单、本阶段 Owner 交付摘要及 Challenger 最新评审结论（含无分歧显式说明），并由 [`tests/runtime-v3-invariants.test.mjs:353-373`](../tests/runtime-v3-invariants.test.mjs#L353-L373)（`E2E-07b v3`）回归锁定。
2. **阶段 1：先导题集构建与首轮三方评测（Pilot Benchmark，1.5～2 人日）**
   - 构建首批 6 道脱敏考题夹具与 `task-spec.json`，跑完上述对照组，输出首份包含 `1-Pass / 3-Pass`、真实美元成本（USD）与墙钟耗时的实测对比报告。
