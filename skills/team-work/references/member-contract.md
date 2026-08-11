# 分工契约

每个 work item 在派发前必须具备：

- 唯一 Owner；
- 场景、当前阶段和具体目标；
- 专属范围与禁止触碰范围；
- 可验证的完成条件；
- 制品路径；
- 验证命令或证据要求；
- 依赖和首个动作。

## 所有成员

- 只处理分配范围，不自行扩展任务或接管他人范围。
- 先验证事实再下结论；区分已验证事实、合理推断和待确认问题。
- 长内容写入分配的制品，消息只返回摘要、路径、证据、风险和请求。
- “已完成”只表示申请验收。Lead 接受后 work item 才算通过。
- 遇到任务本身的失败，提交失败证据与最小返工建议；遇到基础设施错误，按恢复规则处理。

## 研究与审查成员

默认不修改产品代码，但可以写入分配的报告或证据文件。输出必须包含定位信息、事实依据、结论置信度和未解决问题。

## 实施成员

- 只修改独占文件或明确划分的代码区域；共享热点必须由单一 Owner 串行合并。
- 开始前阅读相关项目规范和邻近实现风格。
- 交付时列出变更摘要、完成条件逐项结果、制品路径、验证证据、残余风险和潜在冲突。
- 不覆盖未知的现有改动，不用大范围格式化制造无关 diff。

## Lead 验收

Lead 对照范围和完成条件检查原始制品与验证证据。接受、返工或取消都通过 Runtime 更新 work item；不要在报告中维护第二套任务状态。

## Runtime 映射

先创建计划中的制品文件或目录；Runtime 要求 assignment 中的项目相对路径已经存在。每条写命令都使用上一响应返回的最新 revision。

```text
team-work work create --project <root> --task <task-id> --work <work-id> --owner <agent-id> --scope <scope> --done-when <checks> --artifacts <paths> --dependencies <work-ids> --expected-revision <rev> --json
team-work work start --project <root> --task <task-id> --work <work-id> --expected-revision <rev> --json
team-work work submit --project <root> --task <task-id> --work <work-id> --scenario <scenario> --scope-refs <refs> --outcome <pass|rework|blocked|degraded> --artifacts <paths> --evidence <existing-evidence-ids> --summary <summary> --expected-revision <rev> --json
```

基础设施失败用 `work block` 记录，不伪造任务 submission。blocked 后重试同一成员时直接 `work start`；同档换模型时只在该命令追加新 `--owner`，Runtime 会保留上一 attempt 的 Owner 与 blockage。

```text
team-work work block --project <root> --task <task-id> --work <work-id> --error-code <code> --reason <reason> --refs <diagnostic-refs> --expected-revision <rev> --json
team-work work start --project <root> --task <task-id> --work <work-id> --owner <same-tier-agent-id> --expected-revision <rev> --json
```

Lead 验收前先把验收或拒绝依据记录成任务证据。通过时建立 `passed` 语义门禁；拒绝时建立带 `--blocker` 的 `blocked` 语义门禁。`--evidence` 在此命令中是新证据 ID，`--evidence-path` 必须是已存在的项目相对路径。

```text
team-work flow decide --project <root> --task <task-id> --gate work-<work-id> --kind semantic --status <passed|blocked> --actor lead --reason <reason> --blocker <blocker-if-any> --evidence <new-evidence-id> --evidence-path <path> --expected-revision <rev> --json
team-work work accept --project <root> --task <task-id> --work <work-id> --actor lead --evidence <evidence-id> --expected-revision <rev> --json
team-work work rework --project <root> --task <task-id> --work <work-id> --actor lead --reason <reason> --evidence <evidence-id> --expected-revision <rev> --json
```

返工或基础设施阻塞后用 `work start` 开启下一 attempt。后续通过时以同一 gate ID 写入新的 `passed` 决策来关闭 blocker，再接受新提交。不要并发复用 revision；可并行执行 Agent 工作，但 Runtime 写入由 Lead 串行提交或在冲突后重新读取。
