# 多智能体研发工作流评估：业界案例与核心判断

本文记录多智能体研发工作流（聚焦“产出 → 挑战审查 → 专家裁决 → 人工门禁”拓扑）的评估方法论、业界基准案例、实证研究结论与开源工具选型判断，作为后续构建评估体系与回归基线的参考依据。

## 结论与核心判断

评估多智能体研发工作流的真实效果，**不能只看“最终任务成功率（Pass@1）”**。业界实证与一线工程团队经验共同指向四条核心判断：

1. **必须拆解过程轨迹，区分“协作净增益”与“空转/退化”**：多智能体引入的沟通与多轮返工并非天然正收益。在复杂推理与验证任务中，缺乏外部可执行验证信号（测试、编译、明确规格条款）锚定的审查循环，容易退化为措辞打磨、顺从放行或“幻觉缺陷”引发的有害修改。评估体系必须同时度量**独家缺陷拦截率（正收益）**与**虚假返工/有害改动率（负收益）**。
2. **失效归因优先于笼统打分**：多智能体系统中约三分之二的失败源于系统规范违背、角色越界、智能体间失调（如范围漂移、言行不一）和验证缺失，而非单模型底座能力不足。采用结构化失效分类法（如 MAST）对任务轨迹做“确定性规则过滤 + 少样本裁判归因”，比主观打分更能直接指导引导词（Guidance）与门禁（Gate）迭代。
3. **评估者必须具备工具核验能力（Agent-as-a-Judge）**：针对方案设计与代码审查等非单一标准答案的任务，仅靠文本评判的 LLM-as-a-Judge 易受冗长偏见与自偏好欺骗；在 DevAI 基准实证中，赋予评估器只读查阅文件快照、比对 diff、核对需求依赖图的能力，可将与人类专家多数共识的一致率从约 69%～72% 提升至 86%～92%。
4. **“线下精选黄金集 + 线上真实轨迹离线审计”双轨并行**：公开基准存在数据污染且与具体工作流拓扑不同构。工程落地的最小闭环是：一方面直接复用活动任务目录（[`runtime-v3/store.mjs`](../runtime-v3/store.mjs)）的落盘事实做全量离线轨迹统计；另一方面从历史真实事故（如 [`v2-e2e-findings.md`](v2-e2e-findings.md)）抽取 6～8 个种子缺陷与争议夹具，用轻量声明式框架（如 Promptfoo）或隔离评测脚本做跨版本回归。

**证据边界说明**：本文引用的公开基准、学术论文与开源仓库均已核对原始论文摘要/正文或官方仓库文档（截至 2026 年 10 月）；但业界尚无直接针对“Owner → Challenger → Expert → 人工门”完整四层拓扑的现成实证论文，第四节的拓扑增益指标为基于相邻实证研究的可落地拼装设计，开源评测框架尚未在本仓库安装实测。

---

## 一、为什么单看“最终通过率”不够：多智能体协作与审查实证

### 1. 协作损耗与审查循环的边界条件

多智能体研发流程的核心假设是“增加非作者挑战者与裁决者能提高交付质量”，但多项实证研究揭示了这一假设成立的严格前提：

