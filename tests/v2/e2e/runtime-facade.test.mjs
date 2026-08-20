import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createRuntimeFacade } from "../../../runtime/application/runtime-facade.mjs"
import { digestValue } from "../../../runtime/domain/digests.mjs"
import { createInMemoryStore } from "../../../runtime/persistence/in-memory-store.mjs"
import {
  createFakeExecutionAdapter,
  createFakeSpecProvider,
  createInMemoryArtifactRepository,
} from "../../../runtime/testing/fakes.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"))
}

function report(summary, artifacts = [], evidenceRefs = []) {
  return {
    outcome: "delivered",
    summary,
    artifacts,
    evidenceRefs,
    recommendation: "accept",
  }
}

function output(ref, path) {
  return { ref, path }
}

test("a through-stage delivery closes through LeadControl and bound member delivery only", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({
    "requirements/change.md": "Implement a small, backwards-compatible feature.",
  })
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-18T10:00:00.000Z" })
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    clock: () => "2026-08-18T10:00:00.000Z",
  })

  const cards = []
  cards.push(await runtime.leadControl.open({
    title: "Implement the focused change",
    objective: "Implement and independently review the requested behavior",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{
      kind: "requirement",
      locator: { type: "project-path", value: "requirements/change.md" },
    }, {
      kind: "reference",
      locator: { type: "external-uri", value: "https://example.test/runtime-contract" },
    }],
  }))
  assert.equal(cards.at(-1).next.kind, "plan")
  assert.equal((await store.loadTask(cards[0].task.id)).evidence.some(({ kind }) => kind === "external-fact"), true)
  assert.deepEqual(await runtime.leadControl.open({
    title: "Implement the focused change",
    objective: "Implement and independently review the requested behavior",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{
      kind: "requirement",
      locator: { type: "project-path", value: "requirements/change.md" },
    }, {
      kind: "reference",
      locator: { type: "external-uri", value: "https://example.test/runtime-contract" },
    }],
  }), cards.at(-1))

  cards.push(await runtime.leadControl.plan({ objective: "Implement the requested behavior safely" }))
  assert.equal(cards.at(-1).report.team.mode, "solo")
  assert.equal(cards.at(-1).report.team.owners, 1)
  assert.equal(cards.at(-1).next.kind, "wait")
  let members = execution.activeMembers()
  const owner = members.find(({ role }) => role === "owner")
  assert.ok(owner)
  artifacts.write("src/feature.mjs", "export const feature = true\n", { assignmentId: owner.assignmentId })
  artifacts.write(".team-work/checks/focused-feature-test.txt", "focused feature test passed\n")
  const check = {
    kind: "check",
    observationId: "check-feature-1",
    dedupeKey: "check-feature-1",
    toolCallRef: "focused-feature-test",
    commandSummary: "run focused feature test",
    result: "pass",
    outputRef: ".team-work/checks/focused-feature-test.txt",
    outputDigest: digestValue("focused feature test passed\n"),
    observedAt: "2026-08-18T10:00:00.000Z",
  }
  assert.equal((await owner.observe(check)).duplicate, false)
  assert.equal((await owner.observe(check)).duplicate, true)
  const ownerReceipt = await owner.report(report(
    "Implemented the focused change and checked its boundary.",
    [output("artifact:source", "src/feature.mjs")],
    ["check:focused-feature-test"],
  ))

  cards.push(await runtime.leadControl.run())
  assert.equal(cards.at(-1).next.kind, "wait")
  members = execution.activeMembers()
  const challenger = members.find(({ role }) => role === "challenger")
  assert.ok(challenger)
  assert.notEqual(challenger.executionRef, owner.executionRef)
  const challengerReceipt = await challenger.report(report(
    "Independent challenge found no remaining blocker.",
    [],
    [`report:${ownerReceipt.reportId}`],
  ))

  cards.push(await runtime.leadControl.run())
  members = execution.activeMembers()
  const ownerResponse = members.find(({ assignmentId }) => assignmentId.startsWith("owner-response-"))
  assert.ok(ownerResponse)
  assert.equal(ownerResponse.executionRef, owner.executionRef)
  await ownerResponse.report(report(
    "Owner cited its own delivery instead of the independent review.",
    [],
    [`report:${ownerReceipt.reportId}`],
  ))

  cards.push(await runtime.leadControl.run())
  const retriedOwnerResponse = execution.activeMembers().find(({ assignmentId }) => assignmentId === ownerResponse.assignmentId)
  assert.ok(retriedOwnerResponse)
  assert.equal(retriedOwnerResponse.executionRef, owner.executionRef)
  await retriedOwnerResponse.report(report(
    "Owner independently verified and accepts the challenge conclusion.",
    [],
    [`report:${challengerReceipt.reportId}`],
  ))

  cards.push(await runtime.leadControl.run())
  assert.equal(cards.at(-1).task.status, "awaiting-user", JSON.stringify(cards.map(({ task, next, report: value }) => ({ status: task.status, next: next.kind, team: value.team }))))
  assert.equal(cards.at(-1).next.kind, "steer")
  assert.deepEqual(cards.at(-1).next.choices.map(({ value }) => value), ["accept", "rework"])
  assert.ok(cards.at(-1).decision?.packetRef)
  const packetId = cards.at(-1).decision.packetRef.split("/").at(-1).replace(/\.json$/, "")
  const packet = await store.loadRecord(cards[0].task.id, "packet", packetId)
  assert.equal(packet.packetId, packetId)
  assert.equal(packet.stage, "implementation")
  assert.ok(packet.roster.some(({ role }) => role === "owner"))
  assert.ok(packet.roster.some(({ role }) => role === "challenger"))

  execution.setHumanChoice("accept")
  cards.push(await runtime.leadControl.steer({ action: "choose", directive: "accept" }))
  assert.equal(cards.at(-1).task.status, "completed")
  assert.equal(cards.at(-1).next.kind, "none")
  const repeated = await runtime.leadControl.run()
  assert.equal(repeated.task.status, "completed")
  assert.equal(repeated.next.kind, "none")
  assert.equal(cards.length, 7)
  assert.equal((await store.loadTask(cards[0].task.id)).evidence.some(({ kind, sourceRef, result }) => (
    kind === "platform-check" && sourceRef === "check:focused-feature-test" && result === "pass"
  )), true)
})

