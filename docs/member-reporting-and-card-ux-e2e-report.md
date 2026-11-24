# 成员汇报与卡片改造：实机核验报告

**原验收基线未全部满足：DSH 0.2.2-rc.5 接缝全文件实跑为 7 通过、2 失败、0 跳过，文件实际只有 9 项；隔离 headless 的 A–D 测点均取得实证：四角色精确选模、消息引导和恢复、意图首卡分流、人工返工后单次追加、精简呈现及 UTF-8 跨块。**试验不修改产品或既有夹具，不把测试登记或合成答复当正式验收。

## 宿主接缝：全跑两次，未达到 10/10

两次都以 `ELECTRON_RUN_AS_NODE=1` 加 `DSH_TEST_HOST=<DSH_HOST>` 执行 [完整接缝文件](<../tests/dsh-plugin-e2e.test.mjs>)，无需模型凭据；未按名称筛选、未跳过、未修改夹具。实际宿主 DSH 0.2.2-rc.5、Electron 44.7.0、内置 Node v24.21.0，两次退出码均 1。

| 实际用例 | 观察 |
| --- | --- |
| #1、#3–#7、#9 | 7 项通过，包括新增的 #9 原生 PTC 软引导：首发不执行发送、后一步仅一次、一般委派直通。接缝探针不等于真实模型调度。 |
| #2 | [真实 SubagentRuntime 夹具](<../tests/dsh-plugin-e2e.test.mjs#L45-L56>) 在 `ctx.get("subagents")` 后取得 `undefined`，访问 `registerProvider` 报错；在当前版本的旧夹具启动阶段即失败，未走到被测创建断言。 |
| #8 | [真实 ConfigForms 夹具](<../tests/dsh-plugin-e2e.test.mjs#L281-L308>) 以 DSH CLI 包为解析锚，找不到 `@deepseek-ai/dsh-client-store`；未进入浏览器 schema 重建断言。Lead 核对为新版宿主 web 产物位置和旧夹具入口的差异，报告不据此宣称该界面通过。 |

复跑原始输出：[/tmp/twr-v34-seam-DgvE1I/evidence/tap.log](</tmp/twr-v34-seam-DgvE1I/evidence/tap.log>)，版本、输入散列、计数和 TAP SHA-256 在 [seam.json](</tmp/twr-v34-seam-DgvE1I/evidence/seam.json>)；首次 [原始 TAP](</tmp/twr-v34-host.yFhK7O/tap.log>) 同为 7/9。未把全仓其他测试当作第十项，也未尝试绕过上述失败。

## 真机结果

测试于 2026-11-24（UTC+08:00）在 /tmp 隔离环境运行；以下说的“Lead/成员”均为合成项目内实际发起模型请求的会话。HEAD 为 `543be99`；实际加载的是当前未提交改造在内的 77 个包文件副本，不是该提交的纯 Git 快照，也不是本机已安装 TWR。运行时 1.1.5，独立 Node v24.15.0。各主样本包内容逐文件校验相同，合计 SHA-256 为 `bd35cd71f387fae1d230d5909b4cb7bb35fe316eaf312a71d294603597590f4d`；各根目录的 `evidence/build.json` 与 `evidence/inputs.json` 可逐项核对。原生预检确认独立 profile、workspace-write、never、真实工具注册及 Lead 精确选模，bash 未注册。指定凭据只经宿主原生只读解析，未复制凭据文件、在配置中写值或打印密钥。对主要原始证据的凭据值及其 JSON 转义形式进行内存核对（含 11 份压缩会话），两份核对回执均为 0 命中：[三组模型及管道](</tmp/twr-v34-live-ULdB1i/evidence/credential-audit.json>)、[轮次样本](</tmp/twr-v34-round-vCMrSg/evidence/credential-audit.json>)。

四个模型样本共 **11 个会话、27 条宿主请求头、166 条提供方模型响应记录**；请求头全部核对为 `zai-coding-cn/glm-5.3`，`reasoningEffort: max`，响应所报提供方和模型一致。请求头与响应按宿主事件统计，不是 HTTP 调用次数。共 19 个正式成员派单经映射、收单、模型请求及报告回执对账。

| 角色 | 会话数 | 请求头 | 模型响应记录 |
| --- | ---: | ---: | ---: |
| Lead | 4 | 8 | 88 |
| Owner | 3 | 8 | 45 |
| Challenger | 2 | 7 | 21 |
| Expert | 2 | 4 | 12 |

### A：拦住无效播报，必要协调仍通

