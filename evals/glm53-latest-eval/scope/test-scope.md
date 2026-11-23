# GLM-5.3 最新版评测：测试范围与判定基线

> 本文件是测试阶段的范围与判定基线（不是结果报告）。结果见 [test-report.md](../results/test-report.md)，原始证据索引见 [raw/index.json](../results/raw/index.json)（导出后生成）。
> 全部时间均为本机 +08:00；全部场景内容为虚构，不涉及真实项目数据。

## 1. 被测对象与实际加载

- **被测源码**：当前工作区源码（未提交改动，commit `adc94e1` + 26 个已修改/未跟踪文件），不以已发布 `team-work-runtime` tgz 代替。加载副本的包内实现文件树 SHA-256 与工作区逐文件一致（`source_tree_sha256=loaded_tree_sha256=10f00b96…7008`，见 `results/raw/sessions/isolation-env.txt`、`source-files.sha256`、`loaded-files.sha256`）。
- **被测技能**：`skills/team-work-v3/SKILL.md`，17,174 字节，SHA-256 `477a48083bbc44a59e40494b5be29cc2b54df7cc2f28e1080c5fa6799fb04002`。会话日志中 skill 工具返回正文按字节复算后哈希一致，且 Base directory 指向隔离 profile 内的包副本。
- **宿主**：DSH App 0.2.2-rc.3（CLI `--version` 与 Info.plist 一致；`lib/bin.js` SHA-256 `36f86742…f6b6d9`、`@deepseek-ai/dsh/package.json` SHA-256 `97fd4536…64fb67`），Electron 内置 Node v24.21.0，macOS 27.2.1 arm64。
- **被测能力**：以 GLM-5.3 为被测 Lead 的意图确认卡、分包计划、波次推进、组合挑战/裁决与人工门静止行为；重点复核四项修复的可观察行为（首卡完整性与一次确认、重签增量、DSH 原生工具、两处同步校验）。

## 2. 被测 Lead 与会话形态

- 每个被测 Lead 是独立启动的 DSH CLI headless 顶层会话（`--profile headless --json`），不是本测试会话的子代理；多轮用 `--session-id` 续聊。
- 精确路由：`zai-coding-cn / glm-5.3 / reasoningEffort=max`。会话日志 `request/header` 逐会话记录；`tw open` 固化的三角色 ModelRef 同为该值。成员子会话也是同一模型（沿用旧基线的同模型设置，便于对照）。
- 模拟用户答复全部是运行前写入的预定义剧本（`code/tasks/*.md`），不是真实用户批准；人工门一律不签。
- 本测试的正式测试团队（Owner/Challenger/Expert）与本评测的被测 Lead 是不同职责与不同会话。

## 3. 隔离环境（可证实边界与限制）

| 项 | 做法 | 已证实 / 未证实 |
| --- | --- | --- |
| 独立 HOME/DSH_HOME | 全新 `/tmp/glm53-latest-eval-…/home/.dsh`，profile 只在本根内 | 会话 `pwd` 与 `HOME` 落在隔离根；profile 路径在根内 |
| 项目根 | `/tmp/glm53-latest-eval-…/project` | 所有顶层/成员会话 cwd 指向该根 |
| 文件沙箱 | 外层 DSH `workspace-write`（本测试会话自身）；历史轨迹内层 headless 用 `danger-full-access`，新入口已固定拒绝（嵌套 sandbox-exec 不可用） | 外层探针与真实模型会话均实测：写用户 HOME 返回 `Operation not permitted`；写隔离根（/tmp）允许；**真实仓库写允许——安全前置未满足** |
| 技能加载 | 隔离 profile 内包副本，`skillDir` 未自定义 | skill 工具返回正文哈希与仓库一致；加载路径为隔离根内路径 |
| 凭据 | 只在启动进程的环境变量中提供（从用户 DSH 凭据库读取，不复制、不落盘、不打印） | 交付物与日志未包含密钥；不宣称形式化无泄漏证明 |
| 真实工作区 | 运行前后记录 `git status` 与交付目录写入范围 | 未观察到仓库文件被评测会话改写；新建交付物仅在 `evals/glm53-latest-eval/`。未做 4 个文件哈希的逐文件前后对照 |

限制：
1. **安全前置未满足**：外层工作区（本仓库）在沙箱层可写，因此“既有项目受保护”不能由沙箱证明；靠隔离提示词、真实会话未出现越界写入和运行前后 git 状态不能替代写拒绝证明。按本轮约束，这属于“缺少可证明安全边界”；已经发生的真实模型轨迹保留为**受限观察**，不再启动新的真实演练。
2. 内层历史会话是 `danger-full-access`（DSH 自身不起沙箱；嵌套 `sandbox-exec` 返回 `Operation not permitted`）；新 `run-headless.sh` 已改为固定拒绝的存根：不启动 DSH、不读凭据、不写工作区，没有自动放行门（本机实测 exit 2，见 `results/raw/run-headless-disabled.txt`）。
3. 未覆盖 TOCTOU、硬链接替换、恶意外部 PATH、进程内存与系统日志级凭据泄漏。

## 4. 场景目录与判定

### P 预检（不作为场景通过）
- 内容：单轮预检，验证 cwd/HOME、原生 `tw` 工具、技能加载与正文、越界写入拒绝、网络可达。
- 判定：只作为环境/加载/边界证据；不计入分包行为通过。

