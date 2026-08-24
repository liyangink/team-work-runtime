# 团队拓扑找回方案（v3.2 计划）

状态：待交叉评审。背景：DSH Phase 1 编排 E2E（orch-e2e 任务）跑通了串行角色链，同时暴露多 Agent 拓扑缺口；复盘确认 v3 重写时"拓扑执行归平台"被扩大为"拓扑语义不存在"，v2 的拆分/并行/汇总/选人语义丢失（原始设计见 Git 历史 `c4d5270:skills/team-work/references/` 与 `c4d5270:team-work/compiler.mjs`）。

## 0. 平台事实修正（实测 2026-08-24）

- workflow 的 `agent()` 一次性、无句柄、子代不入可持续 registry（UI 标签退化为指纹）——**不能承载持续角色**；
- 续聊原语 = Lead 层后台 `subagent`（持久 id、可命名）+ `send_message`（仅 depth-1）——**凡需多轮续派的成员，首次派发必须在 Lead 层建立**；
- 一次性扇出（只读探查、独立视角审）适合 workflow `parallel`。

## 1. 分层判定（谁决策 / 谁执行）

| 事 | 决策者 | 执行/承载 |
| --- | --- | --- |
| 要不要拆、拆几包、边界怎么划 | Lead（skill 指引；可先用只读子派单收集事实） | `tw plan` 登记 + 调用内同步验收 |
| 拆得对不对（互斥/无环/完成标准） | runtime 规则 | plan/deliver 调用内一次查完（P2） |
| 该用哪个档位 | policy 数据（场景→tier；risk→升降） | 派发点查表 |
| 档位用哪个模型 | policy 规则（同档家族去重）+ 用户候选池 | 派发点确定性挑选 |
| 要不要花钱继续（成本门） | runtime 投影 + 用户决定 | Phase 2（weight 先行导出） |
| 开几个 subagent、续聊/新开、并行 | Lead 按规程机械执行 | DSH 平台原语 |

## 2. 第一批交付

1. **waves.mjs 波组化**：`nextWave` 输出波组——produce 波带 `owners:[包集合]`（无 packages.json 时 `[null]` 完全兼容单 owner）；review 波多包时 `scope:"consolidation"`（组合制品视角）；轮完成 = 活跃包集合每包有当轮 deliver；challenger findings 带 package 归属时下一轮**选择性重派**（只重派被 rework 的包）；`continuation` 标注（同包同角色已有报告 → true）。
2. **tw plan 命令**：`--task <n> --packages '<JSON>'`——验收：id 唯一、writable 两两不相交、dependsOn 存在且无环、每包有完成标准、路径合法；通过写 `packages.json` + journal 记事件；活跃轮中禁重拆（返回卡片说明）。packages.json 是拆分决定的登记事实（类比 intent.json 承载用户输入），非派生状态。
3. **store.mjs**：loadTask 读 packages.json（缺省 = 单 owner 模式）。
4. **dispatch-plan 波组导出**：每波增 `package / continuation / dependsOn / weight(costWeights[tier])`；wait-inflight stop 卡**内嵌原波组全文**（修复 E2E 断链缺陷：补派不再要求 Lead 记住上轮输出）。
5. **continuation 增量派单**：续派轮只带"本轮意见 + 包内待改清单"，不重述全量上下文。
6. **选人**：`.team-work/platform/dsh.json` 档位值从单模型升级为候选数组（`[{provider, model, family}]`，单模型为兼容特例）；挑选规则 = 家族去重后取序（policy `selection.diversityWithinTier`）；risk 升降：`tw open --risk critical|high|normal` 写入 intent（`tw intent --risk` 可修订），仅 owner 波查 `policy.riskTiers` 升档（critical→expert、high→senior，只升不降；challenger/expert 不受影响）。
7. **skill 重写**：`references/dsh-orchestration.md` 改为 Lead 派发操作规程（决策表：continuation=false 组内多 owners → 每包一个命名 subagent（label=`<task>.<stage>.owner@<pkg>`）；continuation=true → send_message 续原会话；一次性扇出 → workflow parallel；stop=awaiting-user → 呈现 choices 走 decide；stop=wait-inflight → 用卡内嵌派单补派）。SKILL.md 补拆包判断指引与 risk 判断。
8. **测试** +10~12：波组兼容退化、plan 验收拒绝矩阵、选择性重派、continuation、risk 升档、候选池挑选、wait-inflight 自包含。
9. **E2E 验收**：多包真实任务（如"三模块各写说明 + 一份总览包 dependsOn 三者"）实测：并行派发、组合挑战、选择性重派、continuation 续聊四件事发生。

## 3. 第二批（第一批验收后）

- 八视角独立并行审：code-review 场景 `reviewTopology:"independent-then-consolidate"`——produce 后插入并行独立审波（N 视角 = N 个一次性 junior 成员，各自只出 findings）→ consolidate 波由 challenger 汇总去重归因出唯一 recommendation（v2 code-review.md 原始设计）；
- e2eTemplate 复活：e2e 路由 run 时物化三包串行链为波组；
- Phase 2 成本投影（weight 已在波次导出）。

## 4. 边界与不做

- 拆包不设 planning 波（用户裁决：Lead 定即可，多委派一轮不划算）；
- gate.mjs / workflow 定义不改（多包时产出物在场按 kinds 聚合，天然兼容）；
- 选模数据积累不进任务循环（v2 评分已删，维持）；
- 派单纪律外的成员写边界拦截仍待 Phase 3 插件 hook。

## 5. 脱敏约束（适用本方案全部产物）

方案文档、配置示例、测试夹具禁止引用执行环境真实标识（provider 名、配置值、项目名、账号）；公开模型名可示例；实现不内置环境默认，无法解析显式 unresolved（已落地：dsh-map.mjs）。
