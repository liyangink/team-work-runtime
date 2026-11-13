# 派发成本、角色模型与意图确认机制改造方案

> 状态：待用户批准（本方案是需求、范围与实现方向的唯一批准正文）。
> 用户第 4/5 轮已拍板：任务级与包级一律保存已解析的具体模型实例（ModelRef）；删除包级升档审批；effort 只在配置了合法枚举时保存，否则省略字段（宿主实测："" 被拒、"none" 被拒）；砍掉 modelBaseline/taskOverrides/dispatchTargets/intake 等复杂嵌套，agents.json 只留 mappings + roles，确认门复用 decisions/journal。
> 本轮（r5）按用户指示做**结构简化**：去掉自包含指纹与多层嵌套，按"稳定配置投影"重算确认指纹；补齐删除升档审批的旧卡收口与残引用清理；§11 原待裁决项由团队内部定稿（见 §11），不再留待用户逐项裁决。
> 调研基线：当前工作区源码。事实均给文件与行号；推断/建议单独标注。示例配置脱敏。

**r5 修订摘要（本轮重点，便于复审对照）**：
1. **effort 语义定稿**（§3.0）：`ModelRef.effort` 可缺省；配置时保存非空合法枚举（如 `off/high/max`），不配置或模型不支持时**省略字段**；严禁 `""` 或 `"none"`。依据为用户提供的宿主源码与工具实测结论（`@deepseek-ai/dsh-llm` 的 `resolveCallWithInfo` 2292-2316 行、`@deepseek-ai/dsh-tool-subagent` 47-77 行：`""` 被 `assertNonEmpty` 拒绝，`"none"` 被 `UNSUPPORTED_REASONING_EFFORT` 拒绝，唯一合法表达是省略该字段）。
2. **砍掉 modelBaseline/taskOverrides/dispatchTargets/intake**（§3.1/§3.2/§3.8）：`agents.json` 只保留 `mappings` + `roles`（按角色直接存 `ModelRef`）；`packages.json` 每包直接存 `model:ModelRef`；派发读 `pkg.model ?? agents.roles[role]`；已派发历史继续用 journal `dispatched.detail.modelHint`；确认门只用 decisions/journal。
3. **确认指纹改为稳定配置投影**（§3.4.4）：`digestValue({ intent, roles, packages })`，排除指纹自身、时间戳、decisionId、profile 等运行元数据——消除"指纹包含自身/确认写入字段"的自包含 bug。
4. **补删除升档审批的收口**（§3.3.3）：历史 journal 中未决的 `escalation-*` 卡按 `decided:superseded` 处理；清理 `cli.mjs:647-650`（runStatusCard）等残引用（清单见 §4）。
5. **§11 内部定稿**（§11）：覆盖范围、gap 未答复、policy 未消费字段、kernel 死常量、costWeights 去留全部给出结论与理由，不再列为待用户裁决；仅在出现新的实质授权冲突时再提报。

## 0 结论与推荐

一句话：把"谁用什么模型"收拢成一条极简数据链——**默认档位只来自 `default.json`；`tw open` 把三个角色解析成 `ModelRef` 存进 `agents.json.roles`；`tw plan` 把每个包解析成 `ModelRef` 存进 `packages.json`；派发直接读 `pkg.model ?? roles[role]`，不再查配置；意图与模型用一张确认卡（复用 decisions/journal）在开放时对齐，拆包后按稳定指纹重签；已有会话不热替换模型，只给"保留旧会话 / 重开会话"的显式选择**。

| 议题 | 结论 |
| --- | --- |
| 模型数据类 | `ModelRef{provider, modelName, effort?, family?}`；宿主映射集中在绑定层 `toHostTarget`（§3.0） |
| effort | 缺省=省略字段；配置时用宿主合法枚举；禁止 `""` 与 `"none"`（§3.0，宿主实测） |
| 任务角色配置 | `agents.json.roles.{owner,challenger,expert}` 直接存 `ModelRef`，open 初始化、`tw roles` 读写（§3.2） |
| 包级配置 | `packages.json[].model:ModelRef`；`tier` 只作 `tw plan` 入参语法糖，落盘前解析（§3.3） |
| 派发来源 | `pkg.model ?? agents.roles[role]`；已派发历史复用 journal `modelHint`（§3.8） |
| 确认门 | 复用 `decision-issued` + `decisions`；指纹 = `digestValue({intent, roles, packages})`；plan 后重签（§3.4） |
| 升档审批 | 删除；历史未决卡按 `superseded` 收口；残引用清理（§3.3.2/§3.3.3） |
| 已有会话换模型 | 派发点拦截：保留旧会话→绑定 `keptModelRef`；重开→写 `session-reset` 强制新会话（§3.6） |
| 待用户裁决 | 无（§11 已内部定稿）；新增实质授权冲突时再提报 |

## 1 现状事实（源码核查）

### 1.1 当前派发成本链路

1. **场景默认档**：`team-work/policies/default.json:12-37` 按 `scenes.<scene>.ownerTier/challengerTier` 给默认档；顶层 `riskTiers`（第 9 行）、`costWeights`（第 5 行）同文件。
2. **档位计算**：`runtime-v3/cli.mjs:380-388` `ownerTierFor` = 包 `tier` 优先，否则场景默认，再按 `riskTiers[intent.risk]` 只升不降；challenger 固定场景 `challengerTier`，expert 固定 `'expert'`（`cli.mjs:517`、`cli.mjs:699-708`）。
3. **档位→模型**：`runtime-v3/dsh-map.mjs:116-133` 从调用快照（`TW_DSH_CONFIG`）解析；`computeModelHint`（同文件 31-43）做候选池家族去重，产出 `{provider, model, source, family, selectedBy, effort?}`。
4. **派发快照**：`cli.mjs:1534-1538` 选 `modelHint`；`cli.mjs:1555-1577` 导出 `waves[].modelHint/weight`；`cli.mjs:747-761` 写入 journal `dispatched.detail`。
5. **创建成员**：`dsh/tw-dispatch.js:279-286`、`:341-346` 把 `modelHint` 转成 `target{provider,model,effort}`；`dsh/subagent-session.js:107-118` 用 `llm.resolveCallConfig` 校验 provider/model/reasoningEffort 一致才创建。
6. **映射登记**：`cli.mjs:1430-1466` `tw agent-map` 写 `agents.json.mappings`；`cli.mjs:1133-1148` retire 删该波 key；当前 agents.json 只存 mappings（`cli.mjs:1426-1429` 注释、`cli.mjs:1433` 拒绝 `--model-hint`）。
7. **成本相关门**：升档审批卡（`cli.mjs:853-898`）在包 tier 高于场景默认时签发 `decision-issued`，卡面硬编码 `"权重倍数 junior:senior:expert = 1:10:50"`（`cli.mjs:878`）；`escalationFingerprint`（`cli.mjs:399-405`）绑定完整包配置。
8. **意图**：`runtime-v3/store.mjs:73-74` open 写 `intent.json`（`{objective,constraints,exclusions,revisions,risk}`）；`cli.mjs:1270-1294` `tw intent` 增补字段。**当前没有任务初期的意图确认环节**。
9. **人工门**：`runtime-v3/gate.mjs:173-204` 只认 workflow 声明的门与 through-stage 的 scoped 门；门禁判定不读档位；未决决定卡统一让任务静止（`derive.mjs:78-104`）。
10. **宿主 effort 语义**（用户第 5 轮提供、源码+工具实测）：`""` 被 `assertNonEmpty` 拒绝；`"none"` 被 `UNSUPPORTED_REASONING_EFFORT` 拒绝；合法枚举由 `list_subagent_models` 返回（示例：某模型 `off/high/max`、另一模型 `low/medium/high/xhigh/max`）；**不配置推理强度时唯一合法表达是省略字段**。本仓库侧可核实的入口是 `dsh/subagent-session.js:115-118` 的 `reasoningEffort` 透传与回读一致性校验。

### 1.2 档位与成本相关的影响清单（全量排查）

"性质"：**数据**=只改数据/文案；**接线**=让已有数据真正被消费；**新增**=新字段/命令/卡；**清理**=死代码或重复来源。