| 样本 | 成员尝试／软提示未发／宿主接受／实际到达 Lead | 发送旁证 |
| --- | --- | --- |
| 协调主样本 | **2／1／1／1** | 首轮 Owner Step 3 的开工播报未发送，注入提示一次，Lead 无该收信或唤醒；后续不重发开工，也没有发第二个例行检查点。Step 4 的口径阻塞求助被接受并成为 Lead 唯一 `agent-message` 唤醒。Lead 两次发消息均实际到达（主动问询和随后纠偏），Owner 收到纠偏才登记。此根的两个人为输入共触发 2 个用户回合，另有 6 个正常结项唤醒。 |
| 原样重发样本 | **2／1／1／1** | Owner Step 3 的真实阻塞请求先被挡下并收到一次提示，Step 4 用同一收件人、同一正文重发成功；Lead 唯一一次收信，答复实际到达 Owner，后者才交卷。此轮 Lead 当时仍在运行，消息在原回合接纳，未另起消息唤醒回合。 |

对账：主样本 Owner 会话 seq 31–33（首次、回执、提示）、39–40（求助）、45（纠偏到达）、58（登记）；Lead seq 51–52（主动问询）、58–59（实际求助／唤醒）、64–65（纠偏）。原样重发 Owner seq 28–29、36–37、42、55，Lead seq 42；成员交付和角色映射再对照任务日志。唤醒按 `turn/start` 前最近紧邻一批入箱首个来源统计，与该回合里接纳的消息数分开；只计真正 `agent-message` 收信，排除回放原话和结项摘要。以上是样本内抑制及恢复，不是与旧版本配对实测的整体流量或节省比例。

### B：明确无差异直派，有差异才弹固定首卡

- **无信息差：** Lead 的真实 `tw open` 和 `tw-dispatch` 带明确用户方向，任务日志 seq 5 登记 `caller-reported`，seq 6 派首轮 Owner，Lead 会话 seq 42 回执确认收单，全任务意图卡签发数为 0。Owner 的实际回执和交付均核对，不以工具成功或文字预告代替派发。
- **有信息差：** 显式“甲还是乙”的信息差仍签唯一 `intake-56efce`（日志 seq 5，原生回执 seq 30），`version:1/form:full`，七个固定二级栏目、1,314 个 Unicode 字符，含逐字用户原话、三角色模型和实际分工。原生回执、只读状态和已落盘正文逐字相等，该模型回合的回复也含同一 Markdown；未答卡、无成员派发、无呈现规则。此证据不声称验证 GUI 渲染、所有纠偏说法、增量卡或旧会话选模冲突。

### C：人工返工后，按上限只追加下一轮

专用轮次样本实测通过：展示第 4 轮时，自主额度为 **3/3**，第 2 轮的人工返工不计入自主额度。额度卡 `dec-e2831f` 只作答 **1 次**，随后 Owner 实收第 5 轮并登记；未再签第二张额度卡，最后独立完成本阶段人工验收。

| 步骤 | 本样本任务日志与原生证据 |
| --- | --- |
| 先人工返工 | 任务日志 seq 12–13 真实签发验收卡 `dec-684422` 并选择返工；seq 14 实派第 2 轮，因果指回该卡。 |
| 达到自主上限 | Challenger 第 2、3、4 轮读到真实合成缺项并登记返工；末次报告是 seq 25，seq 26 签唯一的 `round-limit`（展示 4、自主 3/3），对应 Lead 会话 seq 192。 |
| 一次批准实际续派 | 当期外部输入回合 Lead seq 203，原生 `decide` seq 206–207；任务日志 seq 27 落盘唯一 `extra-round`。seq 28 实派第 5 轮（Lead 回执 seq 212、Owner 收单 seq 137），seq 29 登记交付（Owner 回执 seq 162）。 |
| 末轮正常结束 | seq 31、33 的 Challenger、Expert 结论均接受；seq 34–36 完成新的独立人工验收及任务完成。末门是验收制品，不是追加第二次。 |

三次决定各使用实际显示的卡 ID 和外部合成答复，经同一 Lead 会话冷恢复，由它调用原生工具落盘，未用脚本直接改任务日志。

### D：精简呈现和真实 UTF-8 管道

