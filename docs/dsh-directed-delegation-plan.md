# DSH 定向委派技术方案

状态：**已批准；第一阶段已实施（自动测试与全量回归绿），真实 DSH 验收（§7 七条）与第二阶段切链清理待做**。方案经 Challenger/Expert 多轮评审与人工门批准（dec-2ffeb0，2026-08-31，评审任务 `dsh-directed-delegation` 已归档）；批准后经两轮用户裁决增量：① 工具及实现/测试命名改为 `tw-tool-subagent`（短横线，对齐 DSH 工具目录命名，见 §9 第 3 条）；② 新增 §3.7 档位价值主张与主动委派（见 §9 第 4 条）。第一阶段落点：`dsh/tw-tool-subagent.js`、`dsh/inject.js`（直接选择 + header 回读通道）、`dsh/index.js`（装配 + systemPrompt section）、`dsh/client/badge.js`（@ 候选）、`tests/dsh-tw-tool-subagent.test.mjs`。

## 1. 方案结论

在现有 DSH 平台绑定中增加 `tw-tool-subagent` 工具，让 Lead 可以按档位，或按 provider、model 和 effort 创建子代理。工具复用 DSH 原生子会话能力，不重写子代理引擎。

`@junior`、`@senior`、`@expert` 与新工具在第一阶段同时交付。自然语言和 `@` 只是两种输入方式，最终都由 `tw-tool-subagent` 执行。工具说明携带三档成本/速度价值主张（§3.7），Agent 在 team-work 工作流内外都可按性价比主动选档委派。

新能力属于基础设施层的 **PlatformBinding**。不新增第五个架构 Module，不新增 npm 包，也不在 CoreRuntime 中增加派发逻辑。

## 2. 现有方式为什么要换

现在的模型注入依赖子代理标签。`dispatch-plan` 先把模型选择写入任务的 `agents.json`，插件再从新子会话的标签反查这份选择。

现有字段的含义如下：

| 字段 | 含义 |
| --- | --- |
| `tagHints` | “派发标签 → 模型选择”。新子代理创建时，插件用标签查它应该使用的模型。 |
| `pendingTags` | “派发标签 → 派发编号”。插件取得真实 sessionId 后，用它找到应回填的派发记录。 |
| `modelHints` | “sessionId → 模型选择”。标签查找失败或旧会话恢复时，插件按 sessionId 补读。 |
| `mappings` | “派发编号 → sessionId”。Runtime 用它找到原子代理，以便通过 `send_message` 续派。 |

这套间接链路已能工作，但有三个问题：

- 标签既给人看，又承担机器寻址；格式写错就无法正确注入。
- 模型选择经过多个中间字段才到达子代理，时序和恢复逻辑较复杂。
- 脱离正式 team-work 任务时，Lead 无法直接指定档位、模型和 effort。

新工具要把模型选择直接交给子代理的创建过程。标签因此可以回归展示用途，上述三个中间字段也可在迁移完成后删除。

## 3. 技术选择

### 3.1 复用 DSH 子代理能力

DSH 已经实现了子会话、持久化、恢复、取消、通知和父子关系。新工具只调用 `ctx.subagents.startContinuable()`，不复制这些实现。

DSH 允许调用方预先生成 child session id，并通过 `childId` 传给 `startContinuable()`。这是新方案的关键：插件在子代理创建前就知道它的 sessionId。

provider 和 model 直接写入 DSH 原生 `agentOptions`（`AgentOptions` 只含 `provider?`/`model?`/`maxTokens?`，已源码核实）。effort 不在 `agentOptions` 中，因此继续通过 DSH 提供的 `installModelSelection()` 在首次请求前注入（`ModelSelection.reasoningEffort` 经 `agent/request` 瀑布下发到每次请求）。

> 实现校准（已对 DSH 0.1.0-rc.7 源码核实）：`installModelSelection()` 的 `agent/request` 瀑布会**同时**覆写 provider、model 与 reasoningEffort（见 `dsh-agent/lib/index.js`）。因此首版只把 effort 交给 selection、provider/model 交给 `agentOptions` 即可——两者值完全相同，selection 的 provider/model 覆写不冲突。禁止让 selection 与 `agentOptions` 两处各解析一遍 provider/model（会引入双源不一致）。

