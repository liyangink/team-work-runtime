// runner.mjs — 评测环境装配、8 组实验对照 Patch/Policy 生成器、防作弊工作树物化与无头进程驱动器
// 遵守仓库脱敏规则：不硬编码环境私有 provider 名或本地用户路径；缺失时显式标记 unresolved 并返回修复指引。
import { spawn, execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")

// 安全边界守卫：任何物理清理目录必须位于系统临时目录（/tmp、/private/tmp 或 os.tmpdir()）下至少一级子目录，严禁触碰仓库或用户主目录
export function assertSafeScratchDir(targetPath, label = "scratchDir") {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error(`${label} 必须是非空路径字符串`)
  }
  const resolved = path.resolve(targetPath)
  const tmpRoots = [...new Set([os.tmpdir(), "/tmp", "/private/tmp"].map((p) => path.resolve(p)))]
  const underTmp = tmpRoots.some((root) => resolved.startsWith(root + path.sep) && resolved.slice(root.length + 1).length >= 4)
  if (!underTmp || resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep) || resolved === path.resolve(os.homedir())) {
    const err = new Error(`安全拒绝：${label} (${resolved}) 不在受控临时目录内，拒绝执行破坏性清理`)
    err.code = "UNSAFE_SCRATCH_PATH"
    throw err
  }
  return resolved
}

export async function loadTasksRegistry(registryPath = path.join(HERE, "tasks.json")) {
  return JSON.parse(await readFile(registryPath, "utf8"))
}

export function resolveEvalEnvironment(env = process.env, overrides = {}) {
  const provider = overrides.provider ?? env.EVAL_PROVIDER ?? null
  const dshBin = overrides.dshBin ?? env.EVAL_DSH_BIN ?? null
  const sourceDshHome = overrides.sourceDshHome ?? env.EVAL_SOURCE_DSH_HOME ?? null
  const unresolved = []
  if (!provider || typeof provider !== "string" || !provider.trim()) {
    unresolved.push({ field: "provider", fix: "通过 --provider <id> 或环境变量 EVAL_PROVIDER 指定宿主已配置的 LLM provider 标识" })
  }
  if (!dshBin || typeof dshBin !== "string" || !dshBin.trim()) {
    unresolved.push({ field: "dshBin", fix: "通过 --dsh-bin <path> 或环境变量 EVAL_DSH_BIN 指定 >=0.2.0 的 dsh CLI 可执行文件路径" })
  }
  return {
    ok: unresolved.length === 0,
    status: unresolved.length === 0 ? "resolved" : "unresolved",
    provider: provider?.trim() || "unresolved",
    dshBin: dshBin?.trim() || "unresolved",
    sourceDshHome: sourceDshHome?.trim() || null,
    unresolved
  }
}

function subagentAsyncDescription(tierLabel, modelId) {
  return `Delegate a self-contained task to a ${tierLabel} (${modelId}) subagent. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes — do not busy-poll with list_agents or sleep; end your turn or do independent work while waiting. The child reports results with send_message; use send_message to continue its conversation.`
}

