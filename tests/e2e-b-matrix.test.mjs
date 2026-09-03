// E2E-B：压轴功能矩阵（runtime 全功能，node:test 全自动）
// 覆盖 F-3（默认配置零配置走通）/F-4（自定义配置生效）/F-6（数据隔离 agents.json 层）/
//       F-9（升档卡）/F-10（八视角形态全流程）/F-11（e2eTemplate 物化）
// F-5/F-7（注入/effort 实机）与 F-12（徽标）留真实 dsh 环境人工/半自动确认（E2E-C）。
import assert from "node:assert/strict"
import { writeFile, mkdir, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { makeProject, caller } from "./support/v3-fixtures.mjs"

const settingsFile = path.join(tmpdir(), `tw-e2e-b-tiers-${process.pid}-${Date.now()}.yaml`)
const BASE_SETTINGS = `
team-work-dsh:
  tiers:
    junior: { provider: e2e-junior, model: e2e-junior }
    senior: { provider: e2e-senior, model: e2e-senior }
    expert: { provider: e2e-expert, model: e2e-expert }
`
await writeFile(settingsFile, BASE_SETTINGS)
process.env.DSH_SETTINGS = settingsFile

test("E2E-B F-3：无项目 dsh.json、无插件时，全局 tier 配置可完成派发与交付", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "f3", "--objective", "全流程", "--entry", "code-review"])
  const plan = await call(["dispatch-plan", "--task", "f3", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.ok, true)
  assert.equal(plan.waves[0].modelHint.model, "e2e-junior")
  assert.equal(await access(path.join(root, ".team-work", "platform", "dsh.json")).then(() => true, () => false), false)
  await writeFile(path.join(root, "R.md"), "x")
  const dv = await call(["deliver", "--task", "f3", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(dv.accepted, true)
})

test("E2E-B F-9+F-10：八视角形态（tier 升档卡实测）+ 组合评审收敛", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "f10", "--objective", "八视角审查 runtime-v3", "--entry", "code-review"])
  // 八视角包：2 个 junior 视角 + 1 个 expert 视角（升档）+ 汇总包
  const pkgs = JSON.stringify([
    { id: "req-summary", writable: ["review/findings-req.md:code-review"], done: ["需求摘要视角 findings"], dependsOn: [] },
    { id: "types", writable: ["review/findings-types.md:code-review"], done: ["类型不变量视角 findings"], dependsOn: [] },
    { id: "sec-review", writable: ["review/findings-sec.md:code-review"], done: ["缺陷与安全视角 findings"], tier: "expert", dependsOn: [] },
    { id: "summary", writable: ["review/SUMMARY.md:code-review"], done: ["汇总去重归因，出正式报告"], dependsOn: ["req-summary", "types", "sec-review"] },
  ])
  const planned = await call(["plan", "--task", "f10", "--packages", pkgs])
  assert.equal(planned.ok, true)
  // 首波：3 个视角并行（汇总包依赖锁）——但 sec-review expert 升档 → 升档审批卡先出
  // 首波：3 个视角并行（汇总包依赖锁）——但 sec-review expert 升档 → 升档审批卡先出
  const gate = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(gate.stop, "awaiting-user", "F-9 升档卡触发")
  assert.deepEqual(gate.card.escalations, [{ package: "sec-review", tier: "expert" }], "只有 expert 视角列卡（junior 零打扰）")
  await call(["decide", "--task", "f10", "--choice", "1"]) // 批准
  const wave1 = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(wave1.waves.length, 3, "三视角并行")
  assert.equal(wave1.waves.find((x) => x.package === "sec-review").tier, "expert", "升档生效")
  assert.equal(wave1.waves.find((x) => x.package === "req-summary").tier, "junior", "junior 保持")
  // 三视角交付 → 组合评审 → accept → 裁决（core）
  for (const x of wave1.waves) {
    const p = x.prompt.match(new RegExp("- (review/[^(" + String.fromCharCode(92) + "uFF08" + String.fromCharCode(92) + "n]+)"))?.[1]
    await mkdir(path.dirname(path.join(root, p)), { recursive: true })
    await writeFile(path.join(root, p), "findings for " + x.package)
    const dv = await call(["deliver", "--task", "f10", "--key", x.dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", p])
    assert.equal(dv.accepted, true, x.package + " 交付")
  }
  const rv = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(rv.waves[0].scope, "consolidation", "组合评审")
  await call(["review", "--task", "f10", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "ok"])
  const ve = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(ve.waves[0].role, "expert", "裁决")
  await call(["review", "--task", "f10", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  // 汇总包解锁 → 交付 → 评审链 → 完成
  const wave2 = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(wave2.waves.length, 1)
  assert.equal(wave2.waves[0].package, "summary", "汇总包解锁")
  await writeFile(path.join(root, "review/SUMMARY.md"), "汇总")
  await call(["deliver", "--task", "f10", "--key", wave2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "review/SUMMARY.md"])
  const rv2 = await call(["dispatch-plan", "--task", "f10"])
  await call(["review", "--task", "f10", "--key", rv2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "ok"])
  const ve2 = await call(["dispatch-plan", "--task", "f10"])
  await call(["review", "--task", "f10", "--key", ve2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", "f10", "--route", "e2e", "--decision", "skip", "--basis", "文档任务"])
  const g1 = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(g1.stop, "awaiting-user")
  await call(["decide", "--task", "f10", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "f10"])
  assert.equal(done.stop, "completed", "F-10 八视角全流程完成")
  assert.equal(done.card.status, "completed", "完成卡状态")
})

test("E2E-B F-11：e2eTemplate 物化三包链（run 路由 → e2e 阶段 → 依赖串行）", async () => {
  const wf = { terminalStages: ["finish"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review", route: "e2e" },
    { id: "e2e", label: "端到端", outputs: ["e2e-result"], teamScene: "e2e", route: "e2e" },
    { id: "finish", label: "收尾", outputs: [], teamScene: "finish" },
  ], edges: [
    { from: "research", to: "code-review", outcome: "pass" },
    { from: "code-review", to: "e2e", outcome: "run-e2e" },
    { from: "code-review", to: "finish", outcome: "skip-e2e" },
    { from: "e2e", to: "finish", outcome: "pass" },
  ] }
  const pol = { maxAutonomousRounds: 3, scenes: { research: { core: false }, "code-review": { core: false }, e2e: { core: false }, finish: { core: false } }, e2eTemplate: [
    { packageId: "path-design", outputRefs: ["artifact:e2e-design"], dependsOn: [], completionCriteria: ["设计路径"] },
    { packageId: "execution", outputRefs: ["artifact:e2e-result"], dependsOn: ["path-design"], completionCriteria: ["执行留证"] },
  ] }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await call(["open", "--name", "f11", "--objective", "o"])  // workflow 模式：research 起（through-stage 会走 complete 不 advance）
  const r0 = await call(["dispatch-plan", "--task", "f11", "--writable", "none"])
  await call(["deliver", "--task", "f11", "--key", r0.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "调研"])
  const rv0 = await call(["dispatch-plan", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv0.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // dispatch-plan 锁内 continue：advance → code-review 后直接派发（无 advance 中间卡）
  const d = await call(["dispatch-plan", "--task", "f11", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x")
  await call(["deliver", "--task", "f11", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  await call(["route", "--task", "f11", "--route", "e2e", "--decision", "run", "--basis", "适用"])
  const adv = await call(["dispatch-plan", "--task", "f11"])
  assert.equal(adv.stage, "e2e", "D7 run-e2e 边")
  // F-11：物化发生（advance 后首轮派发前）——同一锁内推进直接出 path-design 单包
  assert.equal(adv.waves.length, 1, "模板物化：首包")
  assert.equal(adv.waves[0].package, "path-design")
  const w1 = adv
  await mkdir(path.join(root, "e2e"), { recursive: true })
  await writeFile(path.join(root, "e2e/e2e-design.md"), "d")
  await call(["deliver", "--task", "f11", "--key", w1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "e2e/e2e-design.md"])
  const rv2 = await call(["dispatch-plan", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const w2 = await call(["dispatch-plan", "--task", "f11"])
  assert.equal(w2.waves[0].package, "execution", "依赖解锁第二包")
})

test("E2E-B F-6/F-4：双任务 agent-map 数据隔离 + 全局候选池生效", async () => {
  const root = await makeProject()
  await writeFile(settingsFile, `
team-work-dsh:
  tiers:
    junior:
      - provider: pool-a
        model: fam-one
        family: one
      - provider: pool-b
        model: fam-two
        family: two
    senior: { provider: pool-senior, model: sen-m }
    expert: { provider: pool-expert, model: exp-m }
`)
  try {
    const call = caller(root)
    const plans = {}
    for (const name of ["iso-a", "iso-b"]) {
      await call(["open", "--name", name, "--objective", "o", "--entry", "code-review"])
      plans[name] = await call(["dispatch-plan", "--task", name, "--writable", name + ".md:code-review", "--json"])
    }
    const keyA = plans["iso-a"].waves[0].dispatchKey
    const keyB = plans["iso-b"].waves[0].dispatchKey
    await call(["agent-map", "--task", "iso-a", "--key", keyA, "--agent", "child-A1"])
    await call(["agent-map", "--task", "iso-b", "--key", keyB, "--agent", "child-B1"])
    assert.equal(plans["iso-a"].waves[0].modelHint.model, "fam-one", "F-4 全局池首选")
    assert.equal(plans["iso-b"].waves[0].modelHint.model, "fam-one", "不同波次各自从首选开始")
    const agentsA = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "iso-a", "agents.json"), "utf8"))
    const agentsB = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "iso-b", "agents.json"), "utf8"))
    assert.equal(agentsA.modelHints, undefined, "agents.json 收敛纯 mappings")
    assert.equal(agentsB.modelHints, undefined)
    assert.equal(agentsA.mappings[keyA], "child-A1", "F-6 双任务映射各归各任务文件")
    assert.equal(agentsB.mappings[keyB], "child-B1", "F-6 双任务映射各归各任务文件")
    assert.equal(Object.hasOwn(agentsA.mappings, keyB), false, "A 任务文件不含 B 任务映射")
    assert.equal(Object.hasOwn(agentsB.mappings, keyA), false, "B 任务文件不含 A 任务映射")
  } finally {
    await writeFile(settingsFile, BASE_SETTINGS)
  }
})