test("report verification rejects a changed check output and binds checks to the reporting attempt", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/check.md": "Implement checked output." })
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-19T15:00:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Reject damaged check evidence",
    objective: "Require stable check output from the reporting member",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/check.md" } }],
  })
  await runtime.leadControl.plan({ objective: "Implement and verify checked output" })
  const owner = execution.activeMembers().find(({ role }) => role === "owner")
  artifacts.write("src/checked.mjs", "export const checked = true\n", { assignmentId: owner.assignmentId })
  artifacts.write(".team-work/checks/checked.txt", "pass\n")
  await owner.observe({
    kind: "check",
    observationId: "check-damaged-1",
    dedupeKey: "check-damaged-1",
    toolCallRef: "checked-test",
    commandSummary: "run checked test",
    result: "pass",
    outputRef: ".team-work/checks/checked.txt",
    outputDigest: digestValue("pass\n"),
    observedAt: "2026-08-19T15:00:00.000Z",
  })
  await runtime.leadControl.run()
  artifacts.write(".team-work/checks/checked.txt", "corrupt\n")
  await owner.report(report(
    "Implemented the output and cited the captured check.",
    [output("artifact:source", "src/checked.mjs")],
    ["check:checked-test"],
  ))
  await runtime.leadControl.run()
  const state = await store.loadTask(opened.task.id)
  const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId)
  assert.equal(assignment.attempts[0].status, "rework")
  assert.equal(assignment.attempts.length, 2)
  assert.equal(state.artifacts.some(({ path: artifactPath }) => artifactPath === "src/checked.mjs"), false)
})