export function buildBaseProfilePatch({ llmPiAiPatch }) {
  if (!llmPiAiPatch || llmPiAiPatch.id !== "llm-pi-ai") {
    throw new Error("buildBaseProfilePatch 需要有效的 llm-pi-ai 配置项")
  }
  return [
    { id: "credentials", disabled: false },
    llmPiAiPatch,
    { id: "session-title-llm", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    { id: "tool-web", disabled: true },
    // workspace-write 以会话 cwd（评测工作区）为写入边界，阻止子会话越界修改工作区外文件；
    // dsh 自身进程写 DSH_HOME 会话日志不受工具沙箱约束。
    { id: "sandbox-policy", config: { mode: "workspace-write" } },
    { id: "approval", config: { policy: "never" } },
    // 禁用 goal 工具、/goal 命令与自动续轮驱动：基准评测必须在一轮或显式续跑内收敛，
    // 禁止 agent 借助 goal 机制无限自动续轮绕过评测轮次与计费边界。
    { id: "tool-goal", disabled: true },
    { id: "goal-round-driver", disabled: true },
    { id: "command-goal", disabled: true }
  ]
}

export function buildGroupOverlayPatch(group, models, provider, { staticReviewOnly = false } = {}) {
  if (!provider || provider === "unresolved") {
    const err = new Error("provider unresolved：请提供有效的 provider 标识后再生成实验组 patch")
    err.code = "EVAL_PROVIDER_UNRESOLVED"
    throw err
  }
  const j = models.junior
  const s = models.senior
  const e = models.expert
  if (group.kind === "single") {
    const m = models[group.tier]
    if (!m) throw new Error(`未知模型档位：${group.tier}`)
    return [
      {
        id: "agent-default-model",
        config: { provider, model: m.model, reasoningEffort: m.effort }
      },
      { id: "team-work-dsh", disabled: true },
      { id: "tool-subagent", disabled: true },
      { id: "tool-subagent-fork", disabled: true },
      { id: "tool-subagent-control", disabled: true },
      { id: "tool-subagent-list-agents", disabled: true },
      { id: "tool-workflow", disabled: true },
      { id: "workflow-ptc", disabled: true },
      { id: "tool-skill", disabled: true },
      { id: "skill-filesystem", disabled: true },
      ...(staticReviewOnly ? [{ id: "tool-bash", disabled: true }, { id: "tool-jobs", disabled: true }] : [])
    ]
  }
  if (group.kind === "free-team") {
    const lead = models[group.leadTier]
    return [
      {
        id: "agent-default-model",
        config: { provider, model: lead.model, reasoningEffort: lead.effort }
      },
      { id: "subagent", config: { maxDepth: 2 } },
      { id: "team-work-dsh", disabled: true },
      { id: "tool-subagent", disabled: true },
      { id: "tool-subagent-fork", disabled: true },
      { id: "tool-workflow", disabled: true },
      { id: "workflow-ptc", disabled: true },
      { id: "skill-filesystem", disabled: true },
      ...(staticReviewOnly ? [{ id: "tool-bash", disabled: true }, { id: "tool-jobs", disabled: true }] : []),
      {
        insert: [
          {
            id: "tool-subagent-junior",
            name: "@deepseek-ai/dsh-tool-subagent",
            config: {
              provider: "spawn",
              toolName: "subagent_junior",
              description: subagentAsyncDescription("Junior", j.model),
              agentOptions: { provider, model: j.model, reasoningEffort: j.effort }
            }
          },
          {
            id: "tool-subagent-senior",
            name: "@deepseek-ai/dsh-tool-subagent",
            config: {
              provider: "spawn",
              toolName: "subagent_senior",
              description: subagentAsyncDescription("Senior", s.model),
              agentOptions: { provider, model: s.model, reasoningEffort: s.effort }
            }
          },
          {
            id: "tool-subagent-expert",
            name: "@deepseek-ai/dsh-tool-subagent",
            config: {
              provider: "spawn",
              toolName: "subagent_expert",
              description: subagentAsyncDescription("Expert", e.model),
              agentOptions: { provider, model: e.model, reasoningEffort: e.effort }
            }
          }
        ]
      }
    ]
  }
  if (group.kind === "twr") {
    const lead = models[group.leadTier]
    return [
      {
        id: "agent-default-model",
        config: { provider, model: lead.model, reasoningEffort: lead.effort }
      },
      { id: "subagent", config: { maxDepth: 2 } },
      {
        id: "tool-subagent",
        config: {
          provider: "spawn",
          toolName: "subagent",
          agentOptions: { provider, model: j.model, reasoningEffort: j.effort }
        }
      },
      { id: "tool-subagent-fork", disabled: true },
      { id: "tool-workflow", disabled: true },
      { id: "workflow-ptc", disabled: true },
      {
        id: "team-work-dsh",
        config: {
          tiers: {
            junior: [{ provider, model: j.model, effort: j.effort }],
            senior: [{ provider, model: s.model, effort: s.effort }],
            expert: [{ provider, model: e.model, effort: e.effort }]
          }
        }
      }
    ]
  }
  throw new Error(`未知的实验组类型：${String(group.kind)}`)
}

export function buildGroupPolicy(basePolicy, group) {
  const next = structuredClone(basePolicy)
  if (group.kind !== "twr") return next
  next.riskTiers = { critical: group.ownerTier ?? "junior", high: group.ownerTier ?? "junior" }
  for (const [sceneId, scene] of Object.entries(next.scenes ?? {})) {
    scene.ownerTier = group.ownerTier ?? "junior"
    scene.challengerTier = group.challengerTier ?? "senior"
    if (group.core === false) {
      scene.core = false
    } else if (group.core === true && ["implementation", "test", "code-review", "design", "design-review", "spec", "spec-review", "e2e"].includes(sceneId)) {
      scene.core = true
    }
  }
  return next
}

export function buildSelfReviewPrompt(passNumber) {
  return `请进行第 ${passNumber} 轮自审自修：全面复核你上一轮的交付物或代码修改，检查是否遗漏任何需求约束、边界条件或引入了回归缺陷；若发现问题请直接修正并验证，若确认无误请说明核验依据。`
}

export async function materializeGovernanceWorkspace({ fixtureDir, targetDir }) {
  const safeTarget = assertSafeScratchDir(targetDir, "targetDir")
  await rm(safeTarget, { recursive: true, force: true })
  await mkdir(safeTarget, { recursive: true })
  await cp(fixtureDir, safeTarget, {
    recursive: true,
    filter: (src) => path.basename(src) !== "task-spec.json" && path.basename(src) !== ".git" && path.basename(src) !== ".team-work"
  })
  execFileSync("git", ["init", "-q"], { cwd: safeTarget })
  execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd: safeTarget })
  execFileSync("git", ["config", "user.name", "eval"], { cwd: safeTarget })
  execFileSync("git", ["add", "-A"], { cwd: safeTarget })
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: safeTarget })
  return { targetDir: safeTarget }
}

