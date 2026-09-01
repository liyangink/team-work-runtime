# twsub-p1-review 审查报告

- 审查轮次：8（owner，回应 Expert 返工）
- 审查范围：`dsh/tw-tool-subagent.js`、`dsh/inject.js`、`tests/dsh-tw-tool-subagent.test.mjs`。
- 问题：无 effort 的持久化 header 被错误视为“不干预”，使 cold-resume 在合法旧标签存在时可能被 tagHints 覆写 provider/model。
- 结论：**已修正该逻辑与回归缺口；真实 DSH §7 验收仍是放行前提。**

## 修正

1. `recallFromHeader()` 现在只要最近 `request/header` 含有效 provider/model 就重建选择；`reasoningEffort` 仅在非空时附带，不能再决定是否锁定持久化模型。
2. cold-resume 选择优先级固定为直接选择 → 持久化 `request/header` → 迁移期标签/childId 链；无 effort 与有 effort 都会在旧标签链之前锁定 provider/model。
3. 新增“无 effort header + 合法旧标签”的回归：断言持久化 header 的 provider/model 胜出，不会被 tagHints 覆写。
4. 既有 post-start 回收、首请求一致性检查与 `drainContinuableChildren` 创建前能力检查保持不变。

## 回归覆盖与验证

- 新增回归：无 effort 的 header 仍可完整回读；无 effort header 与合法旧标签并存时 header 优先。既有显式选择改写、会话读取异常回收与回收能力缺失用例继续保留。
- 已执行验证：`node --test tests/dsh-tw-tool-subagent.test.mjs` 32/32 通过（含新增用例「cold-resume 的无 effort header 优先于合法旧标签链」）；`npm test` 212 项 = 211 通过 + 1 跳过 + 0 失败；`git diff --check` 无空白错误。

## 未验证项

- unresolved：真实 DSH §7 验收尚未执行。必须点名验证 flush=true 后首个 `request/header` 的可见时序，以及 `drainContinuableChildren(parent, [childId])` 的停止完成语义；fake 宿主不能替代该实测。
- unresolved：若真实宿主忽略预生成 `childId` 并返回不同 ID，直接选择按 sessionId 写入、按 agent.id 消费会 miss。须在 §7 确认宿主尊重传入 ID；否则应迁移键或显式报告 effort 未注入，不能静默成功。
