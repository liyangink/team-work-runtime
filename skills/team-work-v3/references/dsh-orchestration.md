# DSH 编排：Lead 派发操作规程（v3.3；工作流派发工具 tw-dispatch）

平台事实：workflow 的 agent() 一次性无句柄（不能承载持续角色）；**续聊原语 = 后台 subagent（持久 id、可命名）+ send_message（仅 depth-1 直接子代）**。因此：凡需要多轮续派的成员（owner 修 rework、challenger 复审、expert 重裁），首次派发就必须在 Lead 层开子代理；workflow 只用于一次性扇出。

## 波次推进：一律 tw-dispatch

**波次推进一律先调 `tw-dispatch`（{ task, note?, writables? }）**——单次调用完成一个波次的完整派发：

1. 内部子进程调 `tw dispatch-plan --task <名> --json`（writables 透传）推进到派发点或 stop；
2. 波次机不在派发点时（awaiting-user / wait-inflight / completed / blocked / archived 卡，含拒绝卡）**原样透传卡片**，不创建任何子代理——Lead 按卡片行动；
3. 在派发点时对每张派单自动完成三步：按 wave.modelHint 创建子代理（target 直取 provider/model/effort，**不重选档位**）→ `tw agent-map` 登记 dispatchKey→childId 续派映射 → 标签按派单事实自动拼接（见「成员标签」）。

返回逐项结果 `[{key, sessionId, provider/model/effort, 标签, registered}]`。单张失败不回滚已成功项，按该项 message 的指引恢复（登记失败可用 tw agent-map 补登记；勿重复创建，避免重复派单）。

**Lead 推进循环 = 反复调 tw-dispatch 直到终态卡片**，不再需要「先 run/dispatch-plan 看卡、再决定怎么派」的双工具交替。

三工具分工（情境判据是「有无进行中的任务波次」，不依赖记忆）：

| 情境 | 工具 |
| --- | --- |
| 正在推进 team-work 任务（派波次成员/推进一步） | tw-dispatch |
| 非工作流委派：只读子派单、用户 @档位、并行调查、独立审查等 | tw-tool-subagent |
| 任务簿记：决定、门禁查询、交付、评审、补登记 | tw |

## 续派：send_message（不经 tw-dispatch）

- continuation=true 且有 expectedAgentId：对该 subagent **send_message**（消息 = wave.prompt 增量派单全文）；**不要开新 agent**。tw-dispatch 对这类波不创建，只返回 send_message 指引（含 expectedAgentId）；
- send_message 失败/会话不可用：降级为 fresh 新建——dispatch-plan 对映射缺失的续派波输出 expectedAgentIdMissing + resumeNote，此时重新 tw-dispatch 即按创建路径新建子代理并登记新映射；用户点名换人（replace-owner）走同一通道。

## 评审修订纪律（D5）

challenger/expert **同 key 重交修订版**（覆盖旧报告）后必须主动通知 Lead，Lead 重新 tw-dispatch 取波再转发——已按旧版意见派出的 respond 波不会自动更新依据。汇总包的完成标准应含"冲突归并"兜底（两版意见以修订版为准）。

## stop 处理（tw-dispatch 透传卡片后按型行动）

- stop: awaiting-user：先看卡片类型——**升档审批卡**（question 含"高于场景默认档"、choices 为 批准升档/降回默认档继续）：这是唯一的成本核算触点，卡内附包×档位×权重倍数（junior:senior:expert = 1:10:50），按价值判断后 `tw decide`（批准=按升档派发；拒绝=按场景默认档派发，本批不再询问）；**人工门卡**（choices 为 accept/rework）：向用户呈现，答案走 tw decide。awaiting-user 期间任务静止（不轮询、不代答、不越门）；
- stop: wait-inflight：有成员未交付，卡内嵌 inflight[]（原派单全文）——有 expectedAgentId 则 send_message 补派；无（映射缺失）则 tw-tool-subagent 按 prompt 全量新建 fresh 子代理（target 取该派单 modelHint）并 tw agent-map 登记新映射；send_message 失败走同一新建降级；
- stop: completed：问用户是否 tw archive；
- stop: blocked：读 card.blockers（对象数组，每条带 recovery）修复后重新 tw-dispatch。

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

