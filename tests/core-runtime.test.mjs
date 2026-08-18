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
  await mkdir(path.join(projectRoot, "openspec/changes/policy-state"), { recursive: true })
  await writeFile(path.join(projectRoot, "openspec/changes/policy-state/spec.md"), "implementation spec\n")
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
    "--artifacts", "openspec/changes/policy-state/spec.md", "--expected-revision", "2",
  )
  assert.equal(completed.data.task.spec.status, "completed")
  assert.deepEqual(completed.data.task.spec.artifactRefs, ["openspec/changes/policy-state/spec.md"])
  assert.equal(completed.revision, 3)

  const missingArtifact = await runResult(
    projectRoot,
    "task", "spec", "--task", "policy-state", "--status", "completed",
    "--artifacts", "openspec/changes/policy-state/missing.md", "--expected-revision", "3",
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

test("OpenSpec lifecycle accepts only the task active change and blocks premature stage advancement", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.spec.status = "ready"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  await run(projectRoot, "task", "create", "--task", "safe-change", "--entry-stage", "spec")
  await run(
    projectRoot,
    "context", "register", "--task", "safe-change", "--context", "design",
    "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0",
  )

  const premature = await runResult(projectRoot, "flow", "advance", "--task", "safe-change", "--outcome", "pass", "--expected-revision", "1")
  assert.equal(premature.envelope.error.code, "GATE_BLOCKED")
  assert.ok(premature.envelope.error.blockers.some(({ code }) => code === "SPEC_LIFECYCLE_INCOMPLETE"))

  await mkdir(path.join(projectRoot, "openspec/changes/safe-change/specs/example"), { recursive: true })
  await writeFile(path.join(projectRoot, "openspec/changes/safe-change/proposal.md"), "proposal\n")
  await writeFile(path.join(projectRoot, "openspec/changes/safe-change/design.md"), "design\n")
  await writeFile(path.join(projectRoot, "openspec/changes/safe-change/tasks.md"), "tasks\n")
  await writeFile(path.join(projectRoot, "openspec/changes/safe-change/specs/example/spec.md"), "spec\n")

  const started = await run(projectRoot, "task", "spec", "--task", "safe-change", "--status", "in-progress", "--expected-revision", "1")
  const completed = await run(
    projectRoot,
    "task", "spec", "--task", "safe-change", "--status", "completed",
    "--artifacts", "openspec/changes/safe-change/proposal.md,openspec/changes/safe-change/design.md,openspec/changes/safe-change/tasks.md,openspec/changes/safe-change/specs/example/spec.md",
    "--expected-revision", String(started.revision),
  )
  assert.equal(completed.data.task.spec.status, "completed")
  assert.equal((await run(projectRoot, "flow", "advance", "--task", "safe-change", "--outcome", "pass", "--expected-revision", String(completed.revision))).data.to, "spec-review")
})

test("OpenSpec policy rejects canonical, archived, and foreign change paths from agent work", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.spec.status = "ready"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  await run(projectRoot, "task", "create", "--task", "path-policy", "--entry-stage", "implementation")

  for (const [workId, artifact] of [
    ["canonical", "openspec/specs/example/spec.md"],
    ["archived", "openspec/changes/archive/2026-08-01-old/specs/example/spec.md"],
    ["foreign", "openspec/changes/another-change/proposal.md"],
    ["wrong-stage", "openspec/changes/path-policy/proposal.md"],
  ]) {
    const result = await runResult(
      projectRoot,
      "work", "create", "--task", "path-policy", "--work", workId,
      "--owner", "junior-luna", "--scope", "invalid OpenSpec write", "--done-when", "written",
      "--artifacts", artifact, "--expected-revision", "0",
    )
    assert.equal(result.envelope.error.code, "GATE_BLOCKED")
    assert.ok(result.envelope.error.blockers.some(({ code }) => ["OPENSPEC_PATH_FORBIDDEN", "OPENSPEC_STAGE_FORBIDDEN"].includes(code)))
  }

  const taskList = await run(
    projectRoot,
    "work", "create", "--task", "path-policy", "--work", "task-progress",
    "--owner", "junior-luna", "--scope", "record implementation progress", "--done-when", "updated",
    "--artifacts", "openspec/changes/path-policy/tasks.md", "--expected-revision", "0",
  )
  assert.equal(taskList.data.workItem.assignment.artifactPaths[0], "openspec/changes/path-policy/tasks.md")

  await run(projectRoot, "task", "create", "--task", "test-stage-policy", "--entry-stage", "test")
  const testStageWrite = await runResult(
    projectRoot,
    "work", "create", "--task", "test-stage-policy", "--work", "task-progress",
    "--owner", "junior-luna", "--scope", "wrong stage task progress", "--done-when", "updated",
    "--artifacts", "openspec/changes/test-stage-policy/tasks.md", "--expected-revision", "0",
  )
  assert.equal(testStageWrite.envelope.error.blockers[0].code, "OPENSPEC_STAGE_FORBIDDEN")
})