test("a planning preflight becomes a multi-owner design without exposing orchestration to Lead", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/migration.md": "Design a reversible storage migration." })
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-18T11:00:00.000Z" })
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    clock: () => "2026-08-18T11:00:00.000Z",
  })
  const cards = []
  cards.push(await runtime.leadControl.open({
    title: "Design the storage migration",
    objective: "Produce an executable and independently reviewed migration design",
    entryStage: "design",
    completion: { mode: "through-stage", stage: "design" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/migration.md" } }],
  }))
  const taskId = cards[0].task.id
  cards.push(await runtime.leadControl.plan({
    objective: "Design the storage migration with rollback",
    constraints: ["preserve backwards compatibility"],
    preferences: { execution: "team", budget: "quality", risk: "normal" },
  }))
  assert.equal(cards.at(-1).next.kind, "wait")
  assert.equal(cards.at(-1).report.team.mode, "team")

  const reported = new Set()
  let latestEvidenceRef
  const reviewEvidenceRefs = []
  const deliverNewMembers = async () => {
    for (const member of execution.activeMembers()) {
      if (reported.has(member.assignmentId)) continue
      let memberReport
      if (member.assignmentId.startsWith("owner-response-")) {
        memberReport = report("Owner verified the independent review and accepts its conclusion.", [], [...reviewEvidenceRefs])
      } else if (member.assignmentKind === "planning" && member.role === "owner") {
        const body = {
          integrationRequired: true,
          workPackages: [
            {
              packageId: "storage",
              objective: "Design storage transition and rollback",
              inputRefs: [],
              outputRefs: ["artifact:storage-design"],
              completionCriteria: ["cover forward migration and rollback"],
              dependsOn: [],
            },
            {
              packageId: "compatibility",
              objective: "Design compatibility behavior",
              inputRefs: [],
              outputRefs: ["artifact:compatibility-design"],
              completionCriteria: ["cover old and new clients"],
              dependsOn: [],
            },
          ],
        }
        artifacts.write("plans/storage-proposal.json", JSON.stringify(body), { assignmentId: member.assignmentId })
        memberReport = report("Prepared an executable two-owner plan.", [output("artifact:stage-plan-proposal:stage-run-1", "plans/storage-proposal.json")])
      } else if (member.role === "owner") {
        const artifactPath = member.assignmentId.startsWith("owner-storage-") ? "docs/storage-design.md"
          : member.assignmentId.startsWith("owner-compatibility-") ? "docs/compatibility-design.md"
            : "docs/design.md"
        const artifactRef = member.assignmentId.startsWith("owner-storage-") ? "artifact:storage-design"
          : member.assignmentId.startsWith("owner-compatibility-") ? "artifact:compatibility-design"
            : "artifact:design"
        artifacts.write(artifactPath, `Design produced by ${member.assignmentId}.`, { assignmentId: member.assignmentId })
        memberReport = report("Completed the assigned design scope.", [output(artifactRef, artifactPath)])
      } else if (member.role === "expert") {
        memberReport = {
          ...report("Independent Expert review accepts the evidence-backed design.", [], [latestEvidenceRef]),
          verdict: {
            outcome: "accept",
            rationale: "The design covers migration, rollback, compatibility, and integration.",
            evidenceRefs: [latestEvidenceRef],
            affectedScope: ["storage", "compatibility"],
            risks: [],
            confidence: "high",
            recommendedAction: "accept",
          },
        }
      } else {
        memberReport = {
          ...report("Independent challenge identified a non-blocking concern for Expert and Owner adjudication.", [], [latestEvidenceRef]),
          recommendation: "rework",
        }
      }
      const receipt = await member.report(memberReport)
      latestEvidenceRef = `report:${receipt.reportId}`
      if (["challenger", "expert"].includes(member.role)) reviewEvidenceRefs.push(latestEvidenceRef)
      reported.add(member.assignmentId)
    }
  }

  for (let wave = 0; wave < 10; wave += 1) {
    await deliverNewMembers()
    cards.push(await runtime.leadControl.run())
    if (cards.at(-1).task.status === "awaiting-user") break
  }
  const finalState = await store.loadTask(taskId)
  assert.equal(cards.at(-1).task.status, "awaiting-user", JSON.stringify({
    cards: cards.map(({ task, next, report: value }) => ({ status: task.status, next: next.kind, team: value.team })),
    members: execution.activeMembers().map(({ assignmentId, role, assignmentKind, executionRef }) => ({ assignmentId, role, assignmentKind, executionRef })),
    reported: [...reported],
    latestEvidenceRef,
    preflight: finalState.preflight,
    assignments: finalState.workGraph.assignments.map(({ assignmentId, status, attempts }) => ({ assignmentId, status, attempts })),
  }))
  assert.ok(cards.some((card) => card.report.team?.mode === "team" && card.report.team.owners >= 2))
  assert.ok(execution.activeMembers().some(({ assignmentId }) => assignmentId.startsWith("owner-response-owner-integration-")))
  assert.ok(execution.activeMembers().some(({ role, assignmentKind }) => role === "expert" && assignmentKind === "design"))

  execution.setHumanChoice("accept")
  cards.push(await runtime.leadControl.steer({ action: "choose", directive: "accept" }))
  assert.equal(cards.at(-1).task.status, "completed")
  assert.ok(cards.length <= 12, `Lead needed too many actions: ${cards.length}`)
  assert.equal(taskId, cards.at(-1).task.id)
})

