// 规则库测试：runtime-v3/rules.mjs 的解析与合成（三标题、来源顺序、场景隔离、三层合并、读失败、
// 无缓存、锁定契约），以及 cli.mjs 的接线——派单卡段序与来源、成员卡单块业务正文、Lead 按时点反吐、
// 场景/角色规则到达与 clarity 同源短段。
// 夹具全部落在临时目录：包内层用 packageRoot 注入、用户层用 userRulesRoot 注入、项目层用 projectRoot 注入，
// 不依赖也不修改仓库真实的 team-work/rules/ 与真实主目录。
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { mock } from "node:test"

import { resolveMemberRules, resolveLeadRules, composeMemberRules, lockedWorkflowContract, requiredClarityText, createClarityGuidanceReader } from "../runtime-v3/rules.mjs"
import { autoCaller, makeProject, openTask } from "./support/v3-fixtures.mjs"

async function makeRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tw-rules-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// 直接把内容写到 root 下指定相对路径（用户公共层夹具：该目录本身就是规则根）
async function writeAt(root, relative, text) {
  const file = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, "utf8")
  return file
}

// 包内层 / 项目层夹具：规则库固定位于 <root>/team-work/rules/
function writeRule(root, relative, text) {
  return writeAt(root, "team-work/rules/" + relative, text)
}

// 完整 teamScene 集合的事实来源：工作流定义 stages[].teamScene
async function writeDefinition(root, scenes) {
  const file = path.join(root, "workflow", "definitions", "engineering.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ stages: scenes.map((teamScene) => ({ teamScene })) }), "utf8")
  return file
}

// 测试默认禁用用户公共层（显式 null），保证断言不受真实 ~/.team-work/rules 影响。
const resolveMember = (options = {}) => resolveMemberRules({ userRulesRoot: null, ...options })
const resolveLead = (options = {}) => resolveLeadRules({ userRulesRoot: null, ...options })

function pairs(rules) {
  return rules.map((rule) => rule.source + ":" + rule.name)
}

function composeLines(...lines) {
  return lines.join("\n")
}

test("成员规则只取 ## 规范/## 红线/## 建议 标题下的正文，其他内容不注入", async (t) => {
  const pkg = await makeRoot(t)
  await writeRule(pkg, "owner/README.md", [
    "# 角色规则",
    "",
    "标题外前言不注入。",
    "",
    "## 规范",
    "",
    "- 规范条目一",
    "",
    "### 子标题留在正文",
    "",
    "- 规范条目二",
    "",
    "## 红线",
    "",
    "- 红线条目",
    "",
    "## 建议",
    "",
    "- 建议条目",
    "",
    "## 其他",
    "",
    "- 其他段不注入",
  ].join("\n"))
  // CRLF 文件：解析后正文不混入回车
  await writeRule(pkg, "owner/design/index.md", "## 规范\r\n\r\n- CRLF 条目\r\n")
  const rules = await resolveMember({ role: "owner", teamScene: "design", packageRoot: pkg, teamScenes: ["design"] })
  assert.deepEqual(pairs(rules), ["role:owner/README.md", "role-scene:owner/design/index.md"])
  assert.deepEqual(rules[0].sections, {
    规范: "- 规范条目一\n\n### 子标题留在正文\n\n- 规范条目二",
    红线: "- 红线条目",
    建议: "- 建议条目",
  })
  assert.deepEqual(rules[1].sections, { 规范: "- CRLF 条目", 红线: "", 建议: "" })
  assert.equal(composeMemberRules(rules), composeLines(
    "## 规范", "",
    "- 规范条目一", "",
    "### 子标题留在正文", "",
    "- 规范条目二", "",
    "- CRLF 条目", "",
    "## 红线", "",
    "- 红线条目", "",
    "## 建议", "",
    "- 建议条目",
  ))
})

test("成员规则来源顺序为 角色 → 角色×场景 → 场景公共 → 公共通用，类内按文件名排序", async (t) => {
  const pkg = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 公共通用 I")
  await writeRule(pkg, "common/zzz.md", "## 规范\n\n- 公共通用 Z")
  await writeRule(pkg, "common/design.md", "## 规范\n\n- 场景公共")
  await writeRule(pkg, "owner/README.md", "## 规范\n\n- 角色根")
  await writeRule(pkg, "owner/design/index.md", "## 规范\n\n- 角色场景 I")
  await writeRule(pkg, "owner/design/notes.md", "## 规范\n\n- 角色场景 N")
  await writeRule(pkg, "owner/test/index.md", "## 规范\n\n- 其他场景不注入")
  await writeRule(pkg, "challenger/README.md", "## 规范\n\n- 其他角色不注入")
  const rules = await resolveMember({ role: "owner", teamScene: "design", packageRoot: pkg, teamScenes: ["design", "test"] })
  assert.deepEqual(pairs(rules), [
    "role:owner/README.md",
    "role-scene:owner/design/index.md",
    "role-scene:owner/design/notes.md",
    "scene:common/design.md",
    "common:common/index.md",
    "common:common/zzz.md",
  ])
  assert.equal(composeMemberRules(rules), composeLines(
    "## 规范", "",
    "- 角色根", "",
    "- 角色场景 I", "",
    "- 角色场景 N", "",
    "- 场景公共", "",
    "- 公共通用 I", "",
    "- 公共通用 Z",
  ))
})

test("场景隔离：场景文只进同名场景且只注入一次，其他场景文件完全不注入", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  for (const scene of ["design", "implementation", "code-review"]) await writeRule(pkg, "common/" + scene + ".md", "## 规范\n\n- 场景文 " + scene)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 公共通用")
  await writeRule(pkg, "common/extra.md", "## 规范\n\n- 场景名之外的通用文")
  // 项目层同样按完整集合分类：项目新增的其他场景文件不串入本次派单
  await writeRule(project, "common/e2e.md", "## 规范\n\n- 项目新增的场景文 e2e")
  await writeRule(project, "common/notes.md", "## 规范\n\n- 项目新增的通用文")
  const teamScenes = ["design", "implementation", "code-review", "e2e"]
  const design = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes })
  const implementation = await resolveMember({ role: "owner", teamScene: "implementation", projectRoot: project, packageRoot: pkg, teamScenes })
  assert.deepEqual(pairs(design), ["scene:common/design.md", "common:common/extra.md", "common:common/index.md", "common:common/notes.md"])
  assert.deepEqual(pairs(implementation), ["scene:common/implementation.md", "common:common/extra.md", "common:common/index.md", "common:common/notes.md"])
  assert.equal(design.filter((rule) => rule.source === "scene").length, 1, "当前场景文只注入一份")
  assert.ok(!pairs(design).some((pair) => pair.includes("implementation") || pair.includes("code-review") || pair.includes("e2e")), "其他场景零注入：" + pairs(design).join(" | "))
})

