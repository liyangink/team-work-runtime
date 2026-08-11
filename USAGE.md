# team-work 使用指南

team-work 是平台无关的 multiagent engineering loop。通常从 Workflow 开始；明确需要团队讨论、并行实施或独立审查时，也可以直接使用 Team-work。

## QuickStart

当前可直接安装的 PlatformPlugin 是 OpenCode。安装器会自动解析模型，并完成版本、依赖、Agent 和 Plugin 加载检查。首次使用只需两步。

1. 安装到目标项目：

```bash
node plugins/opencode/scripts/manage.mjs install \
  --project /absolute/path/to/project
```

2. 正常启动 OpenCode，在对话中发起任务：

```text
使用 workflow 处理这个需求。按实际阶段介入；根据并行价值和独立审查价值
决定是否组团。优先使用 Junior 控制成本，所有团队成员后台派发。
```

安装命令成功返回后无需逐项人工检查。遇到警告或运行异常时，再查阅[常见问题](#常见问题)。

## 常用方式

### 从 Workflow 开始

一般研发任务使用 Workflow。它负责创建或恢复任务、管理上下文与阶段、判断 solo/team、路由 SPEC，并在需要组团时调用 Team-work。

```text
使用 workflow 实现这个需求，复用现有设计和代码。从 implementation 阶段介入，
完成实现、测试、代码审查和收尾；需要团队时控制成本并建立最低充分拓扑。
```

### 直接使用 Team-work

只需要方案讨论、代码 Review、并行施工或测试团队时，可以显式调用 Team-work。它会创建轻量任务，不要求先启动完整 Workflow。

```text
使用 team-work 对 src/imap/ 做 code-review。从 code-review 阶段介入，
覆盖全部审查视角，安排非作者挑战者，最多三轮收敛并输出 Review 制品。
```

### 从任意阶段介入

只需声明当前目标和已有制品，不需要补跑历史阶段：

- 已有代码直接审查：`code-review`；
- 已有代码补测试：`test`；
- 已有设计做评审：`design-review`；
- 只讨论方案：`design`；
- 完整研发循环：从实际起点交给 Workflow。

门禁只检查当前环节所需输入。例如代码 Review 可以只有代码和审查范围，没有设计或 SPEC 不会形成死门。

## 团队协作规则

- Junior 是成本优先的默认主力；Senior 处理复杂判断并担任挑战者；Expert 用于保底、攻坚或高风险收口。
- 正式团队必须有一名 Senior 或 Expert 复核非本人制品。Expert 不是每个任务的必选成员。
- 每名成员必须有明确范围、完成条件、制品路径和验证要求。
- Lead 不阻塞等待单个成员；具体派发方式由 PlatformPlugin 实现，Lead 只在同步点收集结果。
- 返工和分歧使用原成员续派，最多三轮。仍不能收敛时交给用户决定。
- 成员自报完成不等于通过；Lead 必须检查制品和证据后验收。

## 查看与继续任务

查看团队进度时直接询问 Lead：

```text
汇报当前任务的阶段、团队成员、work item 状态、已生成制品、阻塞和下一同步点。
不要启动新的成员。
```

跨会话继续时提供 task ID；不知道时让 Workflow 解析。存在多个活动任务时，它会要求明确选择，不会猜测最近任务。

```text
使用 workflow 继续任务 <task-id>。先读取任务状态、上下文索引、work item 和
平台 session 映射，再决定收集、续派、返工或推进。
```

任务状态和制品保存在项目 `.team-work/` 中。控制文件可以诊断读取，但不要手工编辑。

## 平台配置

### OpenCode

OpenCode 需要 1.18.0 或更高版本。安装器默认按模型名唯一匹配；名称不一致、存在歧义或只想启用部分成员时，才需要显式模型映射。

复制 [模型映射示例](plugins/opencode/config/model-map.example.json)，把需要的成员设为 `opencode models <provider>` 返回的完整 `provider/model`，再通过 install/update 的 `--model-map` 传入。

可以只映射当前需要的成员；未解析成员不会生成 Agent。正式组团至少需要一名可担任挑战者的 Senior 或 Expert。

更新和卸载：

```bash
node plugins/opencode/scripts/manage.mjs update \
  --project /absolute/path/to/project \
  --model-map /absolute/path/to/model-map.json

node plugins/opencode/scripts/manage.mjs uninstall \
  --project /absolute/path/to/project
```

更新会保护本地改动并先备份。卸载只删除受管文件，保留任务、制品、事件、项目配置和历史备份。

OpenCode 会合并多个配置来源。若已放弃 OMO，应从实际生效的全局配置中移除它，或使用独立配置环境。不要用 `--pure` 启动 Team-work；OpenCode 1.18.15 实测会同时禁用项目 Plugin。

OpenCode 受管成员始终通过原生 child session 后台派发。Lead 不应使用阻塞式 `task` 替代 Team-work 工具。

OpenSpec 只在进入默认 SPEC 流程时需要。缺失 OpenSpec 不会阻止 Standalone Team-work。

安装器参数、文件归属、强制更新和卸载语义见 [OpenCode PlatformPlugin](plugins/opencode/README.md)。

## 常见问题

### 安装失败或 Agent 不可用

先运行：

```bash
node plugins/opencode/scripts/manage.mjs doctor --project /absolute/path/to/project
opencode debug agent <agent-name>
```

`AGENT_UNAVAILABLE` 通常表示模型映射错误、模型不可见或 Agent 未安装。确认 `opencode models` 的完整名称后重新执行 update。

### 找不到 `team_work_runtime`

确认项目存在 `.opencode/plugins/team-work.js`，并且不是用 `--pure` 启动。随后运行 doctor 检查安装漂移。

### 仍出现 OMO Agent 或提示词

项目配置不会清空全局插件列表。应从生效的全局 OpenCode 配置中移除 OMO，然后重启 OpenCode。

### OpenSpec 警告

只做 Team-work 时可以忽略。需要进入 SPEC 阶段时，再安装或初始化项目选择的 SPEC 工具。

### 网关限流、容量或 API 错误

不要重复创建成员。保留原 work item 和 child session，网关恢复后让 Lead 续派原成员。

### Child session 已失联

如果 session 已删除或确认不存在，创建新的 work item attempt 后重派。不要把新 session 伪装成旧 session 续接。

### `REVISION_CONFLICT` 或 `GATE_BLOCKED`

`REVISION_CONFLICT` 需要重新读取任务状态再写入。`GATE_BLOCKED` 需要补齐当前阶段制品或证据，必要时请求人工决定；不要循环重试。