## risk 与选人

- tw open --risk critical|high|normal（或 tw intent --risk 修订）：critical→expert Owner、high→senior（只升不降；challenger/expert 不变）。判断：不可逆/数据迁移/安全敏感/核心跨模块 → critical；常规 → normal；
- 模型只来自 DSH 全局 settings 的 `team-work-dsh.tiers`（`tw models` 查看来源）：可在 DSH Web 的"插件配置"页编辑；档位兼容单个候选对象或候选数组，同波多 owner 自动优先不同模型家族，`effort` 可选。每个候选必须有非空 provider/model；全局配置变化只影响后续 dispatch-plan，已派发波次沿用其记录的 modelHint 快照。项目 `.team-work/platform/dsh.json` 不参与读取或创建，遗留文件可手动删除；任务级 `agents.json` 只保存 dispatchKey→childId 续派映射（模型选择由 tw-dispatch 创建子代理时经 target 直取 modelHint，不经 agents.json 中转）。

## 主动选档（tw-tool-subagent；非工作流委派）

- 输入框 `@junior` / `@senior` / `@expert` 候选与自然语言（如"让 senior 处理 X"）都只是表达选档意图的两种输入方式，实际委派统一由 **tw-tool-subagent** 执行；team-work 波次成员不适用（一律 tw-dispatch）；
- 档位价值主张：junior 速度优势显著、单位成本最低（批量探索/信息收集/初稿类默认）；senior 推理与性价比平衡（大多数常规开发任务默认）；expert 最强推理、最贵（只在高难度设计/疑难定位/关键技术裁决时用）；
- 与原生 subagent 的分工：不选模型、接受继承平台默认选择，或需要前台/一次性模式/继承父会话上下文（subagent_fork）时用原生工具；继续已存在的子会话用 send_message。

## 成员标签（由 tw-dispatch 自动生成）

DSH 所有后台任务在**统一的子代理列表**混排，且侧栏从尾部截断（约 32 个半角字符）——**阶段是跨任务列表的第一分组建，必须最前**；简述殿后（被截断无害）。

标签格式 `阶段缩写·角色[@包] · 简述 #任务名`（任务段固定 ` #任务名`——前置空格+`#`+任务名）**由 tw-dispatch 自动拼接**：阶段缩写、角色、包、任务名四项全部来自派单事实（Runtime 自有，P4 簿记不向模型索要），Lead 不手工拼标签；唯一可定制成分是 tw-dispatch 的可选 `note` 参数（简述，≤4 个中文词、不含 `#`，含包语义时可省 @包；缺省自动生成 任务名-角色-轮次）。

机制固定成分（无需记忆，仅供人读）：阶段缩写表 RES=调研 DESIGN=方案（design 与 design-review 同缩写）SPEC=SPEC（spec 与 spec-review 同缩写）IMPL=实现 TEST=测试 CR=代码审查 E2E=端到端 FIN=收尾；角色 owner / chal（challenger）/ expert；多包波带 @包（包 id 用自然短词 ≤10 字符），单包省略。

示例：`CR·owner@store · 模块说明 #task-a` / `CR·chal · 文档整合评审 #task-a` / `IMPL·owner@api · task-a-owner-r1 #task-a`（缺省 note 形态）。

- 只读子派单（tw-tool-subagent 直发，不经 tw-dispatch）仍按此格式手工写标签，前缀 `RO`：如 `CR·RO · 并发扫描`（一次性只读，非团队成员，无任务段）；
- **标签是纯展示语义**：模型选择由创建时 target 直达、续派映射由 tw agent-map 登记，标签写错只影响人读分组与检索，不影响模型注入、续派与任务推进。固定格式仅为侧栏跨任务列表的人读分组保留。
