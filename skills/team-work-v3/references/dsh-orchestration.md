# DSH 编排：Lead 派发操作规程（DSH 0.2.0-rc.2 / 0.2.1-rc.2）

本篇的开任务、拆包与正式波次派发操作仅供 Lead。已收到角色、边界与 deliver/review 指令的成员按本派单执行，不重建审查团队。成员可用原生工具就本职责内的限定小问题开 junior 只读助手，消息带完整范围、可写为空与禁止继续委托的要求；不复制总目标，不派完整审查团队，由发起者核验整合结果。

正式成员需要可续聊的子会话：Owner 修订、Challenger 复审、Expert 重裁都由 `tw-dispatch` 创建或恢复。普通委派使用原生 `subagent`，继承父历史用 `subagent_fork`。需要续聊时使用支持续聊的原生后端；返回的 `subagentId` 是会话 ID，可直接用于 `send_message`。参数以当前工具 schema 为准，不补造模式字段；旧版非会话回执不作续聊身份。

原样投递 Runtime 业务派单，两种正文都已带当前验收基线；绑定层只选变体，不改业务条件。成员消息是单块业务正文：派单卡纪律区已含包内锁定的「工作流职责」与规则库条目，绑定层不再追加规则 text 块或缺失诊断。Lead 的呈现由返回卡 `presentation` 反吐 `team-work/rules/lead/<时点>/` 规则与根包明晰必读段，无需主动调 clarity 技能；Lead 规则指路见下节，独立入口可依宿主选源，TWR 规则固定来自根包，见[规则库](rules.md)。intent/done/可写目录不授权扩需求，变更仍经用户明确批准及原人工门/SPEC；分流见[场景指导](scenarios.md#验收基线与意见分流)。

## 波次推进：一律 tw-dispatch

**无未决范围/必要性/修法授权争议时，用 `tw-dispatch`（{ task, note?, writables? }）推进**；收到争议先按[场景详则](scenarios.md#范围争议暂停)普通最终消息请用户方向，不为取卡继续派发。单次正常调用完成一个波次：

1. 内部子进程调 `tw dispatch-plan --task <名> --json`（writables 透传）推进到派发点或 stop；
2. 波次机不在派发点时（awaiting-user / completed / blocked / archived 卡，含拒绝卡）**原样透传卡片**，不创建任何子代理——Lead 按卡片行动；wait-inflight 卡是唯一例外：按条目自动兜底处置（见 stop 处理节）；
3. 在派发点时对每张派单先登记 dispatchKey→确定性 sessionId（从任务名和派单 key 推导），再按 wave.modelRef 的精确 provider/modelName/effort 创建成员（绑定层 toHostTarget 映射成宿主字段），不重选档位、不在派发期查配置。重试先核对同 ID：同父活会话等待；同父冷会话读取自身事件后通过宿主 `sendMessage` 续投；异主拒绝接管；确实无记录才同 ID 重建。读取不确定时保留映射并返回恢复指引，不把未知当不存在。标签由派单事实自动拼接。

返回逐项结果 `[{key, sessionId, provider/model/effort, 标签, registered}]`。单张失败不回滚已成功项，按该项 message 的指引恢复（登记失败可用 tw agent-map 补登记；勿重复创建，避免重复派单）。

创建后的持久化确认失败不等于未创建：保留 sessionId 与映射，先核对同 ID 现状。防重复创建不承诺正文跨中断恰好投递一次；回执丢失或读取不确定时不要另建成员或自动重复投正文。

Lead 在报告到达后先核未决授权争议，无争议才继续 tw-dispatch；不能以循环推进代替及时请用户方向。tw run 只读查状态，不签卡；普通等待不等于 Runtime 已落卡，已签卡仍需原卡语义处理。用户范围确认不等于 extra-round，不自行加轮或改 choices/grant；无 DSH 插件时按相同纪律使用 dispatch-plan。

工具分工以工作用途区分；任务期间开的助手仍属于普通委派：

| 情境 | 工具 |
| --- | --- |
| Lead 正在推进 team-work 任务（派波次成员/推进一步） | tw-dispatch |
| 普通委派：只读子派单、用户 @档位、并行调查、成员内部助手等 | 原生 subagent / subagent_fork |
| 主动追问已有子会话 | 原生 send_message |
| 任务簿记：决定、门禁查询、交付、评审、补登记 | tw |

## Lead 规则通道（help 读取 + 工具反吐）

Lead 不读成员派单：开工先调 `tw help`，返回的 `leadGeneralRules` 即 Lead 通用 README 正文（职责边界、推进、判断升级与汇报纪律；运行时按 用户公共 `~/.team-work/rules/` → 包内出厂默认 → 项目 `team-work/rules/` 三层合并解析，不从技能目录猜包根相对路径，也不依赖 cwd）；具体时点规则以派发/决定/进展返回卡 `presentation` 反吐的 `lead/<时点>/` 为准，其他时点按 `leadGeneralRulesSources` 给出的来源线索主动读取对应层文件。同时，`tw` 与 `tw-dispatch` 在决定点、派发与在途、进展三个时点把对应 `lead/<时点>/` 规则与明晰必读段附到返回卡 `presentation`（决定点加审阅段）；时点判定与现有呈现判定一致，机械回执不命中，终态重复查询每次在场。两通道互补：反吐不依赖主动性但只在三个时点触发，help/主动读覆盖其他时点。改措辞改 md，不改代码。

## 续派：宿主 sendMessage（Lead 主动追问用 send_message）

- continuation=true 且有 expectedAgentId：先登记本轮 key 到原成员会话，再按宿主会话状态逐项对账（是否已创建、是否收到本轮正文，唯一以该 sessionId 对应的宿主会话与收单日志核验，不把"登记了映射"当成"消息已送达"；live 会话对象本身不证明旧轮仍在运行）。同父活会话不重投正文：收单日志**完整可靠且确认已收本轮冻结正文**才是健康在途（wait-children）；只见旧轮正文或不能证明本轮已收时，**仅在可靠证明旧轮仍在运行且完成通知可达**的前提下返回 wait-prior-turn（等原轮结束、本轮未送，有可靠通知时正常结束回合，不轮询）；证明不了旧轮活动或通知不可达时返回 recover 按恢复卡处置——两种结果都不得声称本轮已送达。同父冷会话：收单日志**完整可靠**（读取不截断、不失败）、**排除同 key 不同正文冲突**、且补投正文经 **`promptFrozen:true` 证明来自 journal 冻结版本**、并**重算正文 SHA-256 与导出的 `promptDigest`/`promptFullDigest` 一致**（Runtime 对冻结摘要只做 64 位 hex 格式校验后原样导出、不重算比对，损坏账本可能写入与正文不匹配的摘要；重算不符或摘要缺失时该正文不可证明为原发版本）时才按日志分支行动——已有本轮精确派单正文则只发轻量续行提醒，只有旧轮上下文则投冻结的本轮增量，无任何上下文则投全量变体（两种正文均含当前基线）；`promptFrozen:false` 或字段缺失时的正文是 Runtime 按当前任务/规则状态**现场重建**的，热更后可能已与原发送不同。日志不完整、收单不确定、同 key 内容冲突、重算摘要不符或正文不可证明为原发版本时一律 recover（保留原 ID，列 sessionId、key、原因与核对路径），不凭重建文本及其摘要补投。异主由原 Lead 继续或作废该波再派；确实断链才按本波 modelRef 新建，投全量变体并回填映射。查询、读取或回执不确定时按 recover 错误卡恢复，不自动换 ID、不另建成员、不无证重投；
- 用户点名换人（replace-owner）：走 fresh 重建通道（按本波 modelRef 新建并回填映射）。映射缺失（`expectedAgentIdMissing` + resumeNote）：**不得仅凭映射缺失推定旧会话不存在、覆盖旧 ID 或直接 fresh 重建**（可能制造重复写者）——先核对宿主会话与登记事实，仅在可靠证明原会话活/冷均不存在且不会再执行时才同 ID fresh 重建并回填映射，状态不确定时保持 recover。

初派、增量、全量、重建和冷轻提醒都投单块业务正文；冷收单按整块文本精确匹配，规则变更随正文一起投递，但不为刷新规则催活 live 会话。角色/场景业务正文真的改变时沿原算法，不承诺总是轻提醒。live 零消息，不为刷新规范催单；缺资源诊断保留恢复指引，不以内置备用长规则或新门禁替代。

## 评审修订纪律（D5）

challenger/expert **同 key 重交修订版**（覆盖旧报告）后必须主动通知 Lead，Lead 重新 tw-dispatch 取波再转发——已按旧版意见派出的 respond 波不会自动更新依据。汇总包的完成标准应含"冲突归并"兜底（两版意见以修订版为准）。

## stop 处理（tw-dispatch 透传卡片后按型行动）

- stop: awaiting-user：先看卡片类型——**意图确认卡**（结构化返回含 `decisionId` 且 choices 含 `accept-intake`；不要只按 `question` 标题识别——首卡标题为"# 任务意图确认（intake-approval）"，已确认后的增量卡标题为"# 任务意图变更确认"，基线缺失回退卡会先输出提示再接完整卡标题）：按形态分别呈现——首卡（`intake.diff` 与 `diffBaselineUnavailable` 均缺省）完整呈现原始需求、目标/约束/排除、范围与产出、三个角色模型、完整分包计划（每包 id/model/writable/done/dependsOn）或未拆包时的单 Owner 首派可写范围与验收、gap；增量重签卡（`intake.diff` 在场）只呈现 `intake.diff.changes` 的增量变更项（`kind` 新增/删除/修改，含字段路径与旧 → 新值），标明基准卡 `baseDecisionId`，未变更项按 `unchangedCount` 折叠引用，不逐项重展完整卡；基线缺失回退卡（`diffBaselineUnavailable` 在场）完整呈现全部字段并转述"最近已确认卡缺少可核验快照，本次展示完整卡作为新基线"。卡面带唯一 `decisionId`，答复按当前展示的卡把该 ID 透传给 `tw decide --decision-id`（新版意图卡必须携带；迟到旧卡 ID 会被拒绝并提示重新查看最新卡）；结构化 `intake.diff` 含 `baseDecisionId`/`baseFingerprint`/`changes`/`unchangedFolded`/`unchangedCount`；底层 `intakeFingerprint`（SHA-256）与 `--decision-id` 仍绑定完整快照。答复关联：只展示过唯一一张完整卡 A、用户仅回复确认且无歧义时，直接按 A 的展示记录取 `decisionId` 调用 decide，不追问复述；多张卡均已展示而无法关联时先请用户澄清，暂停决定与派发，不猜；**换模型确认卡**（`requiresFreshSession` 在场，choices 为 保留原会话/作废当前波并重开会话/回滚 roles）：已有会话不可热替换模型，按用户选择作答；**人工门卡**（choices 为 accept/rework）：向用户呈现，答案走 tw decide——批准前 Runtime 会实时核对登记清单的磁盘字节 SHA-256，磁盘与摘要不一致时拒绝且不写决定、卡保留待决；**刷新待审基线卡**（kind=artifact-refresh）：呈现旧清单 → 新完整清单、各路径字节 SHA、增删与原因，用户按实际 decision-id 确认或取消——确认只是把当前磁盘字节登记为 Lead 来源待审基线，不代表评审或人工门通过，旧评审与人工门指纹失效须重新走；**按包恢复卡**（kind=package-recovery）：呈现目标包、blocked 引用与候选动作（retry|remove），确认后仅解除该包 blocked。多张待决卡并存时卡片带 `pendingDecisions` 全列表与 `needsDecisionId:true`：向用户呈现完整列表、按实际答复的卡调 `tw decide --decision-id`，不默认队首、不跨卡消费；`staleDecisions` 中的失效卡只能按其原 ID 安全取消或等重签，不能执行旧批准；**blocked 静止卡**（`next:"re-scope"`、无 decisionId/choices——不是 decision 卡）：向用户呈现 `blockedPackages` 证据（包名、blocked 报告 key/version 与摘要 ref）与 reason，涉及必要性/授权争议先请用户确认，不能将恢复提示当自行修复/扩权许可；用户给出某包明确方向后，用 `tw plan --task <名> --resolve-blocked '{"package":"<包>","action":"retry","reason":"<用户方向>"}' --blocked-ref <blockedPackages 列出的 ref>` 准备 package-recovery 卡（action 二选一：'retry' 或 'remove'，字面写 "retry|remove" 会被拒绝；单 Owner 省略 package 字段），用户按卡 ID 确认后仅解除所选包（retry 确认后再携新可写范围经 tw-dispatch 重派）。携带候选计划（`--packages`）的恢复若触发意图确认重签，恢复事实先待确认：先让用户确认重签的意图卡，再按恢复卡 ID 决定，确认前不解除 blocked 或派发。awaiting-user 期间任务静止（不轮询、不代答、不越门）；
- stop: wait-inflight：tw-dispatch 逐条核对已登记或可续会话，按上述活/冷/异主/不存在四种现状恢复。未登记的派单先登记确定性 ID 再补派；缺 registered 判定字段（`registeredUnresolved` 在场——值为账本错误原因字符串，账本损坏时 Runtime 不猜空映射）或读取不确定时不自动补派，按卡片指引修复。agents.json 缺失或损坏时 Runtime 返回 `AGENTS_STATE_CORRUPT` 且**不修改、不重建**：保留原文件与已知 sessionId，先核对宿主恢复可验证的登记事实或从可信备份恢复账本，无法证明时保持 recover；账本修复后才可用 tw agent-map 登记（agent-map 对损坏账本同样拒绝，不能当自愈通道）；`modelRef` 不可解析且该波不应执行时用 tw retire 作废；
- stop: completed：问用户是否 tw archive；
- stop: blocked（兜底分支）：核 card.blockers 与 recovery 修复指引并按指引处理后重推。Owner 的 blocked 静止卡不落在这个分支——它以 **stop: awaiting-user**（`next:"re-scope"`、无 decisionId 的非决定卡）返回，处置见上一条的 blocked 静止卡说明。

## 作废未结波（tw retire）

- 触发：wait-inflight 卡或 dispatch-plan 输出中的未结波需要放弃时——如派错人、该波不再需要、迁移冲突已选保留版本等。waveId 直接取自卡内字段（P4：运行期卡自带 waveId，不手工编造）；
- 执行：`tw retire --task <名> --wave <wvN> --reason <原因>`（**仅 Lead**；reason 必填，写入 journal 的 `dispatch-superseded` 事件供审计）；
- 语义：**作废整波**（波内部分成员已交付也整体作废）：该波所有报告整体忽略、不进评审链与后续推导（投影/快照/依赖/轮次耗尽/续派回溯统一排除作废波）；全部成员均已交付的已结波不能 retire；该波 key 再被 deliver/review 会拒绝并提示「重新 tw-dispatch 取新卡」；
- 幂等矩阵：重复 retire 幂等返回；未知 waveId / 已结波 / 缺 reason 拒绝并附恢复指引（拒绝输出带当前未结波清单）；
- 后续：retire 后受影响包自动回到该包上一条未作废 delivered 报告的**完整清单**（无上一条则未交付），波次机按剩余活跃包推进；回退只改变有效基线、不改写工作区——作废波曾把 X1 改成 X2 时，后续评审/门禁的实时字节核验会发现磁盘 X2 与回退基线 X1 不一致并阻止通过，用 tw restore 恢复旧字节或走授权刷新；历史报告与快照保留审计。重新 tw-dispatch 派新 Owner 前**必须先证实旧成员已停止写文件或其写权限已撤销**：仅拒绝旧 key 的迟到报告不能阻止旧成员继续写工作区；未证实前不得向与旧成员重叠的可写范围派发新 Owner，无法证明时保留旧事实与文件并请用户人工核对。retire 与推进并发由任务锁串行化，但任务锁只保证任务事实一致，不是工作区写者隔离。

## 基线恢复（tw restore 与 tw refresh-artifacts）

- `tw restore --task <名> --path <路径>`：默认从该路径**最新未作废有效报告**的快照恢复原始字节（快照先验摘要再写回）；`--list` 只读列出可验证的非作废历史版本；`--source <报告@版本>` 恢复用户明确选择的历史版本。恢复历史只写文件、不改当前有效清单——字节异于当前基线时后续门禁仍不通过。会覆盖工作区，先由用户明确选择并保留需要的修改。
- `tw refresh-artifacts --task <名> [--package <包>] [--paths-json '<完整路径 JSON 数组>'] --reason <说明>`：收到用户明确的刷新输入后准备 `artifact-refresh` 确认卡（不改基线）：展示旧清单、新完整清单、各路径磁盘字节 SHA-256（sha256-bytes-v1）与增删、原因。多包必须显式选一个包，不能自动扩大；无可验证有效报告时必须显式给全量 paths-json，不扫描目录猜测；超出已批准可写范围或缺意图确认时拒绝并给修复指引。用户按实际展示的 decision-id 调 `tw decide` 确认后，该决定、Lead 来源新基线报告与受影响旧门的作废在**一次 journal 原子提交**内生效；确认前清单/字节再变化会让本卡失效重签。刷新报告来源标记 user-authorized-lead-refresh、参与"最新未作废 delivered 报告"选择，但不充当 Owner 新一轮派单；刷新后旧 Challenger、Expert 与人工批准指纹失效，须重新评审与确认。该入口只登记用户确认的当前磁盘字节为待审基线：不替 Owner 写文件、不声称技术正确、不代替评审或人工批准。
- 评审、Expert 裁决、人工门与阶段推进都会按报告快照逐文件实时核对磁盘原始字节 SHA-256（sha256-bytes-v1，区别于旧的文本规范化摘要）；磁盘缺失、不可读或摘要不一致时同步拒绝并列出路径、期望/实际摘要与恢复指引——恢复边即上述 restore（恢复有效快照）或授权刷新（登记当前字节），不存在独立"作废文件待修复"账本。

## 拆包（tw plan）

- 判断要不要拆：目标含多个可独立验收的垂直范围且可写范围能互斥拆分才拆；共享热点收进一个包或设 dependsOn 汇总包；拆分粒度以"子 agent 高注意力"为准（每包一个清晰交付物）；拆分语义质量由 Lead 把关（runtime 只验机械属性：互斥/无环/完成标准在场）；
- writable 条目路径以 / 结尾 = 目录授权（如 "review/:code-review" 授权 review/ 下全部文件，deliver 与互斥判定都按目录前缀处理）；目录与其下路径视为重叠，不能分给两个包；
- dependsOn 汇总包 = 整合 Owner：完成标准必须含"合并各包结论、解决冲突、不丢信息"；
- 登记：tw plan --task <名> --packages '<JSON>'（形状 [{id, model?:{provider,modelName,effort?}, writable:["路径:kind"], done:["标准"], dependsOn:["包id"]}]）。每包在落盘前解析成 `model:ModelRef`：显式 model 直接采用，都不给则复用 `roles.owner`；解析失败返回 PLAN_MODEL_UNRESOLVED，不落半成品包。open/plan/roles/intent 在首卡签发前只返回内部准备回执、不签卡，完整计划应在首次推进前落盘；签卡后包字段（可写范围、完成标准、依赖、模型）真的变化才会重签。同内容重复 plan 零写入（changed:false、不产生 re-planned，也不解除任何 blocked——计划变更本身不构成 blocked 包的恢复授权，修改别的包或增删包都不会解除未选包）；解除按包 blocked 走 --resolve-blocked 恢复卡（见 stop 处理节）。待决人工门或在途派发时会被拒绝（先处理再拆）；
- 复杂目标可先开只读子派单收集事实辅助判断拆分边界。
- 审查默认正式轻量交叉，一个 Owner 与非作者 Challenger 即可从互补角度核验；不按视角数招募成员。按 `tw-dispatch` 实际返回的波次推进，获派 Expert 时照常裁决。确需独立交付才由 Lead 拆包，done 写明本包职责。复杂完整代码交付等确需全面覆盖或用户明确要求时由 Lead 组织一次八视角，返工先复核变更与关联视角，不每个成员、每轮重新展开。

## 角色模型与选人边界

- 角色模型读写：`tw roles --task <名>`（只读）、`--set <role>=<provider>/<model>[@<effort>]`、`--clear <role>`、`--resolve`（按当前快照重解析）；写操作会重签意图确认卡，已有会话换模型在下一轮派发出换模型卡。默认由策略确定，仅用户明确指定例外模型时才显式写入；缺配置按错误指引修复，不猜默认；
- 模型数据链：默认档来自 `team-work/policies/default.json`；`tw open` 把三角色解析成 `ModelRef` 写 `agents.json.roles`（`tw roles` 唯一显式修改入口）；`tw plan` 把每包解析成 `packages.json[].model`；派发直接读两者的已固化值，不在派发期查配置。配置快照 `team-work-dsh.tiers`（同一 profile 跨项目共用）只用于 open/--resolve 初始化与普通委派候选，`tw models` 显示 entry/profile 来源。配置热变不自动改已有任务，`tw roles --resolve` 才重解析（并重签确认卡）。任务级 agents.json 只保存 mappings 与 roles，已派模型快照在 journal 的 `dispatched.detail.modelRef`。
- 无宿主终端由编排调用方显式提供 `TW_DSH_CONFIG` JSON `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}`；不自动读旧 YAML 或项目 dsh.json、不写缓存。缺输入的选模返回 unresolved，平台无关操作仍可使用；
- 升级前备份旧 settings.yaml 与当前 profile 配置：宿主首次导入可能覆盖已有 tiers。旧文件已改名为 settings.yaml.imported 但导入失败时不自动重导，核对旧 tiers 后通过新页面保存；
- 宿主默认 maxDepth=1；正式成员再开只读助手需要用户允许至少两层，插件不自行提高上限，助手不得继续委托。

## 普通委派（用户明确点名档位）

- 输入框 `@junior` / `@senior` / `@expert` 与自然语言都表达选档意图，读取当前已保存的第一候选后以精确 provider/model 调原生 subagent；effort 转为 reasoning_effort。档位缺失明确 unresolved，不换成默认模型。档位只是普通委派的快捷入口，不代表正式派发的模型选择——正式派发以任务级 roles 与包级 model 为准，正式波次成员一律 tw-dispatch；
- 普通精准选模受宿主开关和允许列表限制，旧会话可能须新建后才获得新权限。先查 list_subagent_models 路由；枚举目录未列出不代表不允许，应按 provider+model 精确查询并区分权限拒绝与解析失败。客户端没有精确只读校验 RPC，未广告候选保留草稿，不能据此声称模型不存在；正式创建仍由宿主 resolveCallConfig 实核。

## 成员标签（由 tw-dispatch 自动生成）

DSH 所有后台任务在**统一的子代理列表**混排，且侧栏从尾部截断（约 32 个半角字符）——**阶段是跨任务列表的第一分组建，必须最前**；简述殿后（被截断无害）。

标签格式 `阶段缩写·角色[@包] · 简述 #任务名`（任务段固定 ` #任务名`——前置空格+`#`+任务名）**由 tw-dispatch 自动拼接**：阶段缩写、角色、包、任务名四项全部来自派单事实（Runtime 自有，P4 簿记不向模型索要），Lead 不手工拼标签；唯一可定制成分是 tw-dispatch 的可选 `note` 参数（简述，≤4 个中文词、不含 `#`，含包语义时可省 @包；缺省自动生成 任务名-角色-轮次）。

机制固定成分（无需记忆，仅供人读）：阶段缩写表 RES=调研 DESIGN=方案（design 与 design-review 同缩写）SPEC=SPEC（spec 与 spec-review 同缩写）IMPL=实现 TEST=测试 CR=代码审查 E2E=端到端 FIN=收尾；角色 owner / chal（challenger）/ expert；多包波带 @包（包 id 用自然短词 ≤10 字符），单包省略。

示例：`CR·owner@store · 模块说明 #task-a` / `CR·chal · 文档整合评审 #task-a` / `IMPL·owner@api · task-a-owner-r1 #task-a`（缺省 note 形态）。

- 只读子派单由原生工具派发，可用 `RO` 标签如 `CR·RO · 并发扫描`；它不是正式团队成员，不登记到任务波次；
- 标签只用于展示；精确模型在创建时传给宿主，续派映射由 tw agent-map 登记，标签不承担机器寻址。
