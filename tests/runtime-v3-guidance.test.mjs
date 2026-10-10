// 引导库与派单注入测试：检索层级、分层覆盖、按角色/场景注入、续派与在途重建。
import assert from "node:assert/strict"
import { mkdir, writeFile, readFile } from "node:fs/promises"
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

test("八视角已拆包：Owner 保留总目标但仅承担本包，不递归重建审查团队", async () => {
  const projectRoot = await makeProject()
  const call = caller(projectRoot)
  const objective = "对示例变更完成八视角审查，每个视角独立交付证据"
  const perspectives = ["需求", "缺陷安全", "错误处理", "逻辑", "测试", "类型", "规范", "影响"]
  const packages = perspectives.map((perspective, index) => ({
    id: "perspective-" + (index + 1),
    writable: ["FINDINGS-" + (index + 1) + ".md:code-review"],
    done: ["仅核验" + perspective + "视角并记录可定位证据"],
    dependsOn: [],
  }))
  await openTask(projectRoot, "perspective-t", { objective })
  const planned = await call(["plan", "--task", "perspective-t", "--packages", JSON.stringify(packages)])
  assert.equal(planned.ok, true)
  const dispatched = await call(["dispatch-plan", "--task", "perspective-t"])
  assert.equal(dispatched.waves.length, 8)
  for (const wave of dispatched.waves) {
    const ownPackage = packages.find((pkg) => pkg.id === wave.package)
    assert.equal(wave.role, "owner")
    assert.ok(wave.prompt.includes(objective), "总目标作为上下文保留")
    assert.ok(wave.prompt.includes(ownPackage.done[0]), "当前视角的完成标准必须随派单到达 Owner：" + wave.package)
    for (const other of packages.filter((pkg) => pkg.id !== wave.package)) {
      assert.ok(!wave.prompt.includes(other.done[0]), "其他包的完成标准不扩张当前 Owner 职责")
    }
    assert.match(wave.prompt, /仅承担.*本包|只承担.*本包|仅负责.*本包/, "总目标不得覆盖已分配的包职责")
    assert.match(wave.prompt, /不得.*(?:重建|重开|再建).*审查团队/, "已拆包后不得递归重建整套审查团队")
    assert.match(wave.prompt, /只读助手|只读子派单/, "仍允许限定范围的只读探索辅助")
    assert.match(wave.prompt, /不得继续委托|不继续委托/, "只读辅助不得继续递归派发")
    assert.doesNotMatch(wave.prompt, /组合评审\/裁决仍覆盖/, "单包 Owner 不接组合职责")
  }
  const current = dispatched.waves.find((wave) => wave.package === "perspective-1")
  await call(["agent-map", "--task", "perspective-t", "--key", current.dispatchKey, "--agent", "fixture-owner"])
  const inflight = await call(["dispatch-plan", "--task", "perspective-t"])
  assert.equal(inflight.stop, "wait-inflight")
  for (const wave of inflight.inflight) {
    assert.match(wave.prompt, /不得重建整个审查团队/)
    assert.ok(wave.prompt.includes(packages.find((pkg) => pkg.id === wave.package).done[0]))
  }
  for (const wave of dispatched.waves) {
    const file = packages.find((pkg) => pkg.id === wave.package).writable[0].split(":")[0]
    await writeFile(path.join(projectRoot, file), "# 审查证据\n" + wave.package, "utf8")
    assert.equal((await call(["deliver", "--task", "perspective-t", "--key", wave.dispatchKey, "--outcome", "delivered", "--summary", "本包审查完成", "--paths", file])).accepted, true)
  }
  const challenger = (await call(["dispatch-plan", "--task", "perspective-t"])).waves[0]
  assert.equal(challenger.scope, "consolidation")
  assert.match(challenger.prompt, /组合评审.*本轮全部已交付包/)
  assert.doesNotMatch(challenger.prompt, /仅承担本包/)
  assert.match(challenger.prompt, /不得重建整个审查团队/)
  await call(["review", "--task", "perspective-t", "--key", challenger.dispatchKey, "--recommendation", "rework", "--summary", "补需求证据", "--findings", JSON.stringify([{ package: "perspective-1", severity: "risk", statement: "缺少需求证据" }])])
  const respond = (await call(["dispatch-plan", "--task", "perspective-t"])).waves[0]
  assert.equal(respond.package, "perspective-1")
  assert.equal(respond.continuation, true)
  assert.equal(respond.expectedAgentId, "fixture-owner", "续派仍复用原成员映射")
  assert.ok(!respond.prompt.includes(objective), "增量续派仍省略已知总目标")
  assert.ok(respond.promptFull.includes(objective), "断链重建仍带完整背景")
  const continuing = await call(["dispatch-plan", "--task", "perspective-t"])
  for (const prompt of [respond.prompt, respond.promptFull, continuing.inflight[0].prompt, continuing.inflight[0].promptFull]) {
    assert.match(prompt, /仅承担本包 perspective-1/)
    assert.match(prompt, /不得重建整个审查团队/)
    assert.ok(prompt.includes(packages[0].done[0]))
    assert.ok(!prompt.includes(packages[1].done[0]))
  }
  await call(["deliver", "--task", "perspective-t", "--key", respond.dispatchKey, "--outcome", "delivered", "--summary", "补齐需求证据", "--paths", "FINDINGS-1.md"])
  const crossReview = (await call(["dispatch-plan", "--task", "perspective-t"])).waves[0]
  assert.equal(crossReview.scope, "consolidation")
  await call(["review", "--task", "perspective-t", "--key", crossReview.dispatchKey, "--recommendation", "accept", "--summary", "组合核验通过"])
  const expert = (await call(["dispatch-plan", "--task", "perspective-t"])).waves[0]
  assert.equal(expert.role, "expert")
  assert.match(expert.prompt, /组合评审\/裁决仍覆盖本轮已交付包/)
  assert.match(expert.prompt, /不得重建整个审查团队/)
  assert.doesNotMatch(expert.prompt, /仅承担本包/)
  assert.match(expert.prompt, /review.*--verdict/)
})