| # | 位置 | 现状（证据） | 性质 | 本次处置 |
| --- | --- | --- | --- | --- |
| 1 | `default.json:5-10` | `costWeights/automaticLimits/maxAutonomousRounds/concurrencySoftLimit/riskTiers/selection` | 数据 | 增 `roles` 兜底档；`automaticLimits` 保留但不接线（§11-3） |
| 2 | `default.json:12-37` | 场景 `ownerTier/challengerTier/core` | 数据 | 作为唯一默认档来源 |
| 3 | `waves.mjs:11-24` `scenePolicy` | 读场景档与 core/maxRounds | 接线 | 增读 `policy.roles` 兜底 |
| 4 | `cli.mjs:380-394` `ownerTierFor/isEscalatedTier` | 包 tier→场景→risk；升档判定 | 接线+清理 | 改为 open 时初始化 `roles`；删除 `isEscalatedTier` |
| 5 | `cli.mjs:699-708` `dispatchTiers` | 三路 + expert 字面量 | 接线 | 改为读 `roles`；移除 expert 字面量 |
| 6 | `cli.mjs:509-527` `dispatchCard` | 卡内 tier 计算 | 接线 | 卡头显示 `ModelRef` |
| 7 | `cli.mjs:399-405`、`853-898`、`1001-1006`、`1057-1067`、`1597`、`647-650` | 升档审批签发/重签/校验/残引用 | 清理 | **整段删除 + 旧卡收口**（§3.3.2/§3.3.3） |
| 8 | `cli.mjs:1534-1538` `selectModelHint` | 每次派发解析 tiers | 接线 | 改为 `pkg.model ?? roles[role]`（§3.8） |
| 9 | `cli.mjs:1555-1577` waves 导出 | `modelHint/weight` | 接线 | 导出 `modelRef/modelSource`；`weight` 保留展示 |
| 10 | `cli.mjs:1426-1466` `tw agent-map` | 只写 mappings | 新增 | 新增 `tw roles` 写 `agents.json.roles`；agent-map 只管 mappings |
| 11 | `cli.mjs:1270-1294` `tw intent` | 字段增补，无 gap/范围/验收 | 新增 | 扩展字段与参数 |
| 12 | `cli.mjs:1346-1422` `tw plan` | 包 tier 校验（1371） | 接线 | 入参 `model`/`tier`，落盘 `model:ModelRef`；缺档 `PLAN_MODEL_UNRESOLVED` |
| 13 | `cli.mjs:1030-1095` `tw decide` | 认账本 choices + 人工门/升档指纹 | 新增+清理 | 增 intake 指纹校验；删升档校验 |
| 14 | `cli.mjs:96-112` `presentationText` | Lead 规则反吐 | 数据 | 决定点补 intake/换模型卡说明 |
| 15 | `derive.mjs:78-104` | 未决卡统一静止 | 接线 | 新卡类型复用 |
| 16 | `gate.mjs:70-85` `humanDecisionFresh` | 双指纹新鲜度 | 接线 | intake 卡用独立稳定指纹 |
| 17 | `store.mjs:54-80` `initTask` | 只写 intent/scope/artifacts/journal | 新增 | 只扩 intent 初始字段（不新增文件，见 §7.3） |
| 18 | `dsh/settings.js:3-5` | 档位价值主张文案 | 数据 | 保留档位名，值判断句改中性 |
| 19 | `dsh/settings.js:52-54` `decisionTableText` | 工具分工 + @档位 | 数据 | 增 `tw roles`；删成本判据暗示 |
| 20 | `dsh/settings.js:56-63` `systemPromptSection` | 每档注入第一候选+价值主张 | 数据 | 保留解析展示，删价值判断 |
| 21 | `dsh/tw-dispatch.js:51-57` | 工具描述 | 数据 | 补确认卡/换模型说明 |
| 22 | `dsh/tw-dispatch.js:279-315` | target 来自 modelHint | 接线 | 改由 runtime 导出 `modelRef`，绑定层 `toHostTarget` 映射 |
| 23 | `dsh/subagent-session.js:107-125` | 只接受精确 target | 接线 | 新增 `toHostTarget(ref)`；`createDirectedSubagent` 收 `modelRef` |
| 24 | `dsh/client/badge.js:11-21` | 三档价值主张 | 数据 | 删成本判据 |
| 25 | `dsh/client/badge.js:83-140` | `@档位` 候选 | 事实 | 保留（普通委派，与正式派发解耦） |
| 26 | `dsh/client/badge.js:200-320` | 配置页 | 数据 | 补"正式派发以任务级 roles 为准" |
| 27 | `SKILL.md:22` | 定包 tier=默认 junior、按失败成本升档 | 数据 | 删判据，指向 default.json/tw roles |
| 28 | `SKILL.md:23` | risk 档用法 | 数据 | 保留 `--risk` 操作，删档位换算 |
| 29 | `SKILL.md:25` | 角色×档位正交 | 数据 | 保留正交说明，删价值判断 |
| 30 | `SKILL.md:41-42` | @档位/effort/配置来源 | 事实 | 保留 |
| 31 | `topology-and-cost.md:3-26` | 整篇定档原则 | 数据 | 重写为"数据从哪读、怎么改、怎么确认" |
| 32 | `topology-and-cost.md:44-47` | 候选池/热变句 | 事实+数据 | 更新为 ModelRef 语义与"热变不自动改" |
| 33 | `scenarios.md:13` | "默认 junior，按失败成本升档" | 数据 | 删除，指向 default.json |
| 34 | `dsh-orchestration.md:49` | 升档审批是成本核算触点 | 数据 | 删除（审批已移除） |
| 35 | `dsh-orchestration.md:73-76` | risk/tiers/热变句 | 事实+数据 | 补 `tw roles`；改写热变句 |
| 36 | `dsh-orchestration.md:81-82` | @档位与价值主张 | 数据 | 删价值主张 |
| 37 | `team-work/rules/lead/README.md:16` | 升档独立授权句 | 数据 | 改写（审批已删除） |
| 38 | `README.md:14,43-57,158` | 三档成本宣传 | 数据 | 改为"默认档来自 policy、模型来自 roles" |
| 39 | `policy/kernel.mjs:37-43` | `COST_WEIGHTS/costWeightForTier` | 清理 | 删除（无消费者，§11-4） |
| 40 | `evals/pricing.mjs:7-30` | 评测分层用 tier 标签 | 事实 | 评测域独立，不改 |
| 41 | `cli.mjs:290-303` `continuationPrevKey` | 续派回溯命中更早已结波映射 | 接线 | 加 `session-reset` seq 边界（§3.6） |
| 42 | `cli.mjs:1128-1130`、`1131-1147` `tw retire` | 只作用未结波、只删本波映射 | 事实 | retire 不能替代 fresh；fresh 由 `session-reset` 保证 |
| 43 | `dsh/subagent-session.js:115-125` | effort 透传 `reasoningEffort` | 接线 | `effort` 缺省即不传（不写 ""/none） |
| 44 | `packages.json`（`cli.mjs:1346-1422` 写、`store.mjs:97` 读） | 持久化 `tier` 字面量 | 接线+迁移 | 持久化 `model:ModelRef`；旧 `tier` 物化（§7.1） |
| 45 | `agents.json`（mappings 之外） | 无角色模型记录 | 新增 | `roles:{owner,challenger,expert}` 存 `ModelRef`（§3.2） |

### 1.3 已核实的事实差异

1. `default.json` 的 `concurrencySoftLimit`、`automaticLimits`、`selection.diversityWithinTier` **在 runtime 中无消费点**（全仓 grep 仅命中默认文件、测试夹具与 skill 文案）；`topology-and-cost.md:43` 却声称"受 concurrencySoftLimit 约束"。§11-3 内部定稿为"不接线、删文档承诺"。
2. `docs/team-topology-recovery-plan.md:5` 称 agents.json 是"dispatchKey→childId 与 modelHint 快照"，但实现只写 mappings（`cli.mjs:1442-1443`）。
3. `policy/kernel.mjs` 的 `COST_WEIGHTS` 与 `default.json:5` 是两份成本定义，前者无消费者（§11-4 定稿清理）。
4. `cli.mjs:878` 的权重倍数文案硬编码，改 `default.json` 不会改变卡面（随升档审批删除）。
5. 删除升档审批会暴露两处必须在同批处理的遗留：`cli.mjs:647-650`（runStatusCard 的 `pending.escalationFingerprint` 分支）与历史 journal 中未决的 `escalation-*` 卡（不处理会让任务永久静止）。处置见 §3.3.2/§3.3.3。

