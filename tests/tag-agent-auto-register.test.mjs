// tagAgents 任务级测试：pendingTags 落盘 + 插件回填 mappings + 跨任务隔离（迁移后窗口消灭）
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync as rfs } from "node:fs"
import { mkdtemp as mkdt, readFile as rf, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { persistTagHints } = await import("../runtime-v3/cli.mjs")
const { makeInjectContribution } = await import("../dsh/inject.js")
const DOT = String.fromCharCode(183)

test("pendingTags：任务级落盘标签到key，同标签续派覆盖为最新key", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-pend-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", key: "w2-aaa", hint: { provider: "p", model: "m" } }])
  let d = JSON.parse(await rf(path.join(taskRoot, "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-aaa")
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", key: "w2-bbb", hint: { provider: "p", model: "m" } }])
  d = JSON.parse(await rf(path.join(taskRoot, "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-bbb", "续派覆盖最新key")
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
  await new Promise((r) => setTimeout(r, 120))
  const d = JSON.parse(await rf(file, "utf8"))
  assert.equal(d.mappings["w2-abc"], "child-x", "回填任务级键")
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 120))
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
  await new Promise((r) => setTimeout(r, 150))
  const ma = JSON.parse(await rf(path.join(ta, "agents.json"), "utf8"))
  const mb = JSON.parse(await rf(path.join(tb, "agents.json"), "utf8"))
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
  await new Promise((r) => setTimeout(r, 150))
  const d = JSON.parse(await rf(path.join(taskRoot, "agents.json"), "utf8"))
  assert.equal(d.mappings?.["w2-x"], undefined, "stopped 后回填被跳过")
})
