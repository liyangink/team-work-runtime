# tw-dispatch 工作流派发工具方案

状态：**已实施（含 §7 修订 v2 + §8 修订 v3 + §9 返工终版，任务 run-dispatch-split）**（初版三项经用户确认并实施；2026-09-06 实机事故触发 §7 修订——run 职责归位与死门根治，两轮交叉评审后用户裁决定稿，9 条必改并入实施并完成；§8 为 Expert 裁决 rework——防双发机器保障、升档批准指纹、续派断链恢复、run 零写与损坏账本自愈，问题 6 降级发布提示；2026-09-07 §9 返工终版——Expert 复裁 rework + 两轮交叉审查（docs/dispatch-rework-investigation.md）后用户裁决升档实施：判定链取代 §8.2 三态对账、未决卡静止化、全量 prompt 变体、run 无锁只读、重建三源拼接）。

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

- 登记失败残留（创建了但未登记、回执指引被无视）：回执指引+并发保守兜底，实机出现后再评估锁内占位原语（agent-map --claim）；——§8 修订 v3 后此项由确定性 sessionId + sessions.get 对账机器化封堵，观察项消解；
- 旧会话装载的旧版 skill 不随宿主刷新：本次修订后 skill 的 wait-inflight 处置已自动化，旧会话按旧规程操作也不会死锁（兜底层接管），仅效率差异。

## 8. 修订 v3：防双发机器保障与死门根治（Expert 裁决 rework，用户裁决定稿）

### 8.1 裁决问题与处置

Expert 补位裁决 rework（0.97 信心）指出五项，逐条处置：

| # | 裁决问题 | 处置 |
| --- | --- | --- |
| 1 | 升档卡幽灵复活误授权 | 升档批准绑定包配置指纹（escalationFingerprint，id+tier 排序序列化）：签发、批准落盘、幂等查找三处同源；re-plan 改包集/档位后旧批准与新批次指纹不符 → 重新出卡；签发前未决旧升档卡先作废（decided:superseded）防 decide 答旧卡空转；decide 端同构校验（指纹不符拒绝直答，F6-3 同款）。历史批准记录无指纹字段视为失效（重新出卡是多问一次，误授权是成本事故） |
| 2 | 防双发无机器保障 | 按用户方案重构（§8.2）：确定性 sessionId 先登记后创建 + sessions.get 事实对账三态 |
| 3 | 续派恢复边断裂 | 续派（expectedAgentId 在场）先对账老会话存活：primed → send_message 指引；断链（missing/empty）→ 机器发现并自动 fresh 重建（与 expectedAgentIdMissing 的 resumeNote 同款语义：登记确定性 sessionId + 创建，key 映射回填，增量 prompt 照发），不再让指引指向幽灵会话 |
| 4 | run 隐藏写与锁外覆盖 | store.loadTask 的 artifacts 重建改默认纯内存（repair=false）：run/gate 与全部锁外预读零写；自愈写回仅由锁内写命令显式 repair:true 承载（decide/retire/migrate/dispatch-plan/agent-map/plan；deliver/review 经 intake 锁内路径）——消灭「锁外读-改-写与锁内写者竞态覆盖」；loadTask 对损坏 artifacts.json 不再抛错（降级重建，run/gate 呈现重建视图、写命令固化） |
| 5 | 损坏账本死门 | agents.json 损坏：agent-map（降级透传卡指名的修复入口）自愈重建（registryRebuilt 声明 + 续派走 fresh 路径）；retire 不被账本损坏挡死（兜底工具自愈）；dispatch-plan 降级推进（agentMaps 空 + warnings，expectedAgentIdMissing fresh 即恢复边）；artifacts.json 损坏：deliver/review 锁内自愈重建（freshState），loadTask 不抛（同 #4） |
| 6 | （降级项） | 按用户裁决降级为发布提示：真实 DSH 实机全链路验收（roadmap 如实标注，不描述成已可用）；登记失败回执被无视的重试双发窗口已随 #2 机器化消解 |

### 8.2 问题 2 重构（用户方案）：先登记后创建 + 三态对账【已被 §9 返工终版取代——三态判定与 empty→drain 重建路径废弃，本节仅存历史】

**确定性 sessionId**：deterministicSessionId(task, dispatchKey) = sha256(task + NUL + key) 组装 UUID v4 形态（version/variant 位规范置位，宿主视角与随机 UUID 无差别）。同一派单 key 的任意次重试推导出同一 id。

**派发序列反转**：每张派单「创建 → 登记」改为「登记 → 创建」（三处派发路径共用 registerThenCreate 序列：正常波 / 续派断链重建 / wait-inflight 补派）：