## 2 目标、范围与排除项

### 2.1 目标落点

| 用户目标 | 落点 |
| --- | --- |
| 1 派发成本机制只依 `default.json` 取默认档位 | §3.1（roles 初始化取 policy）+ §1.2 数据类条目 + §5 文本收敛 |
| 2 任务初期把各角色的具体模型与推理强度记录到 agent.json | §3.2（`agents.json.roles` 存 `ModelRef`）+ §3.8（派发只读它） |
| 3 intent 生成时同步并加人工门确认意图/约束/目标/范围与档位/模型 | §3.4（intake 确认卡，复用 decisions/journal）+ §3.5（gap） |
| 4 优化 intent 生成指引，任务卡模版化规范化 | §3.7 |
| 5 意图不明确时整理 gap 与用户对齐 | §3.5 |
| 用户第 4 轮：任务级与包级直接存具体模型实例，删除升档审批 | §3.0/§3.2/§3.3 |
| 用户第 5 轮：effort 缺省=省略；砍掉基线/覆盖表/派发台账嵌套；确认门复用 decisions；旧卡收口与残引用 | §3.0/§3.2/§3.3.3/§3.4.4/§3.8 |
| 补充约束：已有会话不可改模型，换模型要提示重开会话并确认 | §3.6 |
| 补充约束：OpenViking 经验只作设计方法参考 | §3.7.3（不接入产品流程） |

### 2.2 排除项（本轮不做）

1. 不接入 OpenViking 或任何外部知识库到运行时；不新增检索/记忆/同步接口。
2. 不恢复 Phase 2 成本投影/限额（`docs/runtime-roadmap.md:161` 与 AGENTS 已否决）；`weight` 只保留展示。
3. 不新增 workflow 阶段；确认门用决定卡实现（§3.4.2）。
4. 不改 `@junior/@senior/@expert` 普通委派通道与 profile tiers 配置页的数据形状（只改说明文字）。
5. 不做运行时模型热替换：DSH 绑定只能按精确 target 新建会话（`dsh/subagent-session.js:107-118`）。
6. 不保留包级升档审批；不把 `tier` 作为持久化派发依据（仅 `tw plan` 入参语法糖）。
7. 不动 `evals/`；不修改用户当前未提交的工作区文件（`team-work/rules/lead/*`、两个测试文件），实施时先与用户确认合并方式。

## 3 设计

### 3.0 模型数据类 ModelRef（含 effort 语义定稿）

```json
{
  "provider": "provider-demo",
  "modelName": "model-demo",
  "effort": "high",
  "family": "model"
}
```

| 字段 | 必填 | 语义 | 宿主（DSH）映射 |
| --- | --- | --- | --- |
| `provider` | 是 | 模型提供方 ID | 原样透传 |
| `modelName` | 是 | 具体模型 ID | 映射为宿主 `model` |
| `effort` | 否 | 推理强度；**只在配置了合法枚举时出现** | 映射为宿主 `reasoningEffort`；**缺省则不传该字段** |
| `family` | 否 | 家族（同波多样性/审计用） | 不投影；缺省取 `modelName` 首段（与 `dsh-map.mjs:17-19` 一致） |

**effort 语义（用户第 5 轮定稿，宿主实测结论）**：
- 配置了具体强度 → 保存非空合法字符串（如 `"high"`、`"max"`、`"off"`）；合法枚举由宿主 `list_subagent_models` 返回（不同模型枚举不同，例如某模型 `off/high/max`，另一模型 `low/medium/high/xhigh/max`）。
- 不配置或模型不支持 → **省略 `effort` 字段**（宿主唯一合法表达）。
- **严禁** `""` 或 `"none"`：宿主源码与工具实测（`@deepseek-ai/dsh-llm` 的 `resolveCallWithInfo` 2292-2316 行、`@deepseek-ai/dsh-tool-subagent` 47-77 行）确认前者被 `assertNonEmpty` 拒绝、后者被 `UNSUPPORTED_REASONING_EFFORT` 拒绝。本仓库侧对应入口是 `dsh/subagent-session.js:115-118` 的 `reasoningEffort` 透传与回读一致性校验。
- 校验：`effort` 若出现必须非空字符串且不等于 `"none"`（防御性拒绝）；`ModelRef` 未知字段拒绝（与 `dsh-map.mjs:45-67` 同风格）。
- **可追溯**（Expert 指出的"effort 未解析就确认"）：`roles` 文件只存 `ModelRef`（保持极简），但 `tw open` 在同一事务里写 journal `roles-initialized` 事件，detail 记录每个角色的 `{provider, modelName, effort: "high"|null, effortState: "configured"|"omitted"}`；确认卡按该事件展示"推理强度：high / 省略（不设置）"。这样确认时 effort 已是明确状态，不依赖后续解析。

**字段命名与宿主映射**：内部用 `modelName`（区别于档位概念），宿主用 `model`；映射只允许出现在绑定层 `toHostTarget(ref)`：

```text
toHostTarget(ref) = { provider: ref.provider, model: ref.modelName, ...(ref.effort ? { reasoningEffort: ref.effort } : {}) }
```

理由：① runtime 只处理 `ModelRef`，不拼宿主字段；② 映射可单测（`provider/model/reasoningEffort` 与 `resolveCallConfig` 回读一致，沿用 `subagent-session.js:116-118` 校验）；③ 历史 journal `modelHint.model` 读取时映射为 `modelName`。

### 3.1 角色模型初始化（open 一次性解析，跨阶段保持一致）

**初始化**：`tw open` 在任务锁内按 `default.json` 解析三个角色并写 `agents.json.roles`：
1. 角色默认档：owner = 场景 `ownerTier`（入口阶段）→ `policy.roles.owner`；challenger = 场景 `challengerTier` → `policy.roles.challenger`；expert = `policy.roles.expert`。owner 再与 `riskTiers[risk]` 比较只升不降（现状语义 `cli.mjs:386-388`，challenger/expert 不参与）。
2. 档位 → `ModelRef`：从本次调用快照该档候选池选一个（`dsh-map.mjs:22-43` 家族规则复用）。候选未给 `effort` → `ModelRef` 不含该字段。
3. 缺 tiers 快照/缺档 → 该角色写 unresolved 状态（`roles` 中缺该角色或值记为 `null`）+ journal 记 missing，**不阻塞 open**（平台无关操作必须可用，见 `dsh-020-adaptation-plan.md:68`）；确认卡不可确认（§3.4.5）。
4. journal 写 `roles-initialized`（含每个角色的 `ModelRef`、`effortState`、档位溯源、profile 来源）。

**跨阶段取舍（简化带来的显式行为变化）**：`roles` 按角色只存一份，**跨阶段不随场景默认档切换**（例如入口 research 的 owner 解析成 junior 后，进入 design 仍用同一 `ModelRef`）。理由：用户要求极简结构（按角色存实例），且"先记录、先确认、再派发"要求模型在任务内稳定；代价是失去"design owner 比 research owner 更强"的细分。需要细分时用 `tw roles --set` 显式改（改后重签确认卡，§3.4.4），并在 §7.2 行为变化中写明。

**更新**：`tw roles --task <n> --set owner=<tier 或 ModelRef>` 或 `--resolve`（按当前快照重解析）→ 重写 `roles` 并写 `roles-updated` 事件；若相关角色已有会话 → 触发换模型确认（§3.6）。

### 3.2 agents.json：只保留 mappings 与 roles

```json
{
  "mappings": { "d1-ab12cd": "平台子会话 ID" },
  "roles": {
    "owner":      { "provider": "provider-demo", "modelName": "model-demo", "effort": "high" },
    "challenger": { "provider": "provider-demo", "modelName": "model-demo" },
    "expert":     { "provider": "provider-demo", "modelName": "model-demo", "effort": "max" }
  }
}
```

- 键是三个角色名（闭集）；值直接是 `ModelRef`（不含嵌套元数据；溯源在 journal）。
- `tw roles` 是唯一写入口（`tw agent-map` 仍只管 `mappings`，`cli.mjs:1433` 继续拒绝 `--model-hint`）。
- **不新增** `modelBaseline/taskOverrides/dispatchTargets/intake` 等字段（用户第 5 轮明确砍掉）：确认状态由 decisions 判断（§3.4.5），派发台账复用 journal（§3.8）。
- 并发：`roles` 读改写全部在 `task.lock` 内（`atomicJson`），与 journal 同锁域。
- 损坏降级：`roles` 读不出 → `ROLES_CORRUPT`（`tw roles --resolve` 重建）；`mappings` 损坏维持现有降级（`cli.mjs:1546-1550`、`cli.mjs:1446-1455`）。

