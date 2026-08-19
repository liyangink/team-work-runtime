import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createOpenSpecProvider } from "../../../spec-providers/openspec/provider.mjs"
import { createSpecProviderAdapterPort, digestValue } from "../../../runtime/index.mjs"

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-openspec-"))
  await mkdir(path.join(root, ".team-work"), { recursive: true })
  return root
}

function taskRef() {
  return {
    providerId: "openspec",
    taskId: "task-1",
    stageRunId: "stage-run-4",
    configDigest: "config-digest",
    routeStateDigest: "route-digest",
  }
}

function effect(value) {
  const body = { ...value }
  delete body.effectDigest
  return { ...value, effectDigest: digestValue(body) }
}

function openSpecRunner(projectRoot) {
  const calls = []
  const active = path.join(projectRoot, "openspec", "changes", "task-1")

  async function present(relative) {
    return readFile(path.join(active, relative), "utf8").then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))
  }

  async function status() {
    const proposal = await present("proposal.md")
    const design = await present("design.md")
    const specs = await present("specs/mail/spec.md")
    const tasks = await present("tasks.md")
    return {
      isComplete: tasks,
      artifacts: [
        { id: "proposal", status: proposal ? "done" : "ready" },
        { id: "design", status: design ? "done" : proposal ? "ready" : "blocked" },
        { id: "specs", status: specs ? "done" : design ? "ready" : "blocked" },
        { id: "tasks", status: tasks ? "done" : specs ? "ready" : "blocked" },
      ],
    }
  }

  const outputPaths = { proposal: "proposal.md", design: "design.md", specs: "specs", tasks: "tasks.md" }
  const runner = async ({ args }) => {
    calls.push([...args])
    if (args[0] === "--version") return { stdout: "1.2.3\n", stderr: "" }
    if (args[0] === "list") return { stdout: JSON.stringify({ changes: [] }), stderr: "" }
    if (args[0] === "new") {
      await mkdir(active, { recursive: true })
      return { stdout: "created", stderr: "" }
    }
    if (args[0] === "status") return { stdout: JSON.stringify(await status()), stderr: "" }
    if (args[0] === "instructions") {
      const artifactId = args[1]
      return {
        stdout: JSON.stringify({
          artifactId,
          outputPath: outputPaths[artifactId],
          instruction: `Write ${artifactId} from provider facts.`,
          template: `# ${artifactId}`,
        }),
        stderr: "",
      }
    }
    if (args[0] === "validate") return { stdout: JSON.stringify({ valid: await present("tasks.md") }), stderr: "" }
    if (args[0] === "archive") {
      const archiveRoot = path.join(projectRoot, "openspec", "changes", "archive")
      await mkdir(archiveRoot, { recursive: true })
      await rename(active, path.join(archiveRoot, "2026-08-19-task-1"))
      return { stdout: "archived", stderr: "" }
    }
    throw new Error(`unexpected OpenSpec command: ${args.join(" ")}`)
  }
  return { runner, calls, active }
}

async function setup(options = {}) {
  const projectRoot = options.projectRoot ?? await project()
  const cli = options.cli ?? openSpecRunner(projectRoot)
  const provider = createOpenSpecProvider({
    projectRoot,
    runner: cli.runner,
    clock: () => new Date("2026-08-19T12:00:00.000Z"),
    faultInjector: options.faultInjector,
  })
  return { projectRoot, cli, provider, port: createSpecProviderAdapterPort(provider) }
}

function prepareIntent(artifact = "proposal", extras = {}) {
  return effect({
    operationId: `prepare-${artifact}`,
    task: taskRef(),
    artifact,
    ...extras,
  })
}

test("OpenSpec Provider probes independently and prepares one bounded active-change capability", async () => {
  const { port, cli, projectRoot } = await setup()
  assert.deepEqual(await port.probe(), {
    providerId: "openspec",
    status: "ready",
    version: "1.2.3",
    observedAt: "2026-08-19T12:00:00.000Z",
  })
  const intent = prepareIntent()
  const capability = await port.prepare(intent)
  assert.equal(capability.status, "ready")
  assert.deepEqual(capability.writableRefs, ["openspec/changes/task-1/proposal.md"])
  assert.ok(capability.readableRefs.includes(capability.instructionsRef))
  assert.match(await readFile(path.join(projectRoot, capability.instructionsRef), "utf8"), /禁止修改 canonical specs、archive/)
  assert.equal(cli.calls.filter(([command]) => command === "new").length, 1)

  assert.deepEqual(await port.prepare(intent), capability)
  assert.equal(cli.calls.filter(([command]) => command === "new").length, 1)
  const inspection = await port.inspect({ ...intent, kind: "prepare" })
  assert.equal(inspection.status, "confirmed")
  assert.deepEqual(inspection.result, capability)
})

test("OpenSpec provider state refuses a nested symlink before writing its journal", async () => {
  const projectRoot = await project()
  const external = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-openspec-external-"))
  await symlink(external, path.join(projectRoot, ".team-work", "spec-providers"))
  const provider = createSpecProviderAdapterPort(createOpenSpecProvider({ projectRoot, runner: openSpecRunner(projectRoot).runner }))
  await assert.rejects(provider.probe(), (error) => error.code === "PATH_ESCAPE")
})

