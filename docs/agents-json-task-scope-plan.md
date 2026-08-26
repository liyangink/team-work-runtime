# agents.json 任务级迁移方案：注册表物理归属任务（硬切，无兼容）

状态：待用户批准后实施。缺陷定性（用户裁决+证据闭环）：agents.json 记录的全部键（mappings/modelHints/tagHints/pendingTags）均任务特定（dispatchKey/childId 任务作用域），却放在项目级共享文件——这是 8e585ae 标签规范移除任务名后的实现妥协，引发跨任务覆盖窗口与锁面复杂度。修正：注册表迁任务级，键空间天然任务作用域。

## 1. 证据链（已核实）

- 107485c（v3.2 第一批）：标签规范 <任务名>.<阶段>.<角色>[@<包>]，agents.json 项目级引入（当时仅 mappings 单键，key 任务作用域掩盖了共享问题）；
- 8e585ae（同日）：标签规范改 阶段·角色[@包] · 简述（任务名移除，理由=列表分组建）；
- b76e3c5/4337295（标签寻址/自动回填）：pendingTags[标签]=key 落入项目级键空间，任务身份缺失引爆残余窗口；
- 用户裁决：数据任务特定 → 物理归属任务目录；未正式发布 → 硬切不兼容。

## 2. 方案

### 2.1 数据面：任务级注册表

- 路径：.team-work/tasks/<任务>/agents.json（与 journal.jsonl 同层）；项目级 .team-work/platform/agents.json 弃用（硬切，旧文件忽略不读不写）。
- 键面不变（mappings/modelHints/tagHints/pendingTags），但全部落在任务目录——键空间任务作用域，pendingTags 同标签覆盖窗口自然消灭（同任务同标签串行派发，task.lock 保证）。
- 锁面简化：任务内写入沿用 task.lock（与 journal 同锁域），不再需要项目级 agents.lock（F-2 问题随迁移消失）。

### 2.2 标签形态（待用户拍板，推荐 A）

- **定稿（用户思路）**：`阶段·角色[@包] · 简述 #任务名`——任务段**殿后**（仅 runtime 关注，用户不一定看；UI 侧栏约 32 半角截断先丢殿后段，数据不截——descriptor.data.label 存完整 description，宿主无 maxLength 硬限已核实）。解析三重防线：①形态约束——任务段=最后一个 # 之后全串，匹配 NAME_RE（[a-z0-9][a-z0-9-]{0,63}）且位于最末尾；②**事实源校验**——候选任务名必须真实存在（.team-work/tasks/<名>/ 目录在场），否则视作无任务段降级（简述误写 #42 不误注入）；③skill 显式规范——简述不得以 # 结尾。缺失/畸形/目录不在场 → 降级回退链（不注入+warn），不硬失败。
- （B 形态——任务名前置——已随定稿废弃：会牺牲 8e585ae 的列表分组建价值。）

### 2.3 runtime（三个写入者全部已知 --task）

- persistTagHints / agent-map / dispatch-plan 读写的 agents.json 路径改任务级（task.root 下）；锁用 task.lock（已有持锁上下文）。归零机制表述（评审 R5 修正）：task.lock 只串行化单次写；残余窗口真正归零靠"派发（持锁写 tagHints/pendingTags）→ Lead 得卡 → 派子代（平台同步 materialize 创建完成）→ 回填"的时序事实——同任务串行 + 子代创建晚于派发锁释放；
- 删除项目级 agents.lock 依赖与项目级文件逻辑。

### 2.4 插件（标签解析出任务名 → 任务级路径）

- 事实源校验实现（评审 R6）：contribution 同步段 accessSync 任务目录；"目录在场但 agents.json 缺失/损坏"定义降级态=三态回退的②（warn + childId 补读尝试，同文件缺失则放弃）；

- parseLabelTag 扩展：机器段解析出 {stage, role, pkg, task}（A 形态的 # 段）；
- contribution 同步段：label 含任务名 → 定位 .team-work/tasks/<任务>/agents.json → tagHints 注入 + mappings 回填（原逻辑不变，路径换任务级）；
- 无任务名标签（畸形/旧习惯）→ 无法定位任务级文件 → 不注入 + warn 指引（评审 R1 修正：有任务段但 tagHints 未命中时，同文件内 modelHints[childId] 补读仍有效；无任务段才是补读也失效的终态）。

## 3. 验证面

- 单元：标签解析（A 形态含任务名/畸形）；任务级路径构造；persistTagHints/agent-map 写任务级文件；回填任务级；跨任务同标签无覆盖（两任务各自文件，天然隔离断言）；
- 旧项目级文件忽略（硬切断言：不读不写）；
- E2E：真机两任务同标签并发派发——mappings 各归各（残余窗口消灭的实锤）。

## 4. 硬切影响面

- 现有真机/测试环境的项目级 agents.json 全部弃用（无需迁移）；归档语义（评审 R3）：task 归档/删除时任务级 agents.json 随任务目录走（rm taskRoot 即删）；硬切后既有在途任务续派首轮降级 expectedAgentIdMissing（一次性损失，接受——未发布）；
- 测试 fixtures（v3-fixtures/makeProject 等）的 agents.json 路径断言全改；
- 文档：README/skill（标签规范加 #任务名 段）/roadmap/方案 v2 全同步。

## 5. 影响文件

runtime-v3/cli.mjs、dsh/inject.js、skills 标签规范（含 :14 旧格式残留）、tests 多处（8 个文件显式项目级路径拼接 + 反转断言）、docs/README/AGENTS ≥7 处。
## 6. 评审 findings 处置记录（2026-08-26）

| # | 结论 | 处置 |
| R1 补读措辞过度 | 有 task 段但 tagHints miss 时 modelHints[childId] 同文件仍补读 | §2.4 已修 |
| R2 影响面低估 | ≥7 文档 + README + AGENTS 引用项目级 agents.json | 实施清单同步（§5） |
| R3 归档语义未写 | rm taskRoot 随删；硬切后既有任务续派降级 expectedAgentIdMissing（一次性损失，接受） | §4 补 |
| R4 测试缺项+断言反转 | 残余窗口断言必须反转（迁移后各归各）；补 cold-resume 解析/事实源校验/无 task 降级/归档语义/跨进程争用 | §3 扩 |
| R5 归零机制过度简化 | task.lock 只串行化单次写，归零靠子代创建时序 | §2.3 已修 |
| R6 目录在场但文件缺失降级未定义 | accessSync 目录校验 + 缺失降级态定义 | §2.4 已修 |
| I1 commit 措辞 | 尾部截断先丢殿后段（任务段在殿后） | 表述统一 |
| I2-I5 文档小修 | label 措辞/dsh-orchestration:14 旧格式残留/index.js:60 注释 | 实施清单 |