test("a blocked SPEC route retains PlanIntent and can be replanned after provider recovery", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "docs/design.md": "Approved design." })
  const store = createInMemoryStore()
  const intent = {
    objective: "Produce the SPEC from the approved design",
    constraints: ["preserve the approved scope"],
    preferences: { execution: "auto", budget: "quality", risk: "normal" },
  }
  const create = (status) => createRuntimeFacade({
    store,
    executionAdapter: createFakeExecutionAdapter({ clock: () => "2026-08-18T12:00:00.000Z" }),
    specProviderAdapter: createFakeSpecProvider({ status }),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "required" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T12:00:00.000Z",
  })

  const blockedRuntime = create("missing")
  const opened = await blockedRuntime.leadControl.open({
    title: "Specify the approved design",
    objective: intent.objective,
    entryStage: "spec",
    completion: { mode: "through-stage", stage: "spec" },
    existingArtifacts: [{ kind: "design", locator: { type: "project-path", value: "docs/design.md" } }],
  })
  const blocked = await blockedRuntime.leadControl.plan(intent)
  assert.equal(blocked.code, "ROUTE_BLOCKED")
  const blockedState = await store.loadTask(opened.task.id)
  assert.deepEqual(blockedState.taskIntent, {
    ...intent,
    exclusions: [],
    preferences: { execution: "auto", budget: "quality", risk: "normal" },
  })
  assert.deepEqual(blockedState.routeDecisions.map(({ routeKind, outcome, decision, recovery }) => ({ routeKind, outcome, decision, recovery })), [{
    routeKind: "spec",
    outcome: "blocked",
    decision: "block",
    recovery: "replan-after-capability-change",
  }])

  const recoveredRuntime = create("ready")
  await recoveredRuntime.leadControl.open({ taskId: opened.task.id })
  const recovered = await recoveredRuntime.leadControl.plan(intent)
  assert.equal(recovered.next.kind, "wait")
  assert.equal(recovered.task.status, "working")
})

test("a persisted member report is reconciled after Runtime restart without redispatching its Owner", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/restart.md": "Implement restart-safe handling." })
  const store = createInMemoryStore()
  const makeRuntime = (executionAdapter) => createRuntimeFacade({
    store,
    executionAdapter,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T13:00:00.000Z",
  })

  const firstExecution = createFakeExecutionAdapter({ clock: () => "2026-08-18T13:00:00.000Z" })
  const first = makeRuntime(firstExecution)
  const opened = await first.leadControl.open({
    title: "Implement restart-safe handling",
    objective: "Implement and review restart-safe handling",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/restart.md" } }],
  })
  await first.leadControl.plan({ objective: "Implement restart-safe handling" })
  const owner = firstExecution.activeMembers().find(({ role }) => role === "owner")
  artifacts.write("src/restart.mjs", "export const restartSafe = true\n", { assignmentId: owner.assignmentId })
  await owner.report(report("Implemented the restart-safe behavior.", [output("artifact:source", "src/restart.mjs")]))

  const resumedExecution = createFakeExecutionAdapter({ clock: () => "2026-08-18T13:00:00.000Z" })
  const resumed = makeRuntime(resumedExecution)
  const card = await resumed.leadControl.open({ taskId: opened.task.id })
  assert.equal(card.next.kind, "wait")
  assert.equal(resumedExecution.activeMembers().some(({ role }) => role === "owner"), false)
  assert.equal(resumedExecution.activeMembers().some(({ role }) => role === "challenger"), true)
  const state = await store.loadTask(opened.task.id)
  assert.equal(state.workGraph.assignments.find(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0).attempts.length, 1)
})

