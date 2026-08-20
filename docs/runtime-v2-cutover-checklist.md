# Runtime v2 OpenCode 切换清单

基线：`3ba9366`。V2-0 至 V2-6 已通过 382 项完整测试与 Standards/Spec 双轴复审。本清单是 V2-7 删除旧控制面的人工门禁；确认前不公开部分 v2 工具，也不删除 v1。

状态：已获人工授权并完成切换与终审；未推送、未发布，也未删除项目 `.team-work/` 数据。

## 保留并作为唯一事实源

- `runtime/{application,domain,persistence,ports}/`、`runtime/index.mjs` 及五个稳定接口：`LeadControl`、`MemberDelivery`、`PlatformObservationSink`、`ExecutionAdapter`、`SpecProviderAdapter`；
- `workflow/`、`team-work/`、`policy/`、`spec-providers/openspec/`；
- `schemas/v2/`、`tests/v2/`；
- OpenCode `adapter/`、配置、安装生命周期与用户配置；
- 项目任务数据 `.team-work/`。旧 major 只报版本不匹配，不迁移、不删除。

## 新增或重写

- `runtime/persistence/`：新增生产文件型 ArtifactRepository，负责受控路径读取、digest、声明输出归属校验与 symlink/path escape 防护；
- `plugins/opencode/tools/`：Lead 只公开 `workflow_open`、`workflow_plan`、`workflow_run`、`workflow_steer`，成员只公开 `team_work_report`；配置 helper 时可额外注入成员专属的只读 assist 工具，不得向 Lead 或 helper 自身开放；平台 check hook 在执行前调用 `captureCheck`，执行后调用 `recordCheck`；
- `plugins/opencode/context/`：按 Lead、Owner、Challenger、Expert、Helper 注入最小上下文，只给路径、当前职责、约束和唯一下一步；
- `plugins/opencode/assets/team-work.js`：改为 v2 Runtime Facade + Execution Adapter 的薄装配，不再包含业务编排；宿主按 Lead session 隔离活动任务，使用持久 lead/task binding 在重启后的下一次 `open/run` 恢复，存在歧义时拒绝猜测；
- `plugins/opencode/tui/`：读取 v2 task state 与 OpenCode session 投影，保留 child session 跳转，不保存第二份业务状态；
- `runtime/cli.mjs` 与根 `cli.mjs`：公开 v2 的诊断/只读入口和安装生命周期，不再接受 v1 字符串命令族；
- Workflow/Team-work Skill：只保留协作与使用策略，删除 Runtime 命令、恢复步骤和内部字段教程；
- `plugins/opencode/src/lifecycle.mjs`：物化新的 tools/context/adapter/runtime 文件，并同步切换 profile、config schema、Agent tool 权限、manifest、doctor、update、uninstall；V2-7 只要求这些入口完整切到 v2，生命周期破坏性强化与真实安装 E2E 留在 V2-8。

## 删除

- `runtime/core.mjs` 及其中 `executeRuntime`；
- `plugins/opencode/src/lead-controller.mjs`；
- `plugins/opencode/src/opencode-adapter.mjs` 的 v1 业务编排（由新的薄装配完全替换后删除文件）；
- `skills/workflow/references/runtime-commands.md`；
- v1 schema：`binding`、`context-entry`、`event`、`project-config`、`response`、`task`、`work-item`、`work-items`、`workflow`、旧示例和仅为其服务的 semantic validator；
- `tests/fixtures/runtime/` 的 v1 fixture；
- 只验证 v1 CLI、Runtime 命令、LeadController 与旧 OpenCode Adapter 的测试：`core-runtime`、旧 `runtime-contract`、`opencode-adapter`、`opencode-e2e`；
- lifecycle/TUI/package 测试中的 v1 断言会重写为 v2 断言，不整文件删除。

## 强制验证

- import graph、npm `files`、安装 manifest、doctor 和测试不再引用上述 v1 文件；
- 自动生成并复核最终删除引用账本；`package.json` 覆盖新增 tools/context，`docs/file-inventory.json` 同步新增、删除和重分类路径；
- Lead tool meta 不出现 revision、gate、work-item、session、SPEC command 或恢复教程；
- OpenCode 受管成员仍只用 background/promptAsync；同 assignment 正常返工复用 session，lost 恢复使用新 session；
- TUI 仅从 Runtime authoritative state 和 Adapter session projection 生成视图；
- ArtifactRepository 覆盖损坏输入、缺失输出、外部修改、symlink/path escape、并发读取与幂等快照；安装生命周期变更覆盖损坏输入、并发、失败恢复和幂等；
- 删除 v1 后完整测试全绿，且 `rg` 证明没有 v2→v1 import；
- 切换前提交可回退基线，切换提交保持单一、可审查。

## 人工确认

确认本清单即授权 V2-7 在当前分支删除上述 v1 代码、schema、fixture 和专属测试，并同步重写公开 OpenCode 控制面、CLI、安装器、Skill 与 TUI。此确认不授权删除 `.team-work/` 用户任务数据，也不授权发布 npm 或推送远端。

## 完成证据

- 公开 Lead 控制面仅保留 `open / plan / run / steer`，成员与 helper 权限按角色隔离；
- v1 Runtime、命令、schema、fixture、专属测试和兼容路径已删除；
- 持久绑定、事件唤醒、宿主重启对账、完整 steering 与 ArtifactRepository 已纳入自动测试；
- 完整仓库测试 321/321 通过，最终 Standards/Spec 双轴审查均无 P0/P1；
- npm dry-run 打包通过，共 115 个文件；未推送、未发布、未改动项目 `.team-work/` 数据。
