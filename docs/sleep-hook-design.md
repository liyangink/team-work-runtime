# DSH 插件层 sleep 确认引导 Hook 方案

> 阶段：design（方案设计）· 任务：sleep-hook-design · 状态：待人工批准
>
> 一句话结论：删除 tw-dispatch 派发成功后的立即 concludeTurn 与同回合工具短路硬屏障，改挂一个"sleep 确认引导 Hook"——首次识别到将要 sleep/轮询等待的命令时不执行、返回一张引导卡片并保证它进入模型可见输出，让 Lead 自判（等宿主自动唤醒，还是确需同步等待）；模型在见到引导后的任意更晚 Step 再次执行才真实放行（同 Step 内预排/循环的后续 sleep 继续拦截，不放行；确认与失败不回退；每次新派发后重新引导）。

## 1. 结论与批准范围

**本方案改什么**（全部在 DSH PlatformBinding 绑定层，不触碰 runtime-v3 与 CLI 语义）：

1. 删除 `dsh/tw-dispatch.js` 中三处健康派发后的 `exec.concludeTurn()` 调用与重入短路检查；
2. 下线 `createHandoffBarrier` 硬屏障（同回合 bash/run_code/tw/tw-dispatch 短路机制整体移除）；
3. 新增 `dsh/sleep-confirm.js`：sleep 确认引导 Hook（检测 + 引导递达 + 两态确认状态机：已引导待自判 / 已确认放行）；
4. `dsh/index.js` 钩子装配改为 sleep Hook（tools/execute 引导 + session/event 回合边界清空 + 轻量派发记录供引导文案引用）；
5. 同步更新 tw-dispatch 工具描述文案与 `tests/dsh-dispatch.test.mjs` 对应断言。

**不做什么**：不改波次机 / dispatch-plan / agent-map 的 CLI 语义（判定链照旧兜住重入与在途）；不拦宿主原生等待通道（bash run_in_background、job_output(wait)、schedule、subagent 通知）；不检测 run_code 程序体内的 JS 级等待（timeoutMs 机制兜底）；不新增 npm 依赖与架构 Module。

**取代关系**：本方案取代此前探索的两阶段回合交接方案（首次健康派发只 record 不 concludeTurn、简报 Step 再调用工具时短路收束）。演进点：旧方案的"简报 Step 短路兜底"仍然是一刀切收束（模型一调工具就被 concludeTurn，吞掉同回合多任务派发能力）；本方案用"仅对 sleep 类调用做确认引导、其余工具完全放行"替代该兜底，同时覆盖旧方案未覆盖的"确需同步等待"场景放行路径。

## 2. 问题与现状（机制证据）

三个目标对应三个现状缺陷：

- **目标 ①（派发后能进入下一 Step 输出任务简报）**：现实现中 tw-dispatch 在健康派发后立即 `exec.concludeTurn()`（`dsh/tw-dispatch.js` L556-557、L594-595；重入分支 L317-320 也调用）。宿主侧 concludeTurn 的行为链已核实（`@deepseek-ai/dsh-tools/lib/index.js` L3251-3253 → L3659 → `@deepseek-ai/dsh-agent-loop/lib/index.js` L573 → L1167 → L1007）：工具结果物化带 `concludesTurn: true`，step 收尾聚合后 step() 返回 `{kind:"completed"}`，turn 循环 break——**整个回合结束，模型在工具结果返回后没有任何再输出机会**，派发简报被吞。
- **目标 ②（同一 Lead 单回合/跨 Step 连续派发多个独立任务）**：`dsh/index.js` 装配的 handoffBarrier 在派发后短路同回合的 bash / run_code / tw / tw-dispatch（`dsh/tw-dispatch.js` aroundExecute + shortCircuitResult，其中 run_code/tw/tw-dispatch 分支还再次 concludeTurn）。这锁死了同回合派发 task-b 的能力——Lead 派完 task-a 想在同回合继续统筹 task-b 时被硬屏障拦住。
- **目标 ③（sleep 等待的首次拦截引导与二次放行）**：现状只有"一刀切"（concludeTurn 或短路返回 `TWR_HANDOFF_NOT_EXECUTED`），不区分"等成员完成（宿主会自动唤醒）"与"确需同步等待（宿主不管理该条件）"两类场景；确需同步等待的合法 sleep 也没有放行通道。