### 3.2 架构归属

```text
PlatformBinding（基础设施层）
└── dsh/
    ├── index.js              插件装配
    ├── tw-tool-subagent.js  定向选模工具的内部实现
    ├── inject.js             子代理创建期的模型注入
    └── client/badge.js        现有客户端入口，增加 @ 候选
```

`tw-tool-subagent.js` 只是 DSH PlatformBinding 的内部实现文件，不是新的架构 Module。对外仍然只有根包导出的一个 DSH 插件。

新功能直接复用下列 DSH 能力：

| DSH 能力 | 用途 |
| --- | --- |
| `tools` | 注册 `tw-tool-subagent`。 |
| `subagents` | 创建可续聊子会话。 |
| `llm` | 在创建前验证 provider、model 和 effort。 |
| `sessions` | 读取首个请求记录并等待写入完成。 |
| `sessionPersistence` | 保存子会话，供 DSH 重启后恢复。 |
| `systemPrompt` | 向 Agent 说明新工具与原生工具的选择规则。 |
| `inputTriggers` | 在 Web 输入框提供 `@` 档位候选。 |

除 `inputTriggers` 外，表中能力都是新工具的宿主侧依赖。缺失时工具明确报错，插件不重写子会话或持久化系统。客户端缺少 `inputTriggers` 时只关闭 `@` 候选，自然语言和工具调用仍可使用。

### 3.3 工具参数

按档位委派：

```js
tw-tool-subagent({
  description: "简短名称",
  prompt: "完整任务",
  target: { tier: "junior" | "senior" | "expert" }
})
```

按精确模型委派：

```js
tw-tool-subagent({
  description: "简短名称",
  prompt: "完整任务",
  target: {
    provider: "<provider-id>",
    model: "<model-id>",
    effort: "<可选>"
  }
})
```

两种 `target` 互斥。显式选择必须同时提供 provider 和 model；effort 可选。档位来自 DSH 全局配置，单次临时委派在候选数组中稳定选取第一项。

工具始终创建后台、可续聊的子代理。成功结果返回 sessionId、实际 provider/model/effort 和选择来源。

首版不提供专用 `dispatch` 参数，也不向新工具传递 dispatchKey。创建 DSH 会话和维护 team-work 派发映射是两个已有明确职责的操作，不需要再绑成一个新接口。

### 3.4 sessionId 生成规则

sessionId 由插件在每次工具调用时生成，使用 Node.js `crypto.randomUUID()`。它是一个标准 UUID v4 字符串，不编入任务名、标签、档位或模型信息。

这个 id 作为 `childId` 原样传给 `startContinuable()`。DSH 将它同时用作子会话 id 和子 Agent id，并检查它是否与已存在的活动或持久化会话重复。

sessionId 不是模型参数，用户和 Lead 都不能自定义。如果 DSH 拒绝重复 id，本次创建失败并清理待注入选择；工具不会把已有会话当成本次创建结果。

sessionId 也不写入 label。DSH 已经用 sessionId 识别会话，label 只需保留给人看的名称。工具返回完整 sessionId，正式工作流再由 `agent-map` 保存它。

### 3.5 `@` 输入

客户端通过 DSH 现有 `inputTriggers.registerSource()` 注册 `junior`、`senior`、`expert` 三个 `@` 候选。选中后在输入框写入明确、可见的委派意图。每个候选的描述带对应档位的一句话价值主张（§3.7）。

`@` 候选不自己创建子代理，也不保存 sessionId。Lead 读取这段意图后调用 `tw-tool-subagent`；直接说“让 senior 处理”得到相同结果。

### 3.6 新工具与原生工具如何分工

两个工具同时存在，以“是否显式选择模型”为主要分界——由用户/任务指定，或由 Agent 按档位价值主张（§3.7）主动选定（下表描述的是**第二阶段切换后**的终态分工；第一阶段 team-work 正式派发仍用原生 `subagent`，本表只在 phase 2 切换后对 skill 生效）：

