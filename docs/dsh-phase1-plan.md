# DSH 适配层 Phase 1 实施规约

状态：历史 Phase 1 方案；配置部分已由全局 settings 实现取代。

> **迁移说明（当前实现）**：tier→模型的唯一配置源是 DSH 全局 settings 的 `team-work-dsh.tiers`，由 DSH Web“插件配置”页管理。`junior`、`senior`、`expert` 必须完整，每个候选 provider/model 非空必填，family/effort 可选，单对象与数组均兼容；同波按候选池优先不同 family 选择。项目 `.team-work/platform/dsh.json` 不再读取或创建，遗留文件可手动删除。`agents.json` 继续保留 dispatchKey→childId 和 modelHint 快照这一项目运行事实。以下旧设计中有关 `agent-default`、项目 `dsh.json` 与初始化映射的描述仅供追溯，不代表当前行为。

## 0. 平台事实基础（已实测/已确认）

- workflow 工具：`agent(prompt, opts)`——opts: `{label?, phase?, provider?, model?, schema?}`，provider/model **可独立给**；schema 仅白名单关键字（type/properties/required/additionalProperties/items/enum/const/oneOf）；child 失败 resolve null；脚本无 fs/network/timer；并发与总量有上限，超限 throw 杀脚本。
- skill 装载：项目 `.dsh/skills/` / `.agents/skills/`（filesystem provider 扫描根，实测）。
- 嵌套：subagent 拥有完整工具面，成员可自派只读子代理（AGENTS 16 模式）；send_message 仅 depth-1。
- 配置（当前实现）：DSH 全局 `settings.yaml` 的 `team-work-dsh.tiers`；Web“插件配置”页是首选编辑入口。

## 1. 交付物（4 件）

### 1.1 `tw dispatch-plan --task <name> [--json]`
输出当前可派发波次的机器可读计划（编排脚本的唯一输入）：
```json
{ "task": "audit-q3", "stage": "code-review", "stop": null,
  "waves": [{ "dispatchKey": "w4-0ab813", "kind": "review", "role": "challenger",
    "tier": "senior", "round": 1, "prompt": "<派单全文>",
    "deliver": "review", "modelHint": { "provider": "...", "model": "..." } }],
  "card": { "status": "working", "next": "dispatch" } }
```
- 波次序列复用 derive（含在途等待：已派发未交付 → `stop: "wait-inflight"`）；gate/awaiting-user → `stop` 字段 + 卡片内嵌，脚本见 stop 即终止返回。
- `modelHint` = 全局 settings 候选池的确定性选择结果（tier→provider/model + `global-settings` 来源、可选 family/effort）；精确结果在派发时快照，后续 `agent-map` 只复制快照而不重选。
- 人读模式（无 --json）打印派单全文与派发指令示例。

### 1.2 映射与初始化（当前实现取代原模拟）

**当前结论**：核心 standalone 流程（open → run → 成员 deliver）不依赖 skill 装载或项目映射文件；派单全文已内嵌工作合同。`dispatch-plan` 作为平台选模入口则必须解析全局 `team-work-dsh.tiers`，缺档时返回可恢复 blocked 卡。因此：

- **无默认模型回退**：未配置、文件不可读或三档不完整均标记 unresolved；`dispatch-plan` 返回可恢复 blocked 卡和 settings 文件修复指引，不猜测主 agent 模型；
- **`tw init` 是可选便捷命令**：仅安装 skill 到 `.dsh/skills/`，不创建项目映射；核心流程 = 配置全局 tiers → open → dispatch-plan；
- **插件工具定位**：插件内 `tw` 原生工具使用当前子会话 cwd 与内置入口解析；`injectionEnabled`、`projectRoots`、`twBin` 不再读取，也不保留兼容路径；
- **package contract 测试**：package.json 的 name/version/bin 非空断言（模拟中曾发现元数据损坏，防止复发）。

### 1.3 `tw models`
只读显示全局 `team-work-dsh.tiers` 的每档候选池、来源与 unresolved 警告；不读取或创建项目 `dsh.json`。无参数、无状态。