test("prepare inspection reconstructs a change created before the capability receipt was persisted", async () => {
  const projectRoot = await project()
  const cli = openSpecRunner(projectRoot)
  let crash = true
  const interrupted = await setup({
    projectRoot,
    cli,
    faultInjector: { afterChangeCreated: async () => { if (crash) { crash = false; throw new Error("simulated create receipt loss") } } },
  })
  const intent = prepareIntent()
  await assert.rejects(interrupted.port.prepare(intent), /simulated create receipt loss/)
  assert.equal(cli.calls.filter(([command]) => command === "new").length, 1)

  const restarted = await setup({ projectRoot, cli })
  const inspection = await restarted.port.inspect({ ...intent, kind: "prepare" })
  assert.equal(inspection.status, "confirmed")
  assert.equal(inspection.result.status, "ready")
  assert.equal(cli.calls.filter(([command]) => command === "new").length, 1)
})

test("OpenSpec capabilities enforce proposal to design to specs to tasks and isolate writable paths", async () => {
  const { port, cli } = await setup()
  const proposal = await port.prepare(prepareIntent())
  await mkdir(path.dirname(path.join(cli.active, "proposal.md")), { recursive: true })
  await writeFile(path.join(cli.active, "proposal.md"), "# Proposal")
  const design = await port.prepare(prepareIntent("design"))
  assert.deepEqual(design.writableRefs, ["openspec/changes/task-1/design.md"])
  await writeFile(path.join(cli.active, "design.md"), "# Design")
  const specs = await port.prepare(prepareIntent("specs", { capabilityNames: ["mail"] }))
  assert.deepEqual(specs.writableRefs, ["openspec/changes/task-1/specs/mail/spec.md"])
  await mkdir(path.join(cli.active, "specs", "mail"), { recursive: true })
  await writeFile(path.join(cli.active, "specs", "mail", "spec.md"), "# Mail spec")
  const tasks = await port.prepare(prepareIntent("tasks"))
  assert.deepEqual(tasks.writableRefs, ["openspec/changes/task-1/tasks.md"])
  assert.ok(tasks.readableRefs.includes("openspec/changes/task-1/proposal.md"))
  assert.ok(proposal.capabilityDigest)

  await assert.rejects(
    port.prepare(prepareIntent("specs", { operationId: "prepare-invalid", capabilityNames: ["../archive"] })),
    /invalid OpenSpec capability/,
  )
})

test("status and validation remain provider facts and do not mutate Runtime state", async () => {
  const { port, cli } = await setup()
  await port.prepare(prepareIntent())
  await writeFile(path.join(cli.active, "proposal.md"), "# Proposal")
  await writeFile(path.join(cli.active, "design.md"), "# Design")
  await mkdir(path.join(cli.active, "specs", "mail"), { recursive: true })
  await writeFile(path.join(cli.active, "specs", "mail", "spec.md"), "# Spec")
  await writeFile(path.join(cli.active, "tasks.md"), "# Tasks")
  const status = await port.status(taskRef())
  assert.equal(status.state, "complete")
  assert.equal(status.readyArtifacts.length, 0)
  assert.ok(status.artifactRefs.includes("openspec/changes/task-1/tasks.md"))
  const validation = await port.validate(taskRef())
  assert.equal(validation.valid, true)
  assert.equal(validation.complete, true)
  assert.equal(validation.providerRevision, status.providerRevision)
  assert.equal(validation.evidenceRefs.length, 1)
})

test("archive inspection rebuilds a confirmed receipt after the external archive succeeded", async () => {
  const projectRoot = await project()
  const cli = openSpecRunner(projectRoot)
  let crash = true
  const setupResult = await setup({
    projectRoot,
    cli,
    faultInjector: { afterArchive: async () => { if (crash) { crash = false; throw new Error("simulated archive receipt loss") } } },
  })
  await setupResult.port.prepare(prepareIntent())
  await writeFile(path.join(cli.active, "proposal.md"), "# Proposal")
  await writeFile(path.join(cli.active, "design.md"), "# Design")
  await mkdir(path.join(cli.active, "specs", "mail"), { recursive: true })
  await writeFile(path.join(cli.active, "specs", "mail", "spec.md"), "# Spec")
  await writeFile(path.join(cli.active, "tasks.md"), "# Tasks")
  const status = await setupResult.port.status(taskRef())
  const archiveIntent = effect({
    operationId: "archive-1",
    task: taskRef(),
    expectedProviderRevision: status.providerRevision,
  })
  await assert.rejects(setupResult.port.archive(archiveIntent), /simulated archive receipt loss/)
  assert.equal(cli.calls.filter(([command]) => command === "archive").length, 1)

  const restarted = await setup({ projectRoot, cli })
  const inspection = await restarted.port.inspect({ ...archiveIntent, kind: "archive" })
  assert.equal(inspection.status, "confirmed")
  assert.equal(inspection.result.status, "confirmed")
  assert.ok(inspection.result.archiveRefs.some((entry) => entry.endsWith("tasks.md")))
  assert.deepEqual(await restarted.port.archive(archiveIntent), inspection.result)
  assert.equal(cli.calls.filter(([command]) => command === "archive").length, 1)
})

test("OpenSpec operation ids reject content drift instead of adopting another artifact", async () => {
  const { port } = await setup()
  const proposal = prepareIntent()
  await port.prepare(proposal)
  const conflict = effect({ ...proposal, artifact: "design" })
  await assert.rejects(port.prepare(conflict), /conflicts/)
})
