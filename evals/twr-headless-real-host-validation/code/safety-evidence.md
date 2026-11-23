# 安全前置原始结果（脱敏转录）

## S0-1：历史无 Web CLI 入口原样执行

命令：从仓库根执行 /bin/bash evals/glm53-latest-eval/code/run-headless.sh，不带参数。该历史脚本只提示并退出；未启动 CLI 宿主或读取凭据。

stderr（原文）：

> run-headless: DISABLED: 真实模型演练入口已禁用——本机外层沙箱不能证明真实仓库、已有文件/子目录与用户数据受保护；历史轨迹仅为受限观察，不再启动新的真实模型会话。

该入口实际退出码：2。

## S0-2：当前外层工具链的真实仓库现有文件写模式打开

执行于当前外层 Bash 的普通 Node 子进程。现有目标为仓库内 package.json；只做 O_WRONLY | O_NOFOLLOW 的 open/close，不创建、截断或写字节。

stdout（原文）：

> outer-repo-write-open=ALLOWED; operations=open,close; create=false; truncate=false; write=false
>
> outer-probe-exit=0

工具返回的文件策略：mode=workspace-write，denied=false，enforcement=full。只证明在此执行链没有拒绝该文件的写模式打开，不把它写成实际改过文件，也不外推到没有启动的独立 DSH 宿主。真实仓库写拒绝未获证据，安全前置在此停止。未对真实 HOME 发起写探测；实际 DSH 运行链的隔离项目可写、HOME 写拒绝及后代继承均未执行，不能用历史记录或下方离线结果替代。没有绕过旧入口、扩大权限或尝试其他真实模型。

## S0-3：仅离线子进程正对照

[CLI 回执第 2 行](<cli-evidence.jsonl#L2>)：离线 Node 子进程和孙进程均在虚构项目创建哨兵，孙进程继承合成 HOME，字段 provesHostIsolation=false。该结果不代表实机隔离；脚本没有启动 DSH。