test("task creation registers every initial input atomically", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const base = createInMemoryArtifactRepository({
    "requirements/one.md": "One",
    "requirements/two.md": "Two",
  })
  let failSecondSnapshot = true
  let snapshotCount = 0
  const artifactRepository = {
    ...base,
    async snapshot(paths) {
      snapshotCount += 1
      if (failSecondSnapshot && snapshotCount === 2) throw new Error("artifact store unavailable")
      return base.snapshot(paths)
    },
  }
  const store = createInMemoryStore()
  const create = () => createRuntimeFacade({
    store,
    executionAdapter: createFakeExecutionAdapter(),
    artifactRepository,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T13:30:00.000Z",
  })
  const input = {
    title: "Atomic initial inputs",
    objective: "Register both requirements or neither",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [
      { kind: "requirement", locator: { type: "project-path", value: "requirements/one.md" } },
      { kind: "reference", locator: { type: "project-path", value: "requirements/two.md" } },
    ],
  }
  await assert.rejects(create().leadControl.open(input), /artifact store unavailable/)
  failSecondSnapshot = false
  snapshotCount = 0
  const opened = await create().leadControl.open(input)
  const state = await store.loadTask(opened.task.id)
  assert.equal(state.revision, 0)
  assert.equal(state.artifacts.length, 2)
})

test("a singleton existing stage output keeps its canonical writable identity", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({
    "src/existing.mjs": "export const existing = true\n",
    "reviews/existing.md": "Old review\n",
  })
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-20T08:00:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Revise an existing review",
    objective: "Update the existing code-review artifact",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "code-review", locator: { type: "project-path", value: "reviews/existing.md" } },
    ],
  })
  await runtime.leadControl.plan({ objective: "Update the existing code-review artifact", preferences: { execution: "solo", budget: "quality" } })
  const owner = execution.activeMembers().find(({ role }) => role === "owner")
  artifacts.write("reviews/existing.md", "Updated review\n", { assignmentId: owner.assignmentId })
  await owner.report(report("Updated the existing review.", [output("artifact:code-review", "reviews/existing.md")]))
  await runtime.leadControl.run()

  const state = await store.loadTask(opened.task.id)
  const review = state.artifacts.find(({ artifactId }) => artifactId === "code-review")
  assert.equal(review.path, "reviews/existing.md")
  assert.equal(review.digest, digestValue("Updated review\n"))
  assert.equal(state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId).status, "accepted")
})

test("report verification enforces assignment attribution and does not punish Runtime failures", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const base = createInMemoryArtifactRepository({ "requirements/scope.md": "Implement scoped output." })
  let failSnapshot = false
  const artifactRepository = {
    ...base,
    async snapshot(paths) {
      if (failSnapshot && paths.includes("src/scoped.mjs")) throw new Error("artifact store unavailable")
      return base.snapshot(paths)
    },
  }
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T13:45:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Enforce assignment output scope",
    objective: "Accept only outputs authored by the bound assignment",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/scope.md" } }],
  })
  await runtime.leadControl.plan({ objective: "Implement scoped output" })
  let owner = execution.activeMembers().find(({ role }) => role === "owner")
  base.write("src/scoped.mjs", "export const scoped = true\n", { assignmentId: owner.assignmentId })
  await owner.report(report("Claimed an output outside the assignment ref set.", [output("artifact:test-code", "src/scoped.mjs")]))
  await runtime.leadControl.run()
  let state = await store.loadTask(opened.task.id)
  assert.equal(state.artifacts.some(({ path }) => path === "src/scoped.mjs"), false)
  assert.equal(state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId).attempts[0].status, "rework")

  owner = execution.activeMembers().find(({ assignmentId }) => assignmentId === owner.assignmentId)
  base.write("src/other.mjs", "export const other = true\n", { assignmentId: "another-assignment" })
  await owner.report(report("Claimed another assignment's output.", [output("artifact:source", "src/other.mjs")]))
  await runtime.leadControl.run()
  state = await store.loadTask(opened.task.id)
  assert.equal(state.artifacts.some(({ path }) => path === "src/other.mjs"), false)
  assert.equal(state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId).attempts[1].status, "rework")

  owner = execution.activeMembers().find(({ assignmentId }) => assignmentId === owner.assignmentId)
  base.write("src/scoped.mjs", "export const scoped = true\n", { assignmentId: owner.assignmentId })
  await owner.report(report("Delivered the assignment-owned output.", [output("artifact:source", "src/scoped.mjs")]))
  failSnapshot = true
  await assert.rejects(runtime.leadControl.run(), /artifact store unavailable/)
  state = await store.loadTask(opened.task.id)
  const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId)
  assert.equal(assignment.status, "reported")
  assert.equal(assignment.attempts.length, 3)

  failSnapshot = false
  const recovered = await runtime.leadControl.run()
  assert.equal(recovered.next.kind, "wait")
  assert.equal(execution.activeMembers().some(({ role }) => role === "challenger"), true)
})

