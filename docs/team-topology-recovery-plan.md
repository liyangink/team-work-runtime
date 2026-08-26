# 团队拓扑找回方案（v3.2 计划）

状态：历史 v3.2 方案与评审记录；拓扑能力已实施，配置部分已由全局 settings 取代。评审记录：

> **迁移说明（当前实现）**：本方案早期所称项目 `.team-work/platform/dsh.json` 已不再是配置源。tier→模型唯一来自 DSH 全局 settings 的 `team-work-dsh.tiers`（DSH Web“插件配置”页），每档兼容单对象或候选数组，provider/model 必填，family/effort 可选；同波候选池优先不同 family。`.team-work/tasks/<任务>/agents.json` 仍是 dispatchKey→childId 与 modelHint 快照的项目运行事实。`injectionEnabled`、`projectRoots`、`twBin` 已移除且不兼容读取；注入和 `tw` 工具只以子会话 cwd 定位项目。

- **评审 A（架构/规范轴，2026-08-24）**：无 blocker；F1–F9 全部吸收（见 §2 各条标注）——F1 DAG 分层派发、F2 按包计轮、F3 findings 包归属与无归属回退、F4 incumbent 降级规程、F5 continuation 基线锚定（agent-map）、F6 重拆窗口事实锚定、F7 整合 Owner=汇总包、F8 consolidation 聚合指纹；A1–A3/A6 判定合规（tw plan 仅机械验收、语义质量归 Lead；packages.json 为决策事实非平行权威；plan 验收即 P2 检查点）。
- **评审 B（实现轴，2026-08-24，对象 73c8e92+c5623d5）**：无 blocker；F1 损坏锁回收（已修：超龄回收+竞态窗口重试+fixHint）、F3 verdict dispatchExample 缺 --verdict（已修+断言）两个 major；F2 tiers:null（已修）、F5 blocked 卡形状（已修统一对象数组带 recovery）、F6 幂等 registered 形状（已修补 digest）三个 minor；F4 wait-inflight 内嵌全文=本方案 §2.4 范围；review 幂等 findings 顺序敏感判定可接受（顺序即内容）；测试缺口补 5 项；62/62 绿。

背景：DSH Phase 1 编排 E2E（orch-e2e 任务）跑通了串行角色链，同时暴露多 Agent 拓扑缺口；复盘确认 v3 重写时"拓扑执行归平台"被扩大为"拓扑语义不存在"，v2 的拆分/并行/汇总/选人语义丢失（原始设计见 Git 历史 `c4d5270:skills/team-work/references/` 与 `c4d5270:team-work/compiler.mjs`）。

## 0. 平台事实修正（实测 2026-08-24；插件注入通道 2026-08-24 二次更新）

- workflow 的 `agent()` 一次性、无句柄、子代不入可持续 registry（UI 标签退化为指纹）——**不能承载持续角色**；
- 续聊原语 = Lead 层后台 `subagent`（持久 id、可命名）+ `send_message`（仅 depth-1）——**凡需多轮续派的成员，首次派发必须在 Lead 层建立**；
- 一次性扇出（只读探查、独立视角审）适合 workflow `parallel`；
- **continuable 子代理的模型/effort 插件注入通道**：`ctx.subagents.registerContinuableSetup(contribution)`（dsh-subagent 官方 API）+ `installModelSelection`（dsh-agent 导出，含 reasoningEffort 继承剥离）为每个 continuable 子代（fresh creation 与 cold-resume）提供 `{provider, model, reasoningEffort}` 注入通道。自动层已验证装载、隔离、快照读取与降级；**真实 LLM 请求的注入/effort header 仍待用户实机确认**。覆盖边界：仅 continuable 路径（subagent/subagent_fork 后台）；workflow/ralph 的一次性子代不走 setupRegistry、不可达（恰为 RO 廉价扇出，effort 需求最低，可接受）。

## 1. 分层判定（谁决策 / 谁执行）

| 事 | 决策者 | 执行/承载 |
| --- | --- | --- |
| 要不要拆、拆几包、边界怎么划 | Lead（skill 指引；可先用只读子派单收集事实） | `tw plan` 登记 + 调用内同步验收 |
| 拆得对不对（互斥/无环/完成标准） | runtime 规则（**仅机械属性**：id 唯一、可写互斥、依赖无环、完成标准在场、路径合法） | plan 调用内一次查完（P2） |
| 拆分**语义质量**（边界是否合理、粒度是否得当） | Lead 责任，不转移 | skill 判断指引（机械验收不背书语义） |
| 该用哪个档位 | policy 数据（场景→tier；risk→升降） | 派发点查表 |
| 档位用哪个模型 | 全局 `team-work-dsh.tiers` 候选池（同档家族去重） | 派发点确定性挑选 |
| 要不要花钱继续（成本门） | runtime 投影 + 用户决定 | Phase 2（weight 先行导出） |
| 开几个 subagent、续聊/新开、并行、崩溃恢复 | Lead 按规程机械执行 | DSH 平台原语 + agent-map 登记 |

## 2. 第一批交付

