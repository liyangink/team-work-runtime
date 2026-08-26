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

- **A（推荐）**：`阶段·角色[@包]#任务名 · 简述`——机器段 = 阶段·角色[@包]#任务名（# 定界，任务名=a-z0-9-，机器可读）；阶段仍第一（保留 8e585ae 的分组建价值——你当时提的事实：列表混排按阶段分组）；续派轮标签不变（任务名+阶段+角色[@包] 全相同）。
- **B（回归原始）**：`任务名·阶段·角色[@包] · 简述`——完全回归 107485c 原始设计；代价=列表分组退化为按任务名排序（8e585ae 的动机失效）。

### 2.3 runtime（三个写入者全部已知 --task）

- persistTagHints / agent-map / dispatch-plan 读写的 agents.json 路径改任务级（task.root 下）；锁用 task.lock（已有持锁上下文）；
- 删除项目级 agents.lock 依赖与项目级文件逻辑。

### 2.4 插件（标签解析出任务名 → 任务级路径）

- parseLabelTag 扩展：机器段解析出 {stage, role, pkg, task}（A 形态的 # 段）；
- contribution 同步段：label 含任务名 → 定位 .team-work/tasks/<任务>/agents.json → tagHints 注入 + mappings 回填（原逻辑不变，路径换任务级）；
- 无任务名标签（畸形/旧习惯）→ 三态回退的降级态（childId 补读已随文件迁移死亡——无任务名=无法定位文件=不注入，warn 指引）。

## 3. 验证面

- 单元：标签解析（A 形态含任务名/畸形）；任务级路径构造；persistTagHints/agent-map 写任务级文件；回填任务级；跨任务同标签无覆盖（两任务各自文件，天然隔离断言）；
- 旧项目级文件忽略（硬切断言：不读不写）；
- E2E：真机两任务同标签并发派发——mappings 各归各（残余窗口消灭的实锤）。

## 4. 硬切影响面

- 现有真机/测试环境的项目级 agents.json 全部弃用（无需迁移）；
- 测试 fixtures（v3-fixtures/makeProject 等）的 agents.json 路径断言全改；
- 文档：README/skill（标签规范加 #任务名 段）/roadmap/方案 v2 全同步。

## 5. 影响文件

runtime-v3/cli.mjs、dsh/inject.js、skills 标签规范、tests 多处、docs 三处。