**自动唤醒机制依据**（引导文案判别标准的宿主事实源，均已读源码核实）：回合结束后，若 inbox 有待处理消息（子代理完成通知、后台 job 完成通知、用户新输入），agent-loop 自动重置 step=0 开新回合（`dsh-agent-loop` L1037-1041 wakeDriver 链路）；run_code 内嵌工具调用同样经过 `ctx.waterfall("tools/execute")`（`dsh-tools` L1431-1433 → L3427），嵌套调用的 `concludesTurn` 会向外层传导（L1459）。

## 3. 方案设计：sleep 确认引导 Hook

### 3.1 组件与装配

`dsh/sleep-confirm.js` 导出 `createSleepConfirmGuard()`（纯函数状态机，无宿主依赖，可独立单测）：

- **aroundExecute(exec, next)**：挂 `ctx.on("tools/execute", ...)`（与现 handoffBarrier 同一挂点，替换关系）。
- **noteDispatch(exec, card)**：轻量记录最近一次派发（task、时间、回合键）供引导文案引用，**同时递增该 agent 的派发世代（dispatchEpoch）使旧确认状态作废**（见 §3.4 场景②）——不做任何短路，替代原 handoffBarrier.record 的记录职责、删除其短路职责。触发条件是**新工作交付**：初派创建、在途恢复补派、冷唤醒投递、断链重建、fresh 重建（按 dispatched/inflight 条目的 refollowed / recovered / freshRebuilt 标志或"新建且无 reused 标志"判定）；纯重入等待（判定链命中 reused、无新投递）不触发——查状态不是新派发，不得因重置造成过度拦截。
- **派发世代还覆盖异步原生委派**：guard 在 tools/execute waterfall 上顺带观察宿主原生 `subagent` / `subagent_fork` 调用（guard 挂点即全工具执行通道，已核实 dsh-tools L3427），调用成功返回（结果非错误）时同样递增该 agent 的 dispatchEpoch——原生委派也是"新的等待起点"，其后的 sleep 不得蹭旧状态。观察动作透传原结果，不影响委派本身；`send_message`（续聊催单）不是新派发，不递增。工具名以宿主注册名为准（实施时核对）。
- **clearTurn(sessionId)**：挂 `ctx.on("session/event", ...)`，在 `turn/start`、`turn/end` 时清空该会话的确认状态（新回合重新引导一次）；step 边界**不**清空（同回合跨 Step 已确认持续有效，这是目标②跨 Step 连续派发所需的语义）。

`dsh/index.js` 装配改动：tools/execute 挂 guard.aroundExecute；agent/pre-step 的 clearAgent 钩子删除（确认状态按回合生命周期管理，不再需要每 Step 清理）；session/event 只保留 turn/start、turn/end 两类清理（step/start、step/end 清理删除）。

### 3.2 检测规则（初版，实施时可调）

只检测 bash 工具调用（`exec.name === "bash"`，不分顶层还是 run_code 内嵌；run_code 嵌套 bash 的 exec 同样经过 tools/execute waterfall，已核实）。检测对象是 `exec.arguments.command` 文本：

| 规则 | 判定 | 说明 |
| --- | --- | --- |
| R1 纯等待命令 | 首命令为 `sleep` 且时长 ≥ 1s；或首命令为 `watch` / `tail -f` | 命令主体就是等待 |
| R2 轮询循环 | 命令含 `while/until ... do ... done` 结构且循环体内含 `sleep` | 轮询等待 |
| R3 链中长 sleep | `&&`/`;`/`\n` 分段中存在时长 ≥ 3s 的纯 `sleep` 段 | 组合命令里的实质等待 |
| 放行白名单 | `run_in_background: true` 的 bash（宿主后台机制）；sleep 时长 < 1s（脚本去抖用途）；R3 中 sleep 段 < 3s | 宿主原生通道与微小等待不引导 |