| 场景 | 使用方式 |
| --- | --- |
| 用户或任务指定了 tier、provider、model 或 effort | `tw-tool-subagent` |
| Agent 按任务复杂度、时效与成本主动选档（无需任何人显式指定） | `tw-tool-subagent` |
| team-work 首次派发，`dispatch-plan` 已给出 `modelHint` | `tw-tool-subagent` |
| 不指定模型，接受继承平台默认选择 | 原生 `subagent` |
| 需要原生工具的前台或一次性模式 | 原生 `subagent` |
| 继续已存在的子会话 | `send_message` |
| 需要继承父会话上下文 | 原生 `subagent_fork` |

这个决策不只写在文档里。`tw-tool-subagent` 的工具说明会写明适用条件和不适用条件；平台绑定还会通过 `systemPrompt.section()` 注入同一张决策表。工具说明与 systemPrompt 中的决策表统一带分阶段标注：team-work 正式首派一行注明「第一阶段仍用原生 `subagent`，第二阶段切换后改用本工具」。

team-work skill 另外固定正式派发用法（第二阶段切换后生效）：首派用 `tw-tool-subagent`，返回 sessionId 后调 `agent-map`，续派用 `send_message`。第一阶段 skill 保持旧规程（首派原生 `subagent`），与工具说明/systemPrompt 中「第二阶段切换后」的标注不冲突。三处文案按阶段对齐，避免互相矛盾。

这三层规则能大幅降低误选，但不会从底层拦截原生 `subagent`。插件在 Agent 选择工具前无法机械判断一段自然语言是否含有选模意图。是否需要硬拦截，以第一阶段真实误选数据为准。

### 3.7 档位价值主张与主动委派

工具说明（tool description）不只描述参数，还必须写明三档的成本/能力权衡，让 Agent 把 `tw-tool-subagent`（下文简称 tw-sub）当作有成本意识的通用委派入口，而不是只在有人明确指定模型时才被动使用：

| 档位 | 定位 |
| --- | --- |
| `junior` | 足以负担大部分基础工作；速度优势显著、单位成本最低——批量探索、信息收集、格式化整理、初稿类工作的默认选择。 |
| `senior` | 平衡档：推理能力与解题率不错，综合能力对比 expert 略有不足，但价格优势明显、性价比高——大多数常规开发任务的默认选择。 |
| `expert` | 最强推理能力、高解题率、低错误率；价格与执行耗时都最贵——只在高难度设计、疑难定位、关键技术裁决时使用。 |

文案要求：

- 工具说明与 `systemPrompt.section()` 注入的决策表携带同一张价值主张表（与 §3.6 的分阶段标注规则一致），并明确写出「不处于 team-work 工作流时同样可用」——脱离任务的普通委派（信息收集、并行调查、独立审查）也是合法用途。
- `@junior`/`@senior`/`@expert` 候选的描述各带对应档位的一句话价值主张（§3.5）。
- 引导语气是「积极但有意识」：Agent 应根据任务复杂度、时效要求和成本预算主动选档委派；不确定时优先 senior，明确的高难度才升 expert，大量低风险基础工作下沉 junior。

## 4. 创建过程

