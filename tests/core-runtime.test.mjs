import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(repositoryRoot, "runtime/cli.mjs")

async function project() {
  return mkdtemp(path.join(tmpdir(), "team-work-runtime-"))
}

async function run(projectRoot, ...args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args, "--project", projectRoot, "--json"], {
    cwd: repositoryRoot,
  })
  assert.equal(stderr, "")
  return JSON.parse(stdout)
}

async function runResult(projectRoot, ...args) {
  try {
    return { envelope: await run(projectRoot, ...args), exitCode: 0 }
  } catch (error) {
    assert.equal(error.stderr, "")
    return { envelope: JSON.parse(error.stdout), exitCode: error.code }
  }
}

test("user can initialize a project and create a task at any workflow stage", async () => {
  const projectRoot = await project()

  const initialized = await run(projectRoot, "init")
  assert.equal(initialized.ok, true)
  assert.equal(initialized.data.workflow.id, "engineering")

  const created = await run(
    projectRoot,
    "task", "create",
    "--task", "review-existing-code",
    "--title", "Review existing code",
    "--entry-stage", "code-review",
  )
  assert.equal(created.ok, true)
  assert.equal(created.taskId, "review-existing-code")
  assert.equal(created.revision, 0)
  assert.equal(created.data.task.stage, "code-review")
  assert.equal(created.data.task.entryStage, "code-review")

  const shown = await run(projectRoot, "task", "show", "--task", "review-existing-code")
  assert.deepEqual(shown.data.task, created.data.task)

  const persisted = JSON.parse(await readFile(path.join(projectRoot, ".team-work/tasks/review-existing-code/task.json"), "utf8"))
  assert.equal(persisted.workflow.digest, initialized.data.workflow.digest)
  assert.equal(persisted.spec.status, "not-started")
  assert.equal(persisted.teamDecision.mode, "undecided")
})

test("Workflow persists team decisions and SPEC lifecycle through Runtime", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await writeFile(path.join(projectRoot, "spec.md"), "implementation spec\n")
  await writeFile(path.join(projectRoot, "requirement.md"), "research requirement\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "policy-state", "--entry-stage", "spec")

  const team = await run(
    projectRoot,
    "task", "team", "--task", "policy-state", "--mode", "team",
    "--reason", "Independent SPEC review has high value", "--expected-revision", "0",
  )
  assert.deepEqual(team.data.task.teamDecision, { mode: "team", reason: "Independent SPEC review has high value" })
  assert.equal(team.revision, 1)

  const started = await run(
    projectRoot,
    "task", "spec", "--task", "policy-state", "--status", "in-progress", "--expected-revision", "1",
  )
  assert.equal(started.data.task.spec.status, "in-progress")
  assert.deepEqual(started.data.task.spec.artifactRefs, [])

  const completed = await run(
    projectRoot,
    "task", "spec", "--task", "policy-state", "--status", "completed",
    "--artifacts", "spec.md", "--expected-revision", "2",
  )
  assert.equal(completed.data.task.spec.status, "completed")
  assert.deepEqual(completed.data.task.spec.artifactRefs, ["spec.md"])
  assert.equal(completed.revision, 3)

  const missingArtifact = await runResult(
    projectRoot,
    "task", "spec", "--task", "policy-state", "--status", "completed",
    "--artifacts", "missing.md", "--expected-revision", "3",
  )
  assert.equal(missingArtifact.envelope.error.code, "INVALID_ARGUMENT")

  await run(projectRoot, "task", "create", "--task", "stage-team-reset", "--entry-stage", "research")
  await run(
    projectRoot,
    "context", "register", "--task", "stage-team-reset", "--context", "requirement",
    "--kind", "requirement", "--path", "requirement.md", "--profiles", "lead,research", "--expected-revision", "0",
  )
  await run(
    projectRoot,
    "task", "team", "--task", "stage-team-reset", "--mode", "solo",
    "--reason", "Research is narrow", "--expected-revision", "1",
  )
  const advanced = await run(projectRoot, "flow", "advance", "--task", "stage-team-reset", "--outcome", "pass", "--expected-revision", "2")
  assert.equal(advanced.data.task.stage, "design")
  assert.deepEqual(advanced.data.task.teamDecision, { mode: "undecided" })
})

