# OpenCode 团队派发增量指南

本指南只补充 OpenCode 平台事实；成本、拓扑、挑战者、三轮收敛和验收规则以 Team-work Skill 为准。

- OpenCode 中用 `team_work_runtime` 调用 CoreRuntime；它等价于平台无关 Skill 中的 `team-work ...` CLI 示例，并自动使用当前项目。`task.bind` 会自动采用当前 OpenCode session key；创建任务后仍需显式执行一次 `task.bind`。未绑定时，`task.show` 只会按 Runtime 的“项目唯一活动任务”规则解析，不会静默创建绑定。
- 受管成员只能通过 `team_work_spawn` 派发。该工具创建原生 child session，并使用 `promptAsync` 非阻塞启动；不要用阻塞式 `task` 代替。
- 派发前先用 CoreRuntime 创建 work item，并把稳定的 `task_id`、`work_item_id` 传给工具。成员名称使用已安装的 `junior-*`、`senior-*`、`expert-*`。
- Lead 不等待单个成员结束。继续处理独立工作，在场景同步点调用 `team_work_status`；需要读取结果时调用 `team_work_collect`。
- 返工或第二、三轮收敛使用 `team_work_resume` 续派同一 child session。消息只传分歧、证据缺口、制品路径和完成条件。
- OpenCode session 的 retry/error/deleted 事件由 Plugin 归一化到 Runtime 审计；平台错误不自动改变 work item 的验收状态。
- `resolvedModel` 为空的成员不可派发。模型、provider、网关、凭据和 MCP 仍由 OpenCode 配置管理。