1. 解析档位或显式模型，用 `ctx.llm.resolveCallConfig()` 验证 provider、model 和 effort。验证失败时不创建子会话。
2. 调用 `crypto.randomUUID()` 生成 sessionId，在插件内存中暂存该 id 对应的模型选择。
3. 调用 `startContinuable()`，将 sessionId 作为 `childId`，并将 provider/model 写入 `request.agentOptions`。注意 `ContinuableStartSpec.provider` 是**子代理 provider 名**（`spawn`/`fork` 等），不是 LLM provider——LLM 的 provider/model 必须放在 `request.agentOptions` 里，二者是两个命名空间（已按 `dsh-tool-subagent/lib/index.js` 核实原生 `subagent` 工具的做法）。新工具不设置“仅顶层 Lead 可用”的额外深度上限。
4. DSH 执行子代理 setup 时，现有注入入口先按 sessionId 取直接选择；未命中才走迁移期的旧标签逻辑。
5. 工具确认 `sessionPersistence` 存在，并且 `ctx.sessions.flush(childSession)` 后，才报告启动成功。`childSession` 经 `ctx.sessions.get(childId)` 读取（`SessionStore.get(id): Session | undefined`，见 `dsh-session/lib/types/index.d.ts`）；`flush(session): Promise<boolean>` 的返回值语义是“是否有至少一个持久化监听器参与”，无监听器或抛错均视为启动未持久化、不报告成功。**不做首请求 header 运行期对账**（用户裁决，见 §9 第 5 条）：模型/effort 的实际生效由客户端徽标展示承载（人工可见核验）；实机验证曾证立即对账必然误杀（inbox 接受 ≠ 首请求已发出，header 未落盘），限时轮询又引入时序复杂度，均超出产品需求。

provider/model 和 effort 始终来自同一份已验证选择。不允许两处分别解析，避免子会话描述信息与真实请求不一致。

同一进程内并行创建时，内存选择按 sessionId 隔离。两次独立工具调用本来就代表两次委派，不需要为它们增加跨进程派发租约。

工具不写入自定义 session 事件。DSH 不识别仓库外插件自定义的事件类型，这类事件会使冷恢复失败。

## 5. 与 team-work 派发的关系

本节描述**第二阶段切换后**的目标态；第一阶段 team-work 正式派发仍用原生 `subagent` 旧链（见 §6 实施步骤）。

新工具本身已足够支撑正式工作流，不增加第二套派发入口：

1. `tw dispatch-plan` 继续给出 prompt、dispatchKey 和已固化的 `modelHint`。
2. 首次派发调用 `tw-tool-subagent`，`target` 直接采用 `modelHint` 中的 provider/model/effort。不重新按 tier 选模，因此不会丢失同波模型多样性。
3. 新工具返回 sessionId 后，调用现有 `tw agent-map --task ... --key ... --agent ...` 登记续派映射。
4. 后续返工和复审继续根据 `expectedAgentId` 调用 DSH 原生 `send_message`。

`tw-tool-subagent` 只管 DSH 子会话；`dispatch-plan` 只管工作流事实；`agent-map` 只管派发编号与 sessionId 的对应关系。三者职责已经完整，不增加预留、提交、恢复等 Runtime 命令，也不另造工作流专用的派发模式。

## 6. 实施步骤

### 第一阶段：交付完整工具

- 在 DSH PlatformBinding 内实现 `tw-tool-subagent`，支持档位和精确模型两种调用。
- 同时实现三个 `@` 档位候选，自然语言调用也必须可用。
- 验证首次请求、并行创建、续聊、重启恢复和失败清理。
- team-work 正式派发暂时仍用原生 `subagent`，旧注入链保持不变，便于对照和回退。

第一阶段的验收结果是一个可独立使用的完整工具，不是半成品或只供后续迁移的底层接口。

### 第二阶段：统一派发并清理旧链

先把 team-work skill 的首次派发从原生 `subagent` 切换为 `tw-tool-subagent`，并用现有 `agent-map` 登记返回的 sessionId。续派仍用 `send_message`。

新派发切换后，停止新写 `tagHints`、`pendingTags` 和 `modelHints`。标签只保留阶段、角色和简述，不再含机器寻址段。runtime 侧写端同步清理：删除 `runtime-v3/cli.mjs` 的 `persistTagHints`（定义 `cli.mjs:29`，调用点 `cli.mjs:473/480/488`，即 `tagHints`/`pendingTags` 的派发落盘）；`cmdAgentMap` 中 `modelHints` 的落盘与 note 文案（`cli.mjs:796-805`）改为只登记 `mappings`——`agent-map` 保留为派发编号→sessionId 的续派登记通道；对应测试（`tests/tag-hints-runtime.test.mjs`、`tests/tag-agent-auto-register.test.mjs`、`tests/dsh-tag-injection.test.mjs` 等）随写端删除或改写。