test("轻量交叉审查：两类审查按相关视角执行，仍交付并经过 Challenger 与核心 Expert", async () => {
  for (const scene of ["code-review", "design-review"]) {
    const projectRoot = await makeProject({
      workflow: { stages: [{ id: scene, label: "审查", outputs: [scene], teamScene: scene }], gates: [], terminalStages: [] },
      policy: { ...IMPL_POLICY, scenes: { [scene]: { core: true } } },
    })
    const call = caller(projectRoot)
    await openTask(projectRoot, "cross-t", { objective: "审查示例局部修改", entry: scene })
    const dispatched = await call(["dispatch-plan", "--task", "cross-t", "--writable", "REVIEW.md:" + scene])
    assert.equal(dispatched.waves.length, 1)
    const owner = dispatched.waves[0]
    assert.doesNotMatch(owner.prompt, /本包完成标准|你仅承担本包|组合评审\/裁决仍覆盖/, "无包派单不臆造包、视角或组合职责")
    assert.match(owner.prompt, /默认.*轻量交叉审查/, "小场景不必按固定八视角拆包")
    assert.match(owner.prompt, /少量互补视角/, "视角按问题选择")
    assert.match(owner.prompt, /返工.*变更.*关联视角/, "返工不默认重开全部视角")
    assert.match(owner.prompt, /正式.*deliver/, "轻量审查仍属正式交付")
    if (scene === "code-review") assert.match(owner.prompt, /复杂完整.*代码交付|复杂状态.*并发/, "完整八视角有实质范围依据")
    else assert.match(owner.prompt, /不套用代码.*八视角/, "方案审查按方案问题选择")
    await writeFile(path.join(projectRoot, "REVIEW.md"), "# 审查\n范围与证据", "utf8")
    const delivered = await call(["deliver", "--task", "cross-t", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "审查完成", "--paths", "REVIEW.md"])
    assert.equal(delivered.accepted, true)
    const challenger = (await call(["dispatch-plan", "--task", "cross-t"])).waves[0]
    assert.equal(challenger.role, "challenger")
    assert.match(challenger.prompt, /已分配.*challenger.*不是 Lead/)
    assert.match(challenger.prompt, /不得重建整个审查团队/)
    await call(["review", "--task", "cross-t", "--key", challenger.dispatchKey, "--recommendation", "accept", "--summary", "独立核验通过"])
    const expert = (await call(["dispatch-plan", "--task", "cross-t"])).waves[0]
    assert.equal(expert.role, "expert")
    assert.match(expert.prompt, /已分配.*expert.*不是 Lead/)
    assert.match(expert.prompt, /review.*--verdict/)
  }
})