- 主样本与轮次样本的 18 条实际派发回执，短提示均为 **78 字符**；4 张真实审核卡正文均为 **245 字符**（含规范链接 408–409），各只有一份审阅短节选，无公共明晰段。所测普通查询、固定首卡与机械额度卡不附提示；正式完成回执只有 **116 字符** 的进展提示。按各卡类型计 Unicode 字符，不把结构化别名算作呈现重复，也不据此推算 token。
- 无模型字节压力样本使用已经装配的原生工具和真实 CLI 子进程；观察而非改写 stdout。 `tw-dispatch` 管道 249,887 字节、4 块，在偏移 65,536（4 字节字符）和 131,072（3 字节字）切开 UTF-8；普通 `tw run` 管道 165,736 字节、3 块，在 65,536 切开 4 字节字符。逐块直接解码会出现替换字符；实际产品两个工具都返回同一个无替换字符的冻结正文，其 SHA-256 为 `153ce2e21f00d2e9c2b9a4ef1dc48227dd8fb335c58e7e337b197ce00428d1e9`，保存了原始字节。只证明实际观察到的 stdout 跨块，不声称实测同样的 stderr 跨块或所有终端字符。

第 2 轮只收紧 [D 的离线核对器](<../evals/twr-v34-glm53-e2e/verify.mjs#L252-L275>)：主样本需有普通状态回执，轮次样本需同时有上限卡和完成回执，否则明确报相应类目未覆盖。完整原始日志仍核得 5 条普通状态、1 张上限卡和 1 条完成回执，复算摘要与首轮逐字相同。只在内存分别移除三类回执，另做三类同缺的反例：旧版四个反例均误报 D 通过，修订版均按缺项拒绝，其他分项不变；未重跑模型或改原始日志。见 [对照脚本](</tmp/twr-v34-review-d.Vl4ifw/replay.mjs>)、[修正前](</tmp/twr-v34-review-d.Vl4ifw/before.json>)、[修正后](</tmp/twr-v34-review-d.Vl4ifw/after.json>)和[完整复算](</tmp/twr-v34-review-d.Vl4ifw/after-complete.json>)。

## 证据及复核

复现命令及只读核对器见 [脚本说明](<../evals/twr-v34-glm53-e2e/README.md>)，验收边界见 [测试范围](<member-reporting-and-card-ux-e2e-scope.md>)。会话坐标是原生 `session.v4.jsonl.zstd` 的 seq，任务坐标是对应隔离 `journal.jsonl` 的 seq；两者不同域。依 `agents.json` 的派单 key 和原生收单消息 ID 关联，压缩日志按全部帧解压。文件、散列和逐项统计见 [机器摘要](</tmp/twr-v34-live-ULdB1i/evidence/verified.json>)。

| /tmp 隔离证据根 | 关键证据 |
| --- | --- |
| [协调主样本](</tmp/twr-v34-live-ULdB1i/>) | `evidence/start.jsonl`、`rework.jsonl`、`first-human.json`；`project/.team-work/tasks/coordination-sample/journal.jsonl` 和真实会话。 |
| [必要消息重发](</tmp/twr-v34-retry-8sI14V/>) | `evidence/retry.jsonl`、`retry-state.json`；`project/.team-work/tasks/urgent-retry-sample/journal.jsonl`。 |
| [有信息差](</tmp/twr-v34-gap-ivYZpt/>) | `evidence/gap.jsonl`、`gap-state.json`；`project/.team-work/tasks/gap-sample/journal.jsonl`。 |
| [轮次上限](</tmp/twr-v34-round-vCMrSg/>) | [首次人门](</tmp/twr-v34-round-vCMrSg/evidence/first-human.json>)、[上限](</tmp/twr-v34-round-vCMrSg/evidence/round-limit.json>)、[原卡答复](</tmp/twr-v34-round-vCMrSg/evidence/input-extra-round.json>)、[完成](</tmp/twr-v34-round-vCMrSg/evidence/completed.json>)、[任务日志](</tmp/twr-v34-round-vCMrSg/project/.team-work/tasks/round-sample/journal.jsonl>)及真实会话。 |
| [UTF-8 管道](</tmp/twr-v34-pipe-o2m9kp/>) | `evidence/probe.native.jsonl` 的进程分块及 `evidence/pipe-probe-0-*.raw.json` 原始 stdout。 |

首个组合试跑实际完成第 1 轮并经同一 Lead 会话冷恢复第 2 轮人工返工；初版驱动曾把本阶段验收门误认成全流程最终门，恢复后 Challenger 又把第 2 轮口径正确当作接受，转到另一张人工验收卡，**该组合不计作额度通过**。新专用用例把分轮核对条件写入用户已明确的约束并设置可读制品缺项；未改产品、未编辑任何试跑日志。首个 gap/大文本试跑也有只读卡字段判据误差，原始证据保留，以上正式结论来自修正后独立实跑。

本报告不代替独立 Challenger 核验。按 Lead 转达的用户决定 `dec-2fc49e`，本轮接收宿主接缝的部分通过记录，不返工既有测试；7/9 不等于原 10/10，核对器仍保留原始计数和原基线未达标的非零退出。
