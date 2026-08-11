# team-work

平台无关的 multiagent engineering loop。当前从零实现 Workflow、Team-work、CoreRuntime 与 OpenCode PlatformPlugin。

- 开发契约：[`AGENTS.md`](AGENTS.md)
- 架构设计：[`docs/runtime-plugin-design.md`](docs/runtime-plugin-design.md)
- 实施计划：[`docs/runtime-implementation-plan.md`](docs/runtime-implementation-plan.md)
- 文件清单：[`docs/file-inventory.json`](docs/file-inventory.json)

历史 OMO 与 Claude Code Skill 位于 `archive/`，仅供参考，不参与新实现、构建或测试。

## 当前进度

Runtime Interface 1.0、文件型 CoreRuntime MVP、Workflow 与 Team-work Policy Skill 已实现；OpenCode PlatformPlugin 已完成安装/更新/卸载、分档 Agent、非阻塞 child session、Runtime Tool 和上下文 Hook。DeepSeek/Luna 真实网关的检索、修改、双 child 后台派发和跨进程续派已经通过；无 OMO 的正式挑战者拓扑验收仍待完成。安装配置见 [`plugins/opencode/README.md`](plugins/opencode/README.md)，实际使用见 [`plugins/opencode/USAGE.md`](plugins/opencode/USAGE.md)。当前 Runtime 也可直接通过源码运行：

```bash
node runtime/cli.mjs init --project /path/to/project --json
node runtime/cli.mjs task create --project /path/to/project \
  --task review-task --entry-stage code-review --json
node runtime/cli.mjs doctor --project /path/to/project --json
```

测试：

```bash
npm test
npm run test:runtime
npm run test:policy
npm run test:opencode
```
