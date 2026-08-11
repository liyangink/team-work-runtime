# OpenCode 真实网关 E2E 报告

测试日期：2026-08-11。测试目标是优先使用 DeepSeek 与 Luna 验证真实网关、OpenCode 工具调用、后台 child session 和恢复链路，不消耗 Opus、K3 等昂贵模型。

## 环境

- OpenCode：1.18.15；
- Provider：本机已有 AIGW provider；
- 低成本模型：`deepseek-v4-flash`、`gpt-5.6-luna`；
- 安装目标：独立临时项目；
- 模型映射：只解析 `junior-flash` 与 `junior-luna`，其他成员保持 unavailable；
- 凭据：复用本机 OpenCode 配置，未输出或写入仓库。

## 已通过

本节结论对应的脱敏机器可读记录见 [`evidence/2026-08-11-real-gateway.json`](evidence/2026-08-11-real-gateway.json)。该记录保留了实际命令类别、模型、OpenCode session、任务、child session、工具序列、输出标记和 Runtime 事件；不包含网关地址或凭据。

| 验收项 | 结果 | 证据摘要 |
|---|---|---|
| DeepSeek 文本连通 | 通过 | 返回预期固定标记 |
| Luna 文本连通 | 通过 | 返回预期固定标记 |
| DeepSeek 代码检索 | 通过 | 正确调用 `glob`、`read` 并定位错误表达式 |
| Luna 文件修改 | 通过 | 正确调用 `read`、`apply_patch`、`read`，修改结果符合预期 |
| 真实安装 | 通过 | 安装器完成依赖、Agent 加载 smoke 和 Platform Profile 生成 |
| 双成员后台派发 | 通过 | 两次 spawn 均立即返回 `mode: background`，两个 child 并发完成 |
| 状态与结果回收 | 通过 | 两个 child 最终为 `idle`，返回预期结果 |
| 跨进程续派 | 通过 | OpenCode server 重启后沿用同一 child session，resume 成功 |
| Runtime 审计 | 通过 | 记录两次 `platform.dispatch.accepted` 和一次 `platform.resume.accepted` |

平台链路复核入口：

- 临时任务：`real-gateway-team`；
- DeepSeek child：`ses_010ab63c8ffez6azN9R3BqkZcI`；
- Luna child：`ses_010ab63b0ffeZlzfmtqnNQgWFQ`；
- 控制状态：`.team-work/tasks/real-gateway-team/`；
- session 映射：`.team-work/platform/opencode/sessions/real-gateway-team/`；
- 派发结果：`DEEPSEEK_CHILD_OK`、`LUNA_CHILD_OK`；
- 跨进程续派结果：同一 DeepSeek child 返回 `DEEPSEEK_RESUME_OK`。

## 实测发现

1. 即使在空临时项目中，最小模型请求仍有约 12k 输入 token；在本仓库运行时约 14.5k。模型输出很短不代表输入上下文成本很低，真实验收应减少重复启动。
2. OpenCode 配置采用合并语义。项目级 `"plugin": []` 没有移除全局 OMO；这与官方配置合并规则一致。
3. OpenCode 1.18.15 的 `--pure` 能隔离外部插件，但同时使项目本地 `team_work_runtime` 不可用，因此不能作为 Team-work 的生产启动参数。
4. 安装器在只有两个 Junior 映射时行为正确：未解析的 Senior/Expert 不会生成 Agent，并给出明确警告。

## 尚未宣称通过

- 本轮双成员派发是 PlatformPlugin 传输与恢复 E2E，不是完整 Team-work 策略验收。两个成员均为 Junior，没有满足正式团队必须存在 Senior/Expert 非作者挑战者的拓扑规则。
- 当前全局 OpenCode 配置仍包含 OMO。虽然 adapter、原生 child session、模型工具调用和恢复链路均已验证，但还需要在移除 OMO 或独立无 OMO 配置环境中完成一次由 Lead 直接调用 `team_work_*` 工具的场景 E2E。
- 未调用 Expert 模型，也未验证高成本模型的工具兼容性；这是本轮主动的成本控制，不是已通过项。
- 尚未做真实限流或供应商容量故障注入；当前只验证了跨进程恢复，模拟网关失败仍由自动化测试覆盖。

## 下一项最小验收

1. 清理或隔离全局 OMO 配置；
2. 保留 DeepSeek、Luna 作为 Lead/Junior 主链路，并启用一个最低可接受成本的 Senior；
3. 从 `code-review` 或 `implementation` 阶段启动一个小型正式团队；
4. 验证 Workflow 路由、Senior 挑战者、Lead 验收、一次 resume 和最终制品；
5. 不启用 Expert，除非场景本身达到升级条件。