test("完整 teamScene 集合缺省时取自工作流定义：项目优先、包内回退；两层都缺时警告并按空集判定", async (t) => {
  const pkg = await makeRoot(t)
  await writeRule(pkg, "common/alpha.md", "## 规范\n\n- 场景文 alpha")
  await writeRule(pkg, "common/beta.md", "## 规范\n\n- 场景文 beta")
  await writeRule(pkg, "common/gamma.md", "## 规范\n\n- 通用文 gamma")
  await writeDefinition(pkg, ["alpha", "beta"])
  const project = await makeRoot(t)
  await writeDefinition(project, ["alpha", "beta"])
  const fromProject = await resolveMember({ role: "owner", teamScene: "beta", projectRoot: project, packageRoot: pkg })
  assert.deepEqual(pairs(fromProject), ["scene:common/beta.md", "common:common/gamma.md"])

  // 项目根没有定义：回退包内定义，分类口径不变
  const bare = await makeRoot(t)
  const fromPackage = await resolveMember({ role: "owner", teamScene: "beta", projectRoot: bare, packageRoot: pkg })
  assert.deepEqual(pairs(fromPackage), ["scene:common/beta.md", "common:common/gamma.md"])

  // 两层定义都缺：按空集判定并警告；当前场景同名文件仍只注入一次
  const noDefinition = await makeRoot(t)
  await writeRule(noDefinition, "common/alpha.md", "## 规范\n\n- 无定义时的 alpha")
  await writeRule(noDefinition, "common/beta.md", "## 规范\n\n- 无定义时的 beta")
  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const fallback = await resolveMember({ role: "owner", teamScene: "beta", projectRoot: bare, packageRoot: noDefinition })
  assert.equal(warns.length, 1, "集合缺失恰好一次警告：" + warns.join(" | "))
  assert.match(warns[0], /teamScene 集合/)
  assert.deepEqual(pairs(fallback), ["scene:common/beta.md", "common:common/alpha.md"])
})

test("同路径追加：基线层正文在前、项目同标题内容在后；项目只能增补不能删除基线默认", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 包内规范")
  await writeRule(pkg, "owner/README.md", "## 规范\n\n- 包内角色规范\n\n## 红线\n\n- 包内角色红线")
  await writeRule(project, "common/index.md", "## 规范\n\n- 项目规范补充")
  await writeRule(project, "owner/README.md", "## 红线\n\n- 项目角色红线补充")
  await writeRule(project, "owner/design/notes.md", "## 建议\n\n- 项目新增角色场景建议")
  const rules = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.deepEqual(pairs(rules), ["role:owner/README.md", "role-scene:owner/design/notes.md", "common:common/index.md"])
  assert.deepEqual(rules[0].sections, {
    规范: "- 包内角色规范",
    红线: "- 包内角色红线\n\n- 项目角色红线补充",
    建议: "",
  })
  assert.equal(rules[1].sections.建议, "- 项目新增角色场景建议")
  assert.equal(rules[2].sections.规范, "- 包内规范\n\n- 项目规范补充")
  assert.equal(composeMemberRules(rules), composeLines(
    "## 规范", "",
    "- 包内角色规范", "",
    "- 包内规范", "",
    "- 项目规范补充", "",
    "## 红线", "",
    "- 包内角色红线", "",
    "- 项目角色红线补充", "",
    "## 建议", "",
    "- 项目新增角色场景建议",
  ))

  // 包内根与项目根为同一目录：不做自身追加（否则同一正文重复一遍）
  const sameRoot = await resolveMember({ role: "owner", teamScene: "design", projectRoot: pkg, packageRoot: pkg, teamScenes: ["design"] })
  assert.equal(sameRoot[0].sections.规范, "- 包内角色规范")
  assert.equal(sameRoot[0].sections.红线, "- 包内角色红线")
  assert.equal(composeMemberRules(sameRoot).split("- 包内角色规范").length - 1, 1, "同一正文只出现一次")
})

test("没有三标题的文件不注入：标题外正文与旧式条目前缀都不算规则（项目追加同理）", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/legacy.md", "- 红线：旧式无标题条目\n- 建议：旧式建议")
  await writeRule(pkg, "common/other.md", "## 其他\n\n- 不属于三段的条目")
  // 项目只写一句补充（不带三标题）：按同一口径不注入，需要注入时写在对应标题下
  await writeRule(project, "owner/design/notes.md", "项目只写一句补充，没有标题")
  const rules = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.deepEqual(rules, [])
  assert.equal(composeMemberRules(rules), "")
})

test("卡上只输出非空段：顺序固定 规范 → 红线 → 建议，空段连标题一起省略", async (t) => {
  const pkg = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 建议\n\n- 只有建议")
  await writeRule(pkg, "owner/README.md", "## 红线\n\n- 只有红线")
  const rules = await resolveMember({ role: "owner", teamScene: "design", packageRoot: pkg, teamScenes: ["design"] })
  assert.equal(composeMemberRules(rules), composeLines("## 红线", "", "- 只有红线", "", "## 建议", "", "- 只有建议"))
})

test("读失败：包内条目静默跳过，项目追加失败警告一次且基线默认完整在场", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 包内通用规则")
  // "损坏" = 条目在场但 readFile 失败：同名目录（readFile 抛 EISDIR）模拟不可读
  await mkdir(path.join(pkg, "team-work", "rules", "common", "broken.md"), { recursive: true })
  const silent = []
  mock.method(console, "warn", (...args) => silent.push(args.join(" ")))
  const packageOnly = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.deepEqual(pairs(packageOnly), ["common:common/index.md"], "包内损坏条目缺席，派发不阻塞")
  assert.deepEqual(silent, [], "包内读失败静默；项目侧目录缺失同样静默")

  // 项目追加条目损坏：警告一次并跳过该追加，基线层仍完整
  await mkdir(path.join(project, "team-work", "rules", "common", "index.md"), { recursive: true })
  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const appended = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.equal(warns.length, 1, "项目追加损坏恰好一次警告：" + warns.join(" | "))
  assert.match(warns[0], /team-work\/rules\/common\/index\.md/, "警告指明具体文件")
  assert.match(warns[0], /已跳过该条项目追加/)
  assert.equal(appended[0].sections.规范, "- 包内通用规则")
})

test("无模块级缓存：每次调用重读，内容修改、新增与删除立即生效", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 第一版")
  const read = () => resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.equal((await read())[0].sections.规范, "- 第一版")
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 第二版")
  assert.equal((await read())[0].sections.规范, "- 第二版", "下次调用读到修改后的正文")
  await writeRule(project, "common/index.md", "## 建议\n\n- 项目建议")
  assert.deepEqual((await read())[0].sections, { 规范: "- 第二版", 红线: "", 建议: "- 项目建议" }, "项目层新标题立即参与合并")
  await rm(path.join(pkg, "team-work", "rules", "common", "index.md"))
  assert.deepEqual((await read())[0].sections, { 规范: "", 红线: "", 建议: "- 项目建议" }, "包内删除后只剩项目追加")
  await rm(path.join(project, "team-work", "rules", "common", "index.md"))
  assert.deepEqual(await read(), [], "两层都删除后整条缺席")
})