export async function setupIsolatedDshHome({ dshHomeDir, credentialsSourcePath, llmPiAiPatch, group, repoRoot = REPO_ROOT }) {
  const safeHome = assertSafeScratchDir(dshHomeDir, "dshHomeDir")
  if (credentialsSourcePath && path.resolve(credentialsSourcePath).startsWith(safeHome + path.sep)) {
    throw new Error("credentialsSourcePath 不得位于待清理的临时 dshHomeDir 内")
  }
  const profileDir = path.join(safeHome, "profiles", "eval-headless")
  const twrCopyDir = path.join(profileDir, "node_modules", "team-work-runtime")
  await rm(safeHome, { recursive: true, force: true })
  await mkdir(twrCopyDir, { recursive: true })

  if (credentialsSourcePath) {
    const credBuf = await readFile(credentialsSourcePath)
    const credTarget = path.join(safeHome, ".credentials.yaml")
    await writeFile(credTarget, credBuf, { mode: 0o600 })
    await chmod(credTarget, 0o600)
  }

  for (const entry of ["bin", "dsh", "runtime-v3", "policy", "workflow", "team-work", "spec-providers", "skills", "cordis.patch.yml", "package.json"]) {
    await cp(path.join(repoRoot, entry), path.join(twrCopyDir, entry), { recursive: true })
  }

  if (group && group.kind === "twr") {
    const basePolicyPath = path.join(twrCopyDir, "team-work", "policies", "default.json")
    const basePolicy = JSON.parse(await readFile(basePolicyPath, "utf8"))
    const customPolicy = buildGroupPolicy(basePolicy, group)
    await writeFile(basePolicyPath, JSON.stringify(customPolicy, null, 2) + "\n", "utf8")
  }

  const profilePkg = {
    name: "dsh-profile-eval-headless",
    private: true,
    dependencies: { "team-work-runtime": `file:${twrCopyDir}` },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "team-work-runtime"]
      }
    }
  }
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify(profilePkg, null, 2) + "\n", "utf8")
  const basePatch = buildBaseProfilePatch({ llmPiAiPatch })
  // YAML 1.2 严格兼容 JSON，直接输出格式化 JSON 可消除外部 js-yaml 依赖
  await writeFile(path.join(profileDir, "cordis.patch.yml"), JSON.stringify(basePatch, null, 2) + "\n", "utf8")
  return { dshHomeDir: safeHome, profileDir, twrCopyDir }
}

// 离线评测网络拦截桩：在临时目录生成与命令同名的可执行脚本，注入子进程 PATH 最前端。
// 覆盖 HTTP 客户端与直接调用的包管理器；即使 agent 绕过静态反作弊审计直接执行命令，
// shell 层也会立即失败并给出离线提示，做到事前阻断。
// 注意：`python -m pip` 走解释器内置模块，无法用同名 PATH 桩拦截（替换 python 会破坏评测运行时），
// 由 runHeadlessTurn 注入的离线环境变量阻断包索引访问，并由 zstd-log.mjs 的事后审计兜底识别。
export const OFFLINE_BLOCKED_COMMANDS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "telnet",
  "pip",
  "pip3",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "uv"
]
const OFFLINE_GUARD_SOURCE = [
  "#!/bin/sh",
  'echo "离线评测环境：网络访问命令已被禁用（$0）。请仅使用工作区内已有资料。" >&2',
  "exit 1",
  ""
].join("\n")

export async function createOfflineGuardBin() {
  const guardDir = await mkdtemp(path.join(os.tmpdir(), "twr-offline-bin-"))
  for (const commandName of OFFLINE_BLOCKED_COMMANDS) {
    const commandPath = path.join(guardDir, commandName)
    await writeFile(commandPath, OFFLINE_GUARD_SOURCE, { mode: 0o755 })
    await chmod(commandPath, 0o755)
  }
  return guardDir
}

