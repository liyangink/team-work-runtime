# DSH 编排：Lead 派发操作规程（v3.2）

平台事实：workflow 的 agent() 一次性无句柄（不能承载持续角色）；**续聊原语 = 后台 subagent（持久 id、可命名）+ send_message（仅 depth-1 直接子代）**。因此：凡需要多轮续派的成员（owner 修 rework、challenger 复审、expert 重裁），首次派发就必须在 Lead 层开 subagent；workflow 只用于一次性扇出。

## 派发决策表（每轮 dispatch-plan 按 wave 字段机械执行）

tw dispatch-plan --task <名> --json 取计划 → 对 waves[] 逐条：

| wave 字段 | 动作 |
| --- | --- |
| 多 owners（package 各异）、continuation=false | 每包开一个**后台 subagent**：label 按标签规范 `阶段缩写·角色[@包] · 简述 #任务名`（见下文标签规范节，机器段+任务段即注入寻址键）；prompt 原样转发；**无需 agent-map 登记**——插件按标签自动注入并回填续派映射（仅无标签/回填失败/换人纠错时才 agent-map） |
| continuation=true 且有 expectedAgentId | 对该 subagent send_message（消息 = wave.prompt 增量派单全文）；**不要开新 agent** |
| continuation=true 但 send_message 失败/会话不可用 | 降级规程：按 prompt 全量新开 fresh subagent + 重新 agent-map（用户点名换人 replace-owner 走同一通道） |
| role=challenger（scope=consolidation）| 单个 challenger subagent（label 按标签规范机器段 `阶段缩写·chal · 简述 #任务名`），组合制品视角 |
| role=expert | 单个 expert subagent；verdict 通过派单内嵌的 review 调用提交 |
| 一次性探查（成员自派） | 成员用只读子派单（junior、可写空、workflow parallel），不占团队波次 |

外层循环：dispatch-plan → 按表派发 → 等成员通知（成员自行调 tw deliver/review，派单已内嵌绝对路径指令）→ 再 dispatch-plan……直到 stop。

## 评审修订纪律（D5）

challenger/expert **同 key 重交修订版**（覆盖旧报告）后必须主动通知 Lead，Lead 重新 `dispatch-plan` 取波再转发——已按旧版意见派出的 respond 波不会自动更新依据。汇总包的完成标准应含"冲突归并"兜底（两版意见以修订版为准）。

## stop 处理

- stop: awaiting-user：先看卡片类型——**升档审批卡**（question 含"高于场景默认档"、choices 为 批准升档/降回默认档继续）：这是唯一的成本核算触点，卡内附包×档位×权重倍数（junior:senior:expert = 1:10:50），按价值判断后 `tw decide`（批准=按升档派发；拒绝=按场景默认档派发，本批不再询问）；**人工门卡**（choices 为 accept/rework）：向用户呈现，答案走 tw decide。awaiting-user 期间任务静止（不轮询、不代答、不越门）；
- stop: wait-inflight：有成员未交付。用卡内嵌的 inflight[]（原派单全文）原样补派——continuation 且有 expectedAgentId 则 send_message；无 expectedAgentId（回填失败/无标签）则新开同标签 fresh subagent（插件自愈覆盖）或 agent-map 兜底；send_message 失败 → 降级新开 fresh（见标签规范节）。
- stop: completed：问用户是否 tw archive；
- stop: blocked：读 card.blockers（对象数组，每条带 recovery）修复后继续。

## 拆包（tw plan）

- 判断要不要拆：目标含多个可独立验收的垂直范围且可写范围能互斥拆分才拆；共享热点收进一个包或设 dependsOn 汇总包；拆分粒度以"子 agent 高注意力"为准（每包一个清晰交付物）；拆分语义质量由 Lead 把关（runtime 只验机械属性：互斥/无环/完成标准在场）；
- dependsOn 汇总包 = 整合 Owner：完成标准必须含"合并各包结论、解决冲突、不丢信息"；
- 登记：tw plan --task <名> --packages '<JSON>'（形状 [{id, writable:["路径:kind"], done:["标准"], dependsOn:["包id"]}]）；待决卡片或在途派发时会被拒绝（先处理再拆）；
- 复杂目标可先开只读子派单收集事实辅助判断拆分边界。

## risk 与选人

- tw open --risk critical|high|normal（或 tw intent --risk 修订）：critical→expert Owner、high→senior（只升不降；challenger/expert 不变）。判断：不可逆/数据迁移/安全敏感/核心跨模块 → critical；常规 → normal；
- 模型只来自 DSH 全局 settings 的 `team-work-dsh.tiers`（`tw models` 查看来源）：可在 DSH Web 的“插件配置”页编辑；档位兼容单个候选对象或候选数组，同波多 owner 自动优先不同模型家族，`effort` 可选。每个候选必须有非空 provider/model；全局配置变化只影响后续 dispatch-plan，已派发波次沿用其记录的 modelHint 快照。项目 `.team-work/platform/dsh.json` 不参与读取或创建，遗留文件可手动删除；`agents.json` 仍是 child 映射与快照事实。

## 成员标签规范

DSH 所有后台任务在**统一的子代理列表**混排，且侧栏从尾部截断（约 32 个半角字符）——**阶段是跨任务列表的第一分组建，必须最前**；简述殿后（被截断无害）。

格式：`阶段·角色[@包] · 简述 #任务名`（任务段固定 ` #任务名`——前置空格+`#`+任务名，殿后；任务名=tw open 的名字）

- **阶段缩写固定表**（同阶段同缩写，不许自由发挥）：RES=调研 DESIGN=方案 SPEC=SPEC IMPL=实现 TEST=测试 CR=代码审查 E2E=端到端 FIN=收尾；
- **角色**：owner / chal（challenger 固定缩写，省 6 字符）/ expert；
- **@包**：多包任务才带；包 id 用自然短词（≤10 字符，如 store/intake/overview）——tw plan 对超 12 字符的包 id 给可读性警告；单包任务省略 @包；
- **简述**：≤4 个中文词（8 半角字符），含包语义时可不带 @包。

示例：`CR·owner@store · 模块说明 #task-a` / `CR·chal · 文档整合评审 #task-a` / `IMPL·owner@api · 接口改造 #task-a`

- 只读子派单前缀：`CR·RO · 并发扫描`（RO=read-only 一次性，非团队成员；只读子派单无需任务段）；
- **简述不含 `#`**（任务段是唯一 ` #` 定界——简述里写 `#` 会被误解析为任务段候选，虽经目录存在性校验兜底，但可能撞上同名任务名）；
- 禁止：派单 key、哈希、轮次号做标签（续派轮标签不变，同一成员可辨认）。
- **机器段是模型注入的寻址键**（`阶段缩写·角色[@包]` + 任务段 ` #任务名`）：机器段必须逐字符用固定表，简述可自由但不得含第二个机器段格式；任务段决定任务级注册表定位。机器段/任务段写错 = 该子代退化为默认模型（不阻塞任务，注入日志有 warn）。
