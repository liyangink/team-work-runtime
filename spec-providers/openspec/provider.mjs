import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

import { digestValue } from "../../runtime/domain/digests.mjs"
import { atomicJson, atomicWrite, withOwnerLock } from "../../runtime/persistence/transactions.mjs"

const execFile = promisify(execFileCallback)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARTIFACTS = new Set(["proposal", "design", "specs", "tasks"])

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw fail("INVALID_IDENTIFIER", `${label} is not a safe identifier`)
  return value
}

function timestamp(clock) {
  const value = clock()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function relativeRoot(value) {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) throw fail("SPEC_ROOT_INVALID", "OpenSpec root must be project-relative")
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (!normalized || normalized.split("/").some((entry) => entry === "" || entry === "." || entry === "..")) {
    throw fail("SPEC_ROOT_INVALID", "OpenSpec root must remain inside the project")
  }
  return normalized
}

function unwrapJson(stdout, label) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw fail("SPEC_PROVIDER_INVALID_RESPONSE", `${label} did not return valid JSON`)
  }
}

async function defaultRunner({ command, args, cwd, timeout }) {
  return execFile(command, args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
}

async function exists(target) {
  return lstat(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))
}

async function assertNoSymlink(root, target, label, { allowMissing = false } = {}) {
  const relative = path.relative(root, target)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("PATH_ESCAPE", `${label} escapes the project root`)
  }
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return
      throw error
    }
    if (metadata.isSymbolicLink()) throw fail("PATH_ESCAPE", `${label} crosses a symbolic link`)
  }
}

async function collectFiles(projectRoot, relativeDirectory, predicate = () => true) {
  const directory = path.join(projectRoot, relativeDirectory)
  if (!await exists(directory)) return []
  await assertNoSymlink(projectRoot, directory, "OpenSpec directory")
  const output = []
  async function visit(currentRelative) {
    const current = path.join(projectRoot, currentRelative)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = `${currentRelative.replace(/\/$/, "")}/${entry.name}`
      if (entry.isSymbolicLink()) throw fail("PATH_ESCAPE", `OpenSpec path crosses a symbolic link: ${child}`)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && predicate(child)) output.push(child)
    }
  }
  await visit(relativeDirectory)
  return output.sort()
}

