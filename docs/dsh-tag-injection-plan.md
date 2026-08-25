# 注入寻址回归方案 v2：标签（阶段·角色[@包]）同步注入

状态：自复核+交叉评审完成（8 findings 全处置，见 §6），待用户批准后实施。

## 1. 背景与偏差链（不变，见 v1）

标签寻址是用户最初设计：子代 description 按标签规范（阶段·角色[@包]）写身份，插件创建时即注入；childId 仅供续聊记账。v1 曾误用 tw:<key> 作标签，与 skill 标签禁则（禁 key/哈希/轮次号）冲突，v2 回归阶段·角色标签。

## 2. 方案

### 2.1 标签约定（复用现有 skill 标签规范，零新增规则）

子代 description = 现有标签规范格式（阶段·角色[@包]，如 code-review·owner@store）。续派轮同包同角色标签不变。无机器前缀，Lead 列表零噪声。

### 2.2 runtime 侧（agents.json 数据面）

- 新增 tagHints：标签 → {provider, model, effort}。dispatched 事件落盘时**自动写入**（detail.modelHint 快照已在派发卡，P4 零转录）；同标签续派时新快照覆盖旧值（标签不变 hint 更新）。
- 并发面：agents.json 写入加项目级 owner 锁（与 task 锁同源 persistence 原语），跨任务并发派发不踩踏。
- 陈旧面（实施修正）：标签键**不含任务身份**（标签规范天然是跨任务分组语义，归档无法精确归属清理）——语义定为“tagHints 是最近一次同标签派发的快照，同标签新派发即覆盖”；陈旧值仅影响无对应新派发的异常子代（本就无注入资格），低风险。跨任务同标签并发覆盖亦受此语义约束（同标签同角色 tier 同源，快照仅家族去重差异，边缘可接受）。
- modelHints（childId 键）与 mappings 保留：续聊映射与兼容过渡。

### 2.3 插件侧（contribution 同步注入，承重墙已静态证实）

- 静态调用链（评审实证）：seedDescriptorTurn→materialize→agents.create({seed,setup})；agent-loop 先建 session（seed 含 seq0 descriptor）→setup 回调→contribution。同步段 agent.session.events 必含 descriptor。
- 同步段：events 取 descriptor → 解析 label 为阶段·角色[@包] → readFileSync 读 agents.json 的 tagHints → 命中且 hint 合法即写 selection.current（首轮生效）→ installModelSelection。
- 三态回退全序：①标签合法且 tagHints 命中且 hint 合法 → 同步注入，stopped=true（与补读互斥，防覆盖）；②标签在但 hint 缺/畸形 → warn + 降级 childId 补读；③无标签/解析失败 → 现状（childId 补读）。
- 读文件：readFileSync 阻塞首读（文件 <1KB，毫秒级；现行代码已有该基础设施）——同步段可行。

### 2.4 家族去重与 effort

- tagHints 存的是 dispatch 时快照（波内家族去重已应用），标签通道不重算去重。
- 续聊不变量：同 child 跨轮 effort 不变（contribution 仅创建/恢复时跑；后续 agent-map 改 effort 不热改已注入子代——避免 thinking 历史断裂 400）。文档化 + 验证面断言首请求 header 含 reasoningEffort。

## 3. 验证面

- 单元：label 解析（阶段·角色[@包] 合法/缺失/畸形三态）；tagHints 自动落盘与续派覆盖、项目级锁并发、归档清理；同步注入桩（contribution 不 await 即注入）；三态回退全序；resume 幂等（重复注入同 hint 无害）单测。
- E2E：带标签派发真实子代 → 首请求 header 即注入 provider/model/reasoningEffort（对比当前首轮默认的旧行为）；无标签回退补读；cold-resume 同路径；续派轮同标签 hint 更新。
- 回归：119 测试全绿；agent-map 续聊映射不受影响。

## 4. 边界与兼容

- workflow 一次性子代不可注入（原边界不变）；旧派单（无标签）行为与现状一致。
- 标签通道与 childId 补读互斥（命中即停），两通道不叠加写 selection.current。
- 400 组合缺陷消除成立（评审 F-4 证实：fresh child seed 仅 descriptor+end-seed，首轮前无 assistant 消息；前提=同步注入+tagHints 已落盘）。

## 5. 影响文件

runtime-v3/cli.mjs（tagHints 落盘/归档清理/项目锁）、dsh/inject.js（标签寻址+三态回退）、tests 三处、skills 派发规程引用、README 与 roadmap 台账。

## 6. 评审 findings 处置记录

| # | 结论 | 处置 |
| F-1 与标签禁则冲突（blocker） | v2 弃 tw:<key>，回归阶段·角色[@包] 标签 |
| F-2 keyHints 锁面/清理 | 改 tagHints 键设计 + 项目级锁 + 归档清理 |
| F-3 首轮生效前提/续聊 effort 不变 | §2.4 不变量 + 验证面断言 |
| F-4 400 消除成立 | 确认（附前提） |
| F-5 resume 优先级/幂等 | 定义：resume 用现 tagHints + 幂等单测 |
| F-6 畸形回退不完整 | §2.3 三态回退全序 |
| F-7 双通道优先级 | 命中即停互斥 |
| F-8 回归代价点名 | §1 偏差链已点名 |
