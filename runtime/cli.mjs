#!/usr/bin/env node

import { executeRuntime } from "./core.mjs"

function parse(argv) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const name = token.slice(2)
    if (["json", "dry-run", "must-read", "repair", "force"].includes(name)) options[name] = true
    else options[name] = argv[++index]
  }
  const [resource, action] = positionals
  const command = ["init", "doctor", "version", "migrate"].includes(resource) ? resource : `${resource}.${action}`
  return {
    command,
    projectRoot: options.project ?? process.cwd(),
    dryRun: Boolean(options["dry-run"]),
    input: {
      taskId: options.task,
      platform: options.platform,
      sessionKey: options.session,
      title: options.title,
      entryStage: options["entry-stage"],
      contextId: options.context,
      kind: options.kind,
      path: options.path,
      profiles: options.profiles?.split(",").filter(Boolean),
      profile: options.profile,
      priority: options.priority,
      mustRead: Boolean(options["must-read"]),
      summary: options.summary,
      expectedRevision: options["expected-revision"],
      gateId: options.gate,
      status: options.status,
      reason: options.reason,
      actor: options.actor,
      blocker: options.blocker,
      evidenceId: options.evidence,
      evidenceRefs: options.evidence?.split(",").filter(Boolean),
      evidencePath: options["evidence-path"],
      outcome: options.outcome,
      to: options.to,
      workItemId: options.work,
      owner: options.owner,
      stage: options.stage,
      scope: options.scope,
      doneWhen: options["done-when"]?.split(",").filter(Boolean),
      artifactPaths: options.artifacts?.split(",").filter(Boolean),
      dependencies: options.dependencies?.split(",").filter(Boolean),
      scenario: options.scenario,
      scopeRefs: options["scope-refs"]?.split(",").filter(Boolean),
      summary: options.summary,
      question: options.question,
      requiredDecision: options["required-decision"],
      repair: Boolean(options.repair),
      force: Boolean(options.force),
      eventType: options.type,
      refs: options.refs?.split(",").filter(Boolean),
    },
  }
}

const result = await executeRuntime(parse(process.argv.slice(2)))
process.stdout.write(`${JSON.stringify(result.envelope)}\n`)
process.exitCode = result.exitCode
