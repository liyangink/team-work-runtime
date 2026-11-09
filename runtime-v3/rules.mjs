// rules.mjs — 规则库与工作流固定契约：成员三标题段、Lead 时点整文件、双层可 DIY 规则合并。
// 一、包内锁定层（lockedWorkflowContract）：TWR 工作流必需的硬规则按角色固定生成，
//     不读任何外部规则目录，也不被用户公共目录或项目规则覆盖。成员卡把它作为独立段落输出。
// 二、可 DIY 规则层（本模块其余解析）分三层：
//     基线层 = 用户公共目录（默认 ~/.team-work/rules，可经 userRulesRoot 覆盖）优先，
//              同名文件不存在（ENOENT）时回退包内出厂默认 <packageRoot>/team-work/rules；
//     项目层 = <projectRoot>/team-work/rules 同名路径正文追加在基线层之后；
//     目录扫描取三层文件名并集（缺谁不影响其他层），忽略 *.default.md 与 *.new.md 旁路文件
//     （tw init 增量同步时写出的参考副本，不参与注入）。
// 成员规则按二级标题分三段落盘：## 规范、## 红线、## 建议；解析只取标题下正文，
// 条目力度由条目自己携带（不做「红线：/严格遵循：」之类前缀筛选，也不解析力度）。
//   段标题行必须是 "## " 起首的二级标题；"### " 及更深标题留在正文里，不切段。
//   其他二级标题只结束当前段，其正文不属于三类、不注入；标题之前的正文同样不注入。
//   同一份（已合并的）正文里同一标题重复出现时按出现顺序拼接——项目追加与基线同标题合入同一段。
// 成员来源与注入顺序（类内按文件名排序）：
//   角色（<role>/ 根级 .md）→ 角色×场景（<role>/<当前 teamScene>/ 下 .md）
//   → 场景公共（common/<当前 teamScene>.md，只此一份、只注入一次）→ 公共通用（common/ 其余 .md）。
// 公共通用批按完整 teamScene 集合判定：文件名（去 .md）属于工作流定义 stages[].teamScene 的
// 文件是场景文件，只进同名场景的派单；集合的权威来源就是工作流定义——调用方已持有 workflow 时
// 经 teamScenes 直接传入（不重复读盘），缺省时读项目根 workflow/definitions/engineering.json、
// 回退包内同名文件（与 cli.mjs 的 loadDefinitions 同序）。集合缺失时按空集处理并警告：
// 此时 common/ 下文件全部按公共通用注入，属配置异常而非派发门禁。
// 读失败：包内默认静默跳过；用户公共层文件存在但读取失败时警告并回退包内默认；
//   项目层文件存在但读取失败时警告并跳过该条追加；基线层仍完整在场。文件不存在（ENOENT）
//   一律视为"该层没有这条"（静默）。规则是增强不是门禁，任何读取失败都不抛错、不阻塞派发。
// 热变语义：无模块级缓存，每次调用全量重读——改规则文件即下次派发/反吐生效。
// Lead 规则（resolveLeadRules）是另一条通道：lead/<kind>/ 下整文件读取，不套这三个标题。
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// 规则库在包内与项目根下的相对位置（同路径合并单位 = 其下的相对路径）。
const RULES_SEGMENTS = ["team-work", "rules"]

// 用户公共可改目录的默认位置：不在任何项目内，供用户直接增删改出厂默认条目。
const DEFAULT_USER_RULES_ROOT = () => path.join(os.homedir(), ".team-work", "rules")

// tw init 增量同步写出的参考副本后缀：不参与注入（用户已在用旧版时新版写旁路供参考合并）。
const BYPASS_SUFFIXES = [".default.md", ".new.md"]

// 卡片上三段的固定顺序；成员规则文件的二级标题也就是这三个名字。
const SECTION_TITLES = ["规范", "红线", "建议"]