**`tw roles` 接口（草案）**：
- `tw roles --task <n>`：只读 `roles`（三个角色 + effort 状态 + 档位溯源 + profile），缺档/unresolved 清单。
- `tw roles --task <n> --set owner=<provider>/<modelName>[@<effort>]`（可多次）：写 `ModelRef`；`@` 后省略 effort 即不设置。
- `tw roles --task <n> --set owner=tier:senior`：档位语法糖，立即解析成 `ModelRef` 再落盘（落盘后无裸 tier）。
- `tw roles --task <n> --clear owner`：清除该角色（下次 `--resolve` 重建）。
- `tw roles --task <n> --resolve`：按当前快照重解析（显式更新入口），返回新旧差异。
- 写操作若检测到将复用旧会话的续派风险 → 返回 `requiresFreshSession` 卡（§3.6）。

### 3.3 包级表示与删除升档审批

**3.3.1 包级持久化**

`packages.json` 每包直接存模型实例：

```json
[
  { "id": "pkg-a", "model": { "provider": "provider-demo", "modelName": "model-demo", "effort": "high" },
    "writable": ["docs/a.md:doc"], "done": ["…"], "dependsOn": [] },
  { "id": "pkg-b", "model": { "provider": "provider-demo", "modelName": "model-demo" },
    "writable": ["docs/b.md:doc"], "done": ["…"], "dependsOn": [] }
]
```

- `tw plan --packages` 入参三种写法：`{id, model:{provider,modelName,effort?}}`、`{id, tier:"senior"}`、或不给模型。**落盘前一律解析成 `model:ModelRef`**：
  - 显式 `model` → 直接采用；
  - `tier` → 按该档从本次快照解析；
  - 都不给 → 直接复用 `agents.roles.owner`（同一任务 owner 默认模型，一次计划内确定性）；若 `roles.owner` 缺失 → `PLAN_MODEL_UNRESOLVED`。
- 缺档/候选池空/无 roles.owner → `PLAN_MODEL_UNRESOLVED`（带配置修复指引），**不落半成品包**；结构/互斥/成环错误仍用 `PLAN_REJECTED`（两码分工：语法与结构 vs 模型解析）。
- 旧 `packages.json` 只有 `tier` → 读取视为待物化，首次 `tw plan` 或首次推进时按上述规则解析并写回，journal 记 `packages-model-materialized`（§7.1）。
- 包级优先于角色级：派发读 `pkg.model ?? roles[role]`（§3.8）。

**3.3.2 删除升档审批（用户拍板，含完整清单）**

删除对象：
- `cli.mjs:399-405` `escalationFingerprint`；
- `cli.mjs:853-898` 审批分支（签发 `escalation-*` 卡、`approve-escalation`/`降回默认档继续` 选项、批次指纹）；
- `cli.mjs:1001-1006` `re-sign-escalation` 分支与指纹校验；
- `cli.mjs:1057-1059`、`1067` `cmdDecide` 升档校验与落盘字段；
- `cli.mjs:878` 权重倍数文案；
- `cli.mjs:1597` `dispatch-plan` 的 `re-sign-escalation` 分支；
- `cli.mjs:647-650` `runStatusCard` 的 `pending.escalationFingerprint` 残引用（用户第 5 轮点名）；
- 测试：`tests/runtime-v3-cli.test.mjs:537/569/592/628`、`tests/runtime-v3-topology.test.mjs:548/616`；
- 文档/文案：`dsh-orchestration.md:49`、`SKILL.md:23`、`topology-and-cost.md:11/26`、`README.md` 相关句、`team-work/rules` 提及升档卡的句子（§1.2 #34/#37）。

替代把关（不新增机制）：① 用户在 `tw roles`/`tw plan` 显式指定即授权；② 初期确认卡统一展示"角色 + 逐包 `ModelRef` + 与默认档对比标记"；③ `costWeights` 仅作展示（§11-5）。

**3.3.3 旧未决升档卡收口（必须与删除同批）**

- 现状：历史任务 journal 可能有未决 `decision-issued`（`detail.escalationFingerprint` 或 `choices` 含 `approve-escalation`/`降回默认档继续`）。删除审批后，这些卡会落入"已签发未失效"渲染分支，答了也不产生派发语义 → 任务永久静止。
- 处置：dispatch 通道（或 `tw migrate`）在推进前扫描未决卡，命中上述特征 → 追加 `decided` 事件（`choice:"superseded"`, reason:`"升档审批机制已删除"`），随后正常重推导。只增不改，审计保留；幂等（已收口的卡不再有未决事件）。
- 验收：遗留任务带未决 escalation 卡时，推进一次即恢复；decide 答旧卡返回 `DECISION_STALE` 或直接重签。

### 3.4 意图确认门（复用 decisions/journal，不新增存储）

#### 3.4.1 流程

```text
tw open（intent + roles 落盘 + 签发 intake-approval 卡）
   ↓ awaiting-user
[可选] tw plan（包级 model 固化 → 指纹变化 → 旧卡 superseded → 自动重签）
   ↓ tw decide --choice 1（确认开始）
首次 dispatch：校验确认指纹与当前稳定投影一致，通过后按 roles/packages 派发
```

**卡面（字段级）**：
```text
# 任务意图确认（intake-approval）
## 你的原始需求（不摘要、不删改）
<rawRequirement 全文>
## 目标 / 约束 / 排除
<objective>；约束逐条（标注：用户原话 / 推断假设）；排除逐条
## 范围与产出
入口阶段 / 完成条件 / 预期产出物
## 角色模型（3 行，恒定显示）
| 角色 | provider | modelName | 推理强度 | 档位溯源 |
| owner | provider-demo | model-demo | high | design.ownerTier=senior |
| challenger | provider-demo | model-demo | 省略（不设置） | design.challengerTier=senior |
| expert | provider-demo | model-demo | max | roles.expert |
## 已拆包的实际模型（未拆包时提示“拆包后本卡会重签并列出逐包模型”）
| 包 | provider | modelName | 推理强度 | 与 roles.owner |
| pkg-b | provider-demo | model-demo | high | 等于 |
## 仍未明确的问题（gap）
1. <问题> —— 影响：…；若确认开始将按“<默认假设>”执行
## 选项
1 确认开始；2 我先修改（tw intent / tw roles / tw plan 后重出卡）；3 终止任务
（roles 有 unresolved：不提供选项 1）
```

#### 3.4.2 为什么用决定卡

复用 `decision-issued` + `decisions` 的"未决即静止 + 指纹失效重签 + 只增不改"机制（`derive.mjs:78-104`、`cli.mjs:1030-1095`），不新增 workflow 阶段（避免改阶段图/边/entry 语义），也不新增任务目录文件。

#### 3.4.3 签发时机（owner 决定：open 当场，plan 后重签）

理由：① 用户原话"intent.json 生成时"就是 open；② gap 与模型最早对齐；③ 不新增状态。代价：拆包会触发一次重签（两次确认）。缓解：卡面提示"若计划拆包，先 `tw plan` 再确认"；重签只列差异。备选（首次 dispatch 拦截）不采纳：open 后无卡、与用户原话不符。

需同时处理：`tw plan` 当前在 awaiting-user 时禁止重拆（`cli.mjs:1413`）→ 把 intake 未决卡加入放行白名单（与 `produceBlocked` 同类）；`tw-dispatch` 对 awaiting-user 的透传保持（`dsh/tw-dispatch.js:412`），工具描述补"新任务首步会先出意图确认卡"。

#### 3.4.4 确认指纹（稳定配置投影，消除自包含）

```text
intakeFingerprint = digestValue({
  intent: { objective, constraints, exclusions, rawRequirement, scope, acceptance, gaps, risk },
  roles: { owner: ModelRef, challenger: ModelRef, expert: ModelRef },
  packages: [ { id, model: ModelRef, writable, done, dependsOn } ]   // 无包时为空数组
})
```