1. **waves.mjs 波组化**：
   - produce 波带 `owners:[包集合]`（无 packages.json 时 `[null]` 完全兼容单 owner）；review 波多包时 `scope:"consolidation"`（组合制品视角）；
   - **DAG 分层派发（F1）**：每波 owners = 依赖已满足（其 dependsOn 包均已交付）且自身未交付的包；依赖未满足的包不出现在该波；后续波在依赖交付后自动解锁；
   - **按包计轮（F2）**：每包独立收敛计数（该包 owner deliver 数 + 该包被挑战轮次），独立触发 converge-user；任一活跃包触发时任务出用户卡（选项含"结束该包/追加该包一轮/换该包 owner"），已收敛包不受影响、不重复上场；awaiting-user 静止语义照旧（规则 6）；
   - **选择性重派（F3）**：challenger/expert 的 findings[] 增可选 `package` 字段（intake 放行并随报告存储）；rework 时有归属 findings → 只重派所指包；无归属 findings 或纯 escalate → 保守回退：全组活跃包重派，journal 记录回退原因；
   - **continuation 标注（F5）**：同包同角色已有报告 → true；基线 = 该包该角色**最近一轮**报告及其对应派发；
   - **consolidation 指纹（F8）**：多包组合被审指纹 = 各包 deliverable digests 聚合；Expert 裁决新鲜度参照 = max(各包 owner 最新交付 at)。
2. **tw plan 命令**：`--task <n> --packages '<JSON>'`——机械验收：id 唯一、writable 两两不相交、dependsOn 存在且无环、每包有完成标准、路径合法；通过写 `packages.json` + journal 记事件。**重拆窗口（F6）**：存在待决卡片或在途派发（journal dispatched 无对应 report）→ 拒绝并返回当前状态卡；否则允许覆盖（journal 记 re-planned）。packages.json 是拆分决定的登记事实（类比 intent.json），非派生状态。
3. **store.mjs**：loadTask 读 packages.json（缺省 = 单 owner 模式）。
4. **dispatch-plan 波组导出**：每波增 `package / continuation / dependsOn / weight(costWeights[tier])`；continuation 波附 `expectedAgentId`（从 agent-map 读，见 §2.6）；wait-inflight stop 卡**内嵌原波组全文**（修复 E2E 断链缺陷）。
5. **continuation 增量派单**：续派轮只带"本轮意见 + 包内待改清单"，不重述全量上下文。
6. **agent 映射与选人**：
   - `tw agent-map --task <n> --key <dispatchKey> --agent <平台subagentId>`：Lead 实际开 subagent 后登记 dispatchKey→agentId 到 `.team-work/tasks/<任务>/agents.json`（平台绑定事实，Lead 维护，runtime 只读写不调用平台）；
   - **降级规程（F4，落 skill）**：send_message 失败/incumbent 不可用 → 以全量派单文本新开 fresh subagent、重新 agent-map 登记、该包 continuation 重置；replace-owner（用户点名换人）走同一通道；
   - 当前档位候选池位于全局 `team-work-dsh.tiers`：单对象或 `[{provider, model, family?, effort?}]` 数组均兼容，挑选 = 家族去重后取序（policy `selection.diversityWithinTier`）；risk 升降：`tw open --risk critical|high|normal` 写入 intent（`tw intent --risk` 可修订），仅 owner 波查 `policy.riskTiers` 升档（只升不降；challenger/expert 不受影响）。项目 dsh.json 不读取或创建。
7. **skill 重写**：`references/dsh-orchestration.md` = Lead 派发操作规程（决策表：continuation=false 组内多 owners → 每包一个命名 subagent（label=`<task>.<stage>.owner@<pkg>`）并 agent-map 登记；continuation=true → 对 expectedAgentId send_message，失败按降级规程 fresh 重开；一次性扇出 → workflow parallel；stop=awaiting-user → 呈现 choices 走 decide；stop=wait-inflight → 用卡内嵌派单补派）。SKILL.md 补拆包判断指引（含**语义质量责任声明**）与 risk 判断、整合包完成标准模板（**F7**：dependsOn 汇总包即整合 Owner——完成标准必须含"合并各包结论、解决冲突、不丢信息"）。
8. **测试** +12~14：波组兼容退化、plan 验收拒绝矩阵、**F1 依赖分层**（总览包不出现在首波、依赖交付后解锁）、**F2 按包计轮**（单包收敛不影响他包）、**F3 归属重派与无归属回退**、continuation 标注、**F6 重拆窗口拒绝与允许 + P1 可重算**（改 packages.json 后 derive 输出与重放一致）、risk 升档、候选池挑选、wait-inflight 自包含、agent-map 读写。
9. **E2E 验收**：多包真实任务（如"三模块各写说明 + 一份总览包 dependsOn 三者"）实测：并行派发、**依赖解锁次序**、组合挑战、选择性重派、continuation 续聊、（人为终止一个 incumbent 验证）降级重开。

## 3. 第二批（第一批验收后）

- 八视角独立并行审：code-review 场景 `reviewTopology:"independent-then-consolidate"`——produce 后插入并行独立审波（N 视角 = N 个一次性 junior 成员，各自只出 findings）→ consolidate 波由 challenger 汇总去重归因出唯一 recommendation（v2 code-review.md 原始设计）；
- e2eTemplate 复活：e2e 路由 run 时物化三包串行链为波组；
- Phase 2 成本投影（weight 已在波次导出）。

## 4. 边界与不做

- 拆包不设 planning 波（用户裁决：Lead 定即可；与 charter §6.1 planning Owner 退役一致）；tw plan 验收只保机械属性，语义质量归 Lead（评审 A1）；
- gate.mjs / workflow 定义不改（多包时产出物在场按 kinds 聚合，天然兼容）；
- 选模数据积累不进任务循环（v2 评分已删，维持）；
- 派单纪律外的成员写边界拦截仍待 Phase 3 插件 hook。

## 5. 脱敏约束（适用本方案全部产物）

方案文档、配置示例、测试夹具禁止引用执行环境真实标识（provider 名、配置值、项目名、账号）；公开模型名可示例；实现不内置环境默认，无法解析显式 unresolved（已落地：dsh-map.mjs）。
