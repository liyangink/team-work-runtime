# 注入寻址回归方案：标签（descriptor.label）同步注入

状态：待用户批准后实施。目标：回归最初设计——Lead 派子代时经 description 标签约定身份，插件在子代创建时**首轮同步注入** model/effort，消灭 childId 后置登记造成的首轮边界及其衍生缺陷（effort=thinking 历史污染 400）。

## 1. 背景与偏差链（已实证）

- 原设计：标签规范（阶段·角色[@包]）作注入寻址——标签在派发时已知，首轮即可注入；childId 仅供多轮续聊记账。
- `3848cfc` 将寻址改为“子代上下文内派单事实（key）”，随后因 contribution 执行时派单 prompt 文本不在 session 而证伪，再退到 childId 后置登记 → 首轮必用默认模型。
- 技术地基（本轮源码实证）：subagent 工具 `description` 参数原样成为 `descriptor.label`；descriptor 事件在子代创建前写入 session seed；contribution 同步段可经 `childCtx.agent.session.events` 读取。宿主注释明示 descriptor 即“首请求前可见的声明组合记录”。

## 2. 方案

### 2.1 标签约定（Lead 派发规程）

子代 description 前缀固定机器段：`tw:<dispatchKey>`，人读段可后附（如 `tw:w2-69a8ae code-review·owner`）。skill 派发规程同步更新。

### 2.2 runtime 侧（agents.json 数据面）

- 新增 `keyHints`：dispatchKey → {provider, model, effort}。在 dispatched 事件落盘时**自动写入**（detail.modelHint 快照已在派发卡上，P4：runtime 已有事实，Lead 零转录）——不再依赖 agent-map 手动传模型。
- `modelHints`（childId 键）与 `mappings`（key→childId）保留：续聊映射与兼容过渡。

### 2.3 插件侧（contribution 同步注入）

- 同步段：session.events 取 `subagent/descriptor` → 解析 label 的 `tw:<key>` → 查 keyHints[key] → 命中即同步写 `selection.current`（首轮请求生效）→ installModelSelection。
- 未命中/无标签 → 回退现有 childId 补读循环（兼容旧派单形态）。
- 注入时机提前后，effort=thinking 场景下首轮即 thinking——历史不再混合非 thinking 轮，400 组合缺陷随之消除。

## 3. 验证面

- 单元：label→key 解析纯函数（合法/缺失/畸形）；keyHints 自动落盘（dispatched 后即可见）；同步注入桩测试（contribution 不 await 即注入——首轮语义）。
- E2E：带标签派发真实子代 → **首请求 header 即注入值**（对比当前首轮默认模型的旧行为）；无标签派单回退 childId 补读；cold-resume 同路径。
- 回归：现有 119 测试全绿；agent-map 续聊映射不受影响。

## 4. 边界与兼容

- workflow 一次性子代（one-shot）不可注入（原有边界，不变）。
- 旧派单（无 tw: 前缀）行为与现状一致（第二请求起注入）。
- 标签仅作身份寻址；人读分组建用途不受影响（key 段可读）。

## 5. 影响文件

- `runtime-v3/cli.mjs`：dispatched 落盘处自动写 keyHints；`dsh/inject.js`：同步标签寻址 + childId 回退；`skills/team-work-v3` 派发规程：description 标签约定；测试三处；README 与 roadmap 台账。