test("user registers minimal context and checks only the current stage gate", async () => {
  const projectRoot = await project()
  await mkdir(path.join(projectRoot, "src"))
  await writeFile(path.join(projectRoot, "src/index.js"), "export const answer = 42\n")
  await writeFile(path.join(projectRoot, "review-scope.md"), "Review src/index.js\n")
  await writeFile(path.join(projectRoot, "review.md"), "E2E applicability reviewed\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "review", "--entry-stage", "code-review")

  const initiallyBlocked = await runResult(projectRoot, "flow", "check", "--task", "review")
  assert.equal(initiallyBlocked.exitCode, 4)
  assert.equal(initiallyBlocked.envelope.error.code, "GATE_BLOCKED")
  assert.deepEqual(initiallyBlocked.envelope.error.blockers.map(({ kind }) => kind), ["source", "review-scope", "semantic"])

  const source = await run(
    projectRoot,
    "context", "register", "--task", "review", "--context", "source-code",
    "--kind", "source", "--path", "src", "--profiles", "lead,check", "--priority", "100", "--must-read",
    "--expected-revision", "0",
  )
  assert.equal(source.revision, 1)

  const stillBlocked = await runResult(projectRoot, "flow", "check", "--task", "review")
  assert.deepEqual(stillBlocked.envelope.error.blockers.map(({ kind }) => kind), ["review-scope", "semantic"])

  const scope = await run(
    projectRoot,
    "context", "register", "--task", "review", "--context", "scope",
    "--kind", "review-scope", "--path", "review-scope.md", "--profiles", "lead,check",
    "--priority", "90", "--expected-revision", "1",
  )
  assert.equal(scope.revision, 2)

  assert.deepEqual((await runResult(projectRoot, "flow", "check", "--task", "review")).envelope.error.blockers.map(({ kind }) => kind), ["semantic"])
  await run(
    projectRoot,
    "flow", "decide", "--task", "review", "--gate", "e2e-applicability", "--kind", "semantic",
    "--status", "passed", "--reason", "E2E applies", "--actor", "lead",
    "--evidence", "review-proof", "--evidence-path", "review.md", "--expected-revision", "2",
  )
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
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.humanReview["design-approval"] = "disabled"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

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
  assert.equal((await run(projectRoot, "task", "show", "--task", "e2e-loop")).data.task.stageRun, 1)
  await run(projectRoot, "context", "register", "--task", "e2e-loop", "--context", "source", "--kind", "source", "--path", "source.md", "--profiles", "lead,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "e2e-loop", "--context", "test-scope", "--kind", "test-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "1")
  const reworked = await run(projectRoot, "flow", "advance", "--task", "e2e-loop", "--outcome", "rework", "--expected-revision", "2")
  assert.equal(reworked.data.from, "e2e")
  assert.equal(reworked.data.to, "e2e")
  assert.equal(reworked.data.task.stageRun, 2)
  assert.equal(reworked.data.task.stageRunRequiresWork, true)
  const emptyRework = await runResult(projectRoot, "flow", "check", "--task", "e2e-loop")
  assert.equal(emptyRework.envelope.error.code, "GATE_BLOCKED")
  assert.ok(emptyRework.envelope.error.blockers.some(({ code }) => code === "STAGE_RUN_DELIVERY_REQUIRED"))
})

test("rollback keeps accepted history but requires a fresh delivery when the stage is revisited", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "source.md"), "source\n")
  await writeFile(path.join(projectRoot, "scope.md"), "scope\n")
  await writeFile(path.join(projectRoot, "old-e2e.md"), "old E2E delivery\n")
  await writeFile(path.join(projectRoot, "implementation.md"), "corrected implementation\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "rollback-runs", "--entry-stage", "e2e")
  await run(projectRoot, "context", "register", "--task", "rollback-runs", "--context", "source", "--kind", "source", "--path", "source.md", "--profiles", "lead,implement,check", "--expected-revision", "0")
  await run(projectRoot, "context", "register", "--task", "rollback-runs", "--context", "test-scope", "--kind", "test-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "1")
  await run(projectRoot, "context", "register", "--task", "rollback-runs", "--context", "review-scope", "--kind", "review-scope", "--path", "scope.md", "--profiles", "lead,check", "--expected-revision", "2")
  await run(projectRoot, "context", "register", "--task", "rollback-runs", "--context", "requirement", "--kind", "requirement", "--path", "scope.md", "--profiles", "lead,implement,check", "--expected-revision", "3")

  await run(projectRoot, "work", "create", "--task", "rollback-runs", "--work", "old-e2e", "--owner", "senior-terra", "--scope", "Original E2E", "--done-when", "E2E delivered", "--artifacts", "old-e2e.md", "--expected-revision", "4")
  await run(projectRoot, "work", "start", "--task", "rollback-runs", "--work", "old-e2e", "--expected-revision", "5")
  await run(projectRoot, "work", "submit", "--task", "rollback-runs", "--work", "old-e2e", "--scenario", "e2e", "--scope-refs", "source.md", "--outcome", "pass", "--artifacts", "old-e2e.md", "--summary", "Original E2E passed", "--expected-revision", "6")
  await run(projectRoot, "flow", "decide", "--task", "rollback-runs", "--gate", "work-old-e2e", "--kind", "semantic", "--status", "passed", "--actor", "expert", "--reason", "Original evidence accepted", "--evidence", "old-e2e-proof", "--evidence-path", "old-e2e.md", "--expected-revision", "7")
  await run(projectRoot, "work", "accept", "--task", "rollback-runs", "--work", "old-e2e", "--actor", "lead", "--evidence", "old-e2e-proof", "--expected-revision", "8")

  const rolledBack = await run(projectRoot, "flow", "rollback", "--task", "rollback-runs", "--to", "implementation", "--reason", "Product defect requires implementation repair", "--evidence", "old-e2e-proof", "--expected-revision", "9")
  assert.equal(rolledBack.data.task.stageRun, 2)
  assert.equal(rolledBack.data.task.stageRunRequiresWork, true)

  await run(projectRoot, "work", "create", "--task", "rollback-runs", "--work", "implementation-fix", "--owner", "senior-terra", "--scope", "Fix product defect", "--done-when", "Implementation delivered", "--artifacts", "implementation.md", "--expected-revision", "10")
  await run(projectRoot, "work", "start", "--task", "rollback-runs", "--work", "implementation-fix", "--expected-revision", "11")
  await run(projectRoot, "work", "submit", "--task", "rollback-runs", "--work", "implementation-fix", "--scenario", "implementation", "--scope-refs", "source.md", "--outcome", "pass", "--artifacts", "implementation.md", "--summary", "Implementation corrected", "--expected-revision", "12")
  await run(projectRoot, "flow", "decide", "--task", "rollback-runs", "--gate", "work-implementation-fix", "--kind", "semantic", "--status", "passed", "--actor", "expert", "--reason", "Correction accepted", "--evidence", "implementation-proof", "--evidence-path", "implementation.md", "--expected-revision", "13")
  await run(projectRoot, "work", "accept", "--task", "rollback-runs", "--work", "implementation-fix", "--actor", "lead", "--evidence", "implementation-proof", "--expected-revision", "14")
  await run(projectRoot, "flow", "advance", "--task", "rollback-runs", "--outcome", "pass", "--expected-revision", "15")
  await run(projectRoot, "flow", "advance", "--task", "rollback-runs", "--outcome", "pass", "--expected-revision", "16")
  await run(projectRoot, "flow", "decide", "--task", "rollback-runs", "--gate", "e2e-applicability", "--kind", "semantic", "--status", "passed", "--actor", "lead", "--reason", "E2E remains applicable", "--evidence", "e2e-route-proof", "--evidence-path", "scope.md", "--expected-revision", "17")
  const revisited = await run(projectRoot, "flow", "advance", "--task", "rollback-runs", "--outcome", "pass", "--expected-revision", "18")
  assert.equal(revisited.data.task.stage, "e2e")
  assert.equal(revisited.data.task.stageRun, 5)
  assert.equal(revisited.data.task.stageRunRequiresWork, true)

  const blocked = await runResult(projectRoot, "flow", "check", "--task", "rollback-runs")
  assert.equal(blocked.envelope.error.code, "GATE_BLOCKED")
  assert.ok(blocked.envelope.error.blockers.some(({ code }) => code === "STAGE_RUN_DELIVERY_REQUIRED"))
  assert.ok(!blocked.envelope.error.blockers.some(({ code }) => code === "INVALID_ACCEPTANCE_EVIDENCE"))
  assert.ok(!blocked.envelope.error.blockers.some(({ code, path: blockerPath }) => code === "GATE_NOT_PASSED" && blockerPath === "work-old-e2e"))
})

