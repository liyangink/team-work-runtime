# tagAgents 自动回填方案 v2：pendingTags + 插件回填 mappings（任务作用域化）

状态：交叉评审 8 findings 全处置，待实施。

## 1. v1 到 v2 变化（评审 F1/F3 处置）

v1 的 tagAgents[标签]=childId 键缺任务身份——跨任务同标签覆盖会确定性地串会话（childId 任务特有，豁免不成立）。v2 改两级间接：
- runtime 派发时写 pendingTags[标签] = dispatchKey（键=标签、值=key——覆盖语义正确：同标签最新派发 key 即续派目标）；
- 插件贡献段标签命中后：读 pendingTags[标签] 得 key，写 mappings[key] = childId（复用现有映射面与 prevKeyOf 读径，读侧零改动）；
- 跨任务安全性：mappings 键=key（任务作用域天然隔离）；残余窗口=两任务同标签并发且子代创建乱序（A 子代晚于 B 派发会写错 B.key——B 续派 expectedAgentId 指向 A 子代）。**自愈面收敛（评审 F-5）**：仅 A 子代已亡时 send_message 失败触发 fresh 重开自愈；A 存活时 send_message 会成功=静默跨任务串会话，需 agent-map 兜底纠错（真路径测试已如实断言该残余窗口行为）。

## 2. 方案

### 2.1 runtime（cli.mjs）
- persistTagHints 同锁内追加写 pendingTags[tag] = key（entries 增带 key）；
- 锁面统一（F2）：agent-map 的 agents.json 写入从 task.lock 改到项目级 agents.lock（读任务事实仍免锁/短锁，写共享文件统一 agents.lock——三路写入者 persistTagHints/插件/agent-map 互斥）；
- dispatch-plan 续派导出：expectedAgentId 缺失时卡内加提示（指引 agent-map 兜底——F5b）。

### 2.2 插件（dsh/inject.js）
- 标签命中后 fire-and-forget：读 agents.json 的 pendingTags[tag] 得 key，写 mappings[key]=childId（atomicJson + agents.lock）；
- 有界重试（F5a）：LOCK_UNAVAILABLE 重试 3 次（100ms 间隔），全部失败才 warn；
- 写前 stopped 检查（防写前已亡）；死-后-写由 fresh 重开降级链自愈（F4 文档化）；
- 无标签/未命中 → 现有回退链不变（F6：不写 pendingTags 消费）。

### 2.3 skill 规程（F6/F7）
- 条件化保留 agent-map：有标签且回填成功 → 无需登记；无标签/回填失败/换人纠错 → 仍需 agent-map（不整条删除）；
- 标签规范统一（F7）：line 11 的旧格式（<任务>.<阶段>.owner@<包>）修正为与 line 47 一致（阶段·角色[@包] · 简述，无任务前缀）。

## 3. 验证面（F8 增补）

- 单元：pendingTags 落盘/覆盖；插件回填写 mappings（含键正确性/stopped/重试/失败降级）；agent-map 锁面迁移不破既有测试；
- 跨任务：两任务同标签并发派发+乱序创建——mappings 不串会话（key 隔离）断言；
- 死-后-写降级：send_message 失败 → fresh 重开覆盖自愈的链路口径测试；
- 锁并发：agents.lock 三写入者互斥（Promise.all 并发合并）。

## 4. 边界与兼容

- 历史任务 mappings 不变（读侧零改动）；pendingTags 是新键不影响旧数据；
- 残余乱序窗口（§1）为已知 risk 如实标注；
- 跨任务同标签 pendingTags 覆盖语义正确（最新派发=续派目标）。

## 4.1 恢复重跑契约（评审 F-9 文档化）

续派链连续性依赖宿主契约：continuable 子代 cold-resume 时重跑 contribution（回填随之为新 key 落 mappings）。该契约由宿主 SetupRegistry 的 resume 分支保证（源码实证），本仓库以测试覆盖插件侧幂等；若某宿主版本不重跑，表现为后续波次 expectedAgentIdMissing 退化为 fresh 重开（丢会话连续性但不破坏正确性）。

## 5. 影响文件

runtime-v3/cli.mjs、dsh/inject.js、skills 规程、tests 三处、README/roadmap、方案本文档。
