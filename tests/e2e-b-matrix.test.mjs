// E2E-B：压轴功能矩阵（runtime 全功能，node:test 全自动）
// 覆盖 F-3（默认配置零配置走通）/F-4（自定义配置生效）/F-6（数据隔离 agents.json 层）/
//       F-9（升档卡）/F-10（八视角形态全流程）/F-11（e2eTemplate 物化）
// F-5/F-7（注入/effort 实机）与 F-12（徽标）留真实 dsh 环境人工/半自动确认（E2E-C）。
import assert from "node:assert/strict"
import { writeFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { makeProject, caller } from "./support/v3-fixtures.mjs"

test("E2E-B F-3：零配置开箱——无 dsh.json 无插件，任务全流程照常（映射 unresolved 不阻塞）", async () => {
  const root = await makeProject()
  // 不写 platform/dsh.json（零配置）
  const call = caller(root)
  await call(["open", "--name", "f3", "--objective", "全流程", "--entry", "code-review"])
  const d = await call(["run", "--task", "f3", "--writable", "R.md:code-review"])
  assert.equal(d.ok, true, "零配置派发正常")
  await writeFile(path.join(root, "R.md"), "x")
  const dv = await call(["deliver", "--task", "f3", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
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
  const gate = await call(["run", "--task", "f10"])
  assert.equal(gate.status, "awaiting-user", "F-9 升档卡触发")
  assert.deepEqual(gate.escalations, [{ package: "sec-review", tier: "expert" }], "只有 expert 视角列卡（junior 零打扰）")
  await call(["decide", "--task", "f10", "--choice", "1"]) // 批准
  const wave1 = await call(["run", "--task", "f10"])
  assert.equal(wave1.dispatches.length, 3, "三视角并行")
  assert.equal(wave1.dispatches.find((x) => x.package === "sec-review").tier, "expert", "升档生效")
  assert.equal(wave1.dispatches.find((x) => x.package === "req-summary").tier, "junior", "junior 保持")
  // 三视角交付 → 组合评审 → accept → 裁决（core）
  for (const x of wave1.dispatches) {
    const p = x.prompt.match(new RegExp("- (review/[^(" + String.fromCharCode(92) + "uFF08" + String.fromCharCode(92) + "n]+)"))?.[1]
    await mkdir(path.dirname(path.join(root, p)), { recursive: true })
    await writeFile(path.join(root, p), "findings for " + x.package)
    const dv = await call(["deliver", "--task", "f10", "--key", x.key, "--outcome", "delivered", "--summary", "s", "--paths", p])
    assert.equal(dv.accepted, true, x.package + " 交付")
  }
  const rv = await call(["run", "--task", "f10"])
  assert.equal(rv.dispatch.scope, "consolidation", "组合评审")
  await call(["review", "--task", "f10", "--key", rv.dispatch.key, "--recommendation", "accept", "--summary", "ok"])
  const ve = await call(["run", "--task", "f10"])
  assert.equal(ve.dispatch.role, "expert", "裁决")
  await call(["review", "--task", "f10", "--key", ve.dispatch.key, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  // 汇总包解锁 → 交付 → 评审链 → 完成
  const wave2 = await call(["run", "--task", "f10"])
  assert.equal(wave2.dispatches.length, 1)
  assert.equal(wave2.dispatches[0].package, "summary", "汇总包解锁")
  await writeFile(path.join(root, "review/SUMMARY.md"), "汇总")
  await call(["deliver", "--task", "f10", "--key", wave2.dispatches[0].key, "--outcome", "delivered", "--summary", "s", "--paths", "review/SUMMARY.md"])
  const rv2 = await call(["run", "--task", "f10"])
  await call(["review", "--task", "f10", "--key", rv2.dispatch.key, "--recommendation", "accept", "--summary", "ok"])
  const ve2 = await call(["run", "--task", "f10"])
  await call(["review", "--task", "f10", "--key", ve2.dispatch.key, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", "f10", "--route", "e2e", "--decision", "skip", "--basis", "文档任务"])
  const g1 = await call(["run", "--task", "f10"])
  assert.equal(g1.status, "awaiting-user")
  await call(["decide", "--task", "f10", "--choice", "1"])
  const done = await call(["run", "--task", "f10"])
  assert.equal(done.status, "completed", "F-10 八视角全流程完成")
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
  const r0 = await call(["run", "--task", "f11", "--writable", "none"])
  await call(["deliver", "--task", "f11", "--key", r0.dispatch.key, "--outcome", "delivered", "--summary", "调研"])
  const rv0 = await call(["run", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv0.dispatch.key, "--recommendation", "accept", "--summary", "s"])
  await call(["run", "--task", "f11"])  // advance → code-review
  const d = await call(["run", "--task", "f11", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x")
  await call(["deliver", "--task", "f11", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["run", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv.dispatch.key, "--recommendation", "accept", "--summary", "s"])
  await call(["route", "--task", "f11", "--route", "e2e", "--decision", "run", "--basis", "适用"])
  const adv = await call(["run", "--task", "f11"])
  assert.equal(adv.stage, "e2e", "D7 run-e2e 边")
  // F-11：物化发生（advance 后首轮派发前）——继续 run 应出 path-design 单包
  const w1 = await call(["run", "--task", "f11", "--writable", "none"])
  assert.equal(w1.dispatches.length, 1, "模板物化：首包")
  assert.equal(w1.dispatches[0].package, "path-design")
  await mkdir(path.join(root, "e2e"), { recursive: true })
  await writeFile(path.join(root, "e2e/e2e-design.md"), "d")
  await call(["deliver", "--task", "f11", "--key", w1.dispatches[0].key, "--outcome", "delivered", "--summary", "s", "--paths", "e2e/e2e-design.md"])
  const rv2 = await call(["run", "--task", "f11"])
  await call(["review", "--task", "f11", "--key", rv2.dispatch.key, "--recommendation", "accept", "--summary", "s"])
  const w2 = await call(["run", "--task", "f11"])
  assert.equal(w2.dispatches[0].package, "execution", "依赖解锁第二包")
})

test("E2E-B F-6/F-4：双任务并发 agent-map 数据隔离 + 自定义映射生效", async () => {
  const root = await makeProject()
  // 自定义映射（F-4）：junior 池带两个不同家族候选
  const mapFile = path.join(root, ".team-work", "platform", "dsh.json")
  await mkdir(path.dirname(mapFile), { recursive: true })
  await writeFile(mapFile, JSON.stringify({ tiers: { junior: [
    { provider: "prov-a", model: "fam-one", family: "one" },
    { provider: "prov-b", model: "fam-two", family: "two" },
  ], senior: [{ provider: "prov-c", model: "sen-m", family: "c" }], expert: [{ provider: "prov-d", model: "exp-m", family: "d" }] }, defaults: null }))
  const call = caller(root)
  for (const name of ["iso-a", "iso-b"]) {
    await call(["open", "--name", name, "--objective", "o", "--entry", "code-review"])
    await call(["run", "--task", name, "--writable", name + ".md:code-review"])
  }
  // 各任务登记不同 child（F-6 隔离：modelHints 按 childId 分键）
  const ja = await call(["agent-map", "--task", "iso-a", "--key", "w2-aaa", "--agent", "child-A1"])
  // w2-aaa 不是 iso-a 的 key（各自任务的 key 不同）——先取真实 key
  const taskA = await loadTask(root, "iso-a", { workflow: { stages: [{ id: "code-review", teamScene: "code-review" }] }, policy: {} })
  const keyA = taskA.journal.filter((e) => e.type === "dispatched").at(-1).detail.key
  const taskB = await loadTask(root, "iso-b", { workflow: { stages: [{ id: "code-review", teamScene: "code-review" }] }, policy: {} })
  const keyB = taskB.journal.filter((e) => e.type === "dispatched").at(-1).detail.key
  const ra = await call(["agent-map", "--task", "iso-a", "--key", keyA, "--agent", "child-A1"])
  const rb = await call(["agent-map", "--task", "iso-b", "--key", keyB, "--agent", "child-B1"])
  assert.equal(ra.modelHint.model, "fam-one", "F-4 自定义池首选")
  assert.equal(rb.modelHint.model, "fam-one", "同档同首选")
  const agents = JSON.parse(await readFile(mapFile.replace("dsh.json", "agents.json"), "utf8"))
  assert.equal(agents.modelHints["child-A1"].model, "fam-one")
  assert.equal(agents.modelHints["child-B1"].model, "fam-one")
  assert.notEqual(agents.mappings[keyA], agents.mappings[keyB], "F-6 双任务映射分键不串")
})
