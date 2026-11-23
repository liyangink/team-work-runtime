# TWR headless 重构验收结果

**本轮原生写隔离和 GLM-5.3 双包真机验收通过。** 授权复跑在单层 DSH 0.2.2-rc.5 `workspace-write` Seatbelt 下完成九次正式派单和两次真实停门；[原始验收](</private/tmp/twr-headless-e2e-bqvVoG/evidence/verified.json>)与[只读重算](<code/live-auto-completed-audit.json>)均为 `completed=true`。外层独立 Challenger 复审待登记。

## 通过的真机复跑

| 验收点 | 结果 |
|---|---|
| 写隔离 | 独立[探针重算](<code/live-auto-probe-audit.json>)和复跑的[无模型预检](</private/tmp/twr-headless-e2e-bqvVoG/evidence/isolation.status.json>)均通过；仓库及 HOME 拒写，独立项目可写。意图、工作、完成三个 headless 进程也各自在送入提示前通过原生预检。 |
| 角色和派单 | Lead、两个 Owner、Challenger 与 Expert 五个持久会话均以 `zai-coding-cn/glm-5.3@max` 收到真实模型响应；九个正式派单 key 各有一次实收和一份有效报告，复跑的四次交付及五次评审均一次接受。审计对账了两类定点返工、逐轮返工原文、交付清单增删、五次实际写入和十六次实际读取。 |
| 两道人工门 | [意图卡](</private/tmp/twr-headless-e2e-bqvVoG/evidence/intake-card.json>) `intake-a6f152` 和[最终卡](</private/tmp/twr-headless-e2e-bqvVoG/evidence/final-card.json>) `dec-f55f4b` 均实际停在 `awaiting-user`。每次退出回合并核对当前卡后，外部测试驱动才提交绑定该 ID 的短句，分别留档为[意图输入](</private/tmp/twr-headless-e2e-bqvVoG/evidence/human-intake.json>)和[最终输入](</private/tmp/twr-headless-e2e-bqvVoG/evidence/human-final.json>)；不是 Lead 代答或真人逐条点击，最终门在输入前未通过、输入后通过。 |
| 可独立复核 | 复跑进程退出 0；[审计入口](<code/audit.mjs>)从原始证据只读重算退出 0。首次重算发现读取证据中的 `operation: undefined` 与 JSON 落盘省略字段不一致；仅修正[测试证据的表示](<code/verify-files.mjs>)后重算同一份原迹通过，未放宽断言、改写原始记录或再次发模型请求。 |

复跑只在[测试剧本](<code/scenario.md>)补公开评审参数形状，未改产品源码、冻结设计、历史评测或真实 profile。最新源码副本离线 CLI 退出 0，专项 11/11；未重新执行历史完整仓库套件。结果只覆盖合成双包链和取样写隔离，不代表生产人工批准、读取或网络隔离。

## 保留的首测：同步拒绝、同 key 修正与最终门未批准

- **写隔离：** DSH 0.2.2-rc.5 的独立 `probe` 退出 0（[原生探针状态](</private/tmp/twr-headless-e2e-xwN5GL/evidence/isolation.status.json>)、[只读重算](code/live-auto-probe-audit.json)），真实仓库和 HOME 拒写、独立项目可写，未送模型。正式运行的无模型、意图、工作三次原生预检也均通过；未执行最终批准回合的预检。此证据不代表读取或网络隔离。
- **真机轨迹：** 隔离项目的 Lead 和四个成员持久会话都出现 `zai-coding-cn/glm-5.3@max` 的实际请求头及模型响应；两位 Owner 共四次交付，Challenger 三次和 Expert 两次有效评审，各对到九个不同的正式派单 key。单独对账了五次原生写入、十六次本轮读取及其登记指纹。详见[未完成运行旁证](code/live-auto-stopped-audit.json)。
- **两次停门：** [意图卡](</private/tmp/twr-headless-e2e-tHwIXx/evidence/intake-card.json>)是 `intake-184500`，原生停门回执、外部测试输入和 Lead 正式决定依序为 43、54、57；[外部输入记录](</private/tmp/twr-headless-e2e-tHwIXx/evidence/human-intake.json>)明确是 `test-driver`，并非真人逐条批准。第二道 [scoped-final-code-review](</private/tmp/twr-headless-e2e-tHwIXx/evidence/final-card.json>)（`dec-82b314`）也停在 `awaiting-user`，门未通过，没有批准或完成回执。
- **首测未通过原因：** 既有审计要求 Challenger／Expert 的 `review` 调用为 3／2 次，实际为 4／6 次：首次 Challenger 的 finding 字段不符；首次 Expert 试用子命令 `--help`、遗漏 finding、JSON 不合法及 severity 不合法。同 key 修正后报告被接受，没有额外正式收单；这是 P2 的真机观察：工具当场拒绝错误参数并反馈修正方向，模型以原 key 更正，试探帮助命令则没有 key。审计没有把这些未接受的调用忽略，启动器退出 2 并写入[停止记录](</private/tmp/twr-headless-e2e-tHwIXx/evidence/stopped.json>)，`audit.mjs` 重算也明确拒绝。未观察到需要修改产品的证据。
- **测试接缝：** 新增经授权的非交互入口；使用原生凭据解析接口，驱动不落盘凭据，只向内层模型进程注入；保留普通交互入口。语法与专项 11/11 通过，含错卡、冒充人工和提前输入反例；这些只用于核验器自检。该首测不是通过样本。