1. tw agent-map --key <k> --agent <确定性id>（先登记）。登记失败时**尚未创建任何子代理**——原样重试安全（旧序的登记失败留下在跑会话 + 双发窗口）；
2. createDirectedSubagent(..., sessionId)：创建核心内对账宿主会话存储（sessions.get）：
   - **missing（未创建）**→ 同 id 正常创建（验证 → startContinuable → flush 确认全链不变）；
   - **primed（已收单：会话在场且事件形态非空/不可判定）**→ 返回 reused 卡，不创建（等待成员交付）；
   - **empty（空收件箱：壳已建、首请求未入队）**→ 回收旧壳（drainContinuableChildren）后同 id 重建，返回带 reactivated 标记。

任何崩溃时点重入都收敛到同一会话：登记前崩溃 → registered=false → 补派路径同 id 收敛；登记后创建前崩溃 → registered=true + mappedAgentId 对账 missing → 同 id 补建；创建后崩溃 → 对账 primed → 等待。防双发从「指引 + 并发排队」升级为「确定性推导 + 事实对账」的机器保障。

**wait-inflight 三分支升级为四判定**（runtime 在 inflight 条目新增投影 mappedAgentId——登记的 childId 值，P4）：

1. registered 缺失（账本损坏降级）→ 透传，恢复边 = tw agent-map 补登记（账本损坏自动重建）；
2. registered=true → 对账 mappedAgentId：primed → 等待；missing → 同 id 补建；empty → 回收激活（不再盲信「已登记=在跑」——登记与创建之间的窗口正是双发根源）；
3. 续派 → 会话存活对账：primed → send_message 指引；断链 → fresh 重建；
4. 其余 → 登记确定性 sessionId + 补派。

**保守方向钉死**：inboxState 对 events 形态不可判定的会话按 primed（已收单）处理——误判 primed 的代价是等待（人工 send_message/retire 可恢复），误判 empty 的代价是重投 prompt 双发；宁可停滞不双发。宿主 sessions 服务缺失/抛错同样保守 primed。

**prompt 缺失防御**（Challenger r2 提出，r3 补全覆盖）：派单 prompt 缺失时拒绝登记与创建（TW_DISPATCH_PROMPT_MISSING，零副作用），不再静默置空串传给创建核心；覆盖全部创建路径——registerThenCreate（正常波/续派断链重建/wait-inflight 补派）与 wait-inflight 分支 2 的 registered=true 补建/激活（该分支登记事实已存在，拒绝时保持原样零写、不重复登记，拒绝卡指 tw retire）。

### 8.3 影响面

runtime-v3/store.mjs（loadTask repair 选项 + 损坏降级、rebuildArtifacts 导出）、runtime-v3/intake.mjs（freshState 损坏自愈）、runtime-v3/cli.mjs（锁内 repair 调用点、升档指纹、agent-map/retire/dispatch-plan 账本自愈降级、inflight 投影 mappedAgentId）、dsh/tw-dispatch.js（deterministicSessionId、registerThenCreate、四判定、续派对账）、dsh/tw-tool-subagent.js（inboxState、sessionId 复用对账、reactivated）；测试（dsh-dispatch 顺序/语义反转、subagent 复用对账、invariants 零写/自愈、topology 升档指纹）；skill dsh-orchestration 同步；roadmap 发布提示。

### 8.4 验收【三态对账相关条目已被 §9 取代】

- 确定性 sessionId：同 key 重试推导同一 id（UUID v4 形态校验）；
- ~~三态对账矩阵：missing 创建 / primed reused 不创建 / empty 回收重建 + 回收失败拒绝~~（→ §9 判定链矩阵）；
- 派发顺序：agent-map 先于创建（多包逐张「登记→创建」）；
- 登记失败 → 零子会话残留、重试安全；创建失败 → 映射在场 + 确定性回执 + 重试幂等；
- ~~兜底矩阵：registered=true 配 primed/missing/empty、续派配在场/断链、registered=false 补派~~（→ §9）、prompt 缺失零副作用；
- 升档指纹：同配置幂等不出卡 / re-plan 改档重新出卡 / decide 端外部改动拒绝直答（指纹公式 §9 扩字段）；
- 零写与自愈：run/gate 对损坏账本字节级不动 / dispatch 推进自愈写回 / deliver-agent-map-retire 自愈 / dispatch-plan 账本损坏降级推进。

