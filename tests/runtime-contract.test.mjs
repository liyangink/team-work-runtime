import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  canTransitionTask,
  canTransitionWorkItem,
  evaluateStageGate,
  planRollback,
  resolveActiveTask,
  rollbackTargetIsEarlier,
  validateTaskAgainstWorkflow,
  validatePlatformProfileSemantics,
  validateWorkflowSemantics,
  validateWorkItemsSemantics,
} from "../schemas/semantic-validation.mjs"
import { createContractValidator } from "./support/contract-validator.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"))
}

async function read(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8")
}

const schemaNames = [
  "task", "context-entry", "workflow", "work-item", "work-items", "event", "binding",
  "project-config", "platform-profile", "response",
]
const schemas = await Promise.all(schemaNames.map((name) => readJson(`schemas/${name}.schema.json`)))
const validate = createContractValidator(schemas)
const schemaId = (name) => `https://team-work.local/schemas/${name}.schema.json`

function setAtPath(target, dottedPath, value) {
  const parts = dottedPath.split(".")
  const last = parts.pop()
  let cursor = target
  for (const part of parts) cursor = cursor[part]
  cursor[last] = value
}

test("runtime contract publishes every platform-neutral schema", async () => {
  for (const name of schemaNames) {
    const schema = await readJson(`schemas/${name}.schema.json`)
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.ok(schema.type === "object" || schema.oneOf, `${name} has an object contract`)
  }
})

test("task fixtures accept a stage entry and reject platform-private state", async () => {
  const valid = await readJson("tests/fixtures/runtime/task.valid.json")
  const invalid = await readJson("tests/fixtures/runtime/task.invalid-platform-field.json")

  assert.deepEqual(validate(schemaId("task"), valid), [])
  assert.match(validate(schemaId("task"), invalid).join("\n"), /sessionId.*additionalProperties/)
})

test("every runtime schema has accepted and rejected fixtures", async () => {
  for (const name of [
    "context-entry", "workflow", "work-item", "work-items", "event", "binding",
    "project-config", "platform-profile", "response",
  ]) {
    const valid = await readJson(`tests/fixtures/runtime/${name}.valid.json`)
    const invalid = await readJson(`tests/fixtures/runtime/${name}.invalid.json`)

    assert.deepEqual(validate(schemaId(name), valid), [], `${name} valid fixture`)
    assert.notDeepEqual(validate(schemaId(name), invalid), [], `${name} invalid fixture`)
  }
})

test("engineering workflow permits direct code-review entry with only its minimum inputs", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")
  const stages = new Map(workflow.stages.map((stage) => [stage.id, stage]))
  const codeReviewInputs = stages.get("code-review").requiredInputs.map(({ kind }) => kind)

  assert.deepEqual(validate(schemaId("workflow"), workflow), [])
  assert.deepEqual([...stages.keys()], [
    "research", "design", "design-review", "spec", "spec-review",
    "implementation", "test", "code-review", "e2e", "finish",
  ])
  assert.deepEqual(codeReviewInputs, ["source", "review-scope"])
  assert.ok(!codeReviewInputs.includes("design"))
  assert.ok(!codeReviewInputs.includes("spec"))
  assert.ok(workflow.transitions.some(({ from, outcome, to }) => from === "code-review" && outcome === "rework" && to === "implementation"))

  const sourceOnly = evaluateStageGate(workflow, "code-review", [{ kind: "source" }])
  assert.equal(sourceOnly.ok, false)
  assert.deepEqual(sourceOnly.blockers.map(({ code, kind }) => [code, kind]), [["MISSING_INPUT", "review-scope"]])
  assert.equal(evaluateStageGate(workflow, "code-review", [{ kind: "source" }, { kind: "review-scope" }]).ok, true)
})

test("runtime interface fixes stage-entry, lifecycle, gate, binding and error semantics", async () => {
  const contract = await read("docs/runtime-interface.md")

  assert.match(contract, /task create --entry-stage/)
  assert.match(contract, /只检查当前阶段声明的最低必需输入/)
  assert.match(contract, /task complete\|cancel\|archive/)
  assert.match(contract, /flow rollback --to/)
  assert.match(contract, /bindings\/<platform>\/<session-key>\.json/)
  assert.match(contract, /"ok": true/)
  assert.match(contract, /"ok": false/)
  assert.match(contract, /REVISION_CONFLICT/)
  assert.match(contract, /GATE_BLOCKED/)
  assert.match(contract, /PLATFORM_UNAVAILABLE/)
})