## 前轮实机：写隔离通过，模型未启动

- **写隔离：** 原生 Bash、原版 `tw` 与 `tw-dispatch` 派生的两个 CLI 及各自的后代中，真实仓库根及子目录已有文件的写式打开、真实仓库和 HOME 的独占创建均返回 `EPERM`，独立临时项目实写成功；原生文件服务的变更前检查也拒绝两处越界路径，项目内实际创建成功。见[探针状态](</private/tmp/twr-headless-e2e-Di1Mjx/evidence/isolation.status.json>)（`passedProbe=true`、`promptReleased=false`）、[原生回执](</private/tmp/twr-headless-e2e-Di1Mjx/evidence/isolation.probe.jsonl>)及[只读重算](<code/live-round-probe-audit.json>)（`isolationVerified=true`、`modelExecuted=false`）。源码与装载副本指纹未变，模型输入数为 0，未产生持久会话。此证据只覆盖取样写入，不代表读取、凭据或网络隔离。
- **测试驱动修正：** [原生接缝](<code/native-guard.mjs>)显式绑定两个入口标签，并给仅用于无模型预检的空会话补齐宿主权限投影需要的字段；[启动器](<code/run.mjs>)在收到原生证明后关闭空 stdin，[核验器](<code/verify.mjs>)只接受宿主的单条缺任务诊断或空输出，并核对无持久会话。原有隔离判据和原生规则未放宽；最终版复跑探针并重算通过，核验专项 **9/9** 通过（新增对额外事件、错误诊断和持久会话的反例）。
- **实机阻塞：** 首次提交真模型启动命令收到 `Auto review rejected tool "bash"; its body was not executed`，工具未返回具体拒绝规则；未启动真模型运行、未读取或注入凭据、未换入口重试，未保留未经实机验证的自动批准或凭据适配。本轮没有可核验的九次正式派单、两次真实停门或 `verified.json completed=true`，外层 Challenger 尚未复核。恢复须由 Lead 确认平台正式允许模型启动的测试会话，再由 Owner 从空项目重跑探针并执行完整双包链路，审计通过后提交独立复核。

## 前序返工与离线记录（保留）

前序返工补齐原生写入口放行要求与成员实读实写的核验；当时的子会话无法挂载内层 Seatbelt，未发送 GLM-5.3 请求。前序源码副本离线 CLI **8/8**、自动套件 **488 项：479 通过、0 失败、9 跳过**，核验专项 **8/8**；以下各节保留原证据层级，不能当作当前实机通过。

## 第二轮返工与自检

