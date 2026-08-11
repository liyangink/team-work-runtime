# OpenCode PlatformPlugin

本模块把平台无关的 Workflow、Team-work 和 CoreRuntime 装配到 OpenCode。面向用户的安装、配置和使用说明见 [`../../README.md`](../../README.md)。

## 安装边界

公开入口是：

```bash
npx team-work-runtime@latest install
```

安装是用户级操作，不依赖当前项目。默认位置：

- 用户配置：`~/.config/team-work/config.json`
- Skill：`~/.config/opencode/skills/`
- Agent：`~/.config/opencode/agents/`
- Plugin：`~/.config/opencode/plugins/team-work.js`
- Runtime、Profile、指南和安装清单：`~/.config/opencode/team-work/`

设置 `XDG_CONFIG_HOME` 时，上述 `.config` 根目录随之变化。路径符合 OpenCode 的全局 Skill、Agent 与 Plugin 自动发现约定；安装器不修改 provider、网关、凭据、MCP 或用户的 `opencode.json`。

首次在项目内调用 Team-work Runtime Tool 时，Plugin 才初始化项目 `.team-work/`，并物化当前 Platform Profile 与增量指南。安装、更新和卸载都不扫描或删除各项目任务数据。

## 模型与 effort

安装器只读取固定用户配置。`models: "auto"` 按模型名唯一匹配；没有匹配或存在歧义时不猜测，不生成对应 Agent，并在 Platform Profile 中保留诊断信息。

显式映射必须使用 OpenCode 可识别的完整 `provider/model`。可选 `effort` 会物化为 Agent frontmatter 的 `reasoningEffort`；模型、Provider 或网关不支持时应省略。

## OpenSpec

用户配置中的 `spec.command` 会物化到全局 Platform 设置。项目首次初始化时，Plugin 用 `--version` 和只读的 `list --json` 检查 OpenSpec；只有返回 `{ "changes": [...] }` 才把项目 SPEC 路由标为 `ready`。

OpenSpec 缺失或项目未初始化时只保持 `missing`，不会阻止非 SPEC 阶段，也不会静默安装工具或修改 OpenSpec 资产。

## 生命周期

```bash
npx team-work-runtime@latest doctor
npx team-work-runtime@latest update
npx team-work-runtime@latest uninstall
```

更新会检查 digest，并在强制覆盖前备份受管文件。卸载只处理安装清单中的用户级资产；本地修改默认保留，`--force` 会先备份再删除。用户配置和项目 `.team-work/` 始终保留。

## 平台运行规则

受管成员使用 OpenCode 原生 `session.create + promptAsync` 后台派发。Lead 通过稳定 task/work-item ID 查询、收集和续派；禁止用阻塞式 `task` 工具替代受管派发。

网关错误、重试、续派、停止和 child session 失联会记录为 `platform.*` 事件。事件审计失败不改变 work item 验收状态，也不会把成功派发改成失败。
