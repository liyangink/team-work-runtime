// 标签寻址测试（任务级形态）：parseLabelTag 三重防线 + hintForTag + 同步注入三态
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DOT = String.fromCharCode(183)
const { parseLabelTag, hintForTag, makeInjectContribution } = await import("../dsh/inject.js")

test("parseLabelTag：{tag,task} 形态与三重防线", () => {
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner@store" + DOT + " 模块说明 #demo-t"), { tag: "CR" + DOT + "owner@store", task: "demo-t" })
  assert.deepEqual(parseLabelTag("CR" + DOT + "chal #demo-t"), { tag: "CR" + DOT + "chal", task: "demo-t" })
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner"), { tag: "CR" + DOT + "owner", task: null })
  assert.equal(parseLabelTag("cr" + DOT + "owner #t"), null)
  assert.equal(parseLabelTag("CR owner"), null)
  assert.equal(parseLabelTag(undefined), null)
})

test("parseLabelTag 任务段边界：多#取末/#后还有内容/#42数字/#MyTask/#-task/超64", () => {
  assert.equal(parseLabelTag("CR" + DOT + "owner" + DOT + " 见 #42 #demo-t").task, "demo-t", "多 # 取最后一个")
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner" + DOT + " x #demo-t 尾巴"), { tag: "CR" + DOT + "owner", task: null }, "# 后还有内容 → 非任务段")
  assert.equal(parseLabelTag("CR" + DOT + "owner #42").task, "42", "#42 数字开头合法（残余已声明）")
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner #MyTask"), { tag: "CR" + DOT + "owner", task: null })
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner #-task"), { tag: "CR" + DOT + "owner", task: null })
  assert.deepEqual(parseLabelTag("CR" + DOT + "owner #" + "a".repeat(65)), { tag: "CR" + DOT + "owner", task: null }, "超 64 → null（NAME_RE 上限 64）")
})

test("hintForTag：命中带 effort 映射 / 缺失拒绝", () => {
  const ag = { tagHints: { ["CR" + DOT + "owner"]: { provider: "p", model: "m", effort: "max" } } }
  assert.deepEqual(hintForTag(ag, "CR" + DOT + "owner"), { provider: "p", model: "m", reasoningEffort: "max" })
  assert.equal(hintForTag(ag, "RES" + DOT + "owner"), null)
})

test("标签注入：任务段命中 → 首轮同步注入 + 回填 + 补读互斥", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag2-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  const file = path.join(taskRoot, "agents.json")
  const { persistTagHints } = await import("../runtime-v3/cli.mjs")
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", key: "w2-x", hint: { provider: "p", model: "m", effort: "max" } }])
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  let polled = 0
  const contribution = makeInjectContribution(ctx, {
    readFile: async () => { polled += 1; return "{}" },
    installerNow: () => (c, sel) => { installs.push(sel) },
    pollMs: 5,
  })
  const childCtx = { agent: { id: "c1", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" + DOT + " 代码审查 #demo-t" } }] } } }
  const disposer = contribution(childCtx)
  assert.equal(installs.length, 1, "install 同步执行")
  assert.equal(installs[0].current.model, "m", "首轮即注入")
  assert.equal(installs[0].current.reasoningEffort, "max")
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(polled, 0, "标签命中锁死：补读不启动")
  const d = JSON.parse(await readFile(file, "utf8"))
  assert.equal(d.mappings["w2-x"], "c1", "回填任务级 mappings")
  disposer()
})

test("三重防线②：任务段目录不在场 → 不注入（简述 #42 不误判）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag3-"))
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, { installerNow: () => (c, sel) => { installs.push(sel) } })
  const childCtx = { agent: { id: "c2", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" + DOT + " 修复 #42" } }] } } }
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(installs.length, 1, "install 注册监听器（无条件）")
  assert.equal(installs[0].current, undefined, "#42 目录不在场 → 不注入（selection 不写）")
})

test("无任务段回退：定位不了任务级文件 → 不注入", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag4-"))
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, { installerNow: () => (c, sel) => { installs.push(sel) } })
  const childCtx = { agent: { id: "c3", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(installs.length, 1, "install 注册监听器（无条件）")
  assert.equal(installs[0].current, undefined, "无任务段 → 不注入（selection 不写）")
})