关于 `#任务名` 任务段（`dsh/inject.js` 的 `parseLabelTag` 当前用它定位任务级 `agents.json` 并触发 `mappings` 自动回填）：自动回填删除后，该段不再充当任何机器寻址输入，仅保留侧栏跨任务列表的分组/展示用途。**第二阶段保留任务段（降级为纯展示）**，并同步 `skills/team-work-v3/references/dsh-orchestration.md` 的“成员标签规范”节：删除“机器段是模型注入的寻址键”以及机器段/任务段“写错=退化默认模型”的表述，改为纯展示语义（仍固定格式，便于人读分组）。

升级前已创建且仍在通话的旧子代理，需要暂时保留旧字段的只读兼容。确认没有活动旧会话后，在同一阶段内删除兼容实现。

清理完成后，`agents.json` 只保留 `mappings`，即 dispatchKey 到 sessionId 的续派关系。同时删除标签反查、自动回填、sessionId 轮询补读及对应测试。

同步更新 `runtime-v3/cli.mjs:873` 的 `modelHint` 输出：`effort` 现带的硬编码 `effortNote: "Lead 派发原语暂无下发通道；Phase 3 插件经 registerContinuableSetup 注入 continuable 成员"` 在切换后成为错误信息——首派已能经 `tw-tool-subagent` 下发 effort，应删除该 `effortNote`（或改为指向新工具的准确说明）。已核实无需修改任何断言：tests/ 中无 `effortNote` 断言，全部 `modelHint` 的 `deepEqual` 比对均为同源快照（期望值取自 dispatch-plan 波次或派单卡，如 `tests/runtime-v3-dsh.test.mjs:300/317/459/461`、`tests/runtime-v3-topology.test.mjs:523-524`，非字面量）；`dispatched.detail.modelHint` 由 `runtime-v3/dsh-map.mjs` 的 `computeModelHint` 生成、本就不含 `effortNote`，删除后 dispatch-plan 输出与 journal 快照反而更一致——回归确认测试全绿即可。

实施新增 `dsh/tw-tool-subagent.js` 时，同步 `docs/file-inventory.json`：该文件已把 `dsh/tw-tool-subagent.js` 与 `tests/dsh-tw-tool-subagent.test.mjs` 预列为 `planned`，落地后须把它们从 `planned` 迁移到 `newImplementation`（AGENTS.md 变更要求：新增/迁移实现路径必须同步本清单）。

## 7. 验收标准

### 自动测试

- 档位、精确模型和可选 effort 的参数校验正确。
- sessionId 由插件生成为 UUID v4，不接受模型输入；重复 id 不得复用已有会话。
- 不存在的 provider/model 和无效 effort 在创建前失败，不留子会话。
- 多个子代理并行创建时，模型选择不串线。
- 缺少持久化后端、`flush()` 返回 `false` 或持久化失败时，不报告启动成功。
- `@` 候选能正确搜索、选择和写入委派意图，与其他 DSH `@` 来源共存。
- 工具说明、系统提示和 team-work skill 中的选择规则一致（按阶段限定：第一阶段要求工具说明与 systemPrompt 互一致、且不与 skill 旧规程矛盾——skill 首派仍是原生 `subagent`，工具说明/systemPrompt 的 team-work 首派行注明第二阶段切换后改用 `tw-tool-subagent`；第二阶段切换后三处完全一致）。
- 工具说明、systemPrompt 与 `@` 候选三处的档位价值主张同源一致（§3.7），且工具说明明确写出不处于 team-work 工作流时同样可用。
- 原生 `subagent` 在第一阶段不受新工具影响。
- （§10.3 风险 2）`installModelSelection` 的 selection 中 provider/model 与 `request.agentOptions` 断言同值；显式 provider/model 与 selection 不一致时创建前失败（防双源不一致把子会话打回默认模型）。
- （§10.3 风险 3）所选的子代理 provider 必须具备 `prepareContinuable` 能力（`continuable` 创建能力），缺此能力在创建前失败而非忽略（仿 `dsh-tool-subagent` 的能力校验）。
- （§10.3 风险 1）cold-resume 重建 selection 时，effort 从持久化 `request/header.config.reasoningEffort` 回读；单测覆盖重启后 effort 重建路径。

