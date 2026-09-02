// tw-dispatch.js — team-work 工作流派发工具（方案 docs/dsh-dispatch-tool-plan.md）
// 单次调用完成一个波次的完整派发：子进程 tw dispatch-plan 拿波次事实 → 派单逐张（串行）经共享创建核心
// createDirectedSubagent（target 直取 modelHint，不重选档位）→ 子进程 tw agent-map 登记续派映射。
// 标签按派单事实自动拼接（P4 回归：阶段缩写/角色/包/任务名四项全是 Runtime 自有事实，模型只可给
// 可选简述 note）。波次机不在派发点时原样透传卡片、不创建任何子代理——Lead 的推进循环收敛为
// 「反复调 tw-dispatch 直到终态卡片」。续派（continuation 且有 expectedAgentId）不归本工具：续聊是
// send_message 不是创建。组合发生在绑定层：不改 dispatch-plan / agent-map 的 CLI 语义，CoreRuntime 不感知本工具。
import { spawn } from "node:child_process"
import { createDirectedSubagent, decisionTableText, SUBAGENT_PROVIDER } from "./tw-tool-subagent.js"
import { resolveChildCwd, resolveTwExecutable } from "./tw-tool.js"

export const TOOL_NAME = "tw-dispatch"

// 阶段缩写固定表（与 skill dsh-orchestration.md 同源；恢复二阶段切链删除的 tagLabel 语义：
// design/spec 的 review 阶段复用 DESIGN/SPEC 缩写——同阶段同缩写，无独立缩写）。未知阶段回退原 id，
// 不猜测语义。workflow.stages 是数据驱动扩展点：新阶段落在固定表外时按原 id 展示。
export const STAGE_ABBREV = Object.freeze({
  research: "RES",
  design: "DESIGN",
  "design-review": "DESIGN",
  spec: "SPEC",
  "spec-review": "SPEC",
  implementation: "IMPL",
  test: "TEST",
  "code-review": "CR",
  e2e: "E2E",
  finish: "FIN",
})

// 角色缩写：challenger 固定缩写 chal（省 6 字符）；其余原样（owner/expert）。
export function roleAbbrev(role) {
  return role === "challenger" ? "chal" : String(role ?? "")
}

// 标签 = `阶段缩写·角色[@包] · 简述 #任务名`（纯展示语义：模型选择由创建核心 target 直达、续派映射由
// agent-map 登记，标签写错只影响人读分组）。@包仅多包波携带——dispatch-plan 对单包/无包派单不输出
// package 字段，字段在场即多包波次成员。简述 = note；缺省自动生成（任务名-角色-轮次）：任务名重复入
// 简述是有意设计——侧栏从尾部截断时 #任务名 段先被截掉，简述里的任务名保住辨识度。
export function buildDispatchLabel(plan, wave, note) {
  const task = String(plan?.task ?? "")
  const ab = STAGE_ABBREV[plan?.stage] ?? String(plan?.stage ?? "")
  const role = roleAbbrev(wave?.role)
  const pkg = wave?.package != null ? "@" + String(wave.package) : ""
  const brief =
    typeof note === "string" && note.trim()
      ? note.trim()
      : task + "-" + role + "-r" + String(wave?.round ?? 1)
  return ab + "·" + role + pkg + " · " + brief + " #" + task
}

// 工具说明（三处同源的分工表：tw-tool-subagent 工具说明 / systemPrompt section / 本工具说明，
// 全部引用 tw-tool-subagent.js 的 decisionTableText()，文案不可能漂移）。
export function twDispatchToolDescription() {
  return [
    "team-work 工作流派发：单次调用完成一个波次的完整派发——推进任务到派发点、按 dispatch-plan 的 modelHint 创建成员子代理（不重选档位）、登记续派映射、自动拼接展示标签。",
    "波次机不在派发点时（awaiting-user/wait-inflight/completed/blocked/archived 卡）原样透传卡片且不创建任何子代理；Lead 推进循环 = 反复调用本工具直到终态卡片。续派（continuation 且有 expectedAgentId）不经本工具：用 send_message 续原会话。",
    decisionTableText(),
  ].join("\n")
}

const TW_TIMEOUT_MS = 120000

function failCard(code, message) {
  return { ok: false, code, message }
}

