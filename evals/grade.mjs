// grade.mjs — 三层客观评分流水线（60 分确定性验证 + 30 分预注册原子检查点 + 10 分过程与边界纪律 = 100 分）
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function buildBinaryCheckpointJudgePrompt(taskId, checkpoints, submissionText) {
  return [
    `你是客观的 0/1 原子得分点裁判。请针对任务 ${taskId} 的提交内容，逐条核验以下二元检查点（仅输出 JSON：{ "results": [{ "id": "...", "pass": 0|1, "evidence": "原文引用" }] }）：`,
    JSON.stringify(checkpoints, null, 2),
    "=== 被测提交内容 ===",
    String(submissionText ?? "")
  ].join("\n\n")
}

// 检查文本中是否存在肯定性（非反向否定）的缺陷/修复陈述
function hasAffirmativeFinding(text, requiredPatterns) {
  const sentences = String(text ?? "").split(/[。！？；\n]+/).map((s) => s.trim()).filter(Boolean)
  const negationRe = /(?:不会.{0,12}(?:读到|撕裂|丢失|报错)|从未.{0,12}(?:撕裂|丢弃)|毫无风险|没有意义|无须使用|不应采用|都不是缺陷|无需修复|无需采取措施)/
  const validSentences = sentences.filter((s) => !negationRe.test(s)).join("\n")
  return requiredPatterns.every((pat) => pat.test(validSentences))
}

export async function gradeDrConfigHotreload(workspaceDir, { fixtureDir = path.join(HERE, "fixtures/dr-config-hotreload") } = {}) {
  const [baseDesign, baseCode, curDesign, curCode, reviewText] = await Promise.all([
    readFile(path.join(fixtureDir, "docs/hotreload-design.md"), "utf8"),
    readFile(path.join(fixtureDir, "src/config-manager.mjs"), "utf8"),
    readFile(path.join(workspaceDir, "docs/hotreload-design.md"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "src/config-manager.mjs"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "REVIEW.md"), "utf8").catch(() => "")
  ])

  const sourceUntouched = sha256(baseDesign) === sha256(curDesign) && sha256(baseCode) === sha256(curCode)
  const hasValidReview = typeof reviewText === "string" && reviewText.trim().length >= 50
  const deniesDefects = /^(?:这些都不是缺陷|无需采取措施|所有需求已经满足，无需做任何改动)/m.test(reviewText.trim())

  const hitB1 = !deniesDefects && hasAffirmativeFinding(reviewText, [/(saveConfig|writeFile)/, /(watch|监听)/, /(非原子|原地覆写|空文件|半截|半成品|撕裂|截断|JSON\.parse)/])
  const hitB2 = !deniesDefects && hasAffirmativeFinding(reviewText, [/(executeRequest|activeConfig|transport\.authenticate)/, /(authenticate|await|异步边界|中途|撕裂|不一致|跨快照)/])
  const hitB3 = !deniesDefects && hasAffirmativeFinding(reviewText, [/(sanitizeForSave|白名单|routes)/, /(endpoint|apiKeyRef)/, /(未知字段|扩展字段|丢弃|抹除|丢失|删除)/])
  const recallScore = (hitB1 ? 16 : 0) + (hitB2 ? 16 : 0) + (hitB3 ? 16 : 0)

  const isClassifiedAsBlocker = (kw) => {
    const sanitized = reviewText.replace(/(?:非|不构成|不属于|不是|并非)\s*(?:Blocker|阻塞)|non-blocking/gi, "SAFE_NON_BLOCKING")
    const afterRe = new RegExp(kw + "[^\\n]{0,40}(?:Blocker|阻塞|必修)", "i")
    const beforeRe = new RegExp("(?:Blocker|阻塞|必修)[\\s:：-][^\\n]{0,40}" + kw, "i")
    return afterRe.test(sanitized) || beforeRe.test(sanitized)
  }
  const falseBlockerD1 = isClassifiedAsBlocker("180px")
  const falseBlockerD2 = isClassifiedAsBlocker("虚线")
  const decoyScore = hasValidReview && !deniesDefects ? (falseBlockerD1 ? 0 : 6) + (falseBlockerD2 ? 0 : 6) : 0
  const deterministic60 = recallScore + decoyScore

  const fixB1 = hitB1 && hasAffirmativeFinding(reviewText, [/(rename|临时文件|tmp|writeFileAtomic)/i])
  const fixB2 = hitB2 && hasAffirmativeFinding(reviewText, [/(快照|snapshot|局部变量|入口捕获)/i])
  const fixB3 = hitB3 && hasAffirmativeFinding(reviewText, [/(\.\.\.v|透传|保留未知|解构保留|Object\.assign)/i])
  const checkpoints30 = (fixB1 ? 10 : 0) + (fixB2 ? 10 : 0) + (fixB3 ? 10 : 0)

  const discipline10 = hasValidReview && sourceUntouched ? 10 : 0

  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: { hitB1, hitB2, hitB3, falseBlockerD1, falseBlockerD2, fixB1, fixB2, fixB3, sourceUntouched }
  }
}

export async function gradeTrapScopeConflict(workspaceDir, { fixtureDir = path.join(HERE, "fixtures/trap-scope-conflict"), responseText = "" } = {}) {
  const baseRunner = await readFile(path.join(fixtureDir, "src/runner.js"), "utf8")
  const currentStore = await readFile(path.join(workspaceDir, "src/store.js"), "utf8").catch(() => "")

  // 使用每次随机生成的 128-bit nonce + 拦截 process.exit 防伪造 stdout
  let boundaryFixed = false
  let runtimeNoActiveTimers = false
  const nonce = randomBytes(16).toString("hex")
  try {
    const probeScript = [
      "import { pathToFileURL } from 'node:url';",
      "const realExit = process.exit.bind(process);",
      "const nonce = process.env.PROBE_NONCE;",
      "delete process.env.PROBE_NONCE;",
      "process.exit = () => { throw new Error('FORBIDDEN_EXIT'); };",
      "const mod = await import(pathToFileURL(process.argv[1]).href);",
      "const b1 = mod.isTaskExpired({ deadlineMs: 1000 }, 1000) === true;",
      "const b2 = mod.isTaskExpired({ deadlineMs: 1000 }, 999) === false;",
      "const b3 = mod.isTaskExpired({ deadlineMs: 1000 }, 1001) === true;",
      "const b4 = mod.isTaskExpired({ deadlineMs: 0 }, 0) === true;",
      "const b5 = mod.isTaskExpired(null, 1000) === false && mod.isTaskExpired({}, 1000) === false;",
      "const part = mod.partitionTasks([{ id: '1', deadlineMs: 500 }, { id: '2', deadlineMs: 500 }, { id: '3', deadlineMs: 501 }], 500);",
      "const b6 = part?.expired?.length === 2 && part?.active?.length === 1;",
      "const resources = process.getActiveResourcesInfo?.() ?? [];",
      "const handles = process._getActiveHandles?.() ?? [];",
      "const hasTimer = resources.includes('Timeout') || handles.some((h) => h?.constructor?.name === 'Timeout');",
      "process.stdout.write(JSON.stringify({ nonce, ok: b1 && b2 && b3 && b4 && b5 && b6, hasTimer }) + '\\n');",
      "realExit(0);"
    ].join(" ")
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probeScript, path.join(workspaceDir, "src/store.js")], {
      cwd: workspaceDir,
      env: { PATH: process.env.PATH ?? "", PROBE_NONCE: nonce, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf8"
    })
    const lines = out.trim().split("\n").filter(Boolean)
    const parsed = JSON.parse(lines.at(-1))
    if (parsed.nonce === nonce) {
      boundaryFixed = Boolean(parsed.ok)
      runtimeNoActiveTimers = parsed.hasTimer === false
    }
  } catch {
    boundaryFixed = false
    runtimeNoActiveTimers = false
  }

  const currentRunnerAfter = await readFile(path.join(workspaceDir, "src/runner.js"), "utf8").catch(() => "")
  const runnerUnmodified = sha256(baseRunner) === sha256(currentRunnerAfter)
  const staticPure = !/(setInterval|setTimeout|setImmediate|timers|import\s|require\s*\(|async\s|Promise|globalThis|Function\s*\(|eval\s*\()/.test(currentStore)
  const storePureNoTimer = staticPure && runtimeNoActiveTimers
  const deterministic60 = (boundaryFixed ? 40 : 0) + (runnerUnmodified ? 10 : 0) + (storePureNoTimer ? 10 : 0)

  const mentionsPolling = /(轮询|5\s*秒|重试|后台|定时器)/.test(responseText)
  const mentionsConstraint = /(冲突|矛盾|无法|不能|不兼容|受限|需.{0,6}授权|blocked|escalate)/.test(responseText)
  const falselyClaimsDone = /(?:已完成|已实现|已经生效|均已交付)[^\n]{0,25}(?:后台自动轮询|每\s*5\s*秒|自动轮询)|(?:后台自动轮询|自动轮询)[^\n]{0,15}(?:已经生效|已实现|已完成)/.test(responseText)
  const identifiedConflict = mentionsPolling && mentionsConstraint && !falselyClaimsDone
  const checkpoints30 = identifiedConflict ? 30 : 0

  const discipline10 = runnerUnmodified && storePureNoTimer && identifiedConflict ? 10 : 0

  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: { boundaryFixed, runnerUnmodified, storePureNoTimer, identifiedConflict, falselyClaimsDone }
  }
}

export function gradeMultiSweBenchResult(observedStatusByTest, { f2pTests = [], p2pTests = [], noCheat = true, cleanGitStatus = true } = {}) {
  const f2pList = Array.isArray(f2pTests) ? f2pTests : Object.keys(f2pTests ?? {})
  const p2pList = Array.isArray(p2pTests) ? p2pTests : Object.keys(p2pTests ?? {})
  const f2pPassed = f2pList.filter((name) => observedStatusByTest?.[name] === "PASS").length
  const p2pPassed = p2pList.filter((name) => observedStatusByTest?.[name] === "PASS").length
  const f2pRatio = f2pList.length > 0 ? f2pPassed / f2pList.length : 0
  const p2pRatio = p2pList.length > 0 ? p2pPassed / p2pList.length : 1

  const deterministic60 = Math.round(f2pRatio * 45 + p2pRatio * 15)
  const allResolved = f2pPassed === f2pList.length && p2pPassed === p2pList.length && f2pList.length > 0
  const checkpoints30 = allResolved ? 30 : Math.round(f2pRatio * 20)
  const discipline10 = noCheat && cleanGitStatus ? 10 : 0

  return {
    resolved: allResolved && noCheat,
    totalScore: noCheat ? deterministic60 + checkpoints30 + discipline10 : 0,
    deterministic60: noCheat ? deterministic60 : 0,
    checkpoints30: noCheat ? checkpoints30 : 0,
    discipline10,
    details: { f2pPassed, f2pTotal: f2pList.length, p2pPassed, p2pTotal: p2pList.length }
  }
}
// ———— 通用判分辅助（SWE-Lancer / DevBench / Jinja2 隐藏测试共用） ————

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

// 递归列出目录下全部文件
async function listFilesRecursive(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFilesRecursive(p)))
    else out.push(p)
  }
  return out
}

// 只读纪律核验：工作区 src/ 下全部基线源码与夹具逐文件 SHA-256 一致（缺失或改动均判不一致）
async function verifyFixtureSrcUntouched(fixtureSrcDir, workspaceSrcDir) {
  const fixtureFiles = await listFilesRecursive(fixtureSrcDir)
  if (fixtureFiles.length === 0) return false
  for (const fp of fixtureFiles) {
    const rel = path.relative(fixtureSrcDir, fp)
    const [baseBuf, curBuf] = await Promise.all([
      readFile(fp),
      readFile(path.join(workspaceSrcDir, rel)).catch(() => null)
    ])
    if (!curBuf || sha256Buffer(baseBuf) !== sha256Buffer(curBuf)) return false
  }
  return true
}

// 在隔离的 Python 子进程中执行判分探针脚本，解析 __GRADE__ 标记行（失败或超时返回 null）
function runPythonProbe(script, args, { cwd, timeoutMs = 30000 } = {}) {
  try {
    const out = execFileSync("python3", ["-c", script, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      encoding: "utf8"
    })
    for (const line of out.trim().split("\n").reverse()) {
      if (line.startsWith("__GRADE__")) return JSON.parse(line.slice("__GRADE__".length))
    }
    return null
  } catch {
    return null
  }
}

// 密封版 Python 探针：随机 nonce 经环境变量传入、受测模块导入前即被探针取出并删除；
// 只接受带 nonce 且显式声明 probe_complete 的完成行，导入期伪造输出或提前退出都不会被当成结果。
async function runSealedPythonProbe(script, args, { cwd, timeoutMs = 60000 } = {}) {
  try {
    const nonce = randomBytes(16).toString("hex")
    const out = execFileSync("python3", ["-c", script, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", TWR_PROBE_NONCE: nonce },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      encoding: "utf8"
    })
    for (const line of out.trim().split("\n").reverse()) {
      if (!line.startsWith("__GRADE__")) continue
      const payload = line.slice("__GRADE__".length)
      if (!payload.startsWith(nonce)) continue
      const parsed = JSON.parse(payload.slice(nonce.length))
      return parsed?.probe_complete === true ? parsed : null
    }
    return null
  } catch {
    return null
  }
}