test("a previously visited stage reopens even when its first visit produced no evidence", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "requirement.md"), "requirement\n")
  await writeFile(path.join(projectRoot, "research.md"), "research rerun\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "history-revisit", "--entry-stage", "research")
  await run(projectRoot, "context", "register", "--task", "history-revisit", "--context", "requirement", "--kind", "requirement", "--path", "requirement.md", "--profiles", "lead,research,implement,check", "--expected-revision", "0")
  await run(projectRoot, "flow", "decide", "--task", "history-revisit", "--gate", "research-baseline", "--kind", "semantic", "--status", "passed", "--actor", "senior-terra", "--reason", "Initial research context checked", "--evidence", "research-baseline-proof", "--evidence-path", "requirement.md", "--expected-revision", "1")
  await run(projectRoot, "flow", "advance", "--task", "history-revisit", "--outcome", "pass", "--expected-revision", "2")
  await run(projectRoot, "flow", "rollback", "--task", "history-revisit", "--to", "research", "--reason", "Research assumptions changed", "--evidence", "research-baseline-proof", "--expected-revision", "3")
  await run(projectRoot, "work", "create", "--task", "history-revisit", "--work", "research-rerun", "--owner", "junior-luna", "--scope", "Repeat research", "--done-when", "Research updated", "--artifacts", "research.md", "--expected-revision", "4")
  await run(projectRoot, "work", "start", "--task", "history-revisit", "--work", "research-rerun", "--expected-revision", "5")
  await run(projectRoot, "work", "submit", "--task", "history-revisit", "--work", "research-rerun", "--scenario", "research", "--scope-refs", "requirement.md", "--outcome", "pass", "--artifacts", "research.md", "--summary", "Research refreshed", "--expected-revision", "6")
  await run(projectRoot, "flow", "decide", "--task", "history-revisit", "--gate", "work-research-rerun", "--kind", "semantic", "--status", "passed", "--actor", "senior-terra", "--reason", "Research checked", "--evidence", "research-rerun-proof", "--evidence-path", "research.md", "--expected-revision", "7")
  await run(projectRoot, "work", "accept", "--task", "history-revisit", "--work", "research-rerun", "--actor", "lead", "--evidence", "research-rerun-proof", "--expected-revision", "8")
  const revisited = await run(projectRoot, "flow", "advance", "--task", "history-revisit", "--outcome", "pass", "--expected-revision", "9")
  assert.equal(revisited.data.task.stage, "design")
  assert.equal(revisited.data.task.stageRunRequiresWork, true)
})