- **只取稳定配置**：不含指纹自身、`decisionId`、时间戳、`profile`、`policyDigest` 等运行元数据——上一版把含 `fingerprint` 字段的对象纳入计算，造成"指纹包含自身"的自包含 bug，本版从公式上消除。
- `ModelRef` 参与计算时用规范化形式（键序稳定、`effort` 缺省不补空值）。
- 失效判定：`runTransition` pending 分支与 `cmdDecide` 比对当前指纹，不一致 → `decided:superseded` → 重签。
- 触发源：`tw intent` 改目标/约束/排除/risk、`tw roles` 改值、`tw plan` 改包/包模型。

#### 3.4.5 确认状态与 decide（不新增存储）

- **确认状态 = decisions 中最新 `gateId:"intake-approval"` 的 accept 记录的 `intakeFingerprint` 是否等于当前稳定投影**。不写 agents.json.intake（用户第 5 轮砍掉）。
- 派发前校验：无匹配确认 → 返回 `INTAKE_UNCONFIRMED` 卡（不写 dispatched）。
- `decide --choice 1`：写 `decisions`（`gateId`, `choice`, `intakeFingerprint`, `modelRefs` 快照、`at`）；后续放行。
- `--choice 2`：不落盘决定，返回修改指引。
- `--choice 3`：写 `task-completed {form:"partial"}`（与现有路径一致，`cli.mjs:1081`）。
- **roles 有 unresolved 时不提供选项 1**（`INTAKE_BASELINE_UNRESOLVED`）：确认语义是"模型符合预期"，不能假确认；修复配置后 `tw roles --resolve` 重签。
- 旧任务：无 intake 卡 → 不补卡、不静止；首次推进按 §7.1 初始化 `roles`（取历史实际 `modelRef`，无历史才按 policy 解析）。

#### 3.4.6 恢复与并发

- 签发失败（journal 写失败）→ 事务回滚，不留半态；卡已签发但 agents.json 写失败 → 以 journal 为准，`tw roles --resolve` 补齐。
- 全部写操作在 `task.lock` 内；重复 `tw-dispatch` 返回同一张未失效卡（幂等）。

### 3.5 意图不明确时的 gap 对齐

`intent.json` 增 `rawRequirement/scope/acceptance/gaps`（只增字段，旧文件缺字段按空）：
```json
{ "rawRequirement": "用户原始需求全文", "objective": "…", "constraints": ["…"], "exclusions": ["…"],
  "scope": { "entry": "design", "outputs": ["design"] }, "acceptance": ["…"],
  "gaps": [ { "id": "g1", "question": "…", "whyItMatters": "…", "proposedDefault": "…", "answer": null } ],
  "risk": "normal", "revisions": [] }
```
- Lead 在 `tw open` 前按 §3.7 模版整理；无法从需求确定的事项写 `gaps`，不把猜测填进 objective/constraints。
- 确认卡逐条呈现 gap 与默认假设；`tw decide --note` 记录答复；结构化答复用 `tw intent --answer-gap g1 --answer "…"`。
- 未答复 gap 的处理（§11-2 内部定稿）：允许确认开始，但卡上必须列出未答复 gap 与默认假设。

### 3.6 已有会话换模型（保留旧会话 / 重开会话）

**前置事实**：DSH 绑定只能按精确 target 创建新会话（`dsh/subagent-session.js:107-118`）；续派复用原会话（`cli.mjs:290-303`、`dsh/tw-dispatch.js:219-264`），不能热替换模型。

```text
dispatch 取 currentRef（pkg.model ?? roles[role]）
  └─ 找续派会话：continuationPrevKey 应用 session-reset seq 边界（边界前映射忽略）
      ├─ 无前驱映射 → fresh：用 currentRef 创建并登记
      └─ 有前驱 sessionId →
           1) 有 keep-session 绑定 → 按 keptModelRef 续派，不再出卡
           2) currentRef 与 journal 首派 modelRef 深度相等 → 直接续派
           3) 不等 → requiresFreshSession 决定卡
```

**卡面**：`1 保留原会话（按 keptModelRef 继续，之后不再重复出卡）` / `2 作废当前波、写 session-reset、重开会话用新模型（全新上下文）` / `3 回滚 roles 到旧值`。

- 选项 1：写 `decisions` `{grant:"keep-session", sessionId, role, keptModelRef, rolesDigest, at}`；该 sessionId 后续一律按 `keptModelRef`，直到换新会话或回滚。
- 选项 2：写 journal `session-reset`（`{role, package|null, scene, reason, decisionId?, fromModelRef, toModelRef}`）+ 按需 `tw retire`；续派回溯以最近一次同 role+package 的 reset seq 为边界，边界前映射一律忽略（`cli.mjs:290-303` 改造），保证 fresh 不被更早已结波映射拉回。
- 选项 3：`tw roles` 回滚并重签确认卡。
- 恢复：绑定损坏/会话已换 → 视为无绑定重判；reset 后崩溃 → 按边界重算、fresh 创建、先登记后创建幂等；多包部分 reset 按包分别计算边界。

**历史快照**：journal `role-models-changed`（roles 变更）、`session-reset`、`dispatched.detail.modelRef` 三个事实只增不改；`tw roles` 展示最近变更与当前值。

### 3.7 意图与任务卡生成指引（模版化）

#### 3.7.1 生成流程（文字规则，不是新代码）
1. 保留原始需求全文（`rawRequirement`）；摘要只写 `objective`，不替换原文。
2. 逐项核对：目标/约束/排除/范围/验收/依赖，每项能指回原文或明确标为假设；对不上写 `gaps`。
3. 事实与建议分离：不把建议写成目标。
4. 先核对再派发：确认卡未接受前不派发正式波次。
5. 模版化卡面：固定段序（原始需求 → 目标 → 约束/排除 → 范围/产出 → 角色模型 3 行 → 逐包模型 → gap → 选项）。
6. 容错：必填 `--objective` 已有拒绝（`cli.mjs:530`）；新增字段缺失不拒绝，卡面标"未提供"。

#### 3.7.2 与派单卡的关系
派单卡已模版化（`cli.mjs:421-505` 固定段序）。本轮增强两处：卡头补"模型：provider/modelName（effort 或 省略）· 来源"；"本轮验收基线"增加 `intent.scope/acceptance` 可选段。

#### 3.7.3 关于 OpenViking 经验（方法参考，不进产品）
§3.7.1 的"建档保留原文、逐项核对并在派发前确认、静态规则与运行时拼接都要核查、事实不混进建议"参考了用户知识库中的两条历史经验；**不新增任何 OpenViking 依赖、检索接口、配置或流程节点**（与 §2.2-1 一致）。

### 3.8 派发链路：直接读 roles/packages，不解析配置

**派发单元**：一个 `dispatch`（owner 波按包各一个 key；challenger/expert 波一个 key）。

```text
for each dispatch d (role, package, scene):
  1. owner 波有包：packages[d.package].model
  2. owner 波无包：agents.roles.owner
  3. challenger/expert 波：agents.roles[role]
  4. 缺失/损坏 → ROLES_UNRESOLVED / PACKAGE_MODEL_UNRESOLVED（不现场解析、不猜）
  5. 产出 dispatch.modelRef + modelSource（"package" / "roles"）
```

**来源链（同一派单重复消费）**：① journal 已有该 key 的 `dispatched.detail.modelRef`（在途重建/重入）→ 用快照；② 否则按上面规则从文件取；③ 先写 journal（`modelRef` + `source`）再派生视图，崩溃窗口只产生"有 journal 无视图"，下次按 ① 回填，幂等。

**与历史字段兼容**：旧 journal `modelHint{provider,model,source,family,selectedBy,effort}` 读取时映射为 `modelRef{provider,modelName,effort,family}`，不重写历史行；新派发一律写 `modelRef`。

**配置热变**：`roles`/`packages` 只在 open/plan/`tw roles` 显式动作时更新；profile tiers 热变不自动改（要改用 `tw roles --resolve`，重签确认卡）。`tw models` 语义不变（当前快照解析，供初始化与排障）。

## 4 全量修改点（文件级）