test("Lead 规则：按呈现时点整文件读取，不套三标题；同路径追加、库根说明不参与", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "lead/README.md", "库根说明不进入反吐通道")
  await writeRule(pkg, "lead/dispatch/index.md", "向用户简报派发内容。\n\n## 任意标题\n\n标题也原样保留。")
  await writeRule(pkg, "lead/dispatch/extra.md", "派发补充规则")
  await writeRule(pkg, "lead/progress/index.md", "进展时点规则")
  await writeRule(pkg, "lead/decision/index.md", "决定时点规则")
  await writeRule(project, "lead/dispatch/index.md", "项目派发补充")
  const dispatch = await resolveLead({ kind: "dispatch", projectRoot: project, packageRoot: pkg })
  assert.deepEqual(pairs(dispatch), ["lead:lead/dispatch/extra.md", "lead:lead/dispatch/index.md"])
  assert.equal(dispatch[1].text, "向用户简报派发内容。\n\n## 任意标题\n\n标题也原样保留。\n\n项目派发补充", "Lead 通道不做三标题分段")
  assert.ok(!dispatch.some((rule) => rule.name === "lead/README.md"), "库根说明文件不注入")
  assert.deepEqual(pairs(await resolveLead({ kind: "progress", packageRoot: pkg })), ["lead:lead/progress/index.md"])
  assert.deepEqual(await resolveLead({ kind: "nope", packageRoot: pkg }), [], "无该时点目录时为空")
})

test("空库返回空数组与空文本；角色、场景、时点键必须是单段标识", async (t) => {
  const pkg = await makeRoot(t)
  const project = await makeRoot(t)
  assert.deepEqual(await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] }), [])
  assert.equal(composeMemberRules([]), "")
  assert.equal(composeMemberRules(undefined), "")
  assert.deepEqual(await resolveMember({ role: "owner", projectRoot: project, packageRoot: pkg, teamScenes: [] }), [], "无场景键时只解析角色与公共通用两层")
  await assert.rejects(() => resolveMember({ teamScene: "design", packageRoot: pkg }), TypeError)
  await assert.rejects(() => resolveMember({ role: "../owner", packageRoot: pkg }), TypeError)
  await assert.rejects(() => resolveMember({ role: "owner", teamScene: "../design", packageRoot: pkg }), TypeError)
  await assert.rejects(() => resolveMember({ role: "owner", packageRoot: pkg, teamScenes: ["../design"] }), TypeError)
  await assert.rejects(() => resolveLead({ kind: "../dispatch", packageRoot: pkg }), TypeError)
})

test("包内锁定工作流契约按角色固定输出，覆盖身份、争议停手、工具合同与只读助手边界", () => {
  const owner = lockedWorkflowContract("owner")
  assert.equal(owner.split("\n")[0], "## 工作流职责（TWR 固定契约）", "固定段标题")
  assert.ok(owner.includes("\n\n- "), "标题后是条目列表")
  assert.ok(!owner.endsWith("\n"), "返回值不带结尾空行")
  assert.match(owner, /已分配的 Owner 成员，不是 Lead/)
  assert.match(owner, /不得自行开任务、拆包、派发正式波次或重建审查团队/)
  assert.match(owner, /deliver --outcome blocked/)
  assert.match(owner, /不提前造新设施|不先造新设施/)
  assert.match(owner, /deliver 工具提交/)
  assert.match(owner, /junior 只读助手/)
  assert.match(owner, /不得读取项目外目录/)
  assert.match(owner, /不读取任何外部规则目录/)
  assert.match(owner, /不被用户公共目录或项目规则覆盖/)

  const challenger = lockedWorkflowContract("challenger")
  assert.match(challenger, /Challenger/)
  assert.match(challenger, /review --recommendation escalate/)
  assert.match(challenger, /旧结论失效/)
  assert.match(challenger, /review 工具提交/)

  const expert = lockedWorkflowContract("expert")
  assert.match(expert, /Expert/)
  assert.match(expert, /escalate-to-user/)
  assert.match(expert, /旧裁决自动失效/)
  assert.match(expert, /verdict/)

  assert.equal(owner, lockedWorkflowContract("owner"), "同一角色输出稳定、不读盘")
  assert.throws(() => lockedWorkflowContract("lead"), TypeError)
  assert.throws(() => lockedWorkflowContract(), TypeError)
})

test("用户公共层优先于包内默认，项目追加在基线层之后；缺省回退与禁用手法符合约定", async (t) => {
  const pkg = await makeRoot(t)
  const user = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 包内规范")
  await writeRule(pkg, "common/fallback.md", "## 建议\n\n- 包内回退条目")
  await writeRule(pkg, "owner/README.md", "## 规范\n\n- 包内角色规范\n\n## 红线\n\n- 包内角色红线")
  await writeAt(user, "common/index.md", "## 规范\n\n- 用户改写规范")
  await writeAt(user, "owner/README.md", "## 红线\n\n- 用户改写红线")
  await writeRule(project, "common/index.md", "## 规范\n\n- 项目追加规范")
  const rules = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, userRulesRoot: user, teamScenes: ["design"] })
  assert.deepEqual(pairs(rules), ["role:owner/README.md", "common:common/fallback.md", "common:common/index.md"])
  assert.deepEqual(rules[0].sections, { 规范: "", 红线: "- 用户改写红线", 建议: "" }, "用户版本整份取代包内默认")
  assert.equal(rules[1].sections.建议, "- 包内回退条目", "用户层没有的文件回退包内默认")
  assert.equal(rules[2].sections.规范, "- 用户改写规范\n\n- 项目追加规范", "项目追加在基线层之后")

  // 用户把文件清空 = 整份覆盖为空（用户层允许删减默认条目），包内默认不再注入
  await writeAt(user, "common/blank.md", "")
  await writeRule(pkg, "common/blank.md", "## 规范\n\n- 包内会被用户清空覆盖")
  const cleared = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, userRulesRoot: user, teamScenes: ["design"] })
  assert.ok(!cleared.some((rule) => rule.name === "common/blank.md"), "用户清空的文件整条不注入")

  // null / 空串禁用用户公共层：回到包内默认 + 项目追加
  for (const disabled of [null, ""]) {
    const withoutUser = await resolveMemberRules({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, userRulesRoot: disabled, teamScenes: ["design"] })
    assert.equal(withoutUser.find((rule) => rule.name === "common/index.md").sections.规范, "- 包内规范\n\n- 项目追加规范", "禁用手法：" + JSON.stringify(disabled))
  }

  // 传入上层根（其下有 team-work/rules）时取该子目录；传入规则根本身时原样使用
  const upper = await makeRoot(t)
  await writeRule(upper, "owner/README.md", "## 规范\n\n- 上层根形态读取")
  const fromUpper = await resolveMember({ role: "owner", teamScene: "design", packageRoot: pkg, userRulesRoot: upper, teamScenes: ["design"] })
  assert.equal(fromUpper[0].sections.规范, "- 上层根形态读取")
  const fromSuffix = await resolveMember({ role: "owner", teamScene: "design", packageRoot: pkg, userRulesRoot: path.join(upper, "team-work", "rules"), teamScenes: ["design"] })
  assert.equal(fromSuffix[0].sections.规范, "- 上层根形态读取")
})

