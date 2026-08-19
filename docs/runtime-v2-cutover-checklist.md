# Runtime v2 OpenCode 切换清单

基线：`3ba9366`。V2-0 至 V2-6 已通过 382 项完整测试与 Standards/Spec 双轴复审。本清单是 V2-7 删除旧控制面的人工门禁；确认前不公开部分 v2 工具，也不删除 v1。

## 保留并作为唯一事实源

- `runtime/{application,domain,persistence,ports}/`、`runtime/index.mjs` 及四个稳定接口；
- `workflow/`、`team-work/`、`policy/`、`spec-providers/openspec/`；
- `schemas/v2/`、`tests/v2/`；
- OpenCode `adapter/`、配置、安装生命周期与用户配置；
- 项目任务数据 `.team-work/`。旧 major 只报版本不匹配，不迁移、不删除。

## 新增或重写

- `plugins/opencode/tools/`：只公开 `workflow_open`、`workflow_plan`、`workflow_run`、`workflow_steer` 和成员 `team_work_report`；平台 check hook 在执行前调用 `captureCheck`，执行后调用 `recordCheck`；
- `plugins/opencode/context/`：按 Lead、Owner、Challenger、Expert、Helper 注入最小上下文，只给路径、当前职责、约束和唯一下一步；
- `plugins/opencode/assets/team-work.js`：改为 v2 Runtime Facade + Execution Adapter 的薄装配，不再包含业务编排；
- `plugins/opencode/tui/`：读取 v2 task state 与 OpenCode session 投影，保留 child session 跳转，不保存第二份业务状态；
- `runtime/cli.mjs` 与根 `cli.mjs`：公开 v2 的诊断/只读入口和安装生命周期，不再接受 v1 字符串命令族；
- Workflow/Team-work Skill：只保留协作与使用策略，删除 Runtime 命令、恢复步骤和内部字段教程；
- `plugins/opencode/src/lifecycle.mjs`：物化新的 tools/context/adapter/runtime 文件并更新 manifest、doctor、update、uninstall。

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
- Lead tool meta 不出现 revision、gate、work-item、session、SPEC command 或恢复教程；
- OpenCode 受管成员仍只用 background/promptAsync；同 assignment 正常返工复用 session，lost 恢复使用新 session；
- TUI 仅从 Runtime authoritative state 和 Adapter session projection 生成视图；
- 删除 v1 后完整测试全绿，且 `rg` 证明没有 v2→v1 import；
- 切换前提交可回退基线，切换提交保持单一、可审查。

## 人工确认

确认本清单即授权 V2-7 在当前分支删除上述 v1 代码、schema、fixture 和专属测试，并同步重写公开 OpenCode 控制面、CLI、安装器、Skill 与 TUI。此确认不授权删除 `.team-work/` 用户任务数据，也不授权发布 npm 或推送远端。
