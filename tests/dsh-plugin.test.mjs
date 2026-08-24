// dsh-plugin 纯函数单测（不依赖 DSH 运行时；装载链验证在 I2 验证脚本与 I6 压轴 E2E）
import assert from "node:assert/strict"
import test from "node:test"

import { hintForChild, agentsJsonPath } from "../packages/dsh-plugin/src/inject.js"
import { resolveTwBin, resolveProjectRoot } from "../packages/dsh-plugin/src/tw-tool.js"
import { parseFrontmatter } from "../packages/dsh-plugin/src/skill-embed.js"

test("I2 注入寻址：childId 查 modelHints（合法/缺字段/无此 child/损坏输入）", () => {
  const agents = { mappings: { w1: "child-a" }, modelHints: { "child-a": { provider: "p", model: "m", effort: "high" }, "child-b": { provider: "p", model: "m" }, "child-c": { provider: "", model: "m" } } }
  assert.deepEqual(hintForChild(agents, "child-a"), { provider: "p", model: "m", reasoningEffort: "high" }, "effort 映射为 reasoningEffort")
  assert.deepEqual(hintForChild(agents, "child-b"), { provider: "p", model: "m" }, "无 effort 不带字段")
  assert.equal(hintForChild(agents, "child-c"), null, "空 provider 拒绝")
  assert.equal(hintForChild(agents, "child-x"), null, "无此 child")
  assert.equal(hintForChild(null, "child-a"), null, "损坏输入")
  assert.equal(hintForChild({ modelHints: "not-object" }, "a"), null, "modelHints 非对象")
})

test("I2 agents.json 路径解析：config 优先 → header.cwd 兜底 → 无则 null", () => {
  assert.equal(agentsJsonPath({ projectRoot: "/proj" }, "/cwd"), "/proj/.team-work/platform/agents.json", "config 优先")
  assert.equal(agentsJsonPath(null, "/cwd"), "/cwd/.team-work/platform/agents.json", "header.cwd 兜底")
  assert.equal(agentsJsonPath(null, null), null, "两者皆无 → 不注入")
})

test("I2 tw 工具解析：twBin config 优先；projectRoot 三级链", () => {
  assert.equal(resolveTwBin({ twBin: "/x/tw.mjs" }), "/x/tw.mjs", "config 显式")
  assert.equal(typeof resolveTwBin({}), "string", "peerDep 解析或 PATH 兜底")
  assert.equal(resolveProjectRoot({ projectRoot: "/p" }, { agent: { session: { header: { cwd: "/c" } } } }), "/p")
  assert.equal(resolveProjectRoot({}, { agent: { session: { header: { cwd: "/c" } } } }), "/c")
  assert.equal(resolveProjectRoot({}, {}), process.cwd())
})

test("I2 注入链提纯（F7）：同步预注册 install + hint 异步补写 selection.current；读失败静默", async () => {
  const { makeInjectContribution, hintForChild } = await import("../packages/dsh-plugin/src/inject.js")
  const calls = []
  const installs = []
  const fakeInstall = (ctx, selection) => { installs.push({ ctx, selection }) }
  const fakeRead = async (file) => {
    calls.push(file)
    return JSON.stringify({ modelHints: { "child-1": { provider: "p", model: "m", effort: "max" } } })
  }
  const ctx = { logger: { info() {} } }
  let providerAtInstall = "UNSET"
  const fakeInstallChecked = (childCtx2, selection) => {
    providerAtInstall = selection.current.provider // 注册时刻的占位快照（应为 null——补读在其后）
    fakeInstall(childCtx2, selection)
  }
  const contribution = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFile: fakeRead,
    resolveInstaller: async () => fakeInstallChecked,
  })
  const childCtx = { agent: { id: "child-1", session: { header: { cwd: "/x" } } } }
  await contribution(childCtx)
  // 同步预注册：install 已被调用（监听器在场——F2 契约）；注册时刻占位为空（补读未发生）
  assert.equal(installs.length, 1, "install 同步预注册")
  assert.equal(providerAtInstall, null, "注册时刻占位为空（补读在注册之后）")
  const selection = installs[0].selection
  // 异步补读：selection.current 被覆写为 hint
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(selection.current.model, "m", "hint 异步补写")
  assert.equal(selection.current.reasoningEffort, "max")
  // 读失败静默：selection 保持
  const contribution2 = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFile: async () => { throw new Error("enoent") },
    resolveInstaller: async () => fakeInstall,
  })
  const installs2 = []
  await contribution2({ agent: { id: "child-2", session: { header: { cwd: "/x" } } } })
  await new Promise((r) => setTimeout(r, 20))
  // 无抛出即为通过（selection 保持占位）
  // installer 解析失败 → 不注入
  const contribution3 = makeInjectContribution(ctx, {}, { resolveInstaller: async () => null })
  const before = installs.length
  await contribution3({ agent: { id: "child-3" } })
  assert.equal(installs.length, before, "无安装器 → install 不被调")
})

test("I2 frontmatter 解析：name/description 提取与引号剥离", () => {
  const md = ["---", "name: team-work-v3", 'description: "用 tw CLI 驱动多智能体研发工作流"', "---", "正文"].join(String.fromCharCode(10))
  const fm = parseFrontmatter(md)
  assert.equal(fm.name, "team-work-v3")
  assert.equal(fm.description, "用 tw CLI 驱动多智能体研发工作流")
  assert.deepEqual(parseFrontmatter("无 frontmatter"), {})
})
