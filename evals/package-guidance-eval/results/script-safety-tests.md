# 脚本安全门验证（v3，可重复夹具）

- 验证对象：`code/setup-isolation.sh`、`code/run-headless.sh`（v3）。
- 验证方式：只创建新的 `/tmp` 夹具根；所有“外部目标”都是新建隔离哨兵目录/文件，带 `KEEP` 标记；使用无副作用 Electron 桩（只打印 cwd/argv，可选读 stdin），**不启动真实 DSH、不调用模型、不使用凭据、不运行原危险脚本**。
- 可重复命令：`bash evals/package-guidance-eval/code/test-safety-guards.sh`。最近一次运行夹具：`/tmp/twr-eval-safety-a36Ue8`（保留供复查，未删除）。
- 最近结果：**RESULT: OK**，全部断言通过。

## 覆盖用例

| 用例 | 触发 | 期望 | 结果 |
| --- | --- | --- | --- |
| T1 | 目标根已存在 | 拒绝且不删除 | exit 2，`KEEP` 保留 |
| T2 | 目标根为软链 | 拒绝且目标不动 | exit 2，目标 `KEEP` |
| T3 | 目标在真实仓库内 | 拒绝且不创建 | exit 2，未创建 |
| T4 | 目标在 HOME 内 | 拒绝且不创建 | exit 2，未创建 |
| T5 | 全新根正常创建 | 成功、技能哈希一致、无凭据文件 | exit 0，副本存在，`credentials=no` |
| T19 | 输入包是软链 | 拒绝且原包不动 | exit 2，包内标记 `KEEP` |
| T20 | 输入包的 `skills/team-work-v3` 是软链 | 拒绝且外部目标不动 | exit 2，外部标记 `KEEP` |
| T21 | 依赖目录含软链 | 复制后检测到软链即拒绝，不做删除 | exit 2，外部目标 `KEEP` |
| T22 | 期望技能哈希不匹配 | 拒绝 | exit 3 |
| T6 | 缺 project | 拒绝且桩不调用 | exit 2，无桩标记 |
| T7 | project 为目录软链 | 拒绝且桩不调用 | exit 2，无桩标记 |
| T11 | HOME 为软链 | 拒绝且桩不调用 | exit 2，无桩标记 |
| T12 | DSH_HOME 为软链 | 拒绝且桩不调用 | exit 2，无桩标记 |
| T13 | evidence 为软链 | 拒绝且桩不调用 | exit 2，无桩标记 |
| T14 | TAG = `../escape` | 拒绝且桩不调用、无逃逸输出 | exit 2，无桩标记、无文件 |
| T15 | TAG 含 `/` | 拒绝 | exit 2，无桩标记 |
| T9 | provider 环境变量缺失 | 拒绝 | exit 2，无桩标记 |
| T10 | 任务文件缺失 | 拒绝 | exit 2，无桩标记 |
| T8 | 正常根 + 桩，从外部 cwd 启动 | 桩在隔离项目根运行、退出码落盘 | exit 0，`stub-cwd=<root>/project`，`.exit=0` |
| T16 | 相对 TASKFILE，切 cwd 后 | 仍能读取 | exit 0，stdin=`noop` |
| T17 | 相对 DSH_BIN/ELECTRON_BIN | 切 cwd 后仍能启动 | exit 0，桩被调用 |
| T18 | 输出文件已是软链 | 拒绝且外部目标不变 | exit 2，目标仍为 `ORIGINAL`，无桩标记 |

## 关键修正

1. `run-headless.sh` 对 HOME、DSH_HOME、project、evidence 逐级做“非软链 + 解析后物理路径在根内”校验；不再依赖字面字符串前缀。
2. TAG 仅允许单段 `[A-Za-z0-9._-]`，长度 ≤64；输出文件已存在（含软链）即拒绝，避免重定向逃逸。
3. TASKFILE / DSH_BIN / ELECTRON_BIN 在 `cd` 前解析为绝对路径；`cd` 失败即退出。
4. `setup-isolation.sh` 不再通过复制后的潜在软链执行删除：复制前拒绝输入包/中间 skills 软链；复制后若插件树或依赖树含任何软链则拒绝继续（在做 `rm -r` 之前）；删除前再确认目标是非软链真实目录。
5. 输入包与依赖的软链用例（T19/T20/T21）都验证了外部目标 `KEEP`。

## 未覆盖（不声称已证明）

- 检查与 `mkdir`/`cp`/运行之间的 **TOCTOU 竞态**；硬链接或同 inode 替换；恶意 PATH/HOME 外部环境；NFS/大小写不敏感文件系统；以 root 运行。
- 未在真实 DSH 会话上运行 v3（本轮不启动模型）；因此只证明“拒绝分支与路径校验在夹具上生效”，不证明真实宿主下的全部行为。
- 未证明真实工作区在历史运行中未被写入（见 `isolation-evidence.md`）。