test("user registers minimal context and checks only the current stage gate", async () => {
  const projectRoot = await project()
  await mkdir(path.join(projectRoot, "src"))
  await writeFile(path.join(projectRoot, "src/index.js"), "export const answer = 42\n")
  await writeFile(path.join(projectRoot, "review-scope.md"), "Review src/index.js\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "review", "--entry-stage", "code-review")

  const initiallyBlocked = await runResult(projectRoot, "flow", "check", "--task", "review")
  assert.equal(initiallyBlocked.exitCode, 4)
  assert.equal(initiallyBlocked.envelope.error.code, "GATE_BLOCKED")
  assert.deepEqual(initiallyBlocked.envelope.error.blockers.map(({ kind }) => kind), ["source", "review-scope"])

  const source = await run(
    projectRoot,
    "context", "register", "--task", "review", "--context", "source-code",
    "--kind", "source", "--path", "src", "--profiles", "lead,check", "--priority", "100", "--must-read",
    "--expected-revision", "0",
  )
  assert.equal(source.revision, 1)

  const stillBlocked = await runResult(projectRoot, "flow", "check", "--task", "review")
  assert.deepEqual(stillBlocked.envelope.error.blockers.map(({ kind }) => kind), ["review-scope"])

  const scope = await run(
    projectRoot,
    "context", "register", "--task", "review", "--context", "scope",
    "--kind", "review-scope", "--path", "review-scope.md", "--profiles", "lead,check",
    "--priority", "90", "--expected-revision", "1",
  )
  assert.equal(scope.revision, 2)

  const checked = await run(projectRoot, "flow", "check", "--task", "review")
  assert.equal(checked.data.gate.ok, true)
  const rendered = await run(projectRoot, "context", "render", "--task", "review", "--profile", "check")
  assert.deepEqual(rendered.data.entries.map(({ contextId }) => contextId), ["source-code", "scope"])
  assert.doesNotMatch(JSON.stringify(rendered.data.entries), /design|spec/)
})

test("user advances on an explicit edge and rolls back with auditable evidence", async () => {
  const projectRoot = await project()
  await mkdir(path.join(projectRoot, "src"))
  await writeFile(path.join(projectRoot, "src/index.js"), "export const answer = 42\n")
  await writeFile(path.join(projectRoot, "review-scope.md"), "Review src/index.js\n")
  await writeFile(path.join(projectRoot, "review.md"), "No blocking findings\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "review", "--entry-stage", "code-review")
  await run(projectRoot, "context", "register", "--task", "review", "--context", "source", "--kind", "source", "--path", "src", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "review", "--context", "scope", "--kind", "review-scope", "--path", "review-scope.md", "--profiles", "lead,check", "--expected-revision", "1")

  const decided = await run(
    projectRoot,
    "flow", "decide", "--task", "review", "--gate", "e2e-applicability", "--kind", "semantic",
    "--status", "passed", "--reason", "Lead accepted review and E2E applies", "--actor", "lead",
    "--evidence", "review-proof", "--evidence-path", "review.md", "--expected-revision", "2",
  )
  assert.equal(decided.revision, 3)

  const advanced = await run(projectRoot, "flow", "advance", "--task", "review", "--outcome", "pass", "--expected-revision", "3")
  assert.equal(advanced.data.from, "code-review")
  assert.equal(advanced.data.to, "e2e")
  assert.equal(advanced.revision, 4)

  const rolledBack = await run(
    projectRoot,
    "flow", "rollback", "--task", "review", "--to", "implementation",
    "--reason", "Review assumption no longer holds", "--evidence", "review-proof", "--expected-revision", "4",
  )
  assert.equal(rolledBack.data.from, "e2e")
  assert.equal(rolledBack.data.to, "implementation")
  assert.equal(rolledBack.data.task.gates[0].status, "pending")
  assert.equal(rolledBack.data.task.evidence[0].status, "invalidated")
  assert.equal(rolledBack.revision, 5)

  const illegal = await runResult(projectRoot, "flow", "advance", "--task", "review", "--outcome", "fail", "--expected-revision", "5")
  assert.equal(illegal.envelope.error.code, "ILLEGAL_TRANSITION")
})

test("optional SPEC and E2E branches follow the declared skip and internal rework edges", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "requirement.md"), "implement approved design\n")
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await writeFile(path.join(projectRoot, "source.md"), "source\n")
  await writeFile(path.join(projectRoot, "scope.md"), "scope\n")
  await run(projectRoot, "init")

  await run(projectRoot, "task", "create", "--task", "skip-spec", "--entry-stage", "design-review")
  await run(projectRoot, "context", "register", "--task", "skip-spec", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "skip-spec", "--context", "requirement", "--kind", "requirement", "--path", "requirement.md", "--profiles", "lead,implement", "--expected-revision", "1")
  const unavailableSpec = await runResult(projectRoot, "flow", "advance", "--task", "skip-spec", "--outcome", "pass", "--expected-revision", "2")
  assert.equal(unavailableSpec.envelope.error.code, "GATE_BLOCKED")
  assert.equal(unavailableSpec.envelope.error.blockers[0].code, "SPEC_ROUTE_BLOCKED")
  const skippedSpec = await run(projectRoot, "flow", "advance", "--task", "skip-spec", "--outcome", "skip", "--expected-revision", "2")
  assert.equal(skippedSpec.data.to, "implementation")

  await run(projectRoot, "task", "create", "--task", "skip-e2e", "--entry-stage", "code-review")
  await run(projectRoot, "context", "register", "--task", "skip-e2e", "--context", "source", "--kind", "source", "--path", "source.md", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "skip-e2e", "--context", "review-scope", "--kind", "review-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "1")
  const undecidedE2e = await runResult(projectRoot, "flow", "advance", "--task", "skip-e2e", "--outcome", "skip", "--expected-revision", "2")
  assert.equal(undecidedE2e.envelope.error.code, "GATE_BLOCKED")
  await run(
    projectRoot,
    "flow", "decide", "--task", "skip-e2e", "--gate", "e2e-applicability", "--kind", "semantic",
    "--status", "passed", "--reason", "No cross-system user path", "--actor", "lead",
    "--evidence", "e2e-applicability-proof", "--evidence-path", "scope.md", "--expected-revision", "2",
  )
  const skippedE2e = await run(projectRoot, "flow", "advance", "--task", "skip-e2e", "--outcome", "skip", "--expected-revision", "3")
  assert.equal(skippedE2e.data.to, "finish")

  await run(projectRoot, "task", "create", "--task", "e2e-loop", "--entry-stage", "e2e")
  await run(projectRoot, "context", "register", "--task", "e2e-loop", "--context", "source", "--kind", "source", "--path", "source.md", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "e2e-loop", "--context", "test-scope", "--kind", "test-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "1")
  const reworked = await run(projectRoot, "flow", "advance", "--task", "e2e-loop", "--outcome", "rework", "--expected-revision", "2")
  assert.equal(reworked.data.from, "e2e")
  assert.equal(reworked.data.to, "e2e")
})

test("SPEC routing mode cannot be bypassed through direct flow commands", async () => {
  const requiredRoot = await project()
  await writeFile(path.join(requiredRoot, "design.md"), "approved design\n")
  await run(requiredRoot, "init")
  const requiredConfigPath = path.join(requiredRoot, ".team-work/config.yaml")
  const requiredConfig = JSON.parse(await readFile(requiredConfigPath, "utf8"))
  requiredConfig.spec = { ...requiredConfig.spec, mode: "required", status: "missing" }
  await writeFile(requiredConfigPath, `${JSON.stringify(requiredConfig, null, 2)}\n`)
  await run(requiredRoot, "task", "create", "--task", "required-spec", "--entry-stage", "design-review")
  await run(requiredRoot, "context", "register", "--task", "required-spec", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")

  for (const outcome of ["pass", "skip"]) {
    const blocked = await runResult(requiredRoot, "flow", "advance", "--task", "required-spec", "--outcome", outcome, "--expected-revision", "1")
    assert.equal(blocked.envelope.error.code, "GATE_BLOCKED")
    assert.equal(blocked.envelope.error.blockers[0].code, "SPEC_ROUTE_BLOCKED")
  }

  const readyRoot = await project()
  await writeFile(path.join(readyRoot, "design.md"), "approved design\n")
  await run(readyRoot, "init")
  const readyConfigPath = path.join(readyRoot, ".team-work/config.yaml")
  const readyConfig = JSON.parse(await readFile(readyConfigPath, "utf8"))
  readyConfig.spec = { ...readyConfig.spec, mode: "auto", status: "ready" }
  await writeFile(readyConfigPath, `${JSON.stringify(readyConfig, null, 2)}\n`)
  await run(readyRoot, "task", "create", "--task", "ready-spec", "--entry-stage", "design-review")
  await run(readyRoot, "context", "register", "--task", "ready-spec", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")

  const skipped = await runResult(readyRoot, "flow", "advance", "--task", "ready-spec", "--outcome", "skip", "--expected-revision", "1")
  assert.equal(skipped.envelope.error.code, "GATE_BLOCKED")
  const entered = await run(readyRoot, "flow", "advance", "--task", "ready-spec", "--outcome", "pass", "--expected-revision", "1")
  assert.equal(entered.data.to, "spec")
})

test("Lead can rework and accept a work item without losing attempt history", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "review.md"), "review output\n")
  await writeFile(path.join(projectRoot, "proof.md"), "verified evidence\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "team-review", "--entry-stage", "code-review")
  await run(projectRoot, "flow", "decide", "--task", "team-review", "--gate", "review-proof-gate", "--kind", "semantic", "--status", "passed", "--reason", "Evidence captured", "--actor", "lead", "--evidence", "proof-1", "--evidence-path", "proof.md", "--expected-revision", "0")

  await run(
    projectRoot,
    "work", "create", "--task", "team-review", "--work", "security-review", "--owner", "senior-terra",
    "--scope", "Review failure paths", "--done-when", "Evidence-backed findings",
    "--artifacts", "review.md", "--expected-revision", "1",
  )
  await run(projectRoot, "work", "start", "--task", "team-review", "--work", "security-review", "--expected-revision", "2")
  await run(
    projectRoot,
    "work", "submit", "--task", "team-review", "--work", "security-review", "--scenario", "code-review",
    "--scope-refs", "src", "--outcome", "pass", "--artifacts", "review.md", "--evidence", "proof-1",
    "--summary", "First review", "--expected-revision", "3",
  )
  const fakeEvidence = await runResult(
    projectRoot,
    "work", "rework", "--task", "team-review", "--work", "security-review",
    "--evidence", "fake-proof", "--reason", "Invalid evidence", "--expected-revision", "4",
  )
  assert.equal(fakeEvidence.envelope.error.code, "INVALID_ARGUMENT")
  const rework = await run(
    projectRoot,
    "work", "rework", "--task", "team-review", "--work", "security-review",
    "--evidence", "proof-1", "--reason", "Missing boundary analysis", "--expected-revision", "4",
  )
  assert.equal(rework.data.workItem.status, "rework")

  const restarted = await run(projectRoot, "work", "start", "--task", "team-review", "--work", "security-review", "--expected-revision", "5")
  assert.equal(restarted.data.workItem.status, "running")
  assert.equal(restarted.data.workItem.attempt, 2)
  assert.equal(restarted.data.workItem.attemptHistory[0].acceptance.decision, "rework")

  await run(
    projectRoot,
    "work", "submit", "--task", "team-review", "--work", "security-review", "--scenario", "code-review",
    "--scope-refs", "src", "--outcome", "pass", "--artifacts", "review.md", "--evidence", "proof-1",
    "--summary", "Boundary analysis added", "--expected-revision", "6",
  )
  const accepted = await run(
    projectRoot,
    "work", "accept", "--task", "team-review", "--work", "security-review",
    "--evidence", "proof-1", "--reason", "Evidence verified", "--expected-revision", "7",
  )
  assert.equal(accepted.data.workItem.status, "accepted")
  assert.equal(accepted.data.workItem.acceptance.decision, "accepted")
  assert.equal(accepted.revision, 8)

  const shown = await run(projectRoot, "work", "show", "--task", "team-review", "--work", "security-review")
  assert.deepEqual(shown.data.workItem, accepted.data.workItem)
})

test("infrastructure blockage can retry or reassign the same work item with audit history", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "report.md"), "partial report\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "gateway-recovery", "--entry-stage", "research")
  await run(
    projectRoot,
    "work", "create", "--task", "gateway-recovery", "--work", "facts", "--owner", "junior-a",
    "--scope", "Collect code facts", "--done-when", "Report has evidence", "--artifacts", "report.md", "--expected-revision", "0",
  )
  await run(projectRoot, "work", "start", "--task", "gateway-recovery", "--work", "facts", "--expected-revision", "1")

  const blocked = await run(
    projectRoot,
    "work", "block", "--task", "gateway-recovery", "--work", "facts",
    "--error-code", "RATE_LIMITED", "--reason", "Gateway returned 429", "--refs", "gateway-log-1",
    "--expected-revision", "2",
  )
  assert.equal(blocked.data.workItem.status, "blocked")
  assert.equal(blocked.data.workItem.blockage.code, "RATE_LIMITED")
  assert.equal(blocked.data.workItem.blockage.owner, "junior-a")

  const reassigned = await run(
    projectRoot,
    "work", "start", "--task", "gateway-recovery", "--work", "facts", "--owner", "junior-b",
    "--expected-revision", "3",
  )
  assert.equal(reassigned.data.workItem.status, "running")
  assert.equal(reassigned.data.workItem.owner, "junior-b")
  assert.equal(reassigned.data.workItem.attempt, 2)
  assert.equal(reassigned.data.workItem.attemptHistory[0].owner, "junior-a")
  assert.equal(reassigned.data.workItem.attemptHistory[0].blockage.code, "RATE_LIMITED")

  await run(
    projectRoot,
    "work", "block", "--task", "gateway-recovery", "--work", "facts",
    "--error-code", "UPSTREAM_UNAVAILABLE", "--reason", "Replacement provider unavailable",
    "--refs", "gateway-log-2",
    "--expected-revision", "4",
  )
  const cancelled = await run(
    projectRoot,
    "work", "cancel", "--task", "gateway-recovery", "--work", "facts",
    "--reason", "User chose solo fallback", "--expected-revision", "5",
  )
  assert.equal(cancelled.data.workItem.status, "cancelled")
  assert.equal(cancelled.data.workItem.blockage.code, "UPSTREAM_UNAVAILABLE")
  assert.deepEqual(cancelled.data.workItem.blockage.refs, ["gateway-log-2"])
})

