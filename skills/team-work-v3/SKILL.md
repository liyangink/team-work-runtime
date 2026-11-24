---
name: team-work
description: 用 tw CLI（open/dispatch-plan/decide/intent/archive + deliver/review）驱动多智能体研发工作流。用户要求代码审查、方案设计、实现、测试或任何阶段性团队协作时使用；Lead 依据本 skill 判断阶段入口、组团与审查强度。
---

# team-work（v3）

## 成员入口（先识别身份）

已收到带角色、范围与 deliver/review 交付指令的派单时，你是已分配成员：直接遵守本派单和下文「成员纪律」，不执行 Lead 的开任务、拆包或派发正式波次操作。任务总目标是背景，本包完成标准与边界才是你的职责；组合 Challenger/Expert 审本轮已交付包的组合。不得重建整个审查团队或自行再招募八视角团队；已分配的完整检查内容照常完成。

以本轮验收基线独立核验，只要求关闭本轮阻塞；非阻塞建议与范围外发现保留在摘要或已有交付物，扩大需求先获用户明确批准。具体分流、证据与返工纪律见[场景指导](references/scenarios.md#验收基线与意见分流)。

需要辅助时，只就本职责内的限定小问题开 junior 只读助手，可写范围为空、不得继续委托，由你核验整合；它不承担完整审查、不替代 deliver/review、非作者挑战与获派 Expert 的裁决。消息转发也要携带完整职责边界，不把总目标直接复制成助手派单。以下判断与操作指引供 Lead 使用。

房间与门：成员在房间里自由工作（派单内嵌全部上下文），检查只发生在两处——**交付工具调用内**（同步、单次、全量）和**阶段门**（产出物在场、检查通过、非作者评审在场）。你不管理任何运行时状态；任务目录（`.team-work/tasks/<name>/`）就是状态。

## 判断指引（Lead 依据用户语义决定，不由工具强制）

- **验收基线**：用户需求与已批准方案是授权依据；在现有 intent 明确目标、约束、排除项，done 只细化原需求。派单统一携带当前基线，原样转发；改 intent、done 或可写路径不等于扩范围获批，确需扩大授权时先请用户明确决定，细则见场景指导。
- **选入口**：审查请求 → `code-review`；新功能/改动 → `research` 或直接 `implementation`（已有明确方案时）；测试补充 → `test`；方案讨论 → `design`。显式 `--entry` = 任务只运行到该阶段验收；缺省 research = 完整工作流。
- **单任务分包与波次（Lead）**：

  1. **判断**：复杂任务先识别可独立验收、能重叠执行且写范围可分离的部分；安全可拆时优先并行，依赖或写边界不清先澄清或单 Owner 串行，协调成本明显不划算时不强拆；不预设包数。
  2. **计划**：每包明确唯一 Owner、writable（路径:kind，目录保留尾斜杠）、产物和 done；只给必须等待上游交付的包设 dependsOn，并在下游 done 写明要读取的路径。规范路径并核对已知别名，整个计划包括依赖包的写范围均须互斥；共享文件归唯一 Owner，必要时由汇总包写独占最终产物。
  3. **派发**：首次推进前用 tw plan 登记完整分包计划（首卡签发前只返回准备回执）、核对包模型；DSH 用原生 tw-dispatch 推进，终端由调用方投递 dispatch-plan 输出。已在途的同波派单先等待或按返回恢复，不因某一包先交而重复派发下一波。
  4. **组合挑战**：按实际波次，非作者 Challenger 审当时已交付包的组合及接缝；未交付包只是计划，不作为缺交付的返工依据。rework 的 findings 只放本轮需关闭项，逐条带 `disposition:"must-fix"` 与显式 `scope`（整组 `{"kind":"all-covered"}` 或点名 `{"kind":"packages","ids":[...]}`），ids 里的 package 必须准确对应本次已交付且被评审的包；返工目标是 must-fix 范围的并集，不再由省略字段暗示全组，单 Owner 只能 all-covered。发现包名不匹配或返工结果与意见不一致，暂停推进，请原评审者按合法通道核验，不由 Lead 改写结论。
  5. **裁决与汇总**：按实际返回的波次完成评审、裁决及汇总，不自行增减角色。Challenger 的包级返工与 Expert 技术返工（verdict=rework）都按 must-fix 的 scope 并集选择性重派，一条 all-covered 即覆盖本次被审全体。下游/汇总包实际获派后读取已约定的输入；汇总交付后由 Challenger 覆盖新组合，获派裁决时按新鲜度规则重新裁决，保留既有人工门。
  6. **异常与授权**：已审内容发生变化、输入版本不明、写冲突或授权争议时暂停受影响推进；按现有合法流程完成必要复审、重裁和重批，无法确认或没有合法通道则请用户决定。待决用户卡不派发、不轮询、不代答；只读助手不能替代正式成员或审查。
- **角色模型**：默认由策略确定——`tw open` 按 `default.json` 把 owner/challenger/expert 解析成 `ModelRef` 写入 `agents.json.roles`，派发直接读已固化值。仅用户明确指定例外模型时，才用 `tw roles --task <n> --set owner=<provider>/<model>[@<effort>]` 或 `tw plan` 的包级 `model` 写入；缺配置用 `--resolve` 修复。已有会话换模型会出换模型确认卡（保留旧会话 / 重开会话 / 回滚 roles）。配置热变不自动改已有任务。
- **审查强度**：默认正式轻量交叉审查，按本次问题选少量互补视角；各 Owner 聚焦自己的范围，非作者 Challenger 交叉核验，不固定人数或包数。复杂完整代码交付、复杂状态与并发、高失败成本且范围确需全面覆盖，或用户明确要求时，才由 Lead 组织一次完整八视角；跨几个文件或某个敏感点本身不触发八视角。方案审查选需求、取舍、接口、失败恢复等相关方向。返工先查变更及关联视角，新范围或系统风险再重判覆盖。
- **何时升级**：默认自主轮次耗尽后，`tw-dispatch` / `tw dispatch-plan` 会给出 [追加一轮 / 结束任务] 卡片，交用户决定是否追加；不自行增减角色或预测下一波。角色（owner/challenger/裁决者）与模型实例正交——裁决者每轮一个（波次机结构），模型实例由策略和配置决定，见拓扑与成本篇。

场景化的拓扑选择与收敛细节见 **[拓扑与成本](references/topology-and-cost.md)**；审查覆盖与 finding 质量、方案讨论、并行施工、测试协作、用户汇报结构见 **[场景指导](references/scenarios.md)**；DSH 编排层执行团队拓扑（tw-dispatch 波次派发）的规程见 **[DSH 编排](references/dsh-orchestration.md)**；成员卡纪律区与 Lead 呈现要求的来源见 **[规则库](references/rules.md)**：包内锁定的工作流职责 + 可 DIY 规则，Lead 时点指路与工具反吐。

## Lead 操作

DSH 会话内直接调用原生 `tw` 工具（`args` 是 CLI 参数字符串数组）完成 `open/plan/roles/decide` 等；正式波次使用原生 `tw-dispatch`。插件自动注入当前调用的 `TW_DSH_CONFIG` 快照，不要用 shell 拼配置。只有没有 DSH 插件的终端才运行 `tw` CLI；该终端须由调用方显式提供配置快照，缺失则按 unresolved 指引处理。

`tw plan` 原生工具调用示例：外层 `args` 是字符串数组，`--packages` 后是一个 JSON 字符串，其中每包的 `writable`、`done`、`dependsOn` 都是完整数组（方括号不可省，也不能把字符串拆成逐字符）：

```json
{
  "args": [
    "plan",
    "--task",
    "example-task",
    "--packages",
    "[{\"id\":\"draft\",\"writable\":[\"docs/draft.md:design\"],\"done\":[\"完成方案草稿\"],\"dependsOn\":[]},{\"id\":\"merge\",\"writable\":[\"docs/final.md:design\"],\"done\":[\"读取草稿并完成整合\"],\"dependsOn\":[\"draft\"]}]"
  ]
}
```

这两个包没有写 `model`，`tw plan` 会物化为当时的 `roles.owner`；只有用户明确指定例外模型时才在包对象中增加 `model`，值由用户指定。各包写入范围必须互斥，`dependsOn` 只表示真实等待依赖。无插件终端的同一 JSON 可整体作为 `--packages` 的一个参数传入。

```bash
tw open --name <名字> --objective "<目标一句话>" [--entry <stage>]
        [--raw-requirement "<原文>"] [--constraint ...] [--exclusion ...] [--scope-note ...] [--acceptance ...] [--gap '<JSON>']
                                                                    # 开任务并准备意图；首次推进先核对意图，必要时签完整确认卡，重名会拒绝
tw roles --task <名字> [--set owner=<provider>/<model>[@<effort>]] [--clear owner] [--resolve]
                                                                    # 查看/显式修改例外角色模型；默认由策略确定
tw dispatch-plan --task <名字> [--writable <路径>:<kind> ...]        # 推进一步：输出波次派单或 stop 卡；先核对意图，必要时签固定卡；路径以 / 结尾 = 目录授权（如 docs/:doc）
tw run --task <名字>                                                  # 只读查状态：当前状态卡 + 下一步指引（不写任务事实）
tw decide --task <名字> --choice <序号> [--decision-id <卡片ID>] [--note ...]
                                                                    # 按 decisionId 任意审批有效卡片；多张待决卡时缺 ID 会被拒绝并列出全部卡 ID/用途，
                                                                    # 意图卡/刷新卡/包恢复卡必须携带实际向用户展示且被答复的卡 ID；重复相同 ID/选项幂等
tw intent --task <名字> [--objective ...] [--raw-requirement ...] [--add-constraint ...] [--add-exclusion ...] \
          [--acceptance ...] [--scope-note ...] [--add-gap '<JSON>'] [--answer-gap <id> --answer "..."]  # 修订意图（确认卡重签）
tw plan --task <名字> --packages '<JSON: [{id, model?, writable, done, dependsOn}]>'  # 拆包并物化逐包 ModelRef；同内容重复 plan 零写入
                                                                    # （changed:false，不产生 re-planned，也不解除任何 blocked）
tw plan --task <名字> --resolve-blocked '{"package":"<包>","action":"retry","reason":"<用户方向>"}' --blocked-ref <run 卡 blockedPackages 列出的 ref>
                                                                    # 准备按包 package-recovery 恢复卡（action 二选一：'retry' 或 'remove'；单 Owner 省略 package 字段）；
                                                                    # 用户按卡 ID 确认后仅解除所选包；blocked 静止卡以 stop=awaiting-user（next=re-scope、无 decisionId）返回
tw restore --task <名字> --path <路径> [--list | --source <报告@版本>]  # 从该路径最新未作废有效报告恢复原始字节；--list 只读列历史版本；
                                                                    # --source 恢复用户明确选择的历史版本（只写文件，不改当前有效清单）
tw refresh-artifacts --task <名字> [--package <包>] [--paths-json '<完整路径 JSON 数组>'] --reason <说明>
                                                                    # Lead 收到用户明确刷新输入后准备待审基线确认卡；用户按实际 decision-id 确认后才登记新基线
tw retire --task <名字> --wave <wvN> --reason <原因>                  # 作废未结波（仅 Lead）；受影响包整包回退到上一条有效完整清单
tw archive --task <名字>                                              # 用户明确要求归档时
```

- 推进是 dispatch 侧的单一写者。**推进前先核授权争议**：收到未决范围/必要性/修法报告或看到未批准新增方向，停依赖续派，以普通最终消息请用户确认，不为了取卡调 dispatch。没有该争议时，DSH 用原生 `tw-dispatch` 推进/创建/登记，终端用 `dispatch-plan`；按返回卡行动，业务派单原样投递，不改边界。恢复与原卡限制见[范围争议暂停](references/scenarios.md#范围争议暂停)。
- **工具分工**：Lead 用原生 `tw-dispatch` 派发正式波次成员；普通委派、用户指定档位、成员在任务期间开的只读助手用原生 `subagent`，继承历史用 `subagent_fork`。成员辅助须遵守上文成员入口的限定范围与禁止继续委托要求。`@junior|senior|expert` 保留，选档后按当前候选的精确 provider/model 调原生工具，`effort` 转为 `reasoning_effort`，缺档不得猜默认。原生目录未列出模型不代表禁止，可按 provider+model 精确查询；开关、允许列表与旧会话权限由宿主管理。
- **配置来源**：当前 profile 的插件 Config 提供 tiers，只用于 `tw open` 角色初始化、`tw roles --resolve` 与普通委派候选；正式派发直接读任务级 roles / 包级 model，配置热变不自动改已有任务。宿主每次操作传 `TW_DSH_CONFIG` 调用快照；无宿主终端由调用方显式提供 `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}` JSON，缺失时选模明确 unresolved。已派波次沿用 journal 的 `modelRef` 快照；`tw models` 查看当前 entry/profile 来源。
- **续聊与深度**：使用支持续聊的原生后端，返回的 `subagentId` 可用于 `send_message`；参数以当前工具 schema 为准，不补造模式字段，旧版非会话回执不作续聊身份。宿主默认深度 1，正式成员要再开只读助手须用户允许至少两层；不得自行提高上限，助手不得继续委托。
- `tw run` 只读：不确定当前状态时用它查（状态卡 + 下一步指引），不产生任何写入；`tw gate` 只读查门禁。
- `awaiting-user` 卡片出现时任务静止：向用户呈现选项并等待；不要轮询、不要代答。同时有多张待决卡时返回 `pendingDecisions` 全列表（每张含 decisionId、用途、绑定前提与暂时阻碍，多卡时带 `needsDecisionId:true`）：呈现完整列表、按用户实际答复的卡调 `tw decide --decision-id`，不默认队首、不跨卡消费；`staleDecisions` 里的失效卡只能按其原 ID 安全取消或等重签，不能执行旧批准。
- **意图分流与答复**：新任务的 `open/plan/roles/intent` 在首卡签发前只返回内部准备回执。开局和变更用同一判据：用户明确指定且与实际目标、范围、模型和分工吻合、没有信息差时，用 `--user-direction` 报告本次原话与精确覆盖的字段及条目，核对后直接登记；不能把自行补全、纠偏或备注说成用户授权。缺件先修复，已有会话换模型冲突走专用卡。首次**需要确认**时，在任务锁内签发唯一完整意图卡，载有完整分包计划（每包 id/model/writable/done/dependsOn）或未拆包时单 Owner 的首派可写范围与验收。
- **卡面契约**：卡类型按结构化返回识别，不能只看 `question` 标题；原样呈现已签正文及选项，不手工重写。首卡确认后，因意图、角色模型或包字段局部调整重签时，新卡只首屏突出相对最近一次已确认快照的增量变更，未变更项折叠引用完整卡；若中间已有直接授权修订，以包含已登记补充的有效快照为准，不重问已覆盖项。结构化 `intake.diff` 给出 `baseDecisionId`、`baseFingerprint`、`changes`、`unchangedFolded` 与 `unchangedCount`；`intakeFingerprint`（SHA-256）与 `--decision-id` 仍绑定完整快照，增量只是呈现、不放宽确认。没有可核验的完整基准时回退完整卡。
- **答复关联**：按实际展示的卡片及其上下文确定用户所指，将该卡 `decisionId` 原样传给 `tw decide --decision-id`，不能用最新待决卡的 ID 替换。迟到旧卡 ID 返回 `DECISION_STALE`，重新呈现有效卡后再确认。只展示过唯一一张完整卡 A、用户仅回复确认且语境无歧义时，直接按 A 的展示记录取 `decisionId` 调用 `tw decide`，不追问用户复述；多张卡均已展示而无法确定答复所指、或对话记录不完整时，先请用户澄清并暂停决定与派发，不猜。
- 成员通知到达后先核报告；无未决授权争议再推进，有争议先向用户正常最终消息说明方向与风险。普通等待不是 Runtime 已落卡；新用户方向不消费原卡，也不等于轮数/角色模型调整/阶段批准/部署。原作者按当前制品和合法 key 重核，Lead 不代改报告。
- **Lead 规则与表达**：开工先调 `tw help` 读取 `leadGeneralRules`；其他时点按 `leadGeneralRulesSources` 指路。新派发和实际进展只带对应短规则，方案批准、最终验收与技术取舍另带同源审阅短节选；意图卡原样转呈，机械卡不用审阅规则。独立的[公共表达](../clarity-guidance/output-standard.md)与[明晰审阅](../clarity-review/references/review-rules.md)规范保留，不要求重复调用技能。

## 成员纪律（派单已内嵌，这里是你核对成员行为的基准）

- 开工、过程进度和交卷摘要留给正式报告或最终结束语；同 key 已登记就正常结束，不预告、不另发摘要。Lead 主动问询照常答；确需立即纠偏、叫停或处理阻塞，可说明影响和请求。若收到发送前软提示，确需发送可在后续 Step 再发一次。
- 成员只做派单内工作；可写路径外的修改会被 deliver 检查拒绝、已污染产出物可经快照恢复回滚（派单内已声明，不要尝试绕过）。可写条目写目录（尾斜杠）即授权其下全部路径——派单前预估产出文件位置，目录授权比逐文件列举更稳。
- **范围或授权未决**：Owner deliver blocked（paths 留空），报告基线、证据和待确认方向，保留有效制品；Challenger/Expert 按场景详则走评审升级。blocked 以只读 `blockedPackages` 证据展示（包名、blocked 报告 key/version 与摘要），本身不是 decision 卡；用户给出某包明确方向后，由 Lead 准备按包恢复卡（`tw plan --resolve-blocked`），用户按卡确认后仅解除所选包，多包不保证立即全任务暂停；Lead 收到争议先停推进。非空路径不证明授权，不能自行扩权；重派保留原 blocked 原因，细则见场景指导。
- Owner 交卷：`tw deliver --task <名字> --key <派单key> --outcome delivered --summary "<一句话>" --paths <路径1> --paths <路径2> [--checks '<JSON>'] [--unresolved '<JSON>']`——`--paths` 是本包当前阶段的**完整交付清单**，不是本次改动增量：要保留的旧文件必须全部重新列入，未列入即移出本包有效制品（磁盘文件保留待审计，评审/门禁按新清单实时核对字节 SHA-256）。多路径必须**每条重复一次 `--paths`**（如 `--paths docs/a.md --paths docs/b.md`）或用**一个逗号分隔参数**（`--paths docs/a.md,docs/b.md`）；单个 `--paths` 后用空格列多个路径只会收集第一个、其余被静默忽略，会让完整清单漏登——交卷后核对回执 `registered`/`manifest` 列出的路径数与预期一致、复查 `removed` 是否有意外移出，发现遗漏用原 key 重交完整清单。派单正文会列出上一条有效报告的完整路径清单供对照，交付回执同时给出相对上一份的新增/移出。`blocked` 交付 paths 必须为空且不覆盖此前有效清单。
- Challenger/Expert 阅卷：`tw review --task <名字> --key <派单key> --recommendation accept|rework|escalate --summary "<一句话>" [--findings '<JSON>'] [--verdict '<JSON>']`。findings 每项 `{severity, statement, disposition?, scope?}`：返工意见 `disposition:"must-fix"` 必填且显式给 `scope`（整组 `{"kind":"all-covered"}` 或点名 `{"kind":"packages","ids":["包ID"]}`，单 Owner 只能 all-covered；例：`--findings '[{"severity":"blocker","statement":"接缝不一致","disposition":"must-fix","scope":{"kind":"packages","ids":["draft","merge"]}}]'`）；旧 `package`/`packages` 字段会被拒绝并提示替换写法，返工目标 = must-fix 范围并集，`context` 不扩大范围，纯 accept 不得携带 must-fix。Expert 必填完整 verdict `{outcome, rationale, confidence, recommendedAction, risks?}`（Challenger 禁止 verdict），可复制范例：`--verdict '{"outcome":"rework","rationale":"接缝与方案 §4.2 不一致，未按冻结正文对账即声称送达","confidence":"high","recommendedAction":"按 must-fix 范围返工受影响包后重新交付"}'`——outcome 可选 accept|rework|choose-option|need-more-evidence|escalate-to-user，confidence 只能 low|medium|high，rationale/recommendedAction 必须非空，risks 为可选的非空字符串数组；双结论按一致性矩阵校验：accept×accept 合法、accept×rework 合法（按 verdict 返工）、rework×accept 与 escalate×accept/escalate×rework 拒绝，待决类 verdict（choose-option/need-more-evidence/escalate-to-user）不当 accept、返回用户决定。
- `recommendation` 评价这版交付：实施交付违反需求可以返工；审查制品发现产品缺陷应报告，不因此要求审查 Owner 修产品，报告质量缺陷仍可返工。rework 的 findings 只放本轮关闭依据，其他发现放 summary 或已有交付物；详细规则见场景指导。
- 派单纪律区由包内锁定的「工作流职责（TWR 固定契约）」与可 DIY 规则（用户公共目录 `~/.team-work/rules/` 优先、包内默认回退、项目 `team-work/rules/` 追加合并）组成（见 [规则库](references/rules.md)）；规则不改变派单授权和交付合同，项目只能追加不能删除包内默认；规则缺失或读取失败不形成新门禁。
- 上下文与派单全文已内嵌：成员不需要也不应该读取 `.team-work` 内部状态或扫描项目外路径。
- 只读助手经原生工具派发，明确 junior 档与可写范围为空；结果由发起成员核验整合，不登记为正式波次成员。