test("三层目录扫描取并集，忽略 *.default.md 与 *.new.md 旁路副本", async (t) => {
  const pkg = await makeRoot(t)
  const user = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 包内通用")
  await writeRule(pkg, "common/design.md", "## 规范\n\n- 场景公共")
  await writeRule(pkg, "owner/README.md", "## 规范\n\n- 包内角色")
  await writeRule(pkg, "owner/README.default.md", "## 规范\n\n- 包内角色旁路副本")
  await writeRule(pkg, "common/zzz.new.md", "## 规范\n\n- 包内通用新版旁路")
  await writeAt(user, "owner/design/notes.md", "## 建议\n\n- 用户新增角色场景条目")
  await writeAt(user, "common/index.default.md", "## 规范\n\n- 用户旁路默认副本")
  await writeAt(user, "common/design.default.md", "## 规范\n\n- 用户场景旁路副本")
  await writeRule(project, "owner/design/project-notes.md", "## 建议\n\n- 项目新增角色场景条目")
  const rules = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, userRulesRoot: user, teamScenes: ["design"] })
  assert.deepEqual(pairs(rules), [
    "role:owner/README.md",
    "role-scene:owner/design/notes.md",
    "role-scene:owner/design/project-notes.md",
    "scene:common/design.md",
    "common:common/index.md",
  ])
  for (const rule of rules) assert.ok(!rule.name.includes(".default") && !rule.name.includes(".new"), "旁路副本不注入：" + rule.name)
})

test("用户公共层读失败警告并回退包内默认；项目层读失败警告并跳过追加；包内层静默", async (t) => {
  const pkg = await makeRoot(t)
  const user = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "common/index.md", "## 规范\n\n- 包内默认")
  // 用户层同名条目损坏（目录占位）→ 警告一次并回退包内默认
  await mkdir(path.join(user, "common", "index.md"), { recursive: true })
  const userWarns = []
  mock.method(console, "warn", (...args) => userWarns.push(args.join(" ")))
  const fallback = await resolveMember({ role: "owner", teamScene: "design", userRulesRoot: user, packageRoot: pkg, teamScenes: ["design"] })
  assert.equal(userWarns.length, 1, "用户层读失败恰好一次警告：" + userWarns.join(" | "))
  assert.match(userWarns[0], /读取失败/)
  assert.match(userWarns[0], /已回退包内默认/)
  assert.equal(fallback[0].sections.规范, "- 包内默认")

  // 项目层追加损坏 → 警告一次并跳过追加，基线层完整
  await mkdir(path.join(project, "team-work", "rules", "common", "index.md"), { recursive: true })
  const projectWarns = []
  mock.method(console, "warn", (...args) => projectWarns.push(args.join(" ")))
  const appended = await resolveMember({ role: "owner", teamScene: "design", projectRoot: project, packageRoot: pkg, teamScenes: ["design"] })
  assert.equal(projectWarns.length, 1, "项目层读失败恰好一次警告：" + projectWarns.join(" | "))
  assert.match(projectWarns[0], /已跳过该条项目追加/)
  assert.equal(appended[0].sections.规范, "- 包内默认")

  // 包内层损坏：静默跳过，不告警
  const brokenPkg = await makeRoot(t)
  await mkdir(path.join(brokenPkg, "team-work", "rules", "common", "broken.md"), { recursive: true })
  const silent = []
  mock.method(console, "warn", (...args) => silent.push(args.join(" ")))
  assert.deepEqual(await resolveMember({ role: "owner", teamScene: "design", packageRoot: brokenPkg, teamScenes: ["design"] }), [])
  assert.deepEqual(silent, [])
})

test("userRulesRoot 缺省读取 ~/.team-work/rules（用 HOME 夹具验证，不触碰真实主目录）", async (t) => {
  const fakeHome = await makeRoot(t)
  await writeAt(fakeHome, ".team-work/rules/owner/README.md", "## 规范\n\n- 主目录用户规则")
  const pkg = await makeRoot(t)
  const saved = process.env.HOME
  process.env.HOME = fakeHome
  try {
    const rules = await resolveMemberRules({ role: "owner", teamScene: "design", packageRoot: pkg, teamScenes: ["design"] })
    assert.deepEqual(pairs(rules), ["role:owner/README.md"])
    assert.equal(rules[0].sections.规范, "- 主目录用户规则")
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  }
})

test("Lead 通道同样走三层：用户公共层优先、项目追加、旁路副本忽略", async (t) => {
  const pkg = await makeRoot(t)
  const user = await makeRoot(t)
  const project = await makeRoot(t)
  await writeRule(pkg, "lead/dispatch/index.md", "包内派发规则")
  await writeRule(pkg, "lead/dispatch/extra.md", "包内派发补充")
  await writeAt(user, "lead/dispatch/index.md", "用户改写派发规则")
  await writeAt(user, "lead/dispatch/index.new.md", "旁路新版副本")
  await writeRule(project, "lead/dispatch/index.md", "项目派发追加")
  const lead = await resolveLead({ kind: "dispatch", projectRoot: project, packageRoot: pkg, userRulesRoot: user })
  assert.deepEqual(pairs(lead), ["lead:lead/dispatch/extra.md", "lead:lead/dispatch/index.md"])
  assert.equal(lead[1].text, "用户改写派发规则\n\n项目派发追加")
  assert.ok(!lead.some((rule) => rule.name.includes(".default") || rule.name.includes(".new")), "旁路副本不注入")
})

test("明晰提取器随模块迁入：只取唯一必读标记正文，缺资源时诊断可见", async (t) => {
  const pkg = await makeRoot(t)
  const publicFile = path.join(pkg, "skills", "clarity-guidance", "output-standard.md")
  await mkdir(path.dirname(publicFile), { recursive: true })
  await writeFile(publicFile, "详细前言\n<!-- clarity:required:begin -->\n公共必读正文\n<!-- clarity:required:end -->\n不应自动带入的详细示例", "utf8")
  assert.equal(requiredClarityText(await readFile(publicFile, "utf8")).trim(), "公共必读正文")
  assert.throws(() => requiredClarityText("缺少必读标记"), /必读标记须唯一配对、顺序正确且正文非空/)
  const reader = createClarityGuidanceReader({ packageRoot: pkg })
  const publicSection = await reader()
  assert.match(publicSection, /## clarity 公共必读/)
  assert.match(publicSection, /公共必读正文/)
  assert.ok(publicSection.includes(publicFile), "诊断路径指向真实文件")
  assert.doesNotMatch(publicSection, /详细前言|不应自动带入的详细示例/, "只取唯一必读标记内的正文")
  assert.match(await reader({ review: true }), /clarity 规则未带入.*review-rules\.md/s, "审阅资源缺失时诊断可见")
})

// ---- 以下为 cli.mjs 接线与卡片形态的集成用例（原 runtime-v3-guidance.test.mjs 合入）----
// 用户公共规则隔离：HOME 指到临时目录，本文件的派发只读该目录下的 ~/.team-work/rules
const FAKE_HOME = await mkdtemp(path.join(tmpdir(), "tw-rules-home-"))
process.env.HOME = FAKE_HOME
const USER_RULES = path.join(FAKE_HOME, ".team-work", "rules")

// 完整 teamScene 集合：工作流定义是场景文件分类的权威来源。
// 夹具声明全部场景键，才能稳定验证"场景文只进同名场景的派单"。
const SCENES = ["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e", "finish"]
const SCENE_WORKFLOW = {
  terminalStages: ["finish"],
  gates: [],
  stages: SCENES.map((scene) => ({ id: scene, label: scene, outputs: [scene], teamScene: scene })),
  edges: SCENES.slice(0, -1).map((scene, index) => ({ from: scene, to: SCENES[index + 1], outcome: "pass" })),
}
const SCENE_POLICY = {
  maxAutonomousRounds: 3,
  costWeights: { junior: 1, senior: 10, expert: 50 },
  riskTiers: { critical: "expert", high: "senior" },
  scenes: Object.fromEntries(SCENES.map((scene) => [scene, {}])),
}

function assertBaseline(prompt, facts) {
  for (const fact of facts) assert.equal(prompt.split(fact).length - 1, 1, "验收事实恰好出现一次：" + fact)
}

async function writeRules(root, rulesRoot, files) {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...rulesRoot.split("/"), ...relative.split("/"))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text, "utf8")
  }
}

