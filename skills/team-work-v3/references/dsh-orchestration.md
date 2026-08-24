# DSH 编排模板（Lead 经 workflow 工具执行）

平台事实：workflow 脚本没有 fs/network/shell——**Lead 在脚本外执行 `tw dispatch-plan --task <名> --json` 取计划，把 JSON 作为 args 传入脚本；脚本内只调 `agent()`**。成员在 agent 内自带 bash，会按派单内嵌的指令自行调用 `tw deliver / tw review`（派单已注入 tw 的绝对调用路径，不依赖成员 PATH）。

## 循环模板（从当前波次推进到下一扇门）

```js
// args = { plan: <tw dispatch-plan --json 的输出> }，每轮由 Lead 重新生成
const plan = args.plan
if (plan.stop) return plan.card          // awaiting-user / wait-inflight / completed / blocked：终止带回卡片
const results = []
for (const w of plan.waves) {
  results.push(await agent(w.prompt, {
    label: w.dispatchKey,
    provider: w.modelHint.provider,      // tier→模型映射在派发点生效
    model: w.modelHint.model,
  }))
}
// 成员已在 agent 内交付；个别失败(null)不阻断——下一轮 dispatch-plan 会给出 wait-inflight 补派提示
return {
  dispatched: plan.waves.map((w) => w.dispatchKey),
  failed: results.filter((r) => r === null).length,
  card: plan.card,
}
```

Lead 的外层循环：`dispatch-plan` → workflow（args=plan）→ 等成员通知 → 再 `dispatch-plan`……直到 stop。

- `stop: "awaiting-user"`：向用户呈现 `card.choices`，答案经 `tw decide` 写入后继续循环；
- `stop: "wait-inflight"`：有成员未交付（agent 失败或提前结束）——按 `card.dispatchKey` 从上一轮 plan.waves 取原派单全文补派；
- `stop: "completed"`：问用户是否 `tw archive`；
- `stop: "blocked"`：读 `card.blockers` 的 recovery 字段修复后继续。

## 拓扑与并行

- Phase 1 波次机每轮派一个角色（owner → challenger →（核心场景）expert → 门），`plan.waves` 长度为 1；返工/重裁轮由 dispatch-plan 顺序导出，脚本无需特判。
- 多视角并行不发生在编排层：Challenger 成员用**只读子派单**（junior 档、可写范围为空、`parallel()` 并行、按视角分组）自查，整合成一份 review 交付；子派单数量遵守 policy `concurrencySoftLimit`（默认 4）。
- 成员可嵌套派发（DSH subagent 完整工具面），但只读子派单不得继续委托、不进收敛与裁决。

## tier→模型映射

- `.team-work/platform/dsh.json`：缺失时自动生成三档 `{"use":"agent-default"}` 占位（解析为 DSH 主 agent 模型）；
- 分档示例：junior→deepseek-v4-flash（廉价快），senior→glm-5.3（强推理中价），expert→gpt-5.6-terra（旗舰）；
- `tw models` 查看当前解析与来源（explicit / agent-default / fallback / default）；改映射下一波生效，已派发成员不变。