### 真实 DSH 验收

1. 分别用档位、精确模型和 effort 创建子代理，子代理右下角模型/effort 徽标展示与指定值一致（人工可见核验；工具不做运行期对账，§9 第 5 条裁决）。
2. 并行创建两个不同模型的子代理，会话与模型徽标均不串线。
3. 子代理完成一轮后，`send_message` 续聊仍使用原模型和 effort。
4. 重启 DSH 后恢复子会话，provider/model/effort 不变。实现依赖：provider/model 由 durable `agentOptions` 承载；effort 由 setup 阶段从持久化 `request/header.config.reasoningEffort` 回读重建 selection（见 §10.3 风险 1）——实现时必须落此依赖，否则本条只能验证 provider/model、无法验证 effort。
5. 执行一个完整 team-work 任务，首派、`agent-map`、续派、评审和门禁全链路正常。
6. 用升级前的旧子代理做跨版本恢复，确认清理前只读兼容有效。
7. 给出明确模型要求时 Agent 选择 `tw-tool-subagent`；无模型要求且无成本/复杂度考量的普通委派仍可选原生 `subagent`；Agent 面对大量低风险基础工作（下沉 junior）或高难度任务（升 expert）时，即使无人指定也应按价值主张（§3.7）主动选 `tw-tool-subagent` 相应档位。

评审留档的时序关注项（任务 `twsub-p1-review` 八轮收敛后并入，实机验收时逐项核验）：

- ~~flush 后首个 header 可见时序~~ 已随 header 对账砍除（§9 第 5 条）失效——实机两轮验证证实立即对账必然误杀健康会话，该需求整体移除；
- 宿主 `startContinuable` 是否尊重传入 `childId`——若忽略并自行生成，直接选择将 miss、effort 静默丢失且无提示；
- `drainContinuableChildren(parent, [childId])` 的停止完成语义（已核实为宿主公开 API，`dsh-subagent/lib/types/index.d.ts:195`，行为语义待实机验证）。

## 8. 首版限制

- 只支持后台、可续聊子代理，不复制原生工具的前台和一次性模式。
- 新工具不另设“仅 Lead 可用”的深度限制。Owner、Challenger 和 Expert 可以再委派 junior 做信息收集；这类助手必须只读，不得继续委派。
- 工具不内置档位上限与只读校验：任意会话成员都可直接指定任意 provider/model/effort（含最贵档），越级选模（如 junior 档成员按 expert 档委派）暂靠派单纪律约束，治理 hook 留待后续裁决；写边界仍靠派单纪律 + 只读子派单可写范围为空。
- 同一子会话中不切换模型或 effort；需要新选择时另建子代理。

## 9. 用户确认记录

以下事项已全部确认：第 1、2 条随 2026-08-31 人工门批准（dec-2ffeb0）生效；第 3、4 条为批准后的增量裁决。

1. 首版只提供后台、可续聊模式。
2. Owner、Challenger 和 Expert 可使用新工具委派 junior 只读助手，不仅限于顶层 Lead。
3. 新工具命名为 `tw-tool-subagent`（已由用户裁决确认）：模型侧注册名与 DSH 工具目录组件命名 `dsh-tool-subagent` 对齐——统一用短横线，前缀 `tw-` 对应本绑定命名空间（与现有 `tw` 工具同源），区别于 DSH 原生模型侧工具的 snake_case（`send_message`、`subagent_fork` 等）；实现文件 `dsh/tw-tool-subagent.js` 与测试文件 `tests/dsh-tw-tool-subagent.test.mjs` 同步该风格。通过工具说明、系统提示和 team-work skill 区分原生 `subagent`；首版不做硬拦截。
4. 工具说明携带三档成本/速度价值主张（junior 速度与成本优势、senior 性价比、expert 最强推理），并引导 Agent 在工作流内外主动按性价比选档委派（已由用户裁决确认，见 §3.7）。
5. 砍除首请求 header 运行期对账（2026-09-01 用户裁决）：该核验为评审链引入的额外需求，非产品需求——模型/effort 实际生效的核验由子代理右下角徽标展示承载即可。实机两轮验证证实立即对账必然误杀（startContinuable 返回时首请求尚未发出、header 未落盘），限时轮询属为额外需求引入的额外复杂度，一并移除；启动确认语义回归「sessionPersistence 在场 + flush 参与」。