| 复核意见 | 已修订与实际验证 | 尚需外部验证 |
|---|---|---|
| Shell 预检不能保护另行派生的原生工具 | [原生 tw](../../dsh/tw-tool.js#L19-L21)和[原生派发](../../dsh/tw-dispatch.js#L147-L150)直接启动 CLI，而[CLI 项目根](../../bin/tw.mjs#L5-L11)可以显式传入：原意见成立。本轮只在[测试启动边界](code/native-guard.mjs)用原生 DSH 生成的未改写 Seatbelt 规则包装同一版本的原版 CLI 进程，以独立 FD 见证两条实际原生工具调用及各后代；原生文件写路径另验同一变更前检查和项目内安全正例，模型调用只放行演练所需工具。离线验证了参数透传、两条原版 CLI 公开回执、拒绝非匹配进程和根覆盖、私有证据通道、仅有 shell 证据不放行。该适配是因为两个原生插件工具绕过 shell，无现成可配置的共同 kernel 进程入口；不改变产品。 | 未实跑修订后的原生 CLI Seatbelt 和文件服务三路正反例。需外部成功取得同次证据，不用程序模拟替代。 |
| 有报告/最终字节仍不能证明参与者实际读写初始和当前版本 | [核验器](code/verify-files.mjs)以接单后、交付/评审前的成功原生回执为证，匹配角色、绝对规范路径、创建/更新、完整一行内容与该轮登记 SHA；预期 5 个写入、16 个读取观察，含初始“待复核”和裁决定点改动，拒绝 Lead 预写、缺关键读取/写入、伪造创建、遗留的旧读件、结果晚于交付或初始状态错误。前序“预置文件但无成员读写也可通过”的合成场景不再成立。 | 轨迹正反例是合成数据加真实离线 CLI 回执，不能证明 GLM 已逐轮按要求读取，也不能证明从真实宿主已解析并重算一份完整日志。 |

[本轮专项 TAP](code/r2-tests.tap.txt)记录 8 项通过；旧的 CLI/TAP 文件保留原证据，第二轮重新执行相同命令也退出 0，未覆盖留档。

## 已观察事实

| 核对点 | 结果 |
|---|---|
| 前置与选模 | 当前正式修复任务经公开状态命令为 completed，Lead 确认最新修复已在工作区；外层公开角色登记的 Owner/Challenger 均为派单指定 GPT-6.2-Sol/max，Expert 不属于本轮执行链。未查外层任务内部账本或私有会话头。内层本轮只有宿主启动配置中可见的 Lead 目标，**没有任何内层真实请求头、子会话或任务角色登记**，不据配置声称模型可调用。 |
| 宿主安全实测 | PATH 旧版（0.1.7-rc.2）帮助入口在尝试打开真实 headless profile 配置写入时被外层 EPERM 拒绝，无写入证据，不再使用。首轮指定 macOS 宿主 0.2.2-rc.5 在独立 HOME/DSH_HOME 装配并使用原生 Bash 预检；真实错误是 `SANDBOX_UNAVAILABLE` → `sandbox-exec: sandbox_apply: Operation not permitted`，**探针命令没有在内层执行、未证内层三路径正反例**。stdin 从未送任务、没有提供测试密钥，没有申请提权。前序外层可打开真实仓库的样本不能补作当前内层证据。 |
| 源码与加载副本 | Git 基线 `adc94e183f3501d26a2cfd4eb40d255506a35f3c` 之上的当前未提交源码，声明版本 1.1.5；81 个包文件逐字节复制，包树 SHA-256 `ebec38d1a11694765b98062586fd7885bccc12a3595abf426d921d745d644587`，三处修复文件指纹见 [CLI 首行](code/offline-cli.jsonl#L1)。独立宿主试跑的装配副本与离线包树同摘要；模型实际加载轨迹尚无。离线源与副本运行前后核对均一致 [CLI](code/offline-cli.jsonl#L234-L236) · [套件](code/offline-suite.tap.txt#L2942-L2952)。 |
| 外部包的可验证程度 | 已验证脚本语法、公开 CLI 实际回执与核验器用原生形状构造的合成正反例。已观察真实 host 启动路径走到原生隔离失败；最终脚本没有在外部终端跑到隔离成功、模型请求、全员收单或真实批准。外部脚本遇缺证据立即停，不用配置值或人造记录补齐。 |

试跑仅修正测试自身：宿主预设显式用 workspace-write/never，避免默认沙箱和审批组合未匹配；CLI 意图补原文，成功 deliver/review 以实际 accepted 回执判定而不是要求不存在的 ok。历史日志多压缩帧改用 `zstd -dc`（Node 单次解码只读到第一个帧）；它用于校准提取器，不计为本轮模型样本。

## 七组覆盖与证据

| 组 | 当前证据与结论 | 仍缺的实机/未执行项 |
|---|---|---|
| ① 派单、恢复与对账 | **CLI** 部分交付时同波等待，重入冻结正文不变、同映射幂等 [回执](code/offline-cli.jsonl#L9-L40)。**宿主替身** 同 key 并发、未知与停写、活冷识别、补投失败不宣称送达 [TAP](code/offline-suite.tap.txt#L426-L570)。 | 续派的一键场景等真实日志；Ghost Wave、F-7 活冷不存在与迟到/回执丢失竞争只保留为风险，不宣称恰好一次。 |
| ② 强类型、定点返工、G-3 | **CLI** 旧 packages 字段拒绝、同 key 修正成功，Expert 缺 verdict 拒绝；两种返工派单正文均核对 SHA、适用原文和不适用意见 [早期对照](code/offline-cli.jsonl#L24-L42) · [最新闭环](code/offline-cli.jsonl#L211-L221)。新闭环中 Expert recommendation=accept + verdict=rework 确实只派甲包，原样带本包 Challenger context，不带乙包。 | 无实际成员请求头、宿主接收同一正文和按意见工作证据；不把派发生成当作收单。 |
| ③ 交付清单、回执及新鲜度 | **CLI** 跨 key 新增索引、移出旧页、主文件保留且不误报新增，旧页磁盘字节不变，下一轮评审不见旧页；在 Expert 新 key 仅改内容时无路径增删 [回执](code/offline-cli.jsonl#L214-L223)。**自动** 同 key/同字节幂等、迟到/并发、旧协议×blocked 与旧多包索引归属 [TAP](code/offline-suite.tap.txt#L2011-L2136)。原始 SHA 与人工门新鲜度仍有离线对照。 | 实机写者时序、读取后竞争和 ABA 未测。验收不新增 G-1 或改动 G-2。 |
| ④ 用户授权刷新与多卡 | **CLI** A/B 刷新与旧人门并存，缺 ID 拒绝；B 先答、旧门收口、A 仍待决、复审重裁和新门 [回执](code/offline-cli.jsonl#L121-L163)；**自动** 待决和变更、故障注入、回执丢失重放 [TAP](code/offline-suite.tap.txt#L1315-L1362)。 | 真用户刷新授权、实机强鉴权及崩溃前后原子替换未测；合成决定是测试输入。 |
| ⑤ 多包拓扑、恢复与依赖 | **CLI** 同计划及异包变化不解除其他阻塞，按各自卡选择单包重试/取消 [回执](code/offline-cli.jsonl#L164-L195)；**自动** 并发计划、依赖解锁、F-10 模型回滚与定点返工 [TAP](code/offline-suite.tap.txt#L1068-L1118) · [定点与串行](code/offline-suite.tap.txt#L2893-L2922)。 | 新实机场景只计划两个互斥独立包，不安排真实重拆、三包汇总或乱序审批。 |
| ⑥ 作废、迁移与规则 | **CLI** 包内回退、用户覆盖和项目规则叠加 [回执](code/offline-cli.jsonl#L196-L198)；**自动** 历史快照和旧增量歧义 [TAP](code/offline-suite.tap.txt#L1327-L1378)，作废、迁移串行和恢复 [TAP](code/offline-suite.tap.txt#L2857-L2922)。 | 真实宿主技能读取、旧写者停写、跨版生产迁移均未实测；不处理缺事件旧报告已知限制。 |
| ⑦ 两包完整闭环 | **CLI** 在同一案实现二包并行、Challenger 和 Expert 定点返工、回执增删、重评重裁，两道人门静止与合成作答后完成 [完整回执](code/offline-cli.jsonl#L200-L234)。外部核验器要求初派同批，两位 Owner 和非作者 Challenger/Expert 合计四个不同子会话，九个派单及其收件和报告匹配，再按 [原生文件读写证据](code/verify-files.mjs)对账各阶段的实际版本并对最终状态重验。 | 真实模型联动、会话冷续、真正的操作者答卡和实际任务完成均未测；不把合成 E2E skip 当成应用 E2E。 |

[冻结设计 §9](../../runtime-v3/twr-framework-architecture-design.md#L207-L240) 的 28 个主题保留[前序逐项矩阵](../twr-headless-real-host-validation/results.md#L28-L61)的证据层级，以上是最新源码复跑和增量。离线套件的九个跳过仍为未指定真实宿主的既有接缝项 [TAP](code/offline-suite.tap.txt#L576-L624)；历史评测框架与整仓静态契约两个文件不在该副本模式，不能写作完整 npm test。此前未跑的规模/保密基准、实际 kill、延迟到达、跨版本真实切换与其他组合缺口未补造结果。

**外部复核路径：** 非作者先独立复跑 [CLI、自动套件和核验器](code/README.md#不调用模型的独立复核)，再由可挂载真实 Seatbelt 的操作者按[运行步骤](code/README.md#外部运行)留存原生探针和实际轨迹；用[只读校验入口](code/audit.mjs)核对所有原生入口的隔离、角色请求头、每轮文件读写/报告回执和两次人工输入。若外部仍无法挂载或不能证实 HOME 与仓库拒写，保留失败，不发模型请求。