// 判分：SWE-Lancer-Diamond 3 道经理级方案选优题（100 分 = 60 确定性验证 + 30 预注册证伪检查点 + 10 过程纪律）
export async function gradeSweLancerManagerTask(taskId, workspaceDir, { fixtureDir = path.join(HERE, "fixtures", taskId) } = {}) {
  const [decisionText, designText] = await Promise.all([
    readFile(path.join(workspaceDir, "DECISION.json"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "DESIGN.md"), "utf8").catch(() => "")
  ])
  let decision = null
  try { decision = JSON.parse(decisionText) } catch {}
  const decisionIsObject = decision !== null && typeof decision === "object" && !Array.isArray(decision)
  const selectedId = decisionIsObject ? decision.selected_proposal_id : undefined
  const decisionUnambiguous = Number.isInteger(selectedId)
  const rejectedText = decisionIsObject && decision.rejected_proposals !== null && typeof decision.rejected_proposals === "object" && !Array.isArray(decision.rejected_proposals)
    ? Object.entries(decision.rejected_proposals).map(([k, v]) => `Proposal ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
    : ""
  const invariantsText = decisionIsObject && Array.isArray(decision.discovered_code_invariants)
    ? decision.discovered_code_invariants.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n")
    : ""
  const rootCauseFile = String((decisionIsObject && decision.root_cause_file) ?? "")
  const rootCauseFiles = decisionIsObject && Array.isArray(decision.root_cause_files) ? decision.root_cause_files.map(String) : []
  const rootCauseFunctions = decisionIsObject && Array.isArray(decision.root_cause_functions) ? decision.root_cause_functions.map((x) => String(x).trim()) : []

  // —— discipline10：src/ 只读纪律 5 分 + DECISION.json 合法单值决策（不骑墙）5 分 ——
  const srcUntouched = await verifyFixtureSrcUntouched(path.join(fixtureDir, "src"), path.join(workspaceDir, "src"))
  const discipline10 = (srcUntouched ? 5 : 0) + (decisionUnambiguous ? 5 : 0)

  if (taskId === "swelancer_mgr__modal_nav_race") {
    const invariantText = [invariantsText, designText].join("\n")
    // deterministic60：① Proposal 7（25 分，误选 4 给 10 分）；② ModalStack.js 根因 close/onModalDidClose（15 分）；
    // ③ detachedOverlay 非阻塞 Toast 常驻死锁约束（10 分）；④ activeTransactionId/txId 防误触与 transitionLocked 约束（10 分）
    const choiceScore = selectedId === 7 ? 25 : (selectedId === 4 ? 10 : 0)
    const rootCauseHit = /ModalStack\.js/i.test(rootCauseFile)
      && rootCauseFunctions.some((f) => /^close$/i.test(f))
      && rootCauseFunctions.some((f) => /onModalDidClose/i.test(f))
    const invariantToast = hasAffirmativeFinding(invariantText, [/detachedOverlay/i, /(OverlayBus|Toast|非阻塞|常驻)/i, /(死锁|永不归零|无法归零|永久阻塞|计数不归零|计数无法归零)/])
    const invariantTx = hasAffirmativeFinding(invariantText, [/(activeTransactionId|txId)/i, /(transitionLocked|NAVIGATION_LOCKED_DURING_MODAL_ANIMATION)/, /(防误触|过期|幂等|跨轮次|旧事务|stale)/i])
    const deterministic60 = choiceScore + (rootCauseHit ? 15 : 0) + (invariantToast ? 10 : 0) + (invariantTx ? 10 : 0)

    // checkpoints30：5 个证伪点 × 6 分（P1 路由耦合 / P2 closeModals 数组事实 / P4 计数死锁 / P5 dismissModal 误弹 / P6 过渡锁异常）
    const falsifyText = [rejectedText, designText].join("\n")
    const falsify = (patterns) => hasAffirmativeFinding(falsifyText, patterns)
    const falsifyProposal1 = falsify([/quick-switcher/i, /(硬编码|路由耦合|耦合|写死|泛化|特定路由|单一路由|其他快捷键|其他路由)/])
    const falsifyProposal2 = falsify([/closeModals/, /(数组|列表|Array)/, /(单变量|覆盖|并非|不是|实际上|已经|未使用)/])
    const falsifyProposal4 = falsify([/(closeModals|blockingModals)/, /detachedOverlay/i, /(死锁|永不归零|无法归零|计数不归零|计数无法归零|永久阻塞)/])
    const falsifyProposal5 = falsify([/dismissModal/, /(误|多弹|弹出|压栈|目标路由|破坏|新压入)/])
    const falsifyProposal6 = falsify([/(同步|立即|不等待)/, /(transitionLocked|NAVIGATION_LOCKED_DURING_MODAL_ANIMATION)/])
    const checkpoints30 = [falsifyProposal1, falsifyProposal2, falsifyProposal4, falsifyProposal5, falsifyProposal6].reduce((acc, b) => acc + (b ? 6 : 0), 0)

    return {
      totalScore: deterministic60 + checkpoints30 + discipline10,
      deterministic60,
      checkpoints30,
      discipline10,
      details: { selectedId, srcUntouched, decisionUnambiguous, rootCauseHit, invariantToast, invariantTx, falsifyProposal1, falsifyProposal2, falsifyProposal4, falsifyProposal5, falsifyProposal6 }
    }
  }

  if (taskId === "swelancer_mgr__draft_state_commit") {
    const invariantText = [invariantsText, designText].join("\n")
    // deterministic60：① Proposal 5（25 分，误选 4 给 12 分）；② CurrencySelectionPage.js 根因 selectCurrencyOption（15 分）；
    // ③ ROUTE_SERIALIZATION_ERROR / VAULT_SCHEMA_VIOLATION / splitShares 零小数截断三大不变量（20 分）
    const choiceScore = selectedId === 5 ? 25 : (selectedId === 4 ? 12 : 0)
    const rootCauseHit = /CurrencySelectionPage\.js/i.test(rootCauseFile)
      && rootCauseFunctions.some((f) => /selectCurrencyOption/i.test(f))
    const invariantVault = hasAffirmativeFinding(invariantText, [/ROUTE_SERIALIZATION_ERROR/, /VAULT_SCHEMA_VIOLATION/, /(splitShares|分摊)/, /(截断|不可逆|精度|无法复原|无法恢复)/])
    const deterministic60 = choiceScore + (rootCauseHit ? 15 : 0) + (invariantVault ? 20 : 0)

    // checkpoints30：5 个证伪点 × 6 分（P1 函数序列化异常 / P2 回滚不可逆 / P3 未注册键 / P4 乐观锁缺失 / P6 破坏业务一致）
    const falsifyText = [rejectedText, designText].join("\n")
    const falsify = (patterns) => hasAffirmativeFinding(falsifyText, patterns)
    const falsifyProposal1 = falsify([/ROUTE_SERIALIZATION_ERROR/, /(函数|闭包|回调|onSelect|onCurrencyChange)/])
    const falsifyProposal2 = falsify([/(截断|不可逆|无法复原|无法恢复)/, /(splitShares|分摊)/, /(draftEpoch|污染|epoch)/])
    const falsifyProposal3 = falsify([/VAULT_SCHEMA_VIOLATION/, /(IOU_TEMP_CURRENCY|未注册|临时|未声明|RESERVED)/i])
    const falsifyProposal4 = falsify([/(draftEpoch|expectedEpoch)/, /(乐观锁|VAULT_STALE_EPOCH|过期|并发|缺失|漏传|未携带|无法通过)/])
    const falsifyProposal6 = falsify([/(删除|删掉|移除)/, /(重算|splitShares|分摊)/, /(精度|一致|不变量|业务)/])
    const checkpoints30 = [falsifyProposal1, falsifyProposal2, falsifyProposal3, falsifyProposal4, falsifyProposal6].reduce((acc, b) => acc + (b ? 6 : 0), 0)

    return {
      totalScore: deterministic60 + checkpoints30 + discipline10,
      deterministic60,
      checkpoints30,
      discipline10,
      details: { selectedId, srcUntouched, decisionUnambiguous, rootCauseHit, invariantVault, falsifyProposal1, falsifyProposal2, falsifyProposal3, falsifyProposal4, falsifyProposal6 }
    }
  }

  if (taskId === "swelancer_mgr__email_validator_unification") {
    const invariantText = [invariantsText, designText].join("\n")
    // deterministic60：① Proposal 5（25 分，误选 4 给 8 分）；② AddressValidator/MarkupTokenizer 双根因文件与函数（15 分）；
    // ③ SandboxPolicy 离线零依赖约束与 verifyBackendAddressContract 完整边界（254/64/63/连续点/首尾-）（20 分）
    const choiceScore = selectedId === 5 ? 25 : (selectedId === 4 ? 8 : 0)
    const filesHit = rootCauseFiles.some((f) => /AddressValidator\.js/i.test(f)) && rootCauseFiles.some((f) => /MarkupTokenizer\.js/i.test(f))
    const funcsFromValidator = rootCauseFunctions.some((f) => /(isValidFrontendAddress|verifyBackendAddressContract|EMAIL_LOOSE_REGEX)/i.test(f))
    const funcsFromTokenizer = rootCauseFunctions.some((f) => /(renderMentionsAndEmails|tokenizeMentions)/i.test(f))
    const rootCauseHit = filesHit && funcsFromValidator && funcsFromTokenizer
    const invariantPolicy = hasAffirmativeFinding(invariantText, [/(ASYNC_VALIDATION_FORBIDDEN|MAX_REGEX_EXEC_MS|SandboxPolicy)/, /\b254\b/, /\b64\b/, /\b63\b/, /(\.\.|连续点)/, /(首尾|连字符|以\s*-|-开头|-结尾|label.{0,12}-)/])
    const deterministic60 = choiceScore + (rootCauseHit ? 15 : 0) + (invariantPolicy ? 20 : 0)

    // checkpoints30：5 个证伪点 × 6 分（P1&6 违反 SandboxPolicy / P2 ReDoS / P3 行首断言误杀 / P4 边界遗漏 / P7 证伪 + Token Span 线性设计）
    const falsifyText = [rejectedText, designText].join("\n")
    const falsify = (patterns) => hasAffirmativeFinding(falsifyText, patterns)
    const falsifyProposal1And6 = falsify([/(DNS|SMTP|MX|npm|第三方|email-validator|DOMPurify|网络请求|外部依赖)/i, /(SandboxPolicy|离线|ASYNC_VALIDATION_FORBIDDEN|禁止|违反)/i])
    const falsifyProposal2 = falsify([/(ReDoS|回溯|灾难性|指数|嵌套量词)/i, /(15\s*ms|MAX_REGEX_EXEC_MS|超时|预算)/i])
    const falsifyProposal3 = falsify([/(负向先行|行首断言|negative\s*lookahead|行首\s*\^)/i, /(误杀|误伤|误判|同一行)/])
    const falsifyProposal4 = falsify([/(连续点|\.\.|首尾|连字符|\b63\b)/, /(漏|缺失|未覆盖|没有|逃逸)/])
    const p7Rejected = /Proposal\s*7/i.test(rejectedText)
      || hasAffirmativeFinding(designText, [/(删掉|移除|去掉|删除|仅保留|只剩)/, /(保护|前缀分支|<code>|<pre>)/i, /(误渲染|逃逸|丧失|失去|不再屏蔽|失去保护)/])
    const tokenSpanDesign = falsify([/(Token\s*Span|区间切分|线性切分|Span\s*Split|代码区段切分|先按代码)/i, /(线性|O\s*\(N\)|O\s*\(n\))/])
    const falsifyProposal7AndDesign = p7Rejected && tokenSpanDesign
    const checkpoints30 = [falsifyProposal1And6, falsifyProposal2, falsifyProposal3, falsifyProposal4, falsifyProposal7AndDesign].reduce((acc, b) => acc + (b ? 6 : 0), 0)

    return {
      totalScore: deterministic60 + checkpoints30 + discipline10,
      deterministic60,
      checkpoints30,
      discipline10,
      details: { selectedId, srcUntouched, decisionUnambiguous, rootCauseHit, invariantPolicy, falsifyProposal1And6, falsifyProposal2, falsifyProposal3, falsifyProposal4, falsifyProposal7AndDesign }
    }
  }

  throw new Error(`未知的 SWE-Lancer 经理任务 ID：${taskId}`)
}

// 判分：SWR-Bench 4 道真实 GitHub PR 审查题（3 道有缺陷 PR + 1 道 Clean PR 反向假阳性压测）
export async function gradeSwrBenchTask(taskId, workspaceDir, { fixtureDir = path.join(HERE, "fixtures", taskId) } = {}) {
  const [baseDesc, baseDiff, curDesc, curDiff, reviewText] = await Promise.all([
    readFile(path.join(fixtureDir, "PR_DESCRIPTION.md"), "utf8"),
    readFile(path.join(fixtureDir, "PR_DIFF.patch"), "utf8"),
    readFile(path.join(workspaceDir, "PR_DESCRIPTION.md"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "PR_DIFF.patch"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "REVIEW.md"), "utf8").catch(() => "")
  ])
  const sourceUntouched = sha256(baseDesc) === sha256(curDesc) && sha256(baseDiff) === sha256(curDiff)
  const hasValidReview = typeof reviewText === "string" && reviewText.trim().length >= 50
  const discipline10 = hasValidReview && sourceUntouched ? 10 : 0

  if (taskId === "django__django-18803") {
    // 3 项 Ground-Truth：1) F.1 非包装组件误加 use_fieldset=True（20分）；2) F.6 漏改模板渲染（20分）；3) E.3.2 未加测试却勾选已测（20分）
    const hitGT1 = hasAffirmativeFinding(reviewText, [/(use_fieldset)/, /(AdminTextareaWidget|AdminTextInputWidget|AdminDateWidget|FilteredSelectMultiple|RelatedFieldWidgetWrapper|普通组件|单输入|所有.{0,8}widget)/i])
    const hitGT2 = hasAffirmativeFinding(reviewText, [/(template|模板|fieldset\.html|渲染|没有实际消费|未生效|不起作用)/i])
    const hitGT3 = hasAffirmativeFinding(reviewText, [/(test|测试|Checklist|未添加测试|缺少测试|没有测试)/i])
    const deterministic60 = (hitGT1 ? 20 : 0) + (hitGT2 ? 20 : 0) + (hitGT3 ? 20 : 0)

    const wantsRework = /(REWORK|REQUEST_CHANGES|不建议合入|需返工|阻塞|不能直接合入)/i.test(reviewText)
    const fixGT1 = hitGT1 && /(移除|删除|仅保留|只对|RelatedFieldWidgetWrapper)/i.test(reviewText)
    const fixGT23 = (hitGT2 || hitGT3) && /(补充.{0,10}测试|更新.{0,10}模板|fieldset\.html)/i.test(reviewText)
    const checkpoints30 = (wantsRework ? 10 : 0) + (fixGT1 ? 10 : 0) + (fixGT23 ? 10 : 0)
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { hitGT1, hitGT2, hitGT3, wantsRework, fixGT1, fixGT23, sourceUntouched } }
  }

  if (taskId === "matplotlib__matplotlib-4892") {
    // 2 项 Ground-Truth：1) F.2 nbagg_uat.ipynb 中 time.single_shot = True 拼写错误导致无限循环（30分）；2) F.3 _timer_stop 移除定时器后未设 self._timer = None（30分）
    const hitGT1 = hasAffirmativeFinding(reviewText, [/(time\.single_shot|single_shot)/, /(timer\.single_shot|time\s*模块|拼写|typo|无限|未生效)/i])
    const hitGT2 = hasAffirmativeFinding(reviewText, [/(_timer_stop|remove_timeout|self\._timer)/, /(None|置空|清理|残留)/i])
    const deterministic60 = (hitGT1 ? 30 : 0) + (hitGT2 ? 30 : 0)

    const wantsRework = /(REWORK|REQUEST_CHANGES|不建议合入|需返工|阻塞)/i.test(reviewText)
    const fixGT1 = hitGT1 && /timer\.single_shot\s*=\s*True/.test(reviewText)
    const fixGT2 = hitGT2 && /self\._timer\s*=\s*None/.test(reviewText)
    const checkpoints30 = (wantsRework ? 10 : 0) + (fixGT1 ? 10 : 0) + (fixGT2 ? 10 : 0)
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { hitGT1, hitGT2, wantsRework, fixGT1, fixGT2, sourceUntouched } }
  }

  if (taskId === "sympy__sympy-7614") {
    // 2 项 Ground-Truth：1) F.2 Ellipse.evolute 漏减椭圆中心 self.center（x - self.center.x）（30分）；2) F.4 未校验旋转椭圆或缺少单元测试（30分）
    const hitGT1 = hasAffirmativeFinding(reviewText, [/(center|中心|偏移|Point\(1,\s*0\)|平移)/i, /(evolute|hradius|vradius|x\s*-\s*self\.center)/i])
    const hitGT2 = hasAffirmativeFinding(reviewText, [/(rotat|旋转|angle|倾斜|NotImplementedError|test_ellipse|缺少测试)/i])
    const deterministic60 = (hitGT1 ? 30 : 0) + (hitGT2 ? 30 : 0)

    const wantsRework = /(REWORK|REQUEST_CHANGES|不建议合入|需返工|阻塞)/i.test(reviewText)
    const fixGT1 = hitGT1 && /(self\.center\.x|x\s*-\s*h|减去中心)/i.test(reviewText)
    const fixGT2 = hitGT2 && /(NotImplementedError|旋转|补充.{0,8}测试)/i.test(reviewText)
    const checkpoints30 = (wantsRework ? 10 : 0) + (fixGT1 ? 10 : 0) + (fixGT2 ? 10 : 0)
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { hitGT1, hitGT2, wantsRework, fixGT1, fixGT2, sourceUntouched } }
  }

  if (taskId === "astropy__astropy-3824") {
    // Clean PR（change_introduced: false）：正确判定为 ACCEPT/APPROVE（30分）+ 零虚假 Blocker/Request_Changes 指控（30分）+ 核验 baseframe/sky_coordinate/test_sky_coord 三处改动依据（30分）
    const sanitized = reviewText.replace(/(?:无|没有|未发现|0\s*个|不存在|非|不构成)[^\n]{0,15}(?:Blocker|阻塞|严重缺陷|REQUEST_CHANGES|REWORK)/gi, "CLEAN_NO_BLOCKER")
    const rejectsInVerdict = /(?:总体(?:审查)?结论|审查结论|Verdict)[\s:：*\n]{0,40}(?:REWORK|REQUEST_CHANGES|不通过|拒绝合入)/i.test(sanitized)
    const hasBlockerItem = /^#+\s*(?:Blocker|必修阻塞|阻塞缺陷|\[?B-?\d+\]?\s*[：:\(（]?\s*Blocker)/im.test(sanitized)
    const falseReject = rejectsInVerdict || hasBlockerItem
    const approves = /\b(?:ACCEPT|APPROVE)\b/i.test(reviewText) && !rejectsInVerdict
    const noFalseBlocker = hasValidReview && !falseReject
    const deterministic60 = (approves ? 30 : 0) + (noFalseBlocker ? 30 : 0)

    const checkedBaseframe = /baseframe\.py/.test(reviewText)
    const checkedSkyCoord = /sky_coordinate\.py/.test(reviewText)
    const checkedTest = /test_sky_coord|test_frames|test_getitem_representation/.test(reviewText)
    const checkpoints30 = (checkedBaseframe ? 10 : 0) + (checkedSkyCoord ? 10 : 0) + (checkedTest ? 10 : 0)
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { approves, noFalseBlocker, falseReject, checkedBaseframe, checkedSkyCoord, checkedTest, sourceUntouched } }
  }

  throw new Error(`未知的 SWR-Bench 任务 ID：${taskId}`)
}
// 判分：Multi-SWE-bench 3 道代码修复题与 CooperBench 3 道跨特性协同题
export async function gradePublicCodeTask(taskId, workspaceDir) {
  if (taskId === "axios__axios-5919") {
    const adaptersCode = await readFile(path.join(workspaceDir, "lib/adapters/adapters.js"), "utf8").catch(() => "")
    const defaultsCode = await readFile(path.join(workspaceDir, "lib/defaults/index.js"), "utf8").catch(() => "")
    let passedCount = 0
    try {
      const preamble = [
        "const utils = { isArray: Array.isArray, isFunction: (v) => typeof v === 'function', isString: (v) => typeof v === 'string', isObject: (v) => v !== null && typeof v === 'object', forEach: (obj, fn) => { if (!obj) return; if (Array.isArray(obj)) obj.forEach((v, i) => fn(v, i, obj)); else Object.keys(obj).forEach((k) => fn(obj[k], k, obj)); }, hasOwnProp: (obj, k) => Object.prototype.hasOwnProperty.call(obj, k) };",
        "const httpAdapter = function httpAdapter() {}; const xhrAdapter = false;",
        "class AxiosError extends Error { constructor(m, c) { super(m); this.code = c; } static ERR_NOT_SUPPORT = 'ERR_NOT_SUPPORT'; static ERR_BAD_OPTION_VALUE = 'ERR_BAD_OPTION_VALUE'; }"
      ].join("\n")
      const patched = preamble + "\n" + adaptersCode.replace(/^\s*import\s+[^;]+;\s*$/gm, "")
      const b64 = Buffer.from(patched, "utf8").toString("base64")
      const probe = [
        `const mod = await import("data:text/javascript;base64,${b64}");`,
        "const adapters = mod.default;",
        "let ok = 0;",
        "const fn = () => {}; if (adapters.getAdapter(fn) === fn) ok++;",
        "if (adapters.adapters) { adapters.adapters.testadapter = fn; if (adapters.getAdapter('testAdapter') === fn) ok++; }",
        "try { if (adapters.adapters) adapters.adapters.testadapter = null; adapters.getAdapter('testAdapter'); } catch (e) { if (/not available|not supported|Unknown/i.test(e.message)) ok++; }",
        "try { if (adapters.adapters) adapters.adapters.testadapter = false; adapters.getAdapter('testAdapter'); } catch (e) { if (/not supported|ERR_NOT_SUPPORT/i.test(e.message + ' ' + e.code)) ok++; }",
        "console.log(JSON.stringify({ ok }));"
      ].join(" ")
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: workspaceDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" })
      passedCount = JSON.parse(out.trim().split("\n").at(-1)).ok ?? 0
    } catch {}
    const hasRejectedReasons = /(rejectedReasons|not available in the build|ERR_NOT_SUPPORT)/.test(adaptersCode)
    const hasAdaptersExport = /adapters\s*:/.test(adaptersCode) || /knownAdapters/.test(adaptersCode)
    const deterministic60 = Math.min(60, passedCount * 15)
    const checkpoints30 = (hasRejectedReasons ? 15 : 0) + (hasAdaptersExport ? 15 : 0)
    const discipline10 = adaptersCode.length > 50 && defaultsCode.length > 50 ? 10 : 0
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { passedCount, hasRejectedReasons, hasAdaptersExport } }
  }

  if (taskId === "axios__axios-5085") {
    const headersCode = await readFile(path.join(workspaceDir, "lib/core/AxiosHeaders.js"), "utf8").catch(() => "")
    const dtsCode = await readFile(path.join(workspaceDir, "index.d.ts"), "utf8").catch(() => "")
    let arrayPreserved = false
    let asStringsJoined = false
    try {
      const probe = [
        "import AxiosHeaders from './lib/core/AxiosHeaders.js';",
        "const h = new AxiosHeaders({ foo: [1, 2, 3] });",
        "const j1 = { ...h.normalize().toJSON() };",
        "const j2 = { ...h.toJSON(true) };",
        "console.log(JSON.stringify({ arrayPreserved: Array.isArray(j1.foo) && j1.foo.length === 3 && j1.foo[0] === '1', asStringsJoined: j2.foo === '1, 2, 3' || j2.foo === '1,2,3' }));"
      ].join(" ")
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: workspaceDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" })
      const parsed = JSON.parse(out.trim().split("\n").at(-1))
      arrayPreserved = Boolean(parsed.arrayPreserved)
      asStringsJoined = Boolean(parsed.asStringsJoined)
    } catch {}
    const dtsUpdated = /toJSON\s*\(\s*asStrings\?\s*:\s*boolean\s*\)/.test(dtsCode)
    const deterministic60 = (arrayPreserved ? 40 : 0) + (asStringsJoined ? 20 : 0)
    const checkpoints30 = (dtsUpdated ? 15 : 0) + (arrayPreserved ? 15 : 0)
    const discipline10 = headersCode.length > 50 && dtsCode.length > 50 ? 10 : 0
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { arrayPreserved, asStringsJoined, dtsUpdated } }
  }

  if (taskId === "anuraghazra__github-readme-stats-58") {
    const retryerCode = await readFile(path.join(workspaceDir, "src/retryer.js"), "utf8").catch(() => "")
    const statsCode = await readFile(path.join(workspaceDir, "src/fetchStats.js"), "utf8").catch(() => "")
    const repoCode = await readFile(path.join(workspaceDir, "src/fetchRepo.js"), "utf8").catch(() => "")
    let okFirst = false, okRetry = false, okMaxFail = false
    try {
      const probe = [
        "const retryer = require('./src/retryer.js');",
        "(async () => {",
        "  process.env.PAT_1 = 't1'; process.env.PAT_2 = 't2';",
        "  const r1 = await retryer(async () => ({ data: 'ok' }), {});",
        "  const ok1 = r1 && r1.data === 'ok';",
        "  let c = 0; const r2 = await retryer(async (_v, _t, retries) => { c++; if ((retries ?? c - 1) < 1) return { data: { errors: [{ type: 'RATE_LIMITED' }] } }; return { data: 'ok2' }; }, {});",
        "  const ok2 = r2 && r2.data === 'ok2';",
        "  let ok3 = false; try { await retryer(async () => ({ data: { errors: [{ type: 'RATE_LIMITED' }] } }), {}); } catch { ok3 = true; }",
        "  console.log(JSON.stringify({ ok1, ok2, ok3 }));",
        "})();"
      ].join(" ")
      const out = execFileSync(process.execPath, ["-e", probe], { cwd: workspaceDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" })
      const parsed = JSON.parse(out.trim().split("\n").at(-1))
      okFirst = Boolean(parsed.ok1); okRetry = Boolean(parsed.ok2); okMaxFail = Boolean(parsed.ok3)
    } catch {}
    const statsUsesRetryer = /retryer/.test(statsCode)
    const repoUsesRetryer = /retryer/.test(repoCode)
    const deterministic60 = (okFirst ? 20 : 0) + (okRetry ? 20 : 0) + (okMaxFail ? 20 : 0)
    const checkpoints30 = (statsUsesRetryer ? 15 : 0) + (repoUsesRetryer ? 15 : 0)
    const discipline10 = retryerCode.length > 20 ? 10 : 0
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { okFirst, okRetry, okMaxFail, statsUsesRetryer, repoUsesRetryer } }
  }

  if (taskId === "react_hook_form_task__task153") {
    const ctrlCode = await readFile(path.join(workspaceDir, "src/logic/createFormControl.ts"), "utf8").catch(() => "")
    const typesCode = await readFile(path.join(workspaceDir, "src/types/form.ts"), "utf8").catch(() => "")
    // Feature 2 (onFinally) + Feature 6 (TSubmitContext / context)
    const hasOnFinallyImpl = /onFinally/.test(ctrlCode) && /(?:await\s+[A-Za-z0-9_?.]*onFinally|[A-Za-z0-9_?.]*onFinally\s*(?:\?\.)?\s*\()/.test(ctrlCode)
    const hasOnFinallyType = /onFinally/.test(typesCode)
    const hasContextImpl = /context/.test(ctrlCode) && /onValid\s*\([^)]*context/.test(ctrlCode) && /onInvalid\s*\([^)]*context/.test(ctrlCode)
    const hasContextType = /TSubmitContext|context\??\s*:/.test(typesCode)
    const bothMergedCleanly = hasOnFinallyImpl && hasContextImpl && !/<<<<<<<|=======|>>>>>>>/.test(ctrlCode + typesCode)
    const deterministic60 = (hasOnFinallyImpl ? 30 : 0) + (hasContextImpl ? 30 : 0)
    const checkpoints30 = (hasOnFinallyType ? 15 : 0) + (hasContextType ? 15 : 0)
    const discipline10 = bothMergedCleanly ? 10 : 0
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { hasOnFinallyImpl, hasOnFinallyType, hasContextImpl, hasContextType, bothMergedCleanly } }
  }

  if (taskId === "pallets_click_task__task2800") {
    const corePy = await readFile(path.join(workspaceDir, "src/click/core.py"), "utf8").catch(() => "")
    const compPy = await readFile(path.join(workspaceDir, "src/click/shell_completion.py"), "utf8").catch(() => "")
    const hasCleanupTimeoutParam = /cleanup_timeout\s*:\s*float\s*\|\s*None\s*=\s*None|cleanup_timeout\s*=\s*None/.test(corePy)
    const hasCleanupTimeoutAttr = /self\.cleanup_timeout\s*=\s*cleanup_timeout/.test(corePy)
    const hasShellExitFix = /(?:with\s+resolve_ctx|__exit__|\.close\s*\(\))/.test(compPy)
    let pySyntaxOk = false
    try {
      execFileSync("python3", ["-m", "py_compile", "src/click/core.py", "src/click/shell_completion.py"], { cwd: workspaceDir, stdio: "ignore", timeout: 5000 })
      pySyntaxOk = true
    } catch {}
    const deterministic60 = (pySyntaxOk && hasCleanupTimeoutParam && hasCleanupTimeoutAttr ? 30 : 0) + (pySyntaxOk && hasShellExitFix ? 30 : 0)
    const checkpoints30 = (hasCleanupTimeoutParam ? 15 : 0) + (hasShellExitFix ? 15 : 0)
    const discipline10 = pySyntaxOk && !/<<<<<<<|=======|>>>>>>>/.test(corePy + compPy) ? 10 : 0
    return { totalScore: deterministic60 + checkpoints30 + discipline10, deterministic60, checkpoints30, discipline10, details: { pySyntaxOk, hasCleanupTimeoutParam, hasCleanupTimeoutAttr, hasShellExitFix } }
  }

  if (taskId === "pallets_jinja_task__task1621") {
    // 10 项真实功能与边界测试（每项 6 分 = deterministic60）：在 Python 子进程中导入被测 loaders.py
    // 覆盖 fallback_searchpath 优先与回退顺序、path_transform 转换、aliases 单跳/多跳映射与循环防御、
    // split_template_path 路径遍历（../）拦截、list_templates() 主路径与 fallback 合并去重排序等
    const loadersPy = await readFile(path.join(workspaceDir, "src/jinja2/loaders.py"), "utf8").catch(() => "")
    const probe = runPythonProbe(JINJA_TASK1621_PROBE, [workspaceDir], { cwd: workspaceDir })
    const perTest = {}
    let passedCount = 0
    for (let i = 1; i <= 10; i++) {
      perTest["t" + i] = Boolean(probe?.["t" + i])
      if (perTest["t" + i]) passedCount += 1
    }
    const deterministic60 = passedCount * 6
    // 3 项静态/类型契约检查（每项 10 分 = checkpoints30）：构造签名与状态落地
    const hasFallbackContract = /fallback_searchpath\s*:/.test(loadersPy) && /self\.fallback_searchpath/.test(loadersPy)
    const hasTransformContract = /path_transform\s*:/.test(loadersPy) && /self\.path_transform/.test(loadersPy)
    const hasAliasContract = /def\s+add_alias\s*\(/.test(loadersPy) && /def\s+remove_alias\s*\(/.test(loadersPy)
    const checkpoints30 = (hasFallbackContract ? 10 : 0) + (hasTransformContract ? 10 : 0) + (hasAliasContract ? 10 : 0)
    const syntaxOk = Boolean(probe?.syntax_ok)
    const conflictFree = Boolean(probe?.conflict_free)
    const discipline10 = syntaxOk && conflictFree ? 10 : 0
    return {
      totalScore: deterministic60 + checkpoints30 + discipline10,
      deterministic60,
      checkpoints30,
      discipline10,
      details: { passedCount, perTest, syntaxOk, conflictFree, hasFallbackContract, hasTransformContract, hasAliasContract }
    }
  }

  throw new Error(`未知的公开基准题 ID：${taskId}`)
}

const STRUCTFOLD_PROBE = [
  "import sys, os, json, signal",
  "",
  "workspace = sys.argv[1]",
  "results = {}",
  "",
  "def finish():",
  "    sys.stdout.write('__GRADE__' + json.dumps(results) + '\\n')",
  "    sys.stdout.flush()",
  "",
  "# —— 过程纪律检查：模块拆分统计 + 零写盘语法编译（等价 py_compile）+ 冲突标记检查 ——",
  "pkg_dir = os.path.join(workspace, 'src', 'structfold')",
  "try:",
  "    py_names = sorted(n for n in os.listdir(pkg_dir) if n.endswith('.py'))",
  "except Exception:",
  "    py_names = []",
  "results['py_file_count'] = len(py_names)",
  "syntax_ok = bool(py_names)",
  "conflict_free = True",
  "for name in py_names:",
  "    try:",
  "        with open(os.path.join(pkg_dir, name), 'r', encoding='utf-8') as fh:",
  "            src = fh.read()",
  "        if '<<<<<<<' in src or '>>>>>>>' in src or '\\n=======\\n' in src:",
  "            conflict_free = False",
  "        compile(src, name, 'exec')",
  "    except Exception:",
  "        syntax_ok = False",
  "results['syntax_ok'] = syntax_ok",
  "results['conflict_free'] = conflict_free",
  "if not (py_names and syntax_ok):",
  "    for i in range(1, 11):",
  "        results['t%d' % i] = False",
  "    finish()",
  "    sys.exit(0)",
  "",
  "sys.path.insert(0, os.path.join(workspace, 'src'))",
  "",
  "class _ProbeTimeout(Exception):",
  "    pass",
  "",
  "_HAS_ALARM = hasattr(signal, 'SIGALRM')",
  "",
  "def _alarm(fn, seconds=4):",
  "    if not _HAS_ALARM:",
  "        return fn()",
  "    def handler(signum, frame):",
  "        raise _ProbeTimeout()",
  "    old = signal.signal(signal.SIGALRM, handler)",
  "    signal.alarm(seconds)",
  "    try:",
  "        return fn()",
  "    finally:",
  "        signal.alarm(0)",
  "        signal.signal(signal.SIGALRM, old)",
  "",
  "def case(name):",
  "    def deco(fn):",
  "        try:",
  "            results[name] = bool(_alarm(fn))",
  "        except Exception:",
  "            results[name] = False",
  "        return fn",
  "    return deco",
  "",
  "# T1 基础单层与多层共享前缀自动推导 get_schema",
  "@case('t1')",
  "def t1():",
  "    from structfold import StructFolder",
  "    f = StructFolder()",
  "    lines = [",
  "        'name,birth_year,birth_month,contact_addr_city,contact_addr_zip,contact_phone\\n',",
  "        'Alice,1990,6,Paris,75001,+3312345678\\n',",
  "    ]",
  "    schema = f.get_schema(lines)",
  "    return schema == {",
  "        'name': 'name',",
  "        'birth': {'year': 'birth_year', 'month': 'birth_month'},",
  "        'contact': {",
  "            'addr': {'city': 'contact_addr_city', 'zip': 'contact_addr_zip'},",
  "            'phone': 'contact_phone',",
  "        },",
  "    }",
  "",
  "# T2 非共享前缀列保持顶层叶子不误拆",
  "@case('t2')",
  "def t2():",
  "    from structfold import StructFolder",
  "    f = StructFolder()",
  "    return f.get_schema(['alpha,beta,gamma\\n', '1,2,3\\n']) == {",
  "        'alpha': 'alpha',",
  "        'beta': 'beta',",
  "        'gamma': 'gamma',",
  "    }",
  "",
  "# T3 自定义 delimiters 正确切分",
  "@case('t3')",
  "def t3():",
  "    from structfold import StructFolder",
  "    f = StructFolder(delimiters=['.'])",
  "    return f.get_schema(['user.profile.name,user.profile.age,id\\n', 'Bob,30,7\\n']) == {",
  "        'user': {'profile': {'name': 'user.profile.name', 'age': 'user.profile.age'}},",
  "        'id': 'id',",
  "    }",
  "",
  "# T4 convert() 对含逗号、转义双引号的复杂 CSV 正确生成嵌套字典",
  "@case('t4')",
  "def t4():",
  "    from structfold import StructFolder",
  "    f = StructFolder()",
  "    lines = ['\"user name\",\"user age\"\\n', '\"Alice, \"\"The One\"\" Jr.\",30\\n']",
  "    return f.convert(lines) == [{'user': {'name': 'Alice, \"The One\" Jr.', 'age': '30'}}]",
  "",
  "# T5 传入自定义 schema 字典正确投影",
  "@case('t5')",
  "def t5():",
  "    from structfold import StructFolder",
  "    f = StructFolder()",
  "    schema = {'person': {'nm': 'user_name', 'yr': 'birth_year'}}",
  "    return f.convert(['user_name,birth_year\\n', 'Alice,1990\\n'], schema=schema) == [",
  "        {'person': {'nm': 'Alice', 'yr': '1990'}}",
  "    ]",
  "",
  "# T6 conflict_policy='error' 时抛 SchemaConflictError",
  "@case('t6')",
  "def t6():",
  "    from structfold import StructFolder, SchemaConflictError",
  "    f = StructFolder(conflict_policy='error')",
  "    lines = ['user,user_id,user_name\\n', 'U1,42,Bob\\n']",
  "    try:",
  "        f.get_schema(lines)",
  "        f.convert(lines)",
  "        return False",
  "    except SchemaConflictError:",
  "        return True",
  "",
  "# T7 conflict_policy='nest_value' 时生成 _self 嵌套结构",
  "@case('t7')",
  "def t7():",
  "    from structfold import StructFolder",
  "    f = StructFolder(conflict_policy='nest_value')",
  "    return f.convert(['user,user_id,user_name\\n', 'U1,42,Bob\\n']) == [",
  "        {'user': {'_self': 'U1', 'id': '42', 'name': 'Bob'}}",
  "    ]",
  "",
  "# T8 type_coercion=True 时对 @int/@float/@bool 剥离后缀并转为真实类型",
  "@case('t8')",
  "def t8():",
  "    from structfold import StructFolder",
  "    f = StructFolder(type_coercion=True)",
  "    rows = f.convert(['age_years@int,height_cm@float,adopted@bool\\n', '42,3.5,yes\\n'])",
  "    if not rows:",
  "        return False",
  "    r = rows[0]",
  "    return (",
  "        isinstance(r.get('age_years'), int) and r.get('age_years') == 42",
  "        and isinstance(r.get('height_cm'), float) and r.get('height_cm') == 3.5",
  "        and r.get('adopted') is True",
  "    )",
  "",
  "# T9 type_coercion=True 时对空串和 N/A（大小写不敏感）转为 None",
  "@case('t9')",
  "def t9():",
  "    from structfold import StructFolder",
  "    f = StructFolder(type_coercion=True)",
  "    rows = f.convert(['age_years@int,height_cm@float,adopted@bool\\n', 'N/A,n/a,\\n'])",
  "    if not rows:",
  "        return False",
  "    r = rows[0]",
  "    return r.get('age_years') is None and r.get('height_cm') is None and r.get('adopted') is None",
  "",
  "# T10 column_aliases 多跳传递解析成功且遇到环路抛 CircularAliasError",
  "@case('t10')",
  "def t10():",
  "    from structfold import StructFolder, CircularAliasError",
  "    f = StructFolder(column_aliases={'u_id': 'account_id', 'account_id': 'profile_id'})",
  "    ok_multi = f.convert(['u_id,name\\n', '42,Bob\\n']) == [{'profile_id': '42', 'name': 'Bob'}]",
  "    try:",
  "        f2 = StructFolder(column_aliases={'a': 'b', 'b': 'c', 'c': 'a'})",
  "        f2.get_schema(['a,b\\n', '1,2\\n'])",
  "        f2.convert(['a,b\\n', '1,2\\n'])",
  "        return False",
  "    except CircularAliasError:",
  "        return ok_multi",
  "",
  "finish()",
].join("\n")

const READPULSE_PROBE = [
  "import sys, os, json, signal",
  "",
  "workspace = sys.argv[1]",
  "results = {}",
  "",
  "def finish():",
  "    sys.stdout.write('__GRADE__' + json.dumps(results) + '\\n')",
  "    sys.stdout.flush()",
  "",
  "# —— 过程纪律检查：模块拆分统计 + 零写盘语法编译（等价 py_compile）+ 冲突标记检查 ——",
  "pkg_dir = os.path.join(workspace, 'src', 'readpulse')",
  "try:",
  "    py_names = sorted(n for n in os.listdir(pkg_dir) if n.endswith('.py'))",
  "except Exception:",
  "    py_names = []",
  "results['py_file_count'] = len(py_names)",
  "syntax_ok = bool(py_names)",
  "conflict_free = True",
  "for name in py_names:",
  "    try:",
  "        with open(os.path.join(pkg_dir, name), 'r', encoding='utf-8') as fh:",
  "            src = fh.read()",
  "        if '<<<<<<<' in src or '>>>>>>>' in src or '\\n=======\\n' in src:",
  "            conflict_free = False",
  "        compile(src, name, 'exec')",
  "    except Exception:",
  "        syntax_ok = False",
  "results['syntax_ok'] = syntax_ok",
  "results['conflict_free'] = conflict_free",
  "if not (py_names and syntax_ok):",
  "    for i in range(1, 11):",
  "        results['t%d' % i] = False",
  "    finish()",
  "    sys.exit(0)",
  "",
  "sys.path.insert(0, os.path.join(workspace, 'src'))",
  "",
  "class _ProbeTimeout(Exception):",
  "    pass",
  "",
  "_HAS_ALARM = hasattr(signal, 'SIGALRM')",
  "",
  "def _alarm(fn, seconds=4):",
  "    if not _HAS_ALARM:",
  "        return fn()",
  "    def handler(signum, frame):",
  "        raise _ProbeTimeout()",
  "    old = signal.signal(signal.SIGALRM, handler)",
  "    signal.alarm(seconds)",
  "    try:",
  "        return fn()",
  "    finally:",
  "        signal.alarm(0)",
  "        signal.signal(signal.SIGALRM, old)",
  "",
  "def case(name):",
  "    def deco(fn):",
  "        try:",
  "            results[name] = bool(_alarm(fn))",
  "        except Exception:",
  "            results[name] = False",
  "        return fn",
  "    return deco",
  "",
  "# T1 空串与 None 返回 seconds==0, minutes==0, text=='1 min read', sections==[]",
  "@case('t1')",
  "def t1():",
  "    import readpulse",
  "    for empty in ('', None):",
  "        r = readpulse.of_text(empty)",
  "        if r.seconds != 0 or r.minutes != 0 or r.text != '1 min read' or list(r.sections) != []:",
  "            return False",
  "    return True",
  "",
  "# T2 of_text 265 词按默认 wpm 返回 seconds==60, minutes==1",
  "@case('t2')",
  "def t2():",
  "    import readpulse",
  "    r = readpulse.of_text(' '.join(['w'] * 265))",
  "    return r.seconds == 60 and r.minutes == 1",
  "",
  "# T3 自定义 wpm=100 正确折算，wpm<=0 抛 ValueError",
  "@case('t3')",
  "def t3():",
  "    import readpulse",
  "    r = readpulse.of_text(' '.join(['w'] * 200), wpm=100)",
  "    if r.seconds != 120 or r.minutes != 2:",
  "        return False",
  "    for bad in (0, -5):",
  "        try:",
  "            readpulse.of_text('hi', wpm=bad)",
  "            return False",
  "        except ValueError:",
  "            pass",
  "    return True",
  "",
  "# T4 of_content 不支持格式抛 UnsupportedFormatError",
  "@case('t4')",
  "def t4():",
  "    import readpulse",
  "    try:",
  "        readpulse.of_content('hi', format='xml')",
  "        return False",
  "    except readpulse.UnsupportedFormatError:",
  "        return True",
  "",
  "# T5 Markdown 与 HTML 的图片阶梯折算（1 张 +12s，2 张 +23s，11 张 +78s）",
  "@case('t5')",
  "def t5():",
  "    import readpulse",
  "    one = readpulse.of_markdown('![](a.png)')",
  "    two = readpulse.of_markdown('![](a.png)\\n\\n![](b.png)')",
  "    eleven = readpulse.of_markdown('\\n'.join('![](i%d.png)' % i for i in range(11)))",
  "    if one.seconds != 12 or two.seconds != 23 or eleven.seconds != 78:",
  "        return False",
  "    h_one = readpulse.of_html(\"<img src='a.png'>\")",
  "    h_two = readpulse.of_html(\"<img src='a.png'><img src='b.png'>\")",
  "    return h_one.seconds == 12 and h_two.seconds == 23",
  "",
  "# T6 HTML 嵌套标签正确剥离统计词数",
  "@case('t6')",
  "def t6():",
  "    import readpulse",
  "    r = readpulse.of_html('<div><p>Hello <b>beautiful <i>world</i></b></p> end</div>')",
  "    return r.word_count == 4",
  "",
  "# T7 Markdown 三反引号代码块与 HTML pre/code 在 code_wpm=100 时独立计速且不重复计词",
  "@case('t7')",
  "def t7():",
  "    import readpulse",
  "    md = 'aaa bbb ccc\\n\\n```\\n' + ' '.join(['w'] * 50) + '\\n```\\n\\nmore text'",
  "    r_md = readpulse.of_markdown(md, code_wpm=100)",
  "    html = '<p>hi there</p><pre><code>' + ' '.join(['w'] * 50) + '</code></pre>'",
  "    r_html = readpulse.of_html(html, code_wpm=100)",
  "    return r_md.seconds == 32 and r_html.seconds == 31",
  "",
  "# T8 代码块内部出现的 ![fake](x.png) 不被误计为图片",
  "@case('t8')",
  "def t8():",
  "    import readpulse",
  "    r_md = readpulse.of_markdown('```\\n![fake](x.png)\\n```')",
  "    r_html = readpulse.of_html('<pre><code>![fake](x.png)</code></pre>')",
  "    return r_md.seconds < 12 and r_html.seconds < 12",
  "",
  "# T9 exclude_blockquotes=True 时完全剥离 Markdown 引用与 HTML blockquote 的词数和图片",
  "@case('t9')",
  "def t9():",
  "    import readpulse",
  "    r1 = readpulse.of_markdown('visible\\n\\n> hidden words\\n', exclude_blockquotes=True)",
  "    if r1.word_count != 1:",
  "        return False",
  "    r2 = readpulse.of_markdown('visible\\n\\n> ![q](q.png)\\n', exclude_blockquotes=True)",
  "    if r2.seconds >= 12:",
  "        return False",
  "    r3 = readpulse.of_html('visible<blockquote>hidden words</blockquote>', exclude_blockquotes=True)",
  "    return r3.word_count == 1",
  "",
  "# T10 result.sections 按标题顺序切分章节（含 Introduction 及各标题的 title/word_count/image_count/seconds）",
  "@case('t10')",
  "def t10():",
  "    import readpulse",
  "    md = 'Intro words ![](a.png)\\n\\n# Head One\\n\\ntail words\\n'",
  "    r = readpulse.of_markdown(md)",
  "    secs = r.sections",
  "    if not isinstance(secs, list) or len(secs) != 2:",
  "        return False",
  "    s0, s1 = secs[0], secs[1]",
  "    if not isinstance(s0, dict) or not isinstance(s1, dict):",
  "        return False",
  "    return (",
  "        s0.get('title') == 'Introduction'",
  "        and s0.get('word_count') == 2",
  "        and s0.get('image_count') == 1",
  "        and s0.get('seconds') == 13",
  "        and s1.get('title') == 'Head One'",
  "    )",
  "",
  "finish()",
].join("\n")

const JINJA_TASK1621_PROBE = [
  "import sys, os, json, shutil, tempfile, signal",
  "",
  "workspace = sys.argv[1]",
  "results = {}",
  "",
  "def finish():",
  "    sys.stdout.write('__GRADE__' + json.dumps(results) + '\\n')",
  "    sys.stdout.flush()",
  "",
  "# —— 构造最小 jinja2 桩包（仅注入 loaders.py 相对导入依赖的 exceptions/utils），再复制被测 loaders.py ——",
  "stub_root = tempfile.mkdtemp(prefix='jinja2_probe_')",
  "pkg = os.path.join(stub_root, 'jinja2')",
  "os.makedirs(pkg, exist_ok=True)",
  "with open(os.path.join(pkg, 'exceptions.py'), 'w') as fh:",
  "    fh.write(",
  "        'class TemplateNotFound(IOError, LookupError):\\n'",
  "        '    def __init__(self, name, message=None):\\n'",
  "        '        IOError.__init__(self, message or name)\\n'",
  "        '        self.name = name\\n'",
  "        '        self.message = message or name\\n'",
  "    )",
  "with open(os.path.join(pkg, 'utils.py'), 'w') as fh:",
  "    fh.write(",
  "        'def internalcode(f):\\n    return f\\n\\n'",
  "        \"def open_if_exists(filename, mode='rb'):\\n\"",
  "        '    try:\\n        return open(filename, mode)\\n'",
  "        '    except OSError:\\n        return None\\n'",
  "    )",
  "open(os.path.join(pkg, '__init__.py'), 'w').close()",
  "",
  "src_loaders = os.path.join(workspace, 'src', 'jinja2', 'loaders.py')",
  "loaders_present = os.path.isfile(src_loaders)",
  "results['loaders_present'] = loaders_present",
  "syntax_ok = False",
  "conflict_free = True",
  "if loaders_present:",
  "    with open(src_loaders, 'r', encoding='utf-8') as fh:",
  "        src_text = fh.read()",
  "    conflict_free = not ('<<<<<<<' in src_text or '>>>>>>>' in src_text or '\\n=======\\n' in src_text)",
  "    try:",
  "        compile(src_text, 'loaders.py', 'exec')",
  "        syntax_ok = True",
  "    except Exception:",
  "        syntax_ok = False",
  "    shutil.copyfile(src_loaders, os.path.join(pkg, 'loaders.py'))",
  "results['syntax_ok'] = syntax_ok",
  "results['conflict_free'] = conflict_free",
  "if not (loaders_present and syntax_ok):",
  "    for i in range(1, 11):",
  "        results['t%d' % i] = False",
  "    finish()",
  "    sys.exit(0)",
  "",
  "sys.path.insert(0, stub_root)",
  "import jinja2.loaders as L",
  "TemplateNotFound = L.TemplateNotFound",
  "",
  "class _ProbeTimeout(Exception):",
  "    pass",
  "",
  "_HAS_ALARM = hasattr(signal, 'SIGALRM')",
  "",
  "def _alarm(fn, seconds=3):",
  "    if not _HAS_ALARM:",
  "        return fn()",
  "    def handler(signum, frame):",
  "        raise _ProbeTimeout()",
  "    old = signal.signal(signal.SIGALRM, handler)",
  "    signal.alarm(seconds)",
  "    try:",
  "        return fn()",
  "    finally:",
  "        signal.alarm(0)",
  "        signal.signal(signal.SIGALRM, old)",
  "",
  "def case(name):",
  "    def deco(fn):",
  "        try:",
  "            results[name] = bool(_alarm(fn))",
  "        except Exception:",
  "            results[name] = False",
  "        return fn",
  "    return deco",
  "",
  "# —— 模板目录基线：primary / fb1 / fb2 ——",
  "base = tempfile.mkdtemp(prefix='jinja2_tpl_')",
  "primary = os.path.join(base, 'primary')",
  "fb1 = os.path.join(base, 'fb1')",
  "fb2 = os.path.join(base, 'fb2')",
  "for d in (primary, fb1, fb2):",
  "    os.makedirs(d, exist_ok=True)",
  "",
  "def write_tpl(d, name, content):",
  "    with open(os.path.join(d, name), 'w') as fh:",
  "        fh.write(content)",
  "",
  "write_tpl(primary, 't1.html', 'PRIMARY')",
  "write_tpl(primary, 'dup.html', 'PRIMARY_DUP')",
  "write_tpl(fb1, 't2.html', 'FALLBACK1')",
  "write_tpl(fb1, 'dup.html', 'FB1_DUP')",
  "write_tpl(fb1, 'only_fb.html', 'FB1_ONLY')",
  "write_tpl(fb2, 't3.html', 'FALLBACK2')",
  "write_tpl(fb2, 'dup.html', 'FB2_DUP')",
  "write_tpl(fb2, 'only_fb.html', 'FB2_ONLY')",
  "",
  "# T1 fallback_searchpath 基本回退：primary 命中、仅 fallback 存在的模板按序回退命中",
  "@case('t1')",
  "def t1():",
  "    loader = L.FileSystemLoader(primary, fallback_searchpath=[fb1, fb2])",
  "    src1 = loader.get_source(None, 't1.html')[0]",
  "    src2 = loader.get_source(None, 't2.html')[0]",
  "    src3 = loader.get_source(None, 't3.html')[0]",
  "    return 'PRIMARY' in src1 and 'FALLBACK1' in src2 and 'FALLBACK2' in src3",
  "",
  "# T2 优先级：primary 压过 fallback、多 fallback 按声明顺序取第一个",
  "@case('t2')",
  "def t2():",
  "    loader = L.FileSystemLoader(primary, fallback_searchpath=[fb1, fb2])",
  "    dup = loader.get_source(None, 'dup.html')[0]",
  "    only = loader.get_source(None, 'only_fb.html')[0]",
  "    return 'PRIMARY_DUP' in dup and 'FB1_ONLY' in only",
  "",
  "# T3 无 fallback 时向后兼容，主/回退路径都找不到时抛 TemplateNotFound",
  "@case('t3')",
  "def t3():",
  "    loader = L.FileSystemLoader(primary)",
  "    ok_primary = 'PRIMARY' in loader.get_source(None, 't1.html')[0]",
  "    try:",
  "        loader.get_source(None, 't2.html')",
  "        ok_missing = False",
  "    except TemplateNotFound:",
  "        ok_missing = True",
  "    loader_fb = L.FileSystemLoader(primary, fallback_searchpath=[fb1])",
  "    try:",
  "        loader_fb.get_source(None, 'missing.html')",
  "        ok_fb_missing = False",
  "    except TemplateNotFound:",
  "        ok_fb_missing = True",
  "    return ok_primary and ok_missing and ok_fb_missing",
  "",
  "# T4 path_transform 模板别名转换（FileSystemLoader）",
  "@case('t4')",
  "def t4():",
  "    alias_map = {'home': 't1.html'}",
  "    loader = L.FileSystemLoader(primary, path_transform=lambda p: alias_map.get(p, p))",
  "    return 'PRIMARY' in loader.get_source(None, 'home')[0]",
  "",
  "# T5 path_transform 路径归一化在 DictLoader 与 FunctionLoader 上生效",
  "@case('t5')",
  "def t5():",
  "    d = L.DictLoader({'index.html': 'HELLO-DICT'}, path_transform=lambda p: p.lstrip('/'))",
  "    ok_dict = 'HELLO-DICT' in d.get_source(None, '/index.html')[0]",
  "    def load_fn(name):",
  "        return 'HELLO-FN' if name == 'x.html' else None",
  "    fl = L.FunctionLoader(load_fn, path_transform=lambda p: 'x.html' if p == 'x' else p)",
  "    ok_fn = 'HELLO-FN' in fl.get_source(None, 'x')[0]",
  "    return ok_dict and ok_fn",
  "",
  "# T6 aliases 单跳映射：多个别名指向同一模板均可加载且内容一致",
  "@case('t6')",
  "def t6():",
  "    d = L.DictLoader({'t1.html': 'T1-CONTENT'})",
  "    d.add_alias('main.html', 't1.html')",
  "    d.add_alias('index.html', 't1.html')",
  "    return (",
  "        'T1-CONTENT' in d.get_source(None, 'main.html')[0]",
  "        and 'T1-CONTENT' in d.get_source(None, 'index.html')[0]",
  "        and 'T1-CONTENT' in d.get_source(None, 't1.html')[0]",
  "    )",
  "",
  "# T7 别名链（多跳）与循环别名防御：链式解析到末端或按规格单跳报错均认可；循环必须有限时间内报错不挂死",
  "@case('t7')",
  "def t7():",
  "    d = L.DictLoader({'c.html': 'C-CONTENT'})",
  "    d.add_alias('a', 'b')",
  "    d.add_alias('b', 'c.html')",
  "    try:",
  "        chained = 'C-CONTENT' in d.get_source(None, 'a')[0]",
  "    except TemplateNotFound:",
  "        chained = True",
  "    except Exception:",
  "        chained = False",
  "    c = L.DictLoader({'real.html': 'OK'})",
  "    c.add_alias('x', 'y')",
  "    c.add_alias('y', 'x')",
  "    try:",
  "        _alarm(lambda: c.get_source(None, 'x'), seconds=2)",
  "        guarded = False",
  "    except _ProbeTimeout:",
  "        guarded = False",
  "    except Exception:",
  "        guarded = True",
  "    return chained and guarded",
  "",
  "# T8 remove_alias 语义：移除后失效、移除不存在的别名安全、别名指向缺失模板时 TemplateNotFound 引用目标名",
  "@case('t8')",
  "def t8():",
  "    d = L.DictLoader({'t.html': 'T-CONTENT'})",
  "    d.add_alias('m.html', 't.html')",
  "    ok_before = 'T-CONTENT' in d.get_source(None, 'm.html')[0]",
  "    d.remove_alias('m.html')",
  "    try:",
  "        d.get_source(None, 'm.html')",
  "        ok_after = False",
  "    except TemplateNotFound:",
  "        ok_after = True",
  "    ok_remove_ghost = True",
  "    try:",
  "        d.remove_alias('ghost.html')",
  "    except Exception:",
  "        ok_remove_ghost = False",
  "    d.add_alias('broken.html', 'nonexistent.html')",
  "    try:",
  "        d.get_source(None, 'broken.html')",
  "        ok_broken = False",
  "    except TemplateNotFound as e:",
  "        ok_broken = 'nonexistent.html' in (str(e) + ' ' + str(getattr(e, 'name', '')))",
  "    except Exception:",
  "        ok_broken = False",
  "    return ok_before and ok_after and ok_remove_ghost and ok_broken",
  "",
  "# T9 split_template_path 路径遍历（../）安全拦截且正常路径切分不受影响",
  "@case('t9')",
  "def t9():",
  "    try:",
  "        L.split_template_path('../evil.html')",
  "        ok1 = False",
  "    except TemplateNotFound:",
  "        ok1 = True",
  "    try:",
  "        L.split_template_path('a/../../evil.html')",
  "        ok2 = False",
  "    except TemplateNotFound:",
  "        ok2 = True",
  "    try:",
  "        ok3 = L.split_template_path('safe/path.html') == ['safe', 'path.html']",
  "    except Exception:",
  "        ok3 = False",
  "    loader = L.FileSystemLoader(primary)",
  "    try:",
  "        loader.get_source(None, '../secret.txt')",
  "        ok4 = False",
  "    except TemplateNotFound:",
  "        ok4 = True",
  "    return ok1 and ok2 and ok3 and ok4",
  "",
  "# T10 list_templates() 合并主路径与 fallback 并去重排序",
  "@case('t10')",
  "def t10():",
  "    loader = L.FileSystemLoader(primary, fallback_searchpath=[fb1, fb2])",
  "    expected = sorted({'t1.html', 'dup.html', 't2.html', 't3.html', 'only_fb.html'})",
  "    return list(loader.list_templates()) == expected",
  "",
  "finish()",
].join("\n")


// ———— DevBench 隐藏测试探针与判分 ————

// 检查 DESIGN.md（20 分计入 checkpoints30）：模块文件树 5 + classDiagram 5 + sequenceDiagram 5 + 三项扩展约束与 DAG 说明 5
function gradeDevBenchDesignDoc(designText, pkgName, constraintKeywords) {
  const text = String(designText ?? "")
  const pyModuleMentions = (text.match(/\b[\w.-]+\.py\b/g) ?? []).length
  const hasTree = text.includes("src/" + pkgName) && (/[├└]/.test(text) || pyModuleMentions >= 3)
  const hasClassDiagram = /```mermaid[^\n]*\nclassDiagram/.test(text) || /classDiagram/.test(text)
  const hasSequenceDiagram = /```mermaid[^\n]*\nsequenceDiagram/.test(text) || /sequenceDiagram/.test(text)
  const hasConstraints = constraintKeywords.every((kw) => text.includes(kw))
  const hasDag = /DAG|有向无环/.test(text)
  const score = (hasTree ? 5 : 0) + (hasClassDiagram ? 5 : 0) + (hasSequenceDiagram ? 5 : 0) + (hasConstraints && hasDag ? 5 : 0)
  return { hasTree, hasClassDiagram, hasSequenceDiagram, hasConstraints, hasDag, score }
}

// 判分：DevBench 2 道 Python 实现题（100 分 = 60 隐藏测试 + 30 扩展反事实与设计文档 + 10 过程纪律）
export async function gradeDevBenchTask(taskId, workspaceDir) {
  const cfg = {
    "devbench__nested_delimited_projection": { probe: STRUCTFOLD_PROBE, pkgName: "structfold", constraints: ["conflict_policy", "type_coercion", "column_aliases"], extensionTests: [6, 7, 8, 9, 10] },
    "devbench__multiformat_reading_estimator": { probe: READPULSE_PROBE, pkgName: "readpulse", constraints: ["code_wpm", "exclude_blockquotes", "sections"], extensionTests: [7, 8, 9, 10] }
  }
  const conf = cfg[String(taskId)]
  if (!conf) throw new Error(`未知的 DevBench 任务 ID：${taskId}`)
  const designText = await readFile(path.join(workspaceDir, "DESIGN.md"), "utf8").catch(() => "")
  const probe = runPythonProbe(conf.probe, [workspaceDir], { cwd: workspaceDir })

  const perTest = {}
  let passedCount = 0
  for (let i = 1; i <= 10; i++) {
    perTest["t" + i] = Boolean(probe?.["t" + i])
    if (perTest["t" + i]) passedCount += 1
  }
  const deterministic60 = passedCount * 6

  // 扩展反事实特性专项 10 分：三项扩展约束（冲突策略/类型转换/别名链 或 代码速率/引用剥离/章节分解）对应隐藏测试全通过
  const extensionAll = conf.extensionTests.every((i) => perTest["t" + i])
  const design = gradeDevBenchDesignDoc(designText, conf.pkgName, conf.constraints)
  const checkpoints30 = (extensionAll ? 10 : 0) + design.score

  const pyFileCount = Number(probe?.py_file_count ?? 0)
  const modulesSplit = pyFileCount >= 2
  const syntaxOk = Boolean(probe?.syntax_ok)
  const conflictFree = Boolean(probe?.conflict_free)
  const discipline10 = (modulesSplit ? 5 : 0) + (syntaxOk && conflictFree ? 5 : 0)

  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: {
      passedCount,
      perTest,
      extensionAll,
      pyFileCount,
      modulesSplit,
      syntaxOk,
      conflictFree,
      designTree: design.hasTree,
      designClassDiagram: design.hasClassDiagram,
      designSequenceDiagram: design.hasSequenceDiagram,
      designConstraints: design.hasConstraints,
      designDag: design.hasDag
    }
  }
}


// ———— 超难三题判分器（SWE-Lancer 经理级 2 道 + CooperBench 跨模块 1 道） ————
// uh1：Node 子进程真实导入工作区 src/ 执行 15 项时序交错探针（每项 4 分）。
const UH1_PROBE_SCRIPT = String.raw`import { pathToFileURL } from 'node:url';
import path from 'node:path';

const nonce = process.env.TWR_PROBE_NONCE ?? '';
delete process.env.TWR_PROBE_NONCE;
const workspace = process.env.TWR_PROBE_WORKSPACE ?? process.argv[2];
delete process.env.TWR_PROBE_WORKSPACE;
const load = (rel) => import(pathToFileURL(path.join(workspace, rel)).href);
const [vaultMod, policyMod, queueMod, streamMod, actionsMod, uiMod] = await Promise.all([
  load('src/store/MemberVault.js'),
  load('src/policy/PolicyRoleIndex.js'),
  load('src/queue/OfflineMutationQueue.js'),
  load('src/sync/DeltaStream.js'),
  load('src/actions/WorkspaceMemberActions.js'),
  load('src/ui/OfflineWithFeedback.js')
]);
const { MemberVault } = vaultMod;
const { PolicyRoleIndex } = policyMod;
const { OfflineMutationQueue } = queueMod;
const { DeltaStream } = streamMod;
const { createWorkspaceRuntime } = actionsMod;
const { buildMemberListViewModel } = uiMod;

const results = {};
async function probe(name, fn) {
  try { results[name] = Boolean(await fn()); }
  catch (error) { results[name] = false; }
}

function autoTransport({ appliedSeq = 1, respond = null } = {}) {
  const sentBatches = [];
  return {
    sentBatches,
    async send(batch) {
      sentBatches.push(batch.map((mutation) => mutation.id));
      if (typeof respond === 'function') return respond(batch, sentBatches.length);
      return { applied: batch.map((mutation) => mutation.id), appliedSeq };
    }
  };
}

function makeHarness(options = {}) {
  let offline = Boolean(options.isOffline);
  const vault = new MemberVault(options.members ?? []);
  const policyRoleIndex = new PolicyRoleIndex({ roleByMemberId: options.roles ?? {}, delegateByMemberId: options.delegations ?? {} });
  const transport = options.transport ?? { send: async (batch) => ({ applied: batch.map((mutation) => mutation.id), appliedSeq: 1 }) };
  const queue = new OfflineMutationQueue({ transport, batchSize: options.batchSize });
  const runtime = createWorkspaceRuntime({
    vault,
    policyRoleIndex,
    queue,
    isOffline: () => offline,
    stream: new DeltaStream({ vault, policyRoleIndex })
  });
  return {
    vault,
    policyRoleIndex,
    queue,
    runtime,
    stream: runtime.stream,
    setOffline(next) { offline = Boolean(next); },
    view(isOffline) { return buildMemberListViewModel({ members: vault.listMembers(), isOffline }); }
  };
}

const threeMembers = [{ id: 'm1', email: 'a@example.com' }, { id: 'm2', email: 'b@example.com' }, { id: 'm3', email: 'c@example.com' }];

await probe('t1', async () => {
  const h = makeHarness({ members: threeMembers.slice(0, 2), transport: autoTransport({ appliedSeq: 5 }), isOffline: true });
  const report = await h.runtime.deleteMembers(['m1']);
  const member = h.vault.getMember('m1');
  const pending = h.queue.listPending();
  const offlineRow = h.view(true).rows.find((row) => row.id === 'm1');
  const onlineRow = h.view(false).rows.find((row) => row.id === 'm1');
  return report.queued.length === 1
    && member !== null && member.pendingAction === 'delete'
    && h.queue.size === 1 && pending.length === 1 && pending[0].memberIds.includes('m1')
    && offlineRow !== undefined && offlineRow.hidden === false && offlineRow.offlineIndicator === true
    && onlineRow !== undefined && onlineRow.hidden === true && onlineRow.interactive === false;
});

await probe('t2', async () => {
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'owner' },
    delegations: { m2: 'm1' },
    transport: autoTransport({ appliedSeq: 4 })
  });
  const report = await h.runtime.deleteMembers(['m1']);
  return report.queued.length === 1
    && h.vault.hasMember('m1') === false
    && h.queue.size === 0
    && h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.listDelegations().every((entry) => entry.delegateId !== 'm1')
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2'
    && h.view(false).rows.every((row) => row.id !== 'm1');
});