test("成员装载 skill：先遵守已分配职责，Lead 指引按问题选择正式审查覆盖", async () => {
  const skill = await readFile(new URL("../skills/team-work-v3/SKILL.md", import.meta.url), "utf8")
  const entry = skill.slice(0, skill.indexOf("## 判断指引"))
  assert.match(entry, /成员入口/, "先识别派单成员身份再进入 Lead 指引")
  assert.match(entry, /不执行 Lead.*开任务.*拆包.*正式波次/, "成员不得递归执行组团规程")
  const scenarios = await readFile(new URL("../skills/team-work-v3/references/scenarios.md", import.meta.url), "utf8")
  assert.match(scenarios, /默认.*正式轻量交叉审查/)
  assert.match(scenarios, /一个 Owner.*Challenger/)
  assert.doesNotMatch(scenarios, /预算只影响由谁承担，不能删减视角|非全视角抽查.*RO/)
  const policy = JSON.parse(await readFile(new URL("../team-work/policies/default.json", import.meta.url), "utf8"))
  assert.equal(policy.scenes["code-review"].requiredPerspectives, undefined, "可选视角目录不得声称是强制门禁")
  assert.equal(policy.scenes["code-review"].availablePerspectives.length, 8, "保留完整审查的可选方向")
})

test("方案场景：Owner、Challenger、返工和在途重建均带同一决策标准", async () => {
  const projectRoot = await makeProject({
    workflow: { stages: [{ id: "design", label: "方案设计", outputs: ["design"], teamScene: "design" }], gates: [], terminalStages: [] },
    policy: { ...IMPL_POLICY, scenes: { design: {} } },
  })
  const call = caller(projectRoot)
  await openTask(projectRoot, "design-t", { objective: "设计示例模块", entry: "design" })
  const d = await call(["dispatch-plan", "--task", "design-t", "--writable", "DESIGN.md:design"])
  assert.match(d.waves[0].prompt, /场景指引（design）/)
  assert.match(d.waves[0].prompt, /首屏/)
  assert.match(d.waves[0].prompt, /Owner 自检/)
  assert.doesNotMatch(d.waves[0].prompt, /场景指引（design-review）/)
  await writeFile(path.join(projectRoot, "DESIGN.md"), "# 方案\n示例设计", "utf8")
  await call(["deliver", "--task", "design-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成方案", "--paths", "DESIGN.md"])
  const r = await call(["dispatch-plan", "--task", "design-t"])
  assert.equal(r.waves[0].role, "challenger")
  assert.match(r.waves[0].prompt, /能否据此决定/)
  await call(["review", "--task", "design-t", "--key", r.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "补充取舍依据"])
  const rw = await call(["dispatch-plan", "--task", "design-t", "--writable", "DESIGN.md:design"])
  assert.equal(rw.waves[0].kind, "respond")
  assert.match(rw.waves[0].prompt, /本轮变化/)
  const status = await call(["run", "--task", "design-t"])
  const inflight = await call(["dispatch-plan", "--task", "design-t"])
  assert.equal(inflight.stop, "wait-inflight")
  for (const card of [status, inflight]) assert.match(card.inflight[0].prompt, /场景指引（design）/)
})

