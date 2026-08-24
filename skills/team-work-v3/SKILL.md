---
name: team-work-v3
description: 用 tw CLI（open/run/decide/intent/archive + deliver/review）驱动多智能体研发工作流。用户要求代码审查、方案设计、实现、测试或任何阶段性团队协作时使用；Lead 依据本 skill 判断阶段入口、组团与审查强度。
---

# team-work（v3）

房间与门：成员在房间里自由工作（派单内嵌全部上下文），检查只发生在两处——**交付工具调用内**（同步、单次、全量）和**阶段门**（产出物在场、检查通过、非作者评审在场）。你不管理任何运行时状态；任务目录（`.team-work/tasks/<name>/`）就是状态。

## 判断指引（Lead 依据用户语义决定，不由工具强制）

- **选入口**：审查请求 → `code-review`；新功能/改动 → `research` 或直接 `implementation`（已有明确方案时）；测试补充 → `test`；方案讨论 → `design`。显式 `--entry` = 任务只运行到该阶段验收；缺省 research = 完整工作流。
- **是否组团**：单一明确产出且改动面小 → 单 Owner + 一位 Challenger；真正并行且可写范围可互斥拆分的工作才开多任务并行。
- **审查强度**：默认轻量；安全敏感、跨模块、用户点名严格、生产缺陷复盘时要求完整八视角。
- **何时升级**：两轮未收敛 → 第三轮 Expert 裁决；三轮耗尽 → [追加一轮 / 结束任务] 卡片交用户。

场景化的拓扑选择、成本分档与收敛细节见 **[拓扑与成本](references/topology-and-cost.md)**；代码审查八视角与 finding 质量、方案讨论、并行施工、测试协作、用户汇报结构见 **[场景指导](references/scenarios.md)**；DSH 编排层执行团队拓扑（dispatch-plan → agent 派发）的脚本模板见 **[DSH 编排](references/dsh-orchestration.md)**。

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

## 成员纪律（派单已内嵌，这里是你核对成员行为的基准）

- 成员只做派单内工作；可写路径外的修改会被平台沙箱与 deliver 检查双重拒绝。
- Owner 交卷：`tw deliver --task <名字> --key <派单key> --outcome delivered --summary "<一句话>" --paths <路径> [--checks '[{"name":"...","result":"pass"}]']`
- Challenger/Expert 阅卷：`tw review --task <名字> --key <派单key> --recommendation accept|rework|escalate --summary "<一句话>" [--findings '[{"severity":"risk","statement":"..."}]']`（Expert 另加 --verdict）
- `recommendation` 只评价这版交付本身；产品缺陷写 findings，不因此 rework 审查制品。
- 上下文与派单全文已内嵌：成员不需要也不应该读取 `.team-work` 内部状态或扫描项目外路径。
