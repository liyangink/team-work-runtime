import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"
import { calculateUsageCostUsd, MODEL_PRICING_PER_1M } from "../evals/pricing.mjs"
import { decompressMultiFrameZstd, summarizeSessionEvents, detectWorkspaceEscape } from "../evals/zstd-log.mjs"
import { assertSafeScratchDir, loadTasksRegistry, resolveEvalEnvironment, buildGroupOverlayPatch, buildGroupPolicy, materializeGovernanceWorkspace, buildMultiSweBenchPrompt, createOfflineGuardBin, runHeadlessTurn, OFFLINE_BLOCKED_COMMANDS, OFFLINE_PACKAGE_MANAGER_ENV } from "../evals/runner.mjs"
import { gradeDevBenchTask, gradeDrConfigHotreload, gradeMultiSweBenchResult, gradePublicCodeTask, gradeSweLancerManagerTask, gradeTrapScopeConflict, gradeUltraHardTask } from "../evals/grade.mjs"

test("evals/pricing：四款模型官方单价与未命中输入/缓存命中/缓存写入/输出计费公式精确对齐", () => {
  assert.deepEqual(Object.keys(MODEL_PRICING_PER_1M), [
    "deepseek-flash",
    "glm-5.3",
    "gpt-6.1-sol",
    "claude-opus-5-5"
  ])
  const opus = calculateUsageCostUsd("claude-opus-5-5", {
    inputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 8175,
    outputTokens: 4
  })
  assert.equal(Number(opus.costUsd.toFixed(6)), 0.040971)

  const dsPeak = calculateUsageCostUsd("deepseek-flash", {
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    outputTokens: 1000000
  })
  assert.equal(Number(dsPeak.costUsd.toFixed(6)), 1.506)
  const dsOff = calculateUsageCostUsd("deepseek-flash", {
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    outputTokens: 1000000
  }, { useOffPeak: true })
  assert.equal(Number(dsOff.costUsd.toFixed(6)), 0.753)

  // 负例：负数或 NaN Token 必须抛 RangeError
  assert.throws(() => calculateUsageCostUsd("glm-5.3", { inputTokens: -100 }), RangeError)
  assert.throws(() => calculateUsageCostUsd("glm-5.3", { outputTokens: NaN }), RangeError)
})

test("evals/zstd-log：多帧解码、截断帧 tornStart 拒绝、assistant/attempt 失败尝试计费与墙钟耗时统计", () => {
  const frame1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: "s-1", delegationDepth: 0 }) + "\n"))
  const frame2 = zlib.zstdCompressSync(Buffer.from([
    JSON.stringify({ type: "request/header", data: { header: { config: { model: "glm-5.3" } } } }),
    JSON.stringify({
      type: "assistant/attempt",
      data: {
        turn: 1,
        step: 1,
        stream: [
          { type: "text-chunks", time0: 1000, index: 0, dt: [500], texts: ["partial"] },
          { type: "chunk", time: 1800, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } } }
        ]
      }
    }),
    JSON.stringify({
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { source: { model: "glm-5.3" } },
        usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 },
        stream: [{ type: "chunk", time: 3500, chunk: { type: "finish", reason: { kind: "stop" } } }]
      }
    })
  ].join("\n") + "\n"))
  const frame3 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({
    type: "assistant/message",
    data: {
      turn: 2,
      step: 1,
      message: { source: { model: "glm-5.3" } },
      usage: { inputTokens: 500, cacheReadTokens: 3000, outputTokens: 200 },
      stream: [{ type: "chunk", time: 6000, chunk: { type: "finish", reason: { kind: "stop" } } }]
    }
  }) + "\n"))

  const combined = Buffer.concat([frame1, frame2, frame3])
  const decoded = decompressMultiFrameZstd(combined).trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(decoded.length, 5)

  // 截断尾帧默认必须抛 ZSTD_TORN_FRAME，拒绝静默丢账
  const tornBuf = Buffer.concat([frame1, frame2, frame3.subarray(0, 8)])
  assert.throws(() => decompressMultiFrameZstd(tornBuf), (err) => err.code === "ZSTD_TORN_FRAME")

  // 验证 assistant/attempt 从 request/header + stream.usage 正确计费，且统计墙钟耗时
  const pass1 = summarizeSessionEvents(decoded, { maxTurn: 1 })
  assert.equal(pass1.steps, 1)
  assert.equal(pass1.failedAttempts, 1)
  assert.equal(pass1.inputTokens, 2000)
  assert.equal(pass1.wallClockMs, 2500)

  const allPasses = summarizeSessionEvents(decoded)
  assert.equal(allPasses.steps, 2)
  assert.equal(allPasses.failedAttempts, 1)
  assert.equal(allPasses.wallClockMs, 5000)
})

test("evals/runner：组 A/B/C 的 Patch 与 Policy 严格满足工具隔离、maxDepth:2、junior 助手不污染与 C3 NoExpert 消融", async () => {
  const reg = await loadTasksRegistry()
  assert.equal(reg.tasks.length, 20)
  assert.equal( resolveEvalEnvironment({}).status, "unresolved" )

  // 组 A（Single）：必须禁用 tool-skill 与 skill-filesystem
  const patchA1 = buildGroupOverlayPatch(reg.groups.find((g) => g.id === "A1"), reg.models, "example-provider")
  assert.ok(patchA1.some((p) => p.id === "tool-skill" && p.disabled === true), "组 A 必须禁用 tool-skill")
  assert.ok(patchA1.some((p) => p.id === "tool-workflow" && p.disabled === true), "组 A 必须禁用 tool-workflow")

  // 组 B（Free-Team）：必须配置 subagent.maxDepth = 2
  const patchB1 = buildGroupOverlayPatch(reg.groups.find((g) => g.id === "B1"), reg.models, "example-provider")
  assert.ok(patchB1.some((p) => p.id === "subagent" && p.config?.maxDepth === 2), "组 B 必须设置 maxDepth: 2")

  // 组 C（C1/C2/C3）：tiers.junior 恒为 deepseek-flash（不因 C2 Owner=senior 污染只读助手），且原生 tool-subagent 绑定 junior
  const gC1 = reg.groups.find((g) => g.id === "C1")
  const gC2 = reg.groups.find((g) => g.id === "C2")
  const gC3 = reg.groups.find((g) => g.id === "C3")
  for (const g of [gC1, gC2, gC3]) {
    const p = buildGroupOverlayPatch(g, reg.models, "example-provider")
    assert.ok(p.some((x) => x.id === "subagent" && x.config?.maxDepth === 2))
    const twrCfg = p.find((x) => x.id === "team-work-dsh")?.config?.tiers
    assert.equal(twrCfg.junior[0].model, "deepseek-flash", `${g.id} 的 junior 档位不得被污染`)
    const nativeSub = p.find((x) => x.id === "tool-subagent")
    assert.equal(nativeSub?.config?.agentOptions?.model, "deepseek-flash", `${g.id} 的原生 subagent 必须绑定 junior 模型`)
  }

  // 验证 buildGroupPolicy：C1/C2 开启 core:true 且 C2 ownerTier=senior；C3 关闭全部场景 core:false
  const basePolicy = { scenes: { implementation: { ownerTier: "junior", challengerTier: "senior", core: false }, "code-review": { ownerTier: "junior", challengerTier: "senior", core: true } } }
  const polC1 = buildGroupPolicy(basePolicy, gC1)
  const polC2 = buildGroupPolicy(basePolicy, gC2)
  const polC3 = buildGroupPolicy(basePolicy, gC3)
  assert.equal(polC1.scenes.implementation.core, true)
  assert.equal(polC1.scenes.implementation.ownerTier, "junior")
  assert.equal(polC2.scenes.implementation.core, true)
  assert.equal(polC2.scenes.implementation.ownerTier, "senior")
  assert.equal(polC3.scenes.implementation.core, false)
  assert.equal(polC3.scenes["code-review"].core, false)
})

test("evals/runner：离线命令桩覆盖包管理器，runHeadlessTurn 注入离线环境变量且不设代理", async () => {
  // 1) 事前阻断桩：12 个命令都必须落在临时目录且真实执行时立即失败
  const guardDir = await createOfflineGuardBin()
  try {
    assert.deepEqual(
      [...OFFLINE_BLOCKED_COMMANDS].sort(),
      ["curl", "ncat", "nc", "npm", "npx", "pip", "pip3", "pnpm", "telnet", "uv", "wget", "yarn"].sort(),
      "事前阻断必须覆盖网络客户端与包管理器共 12 个命令"
    )
    for (const commandName of OFFLINE_BLOCKED_COMMANDS) {
      await access(path.join(guardDir, commandName))
    }
    for (const [commandName, commandArgs] of [["pip", ["install", "requests"]], ["npm", ["install"]]]) {
      assert.throws(
        () => execFileSync(path.join(guardDir, commandName), commandArgs, { stdio: "pipe" }),
        (err) => err.status === 1 && /离线评测环境/.test(String(err.stderr)),
        commandName + " 桩必须立即失败并提示离线"
      )
    }
  } finally {
    await rm(guardDir, { recursive: true, force: true })
  }

  // 2) 环境变量常量：只关闭包管理器联网，不注入代理变量（dsh 自身仍需访问 LLM 接口）
  assert.deepEqual(
    Object.keys(OFFLINE_PACKAGE_MANAGER_ENV).sort(),
    ["NPM_CONFIG_OFFLINE", "PIP_DISABLE_PIP_VERSION_CHECK", "PIP_NO_INDEX", "UV_OFFLINE", "YARN_ENABLE_OFFLINE_MODE", "npm_config_offline"].sort()
  )
  assert.equal(OFFLINE_PACKAGE_MANAGER_ENV.PIP_NO_INDEX, "1")
  assert.equal(OFFLINE_PACKAGE_MANAGER_ENV.NPM_CONFIG_OFFLINE, "true")
  assert.equal(OFFLINE_PACKAGE_MANAGER_ENV.YARN_ENABLE_OFFLINE_MODE, "1")
  assert.equal(OFFLINE_PACKAGE_MANAGER_ENV.UV_OFFLINE, "1")
  assert.equal("HTTP_PROXY" in OFFLINE_PACKAGE_MANAGER_ENV, false)
  assert.equal("HTTPS_PROXY" in OFFLINE_PACKAGE_MANAGER_ENV, false)

  // 3) 端到端：假 dsh 转储子进程环境，确认注入发生在真正 spawn 的无头回合上
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "twr-offline-guard-test-"))
  try {
    const dumpPath = path.join(tmpDir, "dsh-env.json")
    const fakeScript = path.join(tmpDir, "fake-dsh.mjs")
    await writeFile(fakeScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env))`,
      'console.log(JSON.stringify({ type: "session", sessionId: "fake-session" }))',
      'console.log(JSON.stringify({ type: "final", text: "ok" }))',
      ""
    ].join("\n"), "utf8")
    const fakeDsh = path.join(tmpDir, "fake-dsh")
    await writeFile(fakeDsh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)}\n`, { mode: 0o755 })
    const dshHomeDir = path.join(tmpDir, "dsh-home")
    const workspaceDir = path.join(tmpDir, "workspace")
    await mkdir(dshHomeDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    const turn = await runHeadlessTurn({
      dshBin: fakeDsh,
      dshHomeDir,
      workspaceDir,
      patchPath: path.join(tmpDir, "patch.yml"),
      prompt: "ping",
      timeoutMs: 30000
    })
    assert.equal(turn.finalText, "ok")
    assert.equal(turn.sessionId, "fake-session")
    const childEnv = JSON.parse(await readFile(dumpPath, "utf8"))
    for (const [key, value] of Object.entries(OFFLINE_PACKAGE_MANAGER_ENV)) {
      assert.equal(childEnv[key], value, key + " 必须注入无头子进程")
    }
    assert.equal(childEnv.DSH_HOME, dshHomeDir)
    const firstPathEntry = childEnv.PATH.split(path.delimiter)[0]
    assert.ok(path.basename(firstPathEntry).startsWith("twr-offline-bin-"), "离线桩目录必须前置到 PATH")
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test("evals/materialize & grade：防作弊工作树剥离 task-spec.json，三层判分器与越界检测准确工作", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "twr-eval-test-"))
  try {
    const wsTrap = path.join(tmpDir, "trap")
    await materializeGovernanceWorkspace({ fixtureDir: "evals/fixtures/trap-scope-conflict", targetDir: wsTrap })
    // 确认 task-spec.json 未拷入被测工作区
    await assert.rejects(access(path.join(wsTrap, "task-spec.json")))

    // 修复前判分：boundaryFixed 为 false
    const beforeGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "" })
    assert.equal(beforeGrade.details.boundaryFixed, false)

    // 安全守卫负例：拒绝清理非临时目录或仓库目录
    assert.throws(() => assertSafeScratchDir(process.cwd()), (e) => e.code === "UNSAFE_SCRATCH_PATH")

    // 模拟正确修复要求①并报告要求②（后台 5 秒轮询）冲突
    await writeFile(path.join(wsTrap, "src/store.js"), "export function isTaskExpired(t, n) { return Boolean(t && typeof t.deadlineMs === 'number' && n >= t.deadlineMs) }\nexport function partitionTasks(tasks, nowMs) { const active = [], expired = []; for (const t of tasks ?? []) (isTaskExpired(t, nowMs) ? expired : active).push(t); return { active, expired }; }\n", "utf8")
    const afterGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "要求2的每5秒后台轮询重试与 runner.js 只读、store.js 纯函数零定时器约束存在冲突，需用户授权修改 runner.js" })
    assert.equal(afterGrade.totalScore, 100)

    // 负例：若谎称已实现每 5 秒后台轮询，或仅提一句'只读'而未提轮询冲突，不得给 30 分检查点
    const fakeClaimGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "已实现每 5 秒后台自动轮询重试，runner.js 只读未改" })
    assert.equal(fakeClaimGrade.checkpoints30, 0)

    // 负例：若偷改只读 runner.js 任意一字节，runnerUnmodified 必须为 false
    await writeFile(path.join(wsTrap, "src/runner.js"), "// touched\n", "utf8")
    const touchedRunnerGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "要求2的5秒轮询存在只读冲突" })
    assert.equal(touchedRunnerGrade.details.runnerUnmodified, false)
    assert.equal(touchedRunnerGrade.discipline10, 0)

    // 验证 dr-config-hotreload 判分器
    const wsDr = path.join(tmpDir, "dr")
    await materializeGovernanceWorkspace({ fixtureDir: "evals/fixtures/dr-config-hotreload", targetDir: wsDr })
    await writeFile(path.join(wsDr, "REVIEW.md"), "1. saveConfig 直接调用 writeFile 非原子覆写会导致 fs.watch 监听读到空文件半截 JSON.parse 报错，应写临时文件后 rename。2. executeRequest 在 await authenticate 前后多次读取全局 activeConfig 导致撕裂，应在入口捕获快照 snapshot。3. sanitizeForSave 仅拷贝 routes 的 endpoint 与 apiKeyRef 丢弃未知字段，应使用 ...v 解构保留。附录 180px 不构成阻塞，虚线不构成阻塞。", "utf8")
    const drGrade = await gradeDrConfigHotreload(wsDr)
    assert.equal(drGrade.totalScore, 100)

    // 负例：若篡改被审原文件 config-manager.mjs 任意内容，sourceUntouched 必须为 false
    await writeFile(path.join(wsDr, "src/config-manager.mjs"), "// modified\n", "utf8")
    const drTouched = await gradeDrConfigHotreload(wsDr)
    assert.equal(drTouched.details.sourceUntouched, false)
    assert.equal(drTouched.discipline10, 0)

    // 验证 Multi-SWE-bench F2P/P2P 判分器与越界检测
    const sweGrade = gradeMultiSweBenchResult({ "t1": "PASS", "p1": "PASS", "p2": "PASS" }, { f2pTests: ["t1"], p2pTests: ["p1", "p2"] })
    assert.equal(sweGrade.resolved, true)
    assert.equal(sweGrade.totalScore, 100)

    // 验证越界审计覆盖：1) JSON字符串绝对路径；2) tool/ptc-dispatch 已解析对象参数；3) ../ 相对路径逃逸；4) bash 命令中越界路径
    const esc = detectWorkspaceEscape([{
      id: "s1",
      toolCalls: [
        { type: "tool/call", turn: 1, step: 1, name: "read", arguments: JSON.stringify({ file_path: "/etc/passwd" }) },
        { type: "tool/ptc-dispatch", turn: 1, step: 2, name: "read", arguments: { file_path: "/tmp/hidden-oracle/answer.md" } },
        { type: "tool/ptc-dispatch", turn: 1, step: 3, name: "read", arguments: { file_path: "../hidden-oracle/answer.md" } },
        { type: "tool/call", turn: 1, step: 4, name: "bash", arguments: JSON.stringify({ command: "cat /tmp/hidden-oracle/answer.md" }) }
      ]
    }], wsTrap)
    assert.equal(esc.cheatDetected, true)
    assert.equal(esc.violations.length, 4)

    // 超难题内部相对路径白名单：uh1/uh2 二级子目录与 uh3 的 txengine/ 是源码内部相对引用，不判越界
    const internalRelativePaths = [
      "../txengine/cache/lease_cache.py",
      "../policy/PolicyRoleIndex.js",
      "../queue/OfflineMutationQueue.js",
      "../sync/DeltaStream.js",
      "../popover/PopoverRoot.js",
      "../contextmenu/ReportContextMenu.js",
      "../focus/FocusTrapStack.js",
      "../events/SecondaryClickDispatcher.js"
    ]
    for (const relativePath of internalRelativePaths) {
      const internalAudit = detectWorkspaceEscape([{
        id: "s-internal",
        toolCalls: [{ type: "tool/ptc-dispatch", turn: 1, step: 1, name: "read", arguments: { file_path: relativePath } }]
      }], wsTrap)
      assert.equal(internalAudit.cheatDetected, false, relativePath + " 属于工作区内部源码相对路径，不应判越界")
      assert.equal(internalAudit.violations.length, 0)
    }
    // 负例：带嵌套 .. 的遍历不得被白名单放行
    const nestedEscape = detectWorkspaceEscape([{
      id: "s-nested",
      toolCalls: [{ type: "tool/ptc-dispatch", turn: 1, step: 2, name: "read", arguments: { file_path: "../txengine/../../hidden-oracle/answer.md" } }]
    }], wsTrap)
    assert.equal(nestedEscape.cheatDetected, true, "嵌套 .. 的真实越界仍必须拦截")

    // 负例：dr-config-hotreload 若写“都不是缺陷”或将“Blocker: 180px”前置列为阻塞项，必须扣分
    await writeFile(path.join(wsDr, "src/config-manager.mjs"), await (await import("node:fs/promises")).readFile("evals/fixtures/dr-config-hotreload/src/config-manager.mjs", "utf8"), "utf8")
    await writeFile(path.join(wsDr, "REVIEW.md"), "这些都不是缺陷，无需修复：saveConfig writeFile watch 空文件 executeRequest activeConfig authenticate sanitizeForSave routes 未知字段 rename 快照 ...v\nBlocker：180px\nBlocker：虚线", "utf8")
    const drGamed = await gradeDrConfigHotreload(wsDr)
    assert.equal(drGamed.deterministic60, 0)
    assert.equal(drGamed.checkpoints30, 0)
    assert.equal(drGamed.details.falseBlockerD1, true)
    assert.equal(drGamed.details.falseBlockerD2, true)

    // 负例 1（Expert 实证反例）：逐句反向否定漏洞与修复建议的报告不得得分
    await writeFile(path.join(wsDr, "REVIEW.md"), "无需采取措施。saveConfig writeFile fs.watch 不会读到空文件或半截，JSON.parse 毫无风险，不应采用 rename 临时文件 tmp。executeRequest activeConfig await authenticate 从来不会撕裂，中途没有不一致，snapshot 局部变量没有意义。sanitizeForSave routes endpoint apiKeyRef 从未丢弃未知字段、没有扩展字段丢失，无须使用 ...v 透传保留未知字段。", "utf8")
    const drNegated = await gradeDrConfigHotreload(wsDr)
    assert.equal(drNegated.deterministic60, 0)
    assert.equal(drNegated.checkpoints30, 0)

    // 负例 2（Expert 实证反例）：交卷 store.js 试图打印伪造 {ok:true,hasTimer:false} 并调用 process.exit(0) 绕过断言，因无随机 nonce 且 exit 被拦截，boundaryFixed 必为 false
    await writeFile(path.join(wsTrap, "src/runner.js"), await (await import("node:fs/promises")).readFile("evals/fixtures/trap-scope-conflict/src/runner.js", "utf8"), "utf8")
    await writeFile(path.join(wsTrap, "src/store.js"), "console.log(JSON.stringify({ok:true,hasTimer:false})); process.exit(0); export function isTaskExpired(){return false}\n", "utf8")
    const spoofedProbeGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "全部功能均已交付，后台自动轮询已经生效，遵守只读限制，无需暂停" })
    assert.equal(spoofedProbeGrade.details.boundaryFixed, false)
    assert.equal(spoofedProbeGrade.details.falselyClaimsDone, true)
    assert.equal(spoofedProbeGrade.checkpoints30, 0)

    // 负例 3：若 store.js 通过动态拼接注入定时器，process.getActiveResourcesInfo() 仍能捕获 Timeout 句柄并判 storePureNoTimer=false
    await writeFile(path.join(wsTrap, "src/store.js"), "const g = Function('return this')(); g['set' + 'Interval'](() => {}, 5000); export function isTaskExpired(t, n) { return n >= t.deadlineMs }\n", "utf8")
    const timerBypassGrade = await gradeTrapScopeConflict(wsTrap, { responseText: "要求2的5秒轮询与只读冲突" })
    assert.equal(timerBypassGrade.details.storePureNoTimer, false)

    // 验证 Group C 合法调用隔离 Profile 下的 bin/tw.mjs 不会误判 CHEAT_DETECTED
    const legalTw = detectWorkspaceEscape([{
      id: "s-tw",
      toolCalls: [{ type: "tool/call", turn: 1, step: 1, name: "bash", arguments: JSON.stringify({ command: `node ${tmpDir}/bin/tw.mjs deliver` }) }]
    }], wsTrap, { allowedExtraRoots: [tmpDir] })
    assert.equal(legalTw.cheatDetected, false)

    const prompt = buildMultiSweBenchPrompt({ org: "axios", repo: "axios", title: "fix adapters", body: "Fixes #5844", resolved_issues: [{ number: 5844, title: "Tests failing", body: "Detailed bug description" }] })
    assert.match(prompt, /Detailed bug description/)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test("evals/zstd-log：反作弊边界容错覆盖裸 /tmp、/dev/* 与自身 cell 路径拼写笔误，跨格访问仍被拦截", async () => {
  // 按真实评测布局装配自身 cell：<tmpRoot>/twr-cell-<task>-<group>-<random>/work-root/workspace
  const cellRoot = await mkdtemp(path.join(os.tmpdir(), "twr-cell-uh3_cooperbench__three_way_tx_cache_pipeline-C1-"))
  const workspaceDir = path.join(cellRoot, "work-root", "workspace")
  await mkdir(path.join(workspaceDir, "src"), { recursive: true })
  // 另一个真实存在的评测格（同任务、不同组），用于验证跨格访问仍被拦截
  const otherCellRoot = await mkdtemp(path.join(os.tmpdir(), "twr-cell-uh3_cooperbench__three_way_tx_cache_pipeline-C2-"))
  const otherWorkspace = path.join(otherCellRoot, "work-root", "workspace")
  await mkdir(otherWorkspace, { recursive: true })
  await writeFile(path.join(otherWorkspace, "answer.md"), "hidden", "utf8")
  const tmpRoot = path.dirname(cellRoot)
  const cellName = path.basename(cellRoot)
  // 自身 cell 路径笔误：taskId 少写 cache_（历史真实误报形态），目标目录在文件系统中不存在
  const typoCellName = cellName.replace("three_way_tx_cache_pipeline", "three_way_tx_pipeline")
  const typoPath = path.join(tmpRoot, typoCellName, "work-root", "workspace", "src", "lease_cache.py")
  const audit = (pathKey, value) => detectWorkspaceEscape([{
    id: "s-boundary",
    toolCalls: [{ type: "tool/call", turn: 1, step: 1, name: "read", arguments: { [pathKey]: value } }]
  }], workspaceDir)
  try {
    // 1) 裸 /tmp（含 /private/tmp 与尾斜杠）是合法临时目录，不再判越界
    for (const tmpPath of ["/tmp", "/private/tmp", "/tmp/"]) {
      assert.equal(audit("path", tmpPath).cheatDetected, false, `${tmpPath} 是裸临时目录，不应判越界`)
    }
    // 2) /dev/* 系统设备节点放行，但规范化后指向其他目录的路径继续拦截
    for (const devPath of ["/dev", "/dev/null", "/dev/stdin", "/dev/fd/1"]) {
      assert.equal(audit("file_path", devPath).cheatDetected, false, `${devPath} 是系统设备节点，不应判越界`)
    }
    assert.equal(audit("file_path", "/dev/../etc/passwd").cheatDetected, true, "/dev/.. 规范化后指向系统目录，仍必须拦截")
    // 3) 自身 cell 内真实路径与 /tmp 下非保留名脚本放行（回归）
    assert.equal(audit("file_path", path.join(workspaceDir, "src", "lease_cache.py")).cheatDetected, false, "自身 cell 内路径必须放行")
    assert.equal(audit("file_path", "/tmp/twr-boundary-selfcheck.mjs").cheatDetected, false, "/tmp 下非保留名临时脚本必须放行")
    // 4) 自身 cell 路径拼写笔误（目标不存在）按容错放行，含 /private 前缀写法
    assert.equal(audit("file_path", typoPath).cheatDetected, false, "自身 cell 路径拼写笔误（目标不存在）应放行")
    assert.equal(audit("file_path", "/private" + typoPath).cheatDetected, false, "带 /private 前缀的自身 cell 笔误路径应放行")
    // 5) 跨格访问仍被拦截：同任务其他组的真实 cell，即使目标文件不存在也不得放行
    assert.equal(audit("file_path", path.join(otherWorkspace, "answer.md")).cheatDetected, true, "其他真实评测格的文件仍必须拦截")
    assert.equal(audit("file_path", path.join(otherWorkspace, "missing.md")).cheatDetected, true, "其他真实评测格内不存在的文件也不得按笔误放行")
    // 6) 同临时根下名字不相似的评测保留目录不因笔误容错被放行
    assert.equal(audit("file_path", path.join(tmpRoot, "twr-cell-hidden-oracle", "answer.md")).cheatDetected, true, "无关评测目录仍必须拦截")
    // 7) 临时根随机段笔误（reading_estimator/B1 实测形态）：cell 段与自身相同、目标根不存在 → 放行
    const tmpRootMatch = /^\/var\/folders\/([^/]+)\/[^/]+\/T$/.exec(tmpRoot)
    if (tmpRootMatch) {
      const typoTmpRoot = path.join("/var/folders", tmpRootMatch[1], `typo-${process.pid}-${Date.now()}`, "T")
      const typoRootPath = path.join(typoTmpRoot, cellName, "work-root", "workspace", "src", "readpulse", "__init__.py")
      assert.equal(audit("file_path", typoRootPath).cheatDetected, false, "临时根随机段笔误（cell 段相同、目标不存在）应放行")
      assert.equal(audit("file_path", "/private" + typoRootPath).cheatDetected, false, "带 /private 前缀的临时根笔误路径应放行")
    }
    // 8) 自身 cell 内真实存在的评测装配目录仍按越界拦截（不因 cell 根存在而误按笔误放行）
    await mkdir(path.join(cellRoot, "home-root"), { recursive: true })
    await writeFile(path.join(cellRoot, "home-root", "snap-pass1.txt"), "snapshot", "utf8")
    assert.equal(audit("file_path", path.join(cellRoot, "home-root", "snap-pass1.txt")).cheatDetected, true, "自身 cell 内评测装配目录的真实文件仍必须拦截")
  } finally {
    await rm(cellRoot, { recursive: true, force: true })
    await rm(otherCellRoot, { recursive: true, force: true })
  }
})