不检测 run_code 代码体的 `setTimeout` / Promise 等待（文本匹配脆、宿主 timeoutMs 机制兜底）；不拦 job_output / schedule 工具调用本身。

### 3.3 首次拦截：引导卡片与递达保障（非错误结果，回合继续）

首次命中时**不执行**命令，做两件事：

1. **返回符合 bash 输出契约的结果**（`{isError:false, value:{kind:"foreground", stopped:"TWR_SLEEP_CONFIRM", exitCode:null, stdout:{text:引导文案}, ...}}`，契约字段以 `dsh-tool-bash` 源码为准——实施时对照 L450-489 的 foreground 形状）——顶层调用时该结果即工具结果，模型下一 Step 直接可见；run_code 嵌套调用时该结果是程序内的返回值（stdout 文本可被程序读取并转印）。
2. **调用 `exec.deferContext(...)` 把引导文本作为附加上下文注入**——这是递达的关键保障：run_code 的输出合同是"只有 print/return 的内容构成程序输出"，嵌套 bash 的 stdout 不自动等于模型可见；程序若不转印引导文本，仅靠结果文本不能证明提示递达。deferContext 通路已核实（宿主现有接口，无需新设施）：拦截器在 tools/execute waterfall 层短路返回时，exec 上推入的 deferred context 会并入该次调用结果的 additionalContexts（`dsh-tools` L3427-3435）；run_code 的 commit() 把嵌套结果中的 additionalContexts 逐条 deferContext 到外层 run_code exec（L1453-1458）；外层结果提交时 additionalContexts 经 acceptContext 进入 inbox 的 next-step 消息流（`dsh-agent-loop` L571-572）——下一 Step 模型请求必然包含引导文本。注入消息采用 createUserMessage + source 标记的既有先例形状（对照 dsh-tools 内嵌图片注入 L1454-1456）。

同时在 guard 状态里记 `agent → {turn, guidedStep, epoch}`——注意记的是**已引导待自判**（guided）状态，不是已确认（confirmed）状态；epoch 为当前派发世代（见 §3.4 场景②）。

引导文案（中文，动态拼接）：

```
[TWR_SLEEP_CONFIRM] 本次调用将进入 sleep/轮询等待，命令未执行。请先自判等待是否必要：
1. 若你在等待 tw-dispatch 派出的波次成员、原生 subagent、后台 job 或定时器：宿主会在它们完成时自动唤醒本会话并注入通知，不需要 sleep——正确做法是输出派发简报/结束语后自然结束当前回合。
2. 若你确需同步等待（等待宿主不管理的外部进程或条件，且本回合必须阻塞拿到结果才能继续）：在你看到本提示之后的后续 Step 再次执行该命令即确认放行；更推荐改用 bash run_in_background + job_output(wait:true) 的宿主原生等待通道。
（同一次 run_code 程序预排或循环的后续 sleep、同一 Step 并行发出的其他 sleep 都会继续被拦截；确认放行后本回合内不再重复引导；本回合内再次发起新派发（波次成员或原生 subagent）后，sleep 会重新引导一次；新回合也会重新引导）
```

若 guard 内有近期健康派发记录（noteDispatch 30 分钟内），文案首行追加场景提示："本会话 N 分钟前刚派发了任务 X 的波次，成员完成时宿主会自动唤醒本会话。"——让最常见场景（派发后想 sleep 等成员）的判别信息直接在场。

### 3.4 两态确认状态机与生命周期（含派发世代）

确认状态分两态，核心分界是**模型是否已见到引导、且期间未出现新的等待起点**：

- **guided（已引导、待自判）**：首次拦截写入 `agent → {turn, guidedStep, epoch}`。此后同 turn、同 epoch 内：
  - **同 Step 的后续 sleep 类调用继续拦截不执行**——包括同一次 run_code 程序预排/循环的后续调用（同 rootCallId，模型尚未收到任何工具结果）与同一 Step 并行组里的其他 sleep 调用（同一模型请求同时发出，同样未见过引导）。继续拦截时返回精简提示（"本回合已引导过；请在看到提示后的后续 Step 再次执行以确认放行"），同样走 deferContext 递达。
  - **更晚 Step（step > guidedStep，不要求紧邻）的 sleep 类调用视为"再次执行"**——Lead 中间可以跨任意多个 Step 去做别的事（重读 skill、查文件、其他工具调用）或经历脚本失败后的修复重试，只要仍在同一 turn、同一 epoch 且 step 晚于引导 Step，模型发起该调用时已见过引导（自判完成）——无论顶层直接调用还是新一次 run_code 的嵌套调用。此时转入 confirmed 并放行本次调用。