test("active task resolution never guesses and session binding is only an index", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "first", "--entry-stage", "research")
  await run(projectRoot, "task", "create", "--task", "second", "--entry-stage", "implementation")

  const ambiguous = await runResult(projectRoot, "task", "show")
  assert.equal(ambiguous.envelope.error.code, "TASK_AMBIGUOUS")

  const bound = await run(projectRoot, "task", "bind", "--task", "second", "--platform", "opencode", "--session", "session-42")
  assert.equal(bound.data.binding.taskId, "second")
  const rebinds = await Promise.all([
    runResult(projectRoot, "task", "bind", "--task", "first", "--platform", "opencode", "--session", "session-42", "--expected-revision", "0"),
    runResult(projectRoot, "task", "bind", "--task", "second", "--platform", "opencode", "--session", "session-42", "--expected-revision", "0"),
  ])
  assert.equal(rebinds.filter(({ envelope }) => envelope.ok).length, 1)
  assert.equal(rebinds.filter(({ envelope }) => !envelope.ok).length, 1)
  const winner = rebinds.find(({ envelope }) => envelope.ok).envelope.data.binding.taskId
  const fromBinding = await run(projectRoot, "task", "show", "--platform", "opencode", "--session", "session-42")
  assert.equal(fromBinding.taskId, winner)

  const explicitWins = await run(projectRoot, "task", "show", "--task", "first", "--platform", "opencode", "--session", "session-42")
  assert.equal(explicitWins.taskId, "first")
})