// 单段标识：角色名、teamScene、Lead 时点都是取自工作流/Policy 的单段键。
// 校验同时承载两层意思：键必须是单段（分类按"文件名词干等于场景键"比对），且不得含路径分隔符
// 或 ".."——规则目录拼接不做防逃逸，落在接口入口挡住非法键。
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const SECTION_HEADING = /^##[ \t]+(规范|红线|建议)[ \t]*$/
const ANY_HEADING = /^##[ \t]/

function requireSegment(value, label) {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    throw new TypeError(label + " 必须是单段标识（字母/数字/下划线/连字符）：" + String(value))
  }
  return value
}

// 目录缺失或不可读 = 该层没有条目（静默，规则是增强，不阻塞派发）。
// 只列单层目录内的 .md，忽略旁路副本（*.default.md / *.new.md）；
// 子目录（如 <role>/<scene>/）不在此处展开。
async function listMarkdown(dir) {
  if (!dir) return []
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith(".md") && !BYPASS_SUFFIXES.some((suffix) => name.endsWith(suffix)))
      .sort()
  } catch {
    return []
  }
}

// 三层文件名取并集后按文件名排序：用户/项目可新增条目（增补），其他层同名条目依旧各就各位。
function sortedUnion(...lists) {
  return [...new Set(lists.flat())].sort()
}

// 包根/项目根（上层根）到规则库目录；用户公共层经 normalizeUserRulesRoot 后已是规则库目录。
function packageRulesDir(upperRoot) {
  return path.join(upperRoot, ...RULES_SEGMENTS)
}

// 某一层规则库目录下的子目录；该层未启用（null）时返回 null，listMarkdown/readRuleFile 视为空。
function layerDir(rulesDir, ...segments) {
  return rulesDir ? path.join(rulesDir, ...segments) : null
}

// 读某一层的单条规则：返回 { state: "ok" | "missing" | "failed", text }。
//   missing（ENOENT）= 该层没有这条，静默；ok = 文本（可能是空串，属"用户显式清空"）；
//   failed = 条目在场但读不了：用户层警告后回退包内默认，项目层警告后跳过该条追加，包内层静默跳过。
async function readRuleFile(rulesDir, segments, { layer = null } = {}) {
  if (!rulesDir) return { state: "missing", text: "" }
  const file = path.join(rulesDir, ...segments)
  try {
    return { state: "ok", text: (await readFile(file, "utf8")).trim() }
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", text: "" }
    const reason = error?.code ?? error?.message
    if (layer === "user") console.warn("tw: 警告：" + file + " 读取失败（" + reason + "），已回退包内默认")
    if (layer === "project") console.warn("tw: 警告：" + file + " 读取失败（" + reason + "），已跳过该条项目追加；基线层仍完整在场")
    return { state: "failed", text: "" }
  }
}

// 基线层取值：用户公共目录同名文件优先（存在即整份采用，含用户清空后的空文件），
// 不存在或读取失败时回退包内出厂默认。
async function readBaseline(userRulesDir, packageRulesDirPath, segments) {
  const userFile = await readRuleFile(userRulesDir, segments, { layer: "user" })
  if (userFile.state === "ok") return userFile.text
  const packageFile = await readRuleFile(packageRulesDirPath, segments)
  return packageFile.state === "ok" ? packageFile.text : ""
}