## 9. 返工终版：判定链、未决卡静止化、全量变体、无锁只读与重建等价（2026-09-07，Expert 复裁 + 两轮交叉审查后用户裁决定稿；轮次 6 用户终裁②③判定链四态化 + 终裁①快照容错）

依据：docs/dispatch-rework-investigation.md（终版方案，两轮交叉审查 10 必改全吸收；轮次 6 用户终裁三条修订判定链为四态）。宿主源码语义以其 §一 为准（全部源码实证）；fake 宿主契约固化为其 §三 5 条（宿主升级需复核）。

### 9.1 A 防双发判定链·四态（取代 §8.2 三态对账；轮次 6 用户终裁②③从五态简化）

判定原语与宿主判重标准一致（startContinuable：活注册表+活会话，显式 childId 才加查持久快照）：

```
登记本取确定性 sessionId
├─ sessions.get 有（活）→ 归属检查（header.parentSession）：
│    异主 → 接管冲突卡（不等待/不投递/不重建——同 id 重建判重与冷唤醒鉴权必被宿主拒绝）
│    归属一致 → 等待（活 = 任务进行中：正在处理本轮，或等子代——子代停止时宿主注入父级通知、
│        逐级传导触发 Lead，通知链保证不僵死；重入判活→等待、永不重投——防成员重复执行整轮工作；
│        是什么任务/是否当前轮，等通知到达再判断，届时冷了走冷唤醒投正文。
│        不读事件流：「活+未收单」形态经宿主 submitMaterialized 失败即完全回滚不存在——终裁③）
└─ sessions.get 无 → sessionPersistence.listSnapshots 匹配 id：
     异主 → 接管冲突卡（指 tw retire 或由原会话继续；不做 followup/重建——两路必被双拒）
     归属一致 → 冷唤醒 + 缺什么补什么（冷会话不在执行，本轮派单必未投过——判定与投递互斥；
         readRaw 判收单定变体：曾收单=有上一轮上下文→投本轮增量 / 从未收单→投全量）
     无记录（含未物化崩溃壳）→ 同 id 重建（宿主判重不认未物化壳，重建合法；重建投全量变体）
```

- **废弃声明**：§8.2 的 empty→drain→同 id 重建路径废弃（与宿主持久判重/backend 记账冲突）；轮次 6 终裁②③再废弃「活会话投递」（活壳补发与 received-wait 投本轮正文——活会话统一等待永不重投）与「冷唤醒轻量续行提示」（冷会话不在执行、本轮派单必未投过，改为判收单投增量/全量）。
- **保守方向钉死**：冷支事件形态不可判定按已收单（投增量——成员有上一轮上下文可自辨；误判未收单会向无上下文会话投不可执行的增量）；持久服务缺失按无记录走重建，宿主 DUPLICATE_CHILD 兜底拒绝（报错可恢复，不产生双成员）。
- **实现落点**：dsh/tw-tool-subagent.js（判定原语 ownSuffixOf/sessionReceived/coldSessionStatus/coldSessionReceived + followupChild + 创建核心对账（活归属检查/冷唤醒双变体/重建投全量），target 校验延迟到创建路径——等待/投递不需要模型选择）与 dsh/tw-dispatch.js（reconcileSession 四态判定 + wait-inflight 处置 + 续派 handleContinuation）两处同源原语。
- **单写者声明**：多宿主并发写同任务不支持；最坏后果 = 报错可 retire 恢复（宿主文件层 link() 原子发布防线保证不产生双成员）

### 9.2 B 未决卡统一静止化（升档/人工门/migrate）

- 所有未决决定卡统一进 derive 静止态，**pending 卡优先于派发阻塞判定**（produceBlocked/routeBlocker）——修复「升档卡期间 run/dispatch 仍走 dispatch 分支重签 + 渲染与 decide 两源错位」；
- 一切重渲染直接用账本 pending.choices 与 pending.reason（**禁止重算**）；签发幂等（存在未决同类卡返回原卡，卡面=账本=decide 依据）；derive 静止态透传卡上下文标记（gateId/reworkStalemate/reworkBlocked）供指纹失效重签生成正确选项；
- **升档指纹扩为完整包配置序列化**（id+tier+writable+done+dependsOn）：签发/落盘/查找/decide 四处同源；历史无字段批准视为失效（多问一次优于误授权）；升档卡指纹失效由 dispatch 通道作废重签（re-sign 循环），封堵「静止渲染旧卡 + decide 拒答」死循环。

### 9.3 C 续派恢复边：活→等待 + 冷唤醒机器投递 + 全量 prompt 变体（轮次 6 终裁②修订）

