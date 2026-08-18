# OpenCode PlatformPlugin

本模块把平台无关的 Workflow、Team-work 和 CoreRuntime 装配到 OpenCode。面向用户的安装、配置和使用说明见 [`../../README.md`](../../README.md)。

## 安装边界

公开入口是：

```bash
npx team-work-runtime@latest install
```

安装是用户级操作，不依赖当前项目。Linux/macOS 默认位置：

- 用户配置：`~/.config/team-work/config.json`
- Skill：`~/.config/opencode/skills/`
- Plugin：`~/.config/opencode/plugins/team-work.js`、`team-work-tui.tsx`
- TUI 注册：`~/.config/opencode/tui.json` 中的 `./plugins/team-work-tui.tsx`
- Runtime、Profile、指南和安装清单：`~/.config/opencode/team-work/`

用户配置支持 `TEAM_WORK_CONFIG_HOME`、`XDG_CONFIG_HOME` 和 Windows `%APPDATA%`。OpenCode 安装根遵循其全局目录；安装器只对 `tui.json` 做保留注释的定点注册，不修改 provider、网关、凭据、MCP 或用户的 `opencode.json`。

OpenCode 会自动发现全局 `plugins/` 下的 Server 入口；TUI 入口按官方机制显式注册到 `tui.json`。`enable/disable` 只切换用户配置中的 `platforms.opencode.enabled`；禁用时入口仍可被发现，但 Server 不注册 Agent、工具或 Hook，TUI 不注册侧栏。修改后重启 OpenCode 生效。

首次在项目内调用 Team-work Runtime Tool 时，Plugin 才初始化项目 `.team-work/`，并物化当前 Platform Profile 与增量指南。安装、更新和卸载都不扫描或删除各项目任务数据。

## 模型与 effort

`agents: "auto"` 在安装或更新时按模型名唯一匹配；没有匹配或存在歧义时不猜测，并在 Platform Profile 中保留诊断信息。

显式 Agent 必须使用 OpenCode 可识别的完整 `provider/model`。Plugin 启动时动态注入 Agent，`effort` 映射为 Agent 级 `reasoningEffort`。修改后重启 OpenCode 即可。

可选的顶层 `helper` 使用独立模型和 effort，同时生成隐藏的 `team-work-explore` 与 `team-work-librarian`。它不继承 Junior；未配置时不注入只读助手。

## OpenSpec

Plugin 启动时读取 `spec.command` 和 `spec.mode`。项目首次初始化时用 `--version` 与只读的 `list --json` 检查 OpenSpec；只有返回 `{ "changes": [...] }` 才标为 `ready`。

`auto` 在 missing 时跳过 SPEC，`required` 会阻塞，`disabled` 始终跳过。Plugin 不会静默安装工具。进入 SPEC 后，Plugin 会以 task-id 创建或恢复活动 change，读取 `status/instructions` 约束派单，完成时登记制品；最终人工验收通过后才执行严格校验和 archive。Agent 不能直接修改 canonical specs、archive 或其他任务 change。

## 生命周期

```bash
npx team-work-runtime@latest update
npx team-work-runtime@latest uninstall
```

更新会检查 digest，并在强制覆盖前备份受管文件。卸载只处理安装清单中的用户级资产和自己的 TUI 注册，操作前始终创建恢复快照；本地修改默认保留，`--force` 才会连同本地修改一起移除。用户配置和项目 `.team-work/` 始终保留。

`doctor` 只用于故障诊断，会检查 TUI 注册及显式绑定模型是否仍出现在 `opencode models` 中。`doctor --probe-models` 还会要求每个不同模型真实回复一次 `OK`；OpenCode 仍可能携带系统上下文，因此应留意模型费用。默认检查不调用模型，也不是更新或卸载的前置步骤。

## 平台运行规则

OpenCode PlatformPlugin 内部分为 Server、TUI 和 Installer 子模块，不增加新的产品级 Module。Server 负责工具、Hook、session 映射和事件；TUI 在原生 `sidebar_content` 插槽中同步读取当前任务成员快照并调用原生 session route 跳转，不注册后台轮询或异步状态订阅；Installer 统一装配和更新 Server/TUI 两类入口，并提供软启停与安全卸载。

Server 为 Lead 提供少量意图级工具：`team_work_dispatch` 收敛创建—启动—派发，`team_work_assess` 收敛提交—审查—验收，`team_work_continue` 收敛人工审核与阶段推进。Runtime command、gate、revision、session ID、SPEC 探测和合法边选择都留在实现内。领域失败保留稳定错误和可执行 `remediation`，但不会中止 OpenCode 主会话；普通成员无权调用 Runtime 或 Lead 控制面工具。

`solo` 与 `team` 的受管成员都使用 OpenCode 原生 `session.create + promptAsync` 后台派发。Lead 通过稳定 task/work-item ID 查询、收集和续派；同一 work item 默认复用 child session，失联或停止后才受控替换并保留历史。禁止用阻塞式 `task` 工具替代受管派发。

受管成员可通过 `team_work_assist` 创建临时只读 helper child session。该链路同样使用 `promptAsync`，只允许代码探索或资料检索；助手不能继续委托或成为 Runtime work item Owner。

网关错误、重试、续派、停止和 child session 失联会记录为 `platform.*` 事件。事件审计失败不改变 work item 验收状态，也不会把成功派发改成失败。