// 子进程封装（与 tw-tool.js 的 runTw 同构；tw-tool.js 不在本任务可写清单，故未抽公共模块——
// 后续如需消除重复可把 runTw 提升为 tw-tool.js 导出后两处共用）。解析失败同样回结构化卡。
function runTwChild(executable, args, cwd, timeoutMs = TW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env: process.env })
    let done = false
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, code: "TW_DISPATCH_TIMEOUT", message: "tw " + args[0] + " 超时（" + timeoutMs + "ms）被终止" })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("close", () => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (out || err || "").trim()
      let card = null
      try { card = JSON.parse(text) } catch { card = { ok: false, code: "TW_OUTPUT_UNPARSEABLE", message: text.slice(0, 400) } }
      resolve(card)
    })
    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: "TW_SPAWN_FAILED", message: String(error?.message ?? error) })
    })
  })
}

// 工具定义工厂。deps 与 twToolSubagentDefinition 同形（tiersSource / directSelections /
// subagentProviderName / isModelInjectionReady / getService），保证两工具共享同一份直接选择表与注入就绪状态；
// runTw / createDirectedSubagent 仅测试注入用（fake CLI 卡与 fake 创建核心）。
export function twDispatchDefinition(ctx, deps = {}) {
  const runTw = deps.runTw ?? ((args, cwd) => runTwChild(resolveTwExecutable(), args, cwd))
  const createSubagent = deps.createDirectedSubagent ?? createDirectedSubagent
  const coreDeps = {
    tiersSource: deps.tiersSource ?? (() => null),
    directSelections: deps.directSelections ?? new Map(),
    subagentProviderName: deps.subagentProviderName ?? SUBAGENT_PROVIDER,
    isModelInjectionReady: deps.isModelInjectionReady ?? (() => true),
    ...(deps.getService ? { getService: deps.getService } : {}),
  }

  return {
    name: TOOL_NAME,
    // dispatch-plan 推进 + 多包逐张串行（每张含创建核心的验证与持久化确认）+ 逐张登记，
    // 上限按多包串行链估算；正常单波远低于此值。
    timeoutMs: 300000,
    description: twDispatchToolDescription(),
    // 并发安全（方案 §3.5）：波次推进由任务锁在 CLI 侧串行化，不同任务互不影响；
    // 同任务并发调用返回同一在途/静止卡（波次机幂等），不会双派发。
    isConcurrencySafe: () => true,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务名（tw open 的名字）" },
        note: { type: "string", description: "可选简述（标签展示；≤4 个中文词，不含 #。缺省自动生成 任务名-角色-轮次）" },
        writables: {
          type: "array",
          description: "可写范围，透传 dispatch-plan（路径以 / 结尾 = 目录授权）",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "可写路径（文件如 R.md；目录如 docs/）" },
              kind: { type: "string", description: "制品类型（如 code-review/source/doc）" },
            },
            required: ["path", "kind"],
          },
        },
      },
      required: ["task"],
    },
    async execute(params, exec) {
      const task = typeof params?.task === "string" ? params.task.trim() : ""
      if (!task) return failCard("TW_DISPATCH_TASK_REQUIRED", "task 必须是非空字符串（任务名）")
      const note = typeof params?.note === "string" && params.note.trim() ? params.note.trim() : null
      const writables = params?.writables
      if (writables !== undefined) {
        if (!Array.isArray(writables)) {
          return failCard("TW_DISPATCH_WRITABLES_INVALID", "writables 必须是数组（[{path, kind}]），透传 dispatch-plan --writable")
        }
        for (const w of writables) {
          if (!w || typeof w !== "object" || typeof w.path !== "string" || !w.path.trim() || typeof w.kind !== "string" || !w.kind.trim()) {
            return failCard("TW_DISPATCH_WRITABLES_INVALID", 'writables 每项都需要非空 path 与 kind（如 { path: "R.md", kind: "code-review" }）')
          }
        }
      }
      const cwd = resolveChildCwd(exec)
      if (!cwd) {
        return failCard("TW_DISPATCH_CWD_UNRESOLVED", "无法确定当前会话的工作目录；请在已打开项目的 DSH 会话中重试")
      }

      // 步骤 1：dispatch-plan 拿波次事实（--json 取机器可读 waves[]；writables 透传为 路径:kind 条目）。
      const args = ["dispatch-plan", "--task", task, "--json"]
      for (const w of writables ?? []) args.push("--writable", w.path.trim() + ":" + w.kind.trim())
      const plan = await runTw(args, cwd)
      // 失败语义 §3.6：推进失败/参数拒绝 → 原样返回错误卡（含 fix 指引）；非派发卡（awaiting-user/
      // wait-inflight/completed/blocked/archived）→ 原样透传，不创建任何子代理。
      const isDispatchPlan =
        plan && typeof plan === "object" && plan.ok === true && plan.stop === null && Array.isArray(plan.waves) && plan.waves.length > 0
      if (!isDispatchPlan) return plan

      // 步骤 2/3：派单逐张串行「创建 → 登记」；单张失败不回滚已成功项，逐项报错并给恢复指引（§3.5/§3.6）。
      const dispatched = []
      for (const wave of plan.waves) {
        const key = typeof wave?.dispatchKey === "string" ? wave.dispatchKey : ""
        const label = buildDispatchLabel(plan, wave, note)
        const waveFields = wave?.waveId ? { waveId: wave.waveId } : {}
        if (!key) {
          dispatched.push({ ok: false, key, label, ...waveFields, code: "TW_DISPATCH_KEY_MISSING", message: "派单缺 dispatchKey（波次事实损坏）；已跳过。请核对任务目录后重试 tw-dispatch" })
          continue
        }
        // 续派（continuation 且已有映射）：续聊是 send_message 不是创建，不归本工具（方案 §3.8）。
        // expectedAgentId 缺失（expectedAgentIdMissing）时 dispatch-plan 的 resumeNote 本就指引
        // fresh 新建 + 登记——那是一条创建路径，走下方创建流程。
        if (wave.continuation && wave.expectedAgentId) {
          dispatched.push({
            ok: true,
            key,
            label,
            continuation: true,
            expectedAgentId: wave.expectedAgentId,
            action: "send_message",
            ...waveFields,
            message: "续派波不新建子代理：用 send_message 向 " + wave.expectedAgentId + " 发送本派单 prompt（增量派单全文）",
          })
          continue
        }
        const hint = wave?.modelHint
        if (!hint || typeof hint.provider !== "string" || !hint.provider || typeof hint.model !== "string" || !hint.model) {
          dispatched.push({
            ok: false,
            key,
            label,
            ...waveFields,
            code: "TW_DISPATCH_MODEL_HINT_INVALID",
            message: "派单 " + key + " 的 modelHint 缺失或不完整；未创建子会话。请检查全局配置 team-work-dsh.tiers（tw models 查看解析）后重试",
          })
          continue
        }
        // 创建：共享创建核心（验证 → startContinuable → flush 确认；启动未确认的子会话由核心回收语义处理）。
        const created = await createSubagent(ctx, coreDeps, {
          description: label,
          prompt: typeof wave.prompt === "string" ? wave.prompt : "",
          target: { provider: hint.provider, model: hint.model, ...(hint.effort ? { effort: hint.effort } : {}) },
          exec,
        })
        if (!created || created.ok !== true) {
          dispatched.push({
            ok: false,
            key,
            label,
            ...waveFields,
            code: created?.code ?? "TW_DISPATCH_CREATE_FAILED",
            message: created?.message ?? "子代理创建失败（未知原因）",
          })
          continue
        }
        // 登记：dispatchKey → childId（续派 send_message 的寻址事实）。
        const mapped = await runTw(["agent-map", "--task", task, "--key", key, "--agent", created.sessionId], cwd)
        if (!mapped || mapped.ok !== true) {
          // 登记失败 = 部分成功（§3.6）：子会话已在工作、不回收；给补登记指引，明确勿重复创建。
          dispatched.push({
            ok: false,
            key,
            label,
            sessionId: created.sessionId,
            provider: created.provider,
            model: created.model,
            ...(created.effort ? { effort: created.effort } : {}),
            ...waveFields,
            code: "TW_DISPATCH_REGISTER_FAILED",
            message:
              "子会话已创建（" + created.sessionId + "）但映射登记失败：" + String(mapped?.message ?? mapped) +
              "。修复后用 tw agent-map --task " + task + " --key " + key + " --agent " + created.sessionId + " 补登记；勿重复创建（会重复派单）",
          })
          continue
        }
        dispatched.push({
          ok: true,
          key,
          label,
          sessionId: created.sessionId,
          provider: created.provider,
          model: created.model,
          ...(created.effort ? { effort: created.effort } : {}),
          ...waveFields,
          registered: true,
        })
      }
      const failures = dispatched.filter((d) => !d.ok).length
      return {
        ok: true,
        task: plan.task ?? task,
        stage: plan.stage,
        dispatched,
        ...(failures > 0 ? { failures, note: "部分派单项失败：已成功项不回滚；失败项按各自 message 的指引恢复" } : {}),
      }
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
