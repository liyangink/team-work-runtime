# 拓扑与成本（v3）

## 默认模型由策略确定

默认角色配置及下一波由策略和调用快照决定，Lead 不判断正式派发的档位：[default.json](../../../team-work/policies/default.json) 的 `scenes.*.ownerTier/challengerTier` 与 `roles` 兜底段给出场景默认档（`roles.expert` 缺失即 unresolved），`tw open` 据此把 owner / challenger / expert 解析成具体 `ModelRef{provider, modelName, effort?, family?}` 固化到 `agents.json.roles`；`tw plan` 把每包解析成 `packages.json[].model`。派发直接读 `pkg.model ?? roles[role]`，不在派发期查配置，也不预测下一波。

仅当用户明确指定例外模型时，才用 `tw roles --task <n> --set <role>=<provider>/<model>[@<effort>]` 或 `tw plan` 的包级 `model` 写入；缺配置时按错误指引用 `tw roles --resolve` 修复，不猜默认。`tw roles` 是唯一显式修改入口，写操作会重签意图确认卡，已有会话换模型在下一轮派发出换模型卡。

## 数据从哪读、怎么确认

- **默认档**：`team-work/policies/default.json` 的 `scenes.*.ownerTier/challengerTier` 与 `roles` 兜底段；这是唯一默认档来源，skill 与引导文不再给成本判据。
- **任务角色模型**：`agents.json.roles`。查看 `tw roles --task <n>`；显式改 `tw roles --task <n> --set owner=<provider>/<model>[@<effort>]`；按当前配置重解析 `tw roles --task <n> --resolve`；清除 `--clear owner`。
- **包级模型**：`packages.json[].model`。`tw plan` 入参可给 `model`，或都不给（复用 `roles.owner`）；落盘前一律解析成 `ModelRef`。
- **缺定位**：项目 policy 没有 `roles` 兜底段时，owner/challenger 仍可用场景 `ownerTier/challengerTier`，expert 会 unresolved（选模链不再有字面量默认档）；补齐 `roles` 后 `tw roles --resolve`，或直接 `tw roles --set expert=<provider>/<model>`。缺档时确认卡不提供“确认开始”，派发返回 `ROLES_UNRESOLVED` 及修复指引。
- **确认**：初次推进与变更按同一判据核对用户原话；无信息差的明确指令按实际覆盖值和条目直接登记。确有信息差且需要在首派前确认时，首次 `tw-dispatch`（无插件终端为 `dispatch-plan`）在任务锁内签发唯一完整意图卡。首卡确认后重签的卡只首屏突出相对最近一次已确认快照的增量变更；有直接登记补充时以包含补充的有效基准为准。结构化 `intake.diff` 给出变更条目与未变更折叠标识；`intakeFingerprint` 仍绑定完整快照。原样呈现正文，答复携带实际展示卡的 `decisionId`。只展示过唯一一张完整卡 A、用户仅回复确认且语境无歧义时，直接按 A 的展示记录取 ID 确认，不追问；多张卡均已展示而无法确定答复所指时，先请用户澄清、暂停决定与派发，不猜。已有会话换模型仍用专用卡。
- `effort` 语义：只在配置了合法枚举时保存（如 `high`/`max`/`off`）；不配置就不写该字段——禁止空串与 `"none"`（宿主会拒绝）。卡片与 `tw roles` 显示"省略（不设置）"。

## 角色（与 tw 工具的对应）

- 已收到带角色、范围与交付指令的派单就是成员；不执行 Lead 的开任务、拆包和正式波次派发，不因总目标或八视角目录重建团队。只读助手仅查本职责内的限定小问题，junior、可写为空、不得继续委托，由成员核验整合。
- **Lead**：流程与完整性核对，不做技术裁决；`tw open/plan/dispatch-plan/run 查状态/decide/intent/route` 的调用者，派单的转发者（DSH 内经 tw-dispatch 派发）。
- **Owner**：唯一范围与制品负责人；`tw deliver` 交付，回应轮 = 同路径原地修订或证据反驳。
- **Challenger**：非作者攻击事实/推理/边界/失败路径；只出 findings 与 recommendation，不改制品；组合评审的 findings 标包归属。
- **Expert（裁决者）**：获派裁决波时作技术裁决；`tw review --verdict`；制品变化强制重新裁决（新鲜度）。

