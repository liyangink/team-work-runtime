# tw-dispatch 工作流派发工具方案

状态：**待用户审查**。

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
3. 标签由工具生成、skill 标签规范降为说明（§3.3）。
