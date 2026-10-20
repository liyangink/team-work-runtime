---
name: team-work
description: 用 tw CLI（open/dispatch-plan/decide/intent/archive + deliver/review）驱动多智能体研发工作流。用户要求代码审查、方案设计、实现、测试或任何阶段性团队协作时使用；Lead 依据本 skill 判断阶段入口、组团与审查强度。
---

# team-work（v3）

## 成员入口（先识别身份）

已收到带角色、范围与 deliver/review 交付指令的派单时，你是已分配成员：直接遵守本派单和下文「成员纪律」，不执行 Lead 的开任务、拆包或派发正式波次操作。任务总目标是背景，本包完成标准与边界才是你的职责；组合 Challenger/Expert 审本轮已交付包的组合。不得重建整个审查团队或自行再招募八视角团队；已分配的完整检查内容照常完成。

以本轮验收基线独立核验，只要求关闭本轮阻塞；非阻塞建议与范围外发现保留在摘要或已有交付物，扩大需求先获用户明确批准。具体分流、证据与返工纪律见[场景指导](references/scenarios.md#验收基线与意见分流)。

需要辅助时，只就本职责内的限定小问题开 junior 只读助手，可写范围为空、不得继续委托，由你核验整合；它不承担完整审查、不替代 deliver/review 与非作者挑战、核心 Expert 裁决。消息转发也要携带完整职责边界，不把总目标直接复制成助手派单。以下判断与操作指引供 Lead 使用。

房间与门：成员在房间里自由工作（派单内嵌全部上下文），检查只发生在两处——**交付工具调用内**（同步、单次、全量）和**阶段门**（产出物在场、检查通过、非作者评审在场）。你不管理任何运行时状态；任务目录（`.team-work/tasks/<name>/`）就是状态。

## 判断指引（Lead 依据用户语义决定，不由工具强制）

- **验收基线**：用户需求与已批准方案是授权依据；在现有 intent 明确目标、约束、排除项，done 只细化原需求。派单统一携带当前基线，原样转发；改 intent、done 或可写路径不等于扩范围获批，确需扩大授权时先请用户明确决定，细则见场景指导。
- **选入口**：审查请求 → `code-review`；新功能/改动 → `research` 或直接 `implementation`（已有明确方案时）；测试补充 → `test`；方案讨论 → `design`。显式 `--entry` = 任务只运行到该阶段验收；缺省 research = 完整工作流。
- **是否组团**：单一明确产出且改动面小 → 单 Owner + 一位 Challenger；目标含多个可独立验收的垂直范围且可写范围能互斥拆分 → `tw plan` 拆包（**定包 tier：默认 junior**——廉价档胜任绝大多数常规作业，审查链兜底；仅按失败成本升档：错误难发现/返工贵 → senior，不可逆/安全敏感 → expert——依据见拓扑与成本篇；高于场景默认档会触发用户升档审批卡；成员执行中力有不逮可经 unresolved 上抛建议升档）；多包 = 并行 owner 波 + 组合评审 + findings 包归属选择性重派；汇总包=整合 Owner，完成标准须含合并/解冲突/不丢信息）；拆分语义质量归你把关，runtime 只验互斥/无环/完成标准。
- **risk 档**：不可逆/数据迁移/安全敏感/核心跨模块 → `--risk critical`（未显式定 tier 的包兜底升 expert 且免审批；包级判断仍以 tw plan 的显式 tier 优先）；较高风险 → `high`；常规缺省 normal。
- **审查强度**：默认正式轻量交叉审查，按本次问题选少量互补视角；一个 Owner 聚焦改动，非作者 Challenger 交叉核验，核心 Expert 照旧，不固定人数或包数。复杂完整代码交付、复杂状态与并发、高失败成本且范围确需全面覆盖，或用户明确要求时，才由 Lead 组织一次完整八视角；跨几个文件或某个敏感点本身不触发八视角。方案审查选需求、取舍、接口、失败恢复等相关方向。返工先查变更及关联视角，新范围或系统风险再重判覆盖。
- **何时升级**：两轮未收敛 → 第三轮 Expert 裁决（角色=裁决波）；三轮耗尽 → [追加一轮 / 结束任务] 卡片交用户。角色（owner/challenger/裁决者）与档位（junior/senior/expert 预算）正交——裁决者每轮一个（波次机结构），expert 档的 owner 包完全正常，见拓扑与成本篇。

场景化的拓扑选择、成本分档与收敛细节见 **[拓扑与成本](references/topology-and-cost.md)**；审查覆盖与 finding 质量、方案讨论、并行施工、测试协作、用户汇报结构见 **[场景指导](references/scenarios.md)**；DSH 编排层执行团队拓扑（tw-dispatch 波次派发）的规程见 **[DSH 编排](references/dsh-orchestration.md)**；派单内按角色/场景自动注入的公共引导库见 **[派单引导库](references/guidance.md)**。

## Lead 操作

```bash
tw open --name <名字> --objective "<目标一句话>" [--entry <stage>]   # 开房间；重名会拒绝并提示
tw dispatch-plan --task <名字> [--writable <路径>:<kind> ...]        # 推进一步：输出波次派单或 stop 卡；路径以 / 结尾 = 目录授权（如 docs/:doc）
tw run --task <名字>                                                  # 只读查状态：当前状态卡 + 下一步指引（不写任务事实）
tw decide --task <名字> --choice <序号> [--note ...]                 # 回答当前卡片
tw intent --task <名字> [--objective ...] [--add-constraint ...]     # 随时修订目标/约束
tw archive --task <名字>                                              # 用户明确要求归档时
```

- 推进是 dispatch 侧的单一写者。**推进前先核授权争议**：收到未决范围/必要性/修法报告或看到未批准新增方向，停依赖续派，以普通最终消息请用户确认，不为了取卡调 dispatch。没有该争议时，DSH 用 `tw-dispatch` 开单/创建/登记，终端用 `dispatch-plan`；按返回卡行动，业务派单原样投递，不改边界。恢复与原卡限制见[范围争议暂停](references/scenarios.md#范围争议暂停)。
- **工具分工**：Lead 用 `tw-dispatch` 派发正式波次成员；普通委派、用户指定档位、成员在任务期间开的只读助手用原生 `subagent`，继承历史用 `subagent_fork`。成员辅助须遵守上文成员入口的限定范围与禁止继续委托要求。`@junior|senior|expert` 保留，选档后按当前候选的精确 provider/model 调原生工具，`effort` 转为 `reasoning_effort`，缺档不得猜默认。原生目录未列出模型不代表禁止，可按 provider+model 精确查询；开关、允许列表与旧会话权限由宿主管理。
- **配置来源**：当前 profile 的插件 Config 提供 tiers，同一 profile 跨项目共享且无项目覆盖。宿主每次操作传 `TW_DSH_CONFIG` 调用快照；无宿主终端由调用方显式提供 `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}` JSON，缺失时选模明确 unresolved。已派波次沿用 journal 精确模型快照；`tw models` 查看当前 entry/profile 来源。
- **续聊与深度**：使用支持续聊的原生后端，返回的 `subagentId` 可用于 `send_message`；参数以当前工具 schema 为准，不补造模式字段，旧版非会话回执不作续聊身份。宿主默认深度 1，正式成员要再开只读助手须用户允许至少两层；不得自行提高上限，助手不得继续委托。
- `tw run` 只读：不确定当前状态时用它查（状态卡 + 下一步指引），不产生任何写入；`tw gate` 只读查门禁。
- `awaiting-user` 卡片出现时任务静止：向用户呈现选项并等待；不要轮询、不要代答。
- 成员通知到达后先核报告；无未决授权争议再推进，有争议先向用户正常最终消息说明方向与风险。普通等待不是 Runtime 已落卡；新用户方向不消费原卡，也不等于轮数/升档/阶段批准/部署。原作者按当前制品和合法 key 重核，Lead 不代改报告。
- **自动表达规则**：成员的 `requiredGuidance` 与 Lead 卡片的 `presentation` 自动带入根包同源必读段，以现有 `progress` 为素材，不要求主动调用 clarity 技能。公共规范见[明晰表达](../clarity-guidance/output-standard.md)，人工决定/阻塞的专项见[明晰审阅](../clarity-review/references/review-rules.md)；深看按工具给出的准确路径，不读取独立账本。

## 成员纪律（派单已内嵌，这里是你核对成员行为的基准）

- 成员只做派单内工作；可写路径外的修改会被 deliver 检查拒绝、已污染产出物可经快照恢复回滚（派单内已声明，不要尝试绕过）。可写条目写目录（尾斜杠）即授权其下全部路径——派单前预估产出文件位置，目录授权比逐文件列举更稳。
- **范围或授权未决**：Owner deliver blocked（paths 留空），报告基线、证据和待确认方向，保留有效制品；Challenger/Expert 按场景详则走评审升级。无其他可派波时才有 re-scope（非 decision），多包不保证立即全任务暂停；Lead 收到争议先停推进。用户明确必要性/授权后按单包 writable 或多包 plan 原通道恢复，非空路径不证明授权，不能自行扩权；重派保留原 blocked 原因，细则见场景指导。
- Owner 交卷：`tw deliver --task <名字> --key <派单key> --outcome delivered --summary "<一句话>" --paths <路径> [--checks '[{"name":"...","result":"pass"}]']`
- Challenger/Expert 阅卷：`tw review --task <名字> --key <派单key> --recommendation accept|rework|escalate --summary "<一句话>" [--findings '[{"severity":"risk","statement":"..."}]']`（Expert 另加 --verdict）
- `recommendation` 评价这版交付：实施交付违反需求可以返工；审查制品发现产品缺陷应报告，不因此要求审查 Owner 修产品，报告质量缺陷仍可返工。rework 的 findings 只放本轮关闭依据，其他发现放 summary 或已有交付物；详细规则见场景指导。
- 派单按角色/场景带专业引导与同源明晰短段（见 [派单引导库](references/guidance.md)）；专业引导项目覆盖不替换包规范源，不改变派单授权和交付合同。规则缺失诊断不形成新门禁。
- 上下文与派单全文已内嵌：成员不需要也不应该读取 `.team-work` 内部状态或扫描项目外路径。
- 只读助手经原生工具派发，明确 junior 档与可写范围为空；结果由发起成员核验整合，不登记为正式波次成员。
