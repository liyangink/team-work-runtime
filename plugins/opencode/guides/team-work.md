# OpenCode 增量指南

- Lead 只使用 `workflow_open`、`workflow_plan`、`workflow_run`、`workflow_steer`。分别用于打开任务、提交阶段目标与成本偏好、继续推进、响应明确的决策问题；不要调用原生 `task` 组建另一套团队。
- `workflow_run` 根据持久状态推进或等待平台事件，不需要定时轮询。派发固定使用原生非阻塞 child session；Harness 自动创建或续派，Lead 不传 session、background、revision、门禁或底层命令。
- 同一工作项的返工和三轮收敛复用同一 child session；Owner、挑战者和 Expert 使用独立会话。Expert 在同一阶段收敛期间保持同一会话，跨阶段重新建立工作项。
- 受管成员完成本轮工作后调用 `team_work_report`，身份、工作范围和当前尝试由 Harness 自动绑定。普通消息、会话空闲或平台“完成”状态都不等于交付或验收通过。
- 配置独立 Helper 模型后，受管成员可用 `team_work_assist`、`team_work_assist_status`、`team_work_assist_collect` 调用只读 explore/librarian。助手不是团队成员，不能编辑、执行 shell、继续委托或作技术裁决。
- OpenSpec 由 Harness 管理当前任务的活动 change、provider instructions、完成验证和最终归档；成员只修改派单中给出的活动制品，禁止修改 canonical specs、archive 或其他 change。
- 向用户引用文件、制品或代码时使用 OpenCode 可点击 Markdown 链接：`[说明](file:///<absolute-path>)`。汇报只保留完成内容、当前阶段、关键制品、分歧或风险、下一步，不解释 Runtime 内部字段。