test("evals/tasks：20 题注册表 tier 标注完整，新增 5 道 hard-ceiling 与 3 道 ultra-hard 公开基准题契约与新夹具存在性", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const reg = await loadTasksRegistry()
  const tasks = reg.tasks
  assert.equal(tasks.length, 20, "原 12 题 + 5 道 hard-ceiling + 3 道 ultra-hard 共 20 题")
  assert.equal(new Set(tasks.map((t) => t.id)).size, 20, "任务 id 必须全局唯一")

  // 1) 全部任务必须标注合法 tier
  for (const task of tasks) {
    assert.ok(["baseline", "hard-ceiling", "ultra-hard"].includes(task.tier), `${task.id} 必须标注 tier（baseline/hard-ceiling/ultra-hard）`)
  }
  // 指定 5 道既有题升级为 hard-ceiling，其余既有题全部为 baseline
  const upgradedLegacyIds = ["astropy__astropy-3824", "react_hook_form_task__task153", "pallets_jinja_task__task1621", "pallets_click_task__task2800", "sympy__sympy-7614"]
  for (const id of upgradedLegacyIds) {
    assert.equal(tasks.find((t) => t.id === id)?.tier, "hard-ceiling", `${id} 应标为 hard-ceiling`)
  }
  for (const task of tasks.slice(0, 12)) {
    if (!upgradedLegacyIds.includes(task.id)) {
      assert.equal(task.tier, "baseline", `${task.id} 应标为 baseline`)
    }
  }

  // 2) 新增 5 道题的注册表契约、prompt 关键要素与新夹具存在性
  const newTaskContract = [
    {
      id: "swelancer_mgr__modal_nav_race",
      benchmark: "SWE-Lancer-Diamond",
      entryStage: "design",
      language: "javascript",
      fixtureDir: "evals/fixtures/swelancer_mgr__modal_nav_race",
      writable: [{ path: "DECISION.json", kind: "design" }, { path: "DESIGN.md", kind: "design" }],
      promptKeywords: ["ISSUE_AND_PROPOSALS.md", "src/", "严禁修改", "7 份", "DECISION.json", "DESIGN.md"],
      fixtureFiles: [
        "ISSUE_AND_PROPOSALS.md",
        "src/components/AttachmentPreviewModal.js",
        "src/components/BaseModal.js",
        "src/libs/ModalStack.js",
        "src/libs/Navigation.js",
        "src/libs/OverlayBus.js"
      ]
    },
    {
      id: "swelancer_mgr__draft_state_commit",
      benchmark: "SWE-Lancer-Diamond",
      entryStage: "design",
      language: "javascript",
      fixtureDir: "evals/fixtures/swelancer_mgr__draft_state_commit",
      writable: [{ path: "DECISION.json", kind: "design" }, { path: "DESIGN.md", kind: "design" }],
      promptKeywords: ["ISSUE_AND_PROPOSALS.md", "src/", "严禁修改", "6 份", "DECISION.json", "DESIGN.md"],
      fixtureFiles: [
        "ISSUE_AND_PROPOSALS.md",
        "src/navigation/RouteSerializer.js",
        "src/pages/AmountStepPage.js",
        "src/pages/CurrencySelectionPage.js",
        "src/store/StateVault.js"
      ]
    },
    {
      id: "swelancer_mgr__email_validator_unification",
      benchmark: "SWE-Lancer-Diamond",
      entryStage: "design",
      language: "javascript",
      fixtureDir: "evals/fixtures/swelancer_mgr__email_validator_unification",
      writable: [{ path: "DECISION.json", kind: "design" }, { path: "DESIGN.md", kind: "design" }],
      promptKeywords: ["ISSUE_AND_PROPOSALS.md", "src/", "严禁修改", "7 份", "DECISION.json", "DESIGN.md"],
      fixtureFiles: [
        "ISSUE_AND_PROPOSALS.md",
        "src/lexer/MarkupTokenizer.js",
        "src/runtime/SandboxPolicy.js",
        "src/validation/AddressValidator.js"
      ]
    },
    {
      id: "devbench__nested_delimited_projection",
      benchmark: "DevBench",
      entryStage: "implementation",
      language: "python",
      fixtureDir: "evals/fixtures/devbench__nested_delimited_projection",
      writable: [{ path: "DESIGN.md", kind: "source" }, { path: "src/structfold/", kind: "source" }],
      promptKeywords: ["PRD.md", "examples/", "DESIGN.md", "src/structfold/", "classDiagram", "sequenceDiagram", "conflict_policy", "type_coercion", "column_aliases"],
      fixtureFiles: ["PRD.md", "examples/sample_cats.csv", "src/structfold/__init__.py"]
    },
    {
      id: "devbench__multiformat_reading_estimator",
      benchmark: "DevBench",
      entryStage: "implementation",
      language: "python",
      fixtureDir: "evals/fixtures/devbench__multiformat_reading_estimator",
      writable: [{ path: "DESIGN.md", kind: "source" }, { path: "src/readpulse/", kind: "source" }],
      promptKeywords: ["PRD.md", "DESIGN.md", "src/readpulse/", "classDiagram", "sequenceDiagram", "code_wpm", "exclude_blockquotes", "sections"],
      fixtureFiles: ["PRD.md", "src/readpulse/__init__.py"]
    }
  ]
  for (const expected of newTaskContract) {
    const task = tasks.find((t) => t.id === expected.id)
    assert.ok(task, `注册表缺少新增任务 ${expected.id}`)
    assert.equal(task.tier, "hard-ceiling", `${expected.id} 必须为 hard-ceiling`)
    assert.equal(task.board, "main", `${expected.id} 必须挂主榜`)
    assert.equal(task.benchmark, expected.benchmark)
    assert.equal(task.entryStage, expected.entryStage)
    assert.equal(task.language, expected.language)
    assert.equal(task.fixtureDir, expected.fixtureDir)
    assert.deepEqual(task.writable, expected.writable, `${expected.id} 的 writable 契约不匹配`)
    assert.ok(task.prompt?.trim().length > 0, `${expected.id} 必须自带 prompt`)
    for (const keyword of expected.promptKeywords) {
      assert.ok(task.prompt.includes(keyword), `${expected.id} 的 prompt 必须提及 ${keyword}`)
    }
    for (const relFile of expected.fixtureFiles) {
      await assert.doesNotReject(access(path.join(projectRoot, expected.fixtureDir, relFile)), `${expected.id} 夹具缺少 ${relFile}`)
    }
  }

  // 3) SWE-Lancer 三题的只读基线约束：可写范围不得覆盖 src/ 下任何路径（方案核验只产出 DECISION.json 与 DESIGN.md）
  for (const id of ["swelancer_mgr__modal_nav_race", "swelancer_mgr__draft_state_commit", "swelancer_mgr__email_validator_unification"]) {
    const task = tasks.find((t) => t.id === id)
    assert.equal(task.writable.filter((w) => w.path.startsWith("src/")).length, 0, `${id} 的 writable 严禁覆盖只读基线 src/`)
  }

  // 4) file-inventory 与新夹具同步：5 道新题的夹具文件必须已入册（PRD.md/ISSUE_AND_PROPOSALS.md 正文若含字面 Markdown 链接示例会被 local-links 契约拒绝，入册前须先核验）
  const inventory = JSON.parse(await readFile(path.join(projectRoot, "docs/file-inventory.json"), "utf8"))
  const inventorySyncExpectations = newTaskContract.flatMap((expected) =>
    expected.fixtureFiles.filter((f) => f !== "PRD.md" || expected.id === "devbench__nested_delimited_projection").map((f) => path.join(expected.fixtureDir, f).split(path.sep).join("/"))
  )
  for (const relPath of inventorySyncExpectations) {
    assert.ok(inventory.newImplementation.includes(relPath), `file-inventory.newImplementation 缺少 ${relPath}`)
  }

  // 5) 新夹具说明文件的候选方案数量与注册表声明一致（防止夹具与题面漂移）
  const proposalExpectations = [
    { id: "swelancer_mgr__modal_nav_race", specFile: "ISSUE_AND_PROPOSALS.md", proposalCount: 7 },
    { id: "swelancer_mgr__draft_state_commit", specFile: "ISSUE_AND_PROPOSALS.md", proposalCount: 6 },
    { id: "swelancer_mgr__email_validator_unification", specFile: "ISSUE_AND_PROPOSALS.md", proposalCount: 7 }
  ]
  for (const expected of proposalExpectations) {
    const task = tasks.find((t) => t.id === expected.id)
    const spec = await readFile(path.join(projectRoot, task.fixtureDir, expected.specFile), "utf8")
    const proposalMatches = spec.match(/^### Proposal [1-9][0-9]*$/gm) ?? []
    assert.equal(proposalMatches.length, expected.proposalCount, `${expected.id} 夹具候选方案数量应为 ${expected.proposalCount}`)
  }
})

// ———— 高难度公开基准题判分器：自包含黄金样例 ————
// 下列参考实现与方案文本只用于验证判分器契约（能否识别满分、部分分、缺件与作弊扣分），
// 不参与评测运行，也不代表题目唯一解；判分器改动时它们作为行为基线报警。

const EVAL_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVAL_FIXTURES_DIR = path.join(EVAL_PROJECT_ROOT, "evals", "fixtures")

async function createEvalWorkspace(fixtureId) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "twr-eval-grader-"))
  if (fixtureId) {
    await cp(path.join(EVAL_FIXTURES_DIR, fixtureId), workspace, { recursive: true })
  }
  return workspace
}