test("design cannot advance until an awaited user approves the current design artifact", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "design.md"), "Approved implementation design\n")
  await writeFile(path.join(projectRoot, "requirement.md"), "Implement approved behavior\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "design-human-review", "--entry-stage", "design-review")
  await run(projectRoot, "context", "register", "--task", "design-human-review", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")

  const unapproved = await runResult(projectRoot, "flow", "advance", "--task", "design-human-review", "--outcome", "skip", "--expected-revision", "1")
  assert.equal(unapproved.envelope.error.code, "GATE_BLOCKED")
  assert.ok(unapproved.envelope.error.blockers.some(({ gateId }) => gateId === "design-approval"))

  const waiting = await run(
    projectRoot,
    "task", "await", "--task", "design-human-review", "--gate", "design-approval",
    "--evidence-path", "design.md",
    "--question", "是否批准当前方案并进入实施？", "--blocker", "方案尚未获得人工批准",
    "--required-decision", "批准或提出修改意见", "--expected-revision", "1",
  )
  assert.equal(waiting.data.task.status, "awaiting-user")
  assert.deepEqual(waiting.data.task.gates.find(({ gateId }) => gateId === "design-approval"), {
    gateId: "design-approval", stage: "design-review", stageRun: 1, kind: "human", status: "pending", evidenceRefs: [],
  })
  assert.equal(
    (await runResult(projectRoot, "task", "resume", "--task", "design-human-review", "--expected-revision", "2")).envelope.error.code,
    "HUMAN_DECISION_REQUIRED",
  )

  const forged = await runResult(
    projectRoot,
    "flow", "decide", "--task", "design-human-review", "--gate", "design-approval", "--kind", "human",
    "--status", "passed", "--reason", "Lead claims approval", "--actor", "lead",
    "--evidence", "design-approval-proof", "--evidence-path", "design.md", "--expected-revision", "2",
  )
  assert.equal(forged.envelope.error.code, "HUMAN_DECISION_REQUIRED")

  const wrongArtifact = await runResult(
    projectRoot,
    "flow", "decide", "--task", "design-human-review", "--gate", "design-approval", "--kind", "human",
    "--status", "passed", "--reason", "用户只看到了另一份文件", "--actor", "user",
    "--evidence", "wrong-design-proof", "--evidence-path", "requirement.md", "--expected-revision", "2",
  )
  assert.equal(wrongArtifact.envelope.error.code, "HUMAN_DECISION_REQUIRED")

  const approved = await run(
    projectRoot,
    "flow", "decide", "--task", "design-human-review", "--gate", "design-approval", "--kind", "human",
    "--status", "passed", "--reason", "用户确认方案完整且符合预期", "--actor", "user",
    "--evidence", "design-approval-proof", "--evidence-path", "design.md", "--expected-revision", "2",
  )
  assert.equal(approved.data.gate.kind, "human")
  assert.equal(approved.data.task.status, "active")
  assert.match(approved.data.evidence.digest, /^sha256:[a-f0-9]{64}$/)

  await writeFile(path.join(projectRoot, "design.md"), "Changed after approval\n")
  const staleStatus = await run(projectRoot, "flow", "status", "--task", "design-human-review")
  assert.ok(staleStatus.data.gate.blockers.some(({ code }) => code === "EVIDENCE_CHANGED"))
  const staleCheck = await runResult(projectRoot, "flow", "check", "--task", "design-human-review")
  assert.ok(staleCheck.envelope.error.blockers.some(({ code }) => code === "EVIDENCE_CHANGED"))
  const stale = await runResult(projectRoot, "flow", "advance", "--task", "design-human-review", "--outcome", "skip", "--expected-revision", "3")
  assert.equal(stale.envelope.error.code, "GATE_BLOCKED")
  assert.ok(stale.envelope.error.blockers.some(({ code }) => code === "EVIDENCE_CHANGED"))

  await run(
    projectRoot,
    "task", "await", "--task", "design-human-review", "--gate", "design-approval",
    "--evidence-path", "design.md",
    "--question", "方案已变化，是否重新批准？", "--blocker", "批准后的方案内容发生变化",
    "--required-decision", "重新批准或提出修改意见", "--expected-revision", "3",
  )
  await run(
    projectRoot,
    "flow", "decide", "--task", "design-human-review", "--gate", "design-approval", "--kind", "human",
    "--status", "passed", "--reason", "用户重新批准更新后的方案", "--actor", "user",
    "--evidence", "design-approval-proof-v2", "--evidence-path", "design.md", "--expected-revision", "4",
  )

  const advanced = await run(projectRoot, "flow", "advance", "--task", "design-human-review", "--outcome", "skip", "--expected-revision", "5")
  assert.equal(advanced.data.to, "implementation")
  await run(projectRoot, "context", "register", "--task", "design-human-review", "--context", "requirement", "--kind", "requirement", "--path", "requirement.md", "--profiles", "lead,implement", "--expected-revision", "6")
  await writeFile(path.join(projectRoot, "design.md"), "Changed after implementation started\n")
  const laterStale = await runResult(projectRoot, "flow", "advance", "--task", "design-human-review", "--outcome", "pass", "--expected-revision", "7")
  assert.ok(laterStale.envelope.error.blockers.some(({ code, gateId }) => code === "EVIDENCE_CHANGED" && gateId === "design-approval"))
})

