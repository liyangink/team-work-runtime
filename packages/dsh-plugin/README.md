# team-work-runtime-dsh

team-work-runtime 的 DSH 平台绑定插件。

## 功能

- **成员模型/effort 注入**：continuable 子代理（后台 subagent）创建/恢复时，按 `.team-work/platform/agents.json` 的 modelHints（`tw agent-map` 自动落盘）注入 provider/model/reasoningEffort——tier→模型映射直达团队成员；
- **skill 注册**：team-work-v3 判断指引内嵌（与 `tw init` 文件通道同源同版本，后者为无插件环境兜底）；
- **tw 原生工具**：成员直接调用 `tw` 工具（args 透传 CLI），无需 PATH；
- **模型席位徽标**：子代理会话显示实际执行的 provider/model · 推理等级（注入效果肉眼可核）。

## 安装

```bash
dsh plugin add team-work-runtime-dsh
```

开发期（本仓库）：`node packages/dsh-plugin/build.mjs` 构建后按 profile 手动装配。

## 配置（可选）

```yaml
# 插件 config（通常零配置——默认从项目目录自动发现）
projectRoot: /path/to/project   # 多项目/非标准布局时显式指定
twBin: /path/to/bin/tw.mjs      # tw 入口（默认解析 peerDependencies 的 team-work-runtime）
skillDir: /path/to/skill        # 覆盖内嵌 skill 目录
```

模型映射数据在项目侧 `.team-work/platform/dsh.json`（档位候选数组，参考主包 README；示例用公开模型名如 deepseek-v4-flash / glm-5.3）。

## 实机验证（安装后确认注入生效）

1. 安装后重启 dsh 会话；开一个后台 subagent 任务（`tw agent-map --task <名> --key <派单key> --agent <subagentId>` 已登记 modelHints 的）；
2. **注入确认**：子代理会话的模型席位显示注入的 provider/model（而非主会话默认）即注入生效——这也覆盖徽标功能确认；
3. **effort 确认**：dsh.json 该档候选带 effort 字段时，席位显示"· 推理 <档位>"；若平台 request header 不落 effort（已知边界），注入仍生效于运行时选择；
4. 多任务并发时各子代理各显示各自注入（隔离确认）。

## 边界

- 注入仅覆盖 continuable 子代理（workflow 一次性子代不可达——恰为只读廉价扇出场景）；
- 注入失败逐级静默降级为继承默认模型（不阻塞任务）；
- 徽标仅在线子代理会话显示。
