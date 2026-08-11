# OpenCode 恢复增量指南

- 网关限流、容量不足或 API 失败时，保留 Runtime work item 和已有制品；用 `team_work_status` 判断 child session 状态，再决定续派或重建。
- `team_work_resume` 失败不代表任务状态损坏。记录基础设施 blocker，稍后重试；不得把平台错误解释为成员验收失败。
- child session 映射位于 `.team-work/platform/opencode/sessions/<task-id>/<work-item-id>.json`。以 task/work-item ID 恢复，不要求用户记忆 session ID。
- Runtime 事件中使用 `platform.dispatch.*`、`platform.resume.*` 和 `platform.session.*` 区分平台故障与工作结果；事件缺失时不据此判定制品失败。
- 进程或 Lead 会话切换后，先读取活动任务、work item 和制品索引；映射仍有效时继续 `team_work_resume` 原 child session。只有 session 已失联、Owner/职责变化或需要独立第二意见时才重派，不能因为进入新一轮就重建成员。
- 已标记 lost 或 stopped 的映射可再次调用 `team_work_spawn` 受控替换；Plugin 把旧 session 保存到 `sessionHistory`。Owner 更换时先停止旧 session、通过 Runtime 完成受限换 Owner，再 spawn 新成员。
- 不直接编辑映射或 Runtime 控制文件。`doctor` 报告异常后再按修复建议操作。