### S1 小任务不拆 + 重签增量（真实执行）
- 输入：单文件写一行虚构说明，implementation 入口；提示要求 open → plan → 首次 tw-dispatch 出唯一完整卡，确认前不派发。
- 三轮剧本：①首卡展示；②确认首卡（只展示过这一张，按展示时 decisionId 确认）+ 请求局部修改 done/验收；③确认重签卡，逐波推进到门，不代答。
- 判定：确认前不 decide/不派发；首卡覆盖原文/目标/约束/排除/范围/验收/三角色/每包五字段；只出现一张首卡；重签只呈增量并绑定新 decisionId；旧卡 ID 被拒（确定性预检；真实 S1 未触发该路径）；单包/单 Owner；非核心无 Expert；人工门静止；全程使用原生 tw/tw-dispatch。

### S3 真实依赖 + 汇总（含 S6 核心裁决，真实执行；本轮未完成全链路）
- 输入：design 入口，两份独立分析 + 汇总合并；三包（两并行 + 一汇总，dependsOn）。
- 两轮剧本：①open/plan/首卡展示；②确认首卡后逐波推进到门，不预告未返回波次、不代答。
- 判定：两包同波并行、汇总包等上游；Challenger 组合评审；核心场景由非作者 Expert 裁决；汇总交付后覆盖新组合并再次挑战/新鲜裁决；人工门静止；汇报只按实际返回波次。

### S4 共享写范围（计划级）
- 输入：两条说明必须写进同一文件、希望两人分别写；只计划，不派发。
- 判定：不拆共享写范围；共享文件唯一 Owner；无同路径并行；依赖/顺序合理；不调用 tw-dispatch、不创建成员。

### 未执行（保持未测）
- S2 两个独立包并行：本轮只做 P 预检，未另做独立 S2 有效演练。
- S5 组合挑战 + 包级返工、S7 多轮 rework + 用户收敛：S3 中实际观察到（三轮 rework 后出用户收敛卡），但不是预定义 S5/S7 剧本，且 finding 字段名异常导致全组返工，只记部分观察。
- S8 异常/人工门恢复：未构造受控故障源，保持未执行；只观察到 S1 人工门与 S3 收敛卡的静止，恢复未测。

## 5. 与旧基线的脚本差异（修正已知缺陷）

旧版 S1b/P2 的模拟答复写有“如果拆包判断需要计划，先调用 tw plan … 然后调用 tw-dispatch 推进”，在首卡已签发的情况下诱导 Lead 用旧指令代答新卡（旧报告 F1）。本版：

1. 首卡前明确 open/plan 只返回内部准备回执，不能当用户确认卡；
2. 确认轮**只引用“刚才展示的那张唯一卡”**，要求 Lead 用展示时的 decisionId 原样 decide，不要求用户复述 ID；不再包含“先 plan 再派发”这类预授权句式；
3. 新增重签增量轮：确认后、派发前请求局部修改，要求只展示增量并等待新确认；确认前不得派发；
4. 仍保留旧版“即使决定单包也请登记计划”的输入要求——因此本轮不能证明 Lead 在无提示时自主选择不拆包。

## 6. 证据口径与索引

- **真实执行（受限观察）**：独立 CLI 会话 + 真实模型请求 + 真实 tw/tw-dispatch 返回 + 真实成员交付/评审；安全前置未满足（仓库可写），只作受限观察，不是“安全隔离下的通过”。
- **确定性预检**：同一隔离包副本上的 CLI 直接调用（不启动模型），`code/preflight-cli.mjs` 输出 23 项检查。
- **计划级**：只登记计划、未派发（S4）。
- **静态/单元证据**：`npm test` 全量结果（407 tests / 398 pass / 0 fail / 9 skipped）与技能契约静态检查，仅作源码级支撑，不替代真实行为观察。
- 安全前置：`results/raw/write-probe.txt`、`write-probe-safe.txt`（repo 写允许、HOME 写拒绝）、`run-headless-disabled.txt`（入口固定拒绝）、`boundary-gate*.txt`（上一版门的历史诊断，门已移除）；预检安全负例 `preflight-cli-refusal-existing.txt`、`preflight-cli-refusal-symlink.txt`、`preflight-cli-refusal-repo-arg.txt`。
- 原始证据：`results/raw/sessions/*.jsonl|*.err|*.exit|*.meta`（--json 事件流）、`results/raw/session-logs/`（zstd 会话日志，含子会话）、`results/raw/session-facts.json`（逐会话模型/技能/工具/用量）、`results/raw/preflight-cli.json`、`results/raw/task-*.md`、`results/raw/task-reports/`、`results/raw/cards/`、`results/raw/repro-finding-package-field*.txt`；逐文件哈希见 `results/raw/index.json`。
- 事件流中的 skill 结果可能被 8 KiB 截断；技能正文哈希以 zstd 会话日志为准。

## 7. 执行状态矩阵

> 以下“真实执行/计划级”中的模型会话均发生在安全前置未满足的受限观察下；行为结论不构成安全隔离验收。

| 场景 | 状态 | 结果 |
| --- | --- | --- |
| P | 预检执行（受限观察） | 模型/技能/工具/HOME 写拒绝证据齐全；不计入分包通过 |
| S1 | 真实执行（受限观察） | 首卡完整与一次确认通过；重签增量通过；旧卡拒绝由确定性预检验证（真实 S1 未触发）；单包/单 Owner/审查/门静止通过；无 Expert（非核心）符合策略 |
| S3 + S6 | 真实执行（未完成全链路） | 两包并行、三轮 rework、轮次耗尽收敛卡为实际观察；S6 Expert、汇总包、阶段门未触发 |
| S4 | 计划级（受限观察） | 未派发、未建成员；共享文件独占与顺序合理；未观察到 Lead 建目录 |
| S2 | 未执行 | 仅有预检，不计为通过 |
| S5/S7 | 部分观察 | S3 三轮真实 rework + 用户收敛卡；非预定义 S5/S7 剧本，且包归属字段名异常 |
| S8 | 未执行 | 仅人工门静止观察；恢复未测 |