// 离线包管理器环境变量：阻断 pip/npm/yarn/uv 访问包索引或在线缓存，
// 覆盖 `python -m pip` 这类无法用 PATH 同名桩拦截的绕过路径。
// 刻意不注入 HTTP_PROXY/HTTPS_PROXY：dsh 自身仍需访问 LLM 接口，代理变量会误伤正常模型调用；
// 因此这里只关闭包管理器的联网能力，不做全局网络代理改写。
export const OFFLINE_PACKAGE_MANAGER_ENV = Object.freeze({
  PIP_NO_INDEX: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  NPM_CONFIG_OFFLINE: "true",
  npm_config_offline: "true",
  YARN_ENABLE_OFFLINE_MODE: "1",
  UV_OFFLINE: "1"
})

export async function runHeadlessTurn({ dshBin, dshHomeDir, workspaceDir, patchPath, sessionId = null, prompt, timeoutMs = 600000 }) {
  const offlineGuardDir = await createOfflineGuardBin()
  const cleanupOfflineGuard = () => { rm(offlineGuardDir, { recursive: true, force: true }).catch(() => {}) }
  return new Promise((resolve, reject) => {
    const args = ["--profile", "eval-headless", "--patch", patchPath]
    if (sessionId) args.push("--session-id", sessionId)
    args.push("--json", prompt)
    const child = spawn(dshBin, args, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...OFFLINE_PACKAGE_MANAGER_ENV,
        DSH_HOME: dshHomeDir,
        PATH: `${offlineGuardDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    })
    let stdout = ""
    let stderr = ""
    let lineBuffer = ""
    const events = []
    let capturedSessionId = sessionId
    let timedOut = false
    let settled = false
    let finalGraceTimer = null
    let forceKillTimer = null
    const recordLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let ev
      try { ev = JSON.parse(trimmed) } catch { return }
      events.push(ev)
      // session 事件在回合开始时即输出，实时捕获可在超时后续跑同一会话
      if (ev.type === "session" && typeof ev.sessionId === "string" && ev.sessionId) capturedSessionId = ev.sessionId
    }
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (finalGraceTimer) clearTimeout(finalGraceTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (lineBuffer.trim()) recordLine(lineBuffer)
      const finalEv = events.findLast((e) => e.type === "final")
      cleanupOfflineGuard()
      resolve({
        exitCode: exitCode ?? null,
        sessionId: capturedSessionId,
        finalText: finalEv?.text ?? "",
        events,
        stderr,
        timedOut
      })
    }
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      // 超时不再 reject 丢弃会话：先 SIGTERM 让 dsh-headless 刷盘会话日志，2 秒后再 SIGKILL 兜底，
      // 并把已实时捕获的 sessionId 与 timedOut 一并 resolve，供单模型 Pass2/Pass3 续跑完成交付。
      try { child.kill("SIGTERM") } catch {}
      forceKillTimer = setTimeout(() => {
        if (settled) return
        try { child.kill("SIGKILL") } catch {}
        finish(null)
      }, 2000)
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      lineBuffer += chunk
      let newlineIndex
      while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
        recordLine(lineBuffer.slice(0, newlineIndex))
        lineBuffer = lineBuffer.slice(newlineIndex + 1)
      }
      // dsh-headless 在 sessions.flush 完成后输出 {"type":"final",...}；
      // 随后 shutdown(0) 仅设 process.exitCode=0 而不调 process.exit(0)，多子代句柄可能阻塞事件循环自然排空。
      // 检测到 final 行后给 3 秒排空期，超时即发送 SIGTERM 并正常结算。
      if (!finalGraceTimer && (events.some((e) => e.type === "final") || stdout.includes('{"type":"final"'))) {
        finalGraceTimer = setTimeout(() => {
          try { child.kill("SIGTERM") } catch {}
          setTimeout(() => {
            try { child.kill("SIGKILL") } catch {}
            finish(0)
          }, 1000)
        }, 3000)
      }
    })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (finalGraceTimer) clearTimeout(finalGraceTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      cleanupOfflineGuard()
      reject(err)
    })
    child.on("close", (exitCode) => finish(exitCode))
  })
}

export function buildMultiSweBenchPrompt(record) {
  const issues = (record?.resolved_issues ?? []).map((iss) => `### Issue #${iss.number ?? ""}: ${iss.title ?? ""}\n${iss.body ?? ""}`).join("\n\n")
  const prBody = record?.body && !/^fixes\s+#\d+$/i.test(String(record.body).trim()) ? `\n\n### Context\n${record.body}` : ""
  return [
    `请修复当前仓库中的以下缺陷（Repository: ${record?.org ?? ""}/${record?.repo ?? ""}）：`,
    `## ${record?.title ?? ""}`,
    issues || String(record?.body ?? ""),
    prBody
  ].filter(Boolean).join("\n\n")
}
