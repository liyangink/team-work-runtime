# DSH 适配层 Phase 1 实施规约

状态：待用户批准后实施。前置：b313f1b（v3 重写已提交，42/42 绿）。

## 0. 平台事实基础（已实测/已确认）

- workflow 工具：`agent(prompt, opts)`——opts: `{label?, phase?, provider?, model?, schema?}`，provider/model **可独立给**；schema 仅白名单关键字（type/properties/required/additionalProperties/items/enum/const/oneOf）；child 失败 resolve null；脚本无 fs/network/timer；并发与总量有上限，超限 throw 杀脚本。
- skill 装载：项目 `.dsh/skills/` / `.agents/skills/`（filesystem provider 扫描根，实测）。
- 嵌套：subagent 拥有完整工具面，成员可自派只读子代理（AGENTS 16 模式）；send_message 仅 depth-1。
- 配置：项目 `.team-work/platform/dsh.json`（映射数据留项目，不进 DSH profile）。

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
- `modelHint` = 映射解析结果（tier→provider/model + 来源标记 explicit/fallback/default）。
- 人读模式（无 --json）打印派单全文与派发指令示例。

### 1.2 映射与初始化（模拟修正版：零初始化门槛）

**实测结论（2026-08-24 全流程模拟）**：核心流程（open → run → 成员 deliver）**不依赖** skill 装载与映射文件——派单全文已内嵌工作合同，无映射时 tier 标签照常输出。因此：

- **映射默认值 = 主 agent 模型占位**：`.team-work/platform/dsh.json` 安装/首次使用时自动生成，三档默认 `{"use": "agent-default"}`（常量占位）；运行时解析为 DSH 当前主 agent 模型（`~/.dsh/settings.yaml` 的 `agent-default-model`，实测存在该配置）。用户分档 = 把任一档改为显式 `{provider, model}`；
- **`tw init` 降级为可选便捷命令**：仅做 skill 装载到 `.dsh/skills/`（服务 Lead 判断指引）；README 快速开始不包含它；核心流程 = 安装 → open → run；
- **派单 PATH 注入**：`tw run` 派发时解析自身可执行路径写入派单交付指令（Phase 1 过渡；Phase 3 插件把 tw 封装为 preset 层原生工具后消失）；
- **package contract 测试**：package.json 的 name/version/bin 非空断言（模拟中曾发现元数据损坏，防止复发）。

### 1.3 `tw models`
显示当前映射解析结果：每 tier → provider/model + 来源（explicit/fallback/default）+ 缺档警告。无参数、无状态。

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
tier 显式 → defaults → 仍无法解析则标记 unresolved（不内置环境默认，派发前需配置）→ 全部标注来源
```
- 派发时读取（波次粒度生效）；已派发成员不可变；改文件下一波生效；
- 校验：provider/model 非空字符串；未知字段拒绝并指引。

## 3. 测试计划（先测后码）

| 测试 | 断言 |
| --- | --- |
| dsh-map 解析 | 显式/回退/默认三档来源标记；缺档警告文本；损坏 JSON 拒绝带指引 |
| dispatch-plan | gate 时 stop 字段；awaiting-user 时 stop+卡片；在途时 stop=wait-inflight；modelHint 注入 |
| init | settings.yaml 存在时生成含 provider 清单的模板；skill 复制与幂等；--force 覆盖 |
| models | 三档显示与来源 |
| 编排模板 | 纯文本资产，contract 测试校验与 SKILL.md 链接一致 |

## 4. 验收（Phase 1 DoD）

1. 单测全绿（预计 +8~10 项）；
2. **真实编排实测**：一个 code-review 任务经 workflow 脚本（dispatch-plan → agent 派发 → run 推进 → 人工门 stop）完整跑通，成员按 tier 映射派发（不同 tier 用不同模型，从结果验证）；
3. `tw init` 在空项目与已有 settings.yaml 两种环境可用；
4. 文档同步：charter §8 更新为实施后现状、roadmap Phase 1 标记完成、file-inventory 增量。

## 5. 明确不做（Phase 1 边界）

- Cordis 插件包（含 **tw 注册为 preset 层原生工具**——实测确认 preset = agent.cordis.yml 目录、roster 挂载、工具按 agent→preset→global 作用域链解析；Phase 3 落地后 PATH 方案退役）、写入拦截 hook（Phase 3）；
- 成本投影 `tw status`（Phase 2，但 dsh-map 的权重标注先行落地）；
- OpenSpec provider 接入（独立决策）；
- cmdRun 职责重构（独立技术债，不阻塞本阶段）。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| workflow 脚本无法直接执行 shell（无 fs/network）| 模板设计为 Lead 在脚本外取 dispatch-plan 输出、作为 args 传入；脚本内只调 agent |
| 成员 subagent 不调 tw 就结束 | 派单文本已内嵌交付指令；在途检查兜底（wait 卡提示 Lead 补派） |
| 并发上限未知具体值 | 模板按 waves≤concurrencySoftLimit(4) 拆分；超限 throw 即终止带回错误 |
