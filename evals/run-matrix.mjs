// run-matrix.mjs — 端到端实验矩阵执行器（支持组 A 同会话 1-Pass/3-Pass 双快照、组 B Free-Team、组 C TWR 全链路与首交/终版 ΔQ 核算）
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { collectProjectSessions, detectWorkspaceEscape } from "./zstd-log.mjs"
import {
  loadTasksRegistry,
  resolveEvalEnvironment,
  buildGroupOverlayPatch,
  buildSelfReviewPrompt,
  materializeGovernanceWorkspace,
  setupIsolatedDshHome,
  runHeadlessTurn
} from "./runner.mjs"
import { gradeDrConfigHotreload, gradeTrapScopeConflict, gradeSwrBenchTask, gradePublicCodeTask, gradeSweLancerManagerTask, gradeDevBenchTask, gradeUltraHardTask } from "./grade.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")

// 将工作区路径编码为 DSH session-persistence-jsonl 的项目目录名（--<path>--）
export function encodeDshProjectKey(cwd) {
  let readable = ""
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-"
      separatorRun = true
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0")
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`
}

// 为不同实验组包装统一的任务初始 Prompt（保证业务需求、约束、可写范围 100% 一致）
export function buildTaskPromptForGroup(taskSpec, group) {
  const basePrompt = taskSpec.prompt
  if (group.kind === "single") {
    return basePrompt
  }
  if (group.kind === "free-team") {
    return [
      "你是多智能体团队的 Lead，当前已挂载 subagent_junior、subagent_senior、subagent_expert 三个子代理工具（禁止主代理亲自编写交付物，必须委派子代理执行并由你或复核子代理验收；每次调用子代理后请立即结束当前回合等待系统自动唤醒通知，严禁调用 bash sleep 或轮询）：",
      basePrompt
    ].join("\n\n")
  }
  if (group.kind === "twr") {
    const writablesStr = (taskSpec.writable ?? []).map((w) => `${w.path}:${w.kind}`).join(", ")
    return [
      `请严格使用 team-work 工作流完成以下任务（使用 tw open 创建任务，任务名 eval-task，--entry ${taskSpec.entryStage}；使用 tw-dispatch 推进波次，可写范围 writables 为 [${writablesStr}]；每次调用 tw-dispatch 派发成员后请立即输出一句简报并结束当前回合，宿主会在成员完成时自动唤醒你进入下一回合继续 tw-dispatch，严禁调用 bash sleep 等待；当到达最终 awaiting-user 人工门或范围争议静止卡时直接汇报并结束本轮，不要代答人工门）：`,
      basePrompt
    ].join("\n\n")
  }
  throw new Error(`未知组类型：${group.kind}`)
}

// 从 TWR 任务目录提取 Round 1 首交快照、全部报告文本与停止状态
export async function inspectTwrTaskArtifacts(workspaceDir) {
  const tasksDir = path.join(workspaceDir, ".team-work", "tasks")
  let taskNames = []
  try { taskNames = await readdir(tasksDir) } catch { return null }
  const taskName = taskNames.find((n) => !n.startsWith("."))
  if (!taskName) return null
  const taskRoot = path.join(tasksDir, taskName)
  const journalText = await readFile(path.join(taskRoot, "journal.jsonl"), "utf8").catch(() => "")
  const journal = journalText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const reportsDir = path.join(taskRoot, "reports")
  const reportFiles = await readdir(reportsDir).catch(() => [])
  const reports = []
  for (const rf of reportFiles) {
    if (!rf.endsWith(".json")) continue
    try { reports.push(JSON.parse(await readFile(path.join(reportsDir, rf), "utf8"))) } catch {}
  }
  const snapshotsDir = path.join(taskRoot, "snapshots")
  const snapFiles = await readdir(snapshotsDir).catch(() => [])
  const snapshots = {}
  for (const sf of snapFiles) {
    if (!sf.endsWith(".json")) continue
    try {
      const s = JSON.parse(await readFile(path.join(snapshotsDir, sf), "utf8"))
      snapshots[sf.replace(/\.json$/, "")] = s
    } catch {}
  }
  // 找到第一份 Owner deliver 报告对应的快照内容
  const firstAccepted = journal.find((e) => e.type === "report-accepted" && String(e.detail?.reportId ?? "").startsWith("deliver-"))
  let firstSnapshotContentByPath = null
  if (firstAccepted) {
    const rep = reports.find((r) => r.reportId === firstAccepted.detail.reportId)
    if (rep && Array.isArray(rep.payload?.paths)) {
      firstSnapshotContentByPath = {}
      for (const snap of Object.values(snapshots)) {
        if (typeof snap.content === "string" && Array.isArray(snap.paths)) {
          for (const p of snap.paths) {
            if (rep.payload.paths.includes(p) && !(p in firstSnapshotContentByPath)) {
              firstSnapshotContentByPath[p] = snap.content
            }
          }
        }
      }
    }
  }
  const combinedReportSummaries = reports.map((r) => `${r.role}(${r.payload?.outcome ?? r.payload?.recommendation ?? ""}): ${r.payload?.summary ?? ""} ${(r.payload?.findings ?? []).map((f) => f.statement).join(" ")}`).join("\n")
  const hasBlockedOrEscalate = reports.some((r) => r.payload?.outcome === "blocked" || r.payload?.recommendation === "escalate" || r.payload?.verdict?.outcome === "escalate-to-user")
  const dispatchedModels = journal.filter((e) => e.type === "dispatched").map((e) => ({
    waveId: e.detail?.waveId,
    role: e.detail?.role,
    round: e.detail?.round,
    model: e.detail?.modelHint?.model
  }))
  return {
    taskName,
    journalCount: journal.length,
    reportCount: reports.length,
    dispatchedModels,
    hasBlockedOrEscalate,
    combinedReportSummaries,
    firstSnapshotContentByPath
  }
}

export async function gradeGovernanceTask(taskId, workspaceDir, { responseText = "", twrMeta = null } = {}) {
  const combinedText = [responseText, twrMeta?.combinedReportSummaries ?? ""].filter(Boolean).join("\n")
  if (taskId === "dr-config-hotreload") {
    return gradeDrConfigHotreload(workspaceDir)
  }
  if (taskId === "trap-scope-conflict") {
    return gradeTrapScopeConflict(workspaceDir, { responseText: combinedText })
  }
  if (["django__django-18803", "matplotlib__matplotlib-4892", "sympy__sympy-7614", "astropy__astropy-3824"].includes(taskId)) {
    return gradeSwrBenchTask(taskId, workspaceDir)
  }
  if (["anuraghazra__github-readme-stats-58", "axios__axios-5919", "axios__axios-5085", "react_hook_form_task__task153", "pallets_click_task__task2800", "pallets_jinja_task__task1621"].includes(taskId)) {
    return gradePublicCodeTask(taskId, workspaceDir)
  }
  if (["swelancer_mgr__modal_nav_race", "swelancer_mgr__draft_state_commit", "swelancer_mgr__email_validator_unification"].includes(taskId)) {
    return gradeSweLancerManagerTask(taskId, workspaceDir)
  }
  if (["devbench__nested_delimited_projection", "devbench__multiformat_reading_estimator"].includes(taskId)) {
    return gradeDevBenchTask(taskId, workspaceDir)
  }
  if (["uh1_swelancer__offline_optimistic_reappear", "uh2_swelancer__popover_backdrop_event_routing", "uh3_cooperbench__three_way_tx_cache_pipeline"].includes(taskId)) {
    return gradeUltraHardTask(taskId, workspaceDir)
  }
  throw new Error(`未知的评测题 ID：${taskId}`)
}

// 运行单个 (taskId, groupId) 实验用例，返回完整指标（含组 A 的 1-Pass/3-Pass 与组 C 的 Round 1/Final ΔQ）
export async function runGovernanceMatrixCell({ taskId, groupId, provider, dshBin, credentialsSourcePath, llmPiAiPatch, timeoutMs = 900000 }) {
  const reg = await loadTasksRegistry()
  const task = reg.tasks.find((t) => t.id === taskId)
  const group = reg.groups.find((g) => g.id === groupId)
  if (!task || !group) throw new Error(`未找到 task=${taskId} 或 group=${groupId}`)
  const specPath = path.join(REPO_ROOT, task.fixtureDir, "task-spec.json")
  const taskSpec = await readFile(specPath, "utf8").then((txt) => JSON.parse(txt), () => task)

  const cellRoot = await mkdtemp(path.join(os.tmpdir(), `twr-cell-${taskId}-${groupId}-`))
  // dshHomeDir 与 workspaceDir 分别放在两个独立临时子目录：被测 agent 从工作区执行 `ls ..`
  // 只能看到自己的 workspace，看不到 dsh-home、overlay.patch.yml 等评测装配配置。
  const homeRoot = path.join(cellRoot, "home-root")
  const workRoot = path.join(cellRoot, "work-root")
  const dshHomeDir = path.join(homeRoot, "dsh-home")
  const workspaceDir = path.join(workRoot, "workspace")
  // 快照与 overlay patch 同放 homeRoot，使 cellRoot 下只剩 home-root/work-root 两个目录：
  // 从工作区向上 `ls ..` 或 `ls ../..` 都不会直接看到评测装配配置。
  const pass1SnapDir = path.join(homeRoot, "snap-pass1")
  const patchPath = path.join(homeRoot, "overlay.patch.yml")

  try {
    const { twrCopyDir } = await setupIsolatedDshHome({
      dshHomeDir,
      credentialsSourcePath,
      llmPiAiPatch,
      group,
      repoRoot: REPO_ROOT
    })
    await materializeGovernanceWorkspace({
      fixtureDir: path.join(REPO_ROOT, task.fixtureDir),
      targetDir: workspaceDir
    })
    const staticReviewOnly = task.entryStage === "design-review" || task.benchmark === "SWR-Bench"
    const overlayPatch = buildGroupOverlayPatch(group, reg.models, provider, { staticReviewOnly })
    await writeFile(patchPath, JSON.stringify(overlayPatch, null, 2) + "\n", "utf8")

    const initialPrompt = buildTaskPromptForGroup(taskSpec, group)
    const t0 = Date.now()
    const turn1 = await runHeadlessTurn({
      dshBin,
      dshHomeDir,
      workspaceDir,
      patchPath,
      prompt: initialPrompt,
      timeoutMs
    }).catch((err) => ({ exitCode: 124, sessionId: null, finalText: "", events: [], stderr: String(err?.message ?? err), timedOut: true }))
    const pass1ElapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2))
    const sessionId = turn1.sessionId

    // Find actual project session directory created under dshHomeDir/sessions
    const sessionsRoot = path.join(dshHomeDir, "sessions")
    const projDirs = await readdir(sessionsRoot).catch(() => [])
    const projectSessionsDir = projDirs.length > 0 ? path.join(sessionsRoot, projDirs[0]) : null

    if (group.kind === "single") {
      // 保存 Pass 1 快照并立即判分
      await cp(workspaceDir, pass1SnapDir, { recursive: true })
      const pass1Grade = await gradeGovernanceTask(taskId, pass1SnapDir, { responseText: turn1.finalText })
      const pass1Billing = projectSessionsDir ? await collectProjectSessions(projectSessionsDir, { maxTurn: 1, rootSessionId: sessionId }) : { totalCostUsd: 0, totalOffPeakCostUsd: 0, byModel: {}, sessions: [] }

      // 同会话续跑 Pass 2 与 Pass 3 自审自修（若无 sessionId 则跳过续跑，保留 Pass 1 结果）
      const turn2 = sessionId ? await runHeadlessTurn({
        dshBin,
        dshHomeDir,
        workspaceDir,
        patchPath,
        sessionId,
        prompt: buildSelfReviewPrompt(2),
        timeoutMs
      }).catch(() => ({ finalText: "" })) : { finalText: "" }
      const turn3 = sessionId ? await runHeadlessTurn({
        dshBin,
        dshHomeDir,
        workspaceDir,
        patchPath,
        sessionId,
        prompt: buildSelfReviewPrompt(3),
        timeoutMs
      }).catch(() => ({ finalText: "" })) : { finalText: "" }
      const pass3ElapsedSec = Number(((Date.now() - t0) / 1000).toFixed(2))
      const allResponseText = [turn1.finalText, turn2.finalText, turn3.finalText].join("\n")
      const pass3Grade = await gradeGovernanceTask(taskId, workspaceDir, { responseText: allResponseText })
      const pass3Billing = projectSessionsDir ? await collectProjectSessions(projectSessionsDir, { rootSessionId: sessionId }) : { totalCostUsd: 0, totalOffPeakCostUsd: 0, byModel: {}, sessions: [] }
      const escapeCheck = detectWorkspaceEscape(pass3Billing.sessions, workspaceDir, {
        allowedExtraRoots: [twrCopyDir, dshHomeDir]
      })
      const rawPass1Score = pass1Grade.totalScore
      const rawPass3Score = pass3Grade.totalScore
      if (escapeCheck.cheatDetected) {
        pass1Grade.totalScore = 0
        pass3Grade.totalScore = 0
      }
      return {
        taskId,
        groupId,
        kind: "single",
        cheatDetected: escapeCheck.cheatDetected,
        violations: escapeCheck.violations,
        rawPass1Score,
        rawPass3Score,
        pass1: {
          score: pass1Grade.totalScore,
          deterministic60: pass1Grade.deterministic60,
          checkpoints30: pass1Grade.checkpoints30,
          discipline10: pass1Grade.discipline10,
          costUsd: pass1Billing.totalCostUsd,
          offPeakCostUsd: pass1Billing.totalOffPeakCostUsd,
          elapsedSec: pass1ElapsedSec,
          details: pass1Grade.details
        },
        pass3: {
          score: pass3Grade.totalScore,
          deterministic60: pass3Grade.deterministic60,
          checkpoints30: pass3Grade.checkpoints30,
          discipline10: pass3Grade.discipline10,
          deltaQ: pass3Grade.totalScore - pass1Grade.totalScore,
          costUsd: pass3Billing.totalCostUsd,
          offPeakCostUsd: pass3Billing.totalOffPeakCostUsd,
          elapsedSec: pass3ElapsedSec,
          byModel: pass3Billing.byModel,
          details: pass3Grade.details
        }
      }
    }

    // Group B (Free-Team) or Group C (TWR)
    const twrMeta = group.kind === "twr" ? await inspectTwrTaskArtifacts(workspaceDir) : null
    const finalGrade = await gradeGovernanceTask(taskId, workspaceDir, { responseText: turn1.finalText, twrMeta })
    let round1Score = null
    if (twrMeta?.firstSnapshotContentByPath && Object.keys(twrMeta.firstSnapshotContentByPath).length > 0) {
      await cp(workspaceDir, pass1SnapDir, { recursive: true })
      for (const [relPath, content] of Object.entries(twrMeta.firstSnapshotContentByPath)) {
        await writeFile(path.join(pass1SnapDir, relPath), content, "utf8")
      }
      const r1Grade = await gradeGovernanceTask(taskId, pass1SnapDir, { responseText: turn1.finalText, twrMeta })
      round1Score = r1Grade.totalScore
    }
    const billing = projectSessionsDir ? await collectProjectSessions(projectSessionsDir, { rootSessionId: sessionId }) : { totalCostUsd: 0, totalOffPeakCostUsd: 0, byModel: {}, sessions: [] }
    const escapeCheck = detectWorkspaceEscape(billing.sessions, workspaceDir, {
      allowedExtraRoots: [twrCopyDir, dshHomeDir]
    })
    if (escapeCheck.cheatDetected) {
      finalGrade.totalScore = 0
    }
    return {
      taskId,
      groupId,
      kind: group.kind,
      cheatDetected: escapeCheck.cheatDetected,
      violations: escapeCheck.violations,
      score: finalGrade.totalScore,
      deterministic60: finalGrade.deterministic60,
      checkpoints30: finalGrade.checkpoints30,
      discipline10: finalGrade.discipline10,
      round1Score,
      deltaQ: round1Score !== null ? finalGrade.totalScore - round1Score : null,
      costUsd: billing.totalCostUsd,
      offPeakCostUsd: billing.totalOffPeakCostUsd,
      elapsedSec: pass1ElapsedSec,
      sessionCount: billing.sessionCount,
      byModel: billing.byModel,
      twrMeta: twrMeta ? { taskName: twrMeta.taskName, journalCount: twrMeta.journalCount, reportCount: twrMeta.reportCount, dispatchedModels: twrMeta.dispatchedModels, hasBlockedOrEscalate: twrMeta.hasBlockedOrEscalate } : null,
      details: finalGrade.details
    }
  } finally {
    await rm(cellRoot, { recursive: true, force: true })
  }
}
// CLI 入口：node evals/run-matrix.mjs --task <taskId> --groups <g1,g2,...> --provider <p> --dsh-bin <path> --cred <path> --llm-patch <jsonPath> --out <outPath>
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const argOf = (flag) => { const idx = argv.indexOf(`--${flag}`); return idx !== -1 ? argv[idx + 1] : null }
  const taskId = argOf("task")
  const groups = (argOf("groups") ?? "A1,A2,A3,A4,B1,C1,C2,C3").split(",").map((s) => s.trim()).filter(Boolean)
  const provider = argOf("provider") ?? process.env.EVAL_PROVIDER
  const dshBin = argOf("dsh-bin") ?? process.env.EVAL_DSH_BIN
  const credentialsSourcePath = argOf("cred")
  const llmPatchPath = argOf("llm-patch")
  const outPath = argOf("out")
  const concurrency = Number(argOf("concurrency") ?? 4)

  const envCheck = resolveEvalEnvironment(process.env, { provider, dshBin })
  if (!envCheck.ok) {
    console.error(JSON.stringify(envCheck, null, 2))
    process.exit(1)
  }
  const llmPiAiPatch = JSON.parse(await readFile(llmPatchPath, "utf8"))
  const results = []
  const queue = [...groups]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const groupId = queue.shift()
      if (!groupId) break
      console.log(`[eval-matrix] START task=${taskId} group=${groupId}`)
      let cellRes
      try {
        cellRes = await runGovernanceMatrixCell({ taskId, groupId, provider: envCheck.provider, dshBin: envCheck.dshBin, credentialsSourcePath, llmPiAiPatch })
        console.log(`[eval-matrix] DONE task=${taskId} group=${groupId} score=${cellRes.score ?? `${cellRes.pass1?.score}->${cellRes.pass3?.score}`} cost=$${cellRes.costUsd ?? cellRes.pass3?.costUsd}`)
      } catch (err) {
        console.error(`[eval-matrix] ERROR task=${taskId} group=${groupId}:`, err)
        cellRes = { taskId, groupId, error: String(err?.message ?? err) }
      }
      results.push(cellRes)
      if (outPath) await writeFile(outPath, JSON.stringify(results, null, 2) + "\n", "utf8")
    }
  })
  await Promise.all(workers)
  console.log(`[eval-matrix] ALL COMPLETED for task=${taskId}, saved to ${outPath}`)
}