test("core schemas do not define platform-private fields", async () => {
  for (const name of ["task", "context-entry", "workflow", "work-item", "event"]) {
    const encoded = JSON.stringify(await readJson(`schemas/${name}.schema.json`))
    assert.doesNotMatch(encoded, /sessionId|teamName|teammate|requestedModel|resolvedModel|run_in_background/)
  }
})

test("engineering workflow publishes the complete legal transition table", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")
  const actual = workflow.transitions.map(({ from, outcome, to }) => `${from}:${outcome}->${to}`)

  assert.deepEqual(actual, [
    "research:pass->design",
    "design:pass->design-review",
    "design-review:pass->spec",
    "design-review:rework->design",
    "spec:pass->spec-review",
    "spec-review:pass->implementation",
    "spec-review:rework->spec",
    "implementation:pass->test",
    "test:pass->code-review",
    "test:fail->implementation",
    "code-review:pass->e2e",
    "code-review:rework->implementation",
    "e2e:pass->finish",
    "e2e:fail->implementation",
  ])
})

test("negative contract matrix isolates missing, version and invalid-state failures", async () => {
  const cases = await readJson("tests/fixtures/runtime/contract-negative-cases.json")
  for (const [name, contractCase] of Object.entries(cases)) {
    const valid = await readJson(`tests/fixtures/runtime/${name}.valid.json`)

    const missing = structuredClone(valid)
    delete missing[contractCase.missingRequired]
    assert.match(validate(schemaId(name), missing).join("\n"), /required/, `${name} missing required`)

    const unsupported = structuredClone(valid)
    unsupported[contractCase.versionField] = "9.9"
    assert.match(validate(schemaId(name), unsupported).join("\n"), /const/, `${name} unsupported version`)

    const invalidState = structuredClone(valid)
    setAtPath(invalidState, contractCase.invalidPath, contractCase.invalidValue)
    assert.notDeepEqual(validate(schemaId(name), invalidState), [], `${name} invalid state`)
  }
})

test("paths, guides and binding keys reject traversal and absolute locations", async () => {
  const context = await readJson("tests/fixtures/runtime/context-entry.valid.json")
  for (const unsafe of ["../outside", "/absolute/path", "C:\\outside", "C:outside", "safe/../../outside"]) {
    assert.notDeepEqual(validate(schemaId("context-entry"), { ...context, path: unsafe }), [], unsafe)
  }

  const profile = await readJson("tests/fixtures/runtime/platform-profile.valid.json")
  assert.notDeepEqual(validate(schemaId("platform-profile"), { ...profile, guides: ["../outside.md"] }), [])

  const binding = await readJson("tests/fixtures/runtime/binding.valid.json")
  for (const unsafe of ["../session", "nested/session", "nested\\session"]) {
    assert.notDeepEqual(validate(schemaId("binding"), { ...binding, sessionKey: unsafe }), [], unsafe)
  }
})

test("semantic validation rejects broken graphs, task stages and work-item references", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")
  const brokenWorkflow = await readJson("tests/fixtures/runtime/workflow.invalid-semantics.json")
  const task = await readJson("tests/fixtures/runtime/task.valid.json")
  const brokenWorkItems = await readJson("tests/fixtures/runtime/work-items.invalid-semantics.json")
  const unreachableWorkflow = structuredClone(workflow)
  unreachableWorkflow.stages.push({ id: "island", requiredInputs: [], teamEvaluation: false, terminal: false })
  unreachableWorkflow.transitions.push({ from: "island", outcome: "loop", to: "island" })

  assert.deepEqual(validateWorkflowSemantics(workflow), [])
  assert.match(validateWorkflowSemantics(brokenWorkflow).map(({ message }) => message).join("\n"), /duplicate stage|unknown stage|duplicate transition|terminal stage/)
  assert.match(validateWorkflowSemantics(unreachableWorkflow).map(({ message }) => message).join("\n"), /cannot reach a terminal/)
  assert.deepEqual(validateTaskAgainstWorkflow(task, workflow, { loadedWorkflowDigest: task.workflow.digest }), [])
  assert.match(validateTaskAgainstWorkflow({ ...task, stage: "unknown" }, workflow).map(({ message }) => message).join("\n"), /unknown stage/)
  assert.match(validateTaskAgainstWorkflow(task, workflow, { loadedWorkflowDigest: "sha256:deadbeef" }).map(({ message }) => message).join("\n"), /loaded workflow digest/)
  assert.match(validateWorkItemsSemantics(brokenWorkItems).map(({ message }) => message).join("\n"), /duplicate work item|unknown dependency/)
})