const writeProjectRules = (root, files) => writeRules(root, "team-work/rules", files)
const writeUserRules = (files) => writeRules(FAKE_HOME, ".team-work/rules", files)
// 同一文件内共享临时 HOME：每个用例先清空用户公共层，避免上一个用例写下的规则泄漏到下一个。
const resetUserRules = () => rm(USER_RULES, { recursive: true, force: true })

function positions(prompt, needles) {
  return needles.map((needle) => {
    const index = prompt.indexOf(needle)
    assert.ok(index >= 0, "卡片缺少：" + needle)
    return index
  })
}

function assertAscending(values, message) {
  assert.deepEqual([...values].sort((a, b) => a - b), values, message)
}

test("派单卡段序固定：卡头 → 验收基线 → 锁定契约 → 规范/红线/建议 → 行动与交付", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  const call = autoCaller(projectRoot)
  await resetUserRules()
  await openTask(projectRoot, "order-t", { objective: "实现示例行为", entry: "implementation" })
  const prompt = (await call(["dispatch-plan", "--task", "order-t", "--writable", "src.mjs:source", "--json"])).waves[0].prompt
  assertAscending(positions(prompt, [
    "# 派单（key: ",
    "任务：order-t",
    "## 本轮验收基线",
    "## 工作流职责（TWR 固定契约）",
    "## 规范",
    "## 行动与交付",
    "可写路径（仅限）",
    "完成后调用：",
    "上下文与派单已内嵌",
  ]), "段序按方案固定顺序排列")

  const contract = lockedWorkflowContract("owner")
  assert.equal(prompt.split(contract).length - 1, 1, "锁定契约整段恰好出现一次")
  assert.match(prompt, /不得自行开任务、拆包、派发正式波次或重建审查团队/)
  assert.match(prompt, /deliver --outcome blocked/)
  assert.match(prompt, /junior 只读助手/)
  // 旧成员职责边界段与角色/场景指引段已拆除，行动与交付有独立二级标题避免落入 ## 建议 段
  assert.doesNotMatch(prompt, /## 成员职责边界|## 角色指引|## 场景指引/)
  assert.ok(prompt.indexOf("## 行动与交付") > prompt.indexOf("## 建议"), "行动与交付段在建议段之后独立成节")
})

test("规则来源顺序 角色 → 角色×场景 → 场景公共 → 公共通用；场景文与角色规则零串入", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  await writeProjectRules(projectRoot, {
    "common/index.md": "## 规范\n\n- 项目公共通用条目",
    "common/design.md": "## 规范\n\n- 项目设计场景条目",
    "common/implementation.md": "## 规范\n\n- 项目实施场景条目",
    "owner/README.md": "## 规范\n\n- 项目角色条目",
    "owner/design/project-notes.md": "## 建议\n\n- 项目角色场景建议",
    "challenger/README.md": "## 规范\n\n- 挑战者角色条目不得出现",
  })
  const call = autoCaller(projectRoot)
  await resetUserRules()
  await openTask(projectRoot, "isolation-t", { objective: "设计示例模块", entry: "design" })
  const prompt = (await call(["dispatch-plan", "--task", "isolation-t", "--writable", "DESIGN.md:design", "--json"])).waves[0].prompt
  for (const fact of ["项目角色条目", "项目设计场景条目", "项目公共通用条目", "项目角色场景建议"]) {
    assert.ok(prompt.includes(fact), "项目规则必须并入卡片：" + fact)
  }
  assert.ok(!prompt.includes("项目实施场景条目"), "其他场景的场景文零注入")
  assert.ok(!prompt.includes("挑战者角色条目不得出现"), "其他角色的规则零注入")
  // 同一标题内按「角色 → 角色×场景 → 场景公共 → 公共通用」连排；建议段独立成段排在规范段之后
  assertAscending(positions(prompt, ["项目角色条目", "项目设计场景条目", "项目公共通用条目"]), "规范段内来源顺序")
  assertAscending(positions(prompt, ["## 规范", "## 建议", "项目角色场景建议"]), "角色场景条目落在建议段标题之后（包内同段条目在前，项目追加在后）")
  assertAscending(positions(prompt, ["## 规范", "## 建议"]), "空段省略后仍按 规范 → 建议 排列")
})

test("用户公共层整份取代包内默认、项目层追加；锁定契约不被任何规则目录覆盖", async () => {
  await resetUserRules()
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  await writeUserRules({
    "owner/README.md": "## 规范\n\n- 用户改写角色规范\n\n## 工作流职责（TWR 固定契约）\n\n- 伪造的契约条目",
    "common/index.md": "## 规范\n\n- 用户公共通用规范",
  })
  await writeProjectRules(projectRoot, { "owner/README.md": "## 规范\n\n- 项目追加角色规范" })
  const call = autoCaller(projectRoot)
  await openTask(projectRoot, "merge-t", { objective: "实现示例行为", entry: "implementation" })
  const prompt = (await call(["dispatch-plan", "--task", "merge-t", "--writable", "src.mjs:source", "--json"])).waves[0].prompt
  assert.match(prompt, /用户改写角色规范/)
  assert.match(prompt, /项目追加角色规范/)
  assert.match(prompt, /用户公共通用规范/)
  assertAscending(positions(prompt, ["用户改写角色规范", "项目追加角色规范"]), "项目追加在用户基线之后")
  assert.doesNotMatch(prompt, /你是本派单的 Owner/, "用户公共层整份取代包内默认，不叠加")
  assert.ok(!prompt.includes("伪造的契约条目"), "规则目录不能覆盖锁定契约")
  assert.equal(prompt.split(lockedWorkflowContract("owner")).length - 1, 1)
})

