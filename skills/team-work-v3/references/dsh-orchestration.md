# DSH 编排：Lead 派发操作规程（v3.2；定向委派第二阶段）

平台事实：workflow 的 agent() 一次性无句柄（不能承载持续角色）；**续聊原语 = 后台 subagent（持久 id、可命名）+ send_message（仅 depth-1 直接子代）**。因此：凡需要多轮续派的成员（owner 修 rework、challenger 复审、expert 重裁），首次派发就必须在 Lead 层开子代理；workflow 只用于一次性扇出。首派统一用 **tw-tool-subagent**（定向选模）：target 直接采用 dispatch-plan 已固化的 modelHint，不重选档位。

## 派发决策表（每轮 dispatch-plan 按 wave 字段机械执行）

tw dispatch-plan --task <名> --json 取计划 → 对 waves[] 逐条：

| wave 字段 | 动作 |
| --- | --- |
| 多 owners（package 各异）、continuation=false | 每包新建一个子代理：调 **tw-tool-subagent**，description=标签（按标签规范 `阶段缩写·角色[@包] · 简述 #任务名`，纯展示）；prompt=wave.prompt 原样转发；target=wave.modelHint 的 provider/model（含 effort 时带上），**不重选 tier**；拿到返回的 sessionId 后 **tw agent-map --task <名> --key <dispatchKey> --agent <sessionId>** 登记续派映射（每包必登记，无自动回填） |
| continuation=true 且有 expectedAgentId | 对该 subagent send_message（消息 = wave.prompt 增量派单全文）；**不要开新 agent** |
| continuation=true 但 send_message 失败/会话不可用 | 降级规程：tw-tool-subagent 按 prompt 全量新开 fresh 子代理（target 取该 wave 的 modelHint）+ 重新 agent-map（用户点名换人 replace-owner 走同一通道） |
| role=challenger（scope=consolidation）| 单个 challenger 子代理（同上经 tw-tool-subagent，标签机器段 `阶段缩写·chal · 简述 #任务名`），组合制品视角 |
| role=expert | 单个 expert 子代理（同上经 tw-tool-subagent）；verdict 通过派单内嵌的 review 调用提交 |
| 一次性探查（成员自派） | 成员用只读子派单（tw-tool-subagent tier=junior、可写空、workflow parallel），不占团队波次 |

外层循环：dispatch-plan → 按表派发（首派 tw-tool-subagent + agent-map 登记；续派 send_message）→ 等成员通知（成员自行调 tw deliver/review，派单已内嵌绝对路径指令）→ 再 dispatch-plan……直到 stop。

## 评审修订纪律（D5）

challenger/expert **同 key 重交修订版**（覆盖旧报告）后必须主动通知 Lead，Lead 重新 `dispatch-plan` 取波再转发——已按旧版意见派出的 respond 波不会自动更新依据。汇总包的完成标准应含"冲突归并"兜底（两版意见以修订版为准）。

## stop 处理

- stop: awaiting-user：先看卡片类型——**升档审批卡**（question 含"高于场景默认档"、choices 为 批准升档/降回默认档继续）：这是唯一的成本核算触点，卡内附包×档位×权重倍数（junior:senior:expert = 1:10:50），按价值判断后 `tw decide`（批准=按升档派发；拒绝=按场景默认档派发，本批不再询问）；**人工门卡**（choices 为 accept/rework）：向用户呈现，答案走 tw decide。awaiting-user 期间任务静止（不轮询、不代答、不越门）；
- stop: wait-inflight：有成员未交付。用卡内嵌的 inflight[]（原派单全文）原样补派——continuation 且有 expectedAgentId 则 send_message；无 expectedAgentId（映射缺失）则 tw-tool-subagent 新建 fresh 子代理并 agent-map 登记新映射；send_message 失败 → 同一降级规程。
- stop: completed：问用户是否 tw archive；
- stop: blocked：读 card.blockers（对象数组，每条带 recovery）修复后继续。

## 作废未结波（tw retire）

- 触发：wait-inflight 卡或 dispatch-plan 输出中的未结波需要放弃时——如派错人、该波不再需要、迁移冲突已选保留版本等。waveId 直接取自卡内字段（P4：运行期卡自带 waveId，不手工编造）；
- 执行：`tw retire --task <名> --wave <wvN> --reason <原因>`（**仅 Lead**；reason 必填，写入 journal 的 `dispatch-superseded` 事件供审计）；
- 语义：只解除**未交付派发**的在途（该波不再等交付）；已交付报告保留为审计事实、不参与后续推导（投影/快照/依赖/轮次耗尽/续派回溯统一排除作废波）；该波 key 再被 deliver/review 会拒绝并提示「重新 tw run 取新卡」；
- 幂等矩阵：重复 retire 幂等返回；未知 waveId / 已结波 / 缺 reason 拒绝并附恢复指引（拒绝输出带当前未结波清单）；
- 后续：retire 后重新 dispatch-plan / run，波次机按剩余活跃包推进（多包波中已交付包照常进入评审链）；retire 与 run 并发由任务锁串行化，状态一致。

