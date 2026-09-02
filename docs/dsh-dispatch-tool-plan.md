# tw-dispatch 工作流派发工具方案

状态：**已实施 + §7 修订待评审**（初版三项经用户确认并实施；2026-09-06 实机事故触发 §7 修订——run 职责归位与死门根治，两轮交叉评审后用户裁决定稿方向，待再评审）。

## 1. 背景与动机

二阶段切链后，team-work 波次成员派发由 Lead 手工串联三步：`tw dispatch-plan` 拿派单与 modelHint → 调 `tw-tool-subagent`（target 直取）创建子代理 → 调 `tw agent-map` 登记 dispatchKey→childId。实机一天的使用暴露了三步手工的真实错误源：

- 选错派发工具（该用自研工具时用了原生 subagent）；
- 模型档位绕路（无标签蹭默认、标签映射错档）；
- 漏登记映射、可写范围漏报；
- 标签格式漂移——标签四段成分里三段（阶段缩写/角色/任务名）是 Runtime 自己拥有的事实，让模型手工拼接违反 P4（簿记不向模型索要），规范只写在 skill 里靠纪律执行。

本方案推翻旧方案 §5「不另造工作流专用的派发模式」的裁决（用户裁决：实机踩坑数据已证明三步手工是真实错误源，防呆价值高于工具面 +1 的成本）。

## 2. 方案结论

DSH PlatformBinding（host 插件）新增 `tw-dispatch` 工具：**单次调用完成一个 team-work 波次的完整派发**——推进到派发点、按 modelHint 创建子代理、登记映射、自动拼接标签。波次机不在派发点时，原样透传卡片（不创建任何子代理），Lead 按卡片行动。

```
tw-dispatch({ task, note?, writables? })
  ├─ 子进程调 tw dispatch-plan --task <名> [--writable …]   → 波次事实（prompt/tier/modelHint/key/waveId）
  ├─ 非派发卡（awaiting-user/wait-inflight/completed/decision…）→ 原样透传，结束
  ├─ 每张派单：插件内函数复用 tw-tool-subagent 创建核心（target 直取 modelHint）
  ├─ 每张派单：子进程调 tw agent-map 登记 dispatchKey→childId
  └─ 返回：[{key, sessionId, provider/model/effort, 标签, 登记结果}] 或透传卡片
```

不新增架构 Module、不新增 npm 包；`tw dispatch-plan` 保持只读编排输入不变；CoreRuntime 不感知本工具（分层不破：组合发生在绑定层）。

## 3. 关键设计

### 3.1 创建逻辑复用而非复制

把 `tw-tool-subagent.js` 的创建核心（验证 → startContinuable → flush 确认）抽为内部函数 `createDirectedSubagent(ctx, deps)`，两个工具共用同一实现与同一 `directSelections` 表（index.js 创建后传入两处）。`tw-tool-subagent` 对外参数面不变（通用委派：tier 或精确模型）；`tw-dispatch` 只走「显式 modelHint」路径，不重选模型。

### 3.2 波次卡片透传（Lead 循环简化为一种调用）

`dispatch-plan` 输出非派发卡时（等待用户决定、在途、完成、路由判定等），`tw-dispatch` 原样返回卡片。Lead 的工作流推进循环由此收敛为：**反复调 `tw-dispatch` 直到终态卡片**，中间不再需要「先 run 看卡再决定怎么派」的双工具交替。

### 3.3 标签由机制生成（P4 回归）

标签 `阶段缩写·角色[@包] · 简述 #任务名` 中，阶段缩写、角色、包、任务名四项全部来自 dispatch-plan 输出的派单事实，由工具自动拼接；唯一语义成分「简述」来自可选参数 `note`，缺省自动生成（任务名+角色+轮次）。skill 中的标签规范从「纪律」降为「说明」（描述工具行为，不再要求 Lead 手工拼）。

### 3.4 参数面（只收语义）

```js
tw-dispatch({
  task: string,                 // 任务名
  note?: string,                // 简述（标签展示；缺省自动生成）
  writables?: [{path, kind}],   // 可写范围，透传 dispatch-plan
})
```

派单 key、modelHint、sessionId、waveId 一律内部推导，不向模型索要。

### 3.5 多包波次

dispatch-plan 输出多张派单时逐张创建+登记（工具声明并发安全），返回数组；单张失败不回滚已成功项，逐项报错并给补登记指引。

### 3.6 失败语义

| 阶段 | 失败 | 结果 |
| --- | --- | --- |
| dispatch-plan | 推进失败/参数拒绝 | 原样返回错误卡（含 fix 指引） |
| 创建 | 验证失败/服务缺失/启动未确认 | 该项错误卡；已创建子会话按既有回收语义处理 |
| 登记 | agent-map 拒绝 | 返回部分成功：创建结果 + 登记失败指引（可用 tw agent-map 补登记） |

### 3.7 三工具分工（工具说明与 systemPrompt 同源更新）