test("report verification rejects an external change to a registered input while a member is running", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/stable.md": "Stable requirement." })
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-19T14:00:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Protect registered inputs",
    objective: "Reject output produced against an externally changed requirement",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/stable.md" } }],
  })
  await runtime.leadControl.plan({ objective: "Protect registered inputs" })
  const owner = execution.activeMembers().find(({ role }) => role === "owner")
  artifacts.write("requirements/stable.md", "Changed by another process.")
  artifacts.write("src/protected.mjs", "export const protectedInput = true\n", { assignmentId: owner.assignmentId })
  await owner.report(report("Implemented against the changed input.", [output("artifact:source", "src/protected.mjs")]))
  await runtime.leadControl.run()
  const state = await store.loadTask(opened.task.id)
  const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === owner.assignmentId)
  assert.equal(assignment.attempts[0].status, "rework")
  assert.equal(state.artifacts.some(({ path }) => path === "src/protected.mjs"), false)
})

test("a rejected preflight review opens a new planning round instead of an illegal stage transition", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/preflight-rework.md": "Design a guarded change." })
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T13:50:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Rework a planning preflight",
    objective: "Prove disagreement starts a recoverable new round",
    entryStage: "design",
    completion: { mode: "through-stage", stage: "design" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/preflight-rework.md" } }],
  })
  await runtime.leadControl.plan({ objective: "Design the guarded change" })
  const owner = execution.activeMembers().find(({ role, assignmentKind }) => role === "owner" && assignmentKind === "planning")
  const proposalBody = {
    proposalId: "proposal-preflight-rework",
    stageRunId: "stage-run-1",
    stage: "design",
    integrationRequired: false,
    workPackages: [{
      packageId: "design",
      objective: "Design the guarded change",
      inputRefs: [],
      outputRefs: ["artifact:design"],
      completionCriteria: ["cover the guarded behavior"],
      dependsOn: [],
    }],
  }
  const proposal = { ...proposalBody, digest: digestValue(proposalBody) }
  artifacts.write("plans/preflight-rework.json", JSON.stringify(proposal), { assignmentId: owner.assignmentId })
  const ownerReceipt = await owner.report(report("Prepared a proposal for review.", [
    output("artifact:stage-plan-proposal:stage-run-1", "plans/preflight-rework.json"),
  ]))

  await runtime.leadControl.run()
  const challenger = execution.activeMembers().find(({ role }) => role === "challenger")
  const challengerReport = report("The proposal still misses a failure path.", [], [`report:${ownerReceipt.reportId}`])
  challengerReport.recommendation = "rework"
  const challengerReceipt = await challenger.report(challengerReport)

  await runtime.leadControl.run()
  const expert = execution.activeMembers().find(({ role }) => role === "expert")
  const expertReceipt = await expert.report({
    ...report("Expert confirms the proposal needs another round.", [], [`report:${challengerReceipt.reportId}`]),
    recommendation: "rework",
    verdict: {
      outcome: "rework",
      rationale: "The missing failure path is material.",
      evidenceRefs: [`report:${challengerReceipt.reportId}`],
      affectedScope: ["failure-path"],
      risks: ["incomplete rollback behavior"],
      confidence: "high",
      recommendedAction: "rework",
    },
  })

  await runtime.leadControl.run()
  const response = execution.activeMembers().find(({ assignmentId }) => assignmentId.startsWith("owner-response-"))
  await response.report(report("Owner accepts the evidence-backed need for another planning round.", [], [
    `report:${challengerReceipt.reportId}`,
    `report:${expertReceipt.reportId}`,
  ]))

  const next = await runtime.leadControl.run()
  const state = await store.loadTask(opened.task.id)
  assert.equal(next.next.kind, "wait")
  assert.equal(state.currentStageRun.stageRunId, "stage-run-2")
  assert.equal(state.currentStageRun.round, 2)
  assert.equal(state.preflight.status, "active")
  assert.equal(state.workGraph.assignments.some(({ assignmentKind, status }) => assignmentKind === "planning" && status === "running"), true)
})

