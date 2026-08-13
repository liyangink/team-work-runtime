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
- Runtime、Profile、指南和安装清单：`~/.config/opencode/team-work/`

用户配置支持 `TEAM_WORK_CONFIG_HOME`、`XDG_CONFIG_HOME` 和 Windows `%APPDATA%`。OpenCode 安装根遵循其全局目录；安装器不修改 provider、网关、凭据、MCP 或用户的 `opencode.json`。

首次在项目内调用 Team-work Runtime Tool 时，Plugin 才初始化项目 `.team-work/`，并物化当前 Platform Profile 与增量指南。安装、更新和卸载都不扫描或删除各项目任务数据。

## 模型与 effort

`agents: "auto"` 在安装或更新时按模型名唯一匹配；没有匹配或存在歧义时不猜测，并在 Platform Profile 中保留诊断信息。

显式 Agent 必须使用 OpenCode 可识别的完整 `provider/model`。Plugin 启动时动态注入 Agent，`effort` 映射为 Agent 级 `reasoningEffort`。修改后重启 OpenCode 即可。

可选的顶层 `helper` 使用独立模型和 effort，同时生成隐藏的 `team-work-explore` 与 `team-work-librarian`。它不继承 Junior；未配置时不注入只读助手。

## OpenSpec

Plugin 启动时读取 `spec.command` 和 `spec.mode`。项目首次初始化时用 `--version` 与只读的 `list --json` 检查 OpenSpec；只有返回 `{ "changes": [...] }` 才标为 `ready`。

`auto` 在 missing 时跳过 SPEC，`required` 会阻塞，`disabled` 始终跳过。Plugin 不会静默安装工具或修改 OpenSpec 资产。

## 生命周期

```bash
npx team-work-runtime@latest update
npx team-work-runtime@latest uninstall
```

更新会检查 digest，并在强制覆盖前备份受管文件。卸载只处理安装清单中的用户级资产；本地修改默认保留，`--force` 会先备份再删除。用户配置和项目 `.team-work/` 始终保留。

`doctor` 只用于故障诊断，会检查显式绑定的模型是否仍出现在 `opencode models` 中；它不是更新或卸载的前置步骤。

## 平台运行规则

OpenCode PlatformPlugin 内部分为 Server、TUI 和 Installer 子模块，不增加新的产品级 Module。Server 负责工具、Hook、session 映射和事件；TUI 在原生 `sidebar_content` 插槽中展示当前任务成员状态并调用原生 session route 跳转；Installer 统一安装、更新和卸载两类入口及其依赖。

`solo` 与 `team` 的受管成员都使用 OpenCode 原生 `session.create + promptAsync` 后台派发。Lead 通过稳定 task/work-item ID 查询、收集和续派；同一 work item 默认复用 child session，失联或停止后才受控替换并保留历史。禁止用阻塞式 `task` 工具替代受管派发。

受管成员可通过 `team_work_assist` 创建临时只读 helper child session。该链路同样使用 `promptAsync`，只允许代码探索或资料检索；助手不能继续委托或成为 Runtime work item Owner。

网关错误、重试、续派、停止和 child session 失联会记录为 `platform.*` 事件。事件审计失败不改变 work item 验收状态，也不会把成功派发改成失败。