- **confirmed（已确认放行）**：同 turn、同 epoch 内后续 sleep 类调用直接 `next()` 真实执行。确认键仍是**回合级一次性**（不是命令文本指纹）：确认后命令可改写（sleep 30 → sleep 60 不再拦截，避免改写循环）；每次新回合重新引导一次。
- **状态单向性（不回退）**：guided 只能转为 confirmed 或被清空/重置，confirmed 不因放行后的命令执行失败（exitCode 非零）、失败后的重试或其他工作的成败而回退——状态机不做逆向转换。
- **派发世代重置（场景②）**：每次**新派发**发生时递增该 agent 的 dispatchEpoch——新工作交付的 noteDispatch（初派创建、补派、冷唤醒投递、断链重建、fresh 重建；纯重入 reused 不算）与原生 `subagent` / `subagent_fork` 成功委派。sleep 判定时若状态记录的 epoch ≠ 当前 epoch，旧 guided/confirmed 一律作废、按无状态处理：新派发后的 sleep 重新触发首次拦截引导。理由：新派发意味着新的自动唤醒等待起点，旧确认不能代表模型对新等待的自判；纯重入查询不重置，避免过度拦截。
- **清空时机**：session/event 的 turn/start、turn/end 清空该 agent 全部确认状态（guided 与 confirmed 一并清除，新回合从引导重新开始）；step 边界不清空（目标②跨 Step 连续派发所需）。guard 异常（检测抛错、状态损坏）时放行并记日志（fail-open：引导是防呆增强，不是门禁，不能因自身故障阻塞工具执行）。
- **状态容器**：WeakMap<agent 对象, {turn, guidedStep?, confirmed?, epoch}>（epoch 单调递增计数，也存于该对象）；agent 消亡自动回收；Step 键从 `exec.agent.phase` 读数值 {turn, step}（running 时可读，`currentAgentStepKey` 已示范读法；嵌套 bash 与顶层调用共享同一 agent 的 phase）；phase 读不到时保守视为同 Step（继续拦截，防误放行方向），由 turn 边界清理兜底。

### 3.5 移除清单（对照现有源码）

| 现有代码 | 处置 |
| --- | --- |
| `tw-dispatch.js` L556-557、L594-595（两处健康派发 concludeTurn） | 删除；L556/L594 的 handoffBarrier.record 改调 guard.noteDispatch |
| `tw-dispatch.js` L317-320（重入 existingHandoff 检查 + concludeTurn） | 删除。重入安全由波次机判定链兜底（同任务重入 → dispatch-plan 返回 wait-inflight，registered=true → reused → 恒等待不重投，已实现）；跨任务（task-b）派发不受任何影响 |
| `tw-dispatch.js` createHandoffBarrier（record/match/shortCircuitResult/aroundExecute/clearAgent/clearSession/clearRoot） | 整体删除，导出面由 createSleepConfirmGuard 替代 |
| `tw-dispatch.js` shortCircuitResult 中 run_code/tw/tw-dispatch 分支的 concludeTurn | 随 handoffBarrier 删除 |
| `index.js` agent/pre-step clearAgent 钩子 | 删除 |
| `index.js` session/event 的 step/start、step/end 清理 | 删除（只留 turn 边界清理） |

**为什么删重入检查是安全的**：tw-dispatch `isConcurrencySafe=false` 使宿主同 Step 并行组串行执行；第二个同任务调用正常走判定链（已登记 → reused 等待 / 崩溃窗口 → 自动补派），设计上"同 key 重试经判定链收敛，不会双发"是既有机能；旧 existingHandoff 检查只是判定链之上的捷径，删除后多一次子进程往返，换来 task-b 的正常派发能力。