| 文件 | 修改内容 | 类型 |
| --- | --- | --- |
| `team-work/policies/default.json` | 增 `roles` 兜底档（owner/challenger/expert）；`automaticLimits` 保留不接线（§11-3） | 数据 |
| `runtime-v3/cli.mjs` | open 初始化 `agents.roles` + journal `roles-initialized`；`tw roles`（只读/--set/--clear/--resolve）；`tw plan` 包级 `model` 物化与 `tier` 语法糖；派发读 `pkg.model ?? roles[role]`（零解析）；intake 卡签发/渲染/稳定指纹；`decide` intake 校验；换模型卡与 `session-reset`（`continuationPrevKey` 加 seq 边界）；`dispatchCard` 卡头；help；**删除升档审批全套 + 旧卡收口 + `cli.mjs:647-650` 残引用** | 接线+新增+清理 |
| `runtime-v3/derive.mjs` | 透传 intake / requiresFreshSession 卡类型字段，不改推进逻辑 | 接线 |
| `runtime-v3/gate.mjs` | 沿用 `humanDecisionFresh`；intake 用独立稳定指纹纯函数 | 接线 |
| `runtime-v3/store.mjs` | `initTask` 只扩 intent 初始字段（不新增文件，见 §7.3 骨架断言） | 接线 |
| `runtime-v3/waves.mjs` | `scenePolicy` 增读 `policy.roles` 兜底 | 接线 |
| `runtime-v3/dsh-map.mjs` | 候选规范化复用为 `ModelRef` 校验；`computeModelHint` 只服务 roles 初始化，不再在派发期调用 | 接线 |
| `dsh/subagent-session.js` | 新增 `toHostTarget(ref)` 唯一映射（`modelName→model`、`effort→reasoningEffort`，缺 effort 不传）；`createDirectedSubagent` 收 `modelRef`；保留创建前一致性校验 | 接线 |
| `dsh/tw-dispatch.js` | 工具描述补确认卡/换模型；透传新卡类型；创建用 `toHostTarget` | 接线 |
| `dsh/settings.js` | 删成本价值判据；`decisionTableText` 增 `tw roles` 与确认卡说明；`systemPromptSection` 保留候选展示 | 数据 |
| `dsh/client/badge.js` | 配置页与 @ 候选说明文字去价值判据；补"正式派发以任务级 roles 为准" | 数据 |
| `skills/.../SKILL.md`、`references/*.md` | 删定档判据与升档卡描述；补 `tw roles`/确认卡操作；改热变句（§1.2 #27-36） | 数据 |
| `team-work/rules/lead/*` | 决定点规则补 intake/换模型卡（该目录有用户未提交改动，先合并） | 数据 |
| `README.md` | 成本机制描述改"默认档来自 policy、模型存 roles" | 数据 |
| `docs/team-topology-recovery-plan.md`、`docs/file-inventory.json` | 修正 agents.json 旧描述；清单同步 | 数据 |
| `policy/kernel.mjs` | 删除 `COST_WEIGHTS/costWeightForTier`（§11-4） | 清理 |
| `tests/support/v3-fixtures.mjs` | 增 `confirmIntake`/roles helper；`makePolicy` 增 `roles` 与 ModelRef 样例 | 测试 |
| 11 个测试文件 + 升档测试 | 新任务创建补确认步骤（§7.3）；删除/改写升档测试（`cli:537/569/592/628`、`topology:548/616`）；新增"不再出现升档卡"与"旧 pending 卡收口"断言 | 测试 |

## 5 接口契约（草案）

### 5.1 CLI 命令

```text
tw open --name <n> --objective <o> [--entry <stage>] [--risk normal|high|critical]
        [--raw-requirement <原文>] [--constraint <文本>]... [--exclusion <文本>]...
        [--scope-note <文本>]... [--acceptance <文本>]... [--gap '<JSON>']...
tw roles --task <n>                                   # 只读
tw roles --task <n> --set <role>=<provider>/<modelName>[@<effort>]   # effort 省略=不设置
tw roles --task <n> --set <role>=tier:<junior|senior|expert>[@<effort>]
tw roles --task <n> --clear <role>
tw roles --task <n> --resolve                         # 按当前快照重解析（重签确认卡）
tw plan --task <n> --packages '<JSON>'                # {id, model?} | {id, tier?} | {id}
tw intent --task <n> [--answer-gap <id> --answer <文本>] [--add-gap '<JSON>'] ...
```

### 5.2 数据形状

**ModelRef**：`{ provider, modelName, effort?, family? }`；`effort` 缺省=不设置（禁止 `""`/`"none"`）。

**agents.json**：
```json
{ "mappings": { "d1-ab12cd": "childId" },
  "roles": {
    "owner":      { "provider": "provider-demo", "modelName": "model-demo", "effort": "high" },
    "challenger": { "provider": "provider-demo", "modelName": "model-demo" },
    "expert":     { "provider": "provider-demo", "modelName": "model-demo", "effort": "max" }
  } }
```

**packages.json**：
```json
[ { "id": "pkg-a",
    "model": { "provider": "provider-demo", "modelName": "model-demo", "effort": "high" },
    "writable": ["docs/a.md:doc"], "done": ["…"], "dependsOn": [] } ]
```

**intent.json（只增字段）**：`rawRequirement/scope/acceptance/gaps`（缺省空）。

### 5.3 卡片字段

| 卡 | 字段 |
| --- | --- |
| intake 确认卡 | `gateId:"intake-approval"`、`decisionId`、`question`、`choices`、`intake:{rawRequirement,objective,constraints[],exclusions[],scope,acceptance[],gaps[],roles:[{role,modelRef,effortState,tierProvenance}],packages:[{id,modelRef,vsRolesOwner}]}`、`intakeFingerprint` |
| requiresFreshSession 卡 | `role`、`waveId`、`sessionId`、`fromModelRef`（journal 首派）、`toModelRef`（当前）、`choices:[keep-session, retire-and-recreate, rollback]`、`freshSessionFingerprint` |
| keep-session 记录 | `{grant:"keep-session", sessionId, role, keptModelRef, rolesDigest, at}`（写 decisions） |
| session-reset 事实 | `{type:"session-reset", at, detail:{role, package|null, scene, reason, decisionId?, fromModelRef, toModelRef}}`（journal 只增） |
| `tw roles` 输出 | `task`、`profile`、`roles:{owner,challenger,expert}`、`effortState`、`tierProvenance`、`unresolved[]`、`warnings[]` |
| `dispatch-plan` waves | `modelRef`（替代 `modelHint`）、`modelSource`（package/roles）、`modelStaleForSession`（布尔）；`weight` 保留展示 |

### 5.4 错误码与恢复边

| 码 | 触发 | 恢复 |
| --- | --- | --- |
| `INTAKE_UNCONFIRMED` | 无匹配确认即推进 | 返回确认卡（不写 dispatched） |
| `INTAKE_FINGERPRINT_STALE` | 卡签发后配置变化 | 作废旧卡并重签 |
| `INTAKE_BASELINE_UNRESOLVED` | roles 有 unresolved 时试图确认 | 不给确认选项；修复配置后 `tw roles --resolve` |
| `ROLES_CORRUPT` / `ROLES_UNRESOLVED` | roles 不可读/缺角色 | `tw roles --resolve` 重建；派发不猜 |
| `PACKAGE_MODEL_UNRESOLVED` | 包无 model 且 roles.owner 缺失 | 重 plan 或 `tw roles --set` |
| `MODEL_REF_INVALID` | ModelRef 缺字段/未知字段/effort 为 "" 或 "none" | 按 §3.0 校验提示 |
| `REQUIRES_FRESH_SESSION` | 续派遇模型变更 | 返回换模型确认卡 |
| `PLAN_MODEL_UNRESOLVED` | 包级模型/档位解析失败 | 计划期拒绝并给配置指引 |
| `PLAN_REJECTED` | 结构/互斥/成环/缺完成标准 | 修正 --packages 后重试 |

## 6 实施顺序（4 批）

**批 A：ModelRef 与 roles（地基）**
1. `ModelRef` 校验（含 effort 规则）、`default.json` 增 `roles`；
2. open 初始化 `agents.roles` + journal `roles-initialized`（含 effortState）；`tw roles` 只读/--set/--clear/--resolve；
3. `tw plan` 包级 `model` 物化（显式/ tier 语法糖 / 复用 roles.owner）+ 旧 tier 迁移；
4. 派发零解析：`pkg.model ?? roles[role]`，导出 `modelRef/modelSource`；journal 写 `modelRef`；
5. 绑定层 `toHostTarget`（缺 effort 不传）。
验收：新任务 roles 三角色齐备（含 effort 省略状态）；多包不同模型 target 正确；旧任务迁移不换模型；缺档 unresolved 且确认不可用。

