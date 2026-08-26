# tagAgents 自动回填方案：消灭 agent-map 手工登记步骤

状态：待自复核/交叉评审后实施。目标：插件在子代创建贡献段自动把「标签→childId」写回 agents.json，Lead 派完子代零登记；续派寻址（expectedAgentId）改按标签直查。

## 1. 背景与现状（已核实事实）

- 标签寻址实施后，模型注入已在贡献同步段自动完成（tagHints 通道）；
- agent-map 剩余唯一用途 = Lead 手工回填 key→childId（mappings），供续派 expectedAgentId 推导（cli.mjs:832-852：prevKeyOf 同包同角色找上一派发 key → 查 mappings）；
- prevKeyOf 的匹配语义（同角色+同包）与标签键（阶段缩写·角色[@包]）同构——标签可直查，无需 key 中转；
- 插件贡献段天然同时握有 childId（agent.id）与标签（descriptor.label）；插件包内可复用 runtime-v3/persistence 原子写原语（已装包布局核实）。

## 2. 方案

### 2.1 插件侧：贡献段 fire-and-forget 回填

- 标签命中注入后，异步（不阻塞同步段）写 `tagAgents[标签] = childId` 进 agents.json：
  - 原子写复用 runtime-v3/persistence 的 atomicJson + 项目级 owner 锁（与 persistTagHints 同锁文件，防踩踏）；
  - 写失败降级 warn（不阻塞注入；续派寻址缺失时 Lead 仍可 agent-map 手工兜底）；
  - 贡献段 stopped 检查（子代先亡则不写）；
  - cold-resume 重跑贡献 → 重写同键幂等；同标签后写覆盖 = 最新子代胜出（换人 replace-owner 语义天然正确）。

### 2.2 runtime 侧：expectedAgentId 改标签直查

- cli.mjs 续派导出处：`tagAgents[tagLabel(state.stage, d.role, d.package)]` 优先；未命中回退旧 `mappings[prevKeyOf(d)]`（兼容历史任务已登记数据）。
- agent-map 命令保留（手动纠错/换人/平台异常兜底），不做删除。

### 2.3 skill 规程

- 删除「开完立即 tw agent-map 登记」要求；标注：平台插件自动回填（tagAgents），agent-map 仅纠错/换人时用。

## 3. 验证面

- 单元：插件回填（桩 fs 断言 tagAgents 键值与幂等覆盖）；runtime expectedAgentId 标签直查（fixtures 续派场景）；旧 mappings fallback 不破；
- E2E：真机派发→续派卡自动带 expectedAgentId（无需 agent-map）；冷 resume 重写幂等。

## 4. 边界与兼容

- 跨任务同标签覆盖：与 tagHints 同款语义（同标签同角色档位同源，边缘可接受，已豁免）；
- 无标签子代不回填（回退通道不产生 tagAgents）；
- 历史任务（已有 mappings）不受影响。

## 5. 影响文件

dsh/inject.js（回填）、runtime-v3/cli.mjs（推导改查）、skills 规程、tests 两处、README/roadmap。