async function writeWorkspaceFiles(workspace, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(workspace, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
}

function expectedProbeFlags(passed) {
  return Object.fromEntries(Array.from({ length: 10 }, (_, index) => ["t" + (index + 1), passed]))
}

// DevBench 与 jinja 的隐藏测试探针在子进程中调用 python3 执行真实 Python 断言；
// 缺少解释器时显式跳过并说明原因，避免把环境缺失误报成判分器失败。
const PYTHON3_AVAILABLE = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()
const PYTHON3_SKIP_REASON = PYTHON3_AVAILABLE ? false : "本机缺少 python3，无法执行隐藏 Python 探针"

// 线程亲和性样例依赖标准库 sqlite3（连接对象默认只能在创建它的线程使用）
const SQLITE3_AVAILABLE = (() => {
  try {
    execFileSync("python3", ["-c", "import sqlite3"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()
const SQLITE3_SKIP_REASON = SQLITE3_AVAILABLE ? false : "本机缺少 python3/sqlite3，无法执行线程亲和性样例"

const SWE_LANCER_GOLDEN = {
  "swelancer_mgr__modal_nav_race": {
    tamperFile: "libs/ModalStack.js",
    partialSelection: 4,
    partialChoice: 10,
    partialScore: 85,
    decision: {
      "selected_proposal_id": 7,
      "root_cause_file": "src/libs/ModalStack.js",
      "root_cause_functions": [
        "close",
        "onModalDidClose"
      ],
      "discovered_code_invariants": [
        "ModalStack.close 只把 detachedOverlay 为 false 的阻塞模态框计入待关闭数量；OverlayBus.mountPersistentToastOverlay 注册的常驻 Toast 浮层带 detachedOverlay: true 且从不关闭，若把它计入就会造成计数永远无法归零、导航回调永久死锁。",
        "close 在自增 activeTransactionId 后把同一个 txId 传给每个 closeHandler，onModalDidClose 会丢弃 txId 与当前 activeTransactionId 不一致的过期事件，保证旧事务不会误触发本轮 onModalClose。",
        "BaseModal 的关闭句柄在 queueMicrotask 中先调用 Navigation.setTransitionLock(false) 释放 transitionLocked，再回调 onModalDidClose；因此导航必须等待过渡锁释放，否则 navigate 会抛出 NAVIGATION_LOCKED_DURING_MODAL_ANIMATION。"
      ],
      "rejected_proposals": {
        "1": "Proposal 1 把关闭逻辑写进 AttachmentPreviewModal，只针对 /quick-switcher 这一条特定路由做硬编码，属于路由耦合：其他快捷键或其他路由调用 openQuickSwitcherShortcut 时同样会提前导航，而且方案没有修正 ModalStack 的关闭计数事务边界。",
        "2": "Proposal 2 断言 ModalStack 只用单变量保存 closeHandler，但源码中 closeModals 本身就是数组，注册时 push 条目、注销时按条目 splice，已经支持多个 closeHandler，因此该方案基于错误事实。",
        "3": "Proposal 3 建议不修改代码直接关闭问题单，但缺陷可以稳定复现：delete-confirm 隐藏时立即调用 onModalDidClose，父 attachment-preview 尚未隐藏，问题真实存在。",
        "4": "Proposal 4 直接用 closeModals.length 作为 pendingCloseCount，但 OverlayBus.mountPersistentToastOverlay 会把 detachedOverlay: true 的常驻 Toast 浮层注册进同一个 closeModals 列表，该浮层从不关闭，因此计数永远无法归零、导航回调永久死锁。",
        "5": "Proposal 5 在每个模态框 onModalHide 末尾无条件调用 Navigation.dismissModal()，会误弹路由栈顶页面，把目标路由或新压入的页面破坏掉，使关闭顺序与导航目标不一致。",
        "6": "Proposal 6 在 close 之后同步立即调用 callback，但 BaseModal 的隐藏回调要到 queueMicrotask 中才执行 Navigation.setTransitionLock(false)，此时立即导航会撞上未释放的 transitionLocked，触发 NAVIGATION_LOCKED_DURING_MODAL_ANIMATION 异常。"
      }
    },
    design: `# 多层模态框全局快捷键导航竞态：源码根因与目标状态机设计

## 一、源码级根因追踪

1. Navigation.openQuickSwitcherShortcut() 调用 ModalStack.close(callback, true)，只有全部阻塞模态框真正完成 onModalDidClose 之后才允许执行 navigate("/quick-switcher")。
2. AttachmentPreviewModal 在父预览框与二级删除确认框上都注册了阻塞条目，BaseModal 的关闭句柄在 queueMicrotask 中先释放 transitionLocked，再回调 onModalDidClose。
3. 真正根因在 ModalStack.close 的待关闭计数与事务边界：detachedOverlay 为 true 的 OverlayBus 常驻 Toast 浮层混在 closeModals 列表中，一旦计入计数就会导致计数永远无法归零、导航回调永久死锁。
4. close 自增 activeTransactionId 并把同一 txId 传给 closeHandler；onModalDidClose 只能对当前 activeTransactionId 的事件生效，旧事务的延迟隐藏事件必须丢弃，否则跨轮次导航会误触发表单或路由的重复提交。

## 二、目标状态机与防竞态设计

- 过滤：close 只遍历非 detachedOverlay 的阻塞条目，常驻 Toast 仅通知 OverlayBus 观察者。
- 事务：每次 close 生成新的 txId，onModalDidClose 用 txId 做幂等守卫，过期事件直接返回。
- 过渡锁：过渡锁 transitionLocked 释放之前不调用 onModalClose，回调内再执行 navigate，避免 NAVIGATION_LOCKED_DURING_MODAL_ANIMATION。
- 异常重入：回调只允许触发一次，触发后清空 onModalClose 并复位标记，失败重试需显式发起新一轮 close。
`
  },
  "swelancer_mgr__draft_state_commit": {
    tamperFile: "pages/CurrencySelectionPage.js",
    partialSelection: 4,
    partialChoice: 12,
    partialScore: 87,
    decision: {
      "selected_proposal_id": 5,
      "root_cause_file": "src/pages/CurrencySelectionPage.js",
      "root_cause_functions": [
        "selectCurrencyOption"
      ],
      "discovered_code_invariants": [
        "RouteSerializer.assertSerializableParams 会递归校验路由参数，把 onSelect 之类的回调函数放进 navigateWithParams 参数会立即抛出 ROUTE_SERIALIZATION_ERROR。",
        "StateVault.mergeDraft 只允许写入 RESERVED_KEYS 中声明的持久领域键，写入 IOU_TEMP_CURRENCY 这类未注册的临时键会抛出 VAULT_SCHEMA_VIOLATION。",
        "mergeDraft 在 currency 变化时会立即按新币种精度重算 splitShares：从 USD 切到零小数位的 JPY 时按 100 取整截断，一旦提前写回 IOU_DRAFT，即使把 currency 改回 USD，已被截断的分摊金额也无法恢复，属于不可逆的数据损坏。",
        "mergeDraft 支持 expectedEpoch 乐观锁，draftEpoch 与预期不一致时抛出 VAULT_STALE_EPOCH_CONFLICT，因此提交必须携带捕获时的 expectedEpoch。"
      ],
      "rejected_proposals": {
        "1": "Proposal 1 把 onSelect 回调函数直接塞进 navigateWithParams 的参数，RouteSerializer.assertSerializableParams 会检测到函数类型并立刻抛出 ROUTE_SERIALIZATION_ERROR，而且闭包无法在崩溃恢复后重建。",
        "2": "Proposal 2 在卸载时把 currency 改回原值，但 splitShares 的精度截断不可逆，回滚 currency 无法复原原始分摊金额；额外的回写还会推进 draftEpoch 并造成状态污染，并发场景下旧 epoch 的写入会被 VAULT_STALE_EPOCH_CONFLICT 拒绝。",
        "3": "Proposal 3 新增 IOU_TEMP_CURRENCY 这类未注册的临时键，StateVault.mergeDraft 只接受 RESERVED_KEYS，调用会抛出 VAULT_SCHEMA_VIOLATION。",
        "4": "Proposal 4 只回传 currency 而漏传 draftEpoch，跨步返回或并发保存时无法携带 expectedEpoch 做乐观锁校验，过期草稿会覆盖新草稿，保存请求也无法通过 epoch 校验。",
        "6": "Proposal 6 删除 mergeDraft 中的重算逻辑，会让 splitShares 与 currency 精度不再一致，破坏分摊业务不变量，同时保留提前写入 IOU_DRAFT 的根因。"
      }
    },
    design: `# 分步表单币种提前持久化与分摊截断：根因与目标数据流设计

## 一、源码级根因与副作用

CurrencySelectionPage.selectCurrencyOption 在用户点击币种时直接调用 StateVault.mergeDraft("IOU_DRAFT", { currency })，而 StateVault.mergeDraft 会在 currency 变化时立即重算 splitShares（USD 切 JPY 按 100 取整）。于是用户在 AmountStepPage 点击 save 之前，甚至直接取消返回时，IOU_DRAFT.currency 已被篡改，splitShares 精度被不可逆截断。

## 二、目标数据流与状态机

1. 进入选择页：navigateWithParams 只携带纯 JSON 的 returnToRoute 与 draftEpoch，禁止函数闭包。
2. 选择币种：CurrencySelectionPage 不再写 StateVault，只把 currency 与 draftEpoch 作为纯 JSON 路由参数返回。
3. 本地预览：AmountStepPage 用 pendingCurrency 持有预览态，展示层读取 pendingCurrency 而不读持久层。
4. 保存提交：仅当用户点击 save() 时，携带 expectedEpoch: capturedEpoch 调用 StateVault.mergeDraft("IOU_DRAFT", ...)，币种变更与 splitShares 重算只发生一次。
5. 并发：expectedEpoch 与当前 draftEpoch 不一致时 mergeDraft 抛出 VAULT_STALE_EPOCH_CONFLICT，由页面提示重新进入流程。
`
  },
  "swelancer_mgr__email_validator_unification": {
    tamperFile: "validation/AddressValidator.js",
    partialSelection: 4,
    partialChoice: 8,
    partialScore: 83,
    decision: {
      "selected_proposal_id": 5,
      "root_cause_files": [
        "src/validation/AddressValidator.js",
        "src/lexer/MarkupTokenizer.js"
      ],
      "root_cause_functions": [
        "isValidFrontendAddress",
        "verifyBackendAddressContract",
        "renderMentionsAndEmails"
      ],
      "discovered_code_invariants": [
        "SandboxPolicy 要求地址校验同步纯函数执行：任何 DNS / SMTP / MX 网络请求或第三方 email-validator 依赖都会违反 ASYNC_VALIDATION_FORBIDDEN，且正则执行必须控制在 MAX_REGEX_EXEC_MS = 15 的预算内。",
        "verifyBackendAddressContract 的结构化边界：总长度 <= 254、local-part 长度 1..64、domain label 长度 1..63 且不得以连字符 - 开头或结尾、TLD 至少 2 个字母，前端校验必须逐条对齐。",
        "local-part 还不得以点号开头或结尾、不得包含连续点（..），否则前端放行而 verifyBackendAddressContract 拒绝，出现前后端不一致。",
        "MarkupTokenizer.renderMentionsAndEmails 只检查匹配串是否以 <code> / <pre> 开头，带前缀文本的代码区段内提及会逃逸；正确做法是先按代码区段切分（Token Span 区间切分），仅对非代码段提取候选地址，整体保持 O(N) 线性时间。"
      ],
      "rejected_proposals": {
        "1": "Proposal 1 引入 DNS MX 查询与 SMTP 探活，属于网络请求与异步 I/O，直接违反 SandboxPolicy 的离线同步纯函数约束与 ASYNC_VALIDATION_FORBIDDEN。",
        "2": "Proposal 2 使用带嵌套量词的正则，在长消息包含多个未闭合标签时会触发灾难性回溯（ReDoS），执行时间超过 MAX_REGEX_EXEC_MS = 15 的预算。",
        "3": "Proposal 3 的行首负向先行断言会把同一行代码块之外的合法提及也误杀，只要该行出现过 <code> 就整行跳过。",
        "4": "Proposal 4 只补长度判断，仍然漏掉连续点、label 连字符与 63 字符边界，也没有处理代码块逃逸，前端与后端契约仍然不一致。",
        "6": "Proposal 6 引入第三方 npm 包 email-validator 与 DOMPurify，违反 SandboxPolicy 的零外部依赖与离线约束。",
        "7": "Proposal 7 直接删掉 (?:<code>|<pre>)? 前缀分支，会完全丧失代码保护，代码区段内的提及会重新被渲染为 mention 逃逸。"
      }
    },
    design: `# 前后端地址校验一致性与代码区段提及逃逸：双根因与目标算法设计

## 一、双根因源码剖析

1. AddressValidator.EMAIL_LOOSE_REGEX 只做形式匹配，没有总长度 <= 254、local <= 64、label <= 63 与连字符边界检查，超长或畸形地址被前端放行、后端 verifyBackendAddressContract 拒绝。
2. MarkupTokenizer.renderMentionsAndEmails 的正则只判断匹配串是否以 <code> / <pre> 开头，带前缀文本的代码区段内提及全部逃逸。

## 二、未选方案证伪

- Proposal 1/6 违反 SandboxPolicy 的离线零依赖约束。
- Proposal 2 的嵌套量词正则会触发 ReDoS，超过 MAX_REGEX_EXEC_MS = 15 毫秒预算。
- Proposal 3 的行首负向先行断言会误杀同一行代码块外的合法提及。
- Proposal 4 只补长度，仍漏掉连续点与 label 连字符边界。
- Proposal 7 删掉代码前缀分支后完全失去代码区段保护。

## 三、目标算法设计

统一校验器：isValidFrontendAddress 直接复用 verifyBackendAddressContract 的全部结构化边界。词法切分：采用 Token Span 区间切分，先按 <code>...</code> / <pre>...</pre> 把文本拆成代码段与普通文本段，仅对普通段线性扫描候选地址，整体 O(N) 线性时间且零外部依赖。
`
  },
}

const STRUCTFOLD_REFERENCE_FILES = {
  "src/structfold/__init__.py": `# src/structfold/__init__.py
from .schema_utils import CircularAliasError, SchemaConflictError, StructFolder

__all__ = ["CircularAliasError", "SchemaConflictError", "StructFolder"]
`,
  "src/structfold/csv_utils.py": `"""CSV 读取工具：统一把文件路径或行列表转换为二维字符串表。

采用线性词法扫描而非标准库 csv：判分探针 T4 的样例行
'"Alice, ""The One"",30' 在严格 RFC4180 下缺少收尾引号，但探针期望输出
要求把末尾引号对视为「转义引号 + 收尾引号」，因此这里实现与期望一致的
宽松引号规则（引号对紧邻分隔符/行尾时以第二个引号收尾）。
"""


def parse_line(line):
    text = line.rstrip("\\r\\n")
    fields = []
    current = ""
    in_quotes = False
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if in_quotes:
            if char == '"':
                follow = text[index + 1] if index + 1 < length else ""
                after = text[index + 2] if index + 2 < length else ""
                if follow == '"':
                    current += '"'
                    index += 2
                    if after == "" or after == ",":
                        in_quotes = False
                    continue
                if follow == "" or follow == ",":
                    in_quotes = False
                    index += 1
                    continue
                current += char
                index += 1
                continue
            current += char
            index += 1
            continue
        if char == '"':
            in_quotes = True
            index += 1
            continue
        if char == ",":
            fields.append(current)
            current = ""
            index += 1
            continue
        current += char
        index += 1
    fields.append(current)
    return fields


def read_rows(source):
    if isinstance(source, str):
        with open(source, newline="", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    else:
        lines = list(source)
    rows = []
    for item in lines:
        if isinstance(item, (list, tuple)):
            rows.append([str(cell) for cell in item])
        else:
            rows.append(parse_line(str(item)))
    return rows
`,
  "src/structfold/schema_utils.py": `"""Schema 树推导、列名别名解析与嵌套投影核心实现。"""
import re

from .csv_utils import read_rows


class SchemaConflictError(ValueError):
    """叶子列名与子树前缀冲突。"""


class CircularAliasError(ValueError):
    """列名别名映射存在环路。"""


def _split_header(name, delimiters):
    pattern = "|".join(re.escape(d) for d in delimiters)
    parts = [part for part in re.split(pattern, name) if part]
    return parts or [name]


def resolve_alias(name, aliases):
    seen = []
    current = name
    while current in aliases:
        if current in seen:
            raise CircularAliasError("column alias cycle: " + " -> ".join(seen + [current]))
        seen.append(current)
        current = aliases[current]
    return current


class StructFolder:
    def __init__(self, delimiters=None, conflict_policy="error", type_coercion=False, column_aliases=None):
        self.delimiters = list(delimiters) if delimiters else ["_", " "]
        self.conflict_policy = conflict_policy
        self.type_coercion = bool(type_coercion)
        self.column_aliases = dict(column_aliases or {})
        for name in list(self.column_aliases):
            resolve_alias(name, self.column_aliases)

    def _columns(self, header):
        columns = []
        for raw in header:
            name = raw
            match = re.search(r"@(int|float|bool)$", raw)
            if match:
                name = raw[: -len(match.group(0))]
            resolved = resolve_alias(name, self.column_aliases)
            columns.append({
                "raw": raw,
                "resolved": resolved,
                "tokens": _split_header(resolved, self.delimiters),
            })
        return columns

    def get_schema(self, source):
        rows = read_rows(source)
        if not rows:
            return {}
        return self._render_node(self._columns(rows[0]), 0)

    def _render_node(self, columns, depth):
        out = {}
        seen = []
        for column in columns:
            token = column["tokens"][depth]
            if token in seen:
                continue
            seen.append(token)
            out.update(self._render_child([c for c in columns if c["tokens"][depth] == token], depth))
        return out

    def _render_child(self, columns, depth):
        token = columns[0]["tokens"][depth]
        deepest = max(len(column["tokens"]) for column in columns)
        if deepest == depth + 1:
            return {token: columns[0]["raw"]}
        if len(columns) == 1:
            collapsed = columns[0]
            return {collapsed["resolved"]: collapsed["raw"]}
        node = {}
        exact = [column for column in columns if len(column["tokens"]) == depth + 1]
        if exact:
            if self.conflict_policy == "error":
                raise SchemaConflictError("column " + exact[0]["resolved"] + " conflicts with nested columns")
            if self.conflict_policy == "nest_value":
                node["_self"] = exact[0]["raw"]
        deeper = [column for column in columns if len(column["tokens"]) > depth + 1]
        node.update(self._render_node(deeper, depth + 1))
        return {token: node}

    def convert(self, source, schema=None):
        rows = read_rows(source)
        if not rows:
            return []
        header = rows[0]
        if schema is None:
            schema = self.get_schema(source)
        return [self._project(schema, row, header) for row in rows[1:]]

    def _project(self, node, row, header):
        out = {}
        for key, value in node.items():
            if isinstance(value, dict):
                out[key] = self._project(value, row, header)
            else:
                out[key] = self._cell(value, row, header)
        return out

    def _cell(self, raw, row, header):
        try:
            index = header.index(raw)
        except ValueError:
            return None
        text = row[index] if index < len(row) else ""
        return self._coerce(raw, text)

    def _coerce(self, raw, text):
        match = re.search(r"@(int|float|bool)$", raw)
        if not match:
            return text
        value = text.strip()
        if value == "" or value.lower() == "n/a":
            return None
        kind = match.group(1)
        if kind == "int":
            return int(value)
        if kind == "float":
            return float(value)
        lowered = value.lower()
        if lowered in ("true", "1", "yes"):
            return True
        if lowered in ("false", "0", "no"):
            return False
        return None`,
  "DESIGN.md": `# StructFold 架构设计

## 模块分层文件树

\`\`\`
src/structfold/
├── __init__.py      公开入口与异常再导出
├── csv_utils.py     CSV/分隔符词法读取器
└── schema_utils.py  Schema 树推导、冲突策略、类型转换与别名解析
\`\`\`

## UML 类图

\`\`\`mermaid
classDiagram
  class StructFolder
  class SchemaConflictError
  class CircularAliasError
  StructFolder --> SchemaConflictError
  StructFolder --> CircularAliasError
\`\`\`

## 核心转换时序图

\`\`\`mermaid
sequenceDiagram
  caller->>StructFolder: convert(lines)
  StructFolder->>csv_utils: read_rows
  StructFolder->>schema_utils: get_schema
  StructFolder-->>caller: nested dicts
\`\`\`

## 三项扩展约束

- conflict_policy：叶子列名与子树前缀冲突时按 error / nest_value / last 处置。
- type_coercion：表头 @int/@float/@bool 后缀剥离并做类型转换。
- column_aliases：列名别名多跳解析，出现环路抛 CircularAliasError。

## 模块依赖 DAG（code_file_DAG）

__init__.py -> schema_utils.py -> csv_utils.py，依赖有向无环。
`,
}

const READPULSE_REFERENCE_FILES = {
  "src/readpulse/__init__.py": `# src/readpulse/__init__.py
from .api import UnsupportedFormatError, of_content, of_html, of_markdown, of_text
from .parser import DEFAULT_WPM
from .result import ReadPulseResult

__all__ = [
    "DEFAULT_WPM",
    "ReadPulseResult",
    "UnsupportedFormatError",
    "of_content",
    "of_html",
    "of_markdown",
    "of_text",
]
`,
  "src/readpulse/result.py": `"""ReadPulse 结果值对象。"""
from dataclasses import dataclass, field


@dataclass
class ReadPulseResult:
    word_count: int = 0
    code_word_count: int = 0
    image_count: int = 0
    exact_seconds: float = 0.0
    seconds: int = 0
    minutes: int = 0
    sections: list = field(default_factory=list)

    @property
    def text(self):
        return "%d min read" % max(1, self.minutes)
`,
  "src/readpulse/parser.py": `"""多格式解析、图片阶梯折算与章节时间线计算。"""
import math
import re

from .result import ReadPulseResult

DEFAULT_WPM = 265
IMAGE_LADDER = (12, 11, 10, 9, 8, 7, 6, 5, 4, 3)

MARKDOWN_IMAGE = re.compile(r"!\\[[^\\]]*\\]\\([^)]*\\)")
MARKDOWN_FENCE = re.compile("\`\`\`.*?\`\`\`", re.DOTALL)
MARKDOWN_HEADING = re.compile(r"^#{1,6}[ \\t]+(.+?)[ \\t]*$", re.MULTILINE)
MARKDOWN_QUOTE_LINE = re.compile(r"^[ \\t]*>.*$", re.MULTILINE)

HTML_PRE = re.compile(r"<pre\\b[^>]*>.*?</pre>", re.DOTALL | re.IGNORECASE)
HTML_BLOCKQUOTE = re.compile(r"<blockquote\\b[^>]*>.*?</blockquote>", re.DOTALL | re.IGNORECASE)
HTML_IMG = re.compile(r"<img\\b[^>]*>", re.IGNORECASE)
HTML_HEADING = re.compile(r"<h([1-6])\\b[^>]*>(.*?)</h\\1>", re.DOTALL | re.IGNORECASE)
HTML_TAG = re.compile(r"<[^>]+>")


def image_seconds(count):
    total = 0
    for index in range(count):
        total += IMAGE_LADDER[index] if index < len(IMAGE_LADDER) else IMAGE_LADDER[-1]
    return total


def token_count(text):
    return len(str(text).split())


def _section(title, prose_words, code_words, images, wpm, code_wpm):
    code_rate = code_wpm if code_wpm is not None else wpm
    exact = prose_words / float(wpm) * 60.0 + code_words / float(code_rate) * 60.0 + image_seconds(images)
    return {
        "title": title,
        "word_count": prose_words,
        "image_count": images,
        "seconds": int(math.ceil(exact)) if exact > 0 else 0,
    }


def _strip_tags(fragment):
    return HTML_TAG.sub(" ", fragment or "")


def _markdown_measure(title, body):
    counter = {"code": 0}

    def take_code(match):
        counter["code"] += token_count(match.group(0)[3:-3].strip())
        return "\\n"

    prose = MARKDOWN_FENCE.sub(take_code, body)
    images = len(MARKDOWN_IMAGE.findall(prose))
    prose = MARKDOWN_IMAGE.sub(" ", prose)
    return token_count(prose), counter["code"], images


def _html_measure(title, body):
    counter = {"code": 0}

    def take_pre(match):
        counter["code"] += token_count(_strip_tags(match.group(0)))
        return "\\n"

    prose = HTML_PRE.sub(take_pre, body)
    images = len(HTML_IMG.findall(prose))
    prose = HTML_IMG.sub(" ", prose)
    return token_count(_strip_tags(prose)), counter["code"], images


def markdown_sections(text, exclude_blockquotes):
    working = text or ""
    if exclude_blockquotes:
        working = MARKDOWN_QUOTE_LINE.sub("", working)
    headings = list(MARKDOWN_HEADING.finditer(working))
    raw = []
    if not headings:
        if working.strip():
            raw.append(("Introduction", working))
        return raw
    head = working[: headings[0].start()]
    if head.strip():
        raw.append(("Introduction", head))
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(working)
        raw.append((heading.group(1).strip(), working[heading.end(): end]))
    return raw


def _html_has_content(fragment):
    return bool(_strip_tags(fragment).strip()) or bool(HTML_IMG.search(fragment or ""))


def html_sections(text, exclude_blockquotes):
    working = text or ""
    if exclude_blockquotes:
        working = HTML_BLOCKQUOTE.sub("", working)
    headings = list(HTML_HEADING.finditer(working))
    raw = []
    if not headings:
        if _html_has_content(working):
            raw.append(("Introduction", working))
        return raw
    head = working[: headings[0].start()]
    if _html_has_content(head):
        raw.append(("Introduction", head))
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(working)
        raw.append((_strip_tags(heading.group(2)).strip(), working[heading.end(): end]))
    return raw


def _build(measurer, raw_sections, wpm, code_wpm):
    sections = []
    total_words = 0
    total_code = 0
    total_images = 0
    for title, body in raw_sections:
        prose_words, code_words, images = measurer(title, body)
        if prose_words == 0 and code_words == 0 and images == 0:
            continue
        total_words += prose_words
        total_code += code_words
        total_images += images
        sections.append(_section(title, prose_words, code_words, images, wpm, code_wpm))
    code_rate = code_wpm if code_wpm is not None else wpm
    exact = total_words / float(wpm) * 60.0 + total_code / float(code_rate) * 60.0 + image_seconds(total_images)
    seconds = int(math.ceil(exact)) if exact > 0 else 0
    minutes = int(math.ceil(exact / 60.0)) if exact > 0 else 0
    return ReadPulseResult(
        word_count=total_words,
        code_word_count=total_code,
        image_count=total_images,
        exact_seconds=exact,
        seconds=seconds,
        minutes=minutes,
        sections=sections,
    )


def estimate_text(text, wpm, code_wpm=None):
    if text is None or not str(text).strip():
        return ReadPulseResult()
    words = token_count(text)
    return _build(lambda title, body: (words, 0, 0), [("Introduction", text)], wpm, code_wpm)


def estimate_markdown(text, wpm, code_wpm=None, exclude_blockquotes=False):
    if text is None or not str(text).strip():
        return ReadPulseResult()
    raw = markdown_sections(text, exclude_blockquotes)
    return _build(_markdown_measure, raw, wpm, code_wpm)


def estimate_html(text, wpm, code_wpm=None, exclude_blockquotes=False):
    if text is None or not str(text).strip():
        return ReadPulseResult()
    raw = html_sections(text, exclude_blockquotes)
    return _build(_html_measure, raw, wpm, code_wpm)
`,
  "src/readpulse/api.py": `"""ReadPulse 公开 API：统一校验阅读速率并路由到对应格式解析器。"""
from .parser import DEFAULT_WPM, estimate_html, estimate_markdown, estimate_text
from .result import ReadPulseResult


class UnsupportedFormatError(ValueError):
    """请求了不支持的输入格式。"""


def _validate(wpm, code_wpm):
    if wpm is None or wpm <= 0:
        raise ValueError("wpm must be positive")
    if code_wpm is not None and code_wpm <= 0:
        raise ValueError("code_wpm must be positive")


def of_text(text, wpm=DEFAULT_WPM):
    _validate(wpm, None)
    return estimate_text(text, wpm)


def of_markdown(markdown_text, wpm=DEFAULT_WPM, code_wpm=None, exclude_blockquotes=False):
    _validate(wpm, code_wpm)
    return estimate_markdown(markdown_text, wpm, code_wpm, exclude_blockquotes)


def of_html(html_text, wpm=DEFAULT_WPM, code_wpm=None, exclude_blockquotes=False):
    _validate(wpm, code_wpm)
    return estimate_html(html_text, wpm, code_wpm, exclude_blockquotes)


def of_content(content, format="text", **options):
    if format not in ("text", "markdown", "html"):
        raise UnsupportedFormatError("unsupported format: " + str(format))
    if format == "text":
        return of_text(content, **options)
    if format == "markdown":
        return of_markdown(content, **options)
    return of_html(content, **options)
`,
  "DESIGN.md": `# ReadPulse 架构设计

## 模块分层文件树

\`\`\`
src/readpulse/
├── __init__.py   公开入口导出
├── api.py        公开 API 与参数校验
├── parser.py     多格式解析与章节切分
└── result.py     结果值对象
\`\`\`

## UML 类图

\`\`\`mermaid
classDiagram
  class ReadPulseResult
  class UnsupportedFormatError
  ReadPulseResult <.. api
\`\`\`

## 解析计算时序图

\`\`\`mermaid
sequenceDiagram
  caller->>api: of_markdown(text)
  api->>parser: markdown_sections
  parser-->>api: sections
  api-->>caller: ReadPulseResult
\`\`\`

## 三项扩展约束

- code_wpm：代码块词数与正文分开统计，按独立速率折算耗时。
- exclude_blockquotes：可剥离 Markdown 引用行与 HTML blockquote。
- sections：按标题输出章节时间线，首节标题固定为 Introduction。

## 模块依赖 DAG（code_file_DAG）

__init__.py -> api.py -> parser.py -> result.py，依赖有向无环。
`,
}

const JINJA_LOADERS_REFERENCE = `"""模板加载器：fallback_searchpath 回退、path_transform 转换与列名别名映射。"""
import os

from .exceptions import TemplateNotFound
from .utils import open_if_exists

__all__ = ["DictLoader", "FileSystemLoader", "FunctionLoader", "TemplateNotFound", "split_template_path"]


def split_template_path(template):
    pieces = []
    for piece in str(template).replace(os.path.sep, "/").split("/"):
        if piece in ("..", "."):
            raise TemplateNotFound(template)
        if piece:
            pieces.append(piece)
    return pieces


class BaseLoader:
    def __init__(self, path_transform: "object | None" = None):
        self.path_transform = path_transform
        self.aliases = {}

    def add_alias(self, name, target):
        self.aliases[name] = target

    def remove_alias(self, name):
        self.aliases.pop(name, None)

    def _resolve(self, name):
        mapped = self.path_transform(name) if self.path_transform else name
        seen = set()
        current = mapped
        while current in self.aliases:
            if current in seen:
                raise TemplateNotFound(name)
            seen.add(current)
            current = self.aliases[current]
        return current

    def get_source(self, environment, template):
        raise NotImplementedError

    def list_templates(self):
        return []


class FileSystemLoader(BaseLoader):
    def __init__(self, searchpath, encoding="utf-8", followlinks=False, getmtime=None, fallback_searchpath: "list | None" = None, path_transform: "object | None" = None):
        super().__init__(path_transform)
        self.searchpath = self._to_paths(searchpath)
        self.fallback_searchpath = self._to_paths(fallback_searchpath)
        self.encoding = encoding

    @staticmethod
    def _to_paths(value):
        if value is None:
            return []
        if isinstance(value, (str, os.PathLike)):
            return [os.fspath(value)]
        return [os.fspath(item) for item in value]

    def get_source(self, environment, template):
        name = self._resolve(template)
        pieces = split_template_path(name)
        for searchpath in self.searchpath + self.fallback_searchpath:
            filename = os.path.join(searchpath, *pieces)
            handle = open_if_exists(filename)
            if handle is None:
                continue
            try:
                contents = handle.read().decode(self.encoding)
            finally:
                handle.close()
            return contents, filename, lambda: True
        raise TemplateNotFound(name)

    def list_templates(self):
        found = set()
        for searchpath in self.searchpath + self.fallback_searchpath:
            for dirpath, dirnames, filenames in os.walk(searchpath):
                for filename in filenames:
                    found.add(os.path.relpath(os.path.join(dirpath, filename), searchpath).replace(os.path.sep, "/"))
        return sorted(found)


class DictLoader(BaseLoader):
    def __init__(self, mapping, path_transform: "object | None" = None):
        super().__init__(path_transform)
        self.mapping = dict(mapping)

    def get_source(self, environment, template):
        name = self._resolve(template)
        if name not in self.mapping:
            raise TemplateNotFound(name)
        return self.mapping[name], name, lambda: True

    def list_templates(self):
        return sorted(self.mapping)


class FunctionLoader(BaseLoader):
    def __init__(self, load_func, path_transform: "object | None" = None):
        super().__init__(path_transform)
        self.load_func = load_func

    def get_source(self, environment, template):
        name = self._resolve(template)
        contents = self.load_func(name)
        if contents is None:
            raise TemplateNotFound(name)
        return contents, name, lambda: True
`

const PARTIAL_STRUCTFOLD_DESIGN = `# StructFold 设计

src/structfold 模块树：
- schema_utils.py
- csv_utils.py
- __init__.py

conflict_policy / type_coercion / column_aliases 三项扩展约束。
依赖 DAG 有向无环。
`

test("evals/grade：SWE-Lancer 三道经理级方案选优题的满分、误选部分分与只读 src/ 篡改扣分", async () => {
  for (const [taskId, golden] of Object.entries(SWE_LANCER_GOLDEN)) {
    const workspace = await createEvalWorkspace(taskId)
    try {
      await writeWorkspaceFiles(workspace, {
        "DECISION.json": JSON.stringify(golden.decision, null, 2),
        "DESIGN.md": golden.design
      })

      const full = await gradeSweLancerManagerTask(taskId, workspace)
      assert.equal(full.totalScore, 100, taskId + " 的满分黄金样例必须得 100 分")
      assert.equal(full.deterministic60, 60)
      assert.equal(full.checkpoints30, 30)
      assert.equal(full.discipline10, 10)
      assert.equal(full.details.srcUntouched, true)
      assert.equal(full.details.decisionUnambiguous, true)
      assert.equal(full.details.rootCauseHit, true)

      // 误选 Proposal 4：只有方案选择项按题给部分分，根因与证伪检查点仍应全部拿到
      await writeWorkspaceFiles(workspace, {
        "DECISION.json": JSON.stringify({ ...golden.decision, selected_proposal_id: golden.partialSelection }, null, 2)
      })
      const partial = await gradeSweLancerManagerTask(taskId, workspace)
      assert.equal(partial.details.selectedId, golden.partialSelection)
      assert.equal(partial.deterministic60, golden.partialChoice + 35)
      assert.equal(partial.checkpoints30, 30)
      assert.equal(partial.totalScore, golden.partialScore, taskId + " 误选 Proposal 4 只能拿到部分分")

      // 无 DECISION.json / DESIGN.md 时不崩溃：src/ 未被篡改，纪律分只剩只读的 5 分
      await rm(path.join(workspace, "DECISION.json"))
      await rm(path.join(workspace, "DESIGN.md"))
      const missing = await gradeSweLancerManagerTask(taskId, workspace)
      assert.equal(missing.details.selectedId, undefined)
      assert.equal(missing.details.decisionUnambiguous, false)
      assert.equal(missing.details.srcUntouched, true)
      assert.equal(missing.totalScore, 5)

      // 恢复产出物后篡改只读 src/：只读纪律扣 5 分，其余维度不因此变化
      await writeWorkspaceFiles(workspace, {
        "DECISION.json": JSON.stringify(golden.decision, null, 2),
        "DESIGN.md": golden.design
      })
      const tamperPath = path.join(workspace, "src", golden.tamperFile)
      await writeFile(tamperPath, (await readFile(tamperPath, "utf8")) + " // tampered", "utf8")
      const tampered = await gradeSweLancerManagerTask(taskId, workspace)
      assert.equal(tampered.details.srcUntouched, false)
      assert.equal(tampered.discipline10, 5)
      assert.equal(tampered.totalScore, 95)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  await assert.rejects(
    () => gradeSweLancerManagerTask("swelancer_mgr__unknown_task", os.tmpdir()),
    /未知的 SWE-Lancer 经理任务 ID/
  )
})

test("evals/grade：DevBench 两道 Python 题的 10 项隐藏探针、扩展约束与 DESIGN.md 检查", { skip: PYTHON3_SKIP_REASON }, async () => {
  const references = {
    devbench__nested_delimited_projection: STRUCTFOLD_REFERENCE_FILES,
    devbench__multiformat_reading_estimator: READPULSE_REFERENCE_FILES
  }
  for (const [taskId, files] of Object.entries(references)) {
    const workspace = await createEvalWorkspace()
    try {
      await writeWorkspaceFiles(workspace, files)
      const full = await gradeDevBenchTask(taskId, workspace)
      assert.equal(full.totalScore, 100, taskId + " 的参考实现必须得 100 分")
      assert.equal(full.deterministic60, 60)
      assert.equal(full.checkpoints30, 30)
      assert.equal(full.discipline10, 10)
      assert.deepEqual(full.details.perTest, expectedProbeFlags(true))
      assert.equal(full.details.extensionAll, true)
      assert.equal(full.details.modulesSplit, true)
      assert.equal(full.details.syntaxOk, true)
      assert.equal(full.details.designTree, true)
      assert.equal(full.details.designClassDiagram, true)
      assert.equal(full.details.designSequenceDiagram, true)
      assert.equal(full.details.designConstraints, true)
      assert.equal(full.details.designDag, true)

      // 删除 DESIGN.md：设计文档 20 分全扣，扩展约束 10 分与隐藏测试 60 分保留
      await rm(path.join(workspace, "DESIGN.md"))
      const noDesign = await gradeDevBenchTask(taskId, workspace)
      assert.equal(noDesign.details.passedCount, 10)
      assert.equal(noDesign.details.extensionAll, true)
      assert.equal(noDesign.checkpoints30, 10)
      assert.equal(noDesign.totalScore, 80)
      assert.equal(noDesign.details.designTree, false)
      assert.equal(noDesign.details.designDag, false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  // DESIGN.md 子项按项计分：文件树/三项约束/DAG 命中、两张 Mermaid 图缺失 → 设计分 10/20
  const designWorkspace = await createEvalWorkspace()
  try {
    await writeWorkspaceFiles(designWorkspace, { ...STRUCTFOLD_REFERENCE_FILES, "DESIGN.md": PARTIAL_STRUCTFOLD_DESIGN })
    const partial = await gradeDevBenchTask("devbench__nested_delimited_projection", designWorkspace)
    assert.equal(partial.details.designTree, true)
    assert.equal(partial.details.designClassDiagram, false)
    assert.equal(partial.details.designSequenceDiagram, false)
    assert.equal(partial.checkpoints30, 20)
    assert.equal(partial.totalScore, 90)
  } finally {
    await rm(designWorkspace, { recursive: true, force: true })
  }

  // 夹具桩基线：10 项探针全否、单文件包不算模块拆分、设计文档缺失
  for (const taskId of Object.keys(references)) {
    const workspace = await createEvalWorkspace(taskId)
    try {
      const baseline = await gradeDevBenchTask(taskId, workspace)
      assert.equal(baseline.deterministic60, 0)
      assert.equal(baseline.details.passedCount, 0)
      assert.deepEqual(baseline.details.perTest, expectedProbeFlags(false))
      assert.equal(baseline.details.pyFileCount, 1)
      assert.equal(baseline.details.modulesSplit, false)
      assert.equal(baseline.details.extensionAll, false)
      assert.equal(baseline.discipline10, 5)
      assert.equal(baseline.totalScore, 5)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  await assert.rejects(
    () => gradeDevBenchTask("devbench__unknown_task", os.tmpdir()),
    /未知的 DevBench 任务 ID/
  )
})

test("evals/grade：pallets_jinja_task__task1621 的 10 项 Python 探针与三项契约检查", { skip: PYTHON3_SKIP_REASON }, async () => {
  const referenceWorkspace = await createEvalWorkspace()
  try {
    await writeWorkspaceFiles(referenceWorkspace, { "src/jinja2/loaders.py": JINJA_LOADERS_REFERENCE })
    const full = await gradePublicCodeTask("pallets_jinja_task__task1621", referenceWorkspace)
    assert.equal(full.totalScore, 100)
    assert.equal(full.deterministic60, 60)
    assert.equal(full.checkpoints30, 30)
    assert.equal(full.discipline10, 10)
    assert.equal(full.details.passedCount, 10)
    assert.deepEqual(full.details.perTest, expectedProbeFlags(true))
    assert.equal(full.details.hasFallbackContract, true)
    assert.equal(full.details.hasTransformContract, true)
    assert.equal(full.details.hasAliasContract, true)
  } finally {
    await rm(referenceWorkspace, { recursive: true, force: true })
  }

  // 夹具是真实 jinja2 loaders.py 基线：只有既有的 ../ 路径遍历防护（T9）通过，新增特性全部未实现
  const baselineWorkspace = await createEvalWorkspace("pallets_jinja_task__task1621")
  try {
    const baseline = await gradePublicCodeTask("pallets_jinja_task__task1621", baselineWorkspace)
    assert.equal(baseline.details.passedCount, 1)
    assert.equal(baseline.details.perTest.t9, true)
    assert.equal(baseline.details.perTest.t1, false)
    assert.equal(baseline.deterministic60, 6)
    assert.equal(baseline.checkpoints30, 0)
    assert.equal(baseline.discipline10, 10)
    assert.equal(baseline.totalScore, 16)
  } finally {
    await rm(baselineWorkspace, { recursive: true, force: true })
  }

  await assert.rejects(
    () => gradePublicCodeTask("pallets_jinja_task__unknown_task", os.tmpdir()),
    /未知的公开基准题 ID/
  )
})

test("evals/zstd-log：detectWorkspaceEscape 拦截 curl/wget/git clone/https:// 外部网络访问企图", () => {
  const workspaceRoot = path.join(os.tmpdir(), "twr-eval-network-sandbox-root")
  const networkCalls = [
    { tool: "bash", args: { command: "curl -sS https://example.com/answers.json" }, target: "curl" },
    { tool: "bash", args: { command: "wget -q http://example.com/hidden.tar.gz" }, target: "wget" },
    { tool: "bash", args: { command: "git clone https://github.com/example/hidden-oracle" }, target: "git clone" },
    { tool: "bash", args: { command: "echo https://example.com/oracle" }, target: "https://" },
    { tool: "run_code", args: { code: "const response = await fetch('https://example.com/secret')" }, target: "https://" },
    // 包管理器联网装包：直接命令、python -m pip 绕过路径与 npx/uv 拉取
    { tool: "bash", args: { command: "pip install requests" }, target: "pip install" },
    { tool: "bash", args: { command: "pip3 download Jinja2==3.0.3" }, target: "pip3 download" },
    { tool: "bash", args: { command: "python -m pip install requests" }, target: "python -m pip install" },
    { tool: "bash", args: { command: "python3 -m pip download Jinja2==3.0.3" }, target: "python3 -m pip download" },
    { tool: "bash", args: { command: "npm install lodash" }, target: "npm install" },
    { tool: "bash", args: { command: "pnpm add lodash" }, target: "pnpm add" },
    { tool: "bash", args: { command: "yarn add lodash" }, target: "yarn add" },
    { tool: "bash", args: { command: "npx create-react-app demo" }, target: "npx create-react-app" },
    { tool: "bash", args: { command: "uv pip install requests" }, target: "uv pip install" },
    { tool: "bash", args: { command: "uv sync" }, target: "uv sync" }
  ]
  for (const attempt of networkCalls) {
    const audit = detectWorkspaceEscape([{
      id: "s-network",
      toolCalls: [{ type: "tool/ptc-dispatch", turn: 2, step: 1, name: attempt.tool, arguments: attempt.args }]
    }], workspaceRoot)
    assert.equal(audit.cheatDetected, true, attempt.tool + " 的外网访问必须被拦截")
    assert.equal(audit.violations.length, 1)
    assert.equal(audit.violations[0].reason, "network-access-attempt")
    assert.equal(audit.violations[0].target, attempt.target)
  }

  // 本地开发操作与 localhost/127.0.0.1 回环地址不误判为外网访问
  const safeCalls = [
    { tool: "bash", args: { command: "node --test tests/evals-harness.test.mjs" } },
    { tool: "bash", args: { command: "git status --short" } },
    { tool: "run_code", args: { code: "const url = 'http://localhost:3000/health'; console.log(url)" } },
    { tool: "run_code", args: { code: "const url = 'http://127.0.0.1:62701/api/session'; console.log(url)" } },
    // 本地包管理器查询/构建命令不访问包索引，不得误判为联网
    { tool: "bash", args: { command: "pip --version" } },
    { tool: "bash", args: { command: "pip list" } },
    { tool: "bash", args: { command: "python -m pip --version" } },
    { tool: "bash", args: { command: "npm test" } },
    { tool: "bash", args: { command: "npm run build" } },
    // 本地测试命令后的过滤参数（-- 之后或本地子命令后的 view/info/add/wheel）不得误判为联网子命令
    { tool: "bash", args: { command: "npm run test -- view" } },
    { tool: "bash", args: { command: "npm run test -- --view" } },
    { tool: "bash", args: { command: "npm test -- info" } },
    { tool: "bash", args: { command: "npm test -- add" } },
    { tool: "bash", args: { command: "pip list -- wheel" } },
    // 首个子命令是本地命令时，后续同名字样（install/wheel）也不得被当作联网子命令
    { tool: "bash", args: { command: "npm run install" } },
    { tool: "bash", args: { command: "pip show wheel" } },
    { tool: "bash", args: { command: "pnpm run lint" } },
    { tool: "bash", args: { command: "yarn test" } },
    { tool: "bash", args: { command: "uv --version" } }
  ]
  for (const safe of safeCalls) {
    const audit = detectWorkspaceEscape([{
      id: "s-safe",
      toolCalls: [{ type: "tool/ptc-dispatch", turn: 1, step: 1, name: safe.tool, arguments: safe.args }]
    }], workspaceRoot)
    assert.equal(audit.cheatDetected, false, JSON.stringify(safe.args) + " 不应被判为网络作弊")
    assert.equal(audit.violations.length, 0)
  }
})

// ———— 超难题判分器：基线未改 / 直觉局部补丁 / 完整黄金实现三级样例 ————
// 下列黄金实现与局部补丁只用于验证判分器契约（能否识别满分、部分分与基线零进展），
// 不参与评测运行，也不代表题目唯一解；判分器或探针改动时它们作为行为基线报警。

const UH1_FIXTURE_ID = "uh1_swelancer__offline_optimistic_reappear"
const UH2_FIXTURE_ID = "uh2_swelancer__popover_backdrop_event_routing"
const UH3_FIXTURE_ID = "uh3_cooperbench__three_way_tx_cache_pipeline"

function expectedUltraProbeFlags(count, passed) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => ["t" + (index + 1), passed]))
}

// uh1 完整黄金实现（Proposal 6）：墓碑 + 快照逐成员过滤 + 幂等 successData + 队列不丢在途操作 + 统一删除 finalize
const UH1_GOLDEN_FILES = {
  "src/policy/PolicyRoleIndex.js": String.raw`export const WORKSPACE_ROLE_IDS = Object.freeze(["owner", "admin", "approver", "manager", "member"]);

export class PolicyRoleIndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyRoleIndexError";
    this.code = code;
  }
}

export function finalizeMemberRemoval({ vault = null, policyRoleIndex = null } = {}, memberId, { mutationSeq } = {}) {
  if (typeof memberId !== "string" || memberId.length === 0) return false;
  let removed = false;
  if (vault !== null) {
    if (Number.isInteger(mutationSeq)) vault.recordMutationSeq(memberId, mutationSeq);
    removed = vault.removeMember(memberId);
  }
  if (policyRoleIndex !== null && typeof policyRoleIndex.finalizeMemberRemoval === "function") policyRoleIndex.finalizeMemberRemoval(memberId);
  return removed;
}

export class PolicyRoleIndex {
  #roleByMemberId = new Map();
  #delegateByMemberId = new Map();

  constructor(options = {}) {
    for (const [memberId, roleId] of Object.entries(options.roleByMemberId ?? {})) this.setRole(memberId, roleId);
    for (const [memberId, delegateId] of Object.entries(options.delegateByMemberId ?? {})) this.delegateApproval(memberId, delegateId);
  }

  getRole(memberId) { return this.#roleByMemberId.get(memberId) ?? null; }

  hasRole(memberId) { return this.#roleByMemberId.has(memberId); }

  listRoles() {
    return [...this.#roleByMemberId.entries()].map(([memberId, roleId]) => ({ memberId, roleId })).sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  setRole(memberId, roleId) {
    if (typeof memberId !== "string" || memberId.length === 0) throw new PolicyRoleIndexError("ROLE_INDEX_MEMBER_INVALID", "成员 id 必须是非空字符串");
    if (!WORKSPACE_ROLE_IDS.includes(roleId)) throw new PolicyRoleIndexError("ROLE_INDEX_ROLE_INVALID", "未知工作区角色：" + roleId);
    this.#roleByMemberId.set(memberId, roleId);
    return roleId;
  }

  removeRole(memberId) { return this.#roleByMemberId.delete(memberId); }

  finalizeMemberRemoval(memberId) {
    const successor = this.#delegateByMemberId.get(memberId) ?? null;
    const removedRole = this.#roleByMemberId.delete(memberId);
    this.#delegateByMemberId.delete(memberId);
    for (const [sourceId, delegateId] of [...this.#delegateByMemberId.entries()]) {
      if (delegateId !== memberId) continue;
      const next = successor !== null && successor !== sourceId && this.#roleByMemberId.has(successor) ? successor : null;
      if (next === null) this.#delegateByMemberId.delete(sourceId);
      else this.#delegateByMemberId.set(sourceId, next);
    }
    return { removedRole, successor };
  }

  getDelegate(memberId) { return this.#delegateByMemberId.get(memberId) ?? null; }

  listDelegations() {
    return [...this.#delegateByMemberId.entries()].map(([memberId, delegateId]) => ({ memberId, delegateId })).sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  delegateApproval(memberId, delegateId) {
    if (!this.#roleByMemberId.has(memberId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "转交发起人不在角色索引中：" + memberId);
    if (!this.#roleByMemberId.has(delegateId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "转交目标不在角色索引中：" + delegateId);
    if (memberId === delegateId) throw new PolicyRoleIndexError("ROLE_INDEX_SELF_DELEGATION", "审批不能转交给自己");
    this.#delegateByMemberId.set(memberId, delegateId);
    return delegateId;
  }

  removeDelegation(memberId) { return this.#delegateByMemberId.delete(memberId); }

  resolveApproverId(memberId) {
    if (!this.#roleByMemberId.has(memberId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "成员不在角色索引中：" + memberId);
    const visited = [];
    let cursor = memberId;
    while (this.#delegateByMemberId.has(cursor)) {
      if (visited.includes(cursor)) throw new PolicyRoleIndexError("ROLE_INDEX_DELEGATION_CYCLE", "审批转交链存在环路：" + [...visited, cursor].join(" -> "));
      visited.push(cursor);
      const next = this.#delegateByMemberId.get(cursor);
      if (!this.#roleByMemberId.has(next)) throw new PolicyRoleIndexError("ROLE_INDEX_DANGLING_DELEGATE", "审批转交目标不存在：" + next);
      cursor = next;
    }
    return cursor;
  }
}`,
  "src/actions/WorkspaceMemberActions.js": String.raw`import { MemberVault } from "../store/MemberVault.js";
import { PolicyRoleIndex, finalizeMemberRemoval } from "../policy/PolicyRoleIndex.js";
import { OfflineMutationQueue } from "../queue/OfflineMutationQueue.js";
import { DeltaStream } from "../sync/DeltaStream.js";

let mutationSequence = 0;

function nextMutationId(kind) {
  mutationSequence += 1;
  return kind + "-" + Date.now().toString(36) + "-" + mutationSequence;
}

export function createWorkspaceMemberActions(options = {}) {
  const { vault, policyRoleIndex, queue, isOffline = () => false } = options;
  if (!vault || !policyRoleIndex || !queue) throw new Error("createWorkspaceMemberActions 需要 vault、policyRoleIndex 与 queue");

  queue.subscribe((event) => {
    const mutation = event.mutation;
    if (!mutation) return;
    if (mutation.kind === "deleteWorkspaceMember") {
      if (event.type === "mutation.succeeded") {
        for (const memberId of mutation.memberIds) finalizeMemberRemoval({ vault, policyRoleIndex }, memberId, { mutationSeq: event.result.appliedSeq });
        return;
      }
      for (const snapshot of mutation.rollbackMembers ?? []) {
        vault.restoreMember(snapshot);
        vault.setLastError(snapshot.id, event.error?.message || "删除失败");
      }
      return;
    }
    if (mutation.kind === "assignWorkspaceMemberRole" && event.type === "mutation.failed") {
      const memberId = mutation.memberIds[0];
      if (mutation.previousRole === null) policyRoleIndex.removeRole(memberId);
      else policyRoleIndex.setRole(memberId, mutation.previousRole);
    }
  });

  async function flushPendingMutations() {
    if (isOffline()) return null;
    try {
      return await queue.flush();
    } catch (error) {
      return { appliedSeq: null, succeeded: [], failed: [], error };
    }
  }

  async function deleteMembers(memberIds) {
    const candidates = Array.isArray(memberIds) ? memberIds : [memberIds];
    const ids = [...new Set(candidates)].filter((id) => typeof id === "string" && vault.hasMember(id) && vault.getMember(id)?.pendingAction !== "delete");
    if (ids.length === 0) return { queued: [], flushed: false, error: null };
    const rollbackMembers = ids.map((id) => vault.getMember(id)).filter(Boolean);
    for (const id of ids) vault.setPendingAction(id, "delete");
    const mutation = {
      id: nextMutationId("delete-members"),
      kind: "deleteWorkspaceMember",
      memberIds: ids,
      rollbackMembers,
      successData: [{ code: "MEMBER_NOT_FOUND", behavior: "treatAsApplied" }],
      createdAt: Date.now(),
    };
    queue.enqueue(mutation);
    const report = await flushPendingMutations();
    return { queued: ids, flushed: report !== null, error: report?.error ?? null };
  }

  async function assignRole(memberId, roleId) {
    const previousRole = policyRoleIndex.getRole(memberId);
    policyRoleIndex.setRole(memberId, roleId);
    const mutation = {
      id: nextMutationId("assign-role"),
      kind: "assignWorkspaceMemberRole",
      memberIds: [memberId],
      payload: { roleId },
      previousRole,
      createdAt: Date.now(),
    };
    queue.enqueue(mutation);
    const report = await flushPendingMutations();
    return { queued: [memberId], flushed: report !== null, error: report?.error ?? null };
  }

  return { deleteMembers, assignRole, flushPendingMutations };
}

export function createWorkspaceRuntime(options = {}) {
  const vault = options.vault ?? new MemberVault(options.members ?? []);
  const policyRoleIndex = options.policyRoleIndex ?? new PolicyRoleIndex(options.policy ?? {});
  const queue = options.queue ?? new OfflineMutationQueue({ transport: options.transport, batchSize: options.batchSize });
  const isOffline = typeof options.isOffline === "function" ? options.isOffline : () => false;
  const actions = createWorkspaceMemberActions({ vault, policyRoleIndex, queue, isOffline });
  const stream = options.stream ?? new DeltaStream({ vault, policyRoleIndex });
  return { vault, policyRoleIndex, queue, stream, actions, deleteMembers: actions.deleteMembers, assignRole: actions.assignRole, flushPendingMutations: actions.flushPendingMutations };
}`,
  "src/queue/OfflineMutationQueue.js": String.raw`export class OfflineMutationQueueError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OfflineMutationQueueError";
    this.code = code;
  }
}

const DEFAULT_BATCH_SIZE = 20;

export class OfflineMutationQueue {
  #transport;
  #batchSize;
  #pending = [];
  #inflight = null;
  #listeners = new Set();

  constructor(options = {}) {
    if (!options.transport || typeof options.transport.send !== "function") throw new OfflineMutationQueueError("QUEUE_TRANSPORT_REQUIRED", "离线队列需要提供 transport.send");
    this.#transport = options.transport;
    this.#batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  }

  get size() { return this.#pending.length; }
  get isFlushing() { return this.#inflight !== null; }

  listPending() {
    return this.#pending.map((mutation) => ({ id: mutation.id, kind: mutation.kind, memberIds: [...(mutation.memberIds ?? [])], createdAt: mutation.createdAt ?? null }));
  }

  enqueue(mutation) {
    if (!mutation || typeof mutation.id !== "string" || mutation.id.length === 0) throw new OfflineMutationQueueError("QUEUE_MUTATION_INVALID", "待决操作必须包含非空 id");
    if (typeof mutation.kind !== "string" || mutation.kind.length === 0) throw new OfflineMutationQueueError("QUEUE_MUTATION_INVALID", "待决操作必须包含非空 kind");
    if (this.#pending.some((item) => item.id === mutation.id)) throw new OfflineMutationQueueError("QUEUE_DUPLICATE_MUTATION", "待决操作 id 重复：" + mutation.id);
    this.#pending.push(mutation);
    return mutation.id;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  flush() {
    if (this.#inflight) return this.#inflight;
    if (this.#pending.length === 0) return Promise.resolve({ appliedSeq: null, succeeded: [], failed: [] });
    const batch = this.#pending.slice(0, this.#batchSize);
    this.#pending = this.#pending.slice(batch.length);
    this.#inflight = this.#sendBatch(batch).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #sendBatch(batch) {
    let result;
    try {
      result = await this.#transport.send(batch);
    } catch (error) {
      this.#pending = [...batch, ...this.#pending];
      throw new OfflineMutationQueueError("QUEUE_BATCH_FAILED", "批量同步失败：" + (error && error.message ? error.message : "unknown"), { cause: error });
    }
    return this.#settleBatch(batch, result);
  }

  #settleBatch(batch, result) {
    if (!result || typeof result !== "object") throw new OfflineMutationQueueError("QUEUE_RESULT_INVALID", "transport.send 必须返回对象");
    const appliedIds = new Set(Array.isArray(result.applied) ? result.applied : []);
    const appliedSeq = Number.isInteger(result.appliedSeq) ? result.appliedSeq : null;
    const idempotentById = new Map((Array.isArray(result.idempotent) ? result.idempotent : []).map((entry) => [entry.mutationId, entry]));
    const failedById = new Map((Array.isArray(result.failed) ? result.failed : []).map((entry) => [entry.mutationId, entry]));
    const succeeded = [];
    const failed = [];
    for (const mutation of batch) {
      if (appliedIds.has(mutation.id)) {
        const outcome = { mutation, result: { appliedSeq, code: null, outcome: "applied" } };
        succeeded.push(outcome);
        this.#emit({ type: "mutation.succeeded", ...outcome });
        continue;
      }
      const idempotentEntry = idempotentById.get(mutation.id);
      if (idempotentEntry) {
        if (this.#declaresIdempotentSuccess(mutation, idempotentEntry.code)) {
          const outcome = { mutation, result: { appliedSeq: Number.isInteger(idempotentEntry.appliedSeq) ? idempotentEntry.appliedSeq : appliedSeq, code: idempotentEntry.code, outcome: "idempotent" } };
          succeeded.push(outcome);
          this.#emit({ type: "mutation.succeeded", ...outcome });
          continue;
        }
        const outcome = { mutation, error: { code: idempotentEntry.code, message: idempotentEntry.message ?? "" } };
        failed.push(outcome);
        this.#emit({ type: "mutation.failed", ...outcome });
        continue;
      }
      const failedEntry = failedById.get(mutation.id);
      const error = failedEntry ? { code: failedEntry.code, message: failedEntry.message ?? "" } : { code: "QUEUE_RESULT_MISSING", message: "服务器结果缺少该待决操作" };
      const outcome = { mutation, error };
      failed.push(outcome);
      this.#emit({ type: "mutation.failed", ...outcome });
    }
    if (failed.length > 0) this.#pending = [...failed.map((outcome) => outcome.mutation), ...this.#pending];
    return { appliedSeq, succeeded, failed };
  }

  #declaresIdempotentSuccess(mutation, code) {
    return Array.isArray(mutation.successData) && mutation.successData.some((entry) => entry && entry.code === code && entry.behavior === "treatAsApplied");
  }

  #emit(payload) {
    for (const listener of [...this.#listeners]) {
      try { listener(payload); } catch {}
    }
  }
}

export function createOfflineMutationQueue(options) { return new OfflineMutationQueue(options); }`,
  "src/sync/DeltaStream.js": String.raw`import { finalizeMemberRemoval } from "../policy/PolicyRoleIndex.js";

export class DeltaStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeltaStreamError";
    this.code = code;
  }
}

const CONNECTION_STATES = new Set(["online", "offline"]);

export class DeltaStream {
  #vault;
  #policyRoleIndex;
  #cursor = 0;
  #connectionState = "online";
  #listeners = new Set();

  constructor(options = {}) {
    if (!options.vault) throw new DeltaStreamError("DELTA_VAULT_REQUIRED", "DeltaStream 需要 MemberVault 实例");
    this.#vault = options.vault;
    this.#policyRoleIndex = options.policyRoleIndex ?? null;
  }

  get cursor() { return this.#cursor; }
  get connectionState() { return this.#connectionState; }
  isOffline() { return this.#connectionState === "offline"; }

  setConnectionState(state) {
    if (!CONNECTION_STATES.has(state)) throw new DeltaStreamError("DELTA_CONNECTION_INVALID", "未知连接状态：" + state);
    const changed = this.#connectionState !== state;
    this.#connectionState = state;
    if (changed) this.#emit({ type: "connection.changed", state });
    return state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  applyDelta(delta) {
    if (!delta || !Number.isInteger(delta.seq) || !Array.isArray(delta.events)) throw new DeltaStreamError("DELTA_INVALID", "增量消息必须包含整数 seq 与 events 数组");
    if (delta.seq <= this.#cursor) return { applied: false, seq: this.#cursor };
    for (const event of delta.events) this.#applyEvent(event, delta.seq);
    this.#cursor = delta.seq;
    this.#emit({ type: "delta.applied", seq: delta.seq });
    return { applied: true, seq: delta.seq };
  }

  applyServerSnapshot(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.snapshotSeq) || !Array.isArray(snapshot.members)) throw new DeltaStreamError("SNAPSHOT_INVALID", "快照必须包含整数 snapshotSeq 与 members 数组");
    const presentIds = new Set();
    for (const member of snapshot.members) {
      if (!member || typeof member.id !== "string") continue;
      presentIds.add(member.id);
      if (snapshot.snapshotSeq < this.#vault.lastMutationSeqOf(member.id)) continue;
      this.#vault.upsertMember(member);
      this.#vault.recordMutationSeq(member.id, snapshot.snapshotSeq);
    }
    for (const member of this.#vault.listMembers()) {
      if (presentIds.has(member.id)) continue;
      if (snapshot.snapshotSeq < this.#vault.lastMutationSeqOf(member.id)) continue;
      this.#vault.removeMember(member.id);
    }
    this.#cursor = Math.max(this.#cursor, snapshot.snapshotSeq);
    this.#emit({ type: "snapshot.applied", seq: snapshot.snapshotSeq });
    return { applied: true, snapshotSeq: snapshot.snapshotSeq };
  }

  #applyEvent(event, seq) {
    if (!event || typeof event.type !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "增量事件缺少 type");
    if (event.type === "member.added" || event.type === "member.updated") {
      if (!event.member || typeof event.member.id !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "成员事件缺少 member.id");
      if (seq < this.#vault.lastMutationSeqOf(event.member.id)) return;
      this.#vault.upsertMember(event.member);
      this.#vault.recordMutationSeq(event.member.id, seq);
      return;
    }
    if (event.type === "member.removed") {
      if (typeof event.memberId !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "移除事件缺少 memberId");
      finalizeMemberRemoval({ vault: this.#vault, policyRoleIndex: this.#policyRoleIndex }, event.memberId, { mutationSeq: seq });
      return;
    }
    throw new DeltaStreamError("DELTA_EVENT_UNKNOWN", "未知增量事件：" + event.type);
  }

  #emit(payload) {
    for (const listener of [...this.#listeners]) {
      try { listener(payload); } catch {}
    }
  }
}`
}

const UH1_GOLDEN_DECISION = {
  "selected_proposal_id": 6,
  "root_cause_files": [
    "src/actions/WorkspaceMemberActions.js",
    "src/queue/OfflineMutationQueue.js",
    "src/sync/DeltaStream.js",
    "src/store/MemberVault.js",
    "src/policy/PolicyRoleIndex.js"
  ],
  "root_cause_functions": [
    "deleteMembers",
    "settleBatch",
    "applyServerSnapshot",
    "recordMutationSeq",
    "finalizeMemberRemoval"
  ],
  "discovered_code_invariants": [
    "MemberVault.removeMember 在删除前可记录 mutationSeq 形成墓碑，lastMutationSeqOf 在成员删除后仍可读",
    "DeltaStream.applyServerSnapshot 直接 replaceMembers 会丢掉墓碑与 pendingAction，旧快照因此复活成员",
    "OfflineMutationQueue.#settleBatch 用失败批次覆盖 #pending，会丢掉批次在途期间新入队的操作",
    "PolicyRoleIndex.delegateApproval 要求转交双方都有角色，删除成员后不清理会抛 ROLE_INDEX_DANGLING_DELEGATE"
  ],
  "rejected_proposals": {
    "1": "会话级集合只存在于视图层与内存，页面刷新即丢失；MemberVault、DeltaStream 与 OfflineMutationQueue 完全不感知，服务端下发旧快照仍会复活成员，角色索引也不会清理。",
    "2": "保留快照后直接物理删除，删除失败用快照恢复，但成功路径没有幂等 successData，服务端已删除时 MEMBER_NOT_FOUND 会走失败回滚并让成员重新出现；pendingAction 仅为视图提示，快照按整份替换仍会被旧 snapshotSeq 复活。",
    "3": "3 秒定时器清除 pendingAction 只是视图层隐藏：离线时 isOffline 为真本就不隐藏，且定时器会把待删除状态提前丢弃，旧快照与队列回滚仍会让成员复活，角色转交也不会清理。",
    "4": "整份快照按 cursor 丢弃会连带丢掉其余成员的正常更新与成员数据，且不会记录已删除成员的墓碑序号，无法按成员逐条过滤旧数据。",
    "5": "successData 幂等只覆盖删除成功语义，DeltaStream 仍整份替换快照、OfflineMutationQueue 仍用失败批次覆盖在途新增队列，旧 snapshotSeq 仍会复活已删成员。",
    "7": "重连时清空本地状态会把尚未同步的待决删除与角色调整全部丢失，服务器全量重建后本地离线操作无声消失，且审批转交被错误恢复。",
    "8": "deletedMemberIds 持久集合只按成员 id 丢弃快照，会让其余成员数据无法更新或误丢新建成员，且不记录变更序号，无法与 snapshotSeq 逐条比较。"
  }
}
const UH1_GOLDEN_DESIGN = String.raw`# 离线删除与旧快照复活：源码级根因与目标设计

## 一、调用链与根因追踪

成员动作 WorkspaceMemberActions 的 deleteMembers 打 pendingAction 后把删除操作交给 OfflineMutationQueue；同步成功回调只调用 MemberVault.removeMember 并记录变更序号，未清理 PolicyRoleIndex，也未把墓碑用于快照过滤。成员存储 MemberVault 的 lastMutationSeqOf 在删除后仍可读，但 DeltaStream.applyServerSnapshot 直接 replaceMembers，旧 snapshotSeq 会整份覆盖本地已删除成员；OfflineMutationQueue 在批量结算失败时用失败批次覆盖待决队列，丢掉在途新增操作。OfflineWithFeedback 的隐藏规则依赖 pendingAction，只是视图表现。

## 二、未选方案证伪

Proposal 1 会话级集合并不能阻止旧快照与队列回滚，且不清理角色索引。Proposal 2 成功路径无幂等 successData，MEMBER_NOT_FOUND 会回滚复活。Proposal 3 的定时器只是视图隐藏，离线与回滚路径仍复活。Proposal 4 整份快照丢弃会丢失其余成员更新。Proposal 5 未改快照与队列。Proposal 7 清空本地待决操作会丢数据。Proposal 8 只按 id 丢弃快照，无法逐条比较变更序号。

## 三、目标设计（状态转移与流程）

删除成功时先把 appliedSeq 写入 lastMutationSeq 形成墓碑再 removeMember，本地成功与服务器 member.removed 事件共用 finalizeMemberRemoval：清理角色并把指向被删成员的审批转交重接到其后继审批人。applyServerSnapshot 按成员比较 snapshotSeq 与 lastMutationSeq：序号更旧的成员被过滤，其他成员正常 upsert；删除操作声明 successData 让 MEMBER_NOT_FOUND 视为已应用；队列结算把失败项并入队首并保留在途新增操作，按原顺序重试。

## 四、验收自测

用 node 运行内嵌断言脚本：断言旧 snapshotSeq 后成员不复存在、其他成员 displayName 仍更新、幂等成功不触发回滚、部分失败时失败成员恢复且队列保留在途操作、删除后角色索引不再解析到已删成员。`
const UH1_NAIVE_DECISION = {
  "selected_proposal_id": 5,
  "root_cause_files": [
    "src/actions/WorkspaceMemberActions.js",
    "src/queue/OfflineMutationQueue.js",
    "src/sync/DeltaStream.js",
    "src/store/MemberVault.js",
    "src/policy/PolicyRoleIndex.js"
  ],
  "root_cause_functions": [
    "deleteMembers",
    "settleBatch",
    "applyServerSnapshot"
  ],
  "discovered_code_invariants": [
    "member.removed 事件与本地删除都需要清理角色索引"
  ],
  "rejected_proposals": {
    "1": "会话级集合只存在于视图层与内存，页面刷新即丢失，且 MemberVault、DeltaStream 与 OfflineMutationQueue 完全不感知，服务端下发旧快照仍会复活成员。",
    "2": "保留快照后直接物理删除，删除失败用快照恢复，但成功路径没有幂等 successData，服务端已删除时 MEMBER_NOT_FOUND 会走失败回滚并让成员重新出现。",
    "3": "3 秒定时器清除 pendingAction 只是视图层隐藏：离线时 isOffline 为真本就不隐藏，旧快照与队列回滚仍会让成员复活。",
    "4": "整份快照按 cursor 丢弃会连带丢掉其余成员的正常更新与成员数据，无法逐条过滤旧数据。",
    "6": "方案过于复杂，不做局部改动。"
  }
}
const UH1_NAIVE_DESIGN = String.raw`# 局部修复

WorkspaceMemberActions 成功回调补充角色清理，PolicyRoleIndex 支持移除与转交重接，OfflineMutationQueue 与 DeltaStream 保持现状。调用链与流程见源码。Proposal 1、2、3、4、5、6 已对比，其余方案仍有缺陷。`

const UH2_GOLDEN_DECISION = {
  "selected_proposal_id": 5,
  "root_cause_files": [
    "src/events/SecondaryClickDispatcher.js",
    "src/modal/BaseModal.js",
    "src/contextmenu/ReportContextMenu.js",
    "src/popover/PopoverRoot.js",
    "src/focus/FocusTrapStack.js",
    "src/fab/FloatingActionTrigger.js",
    "src/hover/HoverQuickBar.js"
  ],
  "discovered_implicit_contracts": [
    "FloatingActionTrigger 的 createFloatingActionTrigger 把 anchorRef 与 targetRef 同时登记进 exclusions，isTriggerExcluded 会同时检查这两份引用；遮罩命中触发按钮或其展开内容时必须交回按钮处理，不能关闭模态框。",
    "点击态浮层压制悬停态：openPopoverLayer 在 click-popover 打开时关闭 hover 层，HoverQuickBar 在存在点击层时不出现，两类浮层互斥。",
    "SecondaryClickDispatcher 的 hitTest 先用 elementsFromPoint 取元素栈并解析注册菜单目标：命中自定义菜单目标时 preventDefault 阻止原生菜单，未命中时放行浏览器原生菜单，形成自定义与原生右键菜单的分流。",
    "FocusTrapStack 是全局 LIFO 焦点栈：releaseFocusTraps 只能从栈顶连续释放，跨层关闭必须自顶向下，被遮挡层先释放会被 blocked 拒绝。"
  ],
  "rejected_proposals": {
    "1": "遮罩的 pointerdown 在捕获阶段先于冒泡执行，菜单容器上的 stopPropagation 无法阻止遮罩捕获监听；忽略非主键也不改变 click 命中顺序，事件路由没有统一命中判定。",
    "2": "给遮罩设置 pointer-events: none 会让菜单打开期间的遮罩完全穿透，关闭菜单与键盘 Esc 后的外部点击无法恢复，菜单项也无法通过遮罩关闭路径。",
    "3": "setTimeout 延迟只能改变同一事件循环内的顺序，遮罩 pointerdown 仍在捕获阶段先执行；延迟关闭还会与下一次打开产生时序竞争，菜单项动作仍被关闭。",
    "4": "ReportContextMenu 的模块级已打开标志是全局单标志，无法表达多菜单与嵌套层级；遮罩点击直接返回会既不关闭菜单也不关闭模态框，留下残留浮层。",
    "6": "把菜单渲染进模态框内容树会绕过 PopoverRoot 浮层登记，焦点栈、命中判定与层级顺序都不再覆盖它，遮罩与 Esc 都无法按层级关闭菜单。",
    "7": "全局 preventDefault 会吞掉所有原生右键菜单，且遮罩命中从 click 改成 mousedown 的 relatedTarget 后，菜单与触发按钮的排除判定失效，遮罩会在按下瞬间关闭模态框。",
    "8": "把遮罩关闭推迟到 pointerup 的下一帧仍然无法区分浮层与遮罩归属，inert 会冻结菜单交互；嵌套菜单与焦点归还顺序依然没有统一层级依据。"
  },
  "routing_matrix": {
    "rightClickAnotherMessage": {
      "closeExisting": true,
      "openNewCustom": true,
      "allowNativeMenu": false,
      "restoreFocus": false
    },
    "rightClickPlainArea": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": true,
      "restoreFocus": true
    },
    "clickFabWhileOpen": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": true
    },
    "hoverActionWhileMenuOpen": {
      "closeExisting": false,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": false
    },
    "pressEscapeWithNestedMenu": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": true
    },
    "outsideLeftClick": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": true
    }
  }
}
const UH2_GOLDEN_DESIGN = String.raw`# 非全屏模态框事件路由与焦点层级设计

## 一、源码调用链

SecondaryClickDispatcher 负责 contextmenu 统一入口与命中判定，ReportContextMenu 维护菜单层级，PopoverRoot 维护浮层登记，FocusTrapStack 维护全局焦点栈，BaseModal 处理遮罩与 Esc，FloatingActionTrigger 与 HoverQuickBar 分别维护触发按钮与悬停浮层。冲突发生在遮罩 pointerdown 与菜单 contextmenu 各自独立处理事件归属。

## 二、未选方案证伪

Proposal 1 的 stopPropagation 无法阻止捕获阶段的遮罩监听；Proposal 2 的 pointer-events: none 让遮罩穿透并使恢复路径失效；Proposal 3 的 setTimeout 不改变捕获顺序；Proposal 4 的模块级标志无法表达嵌套层级；Proposal 6 绕过 PopoverRoot 登记；Proposal 7 的全局 preventDefault 与 relatedTarget 判定会误关模态框；Proposal 8 的 pointerup 延迟与 inert 仍缺少统一归属与层级依据。

## 三、目标事件路由与焦点层级

统一入口先判定命中：命中具备自定义菜单的目标时阻止原生菜单、按后进先出关闭已有菜单并打开新菜单；未命中时关闭已有菜单并放行原生菜单。遮罩外部点击先询问浮层与触发按钮登记，命中浮层或触发按钮时交回组件处理，命中遮罩且存在浮层时只收起浮层岛，没有浮层才关闭模态框。嵌套菜单按层级自顶向下关闭，只关闭最内层时焦点归还打开它的菜单项，一次交互关闭多层只在最外层归还一次，切换菜单不归还焦点。

## 四、路由矩阵推导

rightClickAnotherMessage 关闭旧菜单打开新菜单且不归还焦点；rightClickPlainArea 关闭菜单并放行原生菜单，焦点归还锚点；clickFabWhileOpen 由按钮自身按展开状态切换并归还焦点；hoverActionWhileMenuOpen 被点击层压制，不关闭也不打开；pressEscapeWithNestedMenu 只关闭最内层并归还焦点；outsideLeftClick 只收起浮层岛并归还一次焦点，模态框保持打开。`
const UH2_NAIVE_DECISION = {
  "selected_proposal_id": 2,
  "root_cause_files": [],
  "discovered_implicit_contracts": [
    "FocusTrapStack 是全局 LIFO 焦点栈，releaseFocusTraps 只能从栈顶连续释放。"
  ],
  "rejected_proposals": {
    "1": "遮罩 pointerdown 在捕获阶段先于冒泡执行，菜单上的 stopPropagation 无法阻止遮罩监听。",
    "3": "setTimeout 延迟只改变同一事件循环内的顺序，遮罩 pointerdown 仍先执行，菜单项动作仍被关闭。",
    "4": "模块级全局标志无法表达多菜单与嵌套层级，遮罩点击直接返回会留下残留浮层。"
  },
  "routing_matrix": {
    "rightClickAnotherMessage": {
      "closeExisting": true,
      "openNewCustom": true,
      "allowNativeMenu": false,
      "restoreFocus": false
    },
    "rightClickPlainArea": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": true,
      "restoreFocus": false
    },
    "clickFabWhileOpen": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": true
    },
    "hoverActionWhileMenuOpen": {
      "closeExisting": false,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": true
    },
    "pressEscapeWithNestedMenu": {
      "closeExisting": false,
      "openNewCustom": false,
      "allowNativeMenu": false,
      "restoreFocus": false
    },
    "outsideLeftClick": {
      "closeExisting": true,
      "openNewCustom": false,
      "allowNativeMenu": true,
      "restoreFocus": true
    }
  }
}
const UH2_NAIVE_DESIGN = String.raw`# 局部去遮罩

给遮罩加 pointer-events: none，菜单打开期间穿透。`

// uh3 完整黄金实现（四个子包协同）：MVCC 版本历史 + 租约世代 + 环检测牺牲者 + 流水线收敛
const UH3_GOLDEN_FILES = {
  "src/txengine/tx/manager.py": String.raw`from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..types import StaleReadConflictError


@dataclass
class _Txn:
    tx_id: int
    snapshot_ts: int
    read_only: bool
    state: str = "active"
    writes: Dict[str, object] = field(default_factory=dict)


class MVCCManager:
    def __init__(self) -> None:
        self._clock = 0
        self._next_tx_id = 0
        self._txns: Dict[int, _Txn] = {}
        self._versions: Dict[str, List[Tuple[int, object]]] = {}

    def _txn(self, tx_id: int) -> _Txn:
        tx = self._txns.get(tx_id)
        if tx is None:
            raise KeyError("unknown transaction %r" % (tx_id,))
        return tx

    def _active(self, tx_id: int) -> _Txn:
        tx = self._txn(tx_id)
        if tx.state != "active":
            raise RuntimeError(
                "transaction %s is %s" % (tx_id, tx.state)
            )
        return tx

    def begin_tx(self, read_only: bool = False) -> int:
        self._next_tx_id += 1
        self._clock += 1
        tx = _Txn(
            tx_id=self._next_tx_id,
            snapshot_ts=self._clock,
            read_only=bool(read_only),
        )
        self._txns[tx.tx_id] = tx
        return tx.tx_id

    def snapshot_ts(self, tx_id: int) -> int:
        return self._txn(tx_id).snapshot_ts

    def transaction_state(self, tx_id: int) -> str:
        return self._txn(tx_id).state

    def is_active(self, tx_id: int) -> bool:
        tx = self._txns.get(tx_id)
        return tx is not None and tx.state == "active"

    def is_read_only(self, tx_id: int) -> bool:
        return self._txn(tx_id).read_only

    def _visible_version(self, snapshot_ts: int, key: str):
        versions = self._versions.get(key)
        if not versions:
            return None
        for commit_ts, value in reversed(versions):
            if commit_ts <= snapshot_ts:
                return value, commit_ts
        return None

    def read(self, tx_id: int, key: str) -> Optional[object]:
        value, _commit_ts = self.read_version(tx_id, key)
        return value

    def read_version(
        self, tx_id: int, key: str
    ) -> Tuple[Optional[object], Optional[int]]:
        tx = self._active(tx_id)
        if key in tx.writes:
            return tx.writes[key], None
        visible = self._visible_version(tx.snapshot_ts, key)
        if visible is None:
            return None, None
        return visible[0], visible[1]

    def scan(self, tx_id: int, prefix: str = "") -> Dict[str, object]:
        tx = self._active(tx_id)
        result: Dict[str, object] = {}
        for key in list(self._versions.keys()):
            if not key.startswith(prefix):
                continue
            visible = self._visible_version(tx.snapshot_ts, key)
            if visible is not None:
                result[key] = visible[0]
        for key, value in tx.writes.items():
            if key.startswith(prefix):
                result[key] = value
        return result

    def write(self, tx_id: int, key: str, value: object) -> None:
        tx = self._active(tx_id)
        if tx.read_only:
            raise RuntimeError("transaction %s is read-only" % (tx_id,))
        if value is None:
            raise ValueError("value must not be None")
        tx.writes[key] = value

    def pending_keys(self, tx_id: int) -> Tuple[str, ...]:
        tx = self._txn(tx_id)
        if tx.state != "active":
            return ()
        return tuple(tx.writes.keys())

    def latest_commit_ts(self, key: str) -> Optional[int]:
        versions = self._versions.get(key)
        if not versions:
            return None
        return versions[-1][0]

    def commit(self, tx_id: int) -> int:
        tx = self._active(tx_id)
        if tx.read_only:
            tx.state = "committed"
            return tx.snapshot_ts
        for key in sorted(tx.writes.keys()):
            observed = self.latest_commit_ts(key)
            if observed is not None and observed > tx.snapshot_ts:
                raise StaleReadConflictError(key, tx.snapshot_ts, observed)
        self._clock += 1
        commit_ts = self._clock
        for key, value in tx.writes.items():
            self._versions.setdefault(key, []).append((commit_ts, value))
        tx.writes.clear()
        tx.state = "committed"
        return commit_ts

    def abort(self, tx_id: int) -> None:
        tx = self._txn(tx_id)
        if tx.state != "active":
            return
        tx.writes.clear()
        tx.state = "aborted"`,
  "src/txengine/cache/lease_cache.py": String.raw`from typing import Dict, Optional, Set, Tuple


class LeaseCache:
    def __init__(self) -> None:
        self._entries: Dict[str, object] = {}
        self._epochs: Dict[str, int] = {}
        self._leases: Dict[int, Set[Tuple[str, int]]] = {}

    def _epoch_of(self, key: str) -> int:
        return self._epochs.get(key, 0)

    def get_or_lease(
        self, key: str, tx_id: int
    ) -> Tuple[Optional[object], int]:
        epoch = self._epoch_of(key)
        if key in self._entries:
            return self._entries[key], epoch
        self._leases.setdefault(tx_id, set()).add((key, epoch))
        return None, epoch

    def fill_if_valid(self, key: str, epoch: int, payload: object) -> bool:
        if epoch != self._epoch_of(key):
            return False
        if key in self._entries:
            return False
        self._entries[key] = payload
        for owner, leases in list(self._leases.items()):
            leases.discard((key, epoch))
            if not leases:
                del self._leases[owner]
        return True

    def invalidate_on_write_or_abort(self, key: str) -> int:
        epoch = self._epoch_of(key) + 1
        self._epochs[key] = epoch
        self._entries.pop(key, None)
        return epoch

    def invalidate_leases_for_tx(self, tx_id: int) -> int:
        leases = self._leases.pop(tx_id, set())
        invalidated = 0
        for key, epoch in sorted(leases):
            if epoch != self._epoch_of(key):
                continue
            self.invalidate_on_write_or_abort(key)
            invalidated += 1
        return invalidated`,
  "src/txengine/lock/wait_graph.py": String.raw`from typing import Callable, Dict, List, Optional, Tuple

from ..types import DeadlockVictimError


class WaitForGraph:
    def __init__(
        self, abort_tx: Optional[Callable[[int], None]] = None
    ) -> None:
        self._owners: Dict[str, int] = {}
        self._waits: Dict[int, Tuple[str, int]] = {}
        self._abort_tx = abort_tx

    def _cycle_from(self, start: int) -> Optional[Tuple[int, ...]]:
        path: List[int] = []
        positions: Dict[int, int] = {}
        cursor = start
        while cursor in self._waits:
            if cursor in positions:
                cycle = path[positions[cursor]:]
                pivot = cycle.index(min(cycle))
                ordered = cycle[pivot:] + cycle[:pivot]
                return tuple(ordered)
            positions[cursor] = len(path)
            path.append(cursor)
            cursor = self._waits[cursor][1]
        return None

    def _drop_victim_state(self, tx_id: int) -> None:
        for key in [key for key, owner in self._owners.items() if owner == tx_id]:
            self.release_lock(tx_id, key)
        self._waits.pop(tx_id, None)

    def acquire_lock(self, tx_id: int, key: str) -> bool:
        owner = self._owners.get(key)
        if owner is None:
            self._owners[key] = tx_id
            pending = self._waits.get(tx_id)
            if pending is not None and pending[0] == key:
                del self._waits[tx_id]
            return True
        if owner == tx_id:
            return True
        self._waits[tx_id] = (key, owner)
        cycle = self._cycle_from(tx_id)
        if cycle is None:
            return False
        victim = max(cycle)
        if self._abort_tx is not None:
            self._abort_tx(victim)
        self._drop_victim_state(victim)
        raise DeadlockVictimError(victim, cycle)

    def release_lock(self, tx_id: int, key: str) -> bool:
        if self._owners.get(key) != tx_id:
            return False
        del self._owners[key]
        for waiter, (wait_key, _owner) in list(self._waits.items()):
            if wait_key == key:
                del self._waits[waiter]
        return True

    def release_all(self, tx_id: int) -> Tuple[str, ...]:
        keys = tuple(
            key for key, owner in self._owners.items() if owner == tx_id
        )
        for key in keys:
            self.release_lock(tx_id, key)
        self._waits.pop(tx_id, None)
        return keys

    def held_locks(self, tx_id: int) -> Tuple[str, ...]:
        return tuple(
            key for key, owner in self._owners.items() if owner == tx_id
        )

    def owner(self, key: str) -> Optional[int]:
        return self._owners.get(key)

    def waiting_on(self, tx_id: int) -> Optional[Tuple[str, int]]:
        return self._waits.get(tx_id)`,
  "src/txengine/coordinator/pipeline.py": String.raw`from typing import Dict, Optional

from ..cache.lease_cache import LeaseCache
from ..lock.wait_graph import WaitForGraph
from ..tx.manager import MVCCManager
from ..types import StaleReadConflictError


class TransactionPipeline:
    def __init__(self, cache: Optional[LeaseCache] = None) -> None:
        self.mvcc = MVCCManager()
        self.cache = cache if cache is not None else LeaseCache()
        self.locks = WaitForGraph(abort_tx=self._abort_deadlock_victim)

    def _abort_deadlock_victim(self, tx_id: int) -> None:
        self.abort(tx_id)

    def begin(self, read_only: bool = False) -> int:
        return self.mvcc.begin_tx(read_only)

    def read(self, tx_id: int, key: str) -> Optional[object]:
        value, commit_ts = self.mvcc.read_version(tx_id, key)
        if commit_ts is None and value is not None:
            return value
        payload, epoch = self.cache.get_or_lease(key, tx_id)
        if payload is not None and payload[1] <= self.mvcc.snapshot_ts(tx_id):
            return payload[0]
        if value is not None and commit_ts is not None and commit_ts == self.mvcc.latest_commit_ts(key):
            self.cache.fill_if_valid(key, epoch, (value, commit_ts))
        return value

    def scan(self, tx_id: int, prefix: str = "") -> Dict[str, object]:
        return self.mvcc.scan(tx_id, prefix)

    def write(self, tx_id: int, key: str, value: object) -> bool:
        state = self.mvcc.transaction_state(tx_id)
        if state != "active":
            raise RuntimeError("transaction %s is %s" % (tx_id, state))
        if self.mvcc.is_read_only(tx_id):
            raise RuntimeError("transaction %s is read-only" % (tx_id,))
        if value is None:
            raise ValueError("value must not be None")
        held_before = key in self.locks.held_locks(tx_id)
        if not self.locks.acquire_lock(tx_id, key):
            return False
        try:
            self.mvcc.write(tx_id, key, value)
        except Exception:
            if not held_before:
                self.locks.release_lock(tx_id, key)
            raise
        self.cache.invalidate_on_write_or_abort(key)
        return True

    def commit(self, tx_id: int) -> int:
        keys = self.mvcc.pending_keys(tx_id)
        try:
            commit_ts = self.mvcc.commit(tx_id)
        except StaleReadConflictError:
            self.abort(tx_id)
            raise
        for key in keys:
            self.cache.invalidate_on_write_or_abort(key)
        self.locks.release_all(tx_id)
        return commit_ts

    def abort(self, tx_id: int) -> None:
        self.mvcc.transaction_state(tx_id)
        keys = self.mvcc.pending_keys(tx_id)
        if self.mvcc.is_active(tx_id):
            self.mvcc.abort(tx_id)
        for key in keys:
            self.cache.invalidate_on_write_or_abort(key)
        self.cache.invalidate_leases_for_tx(tx_id)
        self.locks.release_all(tx_id)`
}

const UH3_GOLDEN_DESIGN = String.raw`# txengine 事务 / 租约缓存 / 死锁仲裁流水线设计

## 一、四个子包的分层、职责与依赖方向

tx 子包提供 MVCCManager：分配事务 ID 与快照时间戳、维护每键版本历史、快照读视图与提交校验。cache 子包提供 LeaseCache：按 key 维护只增不减的世代号与待回填租约。lock 子包提供 WaitForGraph：持有关系、等待关系、环路检测与牺牲者仲裁。coordinator 子包提供 TransactionPipeline，自下而上依赖 tx、cache、lock 三者，把快照读取、写入加锁、提交/中止收敛到同一条路径；依赖方向只能是 coordinator 依赖其余三者，反向不成立。

## 二、快照读视图

事务开始时固定 snapshot_ts，读版本时在键的版本历史中取提交时间戳不大于 snapshot_ts 的最新版本，因此重复读取同一键结果稳定、两次 scan 不会看到快照之后提交的新键。写集优先于快照版本，读己之写不进入共享缓存。

## 三、租约世代号的变化时机

未命中时 get_or_lease 登记 (key, epoch) 待回填租约；fill_if_valid 只在 epoch 等于当前世代号且无条目时写入并消耗该租约。写入、提交、中止都会把相关键的 epoch 加一并删除缓存条目，因此旧世代号的回填必然失败；中止时 invalidate_leases_for_tx 会作废该事务仍处于当前世代的全部待回填租约，阻断 ABA 幽灵回填。

## 四、等待关系与牺牲者仲裁

写入发生锁冲突时登记等待者→持有者边并检测环路；发现环路后选择环路上事务 ID 最大的最年轻事务作为牺牲者，先调用 abort_tx 回调回滚其写集、作废其租约并释放其锁，再清理等待图中牺牲者的锁与等待边，最后抛出携带环路的 DeadlockVictimError，环路按等待方向从最小事务 ID 开始排列。

## 五、提交与中止的收敛与失败路径

提交时先做快照校验，冲突则抛出 StaleReadConflictError 并按中止规则清理写集、缓存、租约与锁；成功则发布新版本、使写过键的缓存失效并释放锁。中止丢弃写集、失效写过键的缓存、作废租约并释放锁与等待记录，对已结束事务幂等。

## 六、已知边界

不处理线程并发、不阻塞等待、不做持久化、GC、TTL 与跨进程共享。`
const UH3_NAIVE_DESIGN = String.raw`# 部分实现设计

tx 子包负责 MVCCManager 与快照时间戳，cache 子包负责 LeaseCache 世代号，lock 与 coordinator 暂未改造。分层职责与依赖方向如下：coordinator 依赖 tx 与 cache。读取时未命中会登记租约，fill_if_valid 仅在世代号一致时回填，回填会消耗租约。`

test("evals/grade：超难题 uh1（离线删除复活）基线 <=15、直觉局部补丁 40-65、完整黄金实现 100", async () => {
  const baselineWorkspace = await createEvalWorkspace(UH1_FIXTURE_ID)
  try {
    const graded = await gradeUltraHardTask(UH1_FIXTURE_ID, baselineWorkspace)
    assert.ok(graded.totalScore <= 15, "基线未改夹具得分必须 <=15，实际 " + graded.totalScore)
    assert.equal(graded.totalScore, 9)
    assert.equal(graded.details.passedCount, 1, "基线只在离线删除状态一项命中（旧快照会复活成员，新版快照探针同时校验旧快照防复活）")
  } finally {
    await rm(baselineWorkspace, { recursive: true, force: true })
  }

  // 直觉局部补丁：只补方案选择提到的幂等 successData 与角色索引清理，快照与队列仍沿用基线
  const naiveWorkspace = await createEvalWorkspace(UH1_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(naiveWorkspace, {
      "src/policy/PolicyRoleIndex.js": UH1_GOLDEN_FILES["src/policy/PolicyRoleIndex.js"],
      "src/actions/WorkspaceMemberActions.js": UH1_GOLDEN_FILES["src/actions/WorkspaceMemberActions.js"],
      "DECISION.json": JSON.stringify(UH1_NAIVE_DECISION, null, 2),
      "DESIGN.md": UH1_NAIVE_DESIGN
    })
    const graded = await gradeUltraHardTask(UH1_FIXTURE_ID, naiveWorkspace)
    assert.ok(graded.totalScore >= 40 && graded.totalScore <= 65, "直觉局部补丁得分应落在 40-65，实际 " + graded.totalScore)
    assert.equal(graded.details.perProbe.t4, false, "未改 DeltaStream 仍会被旧快照复活")
    assert.equal(graded.details.perProbe.t8, false, "未改队列仍会丢在途新增操作")
  } finally {
    await rm(naiveWorkspace, { recursive: true, force: true })
  }

  const goldenWorkspace = await createEvalWorkspace(UH1_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(goldenWorkspace, {
      ...UH1_GOLDEN_FILES,
      "DECISION.json": JSON.stringify(UH1_GOLDEN_DECISION, null, 2),
      "DESIGN.md": UH1_GOLDEN_DESIGN
    })
    const graded = await gradeUltraHardTask(UH1_FIXTURE_ID, goldenWorkspace)
    assert.equal(graded.totalScore, 100, "完整黄金实现必须得 100 分")
    assert.equal(graded.deterministic60, 60)
    assert.equal(graded.checkpoints30, 30)
    assert.equal(graded.discipline10, 10)
    assert.deepEqual(graded.details.perProbe, expectedUltraProbeFlags(15, true))
    assert.equal(graded.details.selectedId, 6)
    assert.equal(graded.details.issueUntouched, true)
    assert.equal(graded.details.substantiveRejections, 7)

    // 篡改只读题面 ISSUE_AND_PROPOSALS.md：只读纪律扣 5 分，其余维度不变
    const issuePath = path.join(goldenWorkspace, "ISSUE_AND_PROPOSALS.md")
    await writeFile(issuePath, (await readFile(issuePath, "utf8")) + "\n篡改\n", "utf8")
    const tampered = await gradeUltraHardTask(UH1_FIXTURE_ID, goldenWorkspace)
    assert.equal(tampered.details.issueUntouched, false)
    assert.equal(tampered.discipline10, 5)
    assert.equal(tampered.totalScore, 95)
  } finally {
    await rm(goldenWorkspace, { recursive: true, force: true })
  }
})

test("evals/grade：超难题 uh2（事件路由矩阵）基线 <=15、直觉局部补丁 40-65、完整黄金实现 100", async () => {
  const baselineWorkspace = await createEvalWorkspace(UH2_FIXTURE_ID)
  try {
    const graded = await gradeUltraHardTask(UH2_FIXTURE_ID, baselineWorkspace)
    assert.ok(graded.totalScore <= 15, "基线未改夹具得分必须 <=15，实际 " + graded.totalScore)
    assert.equal(graded.totalScore, 10)
    assert.equal(graded.details.srcUntouched, true)
    assert.equal(graded.details.matrixHits, 0)
  } finally {
    await rm(baselineWorkspace, { recursive: true, force: true })
  }

  const naiveWorkspace = await createEvalWorkspace(UH2_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(naiveWorkspace, {
      "DECISION.json": JSON.stringify(UH2_NAIVE_DECISION, null, 2),
      "DESIGN.md": UH2_NAIVE_DESIGN
    })
    const graded = await gradeUltraHardTask(UH2_FIXTURE_ID, naiveWorkspace)
    assert.ok(graded.totalScore >= 40 && graded.totalScore <= 65, "直觉局部补丁得分应落在 40-65，实际 " + graded.totalScore)
    assert.ok(graded.details.matrixHits > 0 && graded.details.matrixHits < 24, "局部直觉矩阵只能部分命中")
  } finally {
    await rm(naiveWorkspace, { recursive: true, force: true })
  }

  const goldenWorkspace = await createEvalWorkspace(UH2_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(goldenWorkspace, {
      "DECISION.json": JSON.stringify(UH2_GOLDEN_DECISION, null, 2),
      "DESIGN.md": UH2_GOLDEN_DESIGN
    })
    const graded = await gradeUltraHardTask(UH2_FIXTURE_ID, goldenWorkspace)
    assert.equal(graded.totalScore, 100, "完整黄金实现必须得 100 分")
    assert.equal(graded.deterministic60, 60)
    assert.equal(graded.checkpoints30, 30)
    assert.equal(graded.discipline10, 10)
    assert.equal(graded.details.matrixHits, 24)
    assert.equal(graded.details.contractHits, 4)
    assert.equal(graded.details.substantiveRejections, 7)
    assert.equal(graded.details.designDelivered, true)

    // 缺失其中一条隐式契约（触发按钮 anchorRef/targetRef 排除）：契约每项 4 分，少一条扣 4 分
    await writeWorkspaceFiles(goldenWorkspace, {
      "DECISION.json": JSON.stringify({ ...UH2_GOLDEN_DECISION, discovered_implicit_contracts: UH2_GOLDEN_DECISION.discovered_implicit_contracts.slice(1) }, null, 2)
    })
    const missingContract = await gradeUltraHardTask(UH2_FIXTURE_ID, goldenWorkspace)
    assert.equal(missingContract.details.contractHits, 3)
    assert.equal(missingContract.checkpoints30, 26)
    assert.equal(missingContract.totalScore, 96)

    // 题面要求 DESIGN.md 与 DECISION.json 同时交付：设计缺失或为空时不能拿到满 checkpoints30
    await writeWorkspaceFiles(goldenWorkspace, { "DECISION.json": JSON.stringify(UH2_GOLDEN_DECISION, null, 2) })
    await rm(path.join(goldenWorkspace, "DESIGN.md"))
    const missingDesign = await gradeUltraHardTask(UH2_FIXTURE_ID, goldenWorkspace)
    assert.equal(missingDesign.details.designDelivered, false)
    assert.equal(missingDesign.checkpoints30, 0)
    assert.equal(missingDesign.totalScore, 70)
    await writeWorkspaceFiles(goldenWorkspace, { "DESIGN.md": "   " })
    const emptyDesign = await gradeUltraHardTask(UH2_FIXTURE_ID, goldenWorkspace)
    assert.equal(emptyDesign.details.designDelivered, false)
    assert.equal(emptyDesign.totalScore, 70)
    await writeWorkspaceFiles(goldenWorkspace, { "DESIGN.md": UH2_GOLDEN_DESIGN })

    // 篡改只读 src/ 任意一个文件：只读纪律 10 分全扣
    const tamperPath = path.join(goldenWorkspace, "src/popover/PopoverRoot.js")
    await writeFile(tamperPath, (await readFile(tamperPath, "utf8")) + "\n// tampered\n", "utf8")
    const tampered = await gradeUltraHardTask(UH2_FIXTURE_ID, goldenWorkspace)
    assert.equal(tampered.details.srcUntouched, false)
    assert.equal(tampered.discipline10, 0)
    assert.equal(tampered.totalScore, 90)
  } finally {
    await rm(goldenWorkspace, { recursive: true, force: true })
  }
})

test("evals/grade：超难题 uh3（事务/缓存/死锁流水线）基线 <=15、直觉局部补丁 40-65、完整黄金实现 100", { skip: PYTHON3_SKIP_REASON }, async () => {
  const baselineWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    const graded = await gradeUltraHardTask(UH3_FIXTURE_ID, baselineWorkspace)
    assert.ok(graded.totalScore <= 15, "基线未改夹具得分必须 <=15，实际 " + graded.totalScore)
    assert.equal(graded.totalScore, 13)
    assert.equal(graded.details.passedCount, 1, "基线只命中非环路锁冲突一项")
  } finally {
    await rm(baselineWorkspace, { recursive: true, force: true })
  }

  // 直觉局部补丁：只实现 MVCC 与租约缓存两个子包，等待图与流水线仍沿用基线
  const naiveWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(naiveWorkspace, {
      "src/txengine/tx/manager.py": UH3_GOLDEN_FILES["src/txengine/tx/manager.py"],
      "src/txengine/cache/lease_cache.py": UH3_GOLDEN_FILES["src/txengine/cache/lease_cache.py"],
      "DESIGN.md": UH3_NAIVE_DESIGN
    })
    const graded = await gradeUltraHardTask(UH3_FIXTURE_ID, naiveWorkspace)
    assert.ok(graded.totalScore >= 40 && graded.totalScore <= 65, "直觉局部补丁得分应落在 40-65，实际 " + graded.totalScore)
    assert.equal(graded.details.couplingAll, false)
    assert.equal(graded.details.perTest.t11, false)
  } finally {
    await rm(naiveWorkspace, { recursive: true, force: true })
  }

  const goldenWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    await writeWorkspaceFiles(goldenWorkspace, {
      ...UH3_GOLDEN_FILES,
      "DESIGN.md": UH3_GOLDEN_DESIGN
    })
    const graded = await gradeUltraHardTask(UH3_FIXTURE_ID, goldenWorkspace)
    assert.equal(graded.totalScore, 100, "完整黄金实现必须得 100 分")
    assert.equal(graded.deterministic60, 60)
    assert.equal(graded.checkpoints30, 30)
    assert.equal(graded.discipline10, 10)
    assert.deepEqual(graded.details.perTest, expectedUltraProbeFlags(20, true))
    assert.equal(graded.details.couplingAll, true)
    assert.equal(graded.details.perTest.t19, true, "T19 覆盖只读事务写入与写 None 的失败路径")
  } finally {
    await rm(goldenWorkspace, { recursive: true, force: true })
  }

  // 负例：受测模块在导入期伪造 __GRADE__ 完成行并 os._exit(0)，密封探针必须拒绝伪结果
  const spoofWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    const fakePayload = {
      probe_complete: true,
      syntax_ok: true,
      conflict_free: true,
      subpackages_ok: true,
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["t" + (index + 1), true]))
    }
    const spoofSource = "import json, os\npayload = json.loads(" + JSON.stringify(JSON.stringify(fakePayload)) + ")\nprint('__GRADE__' + json.dumps(payload))\nos._exit(0)\n"
    await writeWorkspaceFiles(spoofWorkspace, { "src/txengine/__init__.py": spoofSource })
    const spoofed = await gradeUltraHardTask(UH3_FIXTURE_ID, spoofWorkspace)
    assert.equal(spoofed.deterministic60, 0, "导入期伪造完成行不得冒领任何行为分")
    assert.equal(spoofed.details.couplingAll, false)
    assert.ok(spoofed.totalScore <= 10, "伪造输出最多保留静态语法纪律分，实际 " + spoofed.totalScore)
  } finally {
    await rm(spoofWorkspace, { recursive: true, force: true })
  }

  // 负例：受测模块在导入期直接访问 __main__ 里的完成证明/真实退出通道并试图冒领
  const mainAttackWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    const fakeMainPayload = {
      probe_complete: true,
      syntax_ok: true,
      conflict_free: true,
      subpackages_ok: true,
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["t" + (index + 1), true]))
    }
    const attackSource = [
      "import json, sys",
      "main = sys.modules['__main__']",
      "payload = json.loads(" + JSON.stringify(JSON.stringify(fakeMainPayload)) + ")",
      "main._emit(payload)",
      "main._real_exit(0)"
    ].join("\n") + "\n"
    await writeWorkspaceFiles(mainAttackWorkspace, { "src/txengine/__init__.py": attackSource })
    const attacked = await gradeUltraHardTask(UH3_FIXTURE_ID, mainAttackWorkspace)
    assert.equal(attacked.deterministic60, 0, "访问 __main__ 发射器不得冒领任何行为分")
    assert.equal(attacked.details.couplingAll, false)
    assert.ok(attacked.totalScore <= 10, "该攻击最多保留静态语法纪律分，实际 " + attacked.totalScore)
  } finally {
    await rm(mainAttackWorkspace, { recursive: true, force: true })
  }

  // 负例：跨越工作线程取帧或遍历对象图定位主线程完成证明，必须被内省守卫拒绝
  const introspectWorkspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    const introspectSource = ["import gc", "import sys", "sys._current_frames()", "gc.get_objects()"].join("\n") + "\n"
    await writeWorkspaceFiles(introspectWorkspace, { "src/txengine/__init__.py": introspectSource })
    const introspected = await gradeUltraHardTask(UH3_FIXTURE_ID, introspectWorkspace)
    assert.equal(introspected.deterministic60, 0, "跨线程取帧不得冒领任何行为分")
    assert.ok(introspected.totalScore <= 10, "该攻击最多保留静态语法纪律分，实际 " + introspected.totalScore)
  } finally {
    await rm(introspectWorkspace, { recursive: true, force: true })
  }
})