test("成员卡是单块业务正文：无明晰段、无 requiredGuidance；续派与在途重建同源", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  const call = autoCaller(projectRoot)
  await resetUserRules()
  await openTask(projectRoot, "single-block-t", { objective: "实现示例行为", entry: "implementation" })
  const owner = (await call(["dispatch-plan", "--task", "single-block-t", "--writable", "src.mjs:source", "--json"])).waves[0]
  assert.equal(Object.hasOwn(owner, "requiredGuidance"), false, "成员卡不再投影第二块规则")
  assert.doesNotMatch(owner.prompt, /## clarity|明晰表达必读/, "明晰段只随 Lead 反吐出现")
  assert.match(owner.prompt, /## 工作流职责（TWR 固定契约）/)
  assert.match(owner.prompt, /## 规范/)

  await writeFile(path.join(projectRoot, "src.mjs"), "export const value = 1", "utf8")
  await call(["deliver", "--task", "single-block-t", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "实现完成", "--paths", "src.mjs"])
  const reviewer = (await call(["dispatch-plan", "--task", "single-block-t", "--json"])).waves[0]
  assert.match(reviewer.prompt, /## 工作流职责（TWR 固定契约）/, "评审卡同样带锁定契约")
  assert.match(reviewer.prompt, /Challenger/, "评审卡带 challenger 角色契约")
  assert.match(reviewer.prompt, /review --recommendation escalate/, "范围争议的升级通道随角色契约送达")
  await call(["review", "--task", "single-block-t", "--key", reviewer.dispatchKey, "--recommendation", "rework", "--summary", "补失败路径证据"])
  const response = (await call(["dispatch-plan", "--task", "single-block-t", "--writable", "src.mjs:source", "--json"])).waves[0]
  assert.equal(response.kind, "respond")
  for (const prompt of [response.prompt, response.promptFull]) {
    assert.match(prompt, /## 工作流职责（TWR 固定契约）/, "续派与全量变体都带锁定契约")
    assert.match(prompt, /## 规范/, "续派与全量变体都带可 DIY 规则")
    assert.doesNotMatch(prompt, /## clarity|明晰表达必读/)
  }
  const inflightPlan = await call(["dispatch-plan", "--task", "single-block-t", "--json"])
  const inflight = inflightPlan.inflight[0]
  assert.equal(inflight.prompt, response.prompt, "在途重建文本与首派同源")
  assert.equal(inflight.promptFull, response.promptFull)
  assert.equal(Object.hasOwn(inflight, "requiredGuidance"), false)
  // wait-inflight 按现状归入进展时点：读 lead/progress 与公共必读段，不读审阅段
  assert.equal(inflightPlan.stop, "wait-inflight")
  assert.match(inflightPlan.card.presentation, /进展汇报的目的是和用户对齐认知 gap/)
  assert.doesNotMatch(inflightPlan.card.presentation, /## clarity 审阅必读/)
})

test("Lead 反吐按呈现时点读 lead/<时点>：派发与进展只带公共段，决定点另带审阅段；机械回执不命中", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  await writeProjectRules(projectRoot, {
    "lead/dispatch/index.md": "- 项目派发补充",
    "lead/decision/index.md": "- 项目决定补充",
    "lead/progress/index.md": "- 项目进展补充",
  })
  const required = async (relative) => (await readFile(new URL("../" + relative, import.meta.url), "utf8"))
    .split("<!-- clarity:required:begin -->")[1].split("<!-- clarity:required:end -->")[0]
  const publicRules = await required("skills/clarity-guidance/output-standard.md")
  const reviewRules = await required("skills/clarity-review/references/review-rules.md")
  const call = autoCaller(projectRoot)
  await resetUserRules()
  await openTask(projectRoot, "lead-t", { objective: "实现示例行为", entry: "implementation" })

  // 进展时点（run 的 working + next=dispatch）：lead/progress + 公共必读段，不含审阅段
  const progress = await call(["run", "--task", "lead-t"])
  assert.match(progress.presentation, /项目进展补充/)
  assert.ok(progress.presentation.includes(publicRules), "进展反吐携带公共必读段原文")
  assert.doesNotMatch(progress.presentation, /## clarity 审阅必读|项目决定补充|项目派发补充/)

  // 派发时点：lead/dispatch + 公共必读段，不含审阅段
  const plan = await call(["dispatch-plan", "--task", "lead-t", "--writable", "src.mjs:source", "--json"])
  assert.match(plan.presentation, /项目派发补充/)
  assert.ok(plan.presentation.includes(publicRules))
  assert.doesNotMatch(plan.presentation, /## clarity 审阅必读/)

  // 机械回执不命中
  const delivery = await call(["deliver", "--task", "lead-t", "--key", plan.waves[0].dispatchKey, "--outcome", "blocked", "--summary", "新增设施是否本轮必需仍有争议"])
  assert.equal(delivery.presentation, undefined, "成员回执不注入呈现规则")

  // 决定点（awaiting-user）：lead/decision + 公共段 + 审阅段
  const decision = await call(["run", "--task", "lead-t"])
  assert.equal(decision.status, "awaiting-user")
  assert.match(decision.presentation, /项目决定补充/)
  assert.ok(decision.presentation.includes(publicRules))
  assert.ok(decision.presentation.includes(reviewRules))
  assert.equal(decision.presentation.split("## clarity 公共必读").length - 1, 1, "公共段恰好一次")
  assert.equal(decision.presentation.split("## clarity 审阅必读").length - 1, 1, "审阅段恰好一次")
})

test("八视角已拆包：Owner 只承担本包、组合评审覆盖全部已交付包、裁决带 verdict 语义", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: { ...SCENE_POLICY, scenes: { ...SCENE_POLICY.scenes, "code-review": { core: true } } } })
  const call = autoCaller(projectRoot)
  const objective = "对示例变更完成八视角审查，每个视角独立交付证据"
  const perspectives = ["需求", "缺陷安全", "错误处理", "逻辑", "测试", "类型", "规范", "影响"]
  const packages = perspectives.map((perspective, index) => ({
    id: "perspective-" + (index + 1),
    writable: ["FINDINGS-" + (index + 1) + ".md:code-review"],
    done: ["仅核验" + perspective + "视角并记录可定位证据"],
    dependsOn: [],
  }))
  await resetUserRules()
  await openTask(projectRoot, "perspective-t", { objective, entry: "code-review" })
  const baseline = [objective, "保留示例接口合同", "不增加示例产品功能"]
  await call(["intent", "--task", "perspective-t", "--add-constraint", baseline[1], "--add-exclusion", baseline[2]])
  const planned = await call(["plan", "--task", "perspective-t", "--packages", JSON.stringify(packages)])
  assert.equal(planned.ok, true)
  const dispatched = await call(["dispatch-plan", "--task", "perspective-t", "--json"])
  assert.equal(dispatched.waves.length, 8)
  for (const wave of dispatched.waves) {
    const ownPackage = packages.find((pkg) => pkg.id === wave.package)
    assert.equal(wave.role, "owner")
    assertBaseline(wave.prompt, [...baseline, ...ownPackage.done])
    assert.ok(wave.prompt.includes(objective), "总目标作为背景保留")
    assert.ok(wave.prompt.includes(ownPackage.done[0]), "当前视角的完成标准必须随派单到达 Owner：" + wave.package)
    for (const other of packages.filter((pkg) => pkg.id !== wave.package)) {
      assert.ok(!wave.prompt.includes(other.done[0]), "其他包的完成标准不扩张当前 Owner 职责")
    }
    assert.match(wave.prompt, /仅承担本包/, "总目标不得覆盖已分配的包职责")
    assert.match(wave.prompt, /重建审查团队/, "已拆包后不得递归重建整套审查团队")
    assert.match(wave.prompt, /只读助手/, "仍允许限定范围的只读探索辅助")
    assert.match(wave.prompt, /不得继续委托/, "只读辅助不得继续递归派发")
    assert.doesNotMatch(wave.prompt, /组合评审\/裁决仍覆盖/, "单包 Owner 不接组合职责")
    assert.equal(wave.prompt.split(lockedWorkflowContract("owner")).length - 1, 1)
  }
  const current = dispatched.waves.find((wave) => wave.package === "perspective-1")
  await call(["agent-map", "--task", "perspective-t", "--key", current.dispatchKey, "--agent", "fixture-owner"])
  const inflight = await call(["dispatch-plan", "--task", "perspective-t", "--json"])
  assert.equal(inflight.stop, "wait-inflight")
  for (const wave of inflight.inflight) {
    assertBaseline(wave.prompt, baseline)
    assert.match(wave.prompt, /重建审查团队/)
    assert.match(wave.prompt, /## 工作流职责（TWR 固定契约）/, "在途重建同样带锁定契约")
    assert.ok(wave.prompt.includes(packages.find((pkg) => pkg.id === wave.package).done[0]))
  }
  for (const wave of dispatched.waves) {
    const file = packages.find((pkg) => pkg.id === wave.package).writable[0].split(":")[0]
    await writeFile(path.join(projectRoot, file), "# 审查证据\n" + wave.package, "utf8")
    assert.equal((await call(["deliver", "--task", "perspective-t", "--key", wave.dispatchKey, "--outcome", "delivered", "--summary", "本包审查完成", "--paths", file])).accepted, true)
  }
  const challenger = (await call(["dispatch-plan", "--task", "perspective-t", "--json"])).waves[0]
  assert.equal(challenger.scope, "consolidation")
  assertBaseline(challenger.prompt, [...baseline, ...packages.flatMap((pkg) => pkg.done)])
  assert.match(challenger.prompt, /组合评审.*本轮全部已交付包/)
  assert.match(challenger.prompt, /组合评审\/裁决仍覆盖本轮已交付包/)
  assert.doesNotMatch(challenger.prompt, /仅承担本包/)
  assert.match(challenger.prompt, /重建审查团队/)
  await call(["review", "--task", "perspective-t", "--key", challenger.dispatchKey, "--recommendation", "rework", "--summary", "补需求证据", "--findings", JSON.stringify([{ package: "perspective-1", severity: "risk", statement: "缺少需求证据" }])])
  const respond = (await call(["dispatch-plan", "--task", "perspective-t", "--json"])).waves[0]
  assert.equal(respond.package, "perspective-1")
  assert.equal(respond.continuation, true)
  assert.equal(respond.expectedAgentId, "fixture-owner", "续派仍复用原成员映射")
  for (const prompt of [respond.prompt, respond.promptFull]) {
    assertBaseline(prompt, [...baseline, packages[0].done[0]])
    assert.match(prompt, /仅承担本包 perspective-1/)
    assert.match(prompt, /重建审查团队/)
    assert.ok(!prompt.includes(packages[1].done[0]))
  }
  await call(["deliver", "--task", "perspective-t", "--key", respond.dispatchKey, "--outcome", "delivered", "--summary", "补齐需求证据", "--paths", "FINDINGS-1.md"])
  const crossReview = (await call(["dispatch-plan", "--task", "perspective-t", "--json"])).waves[0]
  assert.equal(crossReview.scope, "consolidation")
  for (const prompt of [crossReview.prompt, crossReview.promptFull]) assertBaseline(prompt, [...baseline, ...packages.flatMap((pkg) => pkg.done)])
  await call(["review", "--task", "perspective-t", "--key", crossReview.dispatchKey, "--recommendation", "accept", "--summary", "组合核验通过"])
  const expert = (await call(["dispatch-plan", "--task", "perspective-t", "--json"])).waves[0]
  assert.equal(expert.role, "expert")
  assertBaseline(expert.prompt, [...baseline, ...packages.flatMap((pkg) => pkg.done)])
  assert.match(expert.prompt, /组合评审\/裁决仍覆盖本轮已交付包/)
  assert.match(expert.prompt, /重建审查团队/)
  assert.doesNotMatch(expert.prompt, /仅承担本包/)
  assert.match(expert.prompt, /Expert 裁决语义/)
  assert.match(expert.prompt, /review.*--verdict/)
  assert.match(expert.prompt, /escalate-to-user/, "范围争议的升级通道随裁决者契约送达")
  assert.equal(expert.prompt.split(lockedWorkflowContract("expert")).length - 1, 1)
})

test("审查类派单：角色×场景规则按场景区分，仍交付并经过 Challenger 与核心 Expert", async () => {
  const expectations = {
    "code-review": {
      owner: [/只交审查报告，不修改产品代码/],
      challenger: [/互补的少量角度/],
      expert: [/技术裁决者/, /裁决这份审查报告的技术结论/],
    },
    "design-review": {
      owner: [/审查完整方案/, /不另写方案/],
      challenger: [/不修改被审方案/],
      expert: [/裁决被审方案的技术结论/],
    },
  }
  for (const [scene, expected] of Object.entries(expectations)) {
    const projectRoot = await makeProject({
      workflow: SCENE_WORKFLOW,
      policy: { ...SCENE_POLICY, scenes: { ...SCENE_POLICY.scenes, [scene]: { core: true } } },
    })
    const call = autoCaller(projectRoot)
    await resetUserRules()
    await openTask(projectRoot, "cross-t", { objective: "审查示例局部修改", entry: scene })
    const dispatched = await call(["dispatch-plan", "--task", "cross-t", "--writable", "REVIEW.md:" + scene, "--json"])
    assert.equal(dispatched.waves.length, 1)
    const owner = dispatched.waves[0]
    assert.doesNotMatch(owner.prompt, /^本包完成标准：|^各包完成标准（|你仅承担本包|组合评审\/裁决仍覆盖/m, "无包派单不臆造包、视角或组合职责")
    for (const pattern of expected.owner) assert.match(owner.prompt, pattern, scene + " Owner 规则到达")
    assert.doesNotMatch(owner.prompt, /实施以原需求为基线/, "实施场景规则不串入审查派单")
    assert.equal(owner.prompt.split(lockedWorkflowContract("owner")).length - 1, 1)
    await writeFile(path.join(projectRoot, "REVIEW.md"), "# 审查\n范围与证据", "utf8")
    const delivered = await call(["deliver", "--task", "cross-t", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "审查完成", "--paths", "REVIEW.md"])
    assert.equal(delivered.accepted, true)
    const challenger = (await call(["dispatch-plan", "--task", "cross-t", "--json"])).waves[0]
    assert.equal(challenger.role, "challenger")
    assert.match(challenger.prompt, /非作者 Challenger/)
    assert.match(challenger.prompt, /重建审查团队/)
    for (const pattern of expected.challenger) assert.match(challenger.prompt, pattern, scene + " Challenger 规则到达")
    await call(["review", "--task", "cross-t", "--key", challenger.dispatchKey, "--recommendation", "accept", "--summary", "独立核验通过"])
    const expert = (await call(["dispatch-plan", "--task", "cross-t", "--json"])).waves[0]
    assert.equal(expert.role, "expert")
    assert.match(expert.prompt, /技术裁决者/)
    assert.match(expert.prompt, /review.*--verdict/)
    for (const pattern of expected.expert) assert.match(expert.prompt, pattern, scene + " Expert 规则到达")
  }
})

test("场景规则内容：设计、审查、实施与测试各自按约定交付分流范围外发现", async () => {
  const expectations = {
    design: /改什么与不改什么.*范围.*建议.*不自动/,
    "design-review": /约定需求.*不按理想系统/,
    "code-review": /历史问题.*范围外发现/,
    implementation: /更好实现.*不.*重构.*历史功能/,
    test: /约定需求.*风险.*独立的历史问题.*产品能力/s,
  }
  for (const [scene, expectation] of Object.entries(expectations)) {
    const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
    const call = autoCaller(projectRoot)
    await resetUserRules()
    await openTask(projectRoot, "scene-t", { objective: "完成约定交付", entry: scene })
    const owner = (await call(["dispatch-plan", "--task", "scene-t", "--writable", "RESULT.md:doc", "--json"])).waves[0]
    assert.match(owner.prompt, expectation, scene + " 的场景规则随派单到达")
    for (const other of SCENES.filter((name) => name !== scene && expectations[name])) {
      assert.doesNotMatch(owner.prompt, expectations[other], scene + " 派单不得串入 " + other + " 的场景规则")
    }
  }
})

test("方案场景：Owner、Challenger、返工和在途重建均带同一份锁定契约与设计规则", async () => {
  const projectRoot = await makeProject({ workflow: SCENE_WORKFLOW, policy: SCENE_POLICY })
  const call = autoCaller(projectRoot)
  await resetUserRules()
  await openTask(projectRoot, "design-t", { objective: "设计示例模块", entry: "design" })
  const d = await call(["dispatch-plan", "--task", "design-t", "--writable", "DESIGN.md:design", "--json"])
  assert.match(d.waves[0].prompt, /完整方案是需求、范围与实现方向的唯一人工批准正文/, "设计场景 Owner 规则到达")
  assert.match(d.waves[0].prompt, /交付前自检/)
  assert.doesNotMatch(d.waves[0].prompt, /实施以原需求为基线/, "实施场景规则不串入设计派单")
  await writeFile(path.join(projectRoot, "DESIGN.md"), "# 方案\n示例设计", "utf8")
  await call(["deliver", "--task", "design-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成方案", "--paths", "DESIGN.md"])
  const r = await call(["dispatch-plan", "--task", "design-t", "--json"])
  assert.equal(r.waves[0].role, "challenger")
  assert.match(r.waves[0].prompt, /挑战方案的假设与依赖/, "设计场景 Challenger 规则到达")
  assert.match(r.waves[0].prompt, /不另写一份方案/)
  await call(["review", "--task", "design-t", "--key", r.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "补充取舍依据"])
  const rw = await call(["dispatch-plan", "--task", "design-t", "--writable", "DESIGN.md:design", "--json"])
  assert.equal(rw.waves[0].kind, "respond")
  assert.match(rw.waves[0].prompt, /## 工作流职责（TWR 固定契约）/)
  const status = await call(["run", "--task", "design-t"])
  const inflight = await call(["dispatch-plan", "--task", "design-t", "--json"])
  assert.equal(inflight.stop, "wait-inflight")
  for (const card of [status, inflight]) {
    assert.equal(card.inflight[0].prompt, rw.waves[0].prompt, "在途重建与续派同源")
  }
})

test("clarity 同源短段：按需读取、操作内共享，下一操作更新且不加载详细正文", async () => {
  const root = await makeProject()
  const publicFile = path.join(root, "skills/clarity-guidance/output-standard.md")
  const reviewFile = path.join(root, "skills/clarity-review/references/review-rules.md")
  for (const file of [publicFile, reviewFile]) await mkdir(path.dirname(file), { recursive: true })
  const resource = (body) => "详细前言\n<!-- clarity:required:begin -->\n" + body + "\n<!-- clarity:required:end -->\n不应自动带入的详细示例"
  await writeFile(publicFile, resource("公共第一版"))
  await writeFile(reviewFile, resource("专项第一版"))
  const reads = []
  const read = async (file, encoding) => { reads.push(file); return readFile(file, encoding) }
  const get = createClarityGuidanceReader({ packageRoot: root, read })
  const shared = await Promise.all([get(), get(), get({ review: true })])
  assert.equal(reads.filter((p) => p === publicFile).length, 1)
  assert.equal(reads.filter((p) => p === reviewFile).length, 1)
  assert.ok(shared[0].includes("\n公共第一版\n"), "原文不改写、不截断")
  assert.ok(shared[0].includes(publicFile), "完整规范准确路径可见")
  assert.doesNotMatch(shared[0], /专项第一版|详细前言|不应自动带入/)
  assert.match(shared[2], /专项第一版/)
  await writeFile(publicFile, resource("公共第二版"))
  assert.match(await get(), /公共第一版/, "一次操作内保持同源快照")
  const next = createClarityGuidanceReader({ packageRoot: root, read })
  assert.match(await next(), /公共第二版/, "下次操作不沿用缓存")
  assert.equal(reads.filter((p) => p === reviewFile).length, 1, "仅公共时不读专项")
})

test("clarity 坏资源可见恢复：缺文件、目录、重复/倒置/空标记均不伪造备用规则", async () => {
  const root = await makeProject()
  const source = path.join(root, "skills/clarity-guidance/output-standard.md")
  await mkdir(path.dirname(source), { recursive: true })
  const check = async () => {
    const result = await createClarityGuidanceReader({ packageRoot: root })()
    assert.match(result, /规则未带入.*恢复：/s)
    assert.ok(result.includes(source))
    assert.doesNotMatch(result, /## clarity 公共必读/)
  }
  await check()
  for (const text of ["缺少标记", "<!-- clarity:required:end -->正文<!-- clarity:required:begin -->", "<!-- clarity:required:begin --> <!-- clarity:required:end -->", "<!-- clarity:required:begin -->正文<!-- clarity:required:end --><!-- clarity:required:begin -->"]) {
    await writeFile(source, text); await check()
  }
  await rm(source)
  await mkdir(source)
  await check()
  const result = await createClarityGuidanceReader({ packageRoot: root, read: async () => { const error = new Error("拒绝读取"); error.code = "EACCES"; throw error } })()
  assert.match(result, /EACCES/)
})