test("task lifecycle distinguishes awaiting, completion, cancellation and archive", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "final.md"), "accepted result\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "finished", "--entry-stage", "finish")
  await run(
    projectRoot,
    "flow", "decide", "--task", "finished", "--gate", "final-acceptance", "--kind", "semantic",
    "--status", "passed", "--reason", "Final evidence verified", "--actor", "lead",
    "--evidence", "final-proof", "--evidence-path", "final.md", "--expected-revision", "0",
  )
  const completed = await run(
    projectRoot,
    "task", "complete", "--task", "finished", "--summary", "Task accepted", "--actor", "lead",
    "--artifacts", "final.md", "--evidence", "final-proof", "--expected-revision", "1",
  )
  assert.equal(completed.data.task.status, "completed")
  assert.equal(completed.revision, 2)
  assert.equal((await run(projectRoot, "task", "show", "--task", "finished")).data.task.status, "completed")

  const archived = await run(projectRoot, "task", "archive", "--task", "finished")
  assert.equal(archived.data.archived, true)
  const absent = await runResult(projectRoot, "task", "show", "--task", "finished")
  assert.equal(absent.envelope.error.code, "TASK_NOT_FOUND")

  await run(projectRoot, "task", "create", "--task", "waiting", "--entry-stage", "research")
  const waiting = await run(
    projectRoot,
    "task", "await", "--task", "waiting", "--question", "Which compatibility mode?",
    "--blocker", "Requirements conflict", "--required-decision", "strict or permissive", "--expected-revision", "0",
  )
  assert.equal(waiting.data.task.status, "awaiting-user")
  const resumed = await run(projectRoot, "task", "resume", "--task", "waiting", "--expected-revision", "1")
  assert.equal(resumed.data.task.status, "active")
  const cancelled = await run(projectRoot, "task", "cancel", "--task", "waiting", "--reason", "No longer required", "--expected-revision", "2")
  assert.equal(cancelled.data.task.status, "cancelled")
})