- 在场（活、归属一致）：**统一等待不重投**——活 = 任务进行中（通知链保证不僵死），重入判活恒等待；催单用 send_message；本轮正文永不重投（防成员重复执行整轮工作的成本事故）；
- 冷持久（归属一致）：冷唤醒 + 缺什么补什么——判收单定变体（曾收单=有上一轮上下文→投本轮增量；从未收单→投全量）；
- 异主（活或冷）：接管冲突卡；
- 断链：fresh 重建投**全量变体**——新成员无原上下文，增量单不可执行；
- runtime 在 waves/inflight 导出层附 promptFull 字段（objective/constraints/exclusions 内嵌；continuation 派单专属）；**绑定层不拼装**（P4 与 §7.1 评审先例）。

### 9.4 D run 无锁只读快照

- run 与 gate 统一无锁只读快照（旧实现取任务锁会在锁目录创建/写入/删除锁文件——锁目录只读时 EACCES 不是只读）；
- 单文件原子写保证不撕裂，跨文件尽力一致：卡面标注 journalSeq（所读 journal seq 版本）供对账；自愈写回只在锁内写命令（loadTask repair=false 默认）。

### 9.5 E 损坏账本重建等价（rebuildArtifacts 三源拼接）

- 三源：journal 的 report-accepted 序（全序）+ reports 文件事实（stage/package）+ snapshots（digest；快照文件保留多 path 标签——同 digest 多路径共享快照不丢关联）；
- kind 按「报告 dispatchKey → journal dispatched 的 writable → writableMatch」精确推导（与正常登记 kindOf 同口径含目录继承）；
- 每路径取最新报告完整事实（digest/kind/stage/reportRef）——修复同路径多报告（多轮 ver/跨 key 重交/同 digest 重交）只恢复首见版本、字段随 readdir 顺序漂移；
- 保守降级可测定义 = 结构校验失败跳过该报告/路径并在 degraded 中列出（不产出错误事实）；**快照损坏（非 JSON）按缺失处理**（终裁①，Challenger r5 死门封堵：文件级 degraded 给足提示——损坏文件路径 + 处置建议（依据 journal/报告上下文定位来源后重跑重做，或人工修复/移除损坏文件，由 Lead 自主决策），路径经「快照缺失」路径级 degraded 自然列出；重建不抛 STATE_CORRUPT，run/gate/deliver/review 全链无死门）；结构校验含 reportId（缺 reportId 的报告会产出 reportRef 缺失的 item、cmdRestore 无法寻址）；等价性断言矩阵：损坏 → 重建结果与损坏前逐字段等价。

### 9.6 验收（fake 宿主契约 5 条，docs/dispatch-rework-investigation.md §三）

- 判定链矩阵（四态）：活（归属一致）等待且重入幂等不重投 / 活异主接管冲突 / 冷归属一致冷唤醒（曾收单投增量、从未收单投全量）/ 冷异主接管冲突 / 未物化崩溃壳同 id 重建（投全量）/ 持久服务缺失宿主判重兜底 / own-suffix 按 seedLength 切分（seed 段 spliced 不算收单）/ readRaw 撕裂行保守 / 非 raw 后端降级 inspect；
- 静止化：升档卡签发后 run 呈原卡、再调 dispatch-plan 同卡幂等、待决期间拒绝重拆；指纹扩字段（改 done 也失效）；
- 全量变体：续派 waves/inflight 导出 promptFull、增量正文不含目标、空壳补发用全量；
- 无锁只读：锁目录 0555 时 run 照常返回、locks 目录零变化、journalSeq 在场；
- 重建等价：三组矩阵逐字段等价 + kind 目录继承 + degraded 列出。

### §9.7 已知限制（challenger r7 findings，用户裁决记录收口，2026-09-06）

1. **续派断链 fresh 的两处入口仍投增量变体**（dsh/tw-dispatch.js 正常波循环与 wait-inflight 分支 4）：触发条件为「续派波 + 映射断链（多因账本损坏降级）」经这两条入口创建新成员——新成员收到不含目标/约束的增量单，该轮不可执行需 retire 重派。低频（正常流程不断链）、可恢复、不损数据、不影响防双发。**根治方向**：变体选择目前分散五处入口各自实现（历轮修一处漏一处的结构原因）——后续收敛为单一 helper（五处引用），并补「断言投递变体」的测试（现有测试只断创建不断变体，全绿但行为错）。
2. **创建核心活判定 sessions.get 无异常包裹**（dsh/tw-tool-subagent.js）：异常时抛裸异常而非结构化失败卡，违反 P2 呈现纪律；方向安全（登记完成、无子会话、重试幂等）。