test("task semantics bind gates to valid non-future evidence and require completed work", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")
  const task = await readJson("tests/fixtures/runtime/task.valid.json")
  const workItems = await readJson("tests/fixtures/runtime/work-items.valid.json")
  const evidence = {
    evidenceId: "review-evidence", stage: "code-review", path: "artifacts/review.md",
    status: "valid", recordedAtRevision: 1,
  }
  const gate = {
    gateId: "review-gate", stage: "code-review", kind: "semantic", status: "passed",
    evidenceRefs: [evidence.evidenceId],
    decision: { decidedBy: "lead", reason: "reviewed", decidedAt: "2026-08-10T08:10:00.000Z" },
  }
  assert.deepEqual(validateTaskAgainstWorkflow({ ...task, evidence: [evidence], gates: [gate] }, workflow), [])
  assert.match(validateTaskAgainstWorkflow({ ...task, gates: [gate] }, workflow).map(({ message }) => message).join("\n"), /unknown evidence/)
  assert.match(validateTaskAgainstWorkflow({ ...task, evidence: [{ ...evidence, stage: "e2e" }], gates: [gate] }, workflow).map(({ message }) => message).join("\n"), /future-stage evidence/)

  const futureEvidence = { ...evidence, evidenceId: "e2e-proof", stage: "e2e" }
  const futureGate = { ...gate, gateId: "e2e-gate", stage: "e2e", evidenceRefs: [futureEvidence.evidenceId] }
  assert.match(validateTaskAgainstWorkflow({ ...task, evidence: [futureEvidence], gates: [futureGate] }, workflow).map(({ message }) => message).join("\n"), /future-stage evidence|future-stage gate/)
  assert.deepEqual(validateTaskAgainstWorkflow({
    ...task,
    evidence: [{ ...futureEvidence, status: "invalidated", invalidatedAtRevision: 2, invalidationReason: "rollback" }],
    gates: [{ ...futureGate, status: "pending", evidenceRefs: [], decision: undefined }],
  }, workflow), [])

  const completed = {
    ...task,
    status: "completed",
    stage: "finish",
    evidence: [evidence],
    acceptance: {
      acceptedBy: "lead", acceptedAt: "2026-08-10T08:20:00.000Z", summary: "accepted",
      artifactRefs: ["artifacts/review.md"], evidenceRefs: [evidence.evidenceId],
    },
  }
  assert.match(validateTaskAgainstWorkflow(completed, workflow).map(({ message }) => message).join("\n"), /requires work-items/)
  assert.match(validateTaskAgainstWorkflow(completed, workflow, { workItems }).map(({ message }) => message).join("\n"), /unfinished work items/)
  const finishedItems = {
    ...workItems,
    items: workItems.items.map((item) => ({
      ...item,
      status: "accepted",
      submission: {
        scenario: "code-review", stageRef: "code-review", scopeRefs: ["review-scope"], outcome: "pass",
        artifactRefs: ["artifacts/review.md"], evidenceRefs: [evidence.evidenceId], summary: "done",
        submittedAt: "2026-08-10T08:10:00.000Z",
      },
      acceptance: {
        acceptedBy: "lead", acceptedAt: "2026-08-10T08:15:00.000Z", decision: "accepted",
        evidenceRefs: [evidence.evidenceId],
      },
    })),
  }
  assert.deepEqual(validateTaskAgainstWorkflow(completed, workflow, { workItems: finishedItems }), [])
  assert.match(validateTaskAgainstWorkflow(completed, workflow, { workItems: { ...finishedItems, taskId: "another-task" } }).map(({ message }) => message).join("\n"), /another task/)
  const foreignItem = structuredClone(finishedItems)
  foreignItem.items[0].taskId = "another-task"
  assert.match(validateTaskAgainstWorkflow(completed, workflow, { workItems: foreignItem }).map(({ message }) => message).join("\n"), /does not match document taskId/)
  const unknownStageItem = structuredClone(finishedItems)
  unknownStageItem.items[0].stage = "unknown"
  assert.match(validateTaskAgainstWorkflow(completed, workflow, { workItems: unknownStageItem }).map(({ message }) => message).join("\n"), /unknown stage/)
  assert.match(validateTaskAgainstWorkflow({ ...completed, acceptance: { ...completed.acceptance, evidenceRefs: ["missing"] } }, workflow, { workItems: finishedItems }).map(({ message }) => message).join("\n"), /unknown evidence/)
  const emptyAcceptanceEvidence = { ...completed, acceptance: { ...completed.acceptance, evidenceRefs: [] } }
  assert.notDeepEqual(validate(schemaId("task"), emptyAcceptanceEvidence), [])
  assert.match(validateTaskAgainstWorkflow(emptyAcceptanceEvidence, workflow, { workItems: finishedItems }).map(({ message }) => message).join("\n"), /requires acceptance evidence/)
})