test("invalid planning output is rejected atomically and stops for a user after three attempts", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({ "requirements/invalid-plan.md": "Design a guarded migration." })
  const store = createInMemoryStore()
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-18T14:00:00.000Z" })
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-18T14:00:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Reject an invalid planning result",
    objective: "Design a guarded migration",
    entryStage: "design",
    completion: { mode: "through-stage", stage: "design" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/invalid-plan.md" } }],
  })
  await runtime.leadControl.plan({ objective: "Design a guarded migration", preferences: { budget: "quality" } })

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const owner = execution.activeMembers().find(({ role, assignmentKind }) => role === "owner" && assignmentKind === "planning")
    artifacts.write("plans/invalid.json", `{ invalid attempt ${attempt}`, { assignmentId: owner.assignmentId })
    await owner.report(report("Submitted a malformed proposal fixture.", [output("artifact:stage-plan-proposal:stage-run-1", "plans/invalid.json")]))
    const card = await runtime.leadControl.run()
    if (attempt < 3) assert.equal(card.next.kind, "wait")
    else {
      assert.equal(card.task.status, "awaiting-user")
      assert.deepEqual(card.next.choices.map(({ value }) => value), ["rework"])
    }
  }

  const state = await store.loadTask(opened.task.id)
  const owner = state.workGraph.assignments.find(({ teamRole, assignmentKind }) => teamRole === "owner" && assignmentKind === "planning")
  assert.equal(state.preflight.status, "active")
  assert.equal(state.preflight.result, null)
  assert.equal(state.artifacts.some(({ path }) => path === "plans/invalid.json"), false)
  assert.equal(owner.attempts.length, 3)
  assert.equal(owner.attempts.every(({ status }) => status === "rework"), true)
})

test("an out-of-scope artifact modification is rejected and restored to the registered content", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({
    "src/existing.mjs": "export const existing = true\n",
    "reviews/existing.md": "Old review\n",
  })
  const execution = createFakeExecutionAdapter()
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-20T09:00:00.000Z",
  })
  const opened = await runtime.leadControl.open({
    title: "Guard protected artifacts",
    objective: "Keep the registered review content authoritative",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "code-review", locator: { type: "project-path", value: "reviews/existing.md" } },
    ],
  })
  await runtime.leadControl.plan({ objective: "Keep the registered review content authoritative", preferences: { execution: "solo", budget: "quality" } })
  const owner = execution.activeMembers().find(({ role }) => role === "owner")
  artifacts.write("reviews/existing.md", "Authoritative review\n", { assignmentId: owner.assignmentId })
  const ownerReceipt = await owner.report(report("Delivered the authoritative review.", [output("artifact:code-review", "reviews/existing.md")]))
  await runtime.leadControl.run()
  const stateAfterOwner = await store.loadTask(opened.task.id)
  const registered = stateAfterOwner.artifacts.find(({ artifactId }) => artifactId === "code-review").digest

  // 模拟 Challenger 越权修改受保护制品
  artifacts.write("reviews/existing.md", "Tampered by a read-only member\n")
  const challenger = execution.activeMembers().find(({ role }) => role === "challenger")
  const tamperedReport = report("Reviewed against the tampered content.", [], [`report:${ownerReceipt.reportId}`])
  tamperedReport.recommendation = "accept"
  await challenger.report(tamperedReport)
  await runtime.leadControl.run()

  const state = await store.loadTask(opened.task.id)
  const challengerAssignment = state.workGraph.assignments.find(({ teamRole }) => teamRole === "challenger")
  assert.ok(challengerAssignment.attempts.some(({ status }) => status === "rework"))
  assert.equal(await artifacts.read("reviews/existing.md"), "Authoritative review\n")
  assert.equal(digestValue(await artifacts.read("reviews/existing.md")), registered)
})