test("Runtime resolves an awaited human decision from stored gate and evidence", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "runtime-human", "--entry-stage", "design-review")
  await run(
    projectRoot,
    "task", "await", "--task", "runtime-human", "--gate", "design-approval",
    "--evidence-path", "design.md", "--question", "是否批准？", "--blocker", "等待确认",
    "--required-decision", "批准或驳回", "--expected-revision", "0",
  )

  const resolved = await run(
    projectRoot,
    "flow", "human", "--task", "runtime-human", "--status", "passed",
    "--reason", "用户明确批准", "--actor", "user", "--evidence", "human-approved",
    "--expected-revision", "1",
  )

  assert.equal(resolved.data.gate.gateId, "design-approval")
  assert.equal(resolved.data.evidence.path, "design.md")
  assert.equal(resolved.data.task.status, "active")
})

test("optional human review may be skipped but an explicit rejection routes to rework", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "design.md"), "Design awaiting feedback\n")
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.humanReview["design-approval"] = "optional"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  await run(projectRoot, "task", "create", "--task", "optional-review", "--entry-stage", "design-review")
  await run(projectRoot, "context", "register", "--task", "optional-review", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")
  assert.equal((await run(projectRoot, "flow", "advance", "--task", "optional-review", "--outcome", "skip", "--expected-revision", "1")).data.to, "implementation")

  await run(projectRoot, "task", "create", "--task", "rejected-review", "--entry-stage", "design-review")
  await run(projectRoot, "context", "register", "--task", "rejected-review", "--context", "design", "--kind", "design", "--path", "design.md", "--profiles", "lead,check", "--expected-revision", "0")
  await run(
    projectRoot,
    "task", "await", "--task", "rejected-review", "--gate", "design-approval",
    "--evidence-path", "design.md",
    "--question", "是否批准方案？", "--blocker", "等待人工审核", "--required-decision", "批准或返工", "--expected-revision", "1",
  )
  await run(
    projectRoot,
    "flow", "decide", "--task", "rejected-review", "--gate", "design-approval", "--kind", "human",
    "--status", "rejected", "--reason", "用户要求补齐兼容性设计", "--actor", "user",
    "--evidence", "design-rejection", "--evidence-path", "design.md", "--expected-revision", "2",
  )
  assert.equal((await runResult(projectRoot, "flow", "advance", "--task", "rejected-review", "--outcome", "skip", "--expected-revision", "3")).envelope.error.code, "GATE_BLOCKED")
  assert.equal((await run(projectRoot, "flow", "advance", "--task", "rejected-review", "--outcome", "rework", "--expected-revision", "3")).data.to, "design")
})