### 3.6 文案同步（工具描述与系统提示同源）

- `twDispatchToolDescription()` 第二段（`dsh/tw-dispatch.js` L53）："自动收束当前回合等待宿主通知，请勿轮询或调用 sleep" → 改为"输出派发简报后自然结束回合即可，宿主会在成员完成时自动唤醒本会话；确需同步等待时，sleep 类命令首次会被确认引导，在你看到引导后的后续 Step 再次执行即确认放行（更推荐 bash run_in_background + job_output 等原生等待通道）"。
- 输出 schema 中 `nextAction="wait-children"` 的 description（L74）同步改述（"本回合自动收束" → "可输出简报后结束回合等待通知"）。
- `tw-dispatch.js` L458 fresh 创建成功路径的回执 message："已创建成员会话（…）并投递派单，等待成员完成通知；当前回合已交接，请勿轮询或调用 sleep" → 改述为"已创建成员会话（…）并投递派单；输出派发简报后自然结束回合即可，等待成员完成通知（宿主会自动唤醒本会话）；请勿轮询或调用 sleep，确需同步等待时 sleep 类命令首次会被确认引导"。原句在新语义下是假陈述（回合不再收束交接），会误导模型认为已无输出职责而直接停笔，削弱目标①的简报引导闭环。
- `decisionTableText()` 不涉及等待语义，不改。
- 文案面已全面核验无其他遗漏：全文件含"回合"的模型可见文案共 L53、L74、L458 三处存活路径（均在本节改述清单内）加 L112 内部注释与 L196/L211 短路文案两处删除路径（§3.5 移除清单覆盖）。

## 4. 三个目标的行为链（验收口径）

1. **目标①**：tw-dispatch 健康派发返回卡片（nextAction=wait-children，无 concludeTurn）→ 模型下一 Step 收到工具结果 → 输出派发简报（无工具调用）→ step 返回 completed → 回合自然结束 → 成员完成通知入 inbox → wakeDriver 开新回合。
2. **目标②**：Lead Step1 派 task-a（返回卡片，回合继续）→ Step2 派 task-b（无屏障，正常派发）→ Step3 输出两任务统筹简报 → 回合结束；或跨回合（task-a 唤醒后继续派 task-b）。sleep Hook 只在出现 sleep 类调用时介入，完全不拦 tw-dispatch/tw/run_code 等正常工具。
3. **目标③**：Lead 调 `bash sleep 300` → 首次拦截返回引导卡片并经 deferContext 递达（回合继续、模型下一 Step 必然见到）→ 同 Step 内预排/循环/并行的后续 sleep 继续拦截（模型尚未自判）→ Lead 在见到引导后的任意后续 Step（可跨多 Step、夹其他工作或失败重试）自判：等成员 → 不再 sleep（输出简报结束回合，成员完成自动唤醒）；确需等待 → 再次执行该命令（可以是改写后的命令）→ 确认放行真实执行，同回合同派发世代内不再引导；若中途再次发起新派发（新波次交付或原生 subagent 委派），派发世代递增、确认状态作废，其后的 sleep 重新首次拦截引导；新回合重新引导。

## 5. 测试与验收

**单测**（`tests/dsh-dispatch.test.mjs` 更新 + 新增）：

