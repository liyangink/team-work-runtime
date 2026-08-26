// 引导库与派单注入测试：检索层级、分层覆盖、按角色/场景注入、续派与在途重建。
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import test, { mock } from "node:test"

import { loadGuidance } from "../runtime-v3/guidance.mjs"
import { caller, makeProject, openTask } from "./support/v3-fixtures.mjs"

// implementation → test 两阶段工作流（teamScene 与引导库场景键同名）
const IMPL_WORKFLOW = {
  terminalStages: ["finish"],
  gates: [],
  stages: [
    { id: "implementation", label: "实施", outputs: ["source"], teamScene: "implementation" },
    { id: "test", label: "测试", outputs: ["test-code"], teamScene: "test" },
    { id: "finish", label: "收尾", outputs: [], teamScene: "finish" },
  ],
  edges: [
    { from: "implementation", to: "test", outcome: "pass" },
    { from: "test", to: "finish", outcome: "pass" },
  ],
}
const IMPL_POLICY = {
  maxAutonomousRounds: 3,
  costWeights: { junior: 1, senior: 10, expert: 50 },
  riskTiers: { critical: "expert", high: "senior" },
  scenes: { implementation: {}, test: {}, finish: {} },
}

test("loadGuidance：项目无自定义目录时使用包内基线（角色+场景两级）", async () => {
  const projectRoot = await makeProject()
  const g = await loadGuidance(projectRoot)
  assert.ok(g.roles.owner?.includes("先调研和理解"), "owner 角色引导来自包内基线")
  assert.ok(g.roles.challenger?.includes("成本、合理性"), "challenger 角色引导在场")
  assert.ok(g.roles.expert?.includes("verdict"), "expert 角色引导在场")
  assert.ok(g.scenes.implementation?.includes("最小改动范围"), "implementation 场景引导在场")
  assert.ok(g.scenes.test?.includes("@DisplayName"), "test 场景引导在场（公开注解可借用）")
})

test("loadGuidance：项目根同名文件逐文件覆盖，其余保留基线", async () => {
  const projectRoot = await makeProject()
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes"), { recursive: true })
  await writeFile(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), "# 编码场景指引\n\n- 只允许改动指定模块。", "utf8")
  const g = await loadGuidance(projectRoot)
  assert.ok(g.scenes.implementation.includes("只允许改动指定模块"), "项目自定义覆盖包内同名场景")
  assert.ok(!g.scenes.implementation.includes("最小改动范围"), "覆盖后基线文本不残留")
  assert.ok(g.scenes.test?.includes("薄适配层"), "未覆盖的场景保留包内基线")
  assert.ok(g.roles.owner, "未覆盖的角色保留包内基线")
})

test("loadGuidance：项目根 guidance 目录不存在时回退包内基线，不抛错", async () => {
  const g = await loadGuidance("/nonexistent-project-root-tw-guidance")
  assert.ok(g.roles.owner?.includes("先调研和理解"), "目录缺失静默回退包内基线")
  assert.ok(g.scenes.test, "场景基线同样在场")
})

test("loadGuidance：相对路径 projectRoot 同样启用项目覆盖层（不再静默跳过）", async () => {
  const projectRoot = await makeProject()
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes"), { recursive: true })
  await writeFile(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), "- 相对路径覆盖专用：只在相对 projectRoot 下可见。", "utf8")
  const rel = path.relative(process.cwd(), projectRoot)
  assert.ok(!path.isAbsolute(rel), "夹具临时目录相对 cwd 应为相对路径")
  const g = await loadGuidance(rel)
  assert.ok(g.scenes.implementation.includes("相对路径覆盖专用"), "相对 projectRoot 覆盖层生效")
  assert.ok(!g.scenes.implementation.includes("最小改动范围"), "覆盖后基线文本不残留")
  assert.ok(g.roles.owner, "未覆盖的角色保留包内基线")
})

