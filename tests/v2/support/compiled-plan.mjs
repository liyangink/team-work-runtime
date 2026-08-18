import { digestValue } from "../../../runtime/domain/index.mjs"

export const TEST_AGENT_CATALOG_DIGEST = "c".repeat(64)
export const TEST_TASK_INTENT = Object.freeze({
  objective: "Execute the test stage plan",
  constraints: [],
  exclusions: [],
  preferences: { execution: "auto", budget: "balanced", risk: "normal" },
})

export function compiledPlanMetadata({ workflow, scopeStages = workflow.stages, round = 1, agentCatalogDigest = TEST_AGENT_CATALOG_DIGEST } = {}) {
  const specBody = {
    mode: "disabled",
    configDigest: "d".repeat(64),
    probeDigest: null,
    decision: "skip",
    reason: "disabled-by-project",
  }
  return {
    basis: { kind: "deterministic" },
    teamMode: "solo",
    policyPins: {
      workflow: {
        workflowId: workflow.workflowId,
        version: workflow.version,
        digest: workflow.digest,
      },
      team: { policyId: "default", version: "2026-08-18", digest: "b".repeat(64) },
      agentCatalogDigest,
    },
    convergence: { maxAutonomousRounds: 3, currentRound: round },
    costProjection: {
      scopeStages: [...scopeStages],
      branchPathCount: 0,
      specDecision: "skip",
      e2eDecision: "assessment-required",
      maxAutonomousRounds: 3,
    },
    routes: {
      humanGates: [],
      spec: { ...specBody, digest: digestValue(specBody) },
      e2e: {
        kind: "assessment-required",
        mode: "auto",
        userRequired: false,
        taskIntentDigest: digestValue(TEST_TASK_INTENT),
        artifactSnapshotDigest: digestValue([]),
      },
    },
  }
}
