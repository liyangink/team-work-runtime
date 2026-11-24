# DSH 0.2.2-rc.5 真机复现

从仓库根执行。需要本机 DSH 0.2.2-rc.5 的 Electron 可执行文件和 asar 内 DSH 的绝对 CLI 入口（`lib/bin.js`）、独立 Node 24+、已安装的仓库依赖、`zstd`（只读对账需要）。参数显式传入，不读取或复用当前 profile。模型组会发起真实计费请求；只有无密钥探针通过且本机原生凭据可读时才向该模型提交提示。所有人工选项都仅对合成任务生效。

~~~sh
: "${DSH_ELECTRON:?指定本机 Electron 可执行文件绝对路径}"
: "${DSH_ENTRY:?指定本机 DSH lib/bin.js 绝对路径}"
: "${NODE24:?指定独立 Node 24 绝对路径}"

driver=evals/twr-v34-glm53-e2e/run.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" seam  "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" probe "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" live  "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" retry "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" gap   "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" round "$DSH_ENTRY" "$NODE24"
ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" "$driver" pipe  "$DSH_ENTRY" "$NODE24"
~~~

- `seam`：完整接缝文件，独立 HOME，保留原封 TAP/stderr；只有 10/10、零跳过、零失败才返回零。不要用它的非零退出阻止其他独立样本。其宿主加载路径由显式 CLI 入口向上两级取得。
- `probe`：不发模型，只检查真实宿主、插件、隔离 profile、工具、沙箱模式和精确选模。 `pipe` 再通过两个已注册原生工具观察生产 CLI 进程真实输出的字节边界；最小适配只提供隔离工作目录与取消信号，不替换生产进程、输出或派发工具。
- `live`：执行无信息差、降噪与 Lead 主动协调，真实四角色到首次本阶段验收门后停；`retry`：另起样本检验同一必要请求原样重发；`gap`：停在第一张真实意图卡，绝不代答。
- `round`：独立剧本按默认三轮自主额度执行。驱动进程在每个真实卡停门后用只读 `tw run` 核对，恢复同一个 Lead 会话，并提交带原卡 ID、唯一选项号的合成用户回复；只有 Lead 的原生工具落盘才算决定。未达预期卡、工作区副本漂移或超时会停止并保留证据，不代写任务状态，不自动追加第二次。GLM 的走法可能变化，不能只凭运行器退出码认定测点已覆盖。

记录各模式终端打印的 `/tmp/twr-v34-…` 目录，再离线核对（根目录参数依次对应六个样本）：

~~~sh
"$NODE24" evals/twr-v34-glm53-e2e/verify.mjs \
  "$TMP_LIVE" "$TMP_GAP" "$TMP_RETRY" "$TMP_ROUND" "$TMP_PIPE" "$TMP_SEAM"
~~~

核对器不读取本机正式会话/任务，也不发模型；分项打印实际结果和日志坐标。有缺项或接缝未达原 10 项基线时整体返回非零；不要把“不通过”当作缺失的用例可忽略。原始证据只留各自隔离目录，供同机复核；对应定位和限制见 [范围说明](<../../docs/member-reporting-and-card-ux-e2e-scope.md>)、[实测报告](<../../docs/member-reporting-and-card-ux-e2e-report.md>)。
