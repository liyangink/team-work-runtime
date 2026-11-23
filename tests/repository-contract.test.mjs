import assert from "node:assert/strict"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relativePath) => readFile(path.join(projectRoot, relativePath), "utf8")

test("repository inventory contains only the current implementation", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  for (const relativePath of [...inventory.newImplementation, ...inventory.sharedBuild]) {
    await assert.doesNotReject(access(path.join(projectRoot, relativePath)), relativePath)
  }
  assert.equal("legacyArchive" in inventory, false)
  await assert.rejects(access(path.join(projectRoot, "archive")), (error) => error.code === "ENOENT")
  assert.ok(inventory.rules.some((rule) => rule.includes("Git history")))
})

test("v3 assets exist and historical trees are removed (git history preserves them)", async () => {
  for (const present of ["runtime-v3/cli.mjs", "bin/tw.mjs", "dsh/index.js", "dsh/client/badge.js", "cordis.patch.yml", "tests/e2e-root.test.mjs", "skills/team-work-v3/SKILL.md", "docs/runtime-v3-charter.md"]) {
    await assert.doesNotReject(access(path.join(projectRoot, present)), present)
  }
  for (const removed of ["plugins/opencode", "installer", "runtime", "runtime/application", "runtime/domain/reducer.mjs", "schemas/v2", "tests/v2", "packages/dsh-plugin", "scripts/install-local.mjs", "scripts/uninstall-local.mjs", "scripts/e2e-c1.mjs", "docs/phase3-plugin-plan.md", "docs/pre-phase3-plan.md", "dsh/inject.js", "dsh/tw-tool-subagent.js"]) {
    await assert.rejects(access(path.join(projectRoot, removed)), (error) => error.code === "ENOENT", removed)
  }
})