test("dry-run is side-effect free and concurrent writers cannot silently overwrite", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "a.md"), "A\n")
  await writeFile(path.join(projectRoot, "b.md"), "B\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "concurrent", "--entry-stage", "research")

  const preview = await run(
    projectRoot,
    "context", "register", "--task", "concurrent", "--context", "preview",
    "--kind", "requirement", "--path", "a.md", "--profiles", "lead", "--expected-revision", "0", "--dry-run",
  )
  assert.equal(preview.data.dryRun, true)
  assert.equal(preview.revision, 1)
  assert.equal((await run(projectRoot, "task", "show", "--task", "concurrent")).revision, 0)
  assert.deepEqual((await run(projectRoot, "context", "list", "--task", "concurrent")).data.entries, [])

  const writes = await Promise.all([
    runResult(
      projectRoot,
      "context", "register", "--task", "concurrent", "--context", "a",
      "--kind", "requirement", "--path", "a.md", "--profiles", "lead", "--expected-revision", "0",
    ),
    runResult(
      projectRoot,
      "context", "register", "--task", "concurrent", "--context", "b",
      "--kind", "requirement", "--path", "b.md", "--profiles", "lead", "--expected-revision", "0",
    ),
  ])
  assert.equal(writes.filter(({ envelope }) => envelope.ok).length, 1)
  assert.equal(writes.filter(({ envelope }) => !envelope.ok).length, 1)
  assert.ok(["LOCK_UNAVAILABLE", "REVISION_CONFLICT"].includes(writes.find(({ envelope }) => !envelope.ok).envelope.error.code))
  assert.equal((await run(projectRoot, "context", "list", "--task", "concurrent")).data.entries.length, 1)
})

