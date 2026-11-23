# GLM-5.3 评测问题修复方案

## 建议与边界

建议将首张确认卡从“创建任务时”移到“完成计划、首次推进时”，一次展示完整计划并绑定 SHA-256；同时只清理 Skill 中要求 Lead 判断正式派发档位和是否出裁决波的引导，明确 DSH 原生调用，并在两个现有同步校验点修正错误。四项可按下文落在既有机制内，不改变裁决策略或新增团队角色。本方案是待评审、待用户批准的实现建议，不代表修改已经实施或测试已经通过。

本阶段仅写本方案，不修改 Runtime、Skill、测试、配置，不安装发布，也不删除已有未跟踪文件。实际实施须获得批准并安排相应文件的可写授权；本方案文档新增后按仓库规则应登记 [文件清单](file-inventory.json)，但该清单不在本包可写范围，须由有权限的后续环节处理，不能由本包越权。当前工作区 [主 Skill](../skills/team-work-v3/SKILL.md) 和 [仓库契约测试](../tests/repository-contract.test.mjs) 已有未提交改动，实施必须在其当前内容上精确修改并保留原有改动。

## 一、首轮只给一张完整确认卡

### 已核实的现状和问题

- [cli.mjs:1120–1173](../runtime-v3/cli.mjs#L1120-L1173)：`open` 初始化角色后立即 `signIntakeApproval` 并返回 `awaiting-user`；[cli.mjs:2222–2235](../runtime-v3/cli.mjs#L2222-L2235) 的 `plan` 在已有卡时落包并立即重签，导致先看到空包卡、再看到计划卡。[cli.mjs:743–748](../runtime-v3/cli.mjs#L743-L748) 卡面只列包模型；[cli.mjs:792](../runtime-v3/cli.mjs#L792) 的结构化 `intake.packages` 也没有 `writable`、`done`、`dependsOn`，虽然 [cli.mjs:679–713](../runtime-v3/cli.mjs#L679-L713) 的稳定投影已包含这些字段。
- [cli.mjs:801–810](../runtime-v3/cli.mjs#L801-L810) 只对“曾签发卡”的任务启用确认门；如果仅删除 `open` 签卡，现有新任务会被误当旧任务直接放行。派发检查在 [cli.mjs:1429–1446](../runtime-v3/cli.mjs#L1429-L1446)、[cli.mjs:1489–1500](../runtime-v3/cli.mjs#L1489-L1500)；待决卡优先静止由 [derive.mjs:72–103](../runtime-v3/derive.mjs#L72-L103) 保障。
- [cli.mjs:729–731](../runtime-v3/cli.mjs#L729-L731) 显示的入口、结束方式和产出来自 `task.scope`/当前 Workflow，而现有摘要主要绑定 `intent.scope`；两者并非同一对象。无包的首派实际可写范围来自派发参数（[cli.mjs:1511–1519](../runtime-v3/cli.mjs#L1511-L1519)），目前不在摘要中。[waves.mjs:1–6](../runtime-v3/waves.mjs#L1-L6) 的无包任务确实是匿名单 Owner，不应虚构具名包。
- [policy/kernel.mjs:3–13](../policy/kernel.mjs#L3-L13) 的 `digestValue` 已使用对象键排序、数组保序的规范化 JSON 后做 SHA-256；可复用，无需新哈希实现。`decide` 在锁内比较的是**当前待决卡**的指纹和当前值（[cli.mjs:1710–1725](../runtime-v3/cli.mjs#L1710-L1725)），但 [cli.mjs:1681–1692](../runtime-v3/cli.mjs#L1681-L1692) 只接收选项序号、不接收用户答复针对哪张卡。旧卡 A 被重签为 B 后，迟到的“A 的选项 1”可能被当成 B 的选项 1；快照一致并不能证明该答复属于 B。
- [store.mjs:75–90](../runtime-v3/store.mjs#L75-L90) 并行初始化 `scope`、`intent` 和 journal；`scope` 已写而 `intent` 尚缺时，[taskExists:44–51](../runtime-v3/store.mjs#L44-L51) 判已存在，[loadTask:94–110](../runtime-v3/store.mjs#L94-L110) 却强制读 `intent`。因此现有同名 `open` 会拒绝，`run/intent/plan/dispatch` 也不能依靠该残留继续；仅在 `scope` 写版本标记不构成恢复。

### 拟议状态流和接口

1. **内部准备，不向用户出确认卡**：Lead 在同一轮用户交互内先用原生 `tw open` 写原始需求、目标、约束、排除、范围/验收并初始化角色；若用户明确指定角色例外模型，先用 `tw roles --set` 写入，再按需要用 `tw plan` 登记完整分包，或在被指定的包对象中写入 `model`。先定角色再计划很重要：不写包模型时 `plan` 会复制当时的 `roles.owner`，事后改角色不会自动改已物化的包模型。`open` 返回准备回执和后续指引，不返回 `decision-issued`、`awaiting-user` 或确认选项；`plan/roles/intent` 在首卡尚未签发时也只返回回执。两种操作不创建成员。Lead 不把这些内部回执包装成用户确认卡。
2. **首次推进签卡，不派发**：Lead 调 `tw-dispatch`；无插件终端调 `tw dispatch-plan`。任务锁内先加载最新任务，按现有路径完成入口阶段 E2E 模板（如适用）和旧包模型物化，刷新快照，再生成唯一首卡并返回 `stop: awaiting-user`，`waves` 为空、没有 `dispatched` 事件或子会话。`tw-dispatch` 的现有 stop 透传见 [dsh/tw-dispatch.js:201–205](../dsh/tw-dispatch.js#L201-L205)。完整原始需求未提供、模型未解析、包校验或物化失败时，返回明确的内部错误与修复指引，不签发可确认的不完整卡；Lead 补齐后再次推进。新任务因此须在签卡前提供 `--raw-requirement`（可用 `tw intent` 补充），这是相对现有可缺省接口的行为变化。如果补齐确需用户提供信息，应单独说明缺项并等待；这不是签发不完整确认卡，首轮唯一完整卡保证以输入可准备齐全为前提。空约束、排除和未指定验收必须如实显示“无/未提供”，不能编造。
3. **用户确认再推进**：新版意图卡在卡面显示唯一 `decisionId`；用户不必在每次答复中手抄 ID。Lead 根据**实际向用户展示的卡片及其答复上下文**确定答复所指的卡，将该卡原始 ID 和选择传给 `tw decide --decision-id`；若只展示过唯一一张完整卡 A、用户直接回复“确认”，就传 A 的 ID，无须再询问。不得以查询到的最新待决卡 ID 替换被答复的卡。`decide` 在锁内先核对答复 ID 与当前卡相同，再按该卡版本重算并核对快照，只有均相等且模型已解析才写接受决定；下一次 `tw-dispatch` 重新锁内重算，匹配即直接按实际波次推进，不因 `open` 与 `plan` 产生第二张卡。未决同指纹重复调用只重显同一 `decisionId`/选项，不重复签发。新版门禁还须要求接受决定绑定该任务最新签发、未作废的意图卡 ID；即使内容 A→B→A 恢复到较旧已接受的 SHA，也不能拿旧 A 的决定绕过新签卡的确认。`tw run`/`tw gate` 仅只读显示准备/待确认及下一步，不创建卡或修改任务。
4. **确有变化时仍需重确认**：卡签发后或确认后若原始需求、范围/产出、角色、任何包字段或首次无包可写范围真的发生变化，旧指纹失效；未决旧卡在锁内追加 `superseded` 后重签，旧卡直答拒绝并提示查看/重签。相同内容的重复 `plan/roles/intent` 不仅凭“调用过”就重签；须比较规范化指纹，保留现有 blocked 重拆事件的恢复语义。其他待决卡优先，不能叠卡或错配选项；从旧卡展示与答复上下文关联得到的 ID 不能转而作用于新卡或其他类型的卡。已有会话换模型卡、人工门及确认前不派发规则不变。此处“唯一一张”指首轮基线不变时的一张，不豁免用户之后明确改需求或配置后的重确认。

### 答复绑定：既要校验卡片身份，也要校验 SHA

拟议的接口是在现有 `tw decide --task <名> --choice <序号>` 增加 `--decision-id <卡片标识>`；DSH 的原生 `tw` 同样将其作为两个 `args` 字符串传递。举例：

```json
{"args":["decide","--task","example-task","--choice","1","--decision-id","intake-a1b2c3"]}
```

1. [signIntakeApproval](../runtime-v3/cli.mjs#L765-L798) 目前在生成正文之后才生成 ID；改为在任务锁内先生成该任务未被任何历史 `decision-issued` 使用的 `decisionId`（撞号则重生成），再用同一 ID 构造卡面、结构化返回和 journal 事件。新卡的 `decision-issued.detail` 和后续接受决定均持久化 `intakeVersion: 2`；`scope.intakeVersion` 标识新任务，卡及决定的版本标识用于恢复及新旧卡分流。新版任务如果出现意图卡缺少或不一致的版本标识，应当作损坏拒绝并提示核对，不能回退成允许无 ID 的旧卡。即使 A→B→内容变回 A，第三张卡也不能复用 A 的 ID。ID 标识一次签发；SHA 仍只绑定配置快照，不把随机 ID 加进 SHA。
2. 修改 [twInner 的 decide 参数转发](../runtime-v3/cli.mjs#L2830) 和 [cmdDecide](../runtime-v3/cli.mjs#L1681-L1725)：取得当前 `pending` 后，在查找选项、写 `decisions.json` 或 journal **之前**，若调用方提供了 `--decision-id`，无论当前卡类型都必须原样等于当前 `pending.decisionId`；提供了但不相等时返回 `DECISION_STALE` 和“答复对应的卡已失效，请完整查看最新确认卡并明确选择”的修复指引，不消费新卡。若当前是 `intakeVersion: 2` 的意图卡，缺少/空的 ID 同样拒绝并提示 Lead 携带实际被答复的已展示卡片 ID；无法确定对应关系时先请用户澄清。该要求适用于确认、修改、终止三个选择，不能只保护确认选项。通过身份检查后才做选项合法性、模型解析与现有签发 SHA 对当前快照比较，三项均通过才按原流程处理。
3. 旧版意图卡（签发事件无版本字段）及换模型卡、人工门等非意图卡：未传 `--decision-id` 时沿用现有调用方式；传入时统一校验其与当前卡一致，避免迟到的 A 答复恰好消费其他类型的 B 卡。`tw help`、Skill 和调用样例同步说明 v2 必填及拒绝恢复，其他卡不强制新增参数。
4. **人机答复关联规则**：Lead 向用户完整呈现卡时保留该展示对应的工具返回 `decisionId`；根据当前对话中实际呈现的卡与用户答复内容判断其对象。只有 A 一张卡被展示、用户直接回复“确认”，且语境无歧义时，直接从 A 的展示记录取 ID 调 `decide`，不额外要求用户复述标识。用户明确指向某张已展示卡时按该指向处理；如多张卡均已展示而无法确定答复所指，或对话记录不完整等导致对应关系确实无法确定，先请用户澄清、暂停决定与派发，不猜。已签发但未实际展示给用户的 B 不能被视为用户确认对象：即使最新待决卡已是 B，对 A 的答复仍传 A，交给 Runtime 拒绝后再呈现 B。禁止用 `tw run`/当前待决卡的 ID 推断用户答复，更不能以 B 的 ID 替换 A 的 ID。若宿主有经验证的卡片关联信息，也可使用；本次不假定或新增 GUI 能力。此方案要求调用脚本为新版 `decide` 传 ID，但无歧义的用户确认不增加人工问答；身份与 SHA 校验**不证明用户已阅读或理解卡面**。

**防绕过与兼容落点。** 在 [store.mjs:56–90](../runtime-v3/store.mjs#L56-L90) 的创建入口为新任务的既有 `scope.json` 原子写入确认协议版本标记，例如 `intakeVersion: 2`，由 `cmdOpen` 显式传入；不新建平行状态文件。该标记必须与 `scope.json` 一次写成，不能等角色初始化完成后再补，否则中断窗口会误判为无确认门旧任务。对 v2 新任务，不论是否已有 `decision-issued`，首次推进均必须经过确认；守卫放在 `cmdDispatchPlan` 任务锁内、准备与物化后、任何 `runTransition` 推进/派发之前，而不只依赖现有“已签卡”分支，其他待决卡仍按原优先级静止。拆包意图须在首次推进之前完整落盘；若没有包计划则按匿名单 Owner 明示，不能在用户确认后暗补分包。旧任务无标记且从未有意图卡时维持既有不补卡行为，已有旧卡的任务仍按旧版投影处理。`initTask` 其余调用者及旧测试夹具的缺省行为不应被静默改变。`scope` 或包计划读取失败不能被当作旧任务或空计划；角色损坏仍可使用现有恢复路径，恢复后必须将实际重建值完整展示并确认；事实无法确定时拒绝并给修复指引。该标记是兼容与意外变更保护，不声称抵御人为同时篡改全部任务事实；SHA 也不是身份认证。

**无包单 Owner**：卡明确写“未拆包，单 Owner”，不伪造包 ID；首次推进需携带已有格式的可写声明，锁内将该声明作为 `scope` 内首派事实保存，并在卡上同时展示实际 `roles.owner`、可写范围和来自 `intent.acceptance` 的验收（缺省如实标明），随后纳入 v2 指纹。确认后首次真正派发省略可写参数时使用已确认值；传入不相同值则先更新该事实并重签，绝不按旧确认派发。只在**首个派单之前**执行这项比较；已开工后的回应轮、用户授权的 blocked 恢复与后续阶段仍按现有流程，不将首派路径永久固定为全工作流的路径。无产物的终端场景保留现有 `--writable none` 语义；DSH 绑定的 `writables` 当前仅接受路径/类型对象（[dsh/tw-dispatch.js:161–193](../dsh/tw-dispatch.js#L161-L193)），本方案不另行承诺扩展该历史接口。多包以持久化的包计划为准，不从派发参数推测包。

**一致的 v2 快照**：复用 `intakeSnapshot/intakeState`，增加按协议版本区分的投影；v2 包含现有 `intent`（原文、目标、约束、排除、`intent.scope`、验收、gaps、risk）、实际 `scope.entry` 与 `completion`、入口 Workflow 的显示产出、三角色完整 `ModelRef`、每包 `id/model/writable/done/dependsOn`，以及仅无包时的首次单 Owner 可写声明。用同一投影产生人读卡、结构化字段、签发摘要、决定校验和派发校验；其中 `model` 的 `effort/family` 有值时展示，缺省如实省略。数组顺序保留、对象键排序；时间戳、随机 `decisionId`、配置来源和指纹自身不参与。不要把 `scope.intakeVersion` 当成用户授予额外范围。旧卡/旧接受记录按其原版投影核验，不将旧 SHA 当成 v2 SHA；如无法还原旧版则阻止并提供确认恢复路径，而不是伪造已确认。更新 [cli.mjs:1230–1238](../runtime-v3/cli.mjs#L1230-L1238)、[cli.mjs:1631–1639](../runtime-v3/cli.mjs#L1631-L1639)、[cli.mjs:1710–1725](../runtime-v3/cli.mjs#L1710-L1725)、[cli.mjs:2063–2078](../runtime-v3/cli.mjs#L2063-L2078) 和 `plan/roles/intent` 的对应读取/重签分支，防止呈现、决定和派发采用不同版本。

### 卡面与字段：修改前 → 修改后

- 原“已拆包的实际模型”表仅有包及模型 → “完整分包计划”逐包列出 `id`、完整实际 `model`、`writable`、`done`、`dependsOn`；无依赖显示空数组。`intake.packages` 增加同源 `model/writable/done/dependsOn`，保留原 `modelRef` 兼容字段且 `model` 与 `modelRef` 使用同一物化模型值，其值与实际摘要完全一致。
- 原“未拆包；拆包后本卡会重签” → “未拆包：单 Owner；模型、首派可写范围、验收如下”。多包例：

```text
原始需求：[用户原文，完整保留]
目标：[目标]；约束：[逐项列出或无]；排除：[逐项列出或无]
范围与产出：[入口、结束方式、产出类型及范围补充]；验收：[逐项列出]
角色模型：owner / challenger / expert 的实际 provider、modelName、effort（如有）
卡片标识：intake-a1b2c3
完整分包计划：
- id: draft；model: [实际模型]；writable: [docs/draft.md:design]；done: [完成方案草稿]；dependsOn: []
- id: merge；model: [实际模型]；writable: [docs/final.md:design]；done: [读取草稿并完成整合]；dependsOn: [draft]
待明确问题：[逐项列出或无]
选项：确认开始 / 我先修改 / 终止任务
回复示例：确认开始
```

上述文字中的卡片标识是脱敏示例，不是实际任务标识；不能截断用户原文或以摘要取代。空模型不是默认值。`question` 与结构化 `intake` 均需完整，避免仅机器字段完整而用户卡缺内容。

### 初始化中断的安全恢复与代价

选择**保留残留任务、换新任务名重建**，不尝试推断丢失原文或为残留任务自动补文件，不引入通用事务系统。具体处理：

1. `open` 出错或超时后先确认原调用已结束，不盲目重复同名创建。若新版 `scope` 已落盘但 `intent.json` 不存在，或初始 journal 不存在/为空：该旧名字不能依靠现有 `run/intent/plan/dispatch` 继续；保留残留目录及其全部文件，不删除、不覆盖、不归档，不能宣称同名恢复。即使 `scope` 尚未落盘，也不能简单同名重试：现有 `taskExists` 只检查 `scope`，可能漏掉已落的其他事实。
2. Lead 使用**新的、未被占用的任务名**重新 `open`，重新提供用户原始需求全文、目标、约束、排除、范围和验收，按用户原意重新登记角色例外及完整包计划，再首次推进签发一张完整首卡；确认该新卡并通过指纹与身份双校验后才派发。原文或计划已无法从会话或已获授权的上下文确定时，先请用户补充，不从残留或旧名字猜测。代价是残留任务名被占用、计划需要重新录入，审计事实分在两个名字下；不自动清理和合并。
3. 为让错误有清晰恢复边并避免误覆盖，拟在 [store.mjs 的新版 initTask 创建路径](../runtime-v3/store.mjs#L56-L90) 对任务根目录先做**独占创建**：先确保任务父目录存在，再用非递归 `mkdir` 创建任务根，`EEXIST` 时拒绝而不是覆盖已有文件；若有有效已有任务则保留 `TASK_EXISTS`，若已有新版 `scope` 却缺少 `intent`/初始 journal，或任务目录存在但尚无 `scope`，返回拟议错误 `TASK_INIT_INCOMPLETE`，说明“创建可能仍在进行或曾中断；先核实原调用结束：若已成功则按实际状态继续，若中断或事实不全则保留原目录并用新名字重新提供原文和计划”。这些检查不改写原文件；读取错误/损坏不当作不存在，不把竞态中的另一创建者覆盖掉。该保护仅用于本方案的新版 `cmdOpen` 路径，不改变旧版 `initTask` 其他调用者的默认合同。
4. 在 [loadTask](../runtime-v3/store.mjs#L94-L110) 对新版 `scope` 加最小完整性检查：缺少 `intent` 或初始 journal 缺失/为空时返回同一恢复提示，不把缺 journal 当空任务而签卡；其他读取错误和损坏按实际错误拒绝，不能降级成空内容。`run/intent/plan/dispatch` 取得该提示后不写确认或派发事实。若 `scope` 本身不存在，读取路径仍可能报告 `TASK_NOT_FOUND`；新版 `open` 的独占创建检查负责阻止覆盖残留。缺失派生 `artifacts` 沿用既有可重建路径，不把它误判为必须重建新任务。新增错误码和上述对既存目录的拒绝是新版接口变化；正常同名完整任务仍按原规则返回 `TASK_EXISTS`。

**其他中断**：只有初始化所需事实已经完整且可加载后，才按已落事实继续；之后模型/包解析失败时保留任务及最后有效计划，修配置或重跑 `plan`，不先签不完整卡。签卡后中断重试应读到同一未决卡；决定后或派发前配置漂移要停止并重确认。`decisions.json` 与 journal 目前分两次写入（[cli.mjs:1758–1762](../runtime-v3/cli.mjs#L1758-L1762)、[1791–1792](../runtime-v3/cli.mjs#L1791-L1792)），不能宣称跨文件原子：发生中断时不得凭单边事实自动派发，先用 `tw run` 查看；若仍是同一张未过期待决卡，且用户答复已无歧义关联到原卡，可重试携带**原卡 ID**的同一 `decide`；若不再待决则核对确认状态，再按指引推进。现有实现重试可能重复写决定记录，不承诺跨文件恰好一次；若故障注入发现该恢复不能保持确认门，实施前先向 Lead 报告，不把新的通用事务系统暗加进本次。已有 `open` 调用方从“立即返回确认卡”改为“准备回执、首次推进才出卡”，需同步帮助文案、调用方和测试；当前测试助手自动确认机制需显式调整，不能通过自动代答掩盖首卡问题。之后真正的包变化（包括后续阶段首次实际物化的 E2E 模板）仍可能触发新的确认，这是快照变化，不是首轮重复发卡。

### 重签确认卡的增量 Diff 展示（用户补充要求）

首张完整确认卡被接受后，若意图、角色模型或分包（含 `writable`/`done`/`dependsOn`）发生局部调整而需要重签，新卡只相对于**最近一次已确认（`accept-intake`）快照**首屏突出增量变更，避免用户重读整张卡；这是呈现方式的增量，不改变确认门的完整性。前四节已定案的确认契约与指纹、身份双校验语义保持不变。

1. **基准**：以最近一张已接受决定绑定、仍可还原的 `intakeSnapshot` 为基线（同一 `intakeVersion` 投影）。没有已确认快照（首卡本身，或首次确认前发生的重签）时仍完整展示；历史已确认记录缺少可核验完整快照时不伪造增量，安全回退完整卡并提示（结构化返回以 `diffBaselineUnavailable` 标记基准卡），待本次确认后以新快照为基线。
2. **人读卡面（`question`）**：首卡未确认前完整展示；已有 `accept-intake` 确认后重签时，首屏标明基准卡 `baseDecisionId`，只展开相对最近一张已确认快照的增量变更项——分包按包给出变化行（新增/删除包，或某包 `model`/`writable`/`done`/`dependsOn` 的旧值 → 新值），意图、范围/产出、验收、三角色模型按字段给出旧值 → 新值；未变更区块不重复展开，用“与已确认快照一致（N 项未变）”折叠引用该卡与完整快照。历史已确认记录缺少可核验快照时回退完整卡并提示本次作为新基线。
3. **结构化返回**：`intake.diff` 给出同一基线的机器可读增量，至少含 `{ baseDecisionId, baseFingerprint, changes: [{ path, kind: "added" | "removed" | "modified", before?, after? }], unchangedFolded: true, unchangedCount }`；`path` 为字段路径（包字段用 `packages[<id>].<字段>`），`before`/`after` 为旧/新值，`unchangedCount` 为未变项计数（供人读折叠说明）；完整结构化 `intake` 与底层完整快照保持不变，不因增量呈现而丢字段。
4. **指纹与答复绑定不变**：`intakeFingerprint`（SHA-256）仍对**完整** `intakeSnapshot` 计算，`--decision-id` 仍指向本次重签卡并同时核验卡 ID 与指纹；增量 Diff 不参与指纹、不放宽确认门，决定与派发仍以完整快照为准。
5. **边界**：重复登记相同内容不重签（沿用现有指纹比较）；首卡签发但尚未确认时发生内容变化，因没有已确认基线仍展示完整卡；换模型确认卡、人工门等其他卡片维持原呈现规则，不套用增量 Diff。
6. **回归落点**：Skill 契约测试（`tests/repository-contract.test.mjs`）锁定上述呈现、识别与答复关联规则，并用隔离夹具触发真实返回的首卡、增量重签卡与基线缺失回退卡做接缝核对；Runtime 行为用例（新增/删除/修改字段的 Diff、未变更项折叠、SHA 仍覆盖完整快照、无已确认基线时展示完整卡）由 Runtime 实施用例覆盖。

7. **识别与呈现分流**：Lead 依据结构化返回识别卡类型，不依赖 `question` 标题（首卡标题为“# 任务意图确认（intake-approval）”，已确认后的增量卡为“# 任务意图变更确认”，基线缺失回退卡会先输出提示行再接完整卡标题，标题不足以区分）。识别规则：返回 `decisionId` 且 choices 含 `accept-intake`（“确认开始”）即为意图确认卡；其中 `intake.diff` 在场是已确认后的增量重签卡，只呈现 `changes` 的变更项并折叠未变项、标明 `baseDecisionId`，不逐项重展完整卡；`diffBaselineUnavailable` 在场是基线缺失回退的完整卡，完整呈现并在开头提示“本次展示完整卡作为新基线”；两者均缺省时按首卡完整呈现。答复仍携带所展示卡的 `decisionId`。

示例（脱敏，非真实任务标识）：

```text
与已确认快照相比（其余未变更项已折叠）：
- 新增包 merge：model [实际模型]；writable [docs/final.md:design]；done [读取草稿并完成整合]；dependsOn [draft]
- 修改包 draft 的 done：[完成方案草稿] → [完成方案草稿并补充风险清单]
- 修改角色模型：expert [原实际模型] → [新实际模型]
- 未变更：原始需求、目标、约束（2 项）、排除（无）、范围与产出、验收（2 项）、其余 1 个包字段
卡片标识：intake-a1b2c3
选项：确认开始 / 我先修改 / 终止任务
```

## 二、从 Skill 清除正式派发选档和核心场景判断

### 现状和最小修改

[default.json:9–23](../team-work/policies/default.json#L9-L23) 存有 `riskTiers`、角色兜底、场景角色档与 `core`；[waves.mjs:15–29](../runtime-v3/waves.mjs#L15-L29) 从策略推导，[waves.mjs:261–299](../runtime-v3/waves.mjs#L261-L299) 与 [343–348](../runtime-v3/waves.mjs#L343-L348) 决定返工和裁决波。[cli.mjs:418–430](../runtime-v3/cli.mjs#L418-L430) 的历史 `--risk` 仍会影响 owner 初始解析；[cli.mjs:59–73](../runtime-v3/cli.mjs#L59-L73) 优先读取项目的 `default.json`，缺失时回退包内文件。因此“由 default.json 决定”指实际加载的策略文件，具体模型仍由配置快照解析；不是 Lead 猜出模型。此项只改 Skill 指引，不删除 CLI 的历史 `--risk` 能力、不改 Policy、波次算法或强制要求用户升级。

| 位置（按当前工作树行号） | 现有内容 → 拟议处理 |
| --- | --- |
| [SKILL.md:22–35](../skills/team-work-v3/SKILL.md#L22-L35) | 第 28–29 行的核心/非核心分支、重裁预测改为“按实际返回的波次完成评审、裁决及汇总，不自行增减角色”；删除第 31 行 `--risk` 档位判断；第 32–33 行不写核心 Expert、专家档 Owner 或按场景预测下一波，保留审查范围、证据和轮次耗尽后按卡处理。第 30 行只说明默认由策略确定、用户明确指定模型才用 `roles --set` 或 `plan`；`--resolve` 保留作缺配置修复。第 35 行去掉提示 Lead 查询模型档位的措辞。 |
| [SKILL.md:39–60](../skills/team-work-v3/SKILL.md#L39-L60) | 操作表删除主动传 `--risk` 和 `tier:senior` 示例；更新首卡时序、完整字段，以及新版 `decide --decision-id` 绑定用户答复的规则；不把“用户指定档位的普通委派”和成员 junior 只读助手误删。 |
| [topology-and-cost.md:3–23](../skills/team-work-v3/references/topology-and-cost.md#L3-L23) | 删除 role/tier 对照、逐场景选档、专家档 Owner 示例及“连续返工后自行调整模型”；用一段数据来源与用户明确指定时的操作替代；修改首卡时序。第 31、35、39、44、52 行删除核心场景列表、核心/非核心波预测和临时调模型建议，改为遵循实际派单；保留已分配 Expert 的实际裁决职责及制品变化后的既有复核规则。 |
| [dsh-orchestration.md:47–49](../skills/team-work-v3/references/dsh-orchestration.md#L47-L49)、[62–84](../skills/team-work-v3/references/dsh-orchestration.md#L62-L84) | stop 卡改呈现完整包计划；第 67 行改先准备后首卡；第 69 行按返回波次描述；删除整个 `risk 与选人` 中的 `--risk` 选择规则、tier 调整示例，以及第 83 行按任务类型主动选档的说明。保留用户明确点名普通委派、模型精确查询与成员只读助手边界。 |
| [scenarios.md:3–13](../skills/team-work-v3/references/scenarios.md#L3-L13)、[33](../skills/team-work-v3/references/scenarios.md#L33)、[56–64](../skills/team-work-v3/references/scenarios.md#L56-L64) | 删除“核心场景必出 Expert”和 Lead 自行换强弱模型的指导，改成“按实际返回角色推进和报告”；保留专家已获派时的技术裁决职责、验收分流、审查视角、范围争议及人工门，不将是否新增裁决波交 Lead 判断。 |
| [rules.md](../skills/team-work-v3/references/rules.md) | 已读取，未发现上述正式派发档位或是否产生 Expert 波的判断表，无需为凑修改而改动。 |

统一替换文案建议：“默认角色配置及下一波由策略和 Runtime 决定；Lead 只按 `tw-dispatch`/`dispatch-plan` 实际返回推进和汇报。仅用户明确指定例外模型时，通过 `tw roles --set` 或 `tw plan` 写入；缺配置时按错误指引修复，不猜默认。”`default.json` 决定默认角色档与是否安排裁决波，具体模型由配置快照解析并固化。保留用户主动指定档位的普通 `subagent`、成员限定 junior 只读助手、既有非作者挑战和实际获派专家职责；删除的是让 Lead 判断正式波次模型或是否产生 Expert 的提示，不删除角色名称本身。

## 三、在 Lead 操作区写清 DSH 原生工具及数组示例

[SKILL.md:37–56](../skills/team-work-v3/SKILL.md#L37-L56) 把调用排成 `bash` 命令，`tw plan` 用占位符，未在操作区第一时间说清原生调用；实际 [dsh/tw-tool.js:19–21、51–77](../dsh/tw-tool.js#L19-L77) 接收 `{args: string[]}` 并注入 `TW_DSH_CONFIG`，而 [dsh/tw-dispatch.js:110–112、151–181](../dsh/tw-dispatch.js#L110-L181) 也传配置快照。不要要求 DSH 内手写环境变量，也不要把工具内部启动子进程误称成用户须运行 shell。

在 `SKILL.md` 的“Lead 操作”标题下、命令表之前直接增加：

> DSH 会话内直接调用原生 `tw` 工具（`args` 是 CLI 参数数组）完成 `open/plan/roles/decide` 等；正式波次使用原生 `tw-dispatch`。插件自动注入当前调用的 `TW_DSH_CONFIG` 快照，不要用 bash 拼配置。只有没有 DSH 插件的终端才运行 `tw` CLI；该终端须由调用方显式提供配置快照，缺失则按 unresolved 指引处理。

`tw plan` 原生工具调用示例，外层 `args` 是字符串数组，`--packages` 后是**一个 JSON 字符串**；该字符串内的 `writable`、`done`、`dependsOn` 都有完整方括号：

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

在 DSH 的工具调用参数中使用该对象，不把它当 shell 命令。两包没有写 `model`，现有 `cmdPlan` 会物化为当时的 `roles.owner`（[cli.mjs:2198–2220](../runtime-v3/cli.mjs#L2198-L2220)）；只有用户明确指定例外模型时才在该包对象中增加 `model: {provider, modelName, effort?}`，值由用户指定，不能把样例当真实配置。各包写入范围必须互斥，`dependsOn` 只表示真实等待依赖。无插件终端的同一 JSON 可作为 `--packages` 的单个参数传入；不可省略数组方括号或把字符串拆成逐字符。更新 `helpCard` 的 `open/plan` 描述和 [dsh-orchestration.md:62–67](../skills/team-work-v3/references/dsh-orchestration.md#L62-L67) 的先准备再确认时序；工具 schema 不因示例而新增一层。

## 四、同步校验：减少错误噪声，避免返工包名失配

### 4.1 `cmdPlan` 非数组不得参与路径遍历

现有 [cli.mjs:2137–2147](../runtime-v3/cli.mjs#L2137-L2147) 检查 `!Array.isArray(p.writable)` 后仍执行 `for (const w of p.writable ?? [])`：字符串按字符遍历，重复字符被当重叠路径；普通对象或数字还可能抛非迭代异常。拟议最小改法（伪代码）：

```js
// 前：类型错误后仍遍历 p.writable ?? []
// 后：错误仍聚合，但只有真正的数组参与后续路径检查
if (!Array.isArray(p.writable) || p.writable.length === 0) {
  reasons.push('包 ' + p.id + ' 的 writable 必须是非空数组，例如 ["docs/a.md:design"]')
}
for (const w of Array.isArray(p.writable) ? p.writable : []) {
  // 保留原有相对路径与互斥检查
}
```

不因一个错误 `continue` 掉同一包的 `done/model` 检查；可继续聚合其他包的真实错误。`PLAN_REJECTED` 原错误码及修复指引保留，合法数组、真实重叠与目录边界逻辑不变。本问题不顺带扩大成所有 `dependsOn` 或历史输入类型的全量重构。

### 4.2 `registerReview` 对返工意见的包名精确校验

现状 [intake.mjs:207–241](../runtime-v3/intake.mjs#L207-L241) 仅校验 severity/statement，不检查 `finding.package`；[waves.mjs:37–39、261–283](../runtime-v3/waves.mjs#L37-L39) 把非 null 的包名作为精确点名集合，未知或拼接包名会使实际待修包未被命中，其他已覆盖包甚至被视为接受。不是逐字拆包，也不能靠错误包名安全回退为全组返工。[intake.mjs:39–57](../runtime-v3/intake.mjs#L39-L57) 的锁内 `freshState` 尚未读 packages；[cli.mjs:53–56](../runtime-v3/cli.mjs#L53-L56) 在取锁前加载的 `task.packages` 不能当并发下的最新依据。

拟在 `reviewLocked` 已持有的任务锁内重读当前 `packages.json`，从合法 `items[].id` 建集合，然后在写报告、算幂等回执之前聚合校验：

- 仅对 `recommendation === "rework"` 或 Expert 的 `verdict.outcome === "rework"` 的 findings 增加此项；`accept/escalate` 的既有报告语义不变。`package` 缺省或 `null` 仍表示该条未点名；全部 findings 均未点名时才沿用现有全组返工语义，混有具名条目时仍按既有点名集合选择。空字符串在提交时规范为 `null`，避免现有波次机将 `""` 当成一个点名。非字符串非 null 值拒绝；非空字符串必须**原样**精确等于一个当前包 ID，不做 trim、拆分、模糊匹配或猜测。多个包各写独立 finding，不能用 `"draft,merge"`、数组或拼接字符串。
- 无计划的匿名单 Owner：无包名的 finding 仍可使用；任何非空包名都拒绝并提示省略该字段。计划文件缺失按无包处理，若文件存在但损坏、`items` 形状无效则安全拒绝并提示检查/恢复计划，不猜为空包。仅有 package 字段时才需要包集合；不改变合法的无归属评审。
- 维持 `INTAKE_REJECTED` 与统一 `reasons`；例如：“finding 第 1 项的 package 必须精确等于当前任务的单个包 ID；可用 ID：draft、merge。多个包请分别填写 finding；不指定包请省略 package；修正后用原 key 重新 review。”不得部分写报告、追加 `report-accepted` 或产生伪成功。修正后相同 key 沿用既有版本/幂等机制；历史已接收报告不自动改写，非法历史报告的同内容重交将按新规则拒绝，应由原评审者在有效 key 上修正；若该 key 已作废则按现有派单恢复边处理。

这项校验**只保证包名在当前计划中存在**，不把“已定义”等同于“本次已交付且已被评审”；后者仍由派单及既有评审纪律约束。裁决返工仍按 [waves.mjs:297–300](../runtime-v3/waves.mjs#L297-L300) 的现有全组语义，不承诺 Expert 按 finding 选择性返工，也不治理无关历史报告。

## 五、实施顺序、回归与验收

按“确认投影与状态流 → Skill 与工具示例 → 两处入参校验 → 对应回归”实施；所有测试与断言使用脱敏、合成任务与模型。涉及已有改动的文件须先读取并精确编辑，不覆盖用户工作。下面均为**拟执行**的测试，不是本阶段已运行结果：

1. **首卡与 SHA**：在 [runtime-v3-cli.test.mjs:596–667](../tests/runtime-v3-cli.test.mjs#L596-L667) 改写旧 open 即出卡断言，使用非自动确认调用验证 `open → plan → 首次 dispatch` 只签一次卡，逐项比对原文、目标、约束、排除、scope、产出、三角色和每包五字段；在任务锁相关测试中核对确认前零 dispatched、零子会话、重复推进同一 decisionId，确认后快照相同直接派发。分别改变 `intent`、实际 `scope.entry/completion/outputs`、每包 `id/model/writable/done/dependsOn`、角色及单 Owner 首派 writable，断言旧卡拒绝且新卡与新 SHA 一致；键序变化稳定、数组顺序变化按原规范处理。缺原文、缺配置、损坏输入和物化失败均不产生可接受的不完整卡。特别测试：①对话中只完整展示 A，用户仅回复“确认”，SHA 未变：Lead 从 A 的展示与答复上下文取得 A ID，直接传 `decide --decision-id A --choice 1`，随后派发，期间不再向用户询问 ID；②只展示 A，但 A 的答复到达前计划改变、B 已签发且未展示：仍传 A ID，返回 `DECISION_STALE`，B 保持待决、无新决定或 `dispatched` 事件；呈现 B 并获得对 B 的确认后，`--decision-id B --choice 1` 才能成功。以并发屏障固定 B 签发与 A 答复的次序；③A、B 都已向用户展示且“确认”无法关联其中一张时只请求澄清，不调用 `decide` 或派发，用户明确指向后再携对应 ID 处理。工具入参的空/缺 ID 仍拒绝，A 的迟到 ID 遇其他类型 B 卡也拒绝；旧意图卡与非意图卡不带 ID 保持原行为。另测 A 已接受后 B 重签、内容回到 A 的较旧 SHA 时仍需确认最新新卡；另测 A→B→内容回到 A 与模拟 ID 撞号，确保新卡 ID 不复用；已获用户确认但请求超时后重试仍携带原卡 ID。
2. **兼容/恢复**：覆盖无标记且无卡的历史任务、旧 pending/已确认卡、首卡签发后重试、`decide` 前后漂移、其他人工门和换模型卡优先、单 Owner/无产物终端以及确认后单 Owner blocked 扩权恢复；注入 `scope` 成功而 `intent` 缺失、初始 journal 缺失或为空，校验同名 `open` 与 `run/intent/plan/dispatch` 都拒绝并给换名恢复指引，不签卡、不写派单且保留原目录字节；再以完整原文和计划换新名字创建，核对首卡完整且确认后可推进。另注入 `scope` 尚缺但其他文件已存在、两个同名新版 `open` 并发、完整已有任务以及旧版初始化，分别验证独占创建不覆盖、最多一个创建者成功、完整任务仍 `TASK_EXISTS`、旧版路径不回归；[runtime-v3-topology.test.mjs:588–616](../tests/runtime-v3-topology.test.mjs#L588-L616) 的 E2E 模板在第一张相关确认卡前完成物化且不覆盖显式计划；测试后续阶段模板确实改变包时按新快照重确认。`run/gate` 含只读零写、`tw-dispatch` stop 不创建成员，分别覆盖 [runtime-v3-cli.test.mjs](../tests/runtime-v3-cli.test.mjs)、[dsh-dispatch.test.mjs](../tests/dsh-dispatch.test.mjs) 与 [runtime-v3-concurrency.test.mjs](../tests/runtime-v3-concurrency.test.mjs)。对于决定双文件中断，先注入故障验证现有行为；如无安全恢复边，停止依赖实现并报告，不宣称已解决。
3. **Skill 与调用**：更新 [repository-contract.test.mjs:89–117](../tests/repository-contract.test.mjs#L89-L117) 与 [145–172](../tests/repository-contract.test.mjs#L145-L172) 里和新要求冲突的旧断言；仅针对正式派发判断文本禁止 `--risk` 升档规则、核心/非核心场景预测、无用户指定的主动换模型，不能用全局禁止 `expert/junior/tier` 误伤角色名或普通只读助手。正向断言保留分包互斥、按实际波次推进、完整首卡及卡面 ID、从实际展示与答复上下文关联卡片并透传 ID 给 `decide`、DSH 原生调用和两个 JSON 数组括号；对文内原生示例进行 JSON 解析并在隔离夹具执行 `plan`，校验两包均有完整数组。验证 DSH 两工具收到调用快照，终端无快照正常 unresolved；不依赖真实账号配置。工具级用例以测试驱动者模拟上述展示与答复并检查调用参数及派发结果，Skill 契约测试检查文字指引；这两者不能证明真实模型一定按语境关联。实际 Lead 的“唯一卡 + 确认”不再追问及歧义场景的澄清，须在获授权的隔离 DSH 会话中另行交互复验，并记录所见卡、用户答复、调用参数与结果；本方案阶段未进行该验证。
4. **计划非数组**：在 [runtime-v3-topology.test.mjs:38–94](../tests/runtime-v3-topology.test.mjs#L38-L94) 增加字符串（含重复字符）、对象、数字、`null`、缺失与空数组；均返回清楚的 `PLAN_REJECTED`，无单字符重叠噪声/裸异常，也不掩盖独立真实错误；保留合法数组、真正跨包重叠、依赖环与标准缺失的原测试。
5. **包名校验与路由**：在 [runtime-v3-intake.test.mjs:130–145](../tests/runtime-v3-intake.test.mjs#L130-L145) 和 [runtime-v3-topology.test.mjs:224–254](../tests/runtime-v3-topology.test.mjs#L224-L254) 覆盖精确 ID、未知 ID、大小写、前后空格、拼接/数组、多条不同包、缺省/null/空串、无包任务、有损坏计划、Challenger rework 与 Expert verdict rework；对照未带 rework 裁决的 `accept/escalate` 不扩大校验。拒绝时比较报告文件与 journal 不变，修正同 key 后可接收，重复合法 payload 幂等；并发重拆与评审串行后以锁内当前计划为准，并断言评审在途时重拆按现有规则可被拒绝，不假定两操作都成功；多包端到端证明只重派实际点名的已覆盖包，所有条目均未点名时依旧全组，不把“已定义但未交付”当作新校验承诺。
6. **完整回归**：按 [package.json:31–34](../package.json#L31-L34) 运行针对上述文件的 `node --test`，再运行 `npm test`；保留失败/跳过数量与原因。必要时做隔离宿主接缝测试，但本阶段不声称真实 DSH 人工交互或发布验证通过。实施结束复核最终 diff、脱敏及用户原有改动是否保留。