| 研究案例 | 研究对象与规模 | 核心实证发现 | 对工作流评估的启示 |
| --- | --- | --- | --- |
| **CooperBench**（[论文](https://ar5iv.labs.arxiv.org/html/2601.13295) / [报道](https://hai.stanford.edu/news/ai-coding-agents-fail-at-teamwork)） | 12 个代码库、4 种语言、652 个双智能体协作编码任务 | 双智能体协作成功率比单智能体平均低约 **30%**（“协调诅咒”）；单纯增加自由通信几乎无改善。主要死因：模糊消息淹没关键信息、承诺未兑现、对同伴状态预期错误。 | 拓扑评估必须验证“分包边界是否真正解耦、可写范围是否互斥”，并考核包间契约违约率，不能用自由通信代替结构化交接。 |
| **自我纠错综述与边界**（[Huang et al.](https://arxiv.org/abs/2310.01798) / [Kamoi et al.](https://arxiv.org/abs/2406.01297) / [CRITIC](https://arxiv.org/abs/2305.11738) / [Self-Refine](https://arxiv.org/abs/2303.17651)） | 推理、生成与编码任务中的多轮反思与反馈循环 | [Self-Refine](https://arxiv.org/abs/2303.17651) 在生成润色类任务上靠纯模型自反馈取得约 +20% 提升；但 [Huang et al.](https://arxiv.org/abs/2310.01798) 与 [Kamoi et al.](https://arxiv.org/abs/2406.01297) 系统综述证明，**在复杂推理与验证任务上，无外部可靠反馈的纯提示词反思难以纠错甚至导致正确结果退化**，[CRITIC](https://arxiv.org/abs/2305.11738) 则证实挂接外部可执行工具验证（测试、编译器、明确规格条款）才是稳定增益来源。 | 评审意见（Findings）必须强制绑定可验证证据（源码行号、失败测试、明确需求条款）；评估时需把“无证据的主观返工要求”计为无效噪声。 |
| **批评者价值与幻觉**（[McAleese et al.](https://arxiv.org/abs/2407.00215)） | 代码生成与真实缺陷批评对比实验 | 模型批评在 63% 场景下优于人工批评，抓出的真实 bug 多于人类评审员，但会**幻觉出不存在的 bug**；“人类 + 模型批评者”组合能保持高缺陷捕获率并显著压低幻觉。 | 印证了“机器挑战 + 人工门禁”组合的必要性，同时要求评估体系必须单列**虚假返工率（False Rework Rate）**与**有害修改率（HRR）**。 |
| **多智能体辩论与算力匹配**（[Khan et al.](https://arxiv.org/abs/2402.06782) / [Smit et al.](https://arxiv.org/abs/2311.17371)） | 强模型辩论 + 弱模型/人类裁决 vs 同算力单模型采样 | 双边对抗辩论能让裁判识别真相的准确率从 48%/60% 提升至 **76%（模型裁判）/ 88%（人类裁判）**；但在同等 Token 预算下，设计不当的多智能体辩论未必优于多次独立采样。 | 评估多智能体拓扑或跨档位（junior/senior/expert）配置时，必须做**成本归一（Cost-Normalized）**对照，排除“单纯因为花更多 Token 而变好”的混淆。 |

### 2. 多智能体失效分类法：UC Berkeley MAST 案例

UC Berkeley 等团队提出的 **MAST（Multi-Agent System Failure Taxonomy）**（[arXiv:2503.13657](https://arxiv.org/abs/2503.13657)，开源仓库 [multi-agent-systems-failure-taxonomy/MAST](https://github.com/multi-agent-systems-failure-taxonomy/MAST)，数据集 [mcemri/MAD](https://huggingface.co/datasets/mcemri/MAD)）对 7 个主流多智能体框架的 **1,642 条运行轨迹**进行了扎根理论分析与人工校准（人类专家标注一致性 $\kappa = 0.88$），将多智能体失效归纳为 **3 大类、14 个子类**：

1. **FC1 系统设计与规范违背（System Design & Specification）**
   - `1.1 违反任务规范`（11.8%）：忽略约束条件或排除项（对应本仓库历史台账中的忽略约束问题）。
   - `1.2 违反角色规范`（1.5%）：评审者越权改文件、执行者自行递归扇出子代理（对应 [`v2-e2e-findings.md`](v2-e2e-findings.md) 中的 E2E-17 与 V3-E2E-05）。
   - `1.3 步骤重复`（15.7%）：同波次死循环重派、重复扫描已内嵌上下文（对应 E2E-08、V3-E2E-01）。
   - `1.4 上下文/历史丢失`（2.8%）：续派断链或返工原因丢失（对应 V3-E2E-02）。
   - `1.5 未识别终止条件`（12.4%）：已达标仍反复打磨，或未达标提前声称完成。
2. **FC2 智能体间失调（Inter-Agent Misalignment）**
   - `2.1 对话意外重置`（2.2%）。
   - `2.2 不澄清即假设`（6.8%）：遇到需求歧义或未决授权前提时不暂停请示，直接闷头假设并扩写方案（对应 [`scope-dispute-pause-plan.md`](scope-dispute-pause-plan.md) 处理的核心痛点）。
   - `2.3 任务脱轨/范围漂移`（7.4%）：审查者不断追加范围外偏好，导致产出偏离原始目标（对应 [`review-scope-control-plan.md`](review-scope-control-plan.md)）。
   - `2.4 隐瞒关键信息`（0.85%）：上游未向下游传递关键发现或产出路径。
   - `2.5 忽略同伴输入`（1.9%）：返工轮无视 Challenger 提出的阻塞项，或裁决者忽略已有证据。
   - `2.6 推理-行动不一致（言行不一）`（13.2%）：报告正文声称“已修复/已测试”，但制品快照 `digest` 未变；或裁决结构化结论填 `accept`，正文却要求必须修改（对应 [`v2-e2e-findings.md`](v2-e2e-findings.md) 第 36 行真实案例）。
3. **FC3 任务验证与终止失败（Task Verification & Termination）**
   - `3.1 过早终止`（6.2%）：多包任务漏包或未完成即交卷。
   - `3.2 验证不完整`（8.2%）：只做表层语法/格式检查，未验证核心业务规则或边界条件。
   - `3.3 错误验证`（9.1%）：放过真实阻塞缺陷，或误把合法实现判为缺陷。

**MAST 的两个重要工程启示**：
- **结构对比优于总分对比**：实证显示 MetaGPT 在 FC1/FC2 类错误上比 ChatDev 少 60%～68%，但在 FC3（验证失败）上反而多 1.56 倍。如果只看总体成功率，就无法发现“流程规范好了，但门禁验证太浅”的短板。
- **自动标注与定位的真实上限**：MAST 使用少样本 CoT 裁判对整条轨迹做 14 类打标，与人类一致率达 $\kappa = 0.77$（准确率 0.94）；但相邻基准 [TRAIL（arXiv:2505.08638）](https://arxiv.org/abs/2505.08638) 与 [Who&When（arXiv:2505.00212）](https://arxiv.org/abs/2505.00212) 证明，纯靠大模型自动定位“长轨迹中具体哪一步、哪个角色导致失败”的联合准确率仅 **11%～14.2%**。因此，**能用确定性脚本（检查日志序列、文件指纹、退出码）判定的绝不交给模型猜；模型裁判只负责语义归类并生成候选证据供人抽检**。

---

## 二、软件工程、代码审查与方案设计的评测基准案例

### 1. 公开软件工程与审查基准对比

| 维度 | 代表基准 | 核心评测机制 | 可借鉴之处与局限 |
| --- | --- | --- | --- |
| **代码审查与多评审聚合** | **SWR-Bench**（[论文](https://ar5iv.labs.arxiv.org/html/2509.01494)） | 基于 1,000 个人工核验的真实 GitHub PR（含完整仓库上下文），用结构化真实缺陷清单（Ground Truth）+ 裁判模型计算审查意见的 Precision / Recall / F1（与人类判断约 90% 一致）。 | **直接量化证实“多评审者聚合”最高可提升 43.67% 的审查 F1**；其“预置缺陷清单 + 命中覆盖率”评估法可直接迁移用于评估 `code-review` 与 `design-review` 场景。 |
| **评审评论采纳率** | **ASE 2025 评审实证**（[Goldman et al.](https://arxiv.org/abs/2510.05450)） | 将评审意见分为 5 类（缺陷、可读性、可维护性、设计等），追踪哪些意见真正触发了代码修改并在终版保留。 | 提供了衡量“无效挑刺”的客观代理指标——**评论解决与保留率**，无需完全依赖人工对每条意见做真值标注。 |
| **方案取舍与管理决策** | **SWE-Lancer**（[arXiv:2502.12115](https://arxiv.org/abs/2502.12115)） | 1,400+ 个真实工程任务，除独立编码（端到端测试判分）外，专门设置**技术管理任务**：让模型在多个技术方案提案中做评估与选择，以真实工程经理的裁决为真值。 | 为评估 `Expert` 技术裁决与 `Lead` 拆包/路由决策提供了样板：用真实历史分歧案例构建“多方案选优”测试夹具。 |
| **全生命周期与长程落地** | **DevEval / DevBench**（[仓库](https://github.com/open-compass/DevEval)）、**LoLBench**（[arXiv:2609.37143](https://arxiv.org/abs/2609.37143)） | DevEval 覆盖软件设计、环境、实现、验收测试、单测五阶段；LoLBench 评测从 5,000 词高层设计提案到 240 万行级代码库落地的能力（28 个主流 Agent 最高仅 14% 通过，补充文件树与接口规格可提升 16～22 个百分点）。 | 证明“设计到实现”的最大断层在于**上游产物路径与接口规格是否精确传入下游**（直接支撑 [`runtime-roadmap.md`](runtime-roadmap.md) 批次 A2“派单自动内嵌上游产出物”的必要性）。 |
| **澄清与边界克制** | **AppWorld**（[官网](https://appworld.dev/appworld/)） | 9 个应用、457 个 API 的状态化环境，除检查目标状态外，专门检查**附带破坏（Collateral Damage）**以及面对不可行/歧义指令时是否主动追问确认。 | 对应工作流的**可写范围防越界**与**范围争议提前暂停**：好工作流不仅要完成任务，还要零附带破坏、该停则停。 |
| **多语言与防作弊隔离** | **Multi-SWE-bench**（[仓库](https://github.com/multi-swe-bench/multi-swe-bench)）、**Terminal-Bench 3.0**（[说明](https://www.tbench.ai/news/terminal-bench-3-0)）、**ABC 检查表**（[仓库](https://github.com/uiuc-kang-lab/agentic-benchmarks)） | 覆盖 TS/JS/Go/Rust 等多语言；将执行环境与验证容器隔离，运行作弊探测（Oracle/Cheat Agent）。ABC 研究指出评测集测试不严会导致性能被高估或低估达 100%。 | 自建回归夹具时必须将评估工作目录与真实 `.team-work/tasks/` 隔离，且防止模型通过读取 git 历史或测试断言作弊（如 [OpenHands 在 Commit0 发现的 git log 捷径](https://www.openhands.dev/blog/analyzing-and-improving-openhands-index)）。 |

### 2. 过程级评估方法：Agent-as-a-Judge 与防偏差设计

在方案设计（`design`）与审查（`design-review` / `code-review`）阶段，无法仅靠单元测试判定质量。Meta AI 等提出的 **Agent-as-a-Judge**（[arXiv:2410.10934](https://arxiv.org/abs/2410.10934)，开源实现 [metauto-ai/agent-as-a-judge](https://github.com/metauto-ai/agent-as-a-judge)）在 DevAI 基准（55 个开发任务、365 条带依赖关系的层级需求）上对比了不同评估方式：

- **核心差异**：在黑盒评估三套被测系统（MetaGPT / GPT-Pilot / OpenHands）时，普通 LLM-as-a-Judge 与人类专家多数投票的一致率（Alignment Rate，见原论文 Table 3）分别为 **68.86% / 71.85% / 70.76%**；而为评估器配备只读工具（读取真实生成文件、查看快照差异、按需求依赖图逐条核验）的 Agent-as-a-Judge 将一致率提升至 **92.07% / 86.61% / 90.16%**（注：原论文正文曾混引 92.07%，此处以 Table 3 逐列分项数据为准），同时比三位人类专家评审节省约 **97.6% 的成本与时间**。
- **四条已被证实的裁判防偏差纪律**（综合 [MT-Bench](https://arxiv.org/abs/2306.05685)、[自偏好偏差研究](https://arxiv.org/abs/2404.13076)、[JudgeBench](https://arxiv.org/abs/2410.12784)）：
  1. **确定性校验前置**：文件是否存在、路径是否越界、快照 `digest` 是否变化、测试退出码是否为 0，一律由代码脚本判定，不调用模型。
  2. **跨模型家族与身份盲化（Blinding）**：模型具有识别自身输出并给予高分的线性自偏好（支撑本仓库“非作者评审”与“同波家族多样性”规则）；离线评估时应对裁判隐去产出者的模型档位标签（如不透露该报告来自 `expert` 还是 `junior`），防止权威偏见。
  3. **二值原子核对表（Binary Rubric）替代主观打分**：禁用 1～10 笼统打分，拆解为可验证的 `0/1` 事实问题（如：“该条 `blocker` 意见是否指出了具体文件路径与失败触发链？”、“返工后是否修改了原方案明确要求保留的机制？”）。
  4. **成对交换位置（Position Swapping）**：对比两个版本的引导词或模型档位时，交换 A/B 呈现顺序各评一次，两次结果不一致时记为平局或交人工复核，消除位置偏见。

---

## 三、一线工程团队如何构建内部 Evals（公开实践）

公开基准只能测通用模型能力，一线研发 Agent 团队均依赖自建闭环评估体系指导迭代：

1. **Anthropic（Claude Code 与长程 Harness 设计）**（[SWE-bench 经验](https://www.anthropic.com/engineering/swe-bench-sonnet) / [长程 Harness 设计](https://www.anthropic.com/engineering/harness-design-long-running-apps) / [有效 Harness 构建](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，注：官方页抓取受限时经由 [逐字存档镜像](https://github.com/tim-kaa-py/ai-wiki/blob/main/sources/articles/2025-11-26_anthropic_effective-harnesses-long-running-agents.md) 核对）
   - **工具人体工学优先**：极简且错误提示清晰的接口往往比复杂状态机更能提升通过率（与 Runtime v3 “工具中心重写、同步总检查自带修复指引”同向）。
   - **生成与评估分离 + 契约先行**：通过“Sprint Contract”在动手前明确完成标准，由独立评估者用端到端工具（如浏览器/命令行实测）核验，专门治理“模型提前声称完成”。
   - **随模型升级做减法**：每当底座模型迭代，重新运行评估集并主动删减不再必要的脚手架与繁琐提示词，防止旧补丁变成新模型的束缚与 Token 负担。
2. **OpenHands（多维指数 + 轨迹无监督聚类）**（[OpenHands Index](https://www.openhands.dev/blog/openhands-index) / [Skill 评估方法论](https://www.openhands.dev/blog/evaluating-agent-skills)）
   - **能力-成本-耗时三维并报**：不在单一榜单刷分，而是同时汇报多类任务下的得分、Token 成本与运行耗时。
   - **Skill 消融对照（Ablation）**：评估任何新增提示词或 Skill 时，必须跑“有 Skill vs 无 Skill 基线”对照实验——实测表明部分写得过细的 Skill 在特定任务上反而产生**负增益**。
   - **看轨迹抓捷径**：使用轨迹分析工具对失败与异常高分会话做聚类，成功揪出智能体通过 `git log` 抄袭历史答案的评测漏洞。
3. **Cursor（CursorBench 真实会话回溯）**（[CursorBench](https://cursor.com/blog/cursorbench) / [Bugbot 评估](https://cursor.com/blog/bugbot-out-of-beta)）
   - **从真实生产会话反推黄金集**：将最终被开发者采纳提交的代码回溯到最初的真实模糊请求，构造高保真内部评测集（代码规模为公开基准的数倍，且保留真实需求的简短与歧义）。
   - **代码审查看“解决率（Resolution Rate）”**：其审查工具 Bugbot 的核心线上北极星指标不是“发出了多少条评论”，而是**用户实际采纳并解决的评论比例**。
4. **Cognition / Devin（面向工程价值的会话审计）**（[生产力评估](https://cognition.com/blog/ai-productivity)）
   - 对已完成的真实会话做离线分类审计，结合人工抽样校准，重点识别“看似顺利结束但产物不可用”的虚假完成会话。

---

## 四、映射到 `team-work-runtime` 的评估指标与开源工具选型

### 1. “Owner → Challenger → Expert → 人工门”四层拓扑核心指标

结合上述业界方法与本仓库运行模型（[`team-work-runtime-model.md`](team-work-runtime-model.md)），评估 TWR 工作流应聚焦以下四个维度：

| 评估维度 | 核心指标 | 计算口径与数据源 | 用于发现什么问题/短板？ |
| --- | --- | --- | --- |
| **1. 审查链净增益** | **独家缺陷拦截率（U-IDR）**<br>**阶段缺陷逃逸率（DER）**<br>**虚假返工与有害改动率（HRR）** | 对比首轮交付快照与终版快照；统计 Challenger/Expert 首次提出且有证据的真缺陷占比；统计机器全票 `accept` 却在人工门被 `rework` 的逃逸占比；统计无证据挑刺或改坏已有功能的比例。 | 回答“Challenger 和 Expert 是否真抓出了问题”、“是否存在顺从放行（橡皮图章）”或“过度挑刺引发无意义返工”。 |
| **2. 收敛与范围纪律** | **轮次收敛分布（1/2/3/触顶率）**<br>**每轮边际增益（$\Delta$真缺陷/轮）**<br>**范围争议早停率**<br>**言行不一致率（MAST FC2.6）** | 从 `journal.jsonl` 与 `reports/*.json` 统计各包轮次、触发 `converge-user` 或 `reworkStalemate` 比例；遇到范围/授权争议时在第 1～2 轮主动 `blocked/escalate` 的比例；核对报告声称修改路径的快照 `digest` 是否真变。 | 评估 [`review-scope-control-plan.md`](review-scope-control-plan.md) 与 [`scope-dispute-pause-plan.md`](scope-dispute-pause-plan.md) 规则落地效果；决定“最多三轮”是否应在部分场景收敛为更少轮次。 |
| **3. 契约摩擦与健康度** | **交卷一次通过率（Intake Friction）**<br>**在途作废与重拆率**<br>**人工门一次批准率** | 统计 `deliver/review` 首次调用即通过率 vs 参数/路径拒绝次数；统计 `dispatch-superseded`（`tw retire`）、`re-scope`、决定卡指纹过期重签频次；统计 `design-approval` / `final-acceptance` 一次通过率。 | 发现 CLI 工具接口提示词、可写路径声明或派单模板是否存在理解歧义；衡量人工审查负担是否真正下降。 |
| **4. 跨档位性价比** | **单次过门任务加权成本**<br>**单缺陷拦截成本（CPID）**<br>**子代理越权扇出率** | 关联活动任务 `agents.json` 与宿主会话日志的真实 Token 用量，乘以 [`default.json`](../team-work/policies/default.json) 的 `costWeights`（`1:10:50`）；检查子会话是否违规派生高档位子代理。 | 指导各场景（`research`/`design`/`code-review`/`implementation`）的 `ownerTier`、`challengerTier` 与 `core`（是否启用 Expert）配置调优。 |

### 2. 可直接复用的开源评测工具对比与选型结论

针对本仓库基于 Node.js（ESM）与本地文件目录状态（`.team-work/`）的特点，对 7 个主流开源评估项目进行筛选：

| 开源工具 | 仓库与许可证 | 核心能力与适配方式 | 接入成本 | 选型结论 |
| --- | --- | --- | --- | --- |
| **Promptfoo** | [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)（MIT） | Node 原生 CLI + YAML 声明式配置；免外部数据库（本地 SQLite）；支持 `javascript` 确定性断言、`llm-rubric` 模型裁判、OpenTelemetry 轨迹断言（`trajectory:tool-sequence` / `step-count`）；自带 `promptfoo view` 跨版本差异对比界面。 | **1～2 人日**（需独立 Node >=22.22 环境运行评测命令） | **首选底座**：最契合本地任务目录离线审计与黄金夹具 A/B 回归。 |
| **MAST 标注管线** | [multi-agent-systems-failure-taxonomy/MAST](https://github.com/multi-agent-systems-failure-taxonomy/MAST)（MIT） | 提供现成的 14 类多智能体失效模式定义与少样本裁判提示词模板。 | **0.5 人日**（直接裁剪移植其分类定义与 Rubric） | **直接复用分类与提示词**：免去自研失效分类学成本。 |
| **DeepEval (TS)** | [confident-ai/deepeval](https://github.com/confident-ai/deepeval)（Apache-2.0） | 提供 TypeScript SDK（beta），支持 `vitest` 风格的 `toPass()` 门禁与 `TaskCompletion`、`StepEfficiency` 等指标，支持本地 JSON 存储。 | 1.5～3 人日 | **备选**：适合写进单测门禁，但本地跨版本可视化对比弱于 Promptfoo。 |
| **autoevals** | [braintrustdata/autoevals](https://github.com/braintrustdata/autoevals)（MIT） | 轻量 npm 评分函数库（Factuality、ClosedQA 等），无 CLI、无轨迹断言、无对比界面。 | 0.5 人日 | **辅助库**：可按需在自定义评测脚本中调用。 |
| **Inspect AI** | [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai)（MIT） | 英国 AI 安全研究所开源，容器沙箱隔离与多智能体 Transcript 审计能力极强，支持 `sandbox_agent_bridge` 桥接外部 CLI。 | 5～10 人日（Python 工具链 + 容器编排） | **远期备选**：适合未来建设跨项目隔离沙箱基准，当前接入偏重。 |
| **Langfuse / Opik / Phoenix** | [Langfuse](https://github.com/langfuse/langfuse)（MIT core）/ [Opik](https://github.com/comet-ml/opik)（Apache-2.0）/ [Phoenix](https://github.com/Arize-ai/phoenix)（ELv2） | 在线 Trace 收集、人工标注队列与多用户实验看板；需额外部署服务栈（Langfuse/Opik 依赖多容器，Phoenix 为非 OSI 的 Elastic License 2.0）。 | 3～5 人日 + 持续运维 | **当前不推荐**：`.team-work/` 与宿主本地会话日志已具备完整事实，现阶段无需重复建设重型观测平台。 |

### 3. 结合仓库现状的最小落地路径

根据对 [`runtime-v3/store.mjs`](../runtime-v3/store.mjs)、[`runtime-v3/intake.mjs`](../runtime-v3/intake.mjs)、[`runtime-v3/cli.mjs`](../runtime-v3/cli.mjs) 的代码核查，建议按“**先离线审计、再建黄金回归集、按需评估埋点**”推进（具体实施规划见 [`workflow-evaluation-plan.md`](workflow-evaluation-plan.md)）：

1. **零侵入离线轨迹审计（立即可做）**：
   - **对活动任务（归档前）**：直接复用 [`runtime-v3/waves.mjs`](../runtime-v3/waves.mjs)、[`runtime-v3/gate.mjs`](../runtime-v3/gate.mjs)、[`runtime-v3/derive.mjs`](../runtime-v3/derive.mjs) 的导出纯函数读取 `.team-work/tasks/<name>/` 下的完整日志与报告，并以 `agents.json` 中的子会话 ID 关联宿主本地会话记录，自动汇总轮次、返工率、人工门通过率、Token 成本与工具报错。
   - **对存量已归档任务（`.team-work/archive/*/`）**：由于 [`runtime-v3/cli.mjs:1231-1234`](../runtime-v3/cli.mjs#L1231-L1234) 归档时已删除活动目录且未保留 `agents.json`、`reports/` 与 `dispatched` 事件，仅从 `manifest.json`、`decisions.json` 与 `journal-summary.jsonl` 统计阶段完成形态、评审 `accept/rework` 摘要比例与人工决定分布，不强行回算波次或关联会话。
2. **基于 `dsh-headless` + 预注册 Rubric 构建黄金回归集（约 1～2 人日）**：从历史复盘台账（[`v2-e2e-findings.md`](v2-e2e-findings.md)、[`scope-dispute-pause-plan.md`](scope-dispute-pause-plan.md)）抽取 6～8 个脱敏典型场景，在归档前采集完整活动目录与宿主会话日志，用确定性脚本校验门禁与指纹不变量，用盲化裁判校验审查命中率与范围纪律，作为每次调整引导词、角色策略或模型档位配置前的标准回归基线。
3. **后续可选的 Runtime 轻量埋点方向（不在当前评测框架建设范围内，需另行批准）**：若未来希望归档后的历史任务也能离线重算波次与成本，需单独评估在 [`runtime-v3/cli.mjs`](../runtime-v3/cli.mjs) 归档摘要中保留 `dispatched`/`report-accepted` 与 `agents.json`、在 `dispatched` 事件补充 `tier`/`weight`、以及在 `intake` 拒绝时记录 `intake-rejected`。