| 情境 | 工具 |
| --- | --- |
| 正在推进 team-work 任务（派波次成员/推进一步） | `tw-dispatch` |
| 非工作流委派：只读子派单、用户 @档位、并行调查等 | `tw-tool-subagent` |
| 任务簿记：决定、门禁查询、交付、评审、补登记 | `tw` |

情境判据是「有无进行中的任务波次」，不依赖模型记忆。`tw-tool-subagent` 的工具说明与 systemPrompt 决策表同步加入 `tw-dispatch` 行。

### 3.8 skill 更新

`dsh-orchestration.md` 派发规程简化：波次推进一律先调 `tw-dispatch`（它处理一切卡片形态，包括非派发卡的透传）；续派仍为 `send_message`（续聊不是创建，不归本工具）；标签规范节改为「由工具自动生成」的说明。

## 4. 不做的事

- 不在 `tw-tool-subagent` 里加工作流参数（参数歧义比工具歧义隐蔽，且污染通用工具的编排中性）；
- 不改 `dispatch-plan` / `agent-map` 的 CLI 语义（它们仍是权威事实接口，本工具是绑定层组合）；
- 不做派发循环自动化（何时推进仍由 Lead 按卡片决定，波次机语义不变）；
- **不从 CLI 删除 `dispatch-plan`，但其对 Lead 的直接使用随本工具上线而终止**：skill 规程、工具分工表、systemPrompt 决策表不再指向它；它降级为本工具的内部依赖（子进程调用）、跨绑定共享的编排接口（其他平台绑定的派发工具消费同一 CLI 面）与无宿主环境的调试通道。后续优化项：把 `cli.mjs` 的波次推进逻辑抽为可导入函数后，本工具改为插件内直接 import，消除子进程开销。

## 5. 实施与验收

文件：`dsh/tw-dispatch.js`（新）、`dsh/tw-tool-subagent.js`（抽核心，行为不变）、`dsh/index.js`（注册与共享表）、`skills/team-work-v3/references/dsh-orchestration.md`、测试 `tests/dsh-dispatch.test.mjs`（卡片透传/三步集成/标签拼接/多包/失败矩阵/分工文案同源）、`docs/file-inventory.json`。

自动测试：三步集成成功路径、非派发卡透传（含 awaiting-user/wait-inflight/completed）、标签拼接（含缺省 note）、多包逐项、登记失败的补登记指引、创建失败的回收语义、三工具分工文案与 systemPrompt 同源。

实机验收：一个真实任务全链路，Lead 侧只使用 `tw-dispatch`（推进+派发）、`send_message`（续派）与 `tw decide`（人工门应答）三类调用走完 open→派发→交付→评审→门禁→归档。

## 6. 需要用户确认

1. 推翻旧方案 §5「不另造工作流专用派发模式」裁决（本方案 §1 依据）。
2. 三工具分工表（§3.7）与 Lead 循环简化为「反复 tw-dispatch」的使用形态。

## 7. 修订 v2：run 职责归位与死门根治（2026-09-06 事故 + 两轮交叉评审）

### 7.1 事故与评审链

实机事故：某会话先调 `tw run`（派单落盘、波次进入在途）再调 `tw-dispatch`（领到 wait-inflight 卡，按初版设计透传不创建）——派单从未被执行，无子代理、无登记，流程死锁。违反无死门原则（任何状态必须留恢复边）。

第一版补丁（tw-dispatch 直读 agents.json 判「无登记即未执行」）经两视角交叉评审否决，三个实质缺陷：①续派波走 send_message 不写 mappings（设计事实），「无登记≠未执行」会在全部续派在途波上必现误判 fresh 补派，且续派派单为增量语义、新会话不可执行；②绑定层锁外直读 runtime 账本形成第二语义源（判定输入 journal+mappings 全为 runtime 自有事实，推导责任应在 runtime 并投影进卡片——P4 的准确读法）；③wait-inflight 卡 inflight 条目无 modelHint（journal 已落盘、dispatchCard 重建时丢弃），补派无 target 数据，且 skill「target 取 modelHint」指引自始为空指引。

用户终裁（设计层根因）：`tw run` 越俎代庖——状态机写操作（开单落盘）本应唯一归属 dispatch 侧；run 在无派发工具的年代兼任推进者是历史合理，工具就位后职责未收缩，制造了「已开单无人干」中间态。修订为两层：

### 7.2 第一层（源头）：run 撤推进，单一写者

- `tw run` 改为**只读**：返回当前状态卡 + 下一步指引（「调 tw-dispatch 推进」/awaiting-user 时呈现选项等），**不再开单落盘**；
- AGENTS 规则 6 同步修订：推进职责归属 dispatch 侧（dispatch-plan 为机器接口、tw-dispatch 为 DSH 工具；run 退化为状态查询与向导）；
- 终端（无 DSH 插件）推进通道：`dispatch-plan` 顶上（本就是推进者），补人读输出模式；
- 效果：「已开单无人干」的常态制造源消失——dispatch 开单→创建→登记为一口气的原子序列（同任务锁域内推进+登记的编排在工具内串行完成）。

### 7.3 第二层（兜底）：dispatch 自身崩溃窗口的恢复