## 10. 设计评审结论（owner 复核，2026）

本方案的技术支撑点已逐条对照 DSH 0.1.0-rc.7 实际实现核查，结论如下。

### 10.1 与 AGENTS.md / Roadmap 一致性

- **架构归属正确**：属 PlatformBinding（基础设施层 `dsh/`），不新增第五 Module、不新增 npm 包、不在 CoreRuntime 加派发逻辑——与 AGENTS.md“四个 Module”边界和 Roadmap v3.3 记录一致。
- **P4「模型只供语义」不违背**：新工具只收模型才知道的 `description/prompt/target`，sessionId、agent-map、dispatchKey 等簿记仍由插件与 CLI 推导，工具不向 LLM 索要 ID。
- **规则 16「只读子派单」兼容**：§8 限定的“Owner/Challenger/Expert 可委派 junior 只读助手、不得继续委托”与 AGENTS 16 一致，但深度上限的防御必须落在派单纪律 + 只读子派单可写范围为空，而非新工具内置深度开关（本方案已明确不设“仅 Lead 可用”额外上限，记录为可接受）。
- **§5 与现有派发链的关系正确**：`dispatch-plan` 的 `modelHint.provider/model/effort` 已核实（`runtime-v3/cli.mjs:873`），其中 effort 当前带 `effortNote: "Lead 派发原语暂无下发通道"`——新工具恰好补上这个下发通道。首派不重选 tier 的说法成立（`agent-map` 复用 `dispatch-plan` 已落盘的 `modelHint` 快照而非重选，`cmdAgentMap` 拒绝 `--model-hint`）。

### 10.2 已核查并订正的实现事实

| 方案宣称 | 源码核实结果 |
| --- | --- |
| `ctx.subagents.startContinuable()` 语义 | 存在，返回 `{childId, messageId}`；调用方预留给 `childId` 受支持，重复 id 被拒（`dsh-subagent/lib/types/continuation.d.ts`）。✓ |
| provider/model 写 `agentOptions` | `AgentOptions` 只有 `provider?/model?/maxTokens?`，无 effort（`dsh-agent/lib/types/runtime-types.d.ts`）。✓ |
| effort 走 `installModelSelection()` | `ModelSelection.reasoningEffort` 经 `agent/request` 瀑布下发（`dsh-agent/lib/types/model-selection.d.ts`）。✓ |
| `startContinuable` 的 `provider` 字段含义 | **是子代理 provider 名（spawn/fork 等），不是 LLM provider**。LLM provider/model 在 `request.agentOptions`。已订正 §4 步骤 3。 |
| `ctx.sessions.flush()` | 签名是 `flush(session): Promise<boolean>`（需传 Session；返回“是否有持久化监听器参与”，非空的“成功”布尔）。已订正 §4 步骤 5。 |
| `ctx.llm.resolveCallConfig()` | 存在，入参 `LlmCallConfig{provider,model,reasoningEffort?}`（`dsh-llm/lib/types/call-config.d.ts`）。✓ |
| `inputTriggers.registerSource()` | 存在，但属**客户端**面（`dsh-client-ui-input-trigger`），仅在 Web 输入框。§3.2 表格把它和宿主能力并列有轻微分类误导，§3.5 已正确说“客户端”。 |
| `systemPrompt.section()` / `ctx.sessionPersistence` | 均为真实宿主服务入口（`dsh-system-prompt` / `dsh-session-persistence`）。✓ |
| setup 在冷恢复时重跑 | `registerContinuableSetup` 的 contribution 在每次 materialize **与 cold-resume** 都执行（`activation-setup-registry.d.ts`），直接选择注入跨重启有效。✓ |
| effort 冷恢复来源 | `request/header` 持久化 `config.reasoningEffort`（`dsh-session/lib/types/types.d.ts` 的 `EpochHeader`），故重启后 effort 可从会话日志恢复。 |