## 拆包（tw plan）

- 判断要不要拆：目标含多个可独立验收的垂直范围且可写范围能互斥拆分才拆；共享热点收进一个包或设 dependsOn 汇总包；拆分粒度以"子 agent 高注意力"为准（每包一个清晰交付物）；拆分语义质量由 Lead 把关（runtime 只验机械属性：互斥/无环/完成标准在场）；
- writable 条目路径以 / 结尾 = 目录授权（如 "review/:code-review" 授权 review/ 下全部文件，deliver 与互斥判定都按目录前缀处理）；目录与其下路径视为重叠，不能分给两个包；
- dependsOn 汇总包 = 整合 Owner：完成标准必须含"合并各包结论、解决冲突、不丢信息"；
- 登记：tw plan --task <名> --packages '<JSON>'（形状 [{id, writable:["路径:kind"], done:["标准"], dependsOn:["包id"]}]）；待决卡片或在途派发时会被拒绝（先处理再拆；blocked 静止卡除外——重拆扩权正是它的恢复通道）；
- 复杂目标可先开只读子派单收集事实辅助判断拆分边界。

## risk 与选人

- tw open --risk critical|high|normal（或 tw intent --risk 修订）：critical→expert Owner、high→senior（只升不降；challenger/expert 不变）。判断：不可逆/数据迁移/安全敏感/核心跨模块 → critical；常规 → normal；
- 模型只来自 DSH 全局 settings 的 `team-work-dsh.tiers`（`tw models` 查看来源）：可在 DSH Web 的"插件配置"页编辑；档位兼容单个候选对象或候选数组，同波多 owner 自动优先不同模型家族，`effort` 可选。每个候选必须有非空 provider/model；全局配置变化只影响后续 dispatch-plan，已派发波次沿用其记录的 modelHint 快照。项目 `.team-work/platform/dsh.json` 不参与读取或创建，遗留文件可手动删除；任务级 `agents.json` 只保存 dispatchKey→childId 续派映射（模型选择由 tw-tool-subagent 创建子代理时直接指定，不经 agents.json 中转）。

## 主动选档（tw-tool-subagent）

- 输入框 `@junior` / `@senior` / `@expert` 候选与自然语言（如"让 senior 处理 X"）都只是表达选档意图的两种输入方式，实际委派统一由 **tw-tool-subagent** 执行；
- 档位价值主张：junior 速度优势显著、单位成本最低（批量探索/信息收集/初稿类默认）；senior 推理与性价比平衡（大多数常规开发任务默认）；expert 最强推理、最贵（只在高难度设计/疑难定位/关键技术裁决时用）；
- 引导：不确定优先 senior，明确高难度才升 expert，大量低风险基础工作下沉 junior；不处于 team-work 工作流时同样可用（信息收集、并行调查、独立审查等普通委派）；
- 与原生 subagent 的分工：不选模型、接受继承平台默认选择，或需要前台/一次性模式/继承父会话上下文（subagent_fork）时用原生工具；继续已存在的子会话用 send_message。

## 成员标签规范

DSH 所有后台任务在**统一的子代理列表**混排，且侧栏从尾部截断（约 32 个半角字符）——**阶段是跨任务列表的第一分组建，必须最前**；简述殿后（被截断无害）。

格式：`阶段·角色[@包] · 简述 #任务名`（任务段固定 ` #任务名`——前置空格+`#`+任务名，殿后；任务名=tw open 的名字）

- **阶段缩写固定表**（同阶段同缩写，不许自由发挥）：RES=调研 DESIGN=方案 SPEC=SPEC IMPL=实现 TEST=测试 CR=代码审查 E2E=端到端 FIN=收尾；
- **角色**：owner / chal（challenger 固定缩写，省 6 字符）/ expert；
- **@包**：多包任务才带；包 id 用自然短词（≤10 字符，如 store/intake/overview）——tw plan 对超 12 字符的包 id 给可读性警告；单包任务省略 @包；
- **简述**：≤4 个中文词（8 半角字符），含包语义时可不带 @包。

示例：`CR·owner@store · 模块说明 #task-a` / `CR·chal · 文档整合评审 #task-a` / `IMPL·owner@api · 接口改造 #task-a`

- 只读子派单前缀：`CR·RO · 并发扫描`（RO=read-only 一次性，非团队成员；只读子派单无需任务段）；
- **简述不含 `#`**（任务段是唯一 ` #` 定界——简述里写 `#` 会破坏人读分组时对任务段的辨认）；
- 禁止：派单 key、哈希、轮次号做标签（续派轮标签不变，同一成员可辨认）。
- **标签是纯展示语义**（定向委派第二阶段后不再承担机器寻址）：模型选择由 tw-tool-subagent 创建子代理时直接指定，续派映射由 tw agent-map 登记；标签写错只影响人读分组与检索，不影响模型注入、续派与任务推进。固定格式保留是为侧栏跨任务列表的人读分组——阶段、角色、任务三段仍是辨认成员的主要线索，请仍按固定表书写。