tw-dispatch 自身存在不原子窗口（开单后、创建/登记完成前进程崩溃或超时；登记写文件失败），重启/重试后再调仍遇「已开单未创建」。兜底层：

1. **runtime 一处锁内改动**：dispatch-plan 生成 wait-inflight 卡时给每个 inflight 条目补三字段——`modelHint`（journal dispatched 快照回填）、`expectedAgentId`（仅续派：prevKeyOf 回溯老 key 查 mappings）、`registered`（锁内查 mappings 该 key 有无对应代理）；
2. **tw-dispatch 三分支**：registered=true → 透传等待；续派（有 expectedAgentId）→ send_message 指引不创建（回溯不到则创建路径，target 用回填 modelHint）；registered=false 且非续派 → 自动补派（创建+登记，结果标注「补派：此前已落盘无执行登记」）；registered 字段缺失（agents.json 缺失/损坏降级）→ 透传+修复指引不补派；多张单子逐张独立判定；
3. **并发保守**：tw-dispatch `isConcurrencySafe` 改 false（同任务连点排队，首调用完成登记后次调用见 registered=true）；
4. **登记失败回执**：补派创建成功但登记失败（写 agents.json 失败）时，回执带子代理 ID +「先 agent-map 补登记再继续，勿重复创建」；
5. **判定权边界**：事实判定（未执行）归工具；「该波要不要」的语义决定归 `tw retire`——补派结果卡附「若本波不应执行，立即 tw retire --wave 回收」。

### 7.4 影响面

runtime-v3/cli.mjs（cmdRun 只读化、inflight 导出增强、dispatch-plan 人读模式）、dsh/tw-dispatch.js（三分支/并发声明/回执）、AGENTS.md 规则 6、skills/team-work-v3/references/dsh-orchestration.md（wait-inflight 处置节）、tests（run 只读无副作用、终端 dispatch-plan 人读推进、兜底矩阵：崩溃后补派/已登记透传/续派指引/降级透传/登记失败回执/retire 不补派）、docs/file-inventory.json、roadmap。

### 7.5 二轮评审吸收（C/D 两视角，方向均确认无架构否决，9 条必改并入实施范围）

1. run 只读化影响面补全：`skills/team-work-v3/SKILL.md`（Lead 推进循环整体建于 run——不改则终端死路）与 `references/topology-and-cost.md`；blocked 恢复五处文案改指 dispatch 侧（cli.mjs:626/1076/1263、waves.mjs:360、SKILL.md:24/39）；`ensureE2ePackages` 写副作用从 run 路径移除（dispatch-plan:1128 已有等价）；
2. 指纹失效死循环封堵：只读 run 用 humanDecisionFresh 检测失效待决卡 → 返回「调 tw-dispatch / tw dispatch-plan 重签」指引；DECISION_STALE 两处 fix 文案同步改向；
3. awaiting-user 表述收窄：只读 run 仅呈现已签发待决卡（首签归 dispatch）；归档卡/completed 幂等/wait-inflight 重建卡等天然只读行为保留；
4. 规则 6 修订文案（双模式）：「推进是 dispatch 侧的单一写者：开单、决定卡签发、阶段流转与完成都在任务锁内由 dispatch 通道完成——dispatch-plan 是编排机器接口兼无插件终端的推进通道（人读输出），DSH 内由 tw-dispatch 调用；卡片即呈现单位。run 只读：返回当前状态卡与下一步指引，不写任务事实。awaiting-user 静止；completed 重复调用幂等返回同一完成卡片」；run/gate/dispatch-plan 三分工（查状态/查门/推进）补入方案表述；
5. dispatch-plan 人读模式范围 = waves + 全部 stop 卡（awaiting-user/wait-inflight/completed/blocked）；存量约 10 个测试文件 120+ 处 run 推进用例与共享夹具 v3-fixtures 批量迁移（夹具先行）；
6. 补派防双发：补派卡附 dispatchKey 与核对指引（先核对侧栏同波成员，存在则 agent-map 补登记）；补「创建后登记前崩溃→重试不双发」测试；
7. modelHint 回填失败降级链：老 journal 无快照 → 按重建 tier 从当前全局 tiers 解析 → 仍不可解析报错并指 tw retire --wave；
8. 三分支优先级声明：registered 缺失→降级透传；registered=true→透传（优先于续派）；续派→send_message 指引；其余→补派；
9. 建议级 16 条随实施顺手（人读模式登记提醒、发布说明补重启会话、并发串行吞吐声明、run 冗余派发代码删除、§7 粘贴残留清理等）。

### 7.6 遗留观察项

- 登记失败残留（创建了但未登记、回执指引被无视）：回执指引+并发保守兜底，实机出现后再评估锁内占位原语（agent-map --claim）；
- 旧会话装载的旧版 skill 不随宿主刷新：本次修订后 skill 的 wait-inflight 处置已自动化，旧会话按旧规程操作也不会死锁（兜底层接管），仅效率差异。
3. 标签由工具生成、skill 标签规范降为说明（§3.3）。