test("方案审查场景：审查派单不要求第二份方案，项目同名覆盖继续生效", async () => {
  const projectRoot = await makeProject({
    workflow: { stages: [{ id: "design-review", label: "方案审查", outputs: ["design-review"], teamScene: "design-review" }], gates: [], terminalStages: [] },
    policy: { ...IMPL_POLICY, scenes: { "design-review": {} } },
  })
  const call = caller(projectRoot)
  await openTask(projectRoot, "review-t", { objective: "审查示例方案", entry: "design-review" })
  const d = await call(["dispatch-plan", "--task", "review-t", "--writable", "REVIEW.md:design-review"])
  assert.match(d.waves[0].prompt, /场景指引（design-review）/)
  assert.match(d.waves[0].prompt, /不另写一份方案/)
  assert.doesNotMatch(d.waves[0].prompt, /场景指引（design）/)
  await writeFile(path.join(projectRoot, "REVIEW.md"), "# 审查报告\n示例发现", "utf8")
  await call(["deliver", "--task", "review-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成审查", "--paths", "REVIEW.md"])
  const r = await call(["dispatch-plan", "--task", "review-t"])
  assert.equal(r.waves[0].role, "challenger")
  assert.match(r.waves[0].prompt, /具体缺口/)
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes"), { recursive: true })
  await writeFile(path.join(projectRoot, "team-work/guidance/scenes/design-review.md"), "- 项目审查标准：核对兼容依据。", "utf8")
  const g = await loadGuidance(projectRoot)
  assert.equal(g.scenes["design-review"], "- 项目审查标准：核对兼容依据。")
  assert.ok(g.scenes.design, "未覆盖的设计场景保留基线")
  const inflight = await call(["dispatch-plan", "--task", "review-t"])
  assert.match(inflight.inflight[0].prompt, /核对兼容依据/)
  assert.doesNotMatch(inflight.inflight[0].prompt, /不另写一份方案/)
})

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
  const d = await call(["dispatch-plan", "--task", "impl-t", "--writable", "src.mjs:source"])
  assert.equal(d.stop, null)
  assert.equal(d.waves.length, 1)
  assert.match(d.waves[0].prompt, /## 角色指引（owner）/m)
  assert.match(d.waves[0].prompt, /先调研和理解/, "owner 通用纪律注入")
  assert.match(d.waves[0].prompt, /## 场景指引（implementation）/m)
  assert.match(d.waves[0].prompt, /最小改动范围/, "编码场景指引注入")
  assert.doesNotMatch(d.waves[0].prompt, /角色指引（challenger）/m)
  assert.doesNotMatch(d.waves[0].prompt, /场景指引（test）/m, "不串入其他场景引导")
})

test("派单注入：challenger 派单带 challenger 角色引导与同场景引导", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  const call = caller(projectRoot)
  await openTask(projectRoot, "impl-c", { objective: "实现模块 X", entry: "implementation" })
  const d = await call(["dispatch-plan", "--task", "impl-c", "--writable", "src.mjs:source"])
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "impl-c", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const r = await call(["dispatch-plan", "--task", "impl-c"])
  assert.equal(r.waves[0].role, "challenger")
  assert.match(r.waves[0].prompt, /## 角色指引（challenger）/m)
  assert.match(r.waves[0].prompt, /失败路径/, "challenger 通用纪律注入")
  assert.match(r.waves[0].prompt, /## 场景指引（implementation）/m, "评审按同一场景标准审视")
  assert.doesNotMatch(r.waves[0].prompt, /角色指引（owner）/m)
})

test("派单注入：续派与在途重建同样携带引导", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  const call = caller(projectRoot)
  await openTask(projectRoot, "impl-r", { objective: "实现模块 X", entry: "implementation" })
  const d = await call(["dispatch-plan", "--task", "impl-r", "--writable", "src.mjs:source"])
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "impl-r", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const r = await call(["dispatch-plan", "--task", "impl-r"])
  await call(["review", "--task", "impl-r", "--key", r.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "逻辑不完整"])
  const rw = await call(["dispatch-plan", "--task", "impl-r", "--writable", "src.mjs:source"])
  assert.equal(rw.waves[0].kind, "respond")
  assert.match(rw.waves[0].prompt, /# 续派/, "返工续派标头")
  assert.match(rw.waves[0].prompt, /## 角色指引（owner）/m, "续派仍注入角色引导")
  assert.match(rw.waves[0].prompt, /## 场景指引（implementation）/m, "续派仍注入场景引导")

  // F4：在途重建（respond 未交付时再次 dispatch-plan → wait-inflight stop 卡内嵌重建派单文本）
  const inflight = await call(["dispatch-plan", "--task", "impl-r"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.match(inflight.inflight[0].prompt, /## 角色指引（owner）/m, "在途重建文本携带引导")
})

test("派单注入：无引导文件的场景只注入角色引导，缺失静默跳过", async () => {
  const projectRoot = await makeProject({
    workflow: { stages: [{ id: "custom-review", label: "扩展审查", outputs: ["code-review"], teamScene: "custom-review" }], gates: [], terminalStages: [] },
    policy: { ...IMPL_POLICY, scenes: { "custom-review": {} } },
  })
  const call = caller(projectRoot)
  await openTask(projectRoot, "no-scene", { objective: "审查", entry: "custom-review" })
  const d = await call(["dispatch-plan", "--task", "no-scene", "--writable", "R.md:code-review"])
  assert.match(d.waves[0].prompt, /## 角色指引（owner）/m)
  assert.doesNotMatch(d.waves[0].prompt, /## 场景指引/m, "缺失场景引导静默跳过，不阻塞派发")
})
