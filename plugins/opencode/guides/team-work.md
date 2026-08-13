# OpenCode 团队派发增量指南

本指南只补充 OpenCode 平台事实；成本、拓扑、挑战者、三轮收敛和验收规则以 Team-work Skill 为准。

- OpenCode 中用 `team_work_runtime` 调用 CoreRuntime；它等价于平台无关 Skill 中的 `team-work ...` CLI 示例，并自动使用当前项目。`task.bind` 会自动采用当前 OpenCode session key；创建任务后仍需显式执行一次 `task.bind`。未绑定时，`task.show` 只会按 Runtime 的“项目唯一活动任务”规则解析，不会静默创建绑定。
- 受管成员只能通过 `team_work_spawn` 派发。该工具创建原生 child session，并使用 `promptAsync` 非阻塞启动；不要用阻塞式 `task` 代替。
- 派发前先用 CoreRuntime 创建 work item，并把稳定的 `task_id`、`work_item_id` 传给工具。成员名称使用已安装的 `junior-*`、`senior-*`、`expert-*`。
- Lead 不等待单个成员结束，也不转而处理具体内容；继续维护 Harness、其他派发和同步点，在同步点调用 `team_work_status`，再用 `team_work_collect` 收集结果。
- 同一 work item 的返工和后续轮次必须用 `team_work_resume` 续派同一 child session，不得每轮重新 spawn。Owner、挑战者和 Expert 各自持有独立 work item；Expert 在同一阶段收敛期间保持同一 session，跨阶段再建立新 work item。
- `team_work_resume` 自身始终通过 `promptAsync` 非阻塞续派，只传稳定的 Runtime `task_id`、`work_item_id` 和本轮 `prompt`；这里的 `task_id` 不是 OpenCode 原生委托工具返回的 child session ID。不要传 `session_id`、`run_in_background` 或 `background`，也不要改用原生 `task`、可选增强工具或同步模式继续受管成员。
- OpenCode 原生 `task` 使用 `task_id` 与可选 `background`，部分增强插件则使用 `session_id` 与 `run_in_background`；这些是其他工具的私有协议，不能套用到 `team_work_resume`。参数错误或误用不代表 session 或网关失效，不得进入降级、容灾或重建流程；立即改用正确的 `team_work_resume` 参数重试。
- OpenCode session 的 retry/error/deleted 事件由 Plugin 归一化到 Runtime 审计；平台错误不自动改变 work item 的验收状态。
- `resolvedModel` 为空的成员不可派发。模型、provider、网关、凭据和 MCP 仍由 OpenCode 配置管理。
- 用户配置了独立 `helper` 模型时，受管成员可用 `team_work_assist` 后台派发 `explore` 或 `librarian` 只读助手，并用 `team_work_assist_status`、`team_work_assist_collect` 在同步点收集。助手不创建 Runtime work item；调用成员负责核验和整合结果。
- `team_work_assist` 只接受受管成员 session。两个助手共用 `helper` 模型但提示词与联网权限不同，均禁止编辑、shell、原生 `task`、团队控制和继续辅助委托。

## 用户可点击文件引用

给用户展示代码、文档或其他制品时，使用标准 Markdown 链接和绝对 `file://` URL，不只输出裸路径：

```text
[label](file:///<absolute-path>)
```

空格等字符需 URL 编码。需要标明代码行时，把 `path:line` 写在 label 中，链接仍指向文件。OpenCode TUI 的助手消息由 Markdown renderer 显示；其 [Link 实现](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/ui/link.tsx) 会把 href 交给系统打开。