### 1.4 skill 增补 `references/dsh-orchestration.md`
编排脚本模板（Lead 经 workflow 工具执行）：
```js
// 读计划 → 循环：无 stop 则按 wave 派发 → tw run 消费 → 重新读计划
const plan = JSON.parse(/* tw dispatch-plan --json 的输出 */)
while (!plan.stop) {
  for (const w of plan.waves) {
    await agent(w.prompt, { label: w.dispatchKey, model: w.modelHint.model })
  }
  // 成员在 agent 内已调 tw deliver/review；此处 tw run 推进
  /* plan = 重新执行 tw dispatch-plan */
}
return plan.card
```
- review 复杂拓扑变体：八视角 Owner → `parallel`（多 Challenger 按视角分组）→ Expert → 门；
- 并发上限：waves 数组长度天然受 policy concurrencySoftLimit 约束（Lead 拆分时遵守）；
- 失败语义：agent null → 记录并继续（波次在途检查会让下轮 dispatch-plan 显示 wait-inflight）；脚本级 throw（超限）→ 终止并把错误带回给 Lead。

## 2. 映射解析规则（新模块 runtime-v3/dsh-map.mjs）

```
tier 从 DSH settings 的 `team-work-dsh.tiers` 解析；缺失、损坏或 provider/model 为空则标记 unresolved（不内置环境默认，派发前需配置）→ 全部标注全局来源
```
- settings 路径优先级：显式 settingsFile → `DSH_SETTINGS` → `$DSH_HOME/settings.yaml` → `~/.dsh/settings.yaml`；派发时读取，已派发成员不可变，改文件下一波生效；
- 校验：provider/model 非空字符串；未知字段拒绝并指引。Web 保存还要求 Provider 在目录中处于 active；模型目录与 effort 只在有相应元数据时校验。

## 3. 测试计划（先测后码）

| 测试 | 断言 |
| --- | --- |
| dsh-map 解析 | 引号、注释、单对象与数组候选池；三档缺失/unresolved、provider/model 校验与 settings 路径优先级 |
| dispatch-plan | gate 时 stop 字段；awaiting-user 时 stop+卡片；在途时 stop=wait-inflight；全局 modelHint 快照与家族多样性 |
| init | skill 复制与幂等；不创建项目 dsh.json |
| models | 只读显示全局 settings 来源与三档候选池 |
| 编排模板 | 纯文本资产，contract 测试校验与 SKILL.md 链接一致 |

## 4. 验收（Phase 1 DoD）

1. 单测全绿（预计 +8~10 项）；
2. **真实编排实测**：一个 code-review 任务经 workflow 脚本（dispatch-plan → agent 派发 → run 推进 → 人工门 stop）完整跑通，成员按全局 tier 配置派发（不同 tier 用不同模型，从结果验证）；
3. `tw init` 只装载 skill，项目 `dsh.json` 在空项目和既有遗留文件场景均不被创建或读取；
4. 文档同步：charter §8 更新为实施后现状、roadmap Phase 1 标记完成、file-inventory 增量。

## 5. 明确不做（Phase 1 边界）

- Cordis 插件包（已在后续 Phase 3 实施；`tw` 原生工具只使用子会话 cwd 与内置入口解析）、写入拦截 hook（不在本 Phase 1 范围）；
- 成本投影 `tw status`（Phase 2，但 dsh-map 的权重标注先行落地）；
- OpenSpec provider 接入（独立决策）；
- cmdRun 职责重构（独立技术债，不阻塞本阶段）。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| workflow 脚本无法直接执行 shell（无 fs/network）| 模板设计为 Lead 在脚本外取 dispatch-plan 输出、作为 args 传入；脚本内只调 agent |
| 成员 subagent 不调 tw 就结束 | 派单文本已内嵌交付指令；在途检查兜底（wait 卡提示 Lead 补派） |
| 并发上限未知具体值 | 模板按 waves≤concurrencySoftLimit(4) 拆分；超限 throw 即终止带回错误 |
