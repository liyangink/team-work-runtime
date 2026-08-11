# OpenCode 恢复增量指南

- 网关限流、容量不足或 API 失败时，保留 Runtime work item 和已有制品；用 `team_work_status` 判断 child session 状态，再决定续派或重建。
- `team_work_resume` 失败不代表任务状态损坏。记录基础设施 blocker，稍后重试；不得把平台错误解释为成员验收失败。
- child session 映射位于 `.team-work/platform/opencode/sessions/<task-id>/<work-item-id>.json`。以 task/work-item ID 恢复，不要求用户记忆 session ID。
- 进程或会话切换后，先读取活动任务、work item 和制品索引；旧 child session 不可用时创建新 work item attempt 或按 Team-work 通用恢复规则重派。
- 不直接编辑映射或 Runtime 控制文件。`doctor` 报告异常后再按修复建议操作。