test("disabled final human review does not replace normal task evidence", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "final.md"), "Delivery evidence\n")
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.humanReview["final-acceptance"] = "disabled"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  await run(projectRoot, "task", "create", "--task", "disabled-final-review", "--entry-stage", "finish")
  await run(
    projectRoot,
    "flow", "decide", "--task", "disabled-final-review", "--gate", "delivery-evidence", "--kind", "semantic",
    "--status", "passed", "--reason", "交付证据完整", "--actor", "lead",
    "--evidence", "delivery-proof", "--evidence-path", "final.md", "--expected-revision", "0",
  )
  const completed = await run(
    projectRoot,
    "task", "complete", "--task", "disabled-final-review", "--summary", "Task accepted", "--actor", "lead",
    "--artifacts", "final.md", "--evidence", "delivery-proof", "--expected-revision", "1",
  )
  assert.equal(completed.data.task.status, "completed")
})

test("rejected final acceptance returns work to the user-selected responsible stage", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "final.md"), "Delivery needs another iteration\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "final-rework", "--entry-stage", "finish")
  await run(
    projectRoot,
    "task", "await", "--task", "final-rework", "--gate", "final-acceptance",
    "--evidence-path", "final.md",
    "--question", "是否接受当前交付？", "--blocker", "等待最终人工验收",
    "--required-decision", "通过或指定返工方向", "--expected-revision", "0",
  )
  await run(
    projectRoot,
    "flow", "decide", "--task", "final-rework", "--gate", "final-acceptance", "--kind", "human",
    "--status", "rejected", "--reason", "用户要求优化错误恢复", "--actor", "user",
    "--evidence", "final-rejection", "--evidence-path", "final.md", "--expected-revision", "1",
  )
  const rolledBack = await run(
    projectRoot,
    "flow", "rollback", "--task", "final-rework", "--to", "implementation",
    "--reason", "最终验收要求修改实现", "--evidence", "final-rejection", "--expected-revision", "2",
  )
  assert.equal(rolledBack.data.to, "implementation")
  assert.equal(rolledBack.data.task.gates.find(({ gateId }) => gateId === "final-acceptance").status, "pending")
  assert.equal(rolledBack.data.task.evidence.find(({ evidenceId }) => evidenceId === "final-rejection").status, "invalidated")
})