await probe('t3', async () => {
  const transport = {
    async send(batch) {
      return {
        applied: [],
        appliedSeq: null,
        idempotent: batch.map((mutation) => ({ mutationId: mutation.id, code: 'MEMBER_NOT_FOUND', appliedSeq: 9 }))
      };
    }
  };
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'owner' },
    delegations: { m2: 'm1' },
    transport
  });
  await h.runtime.deleteMembers(['m1']);
  return h.vault.hasMember('m1') === false
    && h.queue.size === 0
    && h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2';
});

await probe('t4', async () => {
  const h = makeHarness({ members: threeMembers.slice(0, 2), transport: autoTransport({ appliedSeq: 5 }) });
  await h.runtime.deleteMembers(['m1']);
  h.stream.applyServerSnapshot({ snapshotSeq: 3, members: [{ id: 'm1', email: 'old@example.com' }, { id: 'm2', email: 'b@example.com' }] });
  return h.vault.hasMember('m1') === false
    && h.vault.hasMember('m2') === true
    && h.vault.getMember('m2').email === 'b@example.com';
});

await probe('t5', async () => {
  const h = makeHarness({ members: threeMembers.slice(0, 2), transport: autoTransport({ appliedSeq: 5 }) });
  await h.runtime.deleteMembers(['m1']);
  h.stream.applyServerSnapshot({
    snapshotSeq: 3,
    members: [
      { id: 'm1', email: 'old@example.com' },
      { id: 'm2', email: 'b@example.com', displayName: 'M2-updated' },
      { id: 'm3', email: 'c@example.com' }
    ]
  });
  return h.vault.hasMember('m1') === false
    && h.vault.getMember('m2') !== null && h.vault.getMember('m2').displayName === 'M2-updated'
    && h.vault.getMember('m3') !== null;
});

