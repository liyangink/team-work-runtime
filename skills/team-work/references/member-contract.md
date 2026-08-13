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

## 返工协议

Owner 收到修改意见后，先理解并确认目标、依据和影响，逐项标记接受、异议或疑问。存在不理解或执行困难时先向 Lead 请求转发原 Owner、挑战者或 Expert 解释；Lead 仍无法从现有证据澄清且会改变结果时交用户决定。分歧关闭后再制定最小修复计划、执行修改并完成自检，随后交非作者复核；复核者应为 Senior 或 Expert。Lead 最后只核对流程、制品和证据。人工复核仅在用户显式要求、高风险或三轮未收敛时触发。

Owner 对最终制品负责，必须独立判断 Expert 或挑战者意见的合理性；有证据时可以辩驳，不能机械接受，也不能无依据拒绝。

## Lead 控制面验收

Lead 只对照范围、制品、验证证据、挑战记录和必要 Expert 结论检查控制面完整性，不重新调查技术细节、不猜测、不替 Owner 修订制品。核心环节缺少非作者 Expert 技术内容裁决时不得推进；有疑问时续派原 Owner、挑战者或 Expert 回答。接受、返工或取消都通过 Runtime 更新 work item。

## Expert 裁决

Expert 阅读原始制品、挑战记录和验证证据，对技术内容作 `pass`、`rework`、`blocked` 或 `needs-user` 结论，指出未关闭问题和最小修正。Expert 是核心内容裁决者，不是 Lead 的意见附件，但其结论不是不可质疑的命令；Owner 可带证据提出异议，门禁在分歧关闭前保持未决。Expert 若是制品 Owner，必须由另一位非作者 Expert 或满足要求的独立专家复核。

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
