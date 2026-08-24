# Phase 3 前置收尾方案（v3.2 第二批 + 台账清偿）v2

状态：双轴交叉评审完成（意图轴 F1–F6 / 技术轴 F1–F8，共 14 findings：无 blocker、6 major、8 minor），全部吸收；处置记录见文末。进入实施。
用户裁决固化：八视角复用波组不加新波型；成本控制取"超默认升档审批卡"（否决投影）；台账全修；E2E 统一压轴（打包前）。

## A. 八视角并行独立审（复用波组，skill 为主）

**机制对账**：第一批波组已提供"多包并行 produce → consolidation 组合评审"。视角审阅即"包"，汇总即现有 consolidation 波。无新波型。

**三档形态（显式分列，轻量≠RO——评审 A-F1）**：
1. **全视角·正式交付**：owner 视角包（每包 writable=各自 findings 文件，done=该视角审查标准）+ 汇总包（dependsOn 全部视角，整合正式审查报告）→ 全链进收敛、core 场景 expert 裁决；
2. **全视角·轻量**：owner 视角包并行交付 findings，challenger 在 consolidation 波汇总（去重/归因/判 severity）即结论——**仍为正式成员、进收敛、有 deliver 登记**；
3. **非全视角抽查**：RO 只读子派单（junior、可写空、不进收敛不改文件、发起者核验整合）——与 1/2 是不同模式，不是"轻量版"。

**runtime 小改**：packages 定义增可选 `tier`（junior|senior|expert；tw plan 验收；派发点覆盖场景默认档）。

**档位计算与升档触发（评审 A-F5 + B-F4c 合并裁定）**：
- 实际派发档 = max(包 tier ?? 场景默认 ownerTier, riskTiers[risk] ?? 场景默认)——tier 与 risk 同时存在取更高者；
- **升档审批触发只看 包 tier > 场景默认 ownerTier（直接比较，不含 risk）**——risk 是用户显式指定（open 时已提示），不重复审批；包 tier 是 Lead 拆包决定，超默认需用户授权。

**档位指引表**（skill，指引非硬编码）：需求摘要/类型不变量/规范合规 → junior；缺陷与安全（安全敏感可 expert）/错误处理/逻辑推演/影响范围 → senior；测试覆盖 → junior|senior。

## C. 升档审批卡

**原则**：默认档位零打扰；仅"包 tier 高于场景默认"的派发批次需用户批准一次。

**触发点**：runTransition 的 owner 派发分支内、派发事件写入前（cmdRun 与 cmdDispatchPlan 共用此单点——评审 B-F4c）；比较 = 包 tier > sp.ownerTier。

**卡片与凭证（评审 B-F4a/b + A-F4）**：
- 一次派发批次全部升档**合批一张卡**：列"包 × tier × 权重倍数"；第二 expert（skill 判定需要时）同批并入并附原因；
- choices：批准（label="批准升档"，**grant="approve-escalation"**——走 cmdDecide 已有的 grant 通道，同 extra-round 机制）｜拒绝（label="降回默认档继续"）；
- decision 结构：`{grant:"approve-escalation", detail:{stage, round, packages:[包id…], items:[{package,tier,weight}], secondExpert?:{reason}}}`——**幂等身份 = stage+round+包集**：预检存在 grant=approve-escalation 且身份匹配本批 → 不再出卡（批准后异常重跑不重复打扰，AGENTS 规则 6）；
- gate.mjs 现有消费者（route/gateId/extra-round/rework 查找）与此凭证无交集（技术评审已核实不误伤）；
- 拒绝路径：本批全部包按场景默认档派发，包 tier 忽略（journal 不留降级记录——派发事件自会体现实际 tier）。

**不做**：tw status 投影、积分累计、automaticLimits 对照（用户否决）。

## B. e2eTemplate 复活（run 路由物化三包）