test("package metadata is intact (install simulation once caught corruption)", async () => {
  const pkg = JSON.parse(await read("package.json"))
  assert.equal(typeof pkg.name, "string")
  assert.ok(pkg.name.length > 0)
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, "version 语义化")
  assert.equal(typeof pkg.bin?.tw, "string")
  assert.ok(pkg.bin.tw.length > 0)
  assert.equal(pkg.main, "./dsh/index.js", "唯一根制品直接提供 DSH host 入口")
  assert.equal(pkg.exports?.["./client"], "./dsh/client/badge.js", "唯一根制品直接提供 Web client")
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "唯一根制品声明 DSH bundle patch")
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh"], ">=0.2.0-rc.2 <0.3.0-0", "允许 0.2 系列加载，但不纳入 0.3 预发布版")
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh-agent"], undefined, "模型注入安装器已下线")
  assert.equal(pkg.dependencies?.["@deepseek-ai/schemastery"], "~3.18.4", "直接使用的 schema 依赖在根制品声明")
  assert.ok(!pkg.files.some((entry) => entry.startsWith("packages/")), "唯一根制品不得收编旧 packages 子包")
  for (const entry of ["bin/", "cordis.patch.yml", "dsh/", "runtime-v3/", "skills/team-work-v3/", "skills/clarity-writing/", "skills/clarity-review/", "skills/clarity-guidance/", "workflow/definitions/", "team-work/policies/"]) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`)
  }
})

test("clarity 技能携带同级公共资源，必读段各只有一个原文来源", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  const files = [
    "skills/clarity-guidance/output-standard.md",
    "skills/clarity-writing/SKILL.md",
    "skills/clarity-review/SKILL.md",
    "skills/clarity-review/references/review-rules.md",
    "skills/clarity-review/references/standalone-records.md",
    "skills/clarity-review/references/examples.md",
  ]
  for (const file of files) {
    assert.ok(inventory.newImplementation.includes(file), file)
    assert.ok(!inventory.planned.includes(file), file)
  }
  for (const name of ["clarity-writing", "clarity-review"]) {
    const skill = await read(`skills/${name}/SKILL.md`)
    assert.ok(skill.startsWith(`---\nname: ${name}\n`), name)
    assert.ok(skill.includes("../clarity-guidance/output-standard.md"), "两个入口链接同一公共规范")
  }
  for (const file of [files[0], files[3]]) {
    const content = await read(file)
    const begin = "<!-- clarity:required:begin -->"
    const end = "<!-- clarity:required:end -->"
    assert.equal(content.split(begin).length, 2, `${file} 唯一开始标记`)
    assert.equal(content.split(end).length, 2, `${file} 唯一结束标记`)
    assert.ok(content.indexOf(begin) < content.indexOf(end), `${file} 标记顺序`)
    assert.ok(content.slice(content.indexOf(begin) + begin.length, content.indexOf(end)).trim(), `${file} 必读原文非空`)
  }
  await assert.rejects(access(path.join(projectRoot, "skills/clarity-guidance/SKILL.md")), (error) => error.code === "ENOENT", "公共资源不是第三个新技能")
  await assert.rejects(access(path.join(projectRoot, "skills/clarity-review/references/state-model.md")), (error) => error.code === "ENOENT", "状态模型并入独立记录，无副本")
})

test("dsh orchestration template stays consistent with skill surface", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /dsh-orchestration\.md/, "SKILL.md 链接编排模板")
  const template = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(template, /dispatch-plan/)
  assert.match(template, /tw-dispatch/)
  assert.match(template, /modelRef/)
})

test("team-work 主技能引导单任务分包、组合挑战与按实际波次推进", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  // 是否分包与包数量：可拆条件、不强拆、不预设包数均为主技能正文，不依赖参考文档
  assert.match(skill, /单任务分包与波次（Lead）/, "分包判断入口在主技能")
  assert.match(skill, /安全可拆时优先并行[^。]*不预设包数/, "拆分与包数量是语义判断，不预设数量")
  // 真实依赖与可写互斥：dependsOn 只给真实等待设置，依赖包的写范围也须互斥
  assert.match(skill, /只给必须等待上游交付的包设 dependsOn/, "依赖按真实上游交付设置")
  assert.match(skill, /整个计划包括依赖包的写范围均须互斥/, "依赖关系不解除可写互斥")
  // 正式派发与在途：同波部分交付不得提前派下一波
  assert.match(skill, /tw-dispatch 推进/, "DSH 以正式派发通道推进")
  assert.match(skill, /不因某一包先交而重复派发下一波/, "部分交付按在途恢复而非重复派发")
  // Challenger 组合覆盖与按包返工归属
  assert.match(skill, /非作者 Challenger 审当时已交付包的组合及接缝/, "组合挑战覆盖当波已交付组合")
  assert.match(skill, /未交付包只是计划，不作为缺交付的返工依据/, "未交付包不构成返工依据")
  assert.match(skill, /package 必须准确对应本次已交付且被评审的包/, "findings 包归属要求")
  assert.match(skill, /发现包名不匹配或返工结果与意见不一致，暂停推进/, "包归属异常时暂停而非改写结论")
  // 按实际返回波次完成评审、裁决与汇总，不写核心/非核心场景预测
  assert.match(skill, /按实际返回的波次完成评审、裁决及汇总，不自行增减角色/, "按实际返回波次推进")
  assert.match(skill, /不自行增减角色或预测下一波/, "不按场景预测下一波")
  assert.doesNotMatch(skill, /核心场景|非核心场景|核心 Expert/, "不写核心/非核心场景预测")
  assert.match(skill, /汇总交付后由 Challenger 覆盖新组合/, "汇总交付后组合再挑战")
  assert.match(skill, /保留既有人工门/, "组合变更不绕过人工门")
  // 异常与授权：已审版本变化、写冲突或授权争议暂停；待决卡不推进
  assert.match(skill, /已审内容发生变化[^。]*暂停受影响推进/, "已审版本变化时暂停受影响推进")
  assert.match(skill, /待决用户卡不派发、不轮询、不代答/, "待决用户卡静止")
  // 相邻表述纠正：多 Owner 各自聚焦，第三轮不自动 Expert
  assert.match(skill, /各 Owner 聚焦自己的范围/, "多包时各 Owner 聚焦各自范围")
  assert.doesNotMatch(skill, /一个 Owner 聚焦改动/, "不再保留单 Owner 聚焦表述")
  assert.doesNotMatch(skill, /第三轮 Expert/, "不再把第三轮自动 Expert 写成机器保障")
})

test("首卡、卡片标识与答复绑定写进 Lead 指引", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  // 首卡时序：open/plan/roles/intent 只作内部准备，首次推进签发唯一完整卡
  assert.match(skill, /在首卡签发前只返回内部准备回执/, "open/plan 只作内部准备不签卡")
  assert.match(skill, /在任务锁内签发唯一完整意图卡/, "首次推进在任务锁内签发唯一完整卡")
  assert.match(skill, /完整分包计划（每包 id\/model\/writable\/done\/dependsOn）/, "卡面含完整分包五字段")
  assert.match(skill, /未拆包时单 Owner 的首派可写范围与验收/, "无包时明示单 Owner 首派事实")
  // 答复绑定：从实际展示与答复上下文关联卡片，透传该卡 ID
  assert.match(skill, /实际展示的卡片及其上下文/, "从实际展示与答复上下文关联卡片")
  assert.match(skill, /将该卡 `decisionId` 原样传给 `tw decide --decision-id`/, "透传展示卡 ID 给 decide")
  assert.match(skill, /不能用最新待决卡的 ID 替换/, "不得用最新待决卡 ID 替换")
  assert.match(skill, /迟到旧卡 ID 返回 `DECISION_STALE`/, "迟到旧卡拒绝与恢复指引")
  assert.match(skill, /tw decide --task <名字> --choice <序号> \[--decision-id <卡片ID>\]/, "操作表列出 decision-id")
  // 拓扑与编排文档同步首卡时序和 ID 透传
  const topology = await read("skills/team-work-v3/references/topology-and-cost.md")
  assert.match(topology, /首次 `tw-dispatch`（无插件终端为 `dispatch-plan`）在任务锁内签发唯一完整意图卡/, "拓扑文档同步首卡时序")
  assert.match(topology, /答复携带实际展示卡的 `decisionId`/, "拓扑文档同步答复绑定")
  const dsh = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(dsh, /完整分包计划（每包 id\/model\/writable\/done\/dependsOn）/, "编排文档呈现完整包计划")
  assert.match(dsh, /答复按当前展示的卡把该 ID 透传给 `tw decide --decision-id`/, "编排文档透传展示卡 ID")
})

test("重签确认卡增量 Diff 与答复关联两条分支写进方案、Skill 与契约", async () => {
  // 方案增补：增量 Diff 规约作为实施基线，前四项已定案核心契约文字保持不变
  const plan = await read("docs/glm53-eval-findings-fix-plan.md")
  assert.match(plan, /### 重签确认卡的增量 Diff 展示（用户补充要求）/, "方案增补增量 Diff 小节")
  assert.match(plan, /最近一次已确认（`accept-intake`）快照/, "增量基准是最近一次已确认快照")
  assert.match(plan, /首屏突出增量变更/, "首屏突出增量变更")
  assert.match(plan, /未变更区块不重复展开/, "未变更项折叠引用")
  assert.match(plan, /[.]diff/, "结构化返回给出 intake.diff")
  assert.match(plan, /baseDecisionId, baseFingerprint, changes/, "结构化字段与 Runtime 接口一致")
  assert.match(plan, /unchangedFolded: true/, "结构化含未变更折叠标识")
  assert.match(plan, /kind: "added" [|] "removed" [|] "modified"/, "变更条目类型为新增/删除/修改")
  assert.match(plan, /首卡未确认前完整展示/, "首卡未确认前完整展示")
  assert.match(plan, /已有 `accept-intake` 确认后重签时，首屏标明基准卡 `baseDecisionId`/, "重签首屏标明基准卡")
  assert.match(plan, /缺少可核验完整快照时不伪造增量，安全回退完整卡并提示/, "历史缺快照回退完整卡")
  assert.match(plan, /diffBaselineUnavailable/, "回退有结构化标记")
  assert.match(plan, /完整[*][*] `intakeSnapshot` 计算/, "指纹仍覆盖完整快照")
  assert.match(plan, /SHA-256/, "指纹算法写明")
  assert.match(plan, /增量 Diff 不参与指纹、不放宽确认门/, "增量不改变确认语义")
  assert.match(plan, /unchangedCount/, "结构化含未变项计数")
  assert.match(plan, /识别与呈现分流/, "方案写识别与呈现分流")
  assert.match(plan, /不依赖 `question` 标题/, "识别不依赖 question 标题")
  // Skill 指引：重签卡增量呈现 + 单卡无歧义直接确认 + 多卡无法关联先澄清
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /首卡确认后，因意图、角色模型或包字段局部调整重签时，新卡只首屏突出相对最近一次已确认快照的增量变更/, "主技能写重签增量呈现")
  assert.match(skill, /未变更项折叠引用完整卡/, "主技能写未变更项折叠")
  assert.match(skill, /结构化 `intake.diff` 给出 `baseDecisionId`/, "主技能同步结构化 Diff 接口")
  assert.match(skill, /`intakeFingerprint`（SHA-256）与 `--decision-id` 仍绑定完整快照，增量只是呈现、不放宽确认/, "主技能写 SHA 仍覆盖完整快照")
  assert.match(skill, /卡类型按结构化返回识别/, "主技能写识别方式")
  assert.match(skill, /不能只看 `question` 标题/, "主技能明确不按标题识别")
  assert.match(skill, /unchangedCount/, "主技能结构化字段含未变项计数")
  assert.match(skill, /只展示过唯一一张完整卡 A、用户仅回复确认且语境无歧义时，直接按 A 的展示记录取 `decisionId` 调用 `tw decide`，不追问用户复述/, "单卡无歧义直接确认不追问")
  assert.match(skill, /多张卡均已展示而无法确定答复所指、或对话记录不完整时，先请用户澄清并暂停决定与派发，不猜/, "多卡无法关联先澄清")
  assert.match(skill, /不能用最新待决卡的 ID 替换/, "答复仍不得替换为最新待决卡 ID")
  // 三个 reference 同步：增量呈现与两条决策分支
  const topology = await read("skills/team-work-v3/references/topology-and-cost.md")
  assert.match(topology, /首卡确认后重签的卡只首屏突出相对最近一次已确认快照的增量变更/, "拓扑文档写重签增量")
  assert.match(topology, /结构化 `intake.diff` 给出变更条目与未变更折叠标识/, "拓扑文档同步结构化 Diff")
  assert.match(topology, /只展示过唯一一张完整卡 A、用户仅回复确认且语境无歧义时，直接按 A 的展示记录取 ID 确认，不追问/, "拓扑文档写单卡分支")
  assert.match(topology, /多张卡均已展示而无法确定答复所指时，先请用户澄清、暂停决定与派发，不猜/, "拓扑文档写多卡分支")
  const dsh = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(dsh, /不要只按 `question` 标题识别/, "编排文档不以标题识别卡型")
  assert.match(dsh, /增量重签卡（`intake.diff` 在场）只呈现 `intake.diff.changes` 的增量变更项/, "编排文档写增量卡呈现")
  assert.match(dsh, /结构化 `intake.diff` 含 `baseDecisionId`/, "编排文档同步结构化 Diff 接口")
  assert.match(dsh, /unchangedCount/, "编排文档含未变项计数")
  assert.match(dsh, /只展示过唯一一张完整卡 A、用户仅回复确认且无歧义时，直接按 A 的展示记录取 `decisionId` 调用 decide，不追问复述/, "编排文档写单卡分支")
  assert.match(dsh, /多张卡均已展示而无法关联时先请用户澄清，暂停决定与派发，不猜/, "编排文档写多卡分支")
  const scenarios = await read("skills/team-work-v3/references/scenarios.md")
  assert.match(scenarios, /首屏只呈现增量变更项与旧 → 新值并标明基准卡 `baseDecisionId`，未变更项折叠引用完整卡/, "场景文档写重签呈现")
  assert.match(scenarios, /只展示过唯一一张卡且答复无歧义时按该卡 ID 直接确认、不追问；多张卡无法关联时先澄清，暂停决定与派发/, "场景文档写两条分支")
  // 底层 SHA 与完整快照绑定在四份 Skill 可见文案中一致
  for (const surface of [
    "skills/team-work-v3/SKILL.md",
    "skills/team-work-v3/references/topology-and-cost.md",
    "skills/team-work-v3/references/dsh-orchestration.md",
    "skills/team-work-v3/references/scenarios.md",
  ]) {
    const text = await read(surface)
    assert.match(text, /intakeFingerprint/, surface + " 说明指纹绑定")
    assert.match(text, /intake[.]diff/, surface + " 说明结构化增量接口")
    assert.match(text, /完整快照|完整卡/, surface + " 说明未变项与指纹以完整快照为准")
  }
})

test("真实返回卡与编排指引的识别接缝：首卡、增量重签卡、基线缺失回退卡", async () => {
  const { makeProject, caller } = await import("./support/v3-fixtures.mjs")
  // 编排指引必须给出可执行的识别字段，不能只按 question 标题分支
  const dsh = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(dsh, /不要只按 `question` 标题识别/, "编排文档不以标题识别卡型")
  assert.match(dsh, /choices 含 `accept-intake`/, "意图卡按 accept-intake 选项识别")
  assert.match(dsh, /`intake.diff` 在场/, "增量卡按 intake.diff 识别")
  assert.match(dsh, /`diffBaselineUnavailable` 在场/, "回退卡按 diffBaselineUnavailable 识别")
  assert.match(dsh, /不逐项重展完整卡/, "增量卡不得重展完整卡")
  const plan = await read("docs/glm53-eval-findings-fix-plan.md")
  assert.match(plan, /识别与呈现分流/, "方案给出识别分流规则")
  assert.match(plan, /不依赖 `question` 标题/, "方案明确不按标题识别")

  // 夹具一：首卡 → 确认 → 改意图 → 增量重签卡（重复推进不重签）
  const rootA = await makeProject()
  try {
    const call = caller(rootA)
    const opened = await call(["open", "--name", "seam", "--objective", "接缝", "--entry", "code-review", "--raw-requirement", "用户原文"])
    assert.notEqual(opened.ok, false, "open 成功：" + JSON.stringify(opened))
    const planned = await call(["plan", "--task", "seam", "--packages", JSON.stringify([{ id: "a", writable: ["a/:design"], done: ["a完成"], dependsOn: [] }])])
    assert.notEqual(planned.ok, false, "plan 成功：" + JSON.stringify(planned))
    const first = await call(["dispatch-plan", "--task", "seam"])
    const firstCard = first.card ?? first
    assert.equal(first.stop, "awaiting-user", "首次推进静止在确认卡")
    assert.ok(firstCard.decisionId, "首卡带 decisionId")
    assert.equal(firstCard.intake.diff, undefined, "首卡无增量 diff")
    assert.equal(firstCard.intake.diffBaselineUnavailable, undefined, "首卡无回退标记")
    assert.ok((firstCard.choices ?? []).some((choice) => choice.grant === "accept-intake"), "首卡可按 accept-intake 识别")
    assert.ok(String(firstCard.question).startsWith("# 任务意图确认（intake-approval）"), "首卡标题为完整确认")
    const confirmed = await call(["decide", "--task", "seam", "--choice", "1", "--decision-id", firstCard.decisionId])
    assert.notEqual(confirmed.ok, false, "首卡确认成功：" + JSON.stringify(confirmed))
    const intent = await call(["intent", "--task", "seam", "--add-constraint", "新增约束"])
    const diffCard = intent.card ?? intent
    assert.ok(diffCard.intake?.diff, "改意图后返回增量 diff 卡")
    assert.equal(diffCard.intake.diff.baseDecisionId, firstCard.decisionId, "增量基准是已确认首卡")
    assert.equal(diffCard.intake.diff.unchangedFolded, true, "未变更项折叠标记")
    assert.equal(typeof diffCard.intake.diff.unchangedCount, "number", "未变更项计数为数字")
    assert.ok(diffCard.intake.diff.changes.some((change) => change.path === "intent.constraints[0]" && change.kind === "added"), "增量含新增约束条目")
    assert.ok(String(diffCard.question).startsWith("# 任务意图变更确认"), "增量卡标题与首卡不同")
    assert.match(String(diffCard.question), /已折叠引用该卡/, "增量卡说明未变更项折叠")
    assert.ok((diffCard.choices ?? []).some((choice) => choice.grant === "accept-intake"), "增量卡也可按 accept-intake 识别")
    const redispatch = await call(["dispatch-plan", "--task", "seam"])
    const redispatchCard = redispatch.card ?? redispatch
    assert.equal(redispatchCard.decisionId, diffCard.decisionId, "重复推进返回同一增量卡")
  } finally {
    await rm(rootA, { recursive: true, force: true })
  }

  // 夹具二：已确认记录缺少完整快照 → 安全回退完整卡并提示
  const rootB = await makeProject()
  try {
    const call = caller(rootB)
    await call(["open", "--name", "seam", "--objective", "回退", "--entry", "code-review", "--raw-requirement", "原文"])
    await call(["plan", "--task", "seam", "--packages", JSON.stringify([{ id: "a", writable: ["a/:design"], done: ["a完成"], dependsOn: [] }])])
    const first = await call(["dispatch-plan", "--task", "seam"])
    const firstCard = first.card ?? first
    await call(["decide", "--task", "seam", "--choice", "1", "--decision-id", firstCard.decisionId])
    const decisionsFile = path.join(rootB, ".team-work", "tasks", "seam", "decisions.json")
    const decisions = JSON.parse(await readFile(decisionsFile, "utf8"))
    const accepted = [...decisions.items].reverse().find((item) => item.gateId === "intake-approval" && item.grant === "accept-intake")
    assert.ok(accepted, "存在已确认意图决定")
    delete accepted.intakeSnapshot
    await writeFile(decisionsFile, JSON.stringify(decisions, null, 2))
    const fallback = await call(["intent", "--task", "seam", "--add-constraint", "回退约束"])
    const fallbackCard = fallback.card ?? fallback
    assert.equal(fallbackCard.intake.diff, undefined, "回退卡不带增量 diff")
    assert.equal(fallbackCard.intake.diffBaselineUnavailable, firstCard.decisionId, "回退标记指向最近已确认卡")
    assert.ok(String(fallbackCard.question).startsWith("（最近已确认卡缺少可核验的完整快照"), "回退卡开头提示基线缺失")
    assert.ok(String(fallbackCard.question).includes("# 任务意图确认（intake-approval）"), "回退卡仍呈现完整卡标题")
    assert.ok(String(fallbackCard.question).includes("## 完整分包计划"), "回退卡完整呈现分包计划")
    assert.ok((fallbackCard.choices ?? []).some((choice) => choice.grant === "accept-intake"), "回退卡选项可识别")
  } finally {
    await rm(rootB, { recursive: true, force: true })
  }
})

test("Lead 操作区明确 DSH 原生调用，tw plan 示例可直接执行", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /DSH 会话内直接调用原生 `tw` 工具/, "明确 DSH 会话内原生调用 tw")
  assert.match(skill, /`args` 是 CLI 参数字符串数组/, "args 是 CLI 参数数组")
  assert.match(skill, /正式波次使用原生 `tw-dispatch`/, "正式波次用原生 tw-dispatch")
  assert.match(skill, /插件自动注入当前调用的 `TW_DSH_CONFIG` 快照/, "配置快照由插件注入")
  // 示例必须是可解析 JSON：args 数组 + --packages 后单个 JSON 字符串 + 完整包字段方括号
  const blocks = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1])
  const example = blocks.map((block) => { try { return JSON.parse(block) } catch { return null } }).find((value) => Array.isArray(value?.args))
  assert.ok(example, "主技能含可解析的原生调用 JSON 示例")
  assert.deepEqual(example.args.slice(0, 2), ["plan", "--task"], "示例以 args 数组调用 tw plan")
  const packagesIndex = example.args.indexOf("--packages")
  assert.ok(packagesIndex > 0, "示例通过 --packages 传入计划")
  const packagesRaw = example.args[packagesIndex + 1]
  assert.equal(typeof packagesRaw, "string", "--packages 后是一个 JSON 字符串，不是 shell 参数")
  const packages = JSON.parse(packagesRaw)
  assert.equal(packages.length, 2, "示例含两个包")
  for (const item of packages) {
    assert.ok(Array.isArray(item.writable) && item.writable.length > 0, "writable 是完整方括号数组")
    assert.ok(Array.isArray(item.done) && item.done.length > 0, "done 是完整方括号数组")
    assert.ok(Array.isArray(item.dependsOn), "dependsOn 是完整方括号数组（无依赖为空数组）")
  }
  // 隔离夹具执行同一示例：两包均被接受，字段按数组完整落盘
  const { makeProject, caller } = await import("./support/v3-fixtures.mjs")
  const isolatedRoot = await makeProject()
  try {
    const call = caller(isolatedRoot)
    const opened = await call(["open", "--name", "example-task", "--objective", "示例任务", "--entry", "code-review", "--raw-requirement", "用户原文"])
    assert.notEqual(opened.ok, false, "隔离夹具 open 成功：" + JSON.stringify(opened))
    const planned = await call(["plan", "--task", "example-task", "--packages", packagesRaw])
    assert.notEqual(planned.ok, false, "原生示例可被 tw plan 接受：" + JSON.stringify(planned))
    const persisted = JSON.parse(await readFile(path.join(isolatedRoot, ".team-work", "tasks", "example-task", "packages.json"), "utf8"))
    assert.equal(persisted.items.length, 2, "两包均落盘")
    for (const item of persisted.items) {
      assert.ok(Array.isArray(item.writable) && item.writable.length > 0, item.id + " writable 完整")
      assert.ok(Array.isArray(item.done) && item.done.length > 0, item.id + " done 完整")
      assert.ok(Array.isArray(item.dependsOn), item.id + " dependsOn 完整")
    }
    assert.deepEqual(persisted.items.find((item) => item.id === "merge")?.dependsOn, ["draft"], "依赖关系按数组落盘")
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true })
  }
})

test("AGENTS.md preserves core collaboration invariants", async () => {
  const agents = await read("AGENTS.md")
  assert.match(agents, /任意研发阶段创建并介入/)
  assert.match(agents, /非作者 Senior 或 Expert 挑战/)
  assert.match(agents, /只读子派单/)
  assert.match(agents, /不得重新引入[^。\n]*旧版资产/)
  assert.match(agents, /名字寻址/)
  assert.match(agents, /状态从事实源推导/)
  assert.match(agents, /工具调用是唯一检查点/)
})

test("charter documents have valid local links", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  const markdownFiles = inventory.newImplementation.filter((file) => file.endsWith(".md"))
  for (const relativeFile of markdownFiles) {
    const content = await read(relativeFile)
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0]
      if (!target || /^(?:https?:|mailto:|file:)/.test(target)) continue
      const resolved = path.resolve(projectRoot, path.dirname(relativeFile), decodeURIComponent(target))
      await assert.doesNotReject(access(resolved), `${relativeFile} links to missing ${target}`)
    }
  }
})

test("成本判据与升档审批已从用户可见文案与 kernel 清理（§9.3 反向断言）", async () => {
  const surfaces = [
    "README.md",
    "skills/team-work-v3/SKILL.md",
    "skills/team-work-v3/references/topology-and-cost.md",
    "skills/team-work-v3/references/scenarios.md",
    "skills/team-work-v3/references/dsh-orchestration.md",
    "skills/team-work-v3/references/rules.md",
    "team-work/rules/lead/README.md",
    "dsh/settings.js",
    "dsh/client/badge.js",
    "dsh/tw-dispatch.js",
  ]
  for (const surface of surfaces) {
    const text = await read(surface)
    assert.doesNotMatch(text, /升档审批|权重倍数|approve-escalation|按失败成本升档|默认 junior|赚便宜|单位成本最低/, surface + " 不得保留旧成本判据或升档审批文案")
  }
  const kernel = await read("policy/kernel.mjs")
  assert.doesNotMatch(kernel, /COST_WEIGHTS|costWeightForTier/, "kernel 死常量已删除")
  for (const surface of ["runtime-v3/cli.mjs", "runtime-v3/waves.mjs", "runtime-v3/derive.mjs", "runtime-v3/store.mjs", "dsh/subagent-session.js"]) {
    const text = await read(surface)
    assert.doesNotMatch(text, /COST_WEIGHTS|costWeightForTier/, surface + " 不得引用已删除的成本常量")
  }
  // 文档与默认策略的数据链说明在位（避免只删不补）。
  const defaultPolicy = JSON.parse(await read("team-work/policies/default.json"))
  assert.deepEqual(defaultPolicy.roles, { owner: "junior", challenger: "senior", expert: "expert" }, "default.json 提供 roles 兜底段")
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  assert.ok(inventory.newImplementation.includes("docs/dispatch-intent-optimization-plan.md"), "file-inventory 登记本次方案")
  assert.ok(inventory.newImplementation.includes("docs/glm53-eval-findings-fix-plan.md"), "file-inventory 登记 GLM-5.3 修复方案")
  assert.ok(inventory.newImplementation.includes("docs/parallel-package-guidance-plan.md"), "file-inventory 登记已批准的分包方案")
  assert.ok(inventory.newImplementation.includes("docs/lead-reporting-alignment-plan.md"), "file-inventory 登记已批准的汇报方案")
})

test("正式派发选档与核心场景预测已从 Skill 清理", async () => {
  const surfaces = [
    "skills/team-work-v3/SKILL.md",
    "skills/team-work-v3/references/topology-and-cost.md",
    "skills/team-work-v3/references/dsh-orchestration.md",
    "skills/team-work-v3/references/scenarios.md",
  ]
  for (const surface of surfaces) {
    const text = await read(surface)
    assert.doesNotMatch(text, /--risk/, surface + " 不得引导 --risk 升档")
    assert.doesNotMatch(text, /tier:senior|tier: "expert"/, surface + " 不得给 tier 选档示例")
    assert.doesNotMatch(text, /核心场景|非核心场景|核心 Expert|核心跨模块|核心重裁|核心技术分歧/, surface + " 不得写核心/非核心场景预测")
    assert.doesNotMatch(text, /需要更强或更弱的模型|按任务类型主动选档|自行调整模型|档位用途/, surface + " 不得引导主动换档")
  }
  // 普通委派、只读助手与精确选模边界保留，不误伤角色名
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /普通委派、用户指定档位、成员在任务期间开的只读助手用原生 `subagent`/, "保留用户指定档位的普通委派")
  assert.match(skill, /junior 只读助手/, "保留成员 junior 只读助手")
  const topology = await read("skills/team-work-v3/references/topology-and-cost.md")
  assert.match(topology, /普通选档委派、只读助手和 `@` 候选使用原生工具/, "保留普通选档委派与只读助手")
  const dsh = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(dsh, /`@junior` \/ `@senior` \/ `@expert`/, "保留用户点名档位入口")
  assert.match(dsh, /list_subagent_models/, "保留精确选模查询")
  assert.doesNotMatch(dsh, /主动选档/, "不再把正式派发选档写成 Lead 主动动作")
})
