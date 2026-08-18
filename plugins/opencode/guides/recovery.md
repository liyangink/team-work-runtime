# OpenCode 恢复增量指南

- 网关限流、容量不足或 API 失败时，保留 Runtime work item 和已有制品；先用 `team_work_overview` 与 `team_work_sync` 判断状态。
- `team_work_dispatch` 返回网关错误不代表任务状态损坏。稍后使用相同 task/work-item 再次调用，它会按持久映射恢复原 session；不得把平台错误解释为成员验收失败。
- 通用委托工具提示 `session_id/task_id`、`run_in_background/background` 或 sync 模式冲突，只说明工具选错或参数误用；回到 `team_work_dispatch`，不要停止、重建或降级。
- 人工门禁等待期间若出现自动 continuation，说明进入等待前仍有外部 TODO：只把遗留 TODO 全部标为 `completed/cancelled`，不要检查任务状态或创建“用户回复后继续”的待办；随后停止并等待真实用户输入。
- child session 映射位于 `.team-work/platform/opencode/sessions/<task-id>/<work-item-id>.json`。以 task/work-item ID 恢复，不要求用户记忆 session ID。
- Runtime 事件使用 `platform.dispatch.*`、`platform.resume.*` 和 `platform.session.*` 区分平台故障与工作结果；事件缺失不等于制品失败。
- Lead 会话或进程切换后，先读取活动任务、work item 和制品索引；映射有效时继续原 child session。只有 session 已确认失联或停止后，`team_work_dispatch` 才受控替换并保留 `sessionHistory`。
- 不直接编辑映射或 Runtime 控制文件。`doctor` 报告异常后再按修复建议操作。
