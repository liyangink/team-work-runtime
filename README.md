# team-work

## 插件简介

team-work 是平台无关的 multiagent engineering loop。它把研发任务拆成四层能力：

- Workflow 管理任务上下文、阶段、状态和门禁，并判断何时进入团队模式；
- Team-work 按成本设计 Junior、Senior、Expert 拓扑，指导讨论、实施、测试和审查；
- CoreRuntime 用项目内文件保存任务、制品索引、工作项和事件，使任务可以跨会话恢复；
- PlatformPlugin 把统一能力适配到具体 Agent CLI。

当前首个可用 PlatformPlugin 是 OpenCode。团队成员始终以非阻塞 child session 派发；Lead 在同步点汇总结论、处理分歧并续派原成员。npm 包提供安装器 CLI，OpenCode 加载的是安装器物化到目标项目的 Skill、Agent 和 Plugin，并不直接加载 npm 包。

## QuickStart

需要 Node.js 18+ 和 OpenCode 1.18.0+。在目标项目目录执行：

```bash
npx team-work-runtime@latest install
opencode
```

首次安装会自动创建唯一的用户配置 `team-work.config.json`、解析可用模型并检查插件加载。随后直接发起任务：

```text
使用 workflow 处理这个需求。从实际阶段介入，根据并行价值和独立审查价值
决定是否组团；优先使用 Junior 控制成本，所有团队成员后台派发。
```

安装成功后不需要逐项人工检查；出现警告或异常时再查看[常见问题](#常见问题)。

## 常用方式

### 从 Workflow 开始

一般研发任务由 Workflow 创建或恢复任务、管理上下文和阶段，并在值得组团时调用 Team-work。

```text
使用 workflow 实现这个需求，复用现有设计和代码。从 implementation 阶段介入，
完成实现、测试、代码审查和收尾。
```

### 直接使用 Team-work

只需要方案讨论、代码 Review、并行施工或测试团队时，可以直接调用 Team-work；它会创建轻量任务，不要求先运行完整 Workflow。

```text
使用 team-work 对 src/imap/ 做 code-review。从 code-review 阶段介入，
覆盖全部审查视角，安排非作者挑战者，最多三轮收敛并输出 Review 制品。
```

### 从任意阶段介入

声明当前目标和已有制品即可，不需要补跑历史阶段。当前阶段门禁只检查该阶段所需输入，例如代码 Review 可以只有代码和审查范围，不要求设计或 SPEC 文档。

### 查看与继续任务

```text
汇报当前任务的阶段、成员、work item 状态、制品、阻塞和下一同步点，不要启动新成员。
```

跨会话继续时提供 task ID；如果不知道，让 Workflow 解析活动任务。任务状态和制品保存在项目 `.team-work/` 中，控制文件不要手工编辑。

## 配置

项目只使用根目录的 `team-work.config.json`。默认配置通常无需修改：

```json
{
  "schemaVersion": "1.0",
  "platforms": {
    "opencode": {
      "models": "auto"
    }
  },
  "spec": {
    "type": "openspec"
  }
}
```

自动解析存在歧义或只想启用部分成员时，仍然编辑同一个文件，将 `models` 改为 Agent 到完整 `provider/model` 名称的映射：

```json
{
  "schemaVersion": "1.0",
  "platforms": {
    "opencode": {
      "models": {
        "junior-flash": "aigw/deepseek-v4-flash",
        "junior-luna": "aigw/gpt-5.6-luna",
        "senior-terra": "aigw/gpt-5.6-terra"
      }
    }
  },
  "spec": {
    "type": "openspec"
  }
}
```

名称必须与 `opencode models` 返回值一致。自定义可执行文件时可在 `platforms.opencode.command` 或 `spec.command` 中填写路径。`.team-work/config.yaml` 是 Runtime 生成的内部状态，不是第二份用户配置。

## 更新与卸载

```bash
npx team-work-runtime@latest update
npx team-work-runtime@latest uninstall
```

更新会保护并备份受管文件；卸载只移除受管 Skill、Agent、Plugin 和 Runtime 文件，保留 `team-work.config.json`、任务、制品、事件和历史备份。确认覆盖本地修改时使用 `update --force` 或 `uninstall --force`。

## 团队协作约束

- Junior 是默认主力，Senior 处理复杂判断并担任挑战者，Expert 用于保底、攻坚或高风险收口；
- 正式团队至少有一名 Senior 或 Expert 复核非本人制品；
- 每名成员必须有明确范围、完成条件、制品路径和验证要求；
- Lead 不阻塞等待单个成员，只在同步点收集结果；
- 返工和分歧续派原成员，最多三轮，仍不能收敛时请求用户决策；
- 成员自报完成不等于通过，Lead 必须检查制品和证据。

## OpenCode 注意事项

OpenCode 会合并多个配置来源。若已经放弃 OMO，需要从实际生效的全局配置中移除它，或使用独立配置环境。不要用 `--pure` 启动 Team-work，当前 OpenCode 会同时禁用项目 Plugin。

OpenSpec 只在进入默认 SPEC 阶段时需要；缺失不会阻止 standalone Team-work。当前 SPEC 路由默认只支持 OpenSpec。

## 常见问题

### Agent 不可用

运行 `npx team-work-runtime@latest doctor`。`AGENT_UNAVAILABLE` 通常表示模型名称错误、模型不可见或 Agent 未安装；按 `opencode models` 的完整名称修改 `team-work.config.json` 后执行 update。

### 找不到 `team_work_runtime`

确认项目存在 `.opencode/plugins/team-work.js`，并且没有使用 `--pure` 启动；随后运行 doctor 检查安装漂移。

### 网关限流、容量或 API 错误

不要重复创建成员。保留原 work item 和 child session，网关恢复后让 Lead 续派原成员。

### Child session 已失联

确认 session 已删除后，为原 work item 创建新 attempt 再重派，不要把新 session 伪装成旧 session。

### `REVISION_CONFLICT` 或 `GATE_BLOCKED`

前者需要重新读取任务状态再写入；后者需要补齐当前阶段制品或证据，必要时请求人工决定，不要循环重试。

## 开发文档

- [开发契约](AGENTS.md)
- [架构设计](docs/runtime-plugin-design.md)
- [Runtime 接口](docs/runtime-interface.md)
- [实施计划](docs/runtime-implementation-plan.md)
- [OpenCode PlatformPlugin 技术说明](plugins/opencode/README.md)
- [研发验收记录](docs/validation/opencode-real-gateway-2026-08-11.md)

历史 OMO 与 Claude Code Skill 位于 `archive/`，仅供参考，不参与新实现、构建或测试。

```bash
npm test
```