test("doctor diagnoses corrupt state and replays an interrupted write transaction", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "recoverable", "--entry-stage", "research")
  const taskRoot = path.join(projectRoot, ".team-work/tasks/recoverable")
  const taskPath = path.join(taskRoot, "task.json")
  const validTask = await readFile(taskPath, "utf8")
  await writeFile(path.join(taskRoot, ".txn/interrupted.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    taskId: "recoverable",
    writes: [{ path: "task.json", content: validTask }],
  }, null, 2)}\n`)
  await writeFile(taskPath, "{ interrupted\n")

  const diagnosed = await run(projectRoot, "doctor")
  assert.equal(diagnosed.data.healthy, false)
  assert.ok(diagnosed.data.issues.some(({ code }) => code === "PENDING_TRANSACTION"))
  assert.ok(diagnosed.data.issues.some(({ code }) => code === "STATE_CORRUPT"))

  const repaired = await run(projectRoot, "doctor", "--repair")
  assert.equal(repaired.data.healthy, true)
  assert.deepEqual(repaired.data.repaired, ["recoverable/interrupted.json"])
  assert.equal((await run(projectRoot, "task", "show", "--task", "recoverable")).data.task.status, "active")

  const staleLock = path.join(taskRoot, ".lock")
  await writeFile(staleLock, `${JSON.stringify({ pid: 99999999, acquiredAt: "2026-01-01T00:00:00.000Z" })}\n`)
  const stale = await run(projectRoot, "doctor")
  assert.ok(stale.data.issues.some(({ code }) => code === "STALE_LOCK"))
  const unlocked = await run(projectRoot, "doctor", "--repair")
  assert.equal(unlocked.data.healthy, true)
  assert.ok(unlocked.data.repaired.some((entry) => entry.endsWith("recoverable/.lock")))
  await writeFile(staleLock, "")
  const unknownOwner = await run(projectRoot, "doctor", "--repair")
  assert.equal(unknownOwner.data.healthy, false)
  assert.ok(unknownOwner.data.issues.some(({ code }) => code === "LOCK_OWNER_UNKNOWN"))
  assert.equal((await run(projectRoot, "doctor", "--repair", "--force")).data.healthy, true)
})

test("generated context view and audit events can be rebuilt from authoritative state", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "requirement.md"), "Build the runtime\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "audit", "--entry-stage", "research")
  await run(
    projectRoot,
    "context", "register", "--task", "audit", "--context", "requirement",
    "--kind", "requirement", "--path", "requirement.md", "--profiles", "lead,research",
    "--summary", "Runtime requirement", "--must-read", "--expected-revision", "0",
  )
  await run(
    projectRoot,
    "event", "record", "--task", "audit", "--type", "lead.note", "--actor", "lead",
    "--reason", "Research started", "--refs", "requirement", "--expected-revision", "1",
  )

  const events = await run(projectRoot, "event", "list", "--task", "audit")
  assert.deepEqual(events.data.events.map(({ type }) => type), ["context.registered", "lead.note"])
  const rebuilt = await run(projectRoot, "context", "rebuild", "--task", "audit", "--expected-revision", "1")
  assert.match(rebuilt.data.markdown, /requirement\.md/)
  assert.match(rebuilt.data.markdown, /Runtime requirement/)
  const index = await readFile(path.join(projectRoot, ".team-work/tasks/audit/index.md"), "utf8")
  assert.equal(index, rebuilt.data.markdown)

  const status = await run(projectRoot, "flow", "status", "--task", "audit")
  assert.equal(status.data.stage, "research")
  assert.equal(status.data.gate.ok, true)
})

test("current-stage work must be accepted or cancelled before flow can advance", async () => {
  const projectRoot = await project()
  await mkdir(path.join(projectRoot, "src"))
  await writeFile(path.join(projectRoot, "src/index.js"), "export const value = 1\n")
  await writeFile(path.join(projectRoot, "scope.md"), "Review src\n")
  await writeFile(path.join(projectRoot, "finding.md"), "pending\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "gated-work", "--entry-stage", "code-review")
  await run(projectRoot, "context", "register", "--task", "gated-work", "--context", "source", "--kind", "source", "--path", "src", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "gated-work", "--context", "scope", "--kind", "review-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "1")
  await run(projectRoot, "work", "create", "--task", "gated-work", "--work", "challenger", "--owner", "senior-terra", "--scope", "Challenge review", "--done-when", "Findings delivered", "--artifacts", "finding.md", "--expected-revision", "2")

  const blocked = await runResult(projectRoot, "flow", "check", "--task", "gated-work")
  assert.equal(blocked.envelope.error.code, "GATE_BLOCKED")
  assert.ok(blocked.envelope.error.blockers.some(({ code }) => code === "WORK_ITEM_PENDING"))

  await run(projectRoot, "work", "cancel", "--task", "gated-work", "--work", "challenger", "--reason", "Reassigned", "--expected-revision", "3")
  assert.equal((await run(projectRoot, "flow", "check", "--task", "gated-work")).data.gate.ok, true)
})

test("initialization is idempotent and never overwrites explicit project configuration", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.spec = { type: "openspec", skill: "openspec", root: "openspec/", mode: "required", status: "ready" }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const second = await run(projectRoot, "init")
  assert.equal(second.data.alreadyInitialized, true)
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).spec, config.spec)
  assert.equal((await run(projectRoot, "version")).data.apiVersion, "1.0")
  assert.equal((await run(projectRoot, "migrate")).data.migrated, false)
})

test("corrupt context, fake evidence, unknown stages and blocked terminal gates fail closed", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "proof.md"), "proof\n")
  await writeFile(path.join(projectRoot, "artifact.md"), "artifact\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "closed", "--entry-stage", "finish")
  await run(projectRoot, "flow", "decide", "--task", "closed", "--gate", "blocked-final", "--kind", "semantic", "--status", "blocked", "--blocker", "Expert rejected result", "--evidence", "proof", "--evidence-path", "proof.md", "--expected-revision", "0")
  const blockedComplete = await runResult(projectRoot, "task", "complete", "--task", "closed", "--actor", "lead", "--summary", "done", "--artifacts", "artifact.md", "--evidence", "proof", "--expected-revision", "1")
  assert.equal(blockedComplete.envelope.error.code, "GATE_BLOCKED")

  const unknownWork = await runResult(projectRoot, "work", "create", "--task", "closed", "--work", "bad-stage", "--stage", "unknown", "--owner", "junior", "--scope", "x", "--done-when", "x", "--artifacts", "artifact.md", "--expected-revision", "1")
  assert.equal(unknownWork.envelope.error.code, "INVALID_ARGUMENT")
  await run(projectRoot, "task", "cancel", "--task", "closed", "--reason", "stop", "--expected-revision", "1")
  const terminalWork = await runResult(projectRoot, "work", "create", "--task", "closed", "--work", "after-cancel", "--owner", "junior", "--scope", "x", "--done-when", "x", "--artifacts", "artifact.md", "--expected-revision", "2")
  assert.equal(terminalWork.envelope.error.code, "ILLEGAL_TRANSITION")

  await run(projectRoot, "task", "create", "--task", "forged-context", "--entry-stage", "code-review")
  const contextPath = path.join(projectRoot, ".team-work/tasks/forged-context/context.jsonl")
  await writeFile(contextPath, '{"kind":"source"}\n{"kind":"review-scope"}\n')
  const forged = await runResult(projectRoot, "flow", "check", "--task", "forged-context")
  assert.equal(forged.envelope.error.code, "STATE_CORRUPT")
  assert.ok((await run(projectRoot, "doctor")).data.issues.some(({ path: issuePath }) => issuePath.includes("forged-context")))
})

test("control roots and binding directories cannot escape through symlinks", async () => {
  const projectRoot = await project()
  const externalRoot = await project()
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "safe", "--entry-stage", "research")
  const externalState = path.join(externalRoot, "state")
  await rename(path.join(projectRoot, ".team-work"), externalState)
  await symlink(externalState, path.join(projectRoot, ".team-work"), "dir")
  assert.equal((await runResult(projectRoot, "task", "show", "--task", "safe")).envelope.error.code, "STATE_CORRUPT")

  const bindingProject = await project()
  const externalBindings = path.join(externalRoot, "bindings")
  await mkdir(externalBindings)
  await run(bindingProject, "init")
  await run(bindingProject, "task", "create", "--task", "safe", "--entry-stage", "research")
  await symlink(externalBindings, path.join(bindingProject, ".team-work/bindings/opencode"), "dir")
  assert.equal((await runResult(bindingProject, "task", "bind", "--task", "safe", "--platform", "opencode", "--session", "session")).envelope.error.code, "STATE_CORRUPT")
  assert.equal((await runResult(bindingProject, "doctor", "--repair")).envelope.error.code, "STATE_CORRUPT")

  const partialProject = await project()
  await mkdir(path.join(partialProject, ".team-work"))
  const externalWorkflows = path.join(externalRoot, "workflows")
  await mkdir(externalWorkflows)
  await symlink(externalWorkflows, path.join(partialProject, ".team-work/workflows"), "dir")
  assert.equal((await runResult(partialProject, "init")).envelope.error.code, "STATE_CORRUPT")
  await assert.rejects(readFile(path.join(externalWorkflows, "engineering.json")))
})
