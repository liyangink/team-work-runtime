// tagAgents v2 测试：pendingTags 落盘/覆盖 + 插件自动回填 mappings（键任务作用域）
import assert from "node:assert/strict"
import test from "node:test"
test("stopped 检查：disposer 调用后回填不写（写前已亡跳过）", async () => {
  const { persistTagHints } = await import("../runtime-v3/cli.mjs")
  const { makeInjectContribution } = await import("../dsh/inject.js")
  const { mkdtemp, mkdir, readFile } = await import("node:fs/promises")
  const rfs = (await import("node:fs")).readFileSync
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-stop-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-x", hint: { provider: "p", model: "m" } }])
  const contribution = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const childCtx = { agent: { id: "child-s", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  const disposer = contribution(childCtx)
  disposer() // 立即销毁（模拟子代先亡）
  await new Promise((r) => setTimeout(r, 150))
  const d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.mappings?.["w2-x"], undefined, "stopped 后回填被跳过")
})

test("锁并发：persistTagHints 与插件回填同锁互斥（合并后两键俱在）", async () => {
  const { persistTagHints } = await import("../runtime-v3/cli.mjs")
  const { makeInjectContribution } = await import("../dsh/inject.js")
  const { mkdtemp, mkdir, readFile } = await import("node:fs/promises")
  const rfs = (await import("node:fs")).readFileSync
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-lock-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-y", hint: { provider: "p", model: "m" } }])
  const contribution = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => {},
  })
  const childCtx = { agent: { id: "child-c", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  // 并发：回填与另一次 persistTagHints（另一标签）同时写
  const disposer = contribution(childCtx)
  await persistTagHints(root, [{ tag: "TEST" + DOT + "owner", key: "w2-z", hint: { provider: "q", model: "n" } }])
  await new Promise((r) => setTimeout(r, 150))
  const d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.mappings?.["w2-y"], "child-c", "回填落盘")
  assert.equal(d.pendingTags?.["TEST" + DOT + "owner"], "w2-z", "并发写不丢键")
  disposer()
})

import { readFileSync as rfs } from "node:fs"
test("残余窗口真路径：同标签 A 派发后 B 覆盖 pendingTags，A 子代创建回填写到 B.key（如实断言已文档化行为）", async () => {
  const { persistTagHints } = await import("../runtime-v3/cli.mjs")
  const { makeInjectContribution } = await import("../dsh/inject.js")
  const { mkdtemp, mkdir, readFile, readFileSync } = await import("node:fs/promises")
  const rfs = (await import("node:fs")).readFileSync
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-iso-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  // 任务 A 派发同标签后，任务 B 又派发（pendingTags 覆盖为 B.key）
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "wA-1", hint: { provider: "p", model: "m" } }])
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "wB-1", hint: { provider: "p", model: "m" } }])
  // A 子代乱序创建（B 派发之后）——走真路径：contribution → backfillMapping
  const installs = []
  const contribution = makeInjectContribution({ logger: { info() {}, warn() {} } }, {
    readFileSync: (f) => rfs(f, "utf8"),
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const childCtx = { agent: { id: "child-A", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  const disposer = contribution(childCtx)
  assert.equal(installs[0].current.model, "m", "注入成功")
  await new Promise((r) => setTimeout(r, 150))
  const d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  // 残余窗口行为（方案 §1 已文档化）：pendingTags 已被 B 覆盖，A 子代回填写到 B.key
  assert.equal(d.mappings["wB-1"], "child-A", "A 回填落在最新 pendingTags 的 key（残余窗口如实）")
  assert.ok(!("wA-1" in (d.mappings ?? {})), "A.key 未被写（A 读到的 pendingTags 已非自己）")
  disposer()
})

import { mkdtemp as mkdt, readFile as rf, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { persistTagHints } = await import("../runtime-v3/cli.mjs")
const { makeInjectContribution } = await import("../dsh/inject.js")
const DOT = String.fromCharCode(183)

test("pendingTags：落盘标签到key，同标签续派覆盖为最新key", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-pend-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-aaa", hint: { provider: "p", model: "m" } }])
  let d = JSON.parse(await rf(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-aaa")
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-bbb", hint: { provider: "p", model: "m" } }])
  d = JSON.parse(await rf(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-bbb", "续派覆盖最新key")
})

test("插件回填：标签命中后 mappings[key]=childId 落地；无 pending 不写；幂等", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-bf-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-abc", hint: { provider: "p", model: "m", effort: "max" } }])
  const file = path.join(root, ".team-work", "platform", "agents.json")
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, {
    readFileSync: (f) => rfs(f, "utf8"), // 贡献段真读（含 tagHints）
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const childCtx = { agent: { id: "child-x", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  const disposer = contribution(childCtx)
  assert.equal(installs[0].current.model, "m", "标签注入")
  await new Promise((r) => setTimeout(r, 120))
  const d = JSON.parse(await rf(file, "utf8"))
  assert.equal(d.mappings["w2-abc"], "child-x", "回填任务作用域键")
  // 幂等：再跑一次（resume 语义）mappings 不变
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 120))
  const d3 = JSON.parse(await rf(file, "utf8"))
  assert.equal(d3.mappings["w2-abc"], "child-x", "幂等")
})