// 把一份规则正文解析成 { 规范, 红线, 建议 } 三段正文（缺段为空字符串）。
// 只认三个二级标题；正文保留原样（列表符号、子标题、力度措辞都不改），仅去掉首尾空行。
// CRLF 输入按行拆开后统一用 "\n" 拼接，保证卡片文本不混入回车。
function parseRuleSections(text) {
  const sections = { 规范: "", 红线: "", 建议: "" }
  if (!text) return sections
  let current = null
  let buffer = []
  const flush = () => {
    if (current) {
      const body = buffer.join("\n").trim()
      if (body) sections[current] = sections[current] ? sections[current] + "\n\n" + body : body
    }
    buffer = []
  }
  for (const line of text.split(/\r?\n/)) {
    const heading = SECTION_HEADING.exec(line)
    if (heading) {
      flush()
      current = heading[1]
      continue
    }
    if (ANY_HEADING.test(line)) {
      flush()
      current = null
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

// 同路径合并成一条：基线层正文 + 空行 + 项目追加，再解析三标题段。
// 这样项目补充只要写在对应标题下，就自然落在同一段；三层都缺或三段全空则整条缺席（不注入空条目）。
async function collectMemberRule({ userRulesDir, packageRulesDirPath, projectRulesDir, source, segments }) {
  const baseline = await readBaseline(userRulesDir, packageRulesDirPath, segments)
  const projectFile = await readRuleFile(projectRulesDir, segments, { layer: "project" })
  const text = [baseline, projectFile.state === "ok" ? projectFile.text : ""].filter(Boolean).join("\n\n")
  if (!text) return null
  const sections = parseRuleSections(text)
  if (!SECTION_TITLES.some((title) => sections[title])) return null
  return { source, name: segments.join("/"), sections }
}

// 完整 teamScene 集合：项目根定义优先、包内定义回退（与 cli.mjs 的 loadDefinitions 同序）。
// 只取 stages[].teamScene；不可读/无有效键的层直接试下一层，两层都取不到才警告并返回空集。
async function loadSceneSet(roots) {
  for (const root of roots) {
    if (!root) continue
    try {
      const workflow = JSON.parse(await readFile(path.join(root, "workflow", "definitions", "engineering.json"), "utf8"))
      const scenes = (Array.isArray(workflow?.stages) ? workflow.stages : [])
        .map((stage) => stage?.teamScene)
        .filter((scene) => typeof scene === "string" && SEGMENT.test(scene))
      const unique = [...new Set(scenes)]
      if (unique.length) return unique
    } catch {
      // 该层定义不可读：试下一层
    }
  }
  console.warn("tw: 警告：未能从工作流定义取得完整 teamScene 集合，本次按空集判定场景文件（common/ 下文件全部按公共通用注入）；请在调用方传入 teamScenes，或核对 workflow/definitions/engineering.json")
  return []
}

// 用户公共目录形态归一：接受"规则根"（如 /x/user-rules 或 ~/.team-work/rules）与"上层根"
// （其下带 team-work/rules 子目录，如 packageRoot / 项目根）两种传法。null/空串表示禁用用户公共层。
// 归一顺序：已是 <sep>team-work/rules 后缀 → 原样；否则目录下存在 team-work/rules 子目录 → 取子目录；
// 否则直接作为规则根（临时夹具目录即此形态）。
async function normalizeUserRulesRoot(value) {
  if (value === null || value === "") return null
  const dir = path.resolve(value)
  const rulesSuffix = path.sep + path.join("team-work", "rules")
  if (dir.endsWith(rulesSuffix)) return dir
  const nested = path.join(dir, "team-work", "rules")
  try {
    await readdir(nested) // 目录可读即视为"上层根"形态（如传入 packageRoot）
    return nested
  } catch {
    return dir // 没有该子目录：传入目录本身就是规则根
  }
}

// 三层根目录归一：包内/项目层是上层根（追加 team-work/rules）；同目录视为同一棵树，不再是"追加"。
async function resolveLayerDirs({ packageRoot, projectRoot, userRulesRoot }) {
  const packageRulesDirPath = packageRulesDir(path.resolve(packageRoot ?? PACKAGE_ROOT))
  const userRulesDir = await normalizeUserRulesRoot(userRulesRoot)
  const projectUpper = projectRoot === undefined || projectRoot === null ? null : path.resolve(projectRoot)
  const projectRulesCandidate = projectUpper ? packageRulesDir(projectUpper) : null
  // 同一棵树不是"追加"：项目层与基线层同目录时跳过追加，否则同一正文会被追加自身重复一遍。
  const projectRulesDir = projectRulesCandidate && projectRulesCandidate !== packageRulesDirPath && projectRulesCandidate !== userRulesDir
    ? projectRulesCandidate
    : null
  return { packageRulesDirPath, userRulesDir, projectUpper, projectRulesDir }
}

// 成员规则解析：返回按注入顺序排列的 [{ source, name, sections }]。
//   source ∈ role（角色）| role-scene（角色×场景）| scene（场景公共）| common（公共通用）
//   name = 规则库内相对路径（"/" 分隔），如 owner/README.md、common/implementation.md
//   sections = { 规范, 红线, 建议 }，每段是该相对路径（基线层 + 项目追加）的正文，缺段为空字符串
// 三段全空或文件不存在的条目不出现在结果里；来源顺序即卡片内同段条目的先后顺序。
// teamScenes 可省略（缺省从工作流定义读取）；调用方已持有 workflow 时建议传入，避免重复读盘。
// userRulesRoot 缺省 ~/.team-work/rules；传 null/空串禁用用户公共层；传上层根则取其 team-work/rules。
// packageRoot 仅用于隔离文件系统测试（与 createClarityGuidanceReader 的 packageRoot 同性质），
// 不是项目配置或规则库选源接口。
export async function resolveMemberRules({ role, teamScene = null, projectRoot = null, packageRoot = PACKAGE_ROOT, userRulesRoot = DEFAULT_USER_RULES_ROOT(), teamScenes } = {}) {
  const roleName = requireSegment(role, "role")
  const scene = teamScene === undefined || teamScene === null || teamScene === "" ? null : requireSegment(teamScene, "teamScene")
  const { packageRulesDirPath, userRulesDir, projectUpper, projectRulesDir } = await resolveLayerDirs({ packageRoot, projectRoot, userRulesRoot })
  const sceneSet = new Set(teamScenes === undefined || teamScenes === null
    ? await loadSceneSet([projectUpper, path.resolve(packageRoot ?? PACKAGE_ROOT)])
    : teamScenes.map((sceneName) => requireSegment(sceneName, "teamScenes[]")))

  const rules = []
  const push = async (source, segments) => {
    const rule = await collectMemberRule({ userRulesDir, packageRulesDirPath, projectRulesDir, source, segments })
    if (rule) rules.push(rule)
  }

  // ① 角色：<role>/ 根级 .md（场景子目录是第 ② 类，不在此展开）。
  const roleNames = sortedUnion(
    await listMarkdown(layerDir(userRulesDir, roleName)),
    await listMarkdown(layerDir(packageRulesDirPath, roleName)),
    await listMarkdown(layerDir(projectRulesDir, roleName)),
  )
  for (const fileName of roleNames) await push("role", [roleName, fileName])

  // ② 角色场景：<role>/<当前 teamScene>/ 下 .md。
  if (scene) {
    const sceneNames = sortedUnion(
      await listMarkdown(layerDir(userRulesDir, roleName, scene)),
      await listMarkdown(layerDir(packageRulesDirPath, roleName, scene)),
      await listMarkdown(layerDir(projectRulesDir, roleName, scene)),
    )
    for (const fileName of sceneNames) await push("role-scene", [roleName, scene, fileName])
  }

  // ③ 场景公共：只读 common/<当前 teamScene>.md 一份，只注入一次。
  if (scene) await push("scene", ["common", scene + ".md"])

  // ④ 公共通用：文件名不属于完整 teamScene 集合的 common/*.md。
  //    当前场景的同名文件由 ③ 注入，这里一并排除——无论该场景是否在集合内，场景文都只出现一次。
  const commonNames = sortedUnion(
    await listMarkdown(layerDir(userRulesDir, "common")),
    await listMarkdown(layerDir(packageRulesDirPath, "common")),
    await listMarkdown(layerDir(projectRulesDir, "common")),
  )
  for (const fileName of commonNames) {
    const stem = fileName.slice(0, -".md".length)
    if (sceneSet.has(stem) || stem === scene) continue
    await push("common", ["common", fileName])
  }

  return rules
}

// 把成员规则按卡片三段拼接：固定顺序 规范 → 红线 → 建议，段内条目按来源顺序、以空行分隔。
// 所有来源都为空的一段整段省略（连标题也不出现）；三段全空返回空字符串（卡片不留空段）。
// 返回可直接插入派单卡的 markdown 文本（含 "## 规范" 等标题），cli 只负责决定放在卡的哪一段。
export function composeMemberRules(rules) {
  const parts = []
  for (const title of SECTION_TITLES) {
    const bodies = []
    for (const rule of Array.isArray(rules) ? rules : []) {
      const body = rule?.sections?.[title]
      if (body) bodies.push(body)
    }
    if (bodies.length) parts.push("## " + title + "\n\n" + bodies.join("\n\n"))
  }
  return parts.join("\n\n")
}

// Lead 规则解析：按呈现时点读 lead/<kind>/ 下 .md（kind = dispatch|decision|progress，见方案第二节 4）。
// Lead 通道整文件读取、不套三标题：lead/ 下文件是成篇的操作要求，不是可分段拼接的成员条目。
// 三层口径与成员通道一致（用户公共层优先、包内默认回退、项目追加，忽略旁路副本），
// 差异只有两条：lead/ 根级文件（含 README.md）不在此读取；正文不做三标题解析。
// 返回 [{ source: "lead", name, text }]。
export async function resolveLeadRules({ kind, projectRoot = null, packageRoot = PACKAGE_ROOT, userRulesRoot = DEFAULT_USER_RULES_ROOT() } = {}) {
  const point = requireSegment(kind, "kind")
  const { packageRulesDirPath, userRulesDir, projectRulesDir } = await resolveLayerDirs({ packageRoot, projectRoot, userRulesRoot })
  const names = sortedUnion(
    await listMarkdown(layerDir(userRulesDir, "lead", point)),
    await listMarkdown(layerDir(packageRulesDirPath, "lead", point)),
    await listMarkdown(layerDir(projectRulesDir, "lead", point)),
  )
  const rules = []
  for (const fileName of names) {
    const segments = ["lead", point, fileName]
    const baseline = await readBaseline(userRulesDir, packageRulesDirPath, segments)
    const projectFile = await readRuleFile(projectRulesDir, segments, { layer: "project" })
    const text = [baseline, projectFile.state === "ok" ? projectFile.text : ""].filter(Boolean).join("\n\n")
    if (text) rules.push({ source: "lead", name: segments.join("/"), text })
  }
  return rules
}

// ---- 包内锁定工作流契约（runtime 固定填充，不可被规则目录覆盖）----
// 这是"纪律区"里唯一不来自 team-work/rules/ 的段落：成员身份与不越权、范围争议的停手/升级口径、
// 交付/评审/裁决的工具合同与新鲜度、只读助手边界。文本固定在代码里，任何外部目录（用户公共、
// 项目）都改不动它；内容不读盘，纯常量拼装。
const WORKFLOW_CONTRACT_TITLE = "## 工作流职责（TWR 固定契约）"
const WORKFLOW_CONTRACT_LOCKED = "本段由 TWR 包内代码固定生成，不读取任何外部规则目录，也不被用户公共目录或项目规则覆盖或修改。"
const WORKFLOW_CONTRACT_HELPER = "需要辅助时只可委托 junior 只读助手：可写范围为空、不作完整审查、不替代正式 deliver/review、不得继续委托；助手不得读取项目外目录，结果由你自行核验整合；转发消息同样带完整职责边界，不得把总目标直接复制成助手派单。"
const WORKFLOW_CONTRACT_ROLES = {
  owner: {
    who: "Owner 成员",
    dispute: "范围、必要性或修法授权仍有实质争议时，先停止依赖工作，以 deliver --outcome blocked（paths 留空）报告 Lead 并保留原有效制品；不先造新设施，不借可写目录扩大需求。",
    tool: "交付必须通过 deliver 工具提交并登记产出物路径：只在文字里声称完成不算交付，工具登记成功后才进入评审链；关键步骤与最终交付前对照派单目标、约束与完成标准自行复核。",
  },
  challenger: {
    who: "Challenger 成员（非作者评审者）",
    dispute: "范围、必要性或修法授权争议不能由现成证据消解时，以 review --recommendation escalate 报告 Lead 请用户确定方向；不借 rework 扩大需求，也不以成本或范围控制强迫 accept。",
    tool: "评审只对当前最新交付制品成立：制品变化后旧结论失效，需按当前状态重新评审；结论必须通过 review 工具提交（recommendation 与 findings），只在文字里表达不算评审。",
  },
  expert: {
    who: "Expert 成员（技术裁决者）",
    dispute: "必要性或修法授权争议不能由现成证据消解时，以 review 的 verdict.outcome=escalate-to-user 报告 Lead 并保留技术与证据；不借裁决新增需求或批准新设施。",
    tool: "裁决只对当前最新制品状态成立：制品变化后旧裁决自动失效，需基于当前制品重新裁决；裁决必须通过 review 的 verdict 字段提交（outcome/rationale/confidence/recommendedAction），只在文字里表达不算裁决。",
  },
}

// 返回该角色的包内锁定工作流职责段落（markdown 文本，固定标题与条目，不含结尾空行）。
// 角色限定 owner / challenger / expert：Lead 不需要成员契约，传入其他值属调用方错误，直接拒绝。
export function lockedWorkflowContract(role) {
  const contract = WORKFLOW_CONTRACT_ROLES[role]
  if (!contract) {
    throw new TypeError("lockedWorkflowContract 的角色必须是 owner、challenger 或 expert：" + String(role))
  }
  const bullets = [
    "你是已分配的 " + contract.who + "，不是 Lead：不得自行开任务、拆包、派发正式波次或重建审查团队；已分配的完整检查内容照常完成，只承担本派单声明的职责。",
    WORKFLOW_CONTRACT_LOCKED,
    contract.dispute,
    contract.tool,
    WORKFLOW_CONTRACT_HELPER,
  ]
  return [WORKFLOW_CONTRACT_TITLE, "", ...bullets.map((line) => "- " + line)].join("\n")
}

// 明晰必读段提取器：成员卡不再消费，
// 只随 Lead 反吐出现；正文来自根包 clarity 技能文件的唯一必读标记，避免静态副本。
const REQUIRED_BEGIN = "<!-- clarity:required:begin -->"
const REQUIRED_END = "<!-- clarity:required:end -->"
const CLARITY_RESOURCES = {
  public: "skills/clarity-guidance/output-standard.md",
  review: "skills/clarity-review/references/review-rules.md",
}

export function requiredClarityText(text) {
  const starts = text.split(REQUIRED_BEGIN).length - 1
  const ends = text.split(REQUIRED_END).length - 1
  const begin = text.indexOf(REQUIRED_BEGIN) + REQUIRED_BEGIN.length
  const end = text.indexOf(REQUIRED_END)
  if (starts !== 1 || ends !== 1 || end < begin || !text.slice(begin, end).trim()) {
    throw new Error("必读标记须唯一配对、顺序正确且正文非空")
  }
  return text.slice(begin, end)
}

// 每次工具操作新建读取器：同一操作共享读取结果，下一操作重新读取。
// 参数仅用于隔离文件系统测试，不是项目配置或宿主技能选源接口。
export function createClarityGuidanceReader({ packageRoot = PACKAGE_ROOT, read = readFile } = {}) {
  const loaded = new Map()
  const section = (kind) => {
    if (!loaded.has(kind)) loaded.set(kind, (async () => {
      const source = path.join(packageRoot, CLARITY_RESOURCES[kind])
      try {
        const text = await read(source, "utf8")
        return "## clarity " + (kind === "public" ? "公共必读" : "审阅必读") + "\n" + requiredClarityText(text) + "\n详细规范（仅限读取此文件，不扩展扫描权限）：" + source
      } catch (error) {
        return "clarity 规则未带入：" + source + "（" + (error?.code ?? error?.message) + "）。恢复：核对当前根包资源及唯一必读标记，修复或重新安装完整根包后重试；本次原流程保持，不将诊断视为批准。"
      }
    })())
    return loaded.get(kind)
  }
  return async ({ review = false } = {}) => (await Promise.all([section("public"), ...(review ? [section("review")] : [])])).join("\n\n")
}