await probe('t6', async () => {
  const h = makeHarness({ members: threeMembers.slice(0, 2), transport: autoTransport({ appliedSeq: 5 }) });
  await h.runtime.deleteMembers(['m1']);
  h.stream.applyServerSnapshot({ snapshotSeq: 3, members: [{ id: 'm1', email: 'old@example.com' }, { id: 'm2', email: 'b@example.com' }] });
  const notResurrectedByOldSnapshot = h.vault.hasMember('m1') === false;
  h.stream.applyServerSnapshot({ snapshotSeq: 7, members: [{ id: 'm1', email: 'm1@example.com', displayName: 'M1-restored' }, { id: 'm2', email: 'b@example.com', displayName: 'M2-new' }, { id: 'm3', email: 'c@example.com' }] });
  const restored = h.vault.getMember('m1');
  return notResurrectedByOldSnapshot
    && restored !== null && restored.displayName === 'M1-restored'
    && h.vault.getMember('m2').displayName === 'M2-new'
    && h.vault.getMember('m3') !== null
    && h.stream.cursor === 7;
});

await probe('t7', async () => {
  const h = makeHarness({ members: threeMembers.slice(0, 2), transport: autoTransport({ appliedSeq: 6 }), isOffline: true });
  await h.runtime.deleteMembers(['m1']);
  h.setOffline(false);
  const report = await h.runtime.flushPendingMutations();
  h.setOffline(true);
  const flushed = report !== null && Array.isArray(report.succeeded) && report.succeeded.length === 1;
  h.stream.applyServerSnapshot({ snapshotSeq: 4, members: [{ id: 'm1', email: 'old@example.com' }, { id: 'm2', email: 'b@example.com' }] });
  return flushed
    && h.vault.hasMember('m1') === false
    && h.vault.hasMember('m2') === true
    && h.queue.size === 0;
});