test("task and work-item lifecycle tables are closed and rollback only moves earlier", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")

  assert.equal(canTransitionTask("active", "awaiting-user"), true)
  assert.equal(canTransitionTask("awaiting-user", "active"), true)
  assert.equal(canTransitionTask("completed", "active"), false)
  assert.equal(canTransitionWorkItem("running", "submitted"), true)
  assert.equal(canTransitionWorkItem("submitted", "accepted"), true)
  assert.equal(canTransitionWorkItem("accepted", "running"), false)
  assert.equal(rollbackTargetIsEarlier(workflow, "code-review", "design"), true)
  assert.equal(rollbackTargetIsEarlier(workflow, "design", "code-review"), false)
})

test("work-item state controls submission and Lead acceptance records", async () => {
  const workItem = await readJson("tests/fixtures/runtime/work-item.valid.json")
  assert.notDeepEqual(validate(schemaId("work-item"), { ...workItem, status: "accepted" }), [])
  assert.notDeepEqual(validate(schemaId("work-item"), {
    ...workItem,
    status: "queued",
    submission: {
      scenario: "code-review",
      stageRef: "code-review",
      scopeRefs: ["review-scope"],
      outcome: "pass",
      artifactRefs: ["artifacts/review.md"],
      evidenceRefs: [],
      summary: "done",
      submittedAt: "2026-08-10T08:00:00.000Z"
    }
  }), [])
})

test("work-item history and dependency graph remain auditable", async () => {
  const document = await readJson("tests/fixtures/runtime/work-items.valid.json")
  const missingHistory = structuredClone(document)
  missingHistory.items[0].attempt = 2
  assert.match(validateWorkItemsSemantics(missingHistory).map(({ message }) => message).join("\n"), /every prior attempt/)

  const impossibleHistory = structuredClone(document)
  impossibleHistory.items[0].attempt = 2
  impossibleHistory.items[0].attemptHistory = [{
    attempt: 1,
    submission: {
      scenario: "code-review", stageRef: "code-review", scopeRefs: ["review-scope"], outcome: "pass",
      artifactRefs: ["artifacts/review.md"], evidenceRefs: [], summary: "done", submittedAt: "2026-08-10T08:05:00.000Z",
    },
    acceptance: { acceptedBy: "lead", acceptedAt: "2026-08-10T08:06:00.000Z", decision: "accepted", evidenceRefs: ["review-evidence"] },
  }]
  assert.notDeepEqual(validate(schemaId("work-items"), impossibleHistory), [])
  assert.match(validateWorkItemsSemantics(impossibleHistory).map(({ message }) => message).join("\n"), /end in rework/)

  const cycle = structuredClone(document)
  const first = cycle.items[0]
  first.workItemId = "first"
  first.assignment.dependencies = ["second"]
  cycle.items.push({ ...structuredClone(first), workItemId: "second", assignment: { ...first.assignment, dependencies: ["first"] } })
  assert.match(validateWorkItemsSemantics(cycle).map(({ message }) => message).join("\n"), /dependency cycle/)
})

test("rollback planning resets later gates and invalidates later evidence", async () => {
  const workflow = await readJson("schemas/examples/engineering.workflow.json")
  const task = await readJson("tests/fixtures/runtime/task.valid.json")
  const enriched = {
    ...task,
    evidence: [
      { evidenceId: "design-proof", stage: "design", path: "artifacts/design.md", status: "valid", recordedAtRevision: 1 },
      { evidenceId: "review-proof", stage: "code-review", path: "artifacts/review.md", status: "valid", recordedAtRevision: 2 },
    ],
    gates: [
      { gateId: "design-gate", stage: "design", kind: "semantic", status: "pending", evidenceRefs: [] },
      { gateId: "review-gate", stage: "code-review", kind: "semantic", status: "pending", evidenceRefs: [] },
    ],
  }
  const planned = planRollback(enriched, workflow, "design", { reason: "assumption failed", evidenceRefs: ["review-proof"] })
  assert.deepEqual(planned.issues, [])
  assert.deepEqual(planned.gateIdsToReset, ["review-gate"])
  assert.deepEqual(planned.evidenceIdsToInvalidate, ["review-proof"])
  assert.match(planRollback(enriched, workflow, "e2e", {}).issues.map(({ message }) => message).join("\n"), /earlier stage|reason|required/)
})