test("concurrent human decisions cannot silently overwrite each other", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "final.md"), "Concurrent decision evidence\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "human-decision-race", "--entry-stage", "finish")
  await run(
    projectRoot,
    "task", "await", "--task", "human-decision-race", "--gate", "final-acceptance",
    "--evidence-path", "final.md",
    "--question", "是否接受？", "--blocker", "等待用户", "--required-decision", "通过或驳回", "--expected-revision", "0",
  )

  const decisions = await Promise.all([
    runResult(
      projectRoot,
      "flow", "decide", "--task", "human-decision-race", "--gate", "final-acceptance", "--kind", "human",
      "--status", "passed", "--reason", "用户通过", "--actor", "user",
      "--evidence", "human-pass", "--evidence-path", "final.md", "--expected-revision", "1",
    ),
    runResult(
      projectRoot,
      "flow", "decide", "--task", "human-decision-race", "--gate", "final-acceptance", "--kind", "human",
      "--status", "rejected", "--reason", "用户驳回", "--actor", "user",
      "--evidence", "human-reject", "--evidence-path", "final.md", "--expected-revision", "1",
    ),
  ])

  assert.equal(decisions.filter(({ exitCode }) => exitCode === 0).length, 1)
  assert.equal(decisions.filter(({ envelope }) => ["REVISION_CONFLICT", "LOCK_UNAVAILABLE"].includes(envelope.error?.code)).length, 1)
  const task = (await run(projectRoot, "task", "show", "--task", "human-decision-race")).data.task
  assert.equal(task.status, "active")
  assert.equal(task.gates.filter(({ gateId }) => gateId === "final-acceptance").length, 1)
})