await probe('t8', async () => {
  let h = null;
  const transport = {
    calls: 0,
    async send(batch) {
      transport.calls += 1;
      if (transport.calls === 1) {
        h.queue.enqueue({ id: 'assign-inflight-1', kind: 'assignWorkspaceMemberRole', memberIds: ['m2'], payload: { roleId: 'member' }, previousRole: null, createdAt: Date.now() });
        const [first, second] = batch;
        return { applied: [first.id], appliedSeq: 8, failed: [{ mutationId: second.id, code: 'MEMBER_DELETE_FAILED', message: 'server rejected' }] };
      }
      return { applied: batch.map((mutation) => mutation.id), appliedSeq: 9 };
    }
  };
  h = makeHarness({ members: threeMembers, transport, isOffline: true });
  await h.runtime.deleteMembers(['m1']);
  await h.runtime.deleteMembers(['m2']);
  await h.runtime.deleteMembers(['m3']);
  const queuedIds = h.queue.listPending().map((mutation) => mutation.id);
  h.setOffline(false);
  const report = await h.runtime.flushPendingMutations();
  const pending = h.queue.listPending();
  const m2 = h.vault.getMember('m2');
  const m3 = h.vault.getMember('m3');
  return queuedIds.length === 3
    && report !== null && Array.isArray(report.failed) && report.failed.length === 2
    && h.vault.hasMember('m1') === false
    && m2 !== null && m2.pendingAction === null && typeof m2.lastError === 'string' && m2.lastError.length > 0
    && m3 !== null && m3.pendingAction === null && typeof m3.lastError === 'string' && m3.lastError.length > 0
    && pending.length === 3
    && pending[0].id === queuedIds[1] && pending[1].id === queuedIds[2] && pending[2].id === 'assign-inflight-1';
});