各角色共享本轮验收基线。Owner 独立核验并可证据反驳；Challenger 的 rework findings 只放本轮关闭依据，其他发现保留在摘要或已有交付物；Expert 区别技术风险与修复授权，扩大需求由 Lead 先请用户决定。详细分流见[场景指导](scenarios.md#验收基线与意见分流)。

审查默认正式轻量交叉：一个 Owner 与非作者 Challenger 从相关互补视角工作。交叉视角不要求一视角一包；Lead 仅在范围确需独立交付时拆包。完整八视角由 Lead 按实际复杂度、失败成本与用户要求组织一次，返工先复核变更及关联视角；覆盖范围是语义判断，不由 Runtime 自动决定。

## 并发与多样性事实

- 是否存在裁决波由策略与 Runtime 决定；Lead 按 `tw-dispatch` / `dispatch-plan` 实际返回的波次推进和汇报，不预测下一波、不自行增减角色；
- 并行成员数 = 当波包数（由拆包与依赖决定）；policy 里的并发/限额字段本轮不接线，不作为运行时约束或文档承诺；
- 每档候选池来自当前 profile 的 `team-work-dsh.tiers`：同一 profile 的项目共用，无项目覆盖；兼容单对象或数组，provider/model 必填，family 与 effort 可选。家族去重只发生在 `tw open` 的角色初始化（每个角色选一个候选）；配置热变不自动改已有任务，`tw roles --resolve` 才重解析。任务 `agents.json` 只保存 mappings 与 roles，派发事实的 `modelRef` 快照在 journal；
- 无宿主终端由调用方通过 `TW_DSH_CONFIG` 显式提供 `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}` JSON，不读旧 YAML 或项目 `dsh.json`；`tw models` 显示来源；
- 普通选档委派、只读助手和 `@` 候选使用原生工具，tiers 的 effort 转为 `reasoning_effort`。枚举目录不等于允许名单，目录未列出时可按 provider+model 精确查询；正式波次由 `tw-dispatch` 创建前交宿主核验精确模型；
- 遇高风险事实冲突时走既有升级通道（Challenger escalate / Expert escalate-to-user）请用户方向，不虚构"临时加裁决者"或自行换档路径。

## 三轮收敛

三轮上限不是范围争议的升级起点。争议在新制品/修补前按[场景详则](scenarios.md#范围争议暂停)暂停；Challenger escalate/Expert escalate-to-user 请求用户方向，不自动升模型。成本不能强迫 accept，rework 不能授权扩建，追加一轮只授权预算，不批准范围；不为此新增角色或轮次。

明晰表达只随 Lead 卡片的同源反吐段出现，成员卡不再有独立明晰块，不增加文案角色或审查轮次；独立技能可单独使用，不要求在 TWR 双调用。短段送达成本与模型档位分开核对，规则装载缺失不改变角色模型或人工门，见[规则库](rules.md#lead-通道skill-指路与工具反吐)。

每轮都有挑战者：Owner 产出 → Challenger 可验证问题 → Owner 独立核验修订或反驳；获派 Expert 时作技术裁决。复审先查阻塞关闭及修改回归，已关闭事项无新证据不重开；第三轮聚焦关闭条件与残余风险。新重大问题仍可提出，须说明证据与本轮关系，不能以轮次或成本强行接受缺陷。展示轮号不变，已有效交付的人工授权返工不占自主额度。待返工包耗尽额度才出 [追加一轮 / 结束任务] 卡片；追加只授权卡上列出的耗尽包各做下一轮，不替代任何范围或制品批准。