test("loadGuidance：项目覆盖层文件读取失败向 stderr 打一次警告，目录缺失静默", async () => {
  const projectRoot = await makeProject()
  // "损坏" = 条目在场但 readFile 失败：同名目录（readFile 目录抛 EISDIR）模拟文件不可读
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), { recursive: true })
  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const g = await loadGuidance(projectRoot)
  assert.equal(warns.length, 1, "覆盖层损坏恰好一次警告：" + warns.join(" | "))
  assert.match(warns[0], /team-work\/guidance\/scenes\/implementation\.md/, "警告指明文件")
  assert.match(warns[0], /已回退包内基线/, "警告说明回退行为")
  assert.ok(g.scenes.implementation?.includes("最小改动范围"), "损坏覆盖回退包内基线")

  // 目录缺失（无覆盖目录）：静默，不产生任何警告
  const warns2 = []
  mock.method(console, "warn", (...args) => warns2.push(args.join(" ")))
  await loadGuidance("/nonexistent-project-root-tw-guidance")
  assert.equal(warns2.length, 0, "目录缺失静默无警告")
})

test("派单注入：owner 派单按角色+场景注入，不串入其他角色/场景引导", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  const call = caller(projectRoot)
  await openTask(projectRoot, "impl-t", { objective: "实现模块 X", entry: "implementation" })
  const d = await call(["run", "--task", "impl-t", "--writable", "src.mjs:source"])
  assert.equal(d.next, "dispatch")
  assert.match(d.dispatch.prompt, /## 角色指引（owner）/m)
  assert.match(d.dispatch.prompt, /先调研和理解/, "owner 通用纪律注入")
  assert.match(d.dispatch.prompt, /## 场景指引（implementation）/m)
  assert.match(d.dispatch.prompt, /最小改动范围/, "编码场景指引注入")
  assert.doesNotMatch(d.dispatch.prompt, /角色指引（challenger）/m)
  assert.doesNotMatch(d.dispatch.prompt, /场景指引（test）/m, "不串入其他场景引导")
})

test("派单注入：challenger 派单带 challenger 角色引导与同场景引导", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  const call = caller(projectRoot)
  await openTask(projectRoot, "impl-c", { objective: "实现模块 X", entry: "implementation" })
  const d = await call(["run", "--task", "impl-c", "--writable", "src.mjs:source"])
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "impl-c", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const r = await call(["run", "--task", "impl-c"])
  assert.equal(r.dispatch.role, "challenger")
  assert.match(r.dispatch.prompt, /## 角色指引（challenger）/m)
  assert.match(r.dispatch.prompt, /失败路径/, "challenger 通用纪律注入")
  assert.match(r.dispatch.prompt, /## 场景指引（implementation）/m, "评审按同一场景标准审视")
  assert.doesNotMatch(r.dispatch.prompt, /角色指引（owner）/m)
})

test("派单注入：续派与在途重建同样携带引导", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  const call = caller(projectRoot)
  await openTask(projectRoot, "impl-r", { objective: "实现模块 X", entry: "implementation" })
  const d = await call(["run", "--task", "impl-r", "--writable", "src.mjs:source"])
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "impl-r", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const r = await call(["run", "--task", "impl-r"])
  await call(["review", "--task", "impl-r", "--key", r.dispatch.key, "--recommendation", "rework", "--summary", "逻辑不完整"])
  const rw = await call(["run", "--task", "impl-r", "--writable", "src.mjs:source"])
  assert.equal(rw.dispatch.kind, "respond")
  assert.match(rw.dispatch.prompt, /# 续派/, "返工续派标头")
  assert.match(rw.dispatch.prompt, /## 角色指引（owner）/m, "续派仍注入角色引导")
  assert.match(rw.dispatch.prompt, /## 场景指引（implementation）/m, "续派仍注入场景引导")

  // F4：在途重建（respond 未交付时再次 run → wait-inflight 卡内嵌重建派单文本）
  const inflight = await call(["run", "--task", "impl-r"])
  assert.equal(inflight.next, "wait")
  assert.match(inflight.inflight[0].prompt, /## 角色指引（owner）/m, "在途重建文本携带引导")
})

test("派单注入：无引导文件的场景只注入角色引导，缺失静默跳过", async () => {
  // 默认夹具只有 code-review 场景，包内 guidance 无 scenes/code-review.md
  const projectRoot = await makeProject()
  const call = caller(projectRoot)
  await openTask(projectRoot, "no-scene", { objective: "审查", entry: "code-review" })
  const d = await call(["run", "--task", "no-scene", "--writable", "R.md:code-review"])
  assert.match(d.dispatch.prompt, /## 角色指引（owner）/m)
  assert.doesNotMatch(d.dispatch.prompt, /## 场景指引/m, "缺失场景引导静默跳过，不阻塞派发")
})
