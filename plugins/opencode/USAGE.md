# OpenCode 使用指南

本指南面向实际使用者。安装器参数和文件归属见 [PlatformPlugin 配置说明](README.md)，Agent 内部执行规则仍以安装后的 Workflow、Team-work Skill 和平台增量指南为准。

## 1. 准备环境

需要：

- Node.js 18 或更高版本；
- OpenCode 1.18.0 或更高版本；
- 已在 OpenCode 中配置并认证的模型 provider；
- 正式团队至少有一名可担任非作者挑战者的 Senior 或 Expert；Junior 是成本优先的默认主力，但不是硬性成员；
- 只有进入 SPEC 阶段才要求对应 SPEC 工具可用，默认是 OpenSpec。单独使用 Team-work 不依赖 OpenSpec。

先确认模型名称：

```bash
opencode --version
opencode models <provider>
```

### 避免旧编排插件干扰

OpenCode 的配置文件采用合并语义，而不是整份替换。项目里的 `"plugin": []` 不能可靠删除全局 `~/.config/opencode/opencode.json` 已声明的 npm 插件。若已经放弃 OMO，应从实际生效的全局配置中移除其 plugin 条目，或者使用独立的 OpenCode 配置目录维护一套不含 OMO 的配置。

不要把 `opencode --pure` 当作 Team-work 的日常启动方式。OpenCode 1.18.15 实测中，`--pure` 在隔离 OMO 的同时也禁用了项目本地 `.opencode/plugins/team-work.js`。它只适合做不依赖 Team-work Plugin 的模型基线检查。