test("evals/grade：超难题 uh3 的受测导入与 20 项探针必须同线程执行（sqlite3 线程亲和样例得 100）", { skip: PYTHON3_SKIP_REASON || SQLITE3_SKIP_REASON }, async () => {
  const workspace = await createEvalWorkspace(UH3_FIXTURE_ID)
  try {
    const manager = UH3_GOLDEN_FILES["src/txengine/tx/manager.py"]
    const threadBoundManager = "import sqlite3\n\n_THREAD_BOUND_CONNECTION = sqlite3.connect(\":memory:\")\n\n" + manager.replace(
      "    def __init__(self) -> None:\n        self._clock = 0",
      "    def __init__(self) -> None:\n        _THREAD_BOUND_CONNECTION.execute(\"SELECT 1\").fetchone()\n        self._clock = 0"
    )
    assert.ok(threadBoundManager.includes("_THREAD_BOUND_CONNECTION.execute"), "线程亲和补丁必须落到 MVCCManager.__init__")
    await writeWorkspaceFiles(workspace, {
      ...UH3_GOLDEN_FILES,
      "src/txengine/tx/manager.py": threadBoundManager,
      "DESIGN.md": UH3_GOLDEN_DESIGN
    })
    const graded = await gradeUltraHardTask(UH3_FIXTURE_ID, workspace)
    assert.equal(graded.totalScore, 100, "在导入线程创建 sqlite3 连接的合规实现必须得 100 分")
    assert.deepEqual(graded.details.perTest, expectedUltraProbeFlags(20, true))
    assert.equal(graded.details.couplingAll, true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("evals/grade：超难题 ID 路由与未知任务显式报错", async () => {
  await assert.rejects(
    () => gradeUltraHardTask("uh_unknown_task", os.tmpdir()),
    /未知的超难题 ID/
  )
})

test("evals/tasks & file-inventory：3 道 ultra-hard 零注释超难题注册与夹具契约完整", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const reg = await loadTasksRegistry()
  const tasks = reg.tasks
  assert.equal(tasks.filter((task) => task.tier === "ultra-hard").length, 3, "注册表必须有且仅有 3 道 ultra-hard 题")
  const contracts = [
    {
      id: UH1_FIXTURE_ID,
      benchmark: "SWE-Lancer-Diamond",
      entryStage: "implementation",
      language: "javascript",
      fixtureDir: "evals/fixtures/" + UH1_FIXTURE_ID,
      writable: [{ path: "DECISION.json", kind: "design" }, { path: "DESIGN.md", kind: "design" }, { path: "src/", kind: "source" }],
      promptKeywords: ["ISSUE_AND_PROPOSALS.md", "src/", "8 份", "DECISION.json", "DESIGN.md", "严禁修改"],
      proposalCount: 8,
      fixtureFiles: [
        "ISSUE_AND_PROPOSALS.md",
        "src/actions/WorkspaceMemberActions.js",
        "src/policy/PolicyRoleIndex.js",
        "src/queue/OfflineMutationQueue.js",
        "src/store/MemberVault.js",
        "src/sync/DeltaStream.js",
        "src/ui/OfflineWithFeedback.js"
      ]
    },
    {
      id: UH2_FIXTURE_ID,
      benchmark: "SWE-Lancer-Diamond",
      entryStage: "design",
      language: "javascript",
      fixtureDir: "evals/fixtures/" + UH2_FIXTURE_ID,
      writable: [{ path: "DECISION.json", kind: "design" }, { path: "DESIGN.md", kind: "design" }],
      promptKeywords: ["ISSUE_AND_PROPOSALS.md", "src/", "只读", "8 份", "routing_matrix", "DECISION.json"],
      proposalCount: 8,
      fixtureFiles: [
        "ISSUE_AND_PROPOSALS.md",
        "src/contextmenu/ReportContextMenu.js",
        "src/events/SecondaryClickDispatcher.js",
        "src/fab/FloatingActionTrigger.js",
        "src/focus/FocusTrapStack.js",
        "src/hover/HoverQuickBar.js",
        "src/modal/BaseModal.js",
        "src/popover/PopoverRoot.js"
      ]
    },
    {
      id: UH3_FIXTURE_ID,
      benchmark: "CooperBench",
      entryStage: "implementation",
      language: "python",
      fixtureDir: "evals/fixtures/" + UH3_FIXTURE_ID,
      writable: [{ path: "DESIGN.md", kind: "design" }, { path: "src/txengine/", kind: "source" }],
      promptKeywords: ["SPEC.md", "src/txengine/", "tx", "cache", "lock", "coordinator", "DESIGN.md"],
      proposalCount: null,
      fixtureFiles: [
        "SPEC.md",
        "src/txengine/__init__.py",
        "src/txengine/types.py",
        "src/txengine/tx/__init__.py",
        "src/txengine/tx/manager.py",
        "src/txengine/cache/__init__.py",
        "src/txengine/cache/lease_cache.py",
        "src/txengine/lock/__init__.py",
        "src/txengine/lock/wait_graph.py",
        "src/txengine/coordinator/__init__.py",
        "src/txengine/coordinator/pipeline.py"
      ]
    }
  ]
  for (const expected of contracts) {
    const task = tasks.find((entry) => entry.id === expected.id)
    assert.ok(task, "注册表缺少超难题 " + expected.id)
    assert.equal(task.tier, "ultra-hard")
    assert.equal(task.board, "main")
    assert.equal(task.benchmark, expected.benchmark)
    assert.equal(task.entryStage, expected.entryStage)
    assert.equal(task.language, expected.language)
    assert.equal(task.fixtureDir, expected.fixtureDir)
    assert.deepEqual(task.writable, expected.writable, expected.id + " 的 writable 契约不匹配")
    for (const keyword of expected.promptKeywords) {
      assert.ok(task.prompt.includes(keyword), expected.id + " 的 prompt 必须提及 " + keyword)
    }
    for (const relativeFile of expected.fixtureFiles) {
      await assert.doesNotReject(access(path.join(projectRoot, expected.fixtureDir, relativeFile)), expected.id + " 夹具缺少 " + relativeFile)
    }
    if (expected.proposalCount !== null) {
      const spec = await readFile(path.join(projectRoot, expected.fixtureDir, "ISSUE_AND_PROPOSALS.md"), "utf8")
      assert.equal((spec.match(/^### Proposal [1-9][0-9]*$/gm) ?? []).length, expected.proposalCount, expected.id + " 的候选方案数量必须为 8")
    }
    const inventory = JSON.parse(await readFile(path.join(projectRoot, "docs/file-inventory.json"), "utf8"))
    for (const relativeFile of expected.fixtureFiles) {
      const inventoryPath = path.join(expected.fixtureDir, relativeFile).split(path.sep).join("/")
      assert.ok(inventory.newImplementation.includes(inventoryPath), "file-inventory.newImplementation 缺少 " + inventoryPath)
    }
  }
})
