// 标签寻址测试（docs/dsh-tag-injection-plan.md v2）：parseLabelTag/hintForTag 纯函数 + 同步注入三态
import assert from "node:assert/strict"
import test from "node:test"

const DOT = String.fromCharCode(183)
const { parseLabelTag, hintForTag, makeInjectContribution } = await import("../dsh/inject.js")

test("parseLabelTag：合法三态（@包/无包/简述殿后）", () => {
  assert.equal(parseLabelTag("CR" + DOT + "owner@store" + DOT + " 模块说明"), "CR" + DOT + "owner@store")
  assert.equal(parseLabelTag("CR" + DOT + "chal"), "CR" + DOT + "chal")
  assert.equal(parseLabelTag("IMPL" + DOT + "owner@api" + DOT + " 接口改造"), "IMPL" + DOT + "owner@api")
})

test("parseLabelTag：畸形全拒（小写/空格/无角色/含key/空/非串）", () => {
  assert.equal(parseLabelTag("cr" + DOT + "owner"), null)
  assert.equal(parseLabelTag("CR owner"), null)
  assert.equal(parseLabelTag("CR" + DOT + "w2-abc"), null)
  assert.equal(parseLabelTag(""), null)
  assert.equal(parseLabelTag(undefined), null)
})

test("hintForTag：命中带 effort 映射 / 缺失 / provider 空拒绝", () => {
  const ag = { tagHints: { ["CR" + DOT + "owner"]: { provider: "p", model: "m", effort: "max" } } }
  assert.deepEqual(hintForTag(ag, "CR" + DOT + "owner"), { provider: "p", model: "m", reasoningEffort: "max" })
  assert.equal(hintForTag(ag, "RES" + DOT + "owner"), null)
  assert.equal(hintForTag({ tagHints: { ["CR" + DOT + "owner"]: { provider: "", model: "m" } } }, "CR" + DOT + "owner"), null)
})

test("标签注入：descriptor.label 命中 tagHints → 首轮同步注入 + 补读互斥（F-7）", async () => {
  const installs = []
  const fakeInstall = (c, sel) => { installs.push(sel) }
  const ctx = { logger: { info() {}, warn() {} } }
  let polled = 0
  const contribution = makeInjectContribution(ctx, {
    readFile: async () => { polled += 1; return "{}" },
    readFileSync: () => JSON.stringify({ tagHints: { ["CR" + DOT + "owner"]: { provider: "p", model: "m", effort: "max" } } }),
    installerNow: () => fakeInstall,
    pollMs: 5,
  })
  const childCtx = { agent: { id: "c1", session: { header: { cwd: "/x" }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" + DOT + " 代码审查" } }] } } }
  const disposer = contribution(childCtx) // 宿主契约：不 await
  assert.equal(typeof disposer, "function")
  assert.equal(installs.length, 1, "install 同步执行")
  assert.equal(installs[0].current.model, "m", "首轮即注入")
  assert.equal(installs[0].current.reasoningEffort, "max")
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(polled, 0, "标签命中即锁死：补读循环不启动")
  disposer()
})

test("回退链：标签合法但 hint 缺 → 降级 childId 补读；无标签 → 现状同步首读", async () => {
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const c1 = makeInjectContribution(ctx, {
    readFileSync: () => JSON.stringify({ tagHints: {} }),
    readFile: async () => JSON.stringify({ modelHints: { c2: { provider: "p2", model: "m2" } } }),
    installerNow: () => (c, sel) => { installs.push(sel) },
    pollMs: 5,
  })
  const child = { agent: { id: "c2", session: { header: { cwd: "/x" }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  c1(child)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(installs[0].current.model, "m2", "降级补读命中")
  const installs2 = []
  const c2 = makeInjectContribution(ctx, {
    readFileSync: () => JSON.stringify({ modelHints: { c3: { provider: "p3", model: "m3" } } }),
    installerNow: () => (c, sel) => { installs2.push(sel) },
  })
  const child2 = { agent: { id: "c3", session: { header: { cwd: "/x" }, events: [{ type: "subagent/descriptor", data: { label: "随便" } }] } } }
  c2(child2)
  assert.equal(installs2[0].current.model, "m3", "无标签 → childId 同步首读")
})

test("resume 幂等：重复跑 contribution 同 hint 无害（第二次覆盖同值）", () => {
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, {
    readFileSync: () => JSON.stringify({ tagHints: { ["RES" + DOT + "owner"]: { provider: "p", model: "m" } } }),
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const childCtx = { agent: { id: "c4", session: { header: { cwd: "/x" }, events: [{ type: "subagent/descriptor", data: { label: "RES" + DOT + "owner" } }] } } }
  contribution(childCtx)
  contribution(childCtx)
  assert.equal(installs.length, 2, "两次注册（宿主每次 resume 调 contribution）")
  assert.equal(installs[1].current.model, "m", "重复注入同 hint（幂等语义）")
})