**前置缺陷修复（新台账 D7，评审 B-F1 发现的现存潜伏缺陷）**：advance 边选择现码 `edges.find(outcome==='pass') ?? edges[0]`——code-review 无 pass 边且 run-e2e/skip-e2e 无消费者，恒取 edges[0]=implementation-defect 弹回 implementation，**runTransition 实际无法推进任务到 e2e/finish**（历史 E2E 均 through-stage 未触发）。修复：advance 分支按路由决定选边——e2e 决定 run→`outcome==='run-e2e'`、skip→`'skip-e2e'`；spec 同理（use-spec/skip-spec）；无路由声明的阶段维持现行为。独立修复独立测试（先于 B 实施）。

**形状映射（评审 B-F2/A-F6；拟议伪代码）**：
```
# policy.e2eTemplate 条目 → packages 条目（实施时按此单测；映射表内置在物化函数，不改 policy 数据）
{
  id:          entry.packageId,
  writable:    entry.outputRefs.map(ref => artifactRefToWritable(ref)),  # "artifact:e2e-design" → 约定路径（如 "e2e/design.md:e2e-design"），映射规则实施时定死并单测
  done:        entry.completionCriteria,
  dependsOn:   entry.dependsOn,
}
```

**物化时点**：advance 进入 e2e 阶段后首次派发前（derive 已保证无在途才 advance）；`--entry e2e` 直达任务在首次 run 派发前同样物化；任务已有 packages.json（用户 tw plan 过）**不覆盖**。journal 记 packages-planned，detail 附 source:"e2eTemplate"。

## D. 台账（修订后 7 项）

| # | 方案（修订吸收） |
| --- | --- |
| D1 rebuildArtifacts kind | 签名扩 journal 参数（loadTask 调用处已有）；**预建 dispatchKey→writable Map（O(m)）再逐 report O(1) 查 kind**（评审 B-F6）；查不到派发事件的历史报告兜底 misc；测试：重建后 gate 按 kind 匹配通过 |
| D2 拒绝带派单身份 | **收窄为同任务两场景**（评审 B-F5：跨任务提示需热路径整树扫描，数据不可得代价不当）：①key 有效但角色不符/路径越界 → 附"本派单：角色/包/轮次、writable=[…]"；②key 不存在 → 列当前在途 key 清单 |
| D3 expectedAgentId 无包波 | **限定放宽**（评审 B-F3：全局放宽会让包2 respond 误继承包1 agent）：仅 d.package==null 的波按"同角色"匹配上一派发；包波维持同包同角色匹配 |
| D4 inflight/waves 形状 | **inflight 输出层映射**（评审 B-F7：dispatchCard 的 key 字段动则影响全派单链，不动）：inflightDispatches 输出时映射 key→dispatchKey；skill 示例同步 |
| D5 评审修订与波派发时序 | ①skill 强约定（challenger 修订重交必须 notify Lead、Lead 重取波再转发）+ 汇总包完成标准兜底；②findingsDigest 为观察项（双轴一致倾向①） |
| D6 verdict 派单内嵌包计划 | **优先于 D5② 实施**（意图轴判定）：dispatchCard parts 增"本任务包计划：store✓ intake✓ overview（未交付，依赖满足后自动派发——缺包不构成 rework 依据，完整性顾虑写 unresolved）"——数据从已加载 task.packages+reports 推导（技术评审确认可得），不读 .team-work |
| D7 advance 边选择按 route | 见 §B 前置段；独立于 e2eTemplate 修复 |

## 实施序（修订）

D7（advance 缺陷，独立且为 B 前置）→ D1–D6（台账）→ A（tier 字段 + skill 三档形态）→ C（升档卡）→ B（e2eTemplate 物化）→ **统一真实 E2E**（多包任务全视角流程：视角并行 → 汇总 → 裁决 → 升档卡实测 → e2eTemplate 物化链 → 人工门）→ 具备 Phase 3 打包条件。

## 测试计划（修订：含评审 B-F8 补缺 + 预算声明）