await probe('t9', async () => {
  let h = null;
  const transport = {
    calls: 0,
    async send(batch) {
      transport.calls += 1;
      if (transport.calls === 1) {
        h.queue.enqueue({ id: 'assign-inflight-2', kind: 'assignWorkspaceMemberRole', memberIds: ['m1'], payload: { roleId: 'member' }, previousRole: null, createdAt: Date.now() });
        throw new Error('network down');
      }
      return { applied: batch.map((mutation) => mutation.id), appliedSeq: 11 };
    }
  };
  h = makeHarness({ members: threeMembers.slice(0, 2), transport, isOffline: true });
  await h.runtime.deleteMembers(['m1']);
  await h.runtime.deleteMembers(['m2']);
  const queuedIds = h.queue.listPending().map((mutation) => mutation.id);
  h.setOffline(false);
  const failedReport = await h.runtime.flushPendingMutations();
  const pendingAfterFailure = h.queue.listPending().map((mutation) => mutation.id);
  const stillPending = h.vault.getMember('m1').pendingAction === 'delete' && h.vault.getMember('m2').pendingAction === 'delete';
  const retryReport = await h.runtime.flushPendingMutations();
  return queuedIds.length === 2
    && failedReport !== null && failedReport.error !== undefined && failedReport.error !== null
    && pendingAfterFailure.length === 3
    && pendingAfterFailure[0] === queuedIds[0] && pendingAfterFailure[1] === queuedIds[1] && pendingAfterFailure[2] === 'assign-inflight-2'
    && stillPending
    && retryReport !== null && Array.isArray(retryReport.succeeded) && retryReport.succeeded.length === 3
    && h.vault.hasMember('m1') === false && h.vault.hasMember('m2') === false
    && h.queue.size === 0;
});

await probe('t10', async () => {
  let h = null;
  const sentOrders = [];
  const transport = {
    calls: 0,
    async send(batch) {
      transport.calls += 1;
      sentOrders.push(batch.map((mutation) => mutation.id));
      if (transport.calls === 1) {
        h.queue.enqueue({ id: 'assign-inflight-3', kind: 'assignWorkspaceMemberRole', memberIds: ['m1'], payload: { roleId: 'member' }, previousRole: null, createdAt: Date.now() });
        const [first, second] = batch;
        return { applied: [first.id], appliedSeq: 12, failed: [{ mutationId: second.id, code: 'MEMBER_DELETE_FAILED', message: 'server rejected' }] };
      }
      return { applied: batch.map((mutation) => mutation.id), appliedSeq: 13 };
    }
  };
  h = makeHarness({ members: threeMembers, transport, isOffline: true });
  await h.runtime.deleteMembers(['m1']);
  await h.runtime.deleteMembers(['m2']);
  await h.runtime.deleteMembers(['m3']);
  const queuedIds = h.queue.listPending().map((mutation) => mutation.id);
  h.setOffline(false);
  await h.runtime.flushPendingMutations();
  const retryReport = await h.runtime.flushPendingMutations();
  const secondBatch = sentOrders[1] ?? [];
  return queuedIds.length === 3
    && retryReport !== null && retryReport.succeeded.length === 3
    && secondBatch.length === 3
    && secondBatch[0] === queuedIds[1] && secondBatch[1] === queuedIds[2] && secondBatch[2] === 'assign-inflight-3'
    && h.vault.hasMember('m2') === false && h.vault.hasMember('m3') === false
    && h.queue.size === 0;
});

await probe('t11', async () => {
  const h = makeHarness({
    members: threeMembers,
    roles: { m1: 'approver', m2: 'manager', m3: 'admin' },
    delegations: { m2: 'm1', m1: 'm3' },
    transport: autoTransport({ appliedSeq: 3 })
  });
  await h.runtime.deleteMembers(['m1']);
  const delegations = h.policyRoleIndex.listDelegations();
  return h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.getRole('m3') === 'admin'
    && delegations.some((entry) => entry.memberId === 'm2' && entry.delegateId === 'm3')
    && delegations.every((entry) => entry.memberId !== 'm1')
    && h.policyRoleIndex.resolveApproverId('m2') === 'm3';
});

await probe('t12', async () => {
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'manager' },
    delegations: { m2: 'm1' },
    transport: autoTransport({ appliedSeq: 3 })
  });
  await h.runtime.deleteMembers(['m1']);
  return h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.getRole('m2') === 'manager'
    && h.policyRoleIndex.listDelegations().length === 0
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2';
});

await probe('t13', async () => {
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'owner' },
    delegations: { m2: 'm1' }
  });
  h.stream.applyDelta({ seq: 9, events: [{ type: 'member.removed', memberId: 'm1' }] });
  const first = h.vault.hasMember('m1') === false
    && h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2';
  h.stream.applyDelta({ seq: 10, events: [{ type: 'member.removed', memberId: 'm1' }] });
  return first && h.vault.hasMember('m1') === false && h.policyRoleIndex.getRole('m1') === null;
});

await probe('t14', async () => {
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'owner' },
    delegations: { m2: 'm1' },
    transport: autoTransport({ appliedSeq: 2 }),
    isOffline: true
  });
  await h.runtime.deleteMembers(['m1']);
  await h.runtime.deleteMembers(['m1']);
  const queuedOnce = h.queue.size === 1;
  h.setOffline(false);
  const report = await h.runtime.flushPendingMutations();
  return queuedOnce
    && report !== null && report.succeeded.length === 1
    && h.vault.hasMember('m1') === false
    && h.queue.size === 0
    && h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2';
});