**批 B：确认门与意图**
6. open 扩展参数、intent 字段、intake 卡签发/渲染（角色 3 行 + 逐包）；
7. 稳定指纹（`{intent, roles, packages}`）、plan 放行与重签、decide 校验、`tw gate` 只读 intake 提示；
8. gap 结构化与答复；unresolved 不可确认。
验收：open 出卡；plan 后旧卡失效重签并逐包展示；改 intent/roles 重签；确认后首波派发；未确认不可派发。

**批 C：换模型确认**
9. `requiresFreshSession` 卡（ModelRef 深度比较）、三选项落盘与执行；
10. `session-reset` 写入与 `continuationPrevKey` seq 边界；`role-models-changed` 事件与 `tw roles` 历史。
验收：改 roles 后续派出卡；选 1 不再重复出卡；选 2 更早已结波映射不再命中、fresh 新模型；多包部分 reset；崩溃重试幂等。

**批 D：删除升档审批、文本收敛与测试**
11. 删除 §3.3.2 全部代码/文案/测试；旧 pending escalation 卡收口；`cli.mjs:647-650` 残引用清理；
12. skill/规则/系统提示/README 判据删除与操作补充；kernel 死常量清理；`costWeights` 改纯展示；
13. 测试改造与新增用例、docs 同步。

**依赖**：B 依赖 A 的 roles/plan 物化；C 依赖 A 的 roles 更新与 B 的卡机制；D 的收口可在 A 后独立做，但全量测试须在 A-D 完成后跑。

## 7 兼容与迁移

### 7.1 数据兼容
- `agents.json`：只增 `roles`，`mappings` 不变；旧文件无 roles → 首次 `tw roles --resolve` 或首次推进初始化（不静止）。
- `packages.json`：持久化 `model:ModelRef`；旧 `tier` 包在首次 plan/推进物化（解析用当次快照；失败 `PLAN_MODEL_UNRESOLVED`/unresolved，不猜），记 `packages-model-materialized`。
- `journal`：只增事件类型（`roles-initialized`、`role-models-changed`、`packages-model-materialized`、`session-reset`）；历史 `modelHint` 读取时映射为 `modelRef`，不重写历史行。
- `decisions`：历史 `approve-escalation`/`降回默认档继续` 读取忽略、不清除；历史未决 `escalation-*` 卡按 §3.3.3 收口。
- 迁移"不换模型"：旧任务 roles 优先取该角色最近一次**实际派发**的 `modelRef`（journal 回读），无历史才按 policy 解析。

### 7.2 行为变化（需用户知情）
1. 新任务首步多一次确认；拆包会触发一次重签。
2. 配置热变不再自动换模型，需 `tw roles --resolve`。
3. 续派遇模型变更出卡；选"保留"后按旧模型固化，不再重复出卡。
4. 选"重开会话"写 `session-reset`：此后不再续派更早会话（上下文不延续）。
5. 升档审批删除：不再有派发前审批中断；成本调整走确认卡与显式命令。
6. 包级持久化从 `tier` 改为 `ModelRef`；roles 跨阶段不随场景默认切换（§3.1 取舍）。

### 7.3 测试影响面（已核实的 11 个文件）
直接经 `tw open` 或 `openTask` 创建任务：`runtime-v3-cli.test.mjs`、`runtime-v3-invariants.test.mjs`、`runtime-v3-rules.test.mjs`、`runtime-v3-rules-lazy.test.mjs`、`runtime-v3-topology.test.mjs`、`runtime-v3-waves-regression.test.mjs`、`runtime-v3-dsh.test.mjs`、`runtime-v3-concurrency.test.mjs`、`dsh-dispatch.test.mjs`、`e2e-b-matrix.test.mjs`、`tag-hints-runtime.test.mjs`。

- 统一改造：`tests/support/v3-fixtures.mjs` 增 `openTaskWithIntake`（open → decide 1）与 `openTaskRaw`；现有 `openTask` 内部补确认步骤。
- `runtime-v3-intake.test.mjs:34-44` 断言 initTask 后目录只有 7 项 → **agents.json 写入必须留在 cmdOpen 层，不得进 initTask**；intent 初始字段只改内容不新增文件。
- `runtime-v3-dsh.test.mjs:203`（热变后波换模型）是行为反转的显式例外，随 §3.8 改写。
- 升档测试删除/改写：`runtime-v3-cli.test.mjs:537/569/592/628`、`runtime-v3-topology.test.mjs:548/616`；新增"旧 pending 卡被 superseded 后任务恢复"。

### 7.4 文档与清单
`docs/file-inventory.json` 增本方案；`docs/team-topology-recovery-plan.md:5` 修正；README 与 skill 同步。

### 7.5 文本生效路径（已核实）
- skill：插件读包内 `skills/`（`dsh/skill-embed.js:27-45`）；若用户经 `tw init` 复制到 `.dsh/skills/`，需 `tw init --force` 同步。
- 规则：用户公共目录同名文件优先（`rules.mjs:5/108/201-225`），包内改默认可能不生效；须同步公共目录，否则 §9.3 断言在真实机器不成立。
- 系统提示/工具描述：插件自带，随插件更新生效；README/docs 随提交生效。

## 8 失败与恢复

| 场景 | 检测 | 恢复 |
| --- | --- | --- |
| tiers 缺档/损坏（roles 初始化期） | `resolveTiers` unresolved（`dsh-map.mjs:76-113`） | open 不阻塞：roles 标 unresolved、确认卡不可确认；修复后 `tw roles --resolve` |
| roles 缺失/损坏 | `ROLES_CORRUPT`/`ROLES_UNRESOLVED` | 派发不猜；`tw roles --resolve` 重建（旧任务按 §7.1 迁移） |
| packages.json 与 roles 不一致 | plan 后逐包比对：包未显式给 model 时应等于 roles.owner | 以 packages.json 为准重算/重 plan，并重签确认卡 |
| 旧 `tier` 物化失败 | 快照缺档/候选池空 | `PLAN_MODEL_UNRESOLVED`；不落半物化包，修复后重试 |
| intake 卡签发后配置变化 | 指纹比对失败 | 作废重签（`decided:superseded`），旧选项不可直答 |
| 确认卡期间要拆包 | `tw plan` 被 awaiting-user 挡住 | intake 卡放行白名单；plan 后重签 |
| 历史未决 escalation 卡 | 扫描 `decision-issued` 含 `escalationFingerprint`/升档 choices | 追加 `decided:superseded`，任务恢复推进（幂等） |
| retire 后新派发前崩溃 | journal 有 `dispatch-superseded` | 重试 dispatch：旧波不在途，新 key 正常创建 |
| 换模型卡未作答 | `requiresFreshSession` 在场 | 派发停止；重复 dispatch 返回同一卡 |
| keep-session 绑定损坏/会话已换 | decisions 不可读或 sessionId 不在 mappings | 视为无绑定重判（可能多问一次，不误用新模型） |
| `session-reset` 后崩溃 | journal 有 reset、边界后无映射 | 下次 dispatch 按边界重算 → fresh 并附 resumeNote；先登记后创建，幂等 |
| 并发写 agents.json | task.lock 竞争 | `LOCK_UNAVAILABLE`（`cli.mjs:85`）原样重试 |
| 卡面与账本不一致 | 渲染同钉 `pending.reason/choices` | 沿用现有纪律（`cli.mjs:981-984`） |

## 9 验收测试

