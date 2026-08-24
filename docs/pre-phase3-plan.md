# Phase 3 前置收尾方案（v3.2 第二批 + 台账清偿）

状态：草案，待自复核与交叉评审。范围 = Phase 3 插件打包前的全部剩余工作（E2E 统一验证压轴）。用户裁决已固化：八视角复用波组机制不加新波型；成本控制取"超默认升档审批卡"（不做 tw status 投影）；台账 6 项全修；修复不单独跑 E2E。

## A. 八视角并行独立审（复用波组，skill 为主）

**机制对账**：第一批波组已提供"多包并行 produce → consolidation 组合评审"——视角审阅即"包"，汇总即现有 consolidation 波。无新波型。

**runtime 小改（仅一处）**：packages 定义增可选 `tier` 字段（合法值 junior|senior|expert；tw plan 验收；派发点包 tier 覆盖场景默认档）。派发点该覆盖若高于场景默认 → 触发 §C 升档审批卡。

**skill（scenarios.md 重写 code-review 节）**：
- 全视角流程：Lead `tw plan` 登记视角包（每包 writable = 各自 findings 文件 `review/findings-<视角>.md`，done = 该视角审查标准；writable 天然互斥）；视角包并行交付 findings（deliver 登记为制品，kind 用 findings 类，不进 gate outputs 检查）→ consolidation challenger 汇总去重、归因、判 severity，出唯一 recommendation（+合并 findings）→ core 场景 expert 裁决 → 门；
- **档位指引表**（指引非硬编码，Lead 按场景调整）：需求摘要/类型不变量/规范合规 → junior；缺陷与安全（安全敏感可 expert）/错误处理/逻辑推演/影响范围 → senior；测试覆盖 → junior|senior；
- 两变体：轻量（无汇总包，challenger 汇总即结论）/正式交付（加汇总包 dependsOn 全部视角，整合成正式审查报告——现有 DAG 能力）；轻量抽查（非全视角）继续用 RO 只读子派单（现状已支持）。

## B. e2eTemplate 复活（run 路由物化三包）

route --decision run 后推进到 e2e 阶段时：若该任务无 packages 且场景 teamScene=e2e → 自动按 policy.e2eTemplate 物化 packages.json（journal 记 packages-planned，detail 标 source:"e2eTemplate"），后续走标准波组 DAG（path-design → fixture-implementation → execution 串行链，天然测依赖锁）。Lead 也可 tw plan 覆盖（重拆窗口规则照常）。

## C. 升档审批卡（Phase 2 用户简化版，替代投影设计）

**原则**：默认档位零打扰；仅"超出场景默认档"的派发动作需用户批准一次。

触发点（dispatch-plan/run 派发前检查）：
1. 包 tier 高于场景默认 ownerTier（§A 视角包升档主场景）；
2. risk 升档**不触发**（用户 open/intent 显式指定，卡片已提示过）；
3. 第二 expert：波次机现无此概念——落 skill：Lead 认为需要第二 expert（不可逆决策/证据冲突/反复失败）时必须先出用户卡片说明理由，批准后才派（runtime 不感知）。

**卡片形状**：一次派发批次中全部升档**合批一张卡**（避免 8 视角 8 次打扰）：列"包 × 升档 × 档位 × 成本权重倍数"，choices = 批准全部 / 降回默认档继续。decide 后按批准结果派发。凭证记 decisions.json（choice=approve-escalation，附包清单）。

**不做**：tw status 投影、成本积分累计、automaticLimits 对照（用户裁决：过度设计）。

## D. 台账 6 项修复方案

| # | 方案 |
| --- | --- |
| 1 rebuildArtifacts kind | 重建时按 deliver 报告的 dispatchKey 回查 journal 派发事件的 writable（path→artifactKind），还原 kind；查不到事件的历史报告才兜底 misc（附测试：重建后 gate 按 kind 匹配通过） |
| 2 deliver/review 拒绝带派单身份 | key 不对应有效派单时：错误信息附该 key 若存在于其他任务/角色的提示；key 有效但路径越界时：附"本派单：角色/包/轮次、writable=[…]"（成员立即识别 key 错配或越界）；key 不存在时列当前在途 key 清单 |
| 3 expectedAgentId 无包波 | prevKeyOf 放宽：同角色（不要求同包）的上一派发即可匹配（challenger/expert 的连续派发均为无包波） |
| 4 inflight/waves 形状统一 | 统一字段名 dispatchKey（inflightDispatches 输出改字段；消费端仅 Lead skill 文档，同步更新示例） |
| 5 评审修订与波派发时序 | 两个候选，评审定夺：①skill 规程——challenger 修订重交必须主动通知 Lead，Lead 重新取波再转发（零 runtime 改动，依赖纪律）；②runtime——respond 派单内嵌意见摘要附报告 reportId + 派发事件记 findingsDigest，重交后 digest 不符时下一轮派单自动带"评审已修订"标注（更硬，改动中等）。倾向 ① 起步、② 观察 |
| 6 verdict"补缺包"语义 | 派单自包含改进：verdict/review 派单内嵌包计划摘要（"本任务包：store✓ intake✓ overview（未交付，依赖满足后将自动派发——**缺包不构成 rework 依据**，完整性顾虑写 unresolved"）——把编排事实给到裁决者，消除 expert 误判（topo-e2e w17 实例） |

## 顺序与验证

实施序：D（台账清偿，独立无依赖）→ A（tier 字段 + skill）→ C（升档卡，依赖 A 的 tier）→ B（e2eTemplate）。
每步全量单测绿；全部完成后统一真实 E2E（多包任务走八视角全流程：视角并行 → 汇总 → 裁决 → 升档卡实测 → 人工门），E2E 通过即具备 Phase 3 打包条件。

## 测试计划（增量）

- A：packages.tier 验收（合法/非法）、派发点包 tier 覆盖、tier 字段进 dispatch-plan 导出
- C：升档触发卡（单包/合批）、批准后派发、降回默认档路径、risk 不触发
- B：e2e run 物化三包 + 依赖锁推进 + plan 覆盖
- D1：损坏索引重建后 kind 还原 + gate 匹配通过；D2：三种拒绝场景断言文案；D3：verdict 波续派带 expectedAgentId；D4：inflight 字段名；D6：verdict 派单含包计划摘要

## 明确不做（本阶段）

tw status/成本投影（用户否决）；八视角新波型（复用波组）；第二 expert 的 runtime 感知（skill 承载）；E2E 分项验证（统一压轴）；Phase 3 插件本体（后续独立方案）。