OpenCode 官方配置合并与优先级说明见 [Config 文档](https://opencode.ai/docs/config/)。

## 2. 配置模型映射

复制 [模型映射示例](config/model-map.example.json) 到仓库外的本地文件，并把值改为 `opencode models` 输出的完整 `provider/model`：

```json
{
  "junior-flash": "your-provider/deepseek-v4-flash",
  "junior-luna": "your-provider/gpt-5.6-luna",
  "senior-terra": "your-provider/gpt-5.6-terra"
}
```

映射文件不保存 API Key。可以只映射当前需要的成员；未解析的成员会保留在 Platform Profile 中用于诊断，但不会生成可派发 Agent。正式团队若只有 Junior，无法满足“非作者 Senior/Expert 挑战者”规则，应补充至少一个高档位成员。

## 3. 安装并检查

在 team-work 源码仓库根目录执行：

```bash
node plugins/opencode/scripts/manage.mjs install \
  --project /absolute/path/to/project \
  --model-map /absolute/path/to/model-map.json

node plugins/opencode/scripts/manage.mjs doctor \
  --project /absolute/path/to/project
```

安装成功应满足：

- 返回 `status: installed`；
- `.opencode/skills/workflow/` 和 `.opencode/skills/team-work/` 存在；
- `.opencode/plugins/team-work.js` 存在；
- 已映射的 `.opencode/agents/<agent>.md` 存在；
- `.team-work/platform/opencode/profile.json` 中相应成员具有 `resolvedModel`；
- `doctor` 没有 Plugin 或受管文件错误。

验证 Agent 的最终模型：

```bash
opencode debug agent junior-flash
opencode debug agent junior-luna
```

若安装器只提示 OpenSpec 未初始化，Standalone Team-work 仍可使用；进入 SPEC 阶段前再执行项目所需的 OpenSpec 初始化。

## 4. 开始日常任务

### 从 Workflow 开始

一般研发任务从 Workflow 开始。用户描述目标和约束即可，不需要手工调用 Runtime 工具：

```text
使用 workflow 处理这个需求。先从 implementation 阶段介入，复用现有代码；
根据并行价值和独立审查价值决定是否组团。优先使用 Junior 控制成本，
所有成员必须后台派发，完成实现、测试和代码审查后再收尾。
```

Workflow 会创建或恢复任务、注册上下文、判断 solo/team、在需要组团时调用 Team-work，并按当前阶段门禁推进。存在多个活动任务时，它应停止猜测并要求指定任务。

### 显式使用 Team-work

需要明确的团队讨论、Review 或并行施工时可以直接调用 Team-work：

```text
使用 team-work 对当前代码做 code-review。从 code-review 阶段创建轻量任务，
审查范围是 src/imap/；覆盖完整审查视角，安排一名非作者挑战者，
所有成员后台运行，最多三轮收敛，最终输出 review 制品和 Lead 汇总。
```

显式调用不要求先存在 Workflow 任务。Team-work 会按目标选择阶段并创建轻量任务，也不会要求补齐设计或 SPEC 等无关历史制品。

### 从任意阶段介入

只声明当前要做的阶段和已有制品即可：

- 已有代码直接做 Review：`code-review`；
- 已有代码补测试：`test`；
- 已有设计做评审：`design-review`；
- 只讨论方案：`design`；
- 完整研发循环：让 Workflow 从实际起点开始。

门禁只检查当前环节所需输入。例如代码 Review 可以只有代码与审查范围，没有设计和 SPEC 不会形成死门。

## 5. 团队运行时会发生什么

Lead 应执行以下动作，用户通常不需要逐条下命令：

1. 创建任务并绑定当前 OpenCode session；
2. 记录团队决策；
3. 设计最低充分拓扑，优先 Junior，并指定 Senior/Expert 挑战者；
4. 为每位成员创建有范围、完成条件和制品路径的 work item；
5. 使用 `team_work_spawn` 创建原生 child session，并通过 `promptAsync` 后台派发；
6. Lead 继续处理独立工作，只在同步点查询和收集结果；
7. 对不合格结果使用同一 child session 续派，最多三轮收敛；
8. Lead 检查原始制品和证据后接受、返工或上报用户决定。

`team_work_spawn` 返回的 `mode` 应为 `background`。不要用阻塞式原生 `task` 替代受管派发。

## 6. 查看任务与团队状态

优先直接询问 Lead：

```text
汇报当前 team-work 任务：阶段、团队成员、每个 work item 状态、child session、
已生成制品、阻塞和下一同步点。不要启动新的成员。
```

需要人工诊断时可以读取：

- `.team-work/tasks/<task-id>/task.json`：任务、阶段与 revision；
- `.team-work/tasks/<task-id>/work-items.json`：成员分工和验收状态；
- `.team-work/tasks/<task-id>/context.jsonl`：上下文索引；
- `.team-work/tasks/<task-id>/events.jsonl`：决策、派发和恢复审计；
- `.team-work/platform/opencode/sessions/<task-id>/`：work item 到 child session 的稳定映射；
- 任务中登记的设计、代码、测试和 Review 制品：事实源。

这些控制文件只能读取，不应手工编辑。

## 7. 跨会话继续与故障恢复

新会话中直接说明继续任务；如果知道 task ID，一并提供：

```text
使用 workflow 继续任务 <task-id>。先读取 Runtime 状态、上下文索引、work item
和平台 session 映射，再决定收集、续派、返工或推进；不要根据聊天记忆重建状态。
```

恢复原则：

- 网关限流、容量不足或 API 错误：保留原 work item 和 child session，网关恢复后有界重试 `resume`；
- 主 OpenCode 进程或会话切换：通过 task/work-item/session 映射恢复，不创建重复成员；
- child session 已删除或确认失联：创建新的 work item attempt 后重派，不伪装成原 session 续接；
- 多个活动任务：明确 task ID，不自动选择“最近任务”；
- 三轮仍有重大分歧：进入用户决策，不无限循环。

## 8. 常见问题

| 现象或错误 | 含义 | 处理方式 |
|---|---|---|
| `AGENT_UNAVAILABLE` | Agent 未安装、模型未解析或不在候选池 | 检查 model map、`opencode models`、Platform Profile，并执行 update |
| `TEAM_TASK_REQUIRED` | 任务尚未记录为 team，或已不活动 | 让 Workflow/Team-work 重新读取任务并记录正确团队决策 |
| `OPENCODE_API_ERROR` | 网关、限流、容量或 OpenCode API 失败 | 查询 child 状态；保留映射，网关恢复后 resume |
| `SESSION_MAPPING_EXISTS` | 同一 work item 已派发过 | 使用 resume，不要重复 spawn |
| `SESSION_LOST` | 原 child session 已确认失联 | 新建 attempt/work item 后重派 |
| `REVISION_CONFLICT` | Lead 使用了过期控制状态 | 重新读取 task/work item，再做决策和写入 |
| `GATE_BLOCKED` | 当前阶段的制品或证据不足 | 按 blocker 补齐、返工或请求人工覆盖；不要死循环重试 |
| `OPENSPEC_*` | 默认 SPEC 路由尚未准备 | 仅在需要 SPEC 阶段时安装/初始化 OpenSpec；Standalone Team-work 可继续 |
| 找不到 `team_work_runtime` | Team-work Plugin 未加载，常见于 `--pure` 或安装漂移 | 正常启动 OpenCode，运行 doctor；确认项目 `.opencode/plugins/team-work.js` |
| 仍出现 OMO Agent/提示词 | 全局 OMO 配置仍参与合并 | 从生效的全局配置移除 OMO，重启 OpenCode 后再验收 |

## 9. 更新与卸载

```bash
node plugins/opencode/scripts/manage.mjs update \
  --project /absolute/path/to/project \
  --model-map /absolute/path/to/model-map.json

node plugins/opencode/scripts/manage.mjs uninstall \
  --project /absolute/path/to/project
```

更新前会备份受管文件；本地改过的受管文件默认拒绝覆盖。卸载只移除清单中的受管文件，任务、制品、事件、项目配置和历史备份会保留。完整语义与 `--force` 使用条件见 [PlatformPlugin 配置说明](README.md)。

## 10. 发布前真实网关验收

建议依次验证：

1. 每个启用模型完成一次极小文本请求；
2. Junior 模型执行检索/读取，另一模型执行读取/编辑/复读；
3. 安装器真实执行并通过 Agent 加载 smoke；
4. 两个低成本成员后台派发，`spawn` 立即返回 `background`；
5. 两个 child 均可查询、收集并得到预期制品；
6. 重启 OpenCode server 后，对原 child session 执行 resume；
7. 最后再做一次符合正式拓扑的 Lead 驱动场景验收。

本仓库当前实测结果和未覆盖边界见 [真实网关 E2E 报告](REAL-GATEWAY-E2E.md)。
