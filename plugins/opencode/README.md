# OpenCode PlatformPlugin

本目录把平台无关的 Workflow、Team-work、CoreRuntime 装配到 OpenCode 项目中。安装目标使用 OpenCode 官方自动发现目录 `.opencode/skills/`、`.opencode/agents/` 和 `.opencode/plugins/`；不会修改 provider、网关、凭据、MCP 或用户的 `opencode.json`。

## 准备模型映射

Agent 的 `model` 必须是 OpenCode 可识别的完整 `provider/model`。先复制 [`config/model-map.example.json`](config/model-map.example.json)，把 `your-provider` 改成 `opencode models` 输出中的 provider。未显式映射时安装器会尝试按模型名唯一匹配；零个或多个匹配都不会猜测，对应 Agent 不会生成，但会保留在 Platform Profile 中供诊断。

## 安装

在本仓库根目录执行：

```bash
node plugins/opencode/scripts/manage.mjs install \
  --project /absolute/path/to/project \
  --model-map /absolute/path/to/model-map.json
```

安装器要求 OpenCode `>= 1.18.0`，不限制更高版本。它会安装生产依赖、初始化缺失的 `.team-work` Workflow 配置，并生成安装清单。已有 Workflow/SPEC 配置不会被覆盖。
写入完成后还会执行 `opencode agent list`，确认 Plugin 能加载且已解析模型的 Agent 可见；失败会回滚受管文件。

## 更新与检查

```bash
node plugins/opencode/scripts/manage.mjs update --project /absolute/path/to/project --model-map /absolute/path/to/model-map.json
node plugins/opencode/scripts/manage.mjs doctor --project /absolute/path/to/project
```

- 内容未变化时返回 `unchanged`。
- 更新会先把当前受管文件完整备份到 `.team-work/platform/opencode/backups/`。
- 受管文件有本地修改时默认拒绝覆盖；确认后使用 `update --force`，本地版本仍会先备份。
- 新版本缺失的旧受管文件会安全移除；用户自己的 `.opencode` 文件不在清单中，不会被处理。

## 卸载

```bash
node plugins/opencode/scripts/manage.mjs uninstall --project /absolute/path/to/project
```

卸载只删除清单中且 digest 未变化的文件。修改过的受管文件默认保留并返回 `partial`；确认后使用 `uninstall --force`，安装器会备份再删除。

以下内容始终保留：

- `.team-work/tasks/`、任务制品、事件和归档；
- Workflow/SPEC 项目配置；
- provider、模型网关、凭据和 MCP 配置；
- 不在安装清单中的 Skill、Agent、Plugin 和其他项目文件；
- 安装审计、卸载 tombstone 和历史备份。

`--skip-dependencies` 和 `--skip-smoke` 仅用于仓库测试，不应在真实项目安装时使用。
