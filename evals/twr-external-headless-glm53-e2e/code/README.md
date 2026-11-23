# 外部终端运行说明

**只在允许挂载内层原生 Seatbelt 的 macOS 终端或经授权的测试会话运行无模型探针；只有通过才启动 GLM。** 外层已受 Seatbelt 限制时不能把嵌套失败当作内层证据，也不要改用全权限、跳过预检或重新启用历史禁用入口；通过探针不等于取得真模型启动权限。

## 外部运行

从本仓库根目录执行。需要**已安装的 DSH 0.2.2-rc.5**（不是 PATH 中的任意 `dsh`）、Node 24+、可用的 `zstd` 和仓库现有依赖。脚本不安装任何东西、不创建或覆盖真实 profile；`probe` 和交互 `live` 不读取现有凭据文件。下列应用路径是 macOS 标准安装位置示例；异处安装时把变量设置为已审核的实际位置。

```bash
CODE=evals/twr-external-headless-glm53-e2e/code
DSH_APP='/Applications/DeepSeek Harness.app'
DSH_ELECTRON="$DSH_APP/Contents/MacOS/DeepSeek Harness"
DSH_ENTRY="$DSH_APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 只运行宿主原生拒写/可写探针：不用凭据、不向 headless stdin 送任务。
node "$CODE/run.mjs" probe "$DSH_ELECTRON" "$DSH_ENTRY"
```

此预检同时要求实际原生 Bash、原生 tw 和 tw-dispatch 派生的原版 CLI 及其后代在相同 DSH 规则下拒写真实仓库和 HOME，并能在专属项目写入；同时验证原生文件写入口的路径检查和项目内正例。原生工具的 CLI 在测试启动器中增加单层 Seatbelt 包装，不换工具实现、不改宿主配置、不变更用户现有任务。只开放本次演练所需原生工具的执行，不接受替代 shell 或指定真实项目根。

仅当上一步明确显示预检通过且退出码为 0，再由操作者经认可的凭据工具向**当前交互终端**注入名为 `TWR_E2E_GLM_KEY` 的、授权给本次固定模型提供方的短期测试密钥，不要把值写入脚本、仓库、命令参数、聊天或终端历史。随后执行：

```bash
node "$CODE/run.mjs" live "$DSH_ELECTRON" "$DSH_ENTRY"
unset TWR_E2E_GLM_KEY
```

`live` 在新的独立目录里从头预检，不接受其他运行的通过标记。随后正式 Lead 首次开任务并停在意图确认；核对任务、两个包和实际选模后，按终端提示输入**当前卡完整批准短句**。第二次停在最终人工门，脚本先核验双包链路、各角色真实请求头、逐轮原生读/写的确切版本和人工门未通过，再请操作者核对。输入其他内容、Ctrl-C、会话失败、变更源码/配置、日志不全、模型不一致或预检失败都停止并保留原迹；不改用其他模型、不自动再跑、不代答。大任务阶段时间上限 45 分钟，其余模型阶段每段 5 分钟；这些是终端进程上限，不是已测耗时。只用本轮固定的合成任务测试，不把它当成真实业务模板。

## 经明确授权的非交互演练

仅限已明确批准读取固定凭据引用、并允许外部驱动按卡应答的测试会话，在单独的 `probe` 成功后使用下列入口；一般外部终端仍用上面的交互入口。

```bash
NODE_BIN="$(command -v node)"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$CODE/run.mjs" live-auto "$DSH_ELECTRON" "$DSH_ENTRY" "$NODE_BIN"
```

该入口再从空目录跑一遍原生探针，通过后用宿主的只读解析器从 `~/.dsh/.credentials.yaml` 取固定的 `refs.ZAI_CODING_CN_API_KEY`，不触发凭据迁移。只向内层有模型任务的 headless 进程注入内存环境变量，不改写真实文件、不拷贝凭据、不打印值，也不向原生 CLI 子进程转发；驱动留档中的已知值替换为 `<SECRET>`。工具执行审查、凭据或隔离失败则停止，不换入口规避。

外部驱动在上一个 Lead 回合结束后，先检查原生停门回执及当前只读状态，再从当前决定卡生成批准短句；最终卡还要先审计整条成员链并核对门未通过。两条输入和留档明确标为 `test-driver`；不是 Lead 代答，没有真人逐条点击，也不用于生产任务。只读审计核验先收到停门回执、再收到外部测试输入、再由 Lead 按原卡提交决定。

## 证据与清理

启动器打印专属的 `/tmp` 物理目录。审查者可用以下命令从已有轨迹**只读重算**，不用复跑模型；参数必须是终端实际打印的路径：

```bash
node "$CODE/audit.mjs" '/private/tmp/twr-headless-e2e-<本次实际后缀>'
```

- 探针：`evidence/isolation.probe.jsonl` 和 `isolation.status.json`（实际原生执行、Bash 与两个 CLI 入口各自的进程/后代结果、原生文件写检查、放行状态）；完整模式另有三次同进程等候 stdin 的探针，任何一次不符即挡提示。`build.json`、`recheck.json` 是加载副本的版本和原始字节指纹；有 `stopped.json` 就不把这次运行当作完整通过。
- 完整模式：`evidence/verified.json`、两个 `human-*.json`、公开卡片、headless JSONL，以及专属 HOME 下的持久会话日志。按会话 ID、工具调用/回执 seq 和收单 key 对账，包括起始空项目、原生写件及每次评审实际读取。源记录留本机，先脱敏再分享必要摘录；启动器收集的输出和自身写出的证据会遮盖已知值；不把宿主的原始会话日志视为已脱敏。
- 验收只证明文件写限制的这些取样和本场景行为。`workspace-write` 不是读取、凭据隔离或网络隔离承诺，macOS 还允许部分临时路径；模型步骤只准用合成项目。不要把业务数据、个人配置或长期主密钥带入测试。如要求保护真实 HOME 的读取或秘密环境变量，这套写隔离不满足，停止实机。审核完及相关进程退出后，按打印的**本次目录**由操作者处置证据；脚本不自动删已有目录。

## 不调用模型的独立复核

```bash
node "$CODE/offline.mjs" cli
node "$CODE/offline.mjs" suite
node --test "$CODE/native-guard.test.mjs" "$CODE/verify.test.mjs"
```

用例复用仓库已有离线底座，并只在本交付目录创建、清理本轮合成临时目录。不会改动留档日志或历史评测。持久证据和通过条件见[结果](../results.md)和[范围](../scope.md)。