export function createOpenSpecProvider({
  projectRoot,
  command = "openspec",
  specRoot = "openspec",
  runner = defaultRunner,
  clock = () => new Date(),
  faultInjector = {},
} = {}) {
  if (!projectRoot) throw new TypeError("projectRoot is required")
  if (typeof command !== "string" || command === "") throw new TypeError("OpenSpec command is required")
  const configuredRoot = relativeRoot(specRoot)
  let rootsPromise

  async function roots() {
    if (!rootsPromise) rootsPromise = (async () => {
      const root = await realpath(path.resolve(projectRoot))
      const control = path.join(root, ".team-work")
      const metadata = await lstat(control)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw fail("PATH_ESCAPE", "Runtime control root must be a real directory")
      const providerRoot = path.join(control, "spec-providers", "openspec")
      for (const directory of [providerRoot, path.join(providerRoot, "operations"), path.join(providerRoot, "instructions"), path.join(providerRoot, "validation"), path.join(providerRoot, "locks")]) {
        await mkdir(directory, { recursive: true })
      }
      return { root, control, providerRoot }
    })()
    return rootsPromise
  }

  async function run(args, timeout = 30_000) {
    const { root } = await roots()
    try {
      return await runner({ command, args, cwd: root, timeout })
    } catch (error) {
      const wrapped = fail("SPEC_PROVIDER_FAILED", error.stderr?.trim() || error.message || String(error))
      wrapped.cause = error
      throw wrapped
    }
  }

  function operationPath(base, operationId) {
    return path.join(base.providerRoot, "operations", `${requireIdentifier(operationId, "operationId")}.json`)
  }

  async function readOperation(operationId) {
    const base = await roots()
    try {
      return JSON.parse(await readFile(operationPath(base, operationId), "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      if (error instanceof SyntaxError) throw fail("SPEC_OPERATION_CORRUPT", `OpenSpec operation ${operationId} is corrupt`)
      throw error
    }
  }

  async function saveOperation(record) {
    const base = await roots()
    await atomicJson(operationPath(base, record.operationId), record)
  }

  async function withOperation(operationId, action) {
    const base = await roots()
    return withOwnerLock(path.join(base.providerRoot, "locks", `${requireIdentifier(operationId, "operationId")}.lock`), action)
  }

  function assertTask(task) {
    if (task.providerId !== "openspec") throw fail("SPEC_PROVIDER_MISMATCH", "OpenSpec Provider received another provider id")
    requireIdentifier(task.taskId, "taskId")
    requireIdentifier(task.stageRunId, "stageRunId")
    return task
  }

  function activeRoot(taskId) {
    return `${configuredRoot}/changes/${taskId}`
  }

  function archiveBase() {
    return `${configuredRoot}/changes/archive`
  }

  async function archivedRoots(taskId) {
    const base = await roots()
    const directory = path.join(base.root, archiveBase())
    if (!await exists(directory)) return []
    await assertNoSymlink(base.root, directory, "OpenSpec archive root")
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${taskId}`))
      .map((entry) => `${archiveBase()}/${entry.name}`)
      .sort()
  }

  async function changeStatus(task) {
    const base = await roots()
    const relative = activeRoot(task.taskId)
    const directory = path.join(base.root, relative)
    if (!await exists(directory)) return null
    await assertNoSymlink(base.root, directory, "OpenSpec active change")
    const response = await run(["status", "--change", task.taskId, "--json"])
    return { raw: unwrapJson(response.stdout, "OpenSpec status"), activeRoot: relative }
  }

  async function instructions(task, artifact) {
    const response = await run(["instructions", artifact, "--change", task.taskId, "--json"])
    const value = unwrapJson(response.stdout, `OpenSpec instructions ${artifact}`)
    if (value.artifactId !== artifact || typeof value.instruction !== "string" || typeof value.template !== "string") {
      throw fail("SPEC_PROVIDER_INVALID_RESPONSE", `OpenSpec instructions ${artifact} are incomplete`)
    }
    return value
  }

  async function artifactRefs(relative) {
    return collectFiles((await roots()).root, relative, (entry) => entry.endsWith(".md"))
  }

  async function providerRevision(status, refs) {
    const base = await roots()
    const files = []
    for (const ref of refs) files.push({ ref, digest: digestValue(await readFile(path.join(base.root, ref), "utf8")) })
    return digestValue({ status, files })
  }

  function writableRefsFor(task, artifact, capabilityNames, instruction) {
    const root = activeRoot(task.taskId)
    if (artifact === "specs") {
      if (!Array.isArray(capabilityNames) || capabilityNames.length === 0) throw fail("SPEC_CAPABILITY_REQUIRED", "OpenSpec specs require at least one capability name")
      const names = [...new Set(capabilityNames)]
      for (const name of names) {
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) throw fail("SPEC_CAPABILITY_INVALID", `invalid OpenSpec capability: ${name}`)
      }
      return names.map((name) => `${root}/specs/${name}/spec.md`)
    }
    if (capabilityNames?.length) throw fail("SPEC_CAPABILITY_INVALID", `${artifact} does not accept capability names`)
    if (typeof instruction.outputPath !== "string" || instruction.outputPath === "" || path.isAbsolute(instruction.outputPath) || instruction.outputPath.split(/[\\/]/).includes("..")) {
      throw fail("SPEC_PROVIDER_INVALID_RESPONSE", `OpenSpec instructions ${artifact} returned an unsafe output path`)
    }
    return [`${root}/${instruction.outputPath.replace(/^\/+/, "")}`]
  }

  async function composeCapability(intent, { createInstructions = true } = {}) {
    const task = assertTask(intent.task)
    if (!ARTIFACTS.has(intent.artifact)) throw fail("SPEC_ARTIFACT_INVALID", `unsupported OpenSpec artifact: ${intent.artifact}`)
    const change = await changeStatus(task)
    if (!change) return null
    const artifactState = (change.raw.artifacts ?? []).find(({ id }) => id === intent.artifact)
    const ready = ["ready", "done"].includes(artifactState?.status)
    let instruction
    try {
      instruction = await instructions(task, intent.artifact)
    } catch (error) {
      if (!ready) instruction = { artifactId: intent.artifact, instruction: `OpenSpec artifact ${intent.artifact} is not ready.`, template: "", outputPath: `${intent.artifact}.md` }
      else throw error
    }
    const writableRefs = ready ? writableRefsFor(task, intent.artifact, intent.capabilityNames, instruction) : []
    const existingRefs = await artifactRefs(change.activeRoot)
    const body = [
      `# OpenSpec ${intent.artifact}`,
      "",
      `活动变更：${task.taskId}`,
      `状态：${artifactState?.status ?? "unknown"}`,
      "",
      instruction.instruction,
      "",
      "## 模板",
      "",
      instruction.template,
      "",
      "只允许修改以下路径：",
      ...writableRefs.map((entry) => `- \`${entry}\``),
      "禁止修改 canonical specs、archive、历史或其他任务的 change。",
      "",
    ].join("\n")
    const capabilityId = `openspec-${digestValue({ task, artifact: intent.artifact, capabilityNames: intent.capabilityNames ?? [], body }).slice(0, 24)}`
    const instructionsRef = `.team-work/spec-providers/openspec/instructions/${capabilityId}.md`
    if (createInstructions) await atomicWrite(path.join((await roots()).root, instructionsRef), body)
    const value = {
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      capabilityId,
      capabilityDigest: "",
      task: structuredClone(task),
      instructionsRef,
      readableRefs: [...new Set([instructionsRef, ...existingRefs])],
      writableRefs,
      status: ready ? "ready" : "blocked",
    }
    value.capabilityDigest = digestValue({ ...value, capabilityDigest: undefined })
    return value
  }

  async function inspectArchive(intent) {
    const task = assertTask(intent.task)
    const archives = await archivedRoots(task.taskId)
    if (archives.length === 0) return null
    const archive = archives.at(-1)
    return {
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      task: structuredClone(task),
      status: "confirmed",
      archiveRefs: await artifactRefs(archive),
      observedAt: timestamp(clock),
    }
  }

  const provider = {
    async probe() {
      try {
        const version = (await run(["--version"], 10_000)).stdout.trim()
        const listed = unwrapJson((await run(["list", "--json"], 15_000)).stdout, "OpenSpec list")
        if (!Array.isArray(listed.changes)) throw fail("SPEC_PROVIDER_INVALID_RESPONSE", "OpenSpec list omitted changes")
        return { providerId: "openspec", status: "ready", ...(version ? { version } : {}), observedAt: timestamp(clock) }
      } catch {
        return { providerId: "openspec", status: "missing", observedAt: timestamp(clock) }
      }
    },

    async prepare(intent) {
      return withOperation(intent.operationId, async () => {
        const existing = await readOperation(intent.operationId)
        if (existing) {
          if (existing.kind !== "prepare" || existing.effectDigest !== intent.effectDigest) throw fail("OPERATION_DIGEST_CONFLICT", `OpenSpec operation ${intent.operationId} conflicts`)
          if (existing.result) return existing.result
        }
        const started = existing ?? {
          schemaVersion: "2.0",
          kind: "prepare",
          operationId: intent.operationId,
          effectDigest: intent.effectDigest,
          intent: structuredClone(intent),
          phase: "started",
          createdAt: timestamp(clock),
          updatedAt: timestamp(clock),
        }
        await saveOperation(started)
        const base = await roots()
        const active = path.join(base.root, activeRoot(assertTask(intent.task).taskId))
        if (!await exists(active)) {
          await assertNoSymlink(base.root, active, "OpenSpec active change", { allowMissing: true })
          await run(["new", "change", intent.task.taskId, "--schema", "spec-driven"])
          await faultInjector.afterChangeCreated?.({ intent: structuredClone(intent) })
        }
        const result = await composeCapability(intent)
        if (!result) throw fail("SPEC_CHANGE_NOT_FOUND", `OpenSpec did not create active change ${intent.task.taskId}`)
        await faultInjector.afterCapabilityPrepared?.({ intent: structuredClone(intent), result: structuredClone(result) })
        await saveOperation({ ...started, phase: "confirmed", result, updatedAt: timestamp(clock) })
        return result
      })
    },

    async status(task) {
      assertTask(task)
      const change = await changeStatus(task)
      if (!change) {
        const archives = await archivedRoots(task.taskId)
        if (archives.length === 0) return { task: structuredClone(task), providerRevision: digestValue({ task, state: "not-started" }), state: "not-started", readyArtifacts: [], artifactRefs: [], blockers: [] }
        const refs = await artifactRefs(archives.at(-1))
        return { task: structuredClone(task), providerRevision: await providerRevision({ archived: archives.at(-1) }, refs), state: "complete", readyArtifacts: [], artifactRefs: refs, blockers: [] }
      }
      const refs = await artifactRefs(change.activeRoot)
      const readyArtifacts = (change.raw.artifacts ?? []).filter(({ status }) => status === "ready").map(({ id }) => id)
      const blockers = (change.raw.artifacts ?? []).filter(({ status }) => status === "blocked").map(({ id }) => `${id} is blocked by prerequisite artifacts`)
      return {
        task: structuredClone(task),
        providerRevision: await providerRevision(change.raw, refs),
        state: change.raw.isComplete ? "complete" : blockers.length && readyArtifacts.length === 0 ? "blocked" : "in-progress",
        readyArtifacts,
        artifactRefs: refs,
        blockers,
      }
    },

    async validate(task) {
      const status = await provider.status(task)
      if (status.state !== "complete") {
        return { task: structuredClone(task), providerRevision: status.providerRevision, valid: false, complete: false, evidenceRefs: [], blockers: status.blockers.length ? status.blockers : ["OpenSpec change is incomplete"] }
      }
      try {
        const response = await run(["validate", task.taskId, "--type", "change", "--strict", "--json", "--no-interactive"])
        const payload = unwrapJson(response.stdout || "{}", "OpenSpec validate")
        const validationId = `validation-${digestValue({ task, revision: status.providerRevision, payload }).slice(0, 24)}`
        const evidenceRef = `.team-work/spec-providers/openspec/validation/${validationId}.json`
        await atomicJson(path.join((await roots()).root, evidenceRef), { task, providerRevision: status.providerRevision, payload, observedAt: timestamp(clock) })
        const valid = payload.valid !== false
        return { task: structuredClone(task), providerRevision: status.providerRevision, valid, complete: true, evidenceRefs: [evidenceRef], blockers: valid ? [] : ["OpenSpec strict validation failed"] }
      } catch (error) {
        return { task: structuredClone(task), providerRevision: status.providerRevision, valid: false, complete: true, evidenceRefs: [], blockers: [error.message] }
      }
    },

    async archive(intent) {
      return withOperation(intent.operationId, async () => {
        const existing = await readOperation(intent.operationId)
        if (existing) {
          if (existing.kind !== "archive" || existing.effectDigest !== intent.effectDigest) throw fail("OPERATION_DIGEST_CONFLICT", `OpenSpec operation ${intent.operationId} conflicts`)
          if (existing.result) return existing.result
        }
        const recovered = await inspectArchive(intent)
        if (recovered) {
          await saveOperation({ schemaVersion: "2.0", kind: "archive", operationId: intent.operationId, effectDigest: intent.effectDigest, intent: structuredClone(intent), phase: "confirmed", result: recovered, createdAt: timestamp(clock), updatedAt: timestamp(clock) })
          return recovered
        }
        const status = await provider.status(intent.task)
        if (status.providerRevision !== intent.expectedProviderRevision || status.state !== "complete") {
          return { operationId: intent.operationId, effectDigest: intent.effectDigest, task: structuredClone(intent.task), status: "blocked", archiveRefs: [], observedAt: timestamp(clock) }
        }
        const validation = await provider.validate(intent.task)
        if (!validation.valid || !validation.complete) {
          return { operationId: intent.operationId, effectDigest: intent.effectDigest, task: structuredClone(intent.task), status: "blocked", archiveRefs: [], observedAt: timestamp(clock) }
        }
        const started = { schemaVersion: "2.0", kind: "archive", operationId: intent.operationId, effectDigest: intent.effectDigest, intent: structuredClone(intent), phase: "started", createdAt: timestamp(clock), updatedAt: timestamp(clock) }
        await saveOperation(started)
        await run(["archive", intent.task.taskId, "--yes"], 60_000)
        await faultInjector.afterArchive?.({ intent: structuredClone(intent) })
        const result = await inspectArchive(intent)
        if (!result) throw fail("SPEC_ARCHIVE_NOT_FOUND", "OpenSpec archive completed without a discoverable archive")
        await saveOperation({ ...started, phase: "confirmed", result, updatedAt: timestamp(clock) })
        return result
      })
    },

    async inspect(intent) {
      return withOperation(intent.operationId, async () => {
        const existing = await readOperation(intent.operationId)
        if (existing) {
          if (existing.kind !== intent.kind || existing.effectDigest !== intent.effectDigest) throw fail("OPERATION_DIGEST_CONFLICT", `OpenSpec operation ${intent.operationId} conflicts`)
          if (existing.result) return { operationId: intent.operationId, effectDigest: intent.effectDigest, kind: intent.kind, status: "confirmed", result: existing.result, observedAt: timestamp(clock) }
        }
        try {
          const source = existing?.intent ?? intent
          const result = intent.kind === "prepare"
            ? await composeCapability(source)
            : await inspectArchive(source)
          if (!result) return { operationId: intent.operationId, effectDigest: intent.effectDigest, kind: intent.kind, status: "missing", observedAt: timestamp(clock) }
          await saveOperation({ schemaVersion: "2.0", kind: intent.kind, operationId: intent.operationId, effectDigest: intent.effectDigest, intent: structuredClone(source), phase: "confirmed", result, createdAt: existing?.createdAt ?? timestamp(clock), updatedAt: timestamp(clock) })
          return { operationId: intent.operationId, effectDigest: intent.effectDigest, kind: intent.kind, status: "confirmed", result, observedAt: timestamp(clock) }
        } catch (error) {
          return { operationId: intent.operationId, effectDigest: intent.effectDigest, kind: intent.kind, status: "in-doubt", blocker: error.message, observedAt: timestamp(clock) }
        }
      })
    },
  }

  return Object.freeze(provider)
}