- A：tier 验收（合法/非法/**缺省回落**）；实际档 = max(包tier, risk升档)；**包 tier 高于默认触发升档卡；risk 升档不触发**；tier 进 dispatch-plan 导出
- C：升档触发（单包/合批/含第二 expert）；grant=approve-escalation 凭证落盘形状；**批准后重跑不重复出卡（幂等身份）**；**批准落盘后中断再 run 正确继续**；拒绝降回默认档
- B/D7：advance 按 route 选边（run/skip/无路由不回归）；--entry e2e 直达物化；**已 plan 不覆盖**；**模板形状映射单测**
- D1：journal 派发事件还原 kind + gate 匹配；无事件兜底 misc
- D2：**角色错配 vs key 不存在两分支文案**断言
- D3：**无包波连续轮带 expectedAgentId；多包 respond 包间不串**
- **预算声明（charter §7）**：本阶段增量测试均属"新增产品规则（tier/升档卡/e2eTemplate 物化）+ 真实缺陷修复（D1/D2/D3/D4/D7）"豁免范畴；预期测试:实现比率由 0.64 继续上行，理由如上；实现行数维持 ≤3k 预算内（改动以小步为主）；文档同步时在 roadmap 如实更新比率。

## 明确不做

tw status/成本投影（用户否决）；八视角新波型（复用波组）；第二 expert 的 runtime 感知（skill 承载、凭证并入升档卡）；跨任务 key 提示（数据不可得）；E2E 分项验证（统一压轴）；Phase 3 插件本体（独立方案）。

---

## 自复核记录（v1，补文档化——评审 A-F2）

1. A/C 咬合：视角包升档 → 合批卡 ✓（v2 增幂等身份与 grant 通道后闭合）
2. C 凭证合规：approve-escalation 走 grant 通道入 decisions.json，P1 判定合法（意图轴确认）✓
3. D1 边界：查不到派发事件兜底 misc 不炸 ✓
4. D5 双候选列两案 ✓（v2 定①起步）
5. 遗漏检查：ORCH-REVIEW.md 已清理 ✓；测试比率 v2 已显式声明 ✓
6. B 细节：已 plan 不覆盖 ✓（v2 补 --entry e2e 入口）
7. 用户第三点原话核对 ✓（v2 增 B-F4c 直接比较，防 risk 误触发）
8. **v1 盲区自查**：自复核仅在会话内未入文档（A-F2 指出）；advance 边选择未核查（B-F1 挖出）——教训：方案涉及"阶段推进"时必须核对 workflow 边定义与选边代码，不止看新增部分。

## 评审处置记录

| Finding | severity | 处置 |
| --- | --- | --- |
| A-F1 三档/RO 边界混叠 | major | §A 三档显式分列，轻量≠RO |
| A-F2 自复核未入文档 | major | 本节补齐 + v1 盲区自查 |
| A-F3 测试预算未声明 | major | 测试计划节预算声明 |
| A-F4 第二 expert 卡不统一 | minor | 并入合批卡、共用 grant 凭证附原因 |
| A-F5 tier 降级/risk 优先序 | minor | §A 档位计算裁定（max 取高；触发只看 tier 直接比较） |
| A-F6 e2eTemplate 映射 | minor | §B 映射伪代码（与 B-F2 合并） |
| B-F1 advance 不可达 | major | 新台账 D7，B 硬前置，独立修复 |
| B-F2 模板形状不匹配 | major | §B 映射 + 单测（与 A-F6 合并） |
| B-F3 prevKeyOf 全局放宽破坏多包 | major | §D3 限定 package==null |
| B-F4 grant 通道/幂等/直接比较 | major | §C 凭证形状 + 幂等身份 + 触发比较 |
| B-F5 跨任务提示不可得 | minor | §D2 收窄同任务 |
| B-F6 D1 签名与复杂度 | minor | §D1 Map 方案 |
| B-F7 D4 影响面取舍 | minor | §D4 输出层映射 |
| B-F8 测试缺口 | minor | 测试计划逐条补 |