test("SPEC routing mode cannot be bypassed through direct flow commands", async () => {
  const requiredRoot = await project()
  await writeFile(path.join(requiredRoot, "design.md"), "approved design\n")
  await run(requiredRoot, "init")
  const requiredConfigPath = path.join(requiredRoot, ".team-work/config.yaml")
  const requiredConfig = JSON.parse(await readFile(requiredConfigPath, "utf8"))
  requiredConfig.spec = { ...requiredConfig.spec, mode: "required", status: "missing" }
  requiredConfig.humanReview["design-approval"] = "disabled"
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
  readyConfig.humanReview["design-approval"] = "disabled"
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

  const premature = await runResult(
    projectRoot,
    "task", "complete", "--task", "finished", "--summary", "Task accepted", "--actor", "lead",
    "--artifacts", "final.md", "--evidence", "final-proof", "--expected-revision", "0",
  )
  assert.equal(premature.envelope.error.code, "GATE_BLOCKED")

  await run(
    projectRoot,
    "task", "await", "--task", "finished", "--gate", "final-acceptance",
    "--evidence-path", "final.md",
    "--question", "是否接受当前交付并完成任务？", "--blocker", "最终交付尚未人工验收",
    "--required-decision", "通过或提出返工方向", "--expected-revision", "0",
  )
  await run(
    projectRoot,
    "flow", "decide", "--task", "finished", "--gate", "final-acceptance", "--kind", "human",
    "--status", "passed", "--reason", "用户接受最终交付", "--actor", "user",
    "--evidence", "final-proof", "--evidence-path", "final.md", "--expected-revision", "1",
  )
  const completed = await run(
    projectRoot,
    "task", "complete", "--task", "finished", "--summary", "Task accepted", "--actor", "lead",
    "--artifacts", "final.md", "--evidence", "final-proof", "--expected-revision", "2",
  )
  assert.equal(completed.data.task.status, "completed")
  assert.equal(completed.revision, 3)
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

test("completed tasks fail closed when final human acceptance is missing or stale", async () => {
  const projectRoot = await project()
  await writeFile(path.join(projectRoot, "final.md"), "Accepted delivery\n")
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "tampered-final", "--entry-stage", "finish")
  await run(
    projectRoot,
    "task", "await", "--task", "tampered-final", "--gate", "final-acceptance", "--evidence-path", "final.md",
    "--question", "是否接受？", "--blocker", "等待最终验收", "--required-decision", "通过或驳回", "--expected-revision", "0",
  )
  await run(
    projectRoot,
    "flow", "decide", "--task", "tampered-final", "--gate", "final-acceptance", "--kind", "human",
    "--status", "passed", "--reason", "用户接受交付", "--actor", "user",
    "--evidence", "final-proof", "--evidence-path", "final.md", "--expected-revision", "1",
  )
  await run(
    projectRoot,
    "task", "complete", "--task", "tampered-final", "--summary", "Accepted", "--actor", "lead",
    "--artifacts", "final.md", "--evidence", "final-proof", "--expected-revision", "2",
  )

  const taskPath = path.join(projectRoot, ".team-work/tasks/tampered-final/task.json")
  const completedTask = JSON.parse(await readFile(taskPath, "utf8"))
  await writeFile(taskPath, `${JSON.stringify({ ...completedTask, gates: [] }, null, 2)}\n`)
  assert.equal((await runResult(projectRoot, "task", "show", "--task", "tampered-final")).envelope.error.code, "STATE_CORRUPT")

  await writeFile(taskPath, `${JSON.stringify(completedTask, null, 2)}\n`)
  await writeFile(path.join(projectRoot, "final.md"), "Changed after completion\n")
  assert.equal((await runResult(projectRoot, "task", "archive", "--task", "tampered-final")).envelope.error.code, "STATE_CORRUPT")
  const diagnosis = await run(projectRoot, "doctor")
  assert.equal(diagnosis.data.healthy, false)
  assert.ok(diagnosis.data.issues.some(({ code }) => code === "STATE_CORRUPT"))
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

test("migrate upgrades pre-stage-run task state idempotently", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "legacy-state", "--entry-stage", "implementation")
  const taskPath = path.join(projectRoot, ".team-work/tasks/legacy-state/task.json")
  const workItemsPath = path.join(projectRoot, ".team-work/tasks/legacy-state/work-items.json")
  const task = JSON.parse(await readFile(taskPath, "utf8"))
  task.schemaVersion = "1.0"
  delete task.stageRun
  delete task.stageRunRequiresWork
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`)
  const workItems = JSON.parse(await readFile(workItemsPath, "utf8"))
  workItems.schemaVersion = "1.0"
  await writeFile(workItemsPath, `${JSON.stringify(workItems, null, 2)}\n`)

  const first = await run(projectRoot, "migrate")
  assert.equal(first.data.migrated, true)
  assert.equal(first.data.tasks, 1)
  assert.equal(JSON.parse(await readFile(taskPath, "utf8")).stageRun, 1)
  assert.equal(JSON.parse(await readFile(workItemsPath, "utf8")).items.length, 0)

  const second = await run(projectRoot, "migrate")
  assert.equal(second.data.migrated, false)
  assert.equal(second.data.tasks, 0)
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
  await run(
    projectRoot,
    "flow", "decide", "--task", "gated-work", "--gate", "e2e-applicability", "--kind", "semantic",
    "--status", "passed", "--reason", "E2E applicability recorded", "--actor", "lead",
    "--evidence", "e2e-decision", "--evidence-path", "finding.md", "--expected-revision", "4",
  )
  assert.equal((await run(projectRoot, "flow", "check", "--task", "gated-work")).data.gate.ok, true)
})

test("work assignment may declare output paths before the worker creates them", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  await run(projectRoot, "task", "create", "--task", "planned-output", "--entry-stage", "implementation")
  const created = await run(
    projectRoot,
    "work", "create", "--task", "planned-output", "--work", "owner-delivery",
    "--owner", "junior-luna", "--scope", "Implement the change", "--done-when", "Code is ready",
    "--artifacts", ".team-work/tasks/planned-output/artifacts/implementation.md", "--expected-revision", "0",
  )
  assert.equal(created.data.workItem.assignment.artifactPaths[0], ".team-work/tasks/planned-output/artifacts/implementation.md")
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

test("project SPEC readiness updates are locked and preserve unrelated configuration", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  const [left, right] = await Promise.all([
    runResult(projectRoot, "project", "spec", "--mode", "auto", "--status", "ready"),
    runResult(projectRoot, "project", "spec", "--mode", "required", "--status", "ready"),
  ])
  assert.ok([left, right].some(({ exitCode }) => exitCode === 0))
  assert.ok([left, right].every(({ envelope }) => envelope.ok || envelope.error.code === "LOCK_UNAVAILABLE"))
  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.ok(["auto", "required"].includes(config.spec.mode))
  assert.equal(config.spec.status, "ready")
  assert.deepEqual(config.humanReview, { "design-approval": "required", "final-acceptance": "required" })
})

test("project human-review configuration rejects unknown gates", async () => {
  const projectRoot = await project()
  await run(projectRoot, "init")
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.humanReview = { "unknown-review": "required" }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const result = await runResult(projectRoot, "task", "create", "--task", "invalid-review-config", "--entry-stage", "research")
  assert.equal(result.envelope.error.code, "STATE_CORRUPT")
  assert.ok(result.envelope.error.blockers.some(({ message }) => /unknown human review gate/.test(message)))
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