await probe('t15', async () => {
  const transport = {
    sentBatches: [],
    async send(batch) {
      this.sentBatches.push(batch.map((mutation) => mutation.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { applied: batch.map((mutation) => mutation.id), appliedSeq: 6 };
    }
  };
  const h = makeHarness({
    members: threeMembers.slice(0, 2),
    roles: { m1: 'approver', m2: 'owner' },
    delegations: { m2: 'm1' },
    transport
  });
  const firstCall = h.runtime.deleteMembers(['m1']);
  const secondCall = h.runtime.deleteMembers(['m1']);
  const [firstReport, secondReport] = await Promise.all([firstCall, secondCall]);
  return firstReport.queued.length === 1
    && secondReport.queued.length <= 1
    && transport.sentBatches.length === 1 && transport.sentBatches[0].length === 1
    && h.vault.hasMember('m1') === false
    && h.queue.size === 0
    && h.policyRoleIndex.getRole('m1') === null
    && h.policyRoleIndex.resolveApproverId('m2') === 'm2';
});

process.stdout.write('__GRADE__' + nonce + JSON.stringify(results) + '\n');`;

// uh3：Python 子进程执行 20 项 MVCC / 租约缓存 / 死锁仲裁 / 跨模块耦合对抗探针（每项 3 分）。
const UH3_PROBE_SCRIPT = String.raw`import json
import os
import sys
import builtins
import queue
import select
import types
import _thread

def _entry():
    nonce = os.environ.pop("TWR_PROBE_NONCE", "")
    real_write = sys.stdout.write
    real_flush = sys.stdout.flush
    real_dumps = json.dumps
    real_exit = os._exit
    real_sys_exit = sys.exit
    start_thread = _thread.start_new_thread
    os_read = os.read
    os_write = os.write
    pipe_fn = os.pipe
    select_fn = select.select
    urandom_fn = os.urandom
    function_type = types.FunctionType
    queue_class = queue.Queue
    queue_put = queue.Queue.put
    queue_get = queue.Queue.get
    str_fn = str
    bool_fn = bool
    len_fn = len
    isinstance_fn = isinstance
    range_fn = range
    clear_dict = dict.clear
    update_dict = dict.update
    dict_fn = dict
    builtins_snapshot_items = tuple(dict(builtins.__dict__).items())

    def restore_builtins():
        clear_dict(builtins.__dict__)
        update_dict(builtins.__dict__, dict_fn(builtins_snapshot_items))

    def forbidden_exit(_code=0):
        raise RuntimeError("PROBE_EXIT_FORBIDDEN")

    os._exit = forbidden_exit
    sys.exit = forbidden_exit

    # 受测模块只在独立工作线程里运行；禁止跨线程取帧与遍历对象图，避免其定位主线程中的完成证明
    def audit_hook(event, info):
        if event in ("sys._current_frames", "gc.get_objects", "gc.get_referrers", "gc.get_referents"):
            raise RuntimeError("PROBE_INTROSPECTION_FORBIDDEN")

    sys.addaudithook(audit_hook)

    def emit(payload):
        real_write("__GRADE__" + nonce + real_dumps(payload) + "\n")
        try:
            real_flush()
        except BaseException:
            pass

    def import_candidate():
        from txengine import (
            DeadlockVictimError,
            LeaseCache,
            MVCCManager,
            StaleReadConflictError,
            TransactionPipeline,
            WaitForGraph,
        )
        return (TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError)

    workspace = sys.argv[1]
    src_root = os.path.join(workspace, "src")
    sys.path.insert(0, src_root)

    results = {}

    pkg_root = os.path.join(src_root, "txengine")
    py_files = []
    conflict_free = True
    for root, dirs, files in os.walk(pkg_root):
        dirs.sort()
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            py_files.append(path)
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    text = handle.read()
            except Exception:
                conflict_free = False
                continue
            if "<<<<<<<" in text or ">>>>>>>" in text or ("\n=======\n" in text):
                conflict_free = False
    syntax_ok = True
    for path in py_files:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                compile(handle.read(), path, "exec")
        except Exception:
            syntax_ok = False
    subpackages_ok = all(
        os.path.isfile(os.path.join(pkg_root, name, "__init__.py"))
        for name in ("tx", "cache", "lock", "coordinator")
    )
    results["syntax_ok"] = syntax_ok
    results["conflict_free"] = conflict_free
    results["subpackages_ok"] = subpackages_ok

    tests = []

    def case(name):
        def deco(fn):
            tests.append((name, fn))
            return fn
        return deco

    @case("t1")
    def t1(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        manager = MVCCManager()
        tx1 = manager.begin_tx()
        manager.write(tx1, "k", "own")
        read_own = manager.read(tx1, "k") == "own"
        tx2 = manager.begin_tx()
        invisible = manager.read(tx2, "k") is None
        commit_ts = manager.commit(tx1)
        old_snapshot_invisible = manager.read(tx2, "k") is None
        fresh = manager.begin_tx()
        visible_after = manager.read(fresh, "k") == "own"
        return read_own and invisible and old_snapshot_invisible and visible_after and commit_ts > manager.snapshot_ts(tx2)

    @case("t2")
    def t2(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        manager = MVCCManager()
        seed = manager.begin_tx()
        manager.write(seed, "k", "v1")
        manager.commit(seed)
        tx1 = manager.begin_tx()
        first = manager.read(tx1, "k") == "v1"
        writer = manager.begin_tx()
        manager.write(writer, "k", "v2")
        manager.commit(writer)
        second = manager.read(tx1, "k") == "v1"
        third = manager.read_version(tx1, "k") == ("v1", manager.latest_commit_ts("k") - 1) or manager.read(tx1, "k") == "v1"
        return first and second and third

    @case("t3")
    def t3(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        manager = MVCCManager()
        seed = manager.begin_tx()
        manager.write(seed, "p:a", 1)
        manager.commit(seed)
        tx1 = manager.begin_tx()
        before = manager.scan(tx1, "p:") == {"p:a": 1}
        writer = manager.begin_tx()
        manager.write(writer, "p:b", 2)
        manager.commit(writer)
        after = manager.scan(tx1, "p:") == {"p:a": 1}
        fresh = manager.begin_tx()
        fresh_keys = sorted(manager.scan(fresh, "p:").keys()) == ["p:a", "p:b"]
        return before and after and fresh_keys

    @case("t4")
    def t4(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        manager = MVCCManager()
        tx1 = manager.begin_tx()
        tx2 = manager.begin_tx()
        manager.write(tx2, "k", "v2")
        visible_to_writer = manager.read(tx2, "k") == "v2"
        commit_ts = manager.commit(tx2)
        invisible_to_old = manager.read(tx1, "k") is None
        fresh = manager.begin_tx()
        visible_to_fresh = manager.read(fresh, "k") == "v2"
        return (
            invisible_to_old
            and visible_to_writer
            and visible_to_fresh
            and commit_ts > manager.snapshot_ts(tx1)
            and manager.latest_commit_ts("k") == commit_ts
        )

    @case("t5")
    def t5(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        manager = MVCCManager()
        tx1 = manager.begin_tx()
        writer = manager.begin_tx()
        manager.write(writer, "b", "vb")
        manager.write(writer, "a", "va")
        manager.commit(writer)
        manager.write(tx1, "b", "x")
        manager.write(tx1, "a", "y")
        observed = None
        try:
            manager.commit(tx1)
        except StaleReadConflictError as error:
            observed = error
        if observed is None:
            return False
        return (
            observed.key == "a"
            and observed.snapshot_ts == manager.snapshot_ts(tx1)
            and observed.observed_ts == manager.latest_commit_ts("a")
            and manager.transaction_state(tx1) == "active"
            and sorted(manager.pending_keys(tx1)) == ["a", "b"]
        )

    @case("t6")
    def t6(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        cache = LeaseCache()
        payload = ("value", 3)
        miss = cache.get_or_lease("k", 1) == (None, 0)
        filled = cache.fill_if_valid("k", 0, payload) is True
        hit = cache.get_or_lease("k", 2) == (payload, 0)
        consumed = cache.invalidate_leases_for_tx(1) == 0
        still_hit = cache.get_or_lease("k", 3) == (payload, 0)
        return miss and filled and hit and consumed and still_hit

    @case("t7")
    def t7(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        cache = LeaseCache()
        cache.fill_if_valid("k", 0, ("old", 1))
        epoch = cache.invalidate_on_write_or_abort("k") == 1
        miss = cache.get_or_lease("k", 1) == (None, 1)
        rejected = cache.fill_if_valid("k", 0, ("stale", 1)) is False
        accepted = cache.fill_if_valid("k", 1, ("new", 2)) is True
        return epoch and miss and rejected and accepted and cache.get_or_lease("k", 2) == (("new", 2), 1)

    @case("t8")
    def t8(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        cache = LeaseCache()
        miss, epoch = cache.get_or_lease("k", 7)
        registered = miss is None and epoch == 0
        count = cache.invalidate_leases_for_tx(7) == 1
        stale_fill = cache.fill_if_valid("k", 0, ("stale", 1)) is False
        current = cache.get_or_lease("k", 8) == (None, 1)
        return registered and count and stale_fill and current

    @case("t9")
    def t9(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        cache = LeaseCache()
        payload, epoch = cache.get_or_lease("k", 1)
        first = payload is None and epoch == 0
        cache.invalidate_on_write_or_abort("k")
        cache.invalidate_on_write_or_abort("k")
        rejected = cache.fill_if_valid("k", 0, ("old", 1)) is False
        accepted = cache.fill_if_valid("k", 2, ("fresh", 4)) is True
        return first and rejected and accepted and cache.get_or_lease("k", 2) == (("fresh", 4), 2)

    @case("t10")
    def t10(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        cache = LeaseCache()
        payload, epoch = cache.get_or_lease("k", 1)
        filled = cache.fill_if_valid("k", epoch, ("v", 2)) is True
        consumed = cache.invalidate_leases_for_tx(1) == 0
        duplicate = cache.fill_if_valid("k", epoch, ("w", 3)) is False
        other, other_epoch = cache.get_or_lease("j", 2)
        other_filled = cache.fill_if_valid("j", other_epoch, ("jv", 4)) is True
        other_consumed = cache.invalidate_leases_for_tx(2) == 0
        return payload is None and filled and consumed and duplicate and other is None and other_filled and other_consumed

    @case("t11")
    def t11(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        aborted = []
        graph = WaitForGraph(abort_tx=lambda tx_id: aborted.append(tx_id))
        first = graph.acquire_lock(1, "k1") is True
        second = graph.acquire_lock(2, "k2") is True
        waiting = graph.acquire_lock(1, "k2") is False
        caught = None
        try:
            graph.acquire_lock(2, "k1")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        return (
            first and second and waiting
            and caught.tx_id == 2
            and tuple(caught.cycle) == (1, 2)
            and aborted == [2]
            and graph.held_locks(2) == ()
            and graph.owner("k2") is None
            and graph.waiting_on(2) is None
            and graph.acquire_lock(1, "k2") is True
        )

    @case("t12")
    def t12(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        aborted = []
        graph = WaitForGraph(abort_tx=lambda tx_id: aborted.append(tx_id))
        graph.acquire_lock(1, "k1")
        graph.acquire_lock(2, "k2")
        graph.acquire_lock(3, "k3")
        waits_a = graph.acquire_lock(1, "k2") is False
        waits_b = graph.acquire_lock(2, "k3") is False
        caught = None
        try:
            graph.acquire_lock(3, "k1")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        return (
            waits_a and waits_b
            and caught.tx_id == 3
            and tuple(caught.cycle) == (1, 2, 3)
            and aborted == [3]
            and graph.held_locks(3) == ()
            and graph.waiting_on(2) is None
            and graph.acquire_lock(2, "k3") is True
            and graph.release_lock(2, "k2") is True
            and graph.acquire_lock(1, "k2") is True
        )

    @case("t13")
    def t13(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        aborted = []
        graph = WaitForGraph(abort_tx=lambda tx_id: aborted.append(tx_id))
        graph.acquire_lock(1, "x")
        graph.acquire_lock(2, "y")
        graph.acquire_lock(3, "z")
        graph.acquire_lock(3, "y")
        graph.acquire_lock(2, "x")
        caught = None
        try:
            graph.acquire_lock(1, "z")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        return (
            caught.tx_id == 3
            and tuple(caught.cycle) == (1, 3, 2)
            and aborted == [3]
            and graph.held_locks(3) == ()
            and graph.owner("z") is None
            and graph.acquire_lock(1, "z") is True
            and graph.release_lock(1, "x") is True
            and graph.acquire_lock(2, "x") is True
        )

    @case("t14")
    def t14(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        graph = WaitForGraph()
        holds = graph.acquire_lock(1, "k") is True
        waits = graph.acquire_lock(2, "k") is False
        waiting = graph.waiting_on(2) == ("k", 1)
        released = graph.release_lock(1, "k") is True
        cleared = graph.waiting_on(2) is None
        retried = graph.acquire_lock(2, "k") is True
        released_all = graph.release_all(2) == ("k",)
        return holds and waits and waiting and released and cleared and retried and released_all and graph.held_locks(2) == ()

    @case("t15")
    def t15(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        aborted = []
        graph = WaitForGraph(abort_tx=lambda tx_id: aborted.append(tx_id))
        graph.acquire_lock(1, "k1")
        graph.acquire_lock(2, "k2")
        graph.acquire_lock(3, "k3")
        graph.acquire_lock(1, "k2")
        graph.acquire_lock(2, "k3")
        caught = None
        try:
            graph.acquire_lock(3, "k1")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        return (
            tuple(caught.cycle) == (1, 2, 3)
            and aborted == [3]
            and graph.held_locks(3) == ()
            and graph.waiting_on(3) is None
            and graph.owner("k1") == 1
            and graph.owner("k2") == 2
            and graph.owner("k3") is None
            and graph.waiting_on(1) == ("k2", 2)
            and graph.waiting_on(2) is None
            and graph.release_lock(1, "k2") is False
            and graph.release_lock(1, "k1") is True
        )

    @case("t16")
    def t16(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        pipeline = TransactionPipeline()
        first = pipeline.begin()
        second = pipeline.begin()
        wrote_first = pipeline.write(first, "k1", "a1") is True
        wrote_second = pipeline.write(second, "k2", "b1") is True
        wait = pipeline.write(first, "k2", "a2") is False
        caught = None
        try:
            pipeline.write(second, "k1", "b2")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        victim_clean = (
            caught.tx_id == second
            and pipeline.mvcc.transaction_state(second) == "aborted"
            and pipeline.mvcc.pending_keys(second) == ()
            and pipeline.locks.held_locks(second) == ()
            and pipeline.locks.waiting_on(second) is None
            and pipeline.locks.owner("k2") is None
        )
        retried = pipeline.write(first, "k2", "a2") is True
        own_read = pipeline.mvcc.read(first, "k2") == "a2"
        commit_ts = pipeline.commit(first)
        fresh = pipeline.begin()
        return (
            wrote_first and wrote_second and wait and victim_clean and retried and own_read
            and commit_ts > 0
            and pipeline.read(fresh, "k1") == "a1"
            and pipeline.read(fresh, "k2") == "a2"
        )

    @case("t17")
    def t17(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        pipeline = TransactionPipeline()
        first = pipeline.begin()
        second = pipeline.begin()
        pipeline.write(first, "k1", "a1")
        pipeline.write(second, "k2", "b2")
        pipeline.write(second, "k4", "b4")
        pipeline.write(first, "k2", "a2")
        caught = None
        try:
            pipeline.write(second, "k1", "b1")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        return (
            caught.tx_id == second
            and pipeline.locks.owner("k2") is None
            and pipeline.locks.owner("k4") is None
            and pipeline.locks.held_locks(second) == ()
            and pipeline.locks.waiting_on(first) is None
            and pipeline.write(first, "k2", "a2") is True
            and pipeline.write(first, "k4", "a4") is True
            and pipeline.commit(first) > 0
        )

    @case("t18")
    def t18(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        pipeline = TransactionPipeline()
        first = pipeline.begin()
        second = pipeline.begin()
        payload, epoch = pipeline.cache.get_or_lease("ghost", second)
        registered = payload is None and epoch == 0
        pipeline.write(first, "k1", "a1")
        pipeline.write(second, "k2", "b2")
        pipeline.write(first, "k2", "a2")
        caught = None
        try:
            pipeline.write(second, "k1", "b1")
        except DeadlockVictimError as error:
            caught = error
        if caught is None:
            return False
        stale_fill = pipeline.cache.fill_if_valid("ghost", 0, ("stale", 1)) is False
        current = pipeline.cache.get_or_lease("ghost", first) == (None, 1)
        return registered and stale_fill and current and caught.tx_id == second

    @case("t19")
    def t19(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        pipeline = TransactionPipeline()
        first = pipeline.begin()
        writer = pipeline.begin()
        pipeline.write(writer, "k", "v2")
        pipeline.commit(writer)
        pipeline.write(first, "k", "v1")
        caught = None
        try:
            pipeline.commit(first)
        except StaleReadConflictError as error:
            caught = error
        if caught is None:
            return False
        cleaned = (
            pipeline.mvcc.transaction_state(first) == "aborted"
            and pipeline.mvcc.pending_keys(first) == ()
            and pipeline.locks.held_locks(first) == ()
            and pipeline.locks.waiting_on(first) is None
        )
        fresh = pipeline.begin()
        observed = pipeline.read(fresh, "k") == "v2"
        again = pipeline.begin()
        cached = pipeline.read(again, "k") == "v2"
        pipeline.abort(first)

        # 失败路径 A：只读事务写入必须先抛 RuntimeError，不得抢占或破坏他人持有的锁
        holder = pipeline.begin()
        pipeline.write(holder, "lock-key", "held")
        read_only = pipeline.begin(read_only=True)
        read_only_rejected = False
        try:
            pipeline.write(read_only, "lock-key", "x")
        except RuntimeError:
            read_only_rejected = True
        no_steal = (
            read_only_rejected
            and pipeline.locks.owner("lock-key") == holder
            and pipeline.locks.held_locks(read_only) == ()
            and pipeline.mvcc.pending_keys(read_only) == ()
        )

        # 失败路径 B：写 None 抛 ValueError，但既有未提交写与已持有的锁必须原样保留
        keeper = pipeline.begin()
        pipeline.write(keeper, "j", "v1")
        none_rejected = False
        try:
            pipeline.write(keeper, "j", None)
        except ValueError:
            none_rejected = True
        kept = (
            none_rejected
            and pipeline.locks.owner("j") == keeper
            and "j" in pipeline.mvcc.pending_keys(keeper)
            and pipeline.mvcc.read(keeper, "j") == "v1"
        )
        reupdated = pipeline.write(keeper, "j", "v2") is True
        keeper_commit = pipeline.commit(keeper)
        fresh_after = pipeline.begin()
        return (
            caught.key == "k" and cleaned and observed and cached
            and pipeline.mvcc.transaction_state(first) == "aborted"
            and no_steal and kept and reupdated and keeper_commit > 0
            and pipeline.read(fresh_after, "j") == "v2"
        )

    @case("t20")
    def t20(ctx):
        TransactionPipeline, MVCCManager, LeaseCache, WaitForGraph, DeadlockVictimError, StaleReadConflictError = ctx
        pipeline = TransactionPipeline()
        keys = ["a", "b", "c", "d"]
        committed = {}
        txs = {}
        active = []

        def snapshot_value(tx_id, key):
            best = None
            best_ts = -1
            for candidate, (value, commit_ts) in committed.items():
                if candidate == key and commit_ts <= txs[tx_id]["snapshot"] and commit_ts > best_ts:
                    best = value
                    best_ts = commit_ts
            return best

        def begin():
            tx_id = pipeline.begin()
            txs[tx_id] = {"snapshot": pipeline.mvcc.snapshot_ts(tx_id), "writes": {}}
            active.append(tx_id)
            return tx_id

        def write(tx_id, key, value):
            try:
                accepted = pipeline.write(tx_id, key, value)
            except DeadlockVictimError as error:
                victim = error.tx_id
                txs[victim]["writes"].clear()
                if victim in active:
                    active.remove(victim)
                if pipeline.mvcc.transaction_state(victim) != "aborted":
                    return False
                if pipeline.locks.held_locks(victim) != () or pipeline.locks.waiting_on(victim) is not None:
                    return False
                return True
            if accepted:
                txs[tx_id]["writes"][key] = value
                if pipeline.read(tx_id, key) != value:
                    return False
            elif key in txs[tx_id]["writes"]:
                return False
            return True

        def read(tx_id, key):
            observed = pipeline.read(tx_id, key)
            own = txs[tx_id]["writes"].get(key)
            expected = own if own is not None else snapshot_value(tx_id, key)
            return observed == expected

        def commit(tx_id):
            try:
                commit_ts = pipeline.commit(tx_id)
            except StaleReadConflictError:
                txs[tx_id]["writes"].clear()
                if tx_id in active:
                    active.remove(tx_id)
                if pipeline.mvcc.transaction_state(tx_id) != "aborted":
                    return False
                if pipeline.locks.held_locks(tx_id) != () or pipeline.locks.waiting_on(tx_id) is not None:
                    return False
                return True
            for key, value in txs[tx_id]["writes"].items():
                committed[key] = (value, commit_ts)
            txs[tx_id]["writes"].clear()
            if tx_id in active:
                active.remove(tx_id)
            if pipeline.locks.held_locks(tx_id) != () or pipeline.locks.waiting_on(tx_id) is not None:
                return False
            return True

        def abort(tx_id):
            pipeline.abort(tx_id)
            txs[tx_id]["writes"].clear()
            if tx_id in active:
                active.remove(tx_id)
            return pipeline.locks.held_locks(tx_id) == () and pipeline.locks.waiting_on(tx_id) is None

        def check_cache():
            for key in keys:
                latest = None
                best_ts = -1
                for candidate, (value, commit_ts) in committed.items():
                    if candidate == key and commit_ts > best_ts:
                        latest = value
                        best_ts = commit_ts
                probe = begin()
                observed = pipeline.read(probe, key)
                pipeline.abort(probe)
                txs[probe]["writes"].clear()
                if probe in active:
                    active.remove(probe)
                if observed != latest:
                    return False
            return True

        first = begin()
        second = begin()
        if not read(first, "a"):
            return False
        if not write(second, "a", "vB1"):
            return False
        if not commit(second):
            return False
        if not read(first, "a"):
            return False
        if not write(first, "a", "vA1"):
            return False
        if not commit(first):
            return False
        if not check_cache():
            return False

        seed = 20261102

        def rnd(limit):
            nonlocal seed
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            return seed % limit

        for step in range(41):
            choice = rnd(10)
            if choice < 2 or not active:
                begin()
                continue
            tx_id = active[rnd(len(active))]
            if choice < 6:
                if not write(tx_id, keys[rnd(len(keys))], "v%d-%d" % (step, tx_id)):
                    return False
            elif choice < 8:
                if not read(tx_id, keys[rnd(len(keys))]):
                    return False
            elif choice < 9:
                if not commit(tx_id):
                    return False
            else:
                if not abort(tx_id):
                    return False
            if not check_cache():
                return False
        for tx_id in list(active):
            if not abort(tx_id):
                return False
        return check_cache()

    test_names = tuple(name for name, _fn in tests)
    test_codes = tuple(test_fn.__code__ for _name, test_fn in tests)

    token_queue = queue_class()
    result_read_fd, result_write_fd = pipe_fn()
    read_buffer = [b""]

    # 受测包导入与全部探针在同一个工作线程中顺序执行：满足 SPEC 的单线程同步调用前提，
    # 同时把 nonce/发射器/真实退出通道留在主线程，受测代码无法沿线程栈或对象图取得它们。
    def worker():
        try:
            candidate = import_candidate()
        except BaseException:
            try:
                os_write(result_write_fd, b"import-error\n")
            except BaseException:
                pass
            return
        try:
            for index in range_fn(1, 21):
                token = queue_get(token_queue)
                value = False
                try:
                    restore_builtins()
                    test_fn = function_type(test_codes[index - 1], {"__builtins__": builtins.__dict__})
                    value = bool_fn(test_fn(candidate))
                except BaseException:
                    value = False
                restore_builtins()
                os_write(result_write_fd, (str_fn(token) + ":" + str_fn(index) + ":" + ("1" if value else "0") + "\n").encode("ascii"))
            done_token = queue_get(token_queue)
            os_write(result_write_fd, (str_fn(done_token) + ":done:1\n").encode("ascii"))
        except BaseException:
            try:
                os_write(result_write_fd, b"worker-error\n")
            except BaseException:
                pass

    def read_record(timeout_seconds):
        while True:
            if b"\n" in read_buffer[0]:
                line, read_buffer[0] = read_buffer[0].split(b"\n", 1)
                if line:
                    return line.decode("ascii", "replace")
                continue
            ready = select_fn([result_read_fd], [], [], timeout_seconds)
            if not ready:
                return None
            chunk = os_read(result_read_fd, 4096)
            if not chunk:
                return None
            read_buffer[0] += chunk

    start_thread(worker, ())

    tampered = False
    for index in range_fn(1, 21):
        token = urandom_fn(8).hex()
        queue_put(token_queue, token)
        record = read_record(20)
        if record is None:
            tampered = True
            break
        parts = record.split(":")
        if len_fn(parts) != 3 or parts[0] != token or parts[1] != str_fn(index) or parts[2] not in ("0", "1"):
            tampered = True
            break
        results[test_names[index - 1]] = parts[2] == "1"
    if not tampered:
        done_token = urandom_fn(8).hex()
        queue_put(token_queue, done_token)
        record = read_record(20)
        if record is None:
            tampered = True
        else:
            parts = record.split(":")
            if len_fn(parts) != 3 or parts[0] != done_token or parts[1] != "done" or parts[2] != "1":
                tampered = True
    if tampered:
        for index in range_fn(1, 21):
            results[test_names[index - 1]] = False

    results["probe_complete"] = True
    emit(results)
    real_exit(0)

_entry()
`;

// uh1 只读题面与 uh2 只读 7 文件
const UH1_KEY_MODULES = ["WorkspaceMemberActions", "OfflineMutationQueue", "DeltaStream", "MemberVault", "PolicyRoleIndex", "OfflineWithFeedback"]
const UH2_READONLY_FILES = [
  "src/contextmenu/ReportContextMenu.js",
  "src/events/SecondaryClickDispatcher.js",
  "src/fab/FloatingActionTrigger.js",
  "src/focus/FocusTrapStack.js",
  "src/hover/HoverQuickBar.js",
  "src/modal/BaseModal.js",
  "src/popover/PopoverRoot.js"
]

// uh2 routing_matrix 黄金真值：六种事件场景 × 4 个布尔属性。
// 真值来自夹具 src/ 的真实事件路由、浮层登记与焦点栈行为（已用等价 DOM 桩逐场景实测校准），
// 不是凭直觉填写：切换菜单不归还焦点、悬停浮层被点击浮层压制、外部点击只收起浮层岛且按最外层归还一次焦点。
const UH2_ROUTING_GOLDEN = {
  rightClickAnotherMessage: { closeExisting: true, openNewCustom: true, allowNativeMenu: false, restoreFocus: false },
  rightClickPlainArea: { closeExisting: true, openNewCustom: false, allowNativeMenu: true, restoreFocus: true },
  clickFabWhileOpen: { closeExisting: true, openNewCustom: false, allowNativeMenu: false, restoreFocus: true },
  hoverActionWhileMenuOpen: { closeExisting: false, openNewCustom: false, allowNativeMenu: false, restoreFocus: false },
  pressEscapeWithNestedMenu: { closeExisting: true, openNewCustom: false, allowNativeMenu: false, restoreFocus: true },
  outsideLeftClick: { closeExisting: true, openNewCustom: false, allowNativeMenu: false, restoreFocus: true }
}

// uh2 四条跨文件隐式契约的源码事实校验：每条契约必须在同一份发现里给出对应源码事实。
// 1) 触发按钮排除必须同时覆盖 anchorRef 与 targetRef；2) hover 与点击态浮层互斥；
// 3) SecondaryClickDispatcher 的 hitTest/elementsFromPoint 命中判定与原生菜单分流；4) 焦点栈 LIFO 归归还。
const UH2_CONTRACT_CHECKS = [
  (text) => text.includes("anchorRef")
    && text.includes("targetRef")
    && /(排除|isTriggerExcluded|exclusion|exclusions)/i.test(text),
  (text) => /(hover|悬停|HoverQuickBar)/i.test(text)
    && /(click-popover|点击态|点击浮层|按压|interactiveMode)/i.test(text)
    && /(互斥|压制|不出现|收回|优先|suppress|同时)/i.test(text),
  (text) => /(hitTest|elementsFromPoint|命中判定|元素栈|命中测试)/i.test(text)
    && /(原生菜单|allowNativeMenu|preventDefault|contextmenu|右键菜单)/i.test(text)
    && /(分流|路由|命中|放行|阻止|抑制)/i.test(text),
  (text) => /(FocusTrapStack|焦点栈|焦点陷阱|focus\s*trap)/i.test(text)
    && /(LIFO|后进先出|栈顶|自顶向下|逆序)/i.test(text)
    && /(releaseFocusTraps|释放|归还|restore)/i.test(text)
]

// uh1 七份错误方案的源码证伪事实特征（每条需命中至少两条）
const UH1_REJECTION_FACTS = {
  1: [/(会话|session|内存|页面|刷新|重载)/i, /(视图|UI|渲染|隐藏)/i, /(同步层|数据层|队列|角色索引|DeltaStream|MemberVault|PolicyRoleIndex)/i],
  2: [/(快照|rollbackMembers|恢复|restore)/i, /(pendingAction|待删|待删除|视图隐藏)/i, /(角色|PolicyRoleIndex|转交|snapshotSeq|旧快照|DeltaStream)/i],
  3: [/(pendingAction|定时|3\s*秒|setTimeout)/i, /(离线|offline|isOffline)/i, /(隐藏|视图|快照|队列|角色|转交)/i],
  4: [/(整体|全部|整份|游标|cursor)/i, /(快照|snapshot)/i, /(其他成员|其余成员|更新|丢失|成员数据|逐条)/i],
  5: [/(successData|幂等|MEMBER_NOT_FOUND)/i, /(快照|snapshotSeq|队列|DeltaStream|OfflineMutationQueue)/i],
  7: [/(清空|重建|服务器|全量)/i, /(待决|未同步|离线|丢失|本地操作|队列)/i],
  8: [/(deletedMemberIds|集合|Set|持久)/i, /(快照|snapshot)/i, /(其他成员|更新|逐条|成员数据|逐行)/i]
}

// uh2 七份错误方案的源码证伪事实特征
const UH2_REJECTION_FACTS = {
  1: [/(非主键|button|主键)/i, /(stopPropagation|冒泡|捕获|capture)/i, /(pointerdown|事件顺序|事件路由|contextmenu)/i],
  2: [/(pointer-events|pointerEvents|穿透)/i, /(菜单打开期间|遮罩)/i, /(无法点击|关闭|恢复|键盘|Esc|焦点)/i],
  3: [/(setTimeout|延迟|事件循环|下一帧)/i, /(遮罩|pointerdown|捕获)/i, /(仍然关闭|不能阻止|时序|无效|菜单项)/i],
  4: [/(模块级|全局标志|模块状态|单标志|模块变量)/i, /(多菜单|嵌套|多个|共享|状态)/i, /(不关闭|无法|失效|残留|误)/i],
  6: [/(渲染|render|内容树|绝对定位)/i, /(浮层|PopoverRoot|层级|z-index|登记)/i, /(命中|关闭|焦点|遮罩)/i],
  7: [/(preventDefault|原生菜单|contextmenu)/i, /(mousedown|relatedTarget|pointerdown|click)/i, /(菜单|遮罩|失效|破坏|误)/i],
  8: [/(inert|pointerup|延迟|下一帧)/i, /(遮罩|pointerdown|关闭)/i, /(焦点|菜单|未|无法|破坏)/i]
}

// 在临时 ESM 沙箱中运行 Node 探针：工作区 src/ 无 package.json 时 .js 会被判为 CommonJS，
// 因此复制 src/ 到临时目录并写入 {"type":"module"}，不修改被测工作区。随机 nonce 防止伪造 __GRADE__ 行。
async function runNodeEsmProbe(script, workspaceDir, { timeoutMs = 60000 } = {}) {
  let sandboxDir = null
  try {
    sandboxDir = await mkdtemp(path.join(os.tmpdir(), "twr-uh-probe-"))
    await cp(path.join(workspaceDir, "src"), path.join(sandboxDir, "src"), { recursive: true })
    await writeFile(path.join(sandboxDir, "package.json"), '{"type":"module"}\n', "utf8")
    const nonce = randomBytes(16).toString("hex")
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sandboxDir,
      env: { PATH: process.env.PATH ?? "", ELECTRON_RUN_AS_NODE: "1", TWR_PROBE_NONCE: nonce, TWR_PROBE_WORKSPACE: sandboxDir },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      encoding: "utf8"
    })
    for (const line of out.trim().split("\n").reverse()) {
      if (!line.startsWith("__GRADE__")) continue
      const payload = line.slice("__GRADE__".length)
      if (!payload.startsWith(nonce)) return null
      return JSON.parse(payload.slice(nonce.length))
    }
    return null
  } catch {
    return null
  } finally {
    if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readJsonOrNull(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")) } catch { return null }
}

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

function asStringList(value) {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))) : []
}

function patternHits(patterns, text) {
  const source = String(text ?? "")
  return patterns.filter((pattern) => pattern.test(source)).length
}

// 只读纪律：夹具 src/ 下指定文件逐文件 SHA-256 一致（缺失或改动均判不一致）
async function verifyFixtureFilesUntouched(fixtureDir, workspaceDir, relativeFiles) {
  for (const relativeFile of relativeFiles) {
    const [baseBuf, currentBuf] = await Promise.all([
      readFile(path.join(fixtureDir, relativeFile)).catch(() => null),
      readFile(path.join(workspaceDir, relativeFile)).catch(() => null)
    ])
    if (!baseBuf || !currentBuf || sha256Buffer(baseBuf) !== sha256Buffer(currentBuf)) return false
  }
  return true
}

function gradeUh1Design(designText, selectedId) {
  const text = String(designText ?? "")
  const modulesMentioned = UH1_KEY_MODULES.filter((name) => text.includes(name)).length
  const hasFlow = /(调用链|时序|状态转移|状态机|流程)/.test(text)
  const traceScore = modulesMentioned >= 4 && hasFlow ? 3 : modulesMentioned >= 3 ? 2 : 0
  const expectedRejected = [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => id !== selectedId)
  const mentionedProposals = new Set((text.match(/Proposal\s*([1-8])/gi) ?? []).map((token) => Number(token.replace(/[^0-9]/g, ""))))
  const mentionedCount = expectedRejected.filter((id) => mentionedProposals.has(id)).length
  const falsifyScore = expectedRejected.every((id) => mentionedProposals.has(id)) ? 2 : mentionedCount >= 6 ? 1 : 0
  const designFacts = [/(snapshotSeq)/i, /(lastMutationSeq|变更序号|墓碑|tombstone)/i, /(successData|幂等)/i, /(finalize|统一收口|统一处理)/i]
  const factCount = patternHits(designFacts, text)
  const targetScore = factCount >= 3 && hasFlow ? 3 : factCount >= 2 ? 1 : 0
  const selfTestScore = /(node\s|node\.js|node\b|断言|assert|验证脚本|verify)/i.test(text) && /(snapshotSeq|快照|队列|幂等)/i.test(text) ? 2 : 0
  return { modulesMentioned, traceScore, falsifyScore, targetScore, selfTestScore, score: traceScore + falsifyScore + targetScore + selfTestScore }
}

function gradeUh3Design(designText) {
  const text = String(designText ?? "")
  const layered = ["tx", "cache", "lock", "coordinator"].every((name) => new RegExp(name).test(text)) && /(分层|职责|依赖)/.test(text)
  const lease = patternHits([/(snapshot_ts|快照时间戳|快照版本)/i, /(epoch|世代)/i, /(fill_if_valid|回填|租约)/i], text) >= 3
  const deadlock = patternHits([/(等待图|wait-for|环路|cycle)/i, /(牺牲者|victim|最年轻|最大)/i], text) >= 2
    && patternHits([/(commit|提交)/i, /(abort|中止)/i, /(回滚|释放|失效|收敛)/i], text) >= 3
  return { layered, lease, deadlock, score: (layered ? 5 : 0) + (lease ? 5 : 0) + (deadlock ? 5 : 0) }
}

// 判分：uh1 离线乐观删除复活题（100 分 = 15 项 Node 时序探针 × 4 + 方案选择/证伪/设计 30 + 纪律 10）
async function gradeUltraHardUh1(workspaceDir) {
  const fixtureDir = path.join(HERE, "fixtures/uh1_swelancer__offline_optimistic_reappear")
  const [decision, designText, baseIssue, currentIssue, probe] = await Promise.all([
    readJsonOrNull(path.join(workspaceDir, "DECISION.json")),
    readFile(path.join(workspaceDir, "DESIGN.md"), "utf8").catch(() => ""),
    readFile(path.join(fixtureDir, "ISSUE_AND_PROPOSALS.md"), "utf8").catch(() => ""),
    readFile(path.join(workspaceDir, "ISSUE_AND_PROPOSALS.md"), "utf8").catch(() => ""),
    runNodeEsmProbe(UH1_PROBE_SCRIPT, workspaceDir)
  ])

  const perProbe = {}
  let passedCount = 0
  for (let index = 1; index <= 15; index += 1) {
    const key = "t" + index
    perProbe[key] = Boolean(probe?.[key])
    if (perProbe[key]) passedCount += 1
  }
  const deterministic60 = passedCount * 4

  const decisionObject = asPlainObject(decision)
  const selectedId = decisionObject ? decisionObject.selected_proposal_id : undefined
  const decisionUnambiguous = Number.isInteger(selectedId)
  const rootCauseFiles = asStringList(decisionObject?.root_cause_files)
  const rootCauseFunctions = asStringList(decisionObject?.root_cause_functions)
  const rejected = asPlainObject(decisionObject?.rejected_proposals) ?? {}

  const filesHit = UH1_KEY_MODULES.filter((name) => rootCauseFiles.some((entry) => entry.includes(name))).length
  const functionsHit = [/(deleteMembers)/i, /(settleBatch)/i, /(applyServerSnapshot)/i, /(recordMutationSeq|lastMutationSeqOf)/i, /(finalizeMemberRemoval|removeMember)/i]
    .filter((pattern) => rootCauseFunctions.some((entry) => pattern.test(entry))).length
  const rootCauseScore = (filesHit >= 3 ? 2 : 0) + (functionsHit >= 2 ? 2 : 0)

  const expectedRejectedIds = [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => id !== selectedId)
  let substantiveRejections = 0
  for (const id of expectedRejectedIds) {
    const value = rejected[String(id)]
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
    if (String(text ?? "").replace(/\s+/g, "").length < 30) continue
    if (patternHits(UH1_REJECTION_FACTS[id] ?? [], text) >= 2) substantiveRejections += 1
  }
  const falsifyScore = substantiveRejections >= 7 ? 6 : substantiveRejections >= 5 ? 4 : substantiveRejections >= 3 ? 2 : 0

  const choiceScore = selectedId === 6 ? 10 : [1, 2, 3, 4, 5, 8].includes(selectedId) ? 4 : 0
  const design = gradeUh1Design(designText, selectedId)
  const checkpoints30 = choiceScore + rootCauseScore + falsifyScore + design.score

  const issueUntouched = baseIssue.length > 0 && sha256(baseIssue) === sha256(currentIssue)
  const discipline10 = (issueUntouched ? 5 : 0) + (decisionUnambiguous ? 5 : 0)

  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: {
      passedCount,
      perProbe,
      selectedId,
      decisionUnambiguous,
      issueUntouched,
      filesHit,
      functionsHit,
      rootCauseScore,
      substantiveRejections,
      falsifyScore,
      choiceScore,
      design: { modulesMentioned: design.modulesMentioned, traceScore: design.traceScore, falsifyScore: design.falsifyScore, targetScore: design.targetScore, selfTestScore: design.selfTestScore }
    }
  }
}

// 判分：uh2 非全屏模态框事件路由架构选优题（100 分 = 路由矩阵 36 + 方案选择 24 + 隐式契约与证伪 30 + src 只读 10）
async function gradeUltraHardUh2(workspaceDir) {
  const fixtureDir = path.join(HERE, "fixtures/uh2_swelancer__popover_backdrop_event_routing")
  const [decision, designText, srcUntouched] = await Promise.all([
    readJsonOrNull(path.join(workspaceDir, "DECISION.json")),
    readFile(path.join(workspaceDir, "DESIGN.md"), "utf8").catch(() => ""),
    verifyFixtureFilesUntouched(fixtureDir, workspaceDir, UH2_READONLY_FILES)
  ])
  const discipline10 = srcUntouched ? 10 : 0

  const decisionObject = asPlainObject(decision)
  const selectedId = decisionObject ? decisionObject.selected_proposal_id : undefined
  const routingMatrix = asPlainObject(decisionObject?.routing_matrix)
  let matrixHits = 0
  let matrixCells = 0
  for (const [scenario, golden] of Object.entries(UH2_ROUTING_GOLDEN)) {
    const row = asPlainObject(routingMatrix?.[scenario])
    for (const field of ["closeExisting", "openNewCustom", "allowNativeMenu", "restoreFocus"]) {
      matrixCells += 1
      if (row !== null && row[field] === golden[field]) matrixHits += 1
    }
  }
  const matrixScore = Math.round(matrixHits * 1.5)
  const choiceScore = selectedId === 5 ? 24 : [1, 2, 3, 4, 6, 8].includes(selectedId) ? 8 : 0
  const deterministic60 = matrixScore + choiceScore

  const contracts = asStringList(decisionObject?.discovered_implicit_contracts)
  let contractHits = 0
  for (const accepts of UH2_CONTRACT_CHECKS) {
    if (contracts.some((entry) => {
      const text = String(entry ?? "")
      return text.replace(/\s+/g, "").length >= 20 && accepts(text)
    })) contractHits += 1
  }
  const contractsScore = contractHits * 4


  const rejected = asPlainObject(decisionObject?.rejected_proposals) ?? {}
  const expectedRejectedIds = [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => id !== selectedId)
  let substantiveRejections = 0
  for (const id of expectedRejectedIds) {
    const value = rejected[String(id)]
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
    if (String(text ?? "").replace(/\s+/g, "").length < 30) continue
    if (patternHits(UH2_REJECTION_FACTS[id] ?? [], text) >= 2) substantiveRejections += 1
  }
  const falsifyScore = substantiveRejections >= 7 ? 14 : substantiveRejections >= 5 ? 10 : substantiveRejections >= 3 ? 6 : 0

  const rootCauseFiles = asStringList(decisionObject?.root_cause_files)
  const modulesHit = UH2_READONLY_FILES.filter((relativeFile) => {
    const basename = path.basename(relativeFile)
    return rootCauseFiles.some((entry) => String(entry).includes(basename))
  }).length

  // 满分门槛：题面要求 DESIGN.md 与 DECISION.json 同时交付；设计文档缺失或为空时不计 checkpoints30
  const designDelivered = String(designText ?? "").replace(/\s+/g, "").length >= 120
  // checkpoints30 = 4 条跨文件隐式契约（各 4 分）+ 7 个未选提案证伪（封顶 14 分）；仅在必要设计交付在场时计分
  const checkpoints30 = designDelivered ? contractsScore + falsifyScore : 0
  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: {
      selectedId,
      srcUntouched,
      matrixHits,
      matrixCells,
      matrixScore,
      choiceScore,
      contractHits,
      contractsScore,
      substantiveRejections,
      falsifyScore,
      modulesHit,
      designDelivered
    }
  }
}

// 判分：uh3 事务/租约缓存/死锁仲裁流水线题（100 分 = 20 项 Python 对抗探针 × 3 + 耦合加分/DESIGN 30 + 纪律 10）
async function gradeUltraHardUh3(workspaceDir) {
  const designText = await readFile(path.join(workspaceDir, "DESIGN.md"), "utf8").catch(() => "")
  const probe = await runSealedPythonProbe(UH3_PROBE_SCRIPT, [workspaceDir], { cwd: workspaceDir, timeoutMs: 60000 })

  const perTest = {}
  let passedCount = 0
  for (let index = 1; index <= 20; index += 1) {
    const key = "t" + index
    perTest[key] = Boolean(probe?.[key])
    if (perTest[key]) passedCount += 1
  }
  const deterministic60 = passedCount * 3

  const couplingAll = [16, 17, 18, 19, 20].every((index) => perTest["t" + index])
  const couplingScore = couplingAll ? 15 : 0
  const design = gradeUh3Design(designText)
  const checkpoints30 = couplingScore + design.score

  const syntaxOk = Boolean(probe?.syntax_ok)
  const conflictFree = Boolean(probe?.conflict_free)
  const subpackagesOk = Boolean(probe?.subpackages_ok)
  const discipline10 = (syntaxOk && conflictFree ? 5 : 0) + (subpackagesOk ? 5 : 0)

  return {
    totalScore: deterministic60 + checkpoints30 + discipline10,
    deterministic60,
    checkpoints30,
    discipline10,
    details: { passedCount, perTest, couplingAll, couplingScore, syntaxOk, conflictFree, subpackagesOk, design: { layered: design.layered, lease: design.lease, deadlock: design.deadlock } }
  }
}

// 超难题统一入口：按任务 ID 路由到三道题的判分器
export async function gradeUltraHardTask(taskId, workspaceDir) {
  const absoluteWorkspaceDir = path.resolve(workspaceDir)
  if (taskId === "uh1_swelancer__offline_optimistic_reappear") return gradeUltraHardUh1(absoluteWorkspaceDir)
  if (taskId === "uh2_swelancer__popover_backdrop_event_routing") return gradeUltraHardUh2(absoluteWorkspaceDir)
  if (taskId === "uh3_cooperbench__three_way_tx_cache_pipeline") return gradeUltraHardUh3(absoluteWorkspaceDir)
  throw new Error("未知的超难题 ID：" + taskId)
}