- 翻转 L1119 用例：健康在途（初派/活会话等待/冷唤醒/重建/wait-inflight 全健康）**不再**触发 concludeTurn；静止卡、部分失败、未确认持久化行为不变（本就不错收束）。
- 改写 L1179 用例为 sleep 引导语义：同 run_code 内后置 bash sleep 被首次引导（返回 TWR_SLEEP_CONFIRM 结果、不执行真实 bash body）；更晚 Step 的再次调用确认放行；新 turn 重新引导；非 sleep 的 bash/run_code/tw-dispatch 完全放行（task-b 连续派发回归）。
- 新增（两态状态机与递达回归，Expert 裁决要求的最小覆盖）：
  - **同次 run_code 连续/循环两次 bash sleep**：两次都拦截、真实 bash body 均未执行（预排调用未自判不得放行）；
  - **同 Step 不同根调用**（并行组两条顶层 bash sleep / 两条 run_code 各含 sleep）：全部拦截，仅首个记 guided；
  - **递达断言**：拦截时 exec.deferContext 被调用且消息含引导文本——嵌套 bash 的引导不依赖程序转印（嵌套结果未打印仍进入外层 additionalContexts 通路）；
  - **后续 Step 再调用放行**（step > guidedStep 的顶层调用与新 run_code 嵌套调用各一例；确认后本回合内改写命令的 sleep 亦放行；跨多 Step 且中间夹其他工具调用与一次失败命令后仍放行——不要求紧邻 guidedStep+1；放行后的失败与重试不回退状态）；
  - **派发世代回归（用户追加两场景）**：guided 后中间隔多个 Step 的其他工具调用再确认放行（不因跨 Step 做别的事失效）；确认后命令执行失败（exitCode 非零）与失败重试均不回退 confirmed；guided → 放弃 sleep → 多步后新派发（noteDispatch 新交付 / 原生 subagent 成功委派各一例）→ 又 sleep → 重新首次拦截引导（旧状态作废）；纯重入查询（reused 无新交付的 noteDispatch 不触发，或 subagent 错误返回不触发）不重置，已确认状态保持放行；send_message 不递增世代；
  - 检测规则矩阵（R1/R2/R3 命中；<1s sleep、run_in_background、链中短 sleep 放行）；guard 状态异常 fail-open；noteDispatch 后引导文案含派发提示；turn/start、turn/end 清空（guided 与 confirmed 一并清）、step 边界不清空；phase 读不到时保守继续拦截。

**隔离宿主 E2E**（实机验收，须在目标宿主重跑）：

1. 派发 → 同回合下一 Step 出现派发简报 → 回合自然结束；
2. 同回合连续派发两个独立任务（task-a、task-b）均成功；
3. 派发后 Lead 试图 `bash sleep 300` → 收到引导卡片（含最近派发提示，且下一 Step 模型请求确实包含引导文本——递达验证）→ 放弃 sleep 结束回合 → 成员完成通知自动唤醒；
4. 确需同步等待路径：sleep 被引导后，Lead 在下一 Step 再次执行（含改写命令变体；含跨多 Step、夹其他工作后确认的变体）→ 确认放行真实执行完成 → Lead 继续后续工作；同 Step 预排/循环变体（run_code 程序内连续两次 sleep）两次均不执行；确认后命令失败与重试不再触发引导。
5. 派发世代重置路径：同回合内 Lead 被引导后放弃 sleep、多步工作后再次派发新波次（或原生 subagent）→ 又发起 sleep → 重新收到首次拦截引导（不蹭旧状态）；重入查询状态（tw-dispatch 重入 reused 等待）后 sleep 不被重置。

