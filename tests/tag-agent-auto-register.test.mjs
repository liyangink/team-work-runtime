// tagAgents 任务级测试：pendingTags 落盘 + 插件回填 mappings + 跨任务隔离（迁移后窗口消灭）
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync as rfs } from "node:fs"
import { mkdtemp as mkdt, readFile as rf, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { persistTagHints } = await import("../runtime-v3/cli.mjs")
const { makeInjectContribution } = await import("../dsh/inject.js")
async function pollUntil(fn, timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v !== undefined && v !== null && v !== false) return v
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil 超时")
    await new Promise((r) => setTimeout(r, 20))
  }
}
const DOT = String.fromCharCode(183)

test("续派回填边界：同标签续派覆盖 pendingTags 最新 key，send_message 不触发回填（回填只发生在子代创建时）", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-cont-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  const file = path.join(taskRoot, "agents.json")
  const tag = "CR" + DOT + "owner"
  // 首派：落盘 pendingTags=key1；子代创建（descriptor 标签命中）→ 回填 mappings[key1]
  await persistTagHints(taskRoot, [{ tag, key: "w2-abc", hint: { provider: "p", model: "m" } }])
  const contribution = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const childA = { agent: { id: "child-a", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: tag + " #demo-t" } }] } } }
  const disposerA = contribution(childA)
  const d1 = await pollUntil(async () => {
    const parsed = JSON.parse(await rf(file, "utf8"))
    return parsed.mappings?.["w2-abc"] === "child-a" ? parsed : null
  })
  assert.equal(d1.mappings["w2-abc"], "child-a", "首派子代创建时回填")
  // 续派：send_message 复用既有子会话——不产生新 descriptor、宿主不再次调用 contribution；
  // runtime 仅把 pendingTags 覆盖为最新 key，mappings 不新增回填（新 key 无映射，生命周期不错位）
  await persistTagHints(taskRoot, [{ tag, key: "w2-bbb", hint: { provider: "p", model: "m" } }])
  await new Promise((r) => setTimeout(r, 300)) // 给足潜在误回填窗口后仍无新键
  const d2 = JSON.parse(await rf(file, "utf8"))
  assert.equal(d2.pendingTags[tag], "w2-bbb", "pendingTags 覆盖为最新 key（续派寻址事实）")
  assert.equal(d2.mappings["w2-bbb"], undefined, "send_message 续派不触发回填：新 key 无映射（回填只发生在子代创建时）")
  assert.equal(d2.mappings["w2-abc"], "child-a", "旧键映射保留（审计记录）")
  // 新子代创建（同标签 fresh）→ contribution 才按最新 pendingTags 回填
  const childB = { agent: { id: "child-b", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: tag + " #demo-t" } }] } } }
  const disposerB = contribution(childB)
  const d3 = await pollUntil(async () => {
    const parsed = JSON.parse(await rf(file, "utf8"))
    return parsed.mappings?.["w2-bbb"] === "child-b" ? parsed : null
  })
  assert.equal(d3.mappings["w2-bbb"], "child-b", "新子代创建（fresh）才按最新 key 回填（R3：fresh 复用 key 回填新映射）")
  disposerA(); disposerB()
})

test("插件回填：标签命中后任务级 mappings[key]=childId；无 pending 不写；幂等", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-bf-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", key: "w2-abc", hint: { provider: "p", model: "m", effort: "max" } }])
  const file = path.join(taskRoot, "agents.json")
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const childCtx = { agent: { id: "child-x", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner #demo-t" } }] } } }
  const disposer = contribution(childCtx)
  assert.equal(installs[0].current.model, "m", "标签注入")
  const d = await pollUntil(async () => {
    const parsed = JSON.parse(await rf(file, "utf8"))
    return parsed.mappings?.["w2-abc"] === "child-x" ? parsed : null
  })
  assert.equal(d.mappings["w2-abc"], "child-x", "回填任务级键")
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 200))
  const d3 = JSON.parse(await rf(file, "utf8"))
  assert.equal(d3.mappings["w2-abc"], "child-x", "幂等")
})

test("跨任务隔离（迁移后窗口消灭）：两任务同标签各写各的 mappings，互不覆盖", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-iso-"))
  const ta = path.join(root, ".team-work", "tasks", "task-a")
  const tb = path.join(root, ".team-work", "tasks", "task-b")
  await mkdir(ta, { recursive: true })
  await mkdir(tb, { recursive: true })
  await persistTagHints(ta, [{ tag: "CR" + DOT + "owner", key: "wA-1", hint: { provider: "p", model: "m" } }])
  await persistTagHints(tb, [{ tag: "CR" + DOT + "owner", key: "wB-1", hint: { provider: "p", model: "m" } }])
  const contributionA = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const contributionB = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const childA = { agent: { id: "child-A", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner #task-a" } }] } } }
  const childB = { agent: { id: "child-B", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner #task-b" } }] } } }
  const da = contributionA(childA)
  const db = contributionB(childB)
  const ma = await pollUntil(async () => {
    const parsed = JSON.parse(await rf(path.join(ta, "agents.json"), "utf8"))
    return parsed.mappings?.["wA-1"] === "child-A" ? parsed : null
  })
  const mb = await pollUntil(async () => {
    const parsed = JSON.parse(await rf(path.join(tb, "agents.json"), "utf8"))
    return parsed.mappings?.["wB-1"] === "child-B" ? parsed : null
  })
  assert.equal(ma.mappings["wA-1"], "child-A", "任务 A 各归各")
  assert.equal(mb.mappings["wB-1"], "child-B", "任务 B 各归各")
  assert.ok(!("wB-1" in (ma.mappings ?? {})), "A 文件无 B 键（窗口消灭实锤）")
  da(); db()
})

test("stopped 检查：disposer 调用后回填不写（写时刻终检）", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-stop-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", key: "w2-x", hint: { provider: "p", model: "m" } }])
  const contribution = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const childCtx = { agent: { id: "child-s", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner #demo-t" } }] } } }
  const disposer = contribution(childCtx)
  disposer()
  await new Promise((r) => setTimeout(r, 400)) // stopped 断言为"不写"：给足回填窗口后仍无键
  const d = JSON.parse(await rf(path.join(taskRoot, "agents.json"), "utf8"))
  assert.equal(d.mappings?.["w2-x"], undefined, "stopped 后回填被跳过")
})
