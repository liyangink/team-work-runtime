# OpenCode 团队派发增量指南

本指南只补充 OpenCode 平台事实；成本、拓扑、挑战者、三轮收敛和验收规则以 Team-work Skill 为准。

- Lead 只使用意图级工具：`team_work_overview` 查看简化状态，`team_work_begin` 建立任务，`team_work_register` 登记上下文，`team_work_dispatch` 派发，`team_work_sync` 挂起等待成员，`team_work_assess` 验收，`team_work_continue` 继续流程。技术内容门禁使用 `team_work_review_gate`；人工审核由 `team_work_continue` 根据当前状态自动发起和恢复。
- `team_work_dispatch` 自动完成 work-item 创建、启动以及原生 child session 的首次派发或续派，自身始终通过 `promptAsync` 非阻塞运行。普通研发工作传稳定的 task/work-item、Owner、范围、完成条件、制品路径和提示词；SPEC 工作只传 `spec_artifact`，编写 delta specs 时再传 proposal 已确认的 capability 名称，物理路径由 Harness 生成。不要传 `session_id`、`run_in_background`、`background`、Runtime revision 或底层 command。
- 同一 work item 的返工和多轮收敛会由 `team_work_dispatch` 复用同一 child session；Owner、挑战者和 Expert 各自持有独立 work item。Expert 在同一阶段收敛期间保持同一 session，跨阶段再建立新 work item。
- `team_work_assess` 自动完成 submit、审查证据登记及 accept/rework，但不会代替非作者 Senior/Expert 审查。证据路径和交付制品必须已经存在。
- `team_work_continue` 不接收 gate、revision、底层 outcome 或 approve/reject。Runtime 根据当前持久状态决定是发起人工审核、消费用户刚刚给出的明确决定，还是进入合法下一阶段；SPEC 可用性会在推进前自动刷新。首次发起人工审核只需提供当前阶段主制品路径。
- 进入 OpenSpec 时，`team_work_begin`/`team_work_continue` 自动创建或恢复与 task-id 同名的活动 change。`team_work_dispatch` 只接受当前 ready/返工 artifact 的活动 change 路径，并自动注入 `openspec instructions`；不要派单修改 `openspec/specs/`、archive 或历史 change。未完成时 `team_work_continue` 保持在 SPEC，最终验收通过后才严格校验并归档。
- 进入人工等待前会检查 OpenCode 外部 TODO；如有未完成项，先用 `todowrite` 把全部项目标为 `completed/cancelled`。等待期间只向用户提交一次简明请求并结束本轮，不挂后台任务、不调用团队同步或重复查看状态；只有真实用户消息可以恢复。
- `team_work_sync` 默认挂起 5 分钟、最长 30 分钟，并由 child session 事件直接唤醒和收集输出。开始时只做一次遗漏事件恢复快照，等待期间没有定时状态轮询。返回 `ready` 只表示需要核对消息、制品和证据，不表示成员工作已验收。
- Plugin 把成员 `idle/error/lost` 归一化为持久待同步提示，只注入 work-item 索引，不复制成员正文。该机制不会维护第二套调度队列，也不会自动推进 Workflow。
- 受管 Lead 不使用外部 TODO 队列维护流程状态；Hook 只允许把遗留 TODO 全部清为完成，拒绝新增 pending/in_progress，避免自动续写与 Runtime Harness 互相抢占。
- 工具参数错误或误用不代表 session 或网关失败，不得据此降级、重建或启动容灾。不可重试错误不要重复调用；先用 `team_work_overview` 重新读取状态，再选择正确的意图级工具。
- 对用户汇报时说人话，只保留“完成内容、当前阶段、关键制品、分歧或风险、下一步”。除故障诊断外，不复述工具名、gate、revision、session ID、Runtime command 等实现术语。
- `resolvedModel` 为空的成员不可派发。模型、Provider、网关、凭据和 MCP 仍由 OpenCode 管理。
- 配置独立 `helper` 模型后，受管成员可用 `team_work_assist`、`team_work_assist_status`、`team_work_assist_collect` 调用只读 explore/librarian。助手不是团队成员，不能编辑、执行 shell、继续委托或作技术裁决。

## 用户可点击文件引用

给用户展示代码、文档或其他制品时，使用标准 Markdown 链接和绝对 `file://` URL，不只输出裸路径：

```text
[label](file:///<absolute-path>)
```

空格等字符需 URL 编码。需要标明代码行时，把 `path:line` 写在 label 中，链接仍指向文件。OpenCode TUI 的 [Link 实现](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/ui/link.tsx) 会把 href 交给系统打开。
