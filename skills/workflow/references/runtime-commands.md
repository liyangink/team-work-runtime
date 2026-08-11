# Runtime 调用约定

## 原则

- 使用安装后的 `team-work` 命令；所有自动化调用追加 `--json`。
- 除初始化和项目级诊断外，始终显式传 `--project <root>` 与 `--task <task-id>`。
- 任务写操作先读取最新 task `revision`，再传 `--expected-revision <revision>`；冲突后重新读取并重做决策，不盲目重试旧写入。`task bind` 单独使用 binding revision，见下文。
- 只依据 JSON 的 `ok`、`error.code`、`retryable`、`blockers` 和 `remediation` 分支，不解析自然语言消息。
- 不直接修改 `.team-work/config.yaml`、`task.json`、`context.jsonl`、`work-items.json` 或事件日志。

## 常用命令

```text
team-work init --project <root> --json
team-work doctor --project <root> --json
team-work task create --project <root> --task <task-id> --title <title> --entry-stage <stage> --json
team-work task show --project <root> --task <task-id> --json
team-work task bind --project <root> --task <task-id> --platform <platform> --session <session> --json
team-work task team --project <root> --task <task-id> --mode <solo|team> --reason <reason> --expected-revision <rev> --json
team-work task spec --project <root> --task <task-id> --status <in-progress|completed|blocked|disabled> --artifacts <paths> --reason <reason> --expected-revision <rev> --json

team-work context register --project <root> --task <task-id> --context <context-id> --kind <kind> --path <path> --profiles <profiles> --summary <summary> --expected-revision <rev> --json
team-work context list --project <root> --task <task-id> --json
team-work context render --project <root> --task <task-id> --profile <lead|research|implement|check> --json
team-work context rebuild --project <root> --task <task-id> --expected-revision <task-rev> --json

team-work flow status --project <root> --task <task-id> --json
team-work flow check --project <root> --task <task-id> --json
team-work flow decide --project <root> --task <task-id> --gate <gate-id> --kind <deterministic|semantic|human> --status <passed|blocked|overridden> --actor <actor> --reason <reason> --evidence <evidence-id> --evidence-path <path> --expected-revision <rev> --json
team-work flow advance --project <root> --task <task-id> --outcome <pass|rework|fail> --expected-revision <rev> --json
team-work flow rollback --project <root> --task <task-id> --to <earlier-stage> --reason <reason> --evidence <refs> --expected-revision <rev> --json

team-work task await --project <root> --task <task-id> --question <question> --blocker <blocker> --required-decision <decision> --expected-revision <rev> --json
team-work task resume --project <root> --task <task-id> --expected-revision <rev> --json
team-work task complete --project <root> --task <task-id> --summary <summary> --artifacts <paths> --evidence <refs> --actor <actor> --expected-revision <rev> --json
```

`flow decide` 的 `--evidence` 是新证据 ID，`--evidence-path` 是已存在的项目相对路径；`blocked` 和 `overridden` 还必须传 `--blocker`。每次成功写入后都使用响应中的新 revision，不复用示例里的旧值。

首次 `task bind` 不传 `--expected-revision`；覆盖已有绑定时传上次 `data.binding.revision`，不要传 task revision。绑定不改变 task revision。

创建团队工作项及验收命令由 `team-work` Skill 使用，Workflow 只消费已验收结果。

## 错误分支

- `TASK_AMBIGUOUS`：列出候选并请求明确任务，不自动选最近任务。
- `REVISION_CONFLICT`：重新读取任务和工作项，重新判断后再写。
- `GATE_BLOCKED`：展示 blocker 与 remediation，补制品或走人工门禁；不要循环重试。
- `STATE_CORRUPT`：停止写入，运行 `doctor`；只有 Runtime 明确支持时才修复。
- 可重试基础设施错误：按恢复规则进行有界重试，保留最后一次错误和已有制品。