### 9.1 单元
1. `ModelRef` 校验：缺 provider/modelName 拒绝；未知字段拒绝；`effort` 为 `""` 或 `"none"` 拒绝；缺省不补空。
2. `toHostTarget`：输出 `{provider,model,reasoningEffort?}`；缺 effort 时不含该键；`resolveCallConfig` 回读一致。
3. roles 初始化：场景档 + roles 兜底 + risk（只升 owner）；缺档 unresolved；expert 不硬编码（`roles.expert` 缺失即 unresolved）。
4. 派发零解析：注入 spy 断言不调用 `resolveTiers`；取值 `pkg.model ?? roles[role]`；缺失返回可恢复码。
5. plan 物化：显式 model / tier 语法糖 / 复用 roles.owner 三种来源；`tier+model` 冲突拒绝；旧 tier 物化且不换模型。
6. 确认指纹：只随 `{intent, roles, packages}` 变化；指纹自身/时间戳/decisionId 变化不影响；同内容幂等。
7. 确认状态：decisions 中 accept 指纹匹配才放行；`unresolved` 不可确认。
8. `tw plan` 在 intake 卡期间可重拆；其他 awaiting-user 仍拒绝（回归 `topology.test:189`）。
9. `requiresFreshSession`：continuation + 模型变更 → 卡；选 1 后不再重复出卡；选 2 后旧映射不命中。
10. 删除升档审批反向断言：包模型高于默认档不再出 `escalation-*` 卡、无 `escalationFingerprint` 校验、decide 不接受 `approve-escalation`、dispatch-plan 无 `re-sign-escalation`。
11. 旧 pending escalation 卡收口：带未决卡的任务推进后卡被 superseded、任务继续；重复推进幂等。
12. 迁移不换模型：旧任务 roles 取历史实际 `modelRef`（对照 `waves-regression` 等价性）。

### 9.2 集成
13. 新任务全链路：open → 确认卡 → decide 1 → dispatch 首波 → deliver → review → 门 → 下一阶段（确认卡不再出现）。
14. 改 intent / 改 roles / 重拆 → 旧卡失效重签 → 再确认 → 派发。
15. 包级 ModelRef：两包不同模型 → plan 落盘与 dispatch 导出一致；同 wave 多包未显式指定时统一复用 roles.owner。
16. 换模型：`tw roles --set` → dispatch 出卡 → 选 2 → reset + retire → 新 key 用新模型 fresh。

### 9.3 文本与反向断言
17. skill/规则/README 无"默认 junior""按失败成本升档"等判据句，也无"配置热变只影响后波"类旧热变句式。
18. 全仓无"升档审批""权重倍数 junior:senior:expert""approve-escalation"用户可见文案。
19. kernel 死常量清理后全仓无 `COST_WEIGHTS`/`costWeightForTier` 引用。

### 9.4 手工/真实宿主
20. 真实 DSH：open 出确认卡（3 角色 + 逐包）、decide、tw-dispatch 经 `toHostTarget` 创建成员、成员卡含 `modelRef` 行；`@` 候选仍可用；`effort` 省略时宿主创建成功（不传空串）。
21. 配置热变：改 profile tiers → 已有任务沿用 roles（`modelSource:"roles"` 可证）；`tw roles --resolve` 后新波变化并重签。
22. 旧任务：带未决升档卡的历史任务推进一次即恢复；旧 `tier` 包物化不换模型。

### 9.5 回归
23. 全量 `node --test`；`docs/file-inventory.json` 一致性；`tw help` 命令面。

## 10 风险

1. **确认门成本**：新任务多一次确认、拆包多一次重签；缓解：卡面提示先 plan 再确认、重签只列差异。
2. **tests 面大**：11 个测试文件 + 升档测试删除；统一 fixture 改造，避免语义漂移。
3. **roles 跨阶段统一**：简化后同一角色跨阶段同模型，可能对"设计阶段需要更强 owner"的任务偏弱；缓解：`tw roles --set` 显式调整（重签确认卡），并在 skill 中说明。
4. **基线不热变与用户预期**：忘 `--resolve` 会继续用旧模型；`tw roles` 与卡面展示 `source`/解析时间。
5. **双源**：`roles/packages`（配置事实）与 `journal modelRef`（派发事实）职责已定"派发前看文件、派发后以 journal 为准"；须用断言锁住。
6. **ModelRef 映射单点**：绕过 `toHostTarget` 直拼宿主字段会静默用错模型；`createDirectedSubagent` 只收 `modelRef` + 单测锁映射。
7. **删除审批后的成本把关**：只剩确认卡；缓解：卡面逐项标"与默认档 高于/等于/低于"。
8. **旧 pending 卡收口的兼容面**：收口写 `decided:superseded` 是只增事实；需覆盖"部分已答/全部未决/重复推进"三类用例。
9. **用户既有工作区改动**：`team-work/rules/lead/*` 与两个测试文件已被修改，实施前确认合并。
10. **session-reset 回归面**：`continuationPrevKey` 同时服务 dispatch 导出、在途重建、断链恢复；需补 reset 后崩溃、多包部分 reset、登记完成再续派用例。

## 11 内部定稿（原待裁决项，用户第 5 轮授权团队消化）

以下结论基于现有事实与最小复杂度原则，不再逐项提报；仅当出现新的实质授权冲突时才升级给用户。

1. **任务级覆盖范围**：`roles` 三档均可覆盖（含 challenger/expert），因为用户要求"各个角色的派发档位"可指定；risk 只对 owner 在初始化时生效，且不覆盖用户显式 `tw roles` 值（显式优先）。expert 降档不设额外确认——它由确认卡展示"与默认档 低于"标记，用户确认即知情（不新增审批机制）。
2. **gap 未答复**：允许确认开始，但卡上必须列出未答复 gap 与"将按默认假设执行"；答复记录在 `gaps[].answer` 或 decide note。理由：把信息不足变成死门会阻塞任务，最小复杂度是"透明假设 + 可追溯"。
3. **policy 未消费字段**：`concurrencySoftLimit`/`selection.diversityWithinTier` **本轮不接线**，删除 skill 中文档承诺（`topology-and-cost.md:43` 等）；`automaticLimits` 保留在 default.json 但不接线（Phase 2 已否决）。理由：接线属于新增治理能力，超出本次授权；文档不得承诺未实现行为。
4. **kernel 死常量**：清理 `COST_WEIGHTS/costWeightForTier`（无消费者，与 default.json 重复），并用文本断言防回流。
5. **costWeights 去留**：保留，仅作 `dispatch-plan` 的 `weight` 展示/审计，不参与任何判定；卡面权重文案随升档审批删除。

**无待用户裁决项**：包级表示、effort 语义、确认时机、升档审批、基线结构等均已由用户拍板或本方案定稿；实施前如出现无法消解的授权冲突，再按"范围争议暂停"流程提报。

## 12 调研依据（可复核）

- 档位解析与派发：`runtime-v3/cli.mjs:377-394`、`440-527`、`699-708`、`728-731`、`747-761`、`805-911`、`1500-1605`。
- 档位→模型：`runtime-v3/dsh-map.mjs:4`、`17-43`、`76-133`。
- 场景策略：`runtime-v3/waves.mjs:11-24`。
- 人工门与指纹：`runtime-v3/gate.mjs:12-85`、`173-204`；`runtime-v3/derive.mjs:70-104`。
- 意图与任务目录：`runtime-v3/store.mjs:54-123`；`cli.mjs:529-540`、`1270-1294`。
- agents.json 写入点：`cli.mjs:1426-1466`、`1133-1148`；`dsh/tw-dispatch.js:176-315`。
- 成员创建与模型校验（含 effort 透传）：`dsh/subagent-session.js:85-147`（关键 107-125）。
- 插件配置与提示注入：`dsh/settings.js:3-64`；`dsh/index.js:11-57`；`dsh/client/badge.js:11-21`、`83-140`、`200-320`。
- 策略数据与权重：`team-work/policies/default.json:5-37`；`policy/kernel.mjs:37-43`；`cli.mjs:1574`、`878`。
- 升档审批全链路（待删除）：`cli.mjs:399-405`、`853-898`、`1001-1006`、`1057-1067`、`1597`、`647-650`。
- 工作流门定义：`workflow/definitions/engineering.json`（`gates` 与 `stages[].teamScene`）。
- 文本影响面：`skills/team-work-v3/SKILL.md:22-25`、`41-42`；`topology-and-cost.md:3-26`、`44-47`；`scenarios.md:13`；`dsh-orchestration.md:49`、`73-76`、`81-82`；`team-work/rules/lead/README.md:16`；`README.md:14`、`43-57`、`158`。
- 既有决策与历史：`docs/agents-json-task-scope-plan.md:18-20`、`docs/dsh-020-adaptation-plan.md:30`、`docs/team-topology-recovery-plan.md:5`、`docs/runtime-roadmap.md:161`。
- effort 宿主语义：用户提供的宿主源码与工具实测结论（`@deepseek-ai/dsh-llm resolveCallWithInfo` 2292-2316、`@deepseek-ai/dsh-tool-subagent` 47-77）；本仓库对应入口 `dsh/subagent-session.js:115-118`。
