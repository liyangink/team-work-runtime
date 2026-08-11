# OpenCode PlatformPlugin

本目录把平台无关的 Workflow、Team-work、CoreRuntime 装配到 OpenCode 项目中。安装目标使用 OpenCode 官方自动发现目录 `.opencode/skills/`、`.opencode/agents/` 和 `.opencode/plugins/`；不会修改 provider、网关、凭据、MCP 或用户的 `opencode.json`。

- 面向用户的简介、QuickStart、配置和日常使用：[`../../README.md`](../../README.md)

OpenCode 配置会合并多个来源。安装器不会替用户移除全局 OMO 等旧插件；若要无 OMO 运行，必须先清理或隔离实际生效的全局配置。不要使用 `--pure` 启动 Team-work：OpenCode 1.18.15 实测会同时禁用项目本地 Team-work Plugin。

## 模型解析

安装器只读取项目根目录的 `team-work.config.json`。`models: "auto"` 会按模型名唯一匹配；零个或多个匹配都不会猜测，对应 Agent 不会生成，但会保留在 Platform Profile 中供诊断。显式映射时，值必须是 OpenCode 可识别的完整 `provider/model`。允许只启用少量成员做低成本 smoke；正式组团至少还要有一名可担任挑战者的 Senior 或 Expert。

## 安装

公开入口由 npm 包的统一 CLI 提供：

```bash
npx team-work-runtime@latest install
```

安装器要求 OpenCode `>= 1.18.0`，不限制更高版本。它会安装生产依赖、初始化缺失的 `.team-work` Workflow 配置，并生成安装清单。已有 Workflow/SPEC 配置不会被覆盖。
写入完成后还会执行 `opencode agent list`，确认 Plugin 能加载且已解析模型的 Agent 可见；失败会回滚受管文件。

默认 SPEC 路由是 OpenSpec。安装器检查 `openspec --version`，并在项目目录执行只读的 `openspec list --json` 就绪探针，只有返回合法的 `{ "changes": [...] }` 才视为可用；`config.yaml` 按官方约定是可选项。探针也兼容由 OpenSpec CLI 解析的外部 store/pointer 布局。install/update 会把默认路由双向同步为 `ready` 或 `missing`，doctor 只读检查。缺失时返回警告和修复建议，不会静默安装 CLI 或执行 `openspec init`。使用非默认可执行文件时在 `team-work.config.json` 中设置 `spec.command`；自定义或禁用的 Runtime SPEC 路由原样保留。

## 更新与检查

```bash
npx team-work-runtime@latest update
npx team-work-runtime@latest doctor
```

- 内容未变化时返回 `unchanged`。
- 更新会先把当前受管文件完整备份到 `.team-work/platform/opencode/backups/`。
- 受管文件有本地修改时默认拒绝覆盖；确认后使用 `update --force`，本地版本仍会先备份。
- 新版本缺失的旧受管文件会安全移除；用户自己的 `.opencode` 文件不在清单中，不会被处理。
- `doctor` 同时报告 OpenSpec CLI、只读就绪探针和不安全符号链接；这些问题只阻止 SPEC 路由就绪，不阻止 standalone Team-work。

## 平台事件与恢复

受管派发、续派、停止，以及 OpenCode 上报的重试、API 错误和 child session 删除，会以 `platform.*` 事件写入当前 Runtime 任务。事件审计是旁路：审计暂时失败不会把成功派发改成失败，也不会修改 work item 的验收状态。网关失败会保留 task/work-item/session 映射，恢复后用 `team_work_resume` 继续同一 work item。

## 卸载

```bash
npx team-work-runtime@latest uninstall
```

卸载只删除清单中且 digest 未变化的文件。修改过的受管文件默认保留并返回 `partial`；确认后使用 `uninstall --force`，安装器会备份再删除。

以下内容始终保留：

- `.team-work/tasks/`、任务制品、事件和归档；
- Workflow/SPEC 项目配置；
- provider、模型网关、凭据和 MCP 配置；
- 不在安装清单中的 Skill、Agent、Plugin 和其他项目文件；
- 安装审计、卸载 tombstone 和历史备份。

仓库测试通过编程接口注入假模型和跳过外部 smoke；这些选项不属于公开 CLI。