### 10.3 需在 Phase 1 实现时收口的风险（不阻塞批准，但必须写进验收）

1. **effort 的冷恢复权威源**（最高优先级，方案当前只写“插件内存暂存”）：内存选择在 DSH 重启后为空。provider/model 有 `agentOptions`（durable）兜底，但 effort 必须明确恢复源。推荐：首版在 setup 阶段从**子会话已持久化的末次 `request/header.config.reasoningEffort`** 回读 effort 重建 selection；二阶段清理 `modelHints` 后，不再依赖 `agents.json` 承载 effort。请把 §7 真实验收第 4 条（重启后 effort 不变）的实现依赖写明，否则该条只能验证 provider/model、无法验证 effort。**重建 selection 时 provider/model 必须与之同源回读（同一持久化 `request/header.config`），并与 `agentOptions` 断言同值**——否则 selection 的 `agent/request` 瀑布会把恢复后的子会话 provider/model 覆写回默认模型（与风险 2 的单一来源约束相交叠，务必同时满足）。
2. **同一份选择的单一来源**：`installModelSelection` 会覆写 provider/model/effort。必须保证 selection 里的 provider/model 与 `agentOptions` 完全一致（见 §3.1 订正），禁止双源解析。建议 Phase 1 加一条单测：显式 provider/model 与 selection 不同时报错或断言同值。
3. **子代理 provider 选取**：`ContinuableStartSpec.provider` 用哪个子代理 provider 名（沿用原生 `subagent` 插件 config 的 provider，还是固定 `spawn`）需在实现时钉死，并适配 `continuable` 能力检查（provider 必须有 `prepareContinuable`，`dsh-tool-subagent` 已示范校验）。
4. **写边界仍靠派单纪律**：新工具不改变成员写边界的现有三层防线（派单纪律 + deliver 校验 + 快照恢复）。Roadmap 已明确写边界 hook 不做（用户裁决），本方案不引入，一致。

### 10.4 收敛结论

- 第一阶段交付“完整可独立使用的工具 + `@` 候选”是合理且必要的里程碑（原生 `subagent` 工具**无**任何 model-facing 的 provider/model/effort 参数，已核实——这印证 §2 的问题陈述）。
- 两阶段、清理旧链前保留只读兼容、标签回归展示用途的迁移路径与 Roadmap（tagHints/pendingTags/modelHints 最终删除、`agents.json` 只留 `mappings`）一致。
- **批准条件**：§10.3 第 1、2、3 条风险在实现时给出确定性落点并纳入自动/真实验收即可，方案本身可作为一阶段开发基线批准。

### 10.5 遗留 unresolved（不阻塞，供实现期跟踪）

- 方案 §3.2 表格把 `inputTriggers` 列为宿主侧依赖；实际是客户端面，缺它只关闭 `@` 候选、不影响工具与自然语言（§3.2 尾段已自洽）。2026-09-01 实机暴露实现曾用 `ctx.inputTriggers` 直接探测未声明服务，触发 Cordis `without inject` 并阻断 Web 装载；已统一改为 `ctx.get()` 可选查询，并同步修复 Host 的 `systemPrompt` 与工具执行期 `llm/sessions/sessionPersistence` 查询。严格 Context 守卫回归锁定“未声明服务禁止直接属性访问”。
- §6 二阶段“跨版本旧子代理只读兼容”的兼容窗口结束条件（“确认没有活动旧会话”）如何机械判定未定义；建议以“旧字段写端已移除后一个宿主重启周期 + 日志无旧标签命中”为收敛信号，实现期细化。
