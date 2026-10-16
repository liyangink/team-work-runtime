# DSH 编排：Lead 派发操作规程（DSH 0.2.0-rc.2）

本篇的开任务、拆包与正式波次派发操作仅供 Lead。已收到角色、边界与 deliver/review 指令的成员按本派单执行，不重建审查团队。成员可用原生工具就本职责内的限定小问题开 junior 只读助手，消息带完整范围、可写为空与禁止继续委托的要求；不复制总目标，不派完整审查团队，由发起者核验整合结果。

正式成员需要可续聊的子会话：Owner 修订、Challenger 复审、Expert 重裁都由 `tw-dispatch` 创建或恢复。普通委派使用原生 `subagent`，继承父历史用 `subagent_fork`；原生后台 `continuable` 返回的 `subagentId` 是会话 ID，可直接用于 `send_message`。一次性后台 `jobId` 与前台 `runId` 不作续聊身份。

原样投递 Runtime 业务派单，两种正文都已带当前验收基线；绑定层只选变体，不改业务条件。requiredGuidance 是根包规范的只读投影，DSH 同条消息追加规则 text 块，Lead 最终结果保留自身 presentation；无需主动调 skill。独立入口可依宿主选源，TWR 自动规则固定来自根包，见[派单引导库](guidance.md)。intent/done/可写目录不授权扩需求，变更仍经用户明确批准及原人工门/SPEC；分流见[场景指导](scenarios.md#验收基线与意见分流)。

## 波次推进：一律 tw-dispatch

**无未决范围/必要性/修法授权争议时，用 `tw-dispatch`（{ task, note?, writables? }）推进**；收到争议先按[场景详则](scenarios.md#范围争议暂停)普通最终消息请用户方向，不为取卡继续派发。单次正常调用完成一个波次：

1. 内部子进程调 `tw dispatch-plan --task <名> --json`（writables 透传）推进到派发点或 stop；
2. 波次机不在派发点时（awaiting-user / completed / blocked / archived 卡，含拒绝卡）**原样透传卡片**，不创建任何子代理——Lead 按卡片行动；wait-inflight 卡是唯一例外：按条目自动兜底处置（见 stop 处理节）；
3. 在派发点时对每张派单先登记 dispatchKey→确定性 sessionId（从任务名和派单 key 推导），再按 wave.modelHint 的精确 provider/model/effort 创建成员，不重选档位。重试先核对同 ID：同父活会话等待；同父冷会话读取自身事件后通过宿主 `sendMessage` 续投；异主拒绝接管；确实无记录才同 ID 重建。读取不确定时保留映射并返回恢复指引，不把未知当不存在。标签由派单事实自动拼接。

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

## 续派：宿主 sendMessage（Lead 主动追问用 send_message）

- continuation=true 且有 expectedAgentId：先登记本轮 key 到原成员会话。同父活会话等待；同父冷会话检查排除继承前缀后的自身消息：已有本轮精确派单正文则只发续行提醒，只有旧上下文则投 wave.prompt 续派正文，无上下文则投 wave.promptFull 全量变体。两种正文均含当前基线。异主由原 Lead 继续或作废该波再派；确实断链才按本波 modelHint 新建，投全量变体并回填映射。查询、读取或回执不确定时按错误卡恢复；
- 用户点名换人（replace-owner）或映射缺失（expectedAgentIdMissing + resumeNote）：同一 fresh 重建通道。

初派、增量、全量、重建和冷轻提醒同消息追加适用原文段，不改冷收单对业务 text 块的精确匹配；仅规则更新不算未收单。角色/场景业务正文真的改变时沿原算法，不承诺总是轻提醒。live 零消息，不为刷新规范催单；缺资源诊断保留恢复指引，不以备用长规则或新门禁替代。

## 评审修订纪律（D5）

challenger/expert **同 key 重交修订版**（覆盖旧报告）后必须主动通知 Lead，Lead 重新 tw-dispatch 取波再转发——已按旧版意见派出的 respond 波不会自动更新依据。汇总包的完成标准应含"冲突归并"兜底（两版意见以修订版为准）。

## stop 处理（tw-dispatch 透传卡片后按型行动）

- stop: awaiting-user：先看卡片类型——**升档审批卡**（question 含"高于场景默认档"、choices 为 批准升档/降回默认档继续）：这是唯一的成本核算触点，卡内附包×档位×权重倍数（junior:senior:expert = 1:10:50），按价值判断后 `tw decide`（批准=按升档派发；拒绝=按场景默认档派发，本批不再询问）；**人工门卡**（choices 为 accept/rework）：向用户呈现，答案走 tw decide。awaiting-user 期间任务静止（不轮询、不代答、不越门）；
- stop: wait-inflight：tw-dispatch 逐条核对已登记或可续会话，按上述活/冷/异主/不存在四种现状恢复。未登记的派单先登记确定性 ID 再补派；缺 registered 判定字段或读取不确定时不自动补派，按卡片指引修复。agents.json 损坏时可通过 tw agent-map 重建登记；modelHint 不可解析且该波不应执行时用 tw retire 作废；
- stop: completed：问用户是否 tw archive；
- stop: blocked：核 card.blockers 与 recovery；涉及必要性/授权争议先请用户确认，不能将恢复提示当自行修复/扩权许可。明确授权后按原通道恢复。

## 作废未结波（tw retire）

- 触发：wait-inflight 卡或 dispatch-plan 输出中的未结波需要放弃时——如派错人、该波不再需要、迁移冲突已选保留版本等。waveId 直接取自卡内字段（P4：运行期卡自带 waveId，不手工编造）；
- 执行：`tw retire --task <名> --wave <wvN> --reason <原因>`（**仅 Lead**；reason 必填，写入 journal 的 `dispatch-superseded` 事件供审计）；
- 语义：只解除**未交付派发**的在途（该波不再等交付）；已交付报告保留为审计事实、不参与后续推导（投影/快照/依赖/轮次耗尽/续派回溯统一排除作废波）；该波 key 再被 deliver/review 会拒绝并提示「重新 tw-dispatch 取新卡」；
- 幂等矩阵：重复 retire 幂等返回；未知 waveId / 已结波 / 缺 reason 拒绝并附恢复指引（拒绝输出带当前未结波清单）；
- 后续：retire 后重新 tw-dispatch，波次机按剩余活跃包推进（多包波中已交付包照常进入评审链）；retire 与推进并发由任务锁串行化，状态一致。

## 拆包（tw plan）

- 判断要不要拆：目标含多个可独立验收的垂直范围且可写范围能互斥拆分才拆；共享热点收进一个包或设 dependsOn 汇总包；拆分粒度以"子 agent 高注意力"为准（每包一个清晰交付物）；拆分语义质量由 Lead 把关（runtime 只验机械属性：互斥/无环/完成标准在场）；
- writable 条目路径以 / 结尾 = 目录授权（如 "review/:code-review" 授权 review/ 下全部文件，deliver 与互斥判定都按目录前缀处理）；目录与其下路径视为重叠，不能分给两个包；
- dependsOn 汇总包 = 整合 Owner：完成标准必须含"合并各包结论、解决冲突、不丢信息"；
- 登记：tw plan --task <名> --packages '<JSON>'（形状 [{id, writable:["路径:kind"], done:["标准"], dependsOn:["包id"]}]）；待决卡片或在途派发时会被拒绝（先处理再拆；blocked 静止卡除外——重拆扩权正是它的恢复通道）；
- 复杂目标可先开只读子派单收集事实辅助判断拆分边界。
- 审查默认正式轻量交叉，一个 Owner 与非作者 Challenger 即可从互补角度核验，core Expert 照旧；不按视角数招募成员。确需独立交付才由 Lead 拆包，done 写明本包职责。复杂完整代码交付等确需全面覆盖或用户明确要求时由 Lead 组织一次八视角，返工先复核变更与关联视角，不每个成员、每轮重新展开。

## risk 与选人

- tw open --risk critical|high|normal（或 tw intent --risk 修订）：critical→expert Owner、high→senior（只升不降；challenger/expert 不变）。判断：不可逆/数据迁移/安全敏感/核心跨模块 → critical；常规 → normal；
- 模型来自当前 profile 的插件 Config `team-work-dsh.tiers`；同一 profile 跨项目共用，无项目覆盖。宿主每次操作通过 `TW_DSH_CONFIG` 传快照，`tw models` 显示 entry/profile 来源。三档兼容单对象或数组，provider/model 必填，family/effort 可选；同波优先不同家族，配置热变只影响后续波次，已派模型快照留在 journal。任务级 agents.json 只保存 mappings。
- 无宿主终端由编排调用方显式提供 `TW_DSH_CONFIG` JSON `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}`；不自动读旧 YAML 或项目 dsh.json、不写缓存。缺输入的选模返回 unresolved，平台无关操作仍可使用；
- 升级前备份旧 settings.yaml 与当前 profile 配置：宿主首次导入可能覆盖已有 tiers。旧文件已改名为 settings.yaml.imported 但导入失败时不自动重导，核对旧 tiers 后通过新页面保存；
- 宿主默认 maxDepth=1；正式成员再开只读助手需要用户允许至少两层，插件不自行提高上限，助手不得继续委托。

## 主动选档（原生普通委派）

- 输入框 `@junior` / `@senior` / `@expert` 与自然语言都表达选档意图，读取当前已保存的第一候选后以精确 provider/model 调原生 subagent；effort 转为 reasoning_effort。档位缺失明确 unresolved，不换成默认模型。正式波次成员一律 tw-dispatch；
- 档位价值主张：junior 速度优势显著、单位成本最低（批量探索/信息收集/初稿类默认）；senior 推理与性价比平衡（大多数常规开发任务默认）；expert 最强推理、最贵（只在高难度设计/疑难定位/关键技术裁决时用）；
- 普通精准选模受宿主开关和允许列表限制，旧会话可能须新建后才获得新权限。先查 list_subagent_models 路由；枚举目录未列出不代表不允许，应按 provider+model 精确查询并区分权限拒绝与解析失败。客户端没有精确只读校验 RPC，未广告候选保留草稿，不能据此声称模型不存在；正式创建仍由宿主 resolveCallConfig 实核。

## 成员标签（由 tw-dispatch 自动生成）

DSH 所有后台任务在**统一的子代理列表**混排，且侧栏从尾部截断（约 32 个半角字符）——**阶段是跨任务列表的第一分组建，必须最前**；简述殿后（被截断无害）。

标签格式 `阶段缩写·角色[@包] · 简述 #任务名`（任务段固定 ` #任务名`——前置空格+`#`+任务名）**由 tw-dispatch 自动拼接**：阶段缩写、角色、包、任务名四项全部来自派单事实（Runtime 自有，P4 簿记不向模型索要），Lead 不手工拼标签；唯一可定制成分是 tw-dispatch 的可选 `note` 参数（简述，≤4 个中文词、不含 `#`，含包语义时可省 @包；缺省自动生成 任务名-角色-轮次）。

机制固定成分（无需记忆，仅供人读）：阶段缩写表 RES=调研 DESIGN=方案（design 与 design-review 同缩写）SPEC=SPEC（spec 与 spec-review 同缩写）IMPL=实现 TEST=测试 CR=代码审查 E2E=端到端 FIN=收尾；角色 owner / chal（challenger）/ expert；多包波带 @包（包 id 用自然短词 ≤10 字符），单包省略。

示例：`CR·owner@store · 模块说明 #task-a` / `CR·chal · 文档整合评审 #task-a` / `IMPL·owner@api · task-a-owner-r1 #task-a`（缺省 note 形态）。

- 只读子派单由原生工具派发，可用 `RO` 标签如 `CR·RO · 并发扫描`；它不是正式团队成员，不登记到任务波次；
- 标签只用于展示；精确模型在创建时传给宿主，续派映射由 tw agent-map 登记，标签不承担机器寻址。