test("active task resolution follows explicit, binding and unique-task precedence", () => {
  const tasks = [
    { taskId: "a", status: "active" },
    { taskId: "b", status: "awaiting-user" },
    { taskId: "done", status: "completed" },
  ]
  assert.deepEqual(resolveActiveTask({ explicitTaskId: "b", bindingTaskId: "a", tasks }), { taskId: "b" })
  assert.deepEqual(resolveActiveTask({ bindingTaskId: "a", tasks }), { taskId: "a" })
  assert.deepEqual(resolveActiveTask({ tasks }), { errorCode: "TASK_AMBIGUOUS" })
  assert.deepEqual(resolveActiveTask({ tasks: [{ taskId: "a", status: "active" }] }), { taskId: "a" })
  assert.deepEqual(resolveActiveTask({ explicitTaskId: "done", tasks }), { errorCode: "TASK_NOT_FOUND" })
})

test("awaiting-user state carries a concrete resume question and optional valid gate", async () => {
  const task = await readJson("tests/fixtures/runtime/task.valid.json")
  const waiting = {
    ...task,
    status: "awaiting-user",
    awaitingUser: {
      question: "Choose a compatibility policy", blocker: "Requirements conflict",
      requiredDecision: "strict or permissive", requestedAt: "2026-08-10T08:10:00.000Z",
    },
  }
  assert.deepEqual(validate(schemaId("task"), waiting), [])
  assert.notDeepEqual(validate(schemaId("task"), { ...task, status: "awaiting-user" }), [])
  assert.notDeepEqual(validate(schemaId("task"), { ...task, awaitingUser: waiting.awaitingUser }), [])
})

test("response and platform capability contracts reject ambiguous envelopes", async () => {
  const response = await readJson("tests/fixtures/runtime/response.valid.json")
  assert.notDeepEqual(validate(schemaId("response"), { ...response, revision: undefined }), [])

  const blocked = {
    ok: false, apiVersion: "1.0", taskId: "review-existing-code", revision: 3,
    error: { code: "GATE_BLOCKED", message: "blocked", retryable: false, blockers: [], remediation: [] },
  }
  assert.notDeepEqual(validate(schemaId("response"), blocked), [])

  const profile = await readJson("tests/fixtures/runtime/platform-profile.valid.json")
  const supportedWithoutTool = structuredClone(profile)
  supportedWithoutTool.operations.spawn.tool = null
  assert.notDeepEqual(validate(schemaId("platform-profile"), supportedWithoutTool), [])
  const unsupportedWithTool = structuredClone(profile)
  unsupportedWithTool.operations.message.tool = "message"
  assert.notDeepEqual(validate(schemaId("platform-profile"), unsupportedWithTool), [])
  const unresolvedMissing = structuredClone(profile)
  delete unresolvedMissing.agents[0].resolvedModel
  assert.notDeepEqual(validate(schemaId("platform-profile"), unresolvedMissing), [])

  const duplicateAgent = structuredClone(profile)
  duplicateAgent.agents.push({ ...duplicateAgent.agents[0], requestedModel: "gateway/other" })
  assert.match(validatePlatformProfileSemantics(duplicateAgent).map(({ message }) => message).join("\n"), /duplicate agent id/)
})

test("OpenCode fixture enforces background dispatch without constraining other platforms", async () => {
  const profileSchema = await readJson("schemas/platform-profile.schema.json")
  const encoded = JSON.stringify(profileSchema)
  const opencode = await readJson("tests/fixtures/runtime/platform-profile.valid.json")

  assert.equal(opencode.platform, "opencode")
  assert.equal(opencode.dispatch.managedMode, "background")
  assert.equal(opencode.dispatch.blockingPolicy, "reject")
  assert.match(encoded, /background/)
  assert.match(encoded, /blocking/)
})
