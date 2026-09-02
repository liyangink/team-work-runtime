---
name: team-work
description: 用 tw CLI（open/run/decide/intent/archive + deliver/review）驱动多智能体研发工作流。用户要求代码审查、方案设计、实现、测试或任何阶段性团队协作时使用；Lead 依据本 skill 判断阶段入口、组团与审查强度。
---

# team-work（v3）

房间与门：成员在房间里自由工作（派单内嵌全部上下文），检查只发生在两处——**交付工具调用内**（同步、单次、全量）和**阶段门**（产出物在场、检查通过、非作者评审在场）。你不管理任何运行时状态；任务目录（`.team-work/tasks/<name>/`）就是状态。

## 判断指引（Lead 依据用户语义决定，不由工具强制）

- **选入口**：审查请求 → `code-review`；新功能/改动 → `research` 或直接 `implementation`（已有明确方案时）；测试补充 → `test`；方案讨论 → `design`。显式 `--entry` = 任务只运行到该阶段验收；缺省 research = 完整工作流。
- **是否组团**：单一明确产出且改动面小 → 单 Owner + 一位 Challenger；目标含多个可独立验收的垂直范围且可写范围能互斥拆分 → `tw plan` 拆包（**定包 tier：默认 junior**——廉价档胜任绝大多数常规作业，审查链兜底；仅按失败成本升档：错误难发现/返工贵 → senior，不可逆/安全敏感 → expert——依据见拓扑与成本篇；高于场景默认档会触发用户升档审批卡；成员执行中力有不逮可经 unresolved 上抛建议升档）；多包 = 并行 owner 波 + 组合评审 + findings 包归属选择性重派；汇总包=整合 Owner，完成标准须含合并/解冲突/不丢信息）；拆分语义质量归你把关，runtime 只验互斥/无环/完成标准。
- **risk 档**：不可逆/数据迁移/安全敏感/核心跨模块 → `--risk critical`（未显式定 tier 的包兜底升 expert 且免审批；包级判断仍以 tw plan 的显式 tier 优先）；较高风险 → `high`；常规缺省 normal。
- **审查强度**：默认轻量；安全敏感、跨模块、用户点名严格、生产缺陷复盘时要求完整八视角。
- **何时升级**：两轮未收敛 → 第三轮 Expert 裁决（角色=裁决波）；三轮耗尽 → [追加一轮 / 结束任务] 卡片交用户。角色（owner/challenger/裁决者）与档位（junior/senior/expert 预算）正交——裁决者每轮一个（波次机结构），expert 档的 owner 包完全正常，见拓扑与成本篇。

场景化的拓扑选择、成本分档与收敛细节见 **[拓扑与成本](references/topology-and-cost.md)**；代码审查八视角与 finding 质量、方案讨论、并行施工、测试协作、用户汇报结构见 **[场景指导](references/scenarios.md)**；DSH 编排层执行团队拓扑（dispatch-plan → agent 派发）的脚本模板见 **[DSH 编排](references/dsh-orchestration.md)**；派单内按角色/场景自动注入的公共引导库见 **[派单引导库](references/guidance.md)**。

## Lead 操作

```bash
tw open --name <名字> --objective "<目标一句话>" [--entry <stage>]   # 开房间；重名会拒绝并提示
tw run --task <名字> [--writable <路径>:<kind> ...]                  # 推进一步；返回卡片或派单
tw decide --task <名字> --choice <序号> [--note ...]                 # 回答当前卡片
tw intent --task <名字> [--objective ...] [--add-constraint ...]     # 随时修订目标/约束
tw archive --task <名字>                                              # 用户明确要求归档时
```

- 每次 `run` 返回一张卡片：按它行动，不要预判步骤。`dispatch` 卡片给你派单全文和 key——**原样**转发给成员（后台 subagent），不要改写边界。
- `awaiting-user` 卡片出现时任务静止：向用户呈现选项并等待；不要轮询、不要代答。
- 成员完成的通知到达后再 `run`，消费报告并推进。
- 向用户只报告：完成了什么、当前阶段、关键制品路径、风险/分歧、下一步。
- **汇报说人话（认知对等硬约束）**：卡片自带的 `presentation` 字段是呈现纪律，每次汇报时机都在场——必须遵守，不因会话变长而淡化；`awaiting-user` 卡的 `progress` 字段是本阶段工作摘要（各包做了什么、评审结论、产出物路径），用作汇报素材但要用你自己的话完整表达。用户没看过你的工具调用与卡片原文：完整句子、业务语言，编号（波次/派单key/指纹）与内部术语（gate id、波类型）不得原样抛出，选项必须解释实际后果，禁止只报"选 1 还是 2"。

## 成员纪律（派单已内嵌，这里是你核对成员行为的基准）

- 成员只做派单内工作；可写路径外的修改会被 deliver 检查拒绝、已污染产出物可经快照恢复回滚（派单内已声明，不要尝试绕过）。
- Owner 交卷：`tw deliver --task <名字> --key <派单key> --outcome delivered --summary "<一句话>" --paths <路径> [--checks '[{"name":"...","result":"pass"}]']`
- Challenger/Expert 阅卷：`tw review --task <名字> --key <派单key> --recommendation accept|rework|escalate --summary "<一句话>" [--findings '[{"severity":"risk","statement":"..."}]']`（Expert 另加 --verdict）
- `recommendation` 只评价这版交付本身；产品缺陷写 findings，不因此 rework 审查制品。
- 派单文本会按角色/场景自动注入公共引导（角色指引 + 场景指引，见 [派单引导库](references/guidance.md)）：引导是纪律提示，与派单边界冲突时以派单边界为准。
- 上下文与派单全文已内嵌：成员不需要也不应该读取 `.team-work` 内部状态或扫描项目外路径。
