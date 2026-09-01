// 标签寻址清理回归（定向委派第二阶段）：inject.js 不再导出标签寻址纯函数；
// 剩余通道 = ⓪ 直接选择 + ① request/header 回读（行为断言见 dsh-tw-tool-subagent.test.mjs）。
// 标签回归纯展示语义（skill dsh-orchestration.md 成员标签规范）。
import assert from "node:assert/strict"
import test from "node:test"

test("标签链读端已删：inject.js 不再导出 parseLabelTag/hintForTag/hintForChild/agentsJsonPath", async () => {
  const inject = await import("../dsh/inject.js")
  assert.equal(inject.parseLabelTag, undefined)
  assert.equal(inject.hintForTag, undefined)
  assert.equal(inject.hintForChild, undefined)
  assert.equal(inject.agentsJsonPath, undefined)
  assert.equal(typeof inject.recallFromHeader, "function", "header 回读通道保留")
  assert.equal(typeof inject.makeInjectContribution, "function")
})

test("recallFromHeader 只认 request/header：descriptor 标签事件不参与回读", async () => {
  const { recallFromHeader } = await import("../dsh/inject.js")
  const events = [
    { type: "subagent/descriptor", data: { label: "CR·owner · 合法标签 #task-x" } },
    { type: "request/header", data: { header: { config: { provider: "p", model: "m", reasoningEffort: "high" } } } },
  ]
  assert.deepEqual(recallFromHeader(events), { provider: "p", model: "m", reasoningEffort: "high" }, "回读取自持久化请求，与标签无关")
  assert.equal(recallFromHeader([events[0]]), null, "只有标签事件、无持久化请求 → 无可回读（继承默认）")
})