**宿主版本说明**：本设计基于当前宿主 checkout（`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.3）源码静态阅读；仓库基线声明仅 0.2.0-rc.2 / 0.2.1-rc.2 完成隔离宿主实测。方案依赖的接口（tools/execute waterfall、session/event、exec.concludeTurn、bash 前台输出契约）在 rc.3 源码中已逐一核实存在且形状一致，但**动态行为未经实测**，实施验收时须在当前宿主完整回归上述 E2E。

## 6. 风险与备选

| 风险 | 评估与缓解 |
| --- | --- |
| 模型不理会引导卡片继续非 sleep 空转 | 系统提示与工具描述已指引"输出简报后结束回合"；非 sleep 工具调用本是合法自由度（多任务统筹），卡片语义引导收敛；非阻塞风险 |
| 误伤正常脚本内 sleep | 阈值白名单（<1s / 链中 <3s / 后台不拦）+ 首次拦截是非错误结果，一次往返可恢复 |
| 拦截面选择过宽（全局 vs 仅派发后） | 见 §7 决策点 1；全局覆盖 job/subagent/定时器等一切回调唤醒场景，判别标准通用 |
| 回合级确认被"确认一次后滥用" | 确认一次后放行本回合后续 sleep，新回合重新引导；滥用上限 = 每回合一次引导往返，可接受 |
| guard fail-open 被视为防线缺失 | sleep 引导定位是防呆增强，宿主系统提示与 awaiting-user 静止规则仍是行为层第一道防线 |
| 递达通路依赖（deferContext → additionalContexts → inbox next-step）| 三层链路均有宿主源码依据（dsh-tools L3427-3435、L1453-1458、dsh-agent-loop L571-572），无新宿主设施；E2E 场景 3 含递达验证；若实测发现通路断点，按既有分歧路径报告证据升级，不自行扩范围 |
| 模型反复在新 Step 之间往返（引导→不执行→又换方式等待）| 每回合（每派发世代）最多一次引导往返；行为层由系统提示与工具描述收敛；非 sleep 的等待方式（run_in_background 等）本就是推荐通道 |
| 新派发后确需的同步等待要多一次引导往返 | 派发世代重置是用户指定的语义（新等待起点必须重新自判），成本上限为每次新派发一次引导往返；纯重入查询不重置以避免过度拦截 |
| rc.3 与已实测 rc.2 的接口差异 | 见 §5 宿主版本说明；E2E 回归覆盖 |

**备选方案（不推荐，保留记录）**：

- 备选 1：维持两阶段交接方案（首派不收束 + 简报 Step 工具调用短路收束）——被本方案取代：其短路兜底仍是一刀切（吞掉同回合多任务派发，目标②不满足），且无"确需同步等待"放行通道（目标③不满足）。
- 备选 2：按命令指纹做二次放行（精确同命令才放行）——不推荐：模型微调命令即陷入引导循环；回合级两态确认（同 Step 拦截、后续 Step 再次执行确认）已满足"首次引导自判、再次执行才放行"语义。
- 备选 3：拦截面仅限"本会话近期派发过"的 agent——不推荐：job/subagent/定时器等回调唤醒场景同样需要引导，全局启用判别标准一致、实现更简单。

## 7. 需要用户确认的决策点

1. **拦截面**：全局（本绑定会话内所有 bash sleep 类调用都引导）【推荐】 vs 仅限近期派发过的会话。影响：普通会话里用户明确要求 sleep 时也会有一次引导往返。
2. **确认语义**：回合级一次性确认 + 派发世代重置——确认时点为"模型见到引导后的任意更晚 Step 再次执行（不要求紧邻）"，确认/失败不回退；每次新派发（新工作交付的 noteDispatch 或原生 subagent/subagent_fork 成功委派）递增世代使旧状态作废【推荐，用户指定方向】 vs 命令指纹级。影响见 §6 备选 2。
3. **阈值**：R1 纯 sleep ≥ 1s、R3 链中 ≥ 3s 才引导（实施时可调参数化）。影响：阈值下的等待不引导。
4. **删除 `createHandoffBarrier` 导出面**（含 `currentAgentStepKey` 等是否保留为 sleep-confirm 内部工具）：导出面收敛会同步更新测试 import，无外部消费者（仅 index.js 与测试引用，已核实）。

## 8. 实施步骤（实现包拆解顺序）

1. 新建 `dsh/sleep-confirm.js`（guard 状态机 + 检测规则 + 引导文案），独立单测；
2. `dsh/tw-dispatch.js`：删除 §3.5 移除清单条目，record 改 noteDispatch，工具描述/schema 文案同步；
3. `dsh/index.js`：钩子装配替换（tools/execute → guard.aroundExecute；session/event → turn 边界清理；删 agent/pre-step）；
4. `tests/dsh-dispatch.test.mjs`：翻转/改写/新增用例（§5）；
5. `docs/file-inventory.json`：新增 `dsh/sleep-confirm.js` 条目；
6. 隔离宿主 E2E 回归（§5 四场景）+ 真实 LLM 会话抽查引导卡片可读性与模型遵从度。

失败与恢复：实施任一步失败时保留原 handoffBarrier 实现可整体回退（git 单提交粒度）；sleep-confirm 与 tw-dispatch 解耦（guard 可独立禁用——index.js 装配处移除挂点即恢复无引导行为，不影响派发主链）。
