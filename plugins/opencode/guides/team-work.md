# OpenCode 团队派发增量指南

本指南只补充 OpenCode 平台事实；成本、拓扑、挑战者、三轮收敛和验收规则以 Team-work Skill 为准。

- OpenCode 中用 `team_work_runtime` 调用 CoreRuntime；它等价于平台无关 Skill 中的 `team-work ...` CLI 示例，并自动使用当前项目。`task.bind` 会自动采用当前 OpenCode session key；创建任务后仍需显式执行一次 `task.bind`。未绑定时，`task.show` 只会按 Runtime 的“项目唯一活动任务”规则解析，不会静默创建绑定。
- 受管成员只能通过 `team_work_spawn` 派发。该工具创建原生 child session，并使用 `promptAsync` 非阻塞启动；不要用阻塞式 `task` 代替。
- 派发前优先用强类型 `team_work_work_create` 创建 work item；随后通过 `team_work_runtime` 的 `work.start` 启动，再把同一组稳定 `task_id`、`work_item_id` 交给 `team_work_spawn`。不要用通用 Runtime record 猜测字段；强类型参数 `work_item_id`、`artifact_paths`、`done_when` 会分别映射为 CoreRuntime 的 `workItemId`、`artifactPaths`、`doneWhen`。成员名称使用已安装的 `junior-*`、`senior-*`、`expert-*`。
- Lead 不阻塞等待某个成员完成整个任务，也不转而处理具体内容；先维护 Harness 和其他派发。没有可继续的控制面工作时，可在明确同步点调用 `team_work_wait` 有界等待任一成员，默认 10 秒、最长 30 秒；超时是正常结果，继续响应用户或稍后再等，禁止无限轮询。
- Plugin 会把成员 `idle/error/lost` 归一化为当前派发轮次的持久待同步提示；`idle` 到达时先复核原生实时状态，避免旧轮次延迟事件误报。Lead 下一轮上下文只注入 work item 索引，不复制成员正文。`team_work_wait` 返回 `ready` 只表示应调用 `team_work_collect` 核对消息、制品和证据，不表示成员工作已验收；成功 collect 后只消费实际读取轮次的普通 `idle` 提示，错误与失联诊断继续保留。
- 同一 work item 的返工和后续轮次必须用 `team_work_resume` 续派同一 child session，不得每轮重新 spawn。Owner、挑战者和 Expert 各自持有独立 work item；Expert 在同一阶段收敛期间保持同一 session，跨阶段再建立新 work item。
- `team_work_resume` 自身始终通过 `promptAsync` 非阻塞续派，只传稳定的 Runtime `task_id`、`work_item_id` 和本轮 `prompt`；这里的 `task_id` 不是 OpenCode 原生委托工具返回的 child session ID。不要传 `session_id`、`run_in_background` 或 `background`，也不要改用原生 `task`、可选增强工具或同步模式继续受管成员。
- OpenCode 原生 `task` 使用 `task_id` 与可选 `background`，部分增强插件则使用 `session_id` 与 `run_in_background`；这些是其他工具的私有协议，不能套用到 `team_work_resume`。参数错误或误用不代表 session 或网关失效，不得进入降级、容灾或重建流程；立即改用正确的 `team_work_resume` 参数重试。
- OpenCode session 的 retry/error/deleted 事件由 Plugin 归一化到 Runtime 审计；平台错误不自动改变 work item 的验收状态。事件遗漏时，`team_work_wait` 低频复核原生 session 状态，但不会维护第二套调度队列，也不会自动推进 Workflow。
- `resolvedModel` 为空的成员不可派发。模型、provider、网关、凭据和 MCP 仍由 OpenCode 配置管理。
- 用户配置了独立 `helper` 模型时，受管成员可用 `team_work_assist` 后台派发 `explore` 或 `librarian` 只读助手，并用 `team_work_assist_status`、`team_work_assist_collect` 在同步点收集。助手不创建 Runtime work item；调用成员负责核验和整合结果。
- `team_work_assist` 只接受受管成员 session。两个助手共用 `helper` 模型但提示词与联网权限不同，均禁止编辑、shell、原生 `task`、团队控制和继续辅助委托。

## 用户可点击文件引用

给用户展示代码、文档或其他制品时，使用标准 Markdown 链接和绝对 `file://` URL，不只输出裸路径：

```text
[label](file:///<absolute-path>)
```

空格等字符需 URL 编码。需要标明代码行时，把 `path:line` 写在 label 中，链接仍指向文件。OpenCode TUI 的助手消息由 Markdown renderer 显示；其 [Link 实现](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/ui/link.tsx) 会把 href 交给系统打开。
