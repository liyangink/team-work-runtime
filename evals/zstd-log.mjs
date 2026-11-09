// zstd-log.mjs — DSH session.v4.jsonl.zstd 多帧 Zstandard 容器解码与真实美元账单/防作弊审计解析器
// 仅针对 DSH 产出的无字典标准校验帧拼接容器；遇到截断尾帧（tornStart）默认显式报错拒绝静默漏计。
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { calculateUsageCostUsd } from "./pricing.mjs"

export const ZSTD_MAGIC = 0xFD2FB528

export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Zstandard 帧头魔数无效（偏移字节 ${offset}）`)
    }
    offset += 4
    if (offset >= buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`Zstandard 保留块类型无效（偏移字节 ${offset - 3}）`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

export function decompressMultiFrameZstd(buffer, { allowTorn = false } = {}) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined && !allowTorn) {
    const err = new Error(`Zstandard 会话日志存在未完整刷盘的截断尾帧（tornStart=${tornStart}），拒绝静默漏计账单`)
    err.code = "ZSTD_TORN_FRAME"
    err.tornStart = tornStart
    throw err
  }
  const chunks = frames.map(({ start, end }) => zlib.zstdDecompressSync(buffer.subarray(start, end)))
  return Buffer.concat(chunks).toString("utf8")
}

export async function readSessionEvents(filePath, options = {}) {
  const buf = await readFile(filePath)
  const text = filePath.endsWith(".zstd") ? decompressMultiFrameZstd(buf, options) : buf.toString("utf8")
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

// 从 assistant/attempt 的紧凑 stream 记录中提取 usage 与起止时间戳
function extractStreamMeta(stream) {
  if (!Array.isArray(stream)) return { usage: null, firstTime: null, lastTime: null }
  let usage = null
  let firstTime = null
  let lastTime = null
  for (const rec of stream) {
    const t0 = rec?.time ?? rec?.time0
    if (typeof t0 === "number") {
      if (firstTime === null || t0 < firstTime) firstTime = t0
      const dtSum = Array.isArray(rec?.dt) ? rec.dt.reduce((a, b) => a + b, 0) : 0
      const tEnd = t0 + dtSum
      if (lastTime === null || tEnd > lastTime) lastTime = tEnd
    }
    if (rec?.type === "chunk" && rec?.chunk?.type === "usage" && rec.chunk.usage) {
      usage = rec.chunk.usage
    }
  }
  return { usage, firstTime, lastTime }
}

export function summarizeSessionEvents(events, { maxTurn = Infinity } = {}) {
  const header = events[0] ?? {}
  const descriptor = events.find((e) => e.type === "subagent/descriptor")?.data ?? null
  const byModel = {}
  const toolCalls = []
  let currentModel = null
  let totalCostUsd = 0
  let totalOffPeakCostUsd = 0
  let totalInputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheWriteTokens = 0
  let totalOutputTokens = 0
  let steps = 0
  let failedAttempts = 0
  let minTimeMs = null
  let maxTimeMs = null

  for (const ev of events) {
    if (ev.type === "request/header" && ev.data?.header?.config?.model) {
      currentModel = ev.data.header.config.model
    } else if (ev.type === "request/context" && ev.data?.model) {
      currentModel = ev.data.model
    }
    const turn = ev.data?.turn ?? 0
    if (turn > maxTurn) continue
    if (ev.type === "tool/call" || ev.type === "tool/ptc-dispatch") {
      toolCalls.push({
        type: ev.type,
        turn,
        step: ev.data?.step,
        name: ev.data?.name ?? ev.type,
        arguments: ev.data?.arguments ?? ev.data?.code ?? ""
      })
    }
    if (ev.type !== "assistant/message" && ev.type !== "assistant/attempt") continue
    const streamMeta = extractStreamMeta(ev.data?.stream)
    if (streamMeta.firstTime !== null) {
      if (minTimeMs === null || streamMeta.firstTime < minTimeMs) minTimeMs = streamMeta.firstTime
      if (maxTimeMs === null || streamMeta.lastTime > maxTimeMs) maxTimeMs = streamMeta.lastTime
    }
    const model = ev.data?.message?.source?.model ?? currentModel
    const rawUsage = ev.data?.usage ?? streamMeta.usage
    if (!model || !rawUsage) continue
    const billed = calculateUsageCostUsd(model, rawUsage, { useOffPeak: false })
    const billedOffPeak = calculateUsageCostUsd(model, rawUsage, { useOffPeak: true })
    if (ev.type === "assistant/attempt") failedAttempts += 1
    else steps += 1
    totalCostUsd += billed.costUsd
    totalOffPeakCostUsd += billedOffPeak.costUsd
    totalInputTokens += billed.inputTokens
    totalCacheReadTokens += billed.cacheReadTokens
    totalCacheWriteTokens += billed.cacheWriteTokens
    totalOutputTokens += billed.outputTokens
    if (!byModel[model]) {
      byModel[model] = { requests: 0, failedAttempts: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, offPeakCostUsd: 0 }
    }
    byModel[model].requests += 1
    if (ev.type === "assistant/attempt") byModel[model].failedAttempts += 1
    byModel[model].inputTokens += billed.inputTokens
    byModel[model].cacheReadTokens += billed.cacheReadTokens
    byModel[model].cacheWriteTokens += billed.cacheWriteTokens
    byModel[model].outputTokens += billed.outputTokens
    byModel[model].costUsd += billed.costUsd
    byModel[model].offPeakCostUsd += billedOffPeak.costUsd
  }

  return {
    id: header.id ?? null,
    createdAt: header.createdAt ?? null,
    origin: header.origin ?? "root",
    parentSession: header.parentSession ?? null,
    delegationDepth: header.delegationDepth ?? 0,
    label: descriptor?.label ?? "Lead (Root)",
    steps,
    failedAttempts,
    inputTokens: totalInputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
    outputTokens: totalOutputTokens,
    costUsd: Number(totalCostUsd.toFixed(6)),
    offPeakCostUsd: Number(totalOffPeakCostUsd.toFixed(6)),
    wallClockMs: minTimeMs !== null && maxTimeMs !== null ? Math.max(0, maxTimeMs - minTimeMs) : 0,
    byModel,
    toolCalls
  }
}

function pickLatestGenerationLog(files) {
  const candidates = files.filter((f) => f.endsWith(".jsonl.zstd") || f.endsWith(".jsonl"))
  if (candidates.length === 0) return null
  const rank = (name) => {
    const m = /^session\.v(\d+)\.jsonl/.exec(name)
    return m ? Number(m[1]) : 0
  }
  return candidates.sort((a, b) => rank(b) - rank(a))[0]
}

export async function collectProjectSessions(projectSessionsDir, { maxTurn = Infinity, rootSessionId = null } = {}) {
  const entries = await readdir(projectSessionsDir, { withFileTypes: true })
  const rawEventsById = new Map()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = path.join(projectSessionsDir, entry.name)
    const files = await readdir(sessionDir)
    const logFile = pickLatestGenerationLog(files)
    if (!logFile) continue
    const events = await readSessionEvents(path.join(sessionDir, logFile))
    const id = events[0]?.id ?? entry.name
    rawEventsById.set(id, events)
  }

  // 若指定 rootSessionId，仅保留该根会话及其派生子代树
  const allowedIds = new Set()
  if (rootSessionId) {
    allowedIds.add(rootSessionId)
    let added = true
    while (added) {
      added = false
      for (const [id, evs] of rawEventsById.entries()) {
        if (allowedIds.has(id)) continue
        const parent = evs[0]?.parentSession
        if (parent && allowedIds.has(parent)) {
          allowedIds.add(id)
          added = true
        }
      }
    }
  } else {
    for (const id of rawEventsById.keys()) allowedIds.add(id)
  }

  const sessions = []
  const byModel = {}
  let totalCostUsd = 0
  let totalOffPeakCostUsd = 0

  for (const id of allowedIds) {
    const events = rawEventsById.get(id)
    if (!events) continue
    const isRoot = (events[0]?.origin ?? "root") === "root"
    const summary = summarizeSessionEvents(events, { maxTurn: isRoot ? maxTurn : Infinity })
    sessions.push(summary)
    totalCostUsd += summary.costUsd
    totalOffPeakCostUsd += summary.offPeakCostUsd
    for (const [m, stats] of Object.entries(summary.byModel)) {
      if (!byModel[m]) {
        byModel[m] = { requests: 0, failedAttempts: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, offPeakCostUsd: 0 }
      }
      byModel[m].requests += stats.requests
      byModel[m].failedAttempts += stats.failedAttempts
      byModel[m].inputTokens += stats.inputTokens
      byModel[m].cacheReadTokens += stats.cacheReadTokens
      byModel[m].cacheWriteTokens += stats.cacheWriteTokens
      byModel[m].outputTokens += stats.outputTokens
      byModel[m].costUsd = Number((byModel[m].costUsd + stats.costUsd).toFixed(6))
      byModel[m].offPeakCostUsd = Number((byModel[m].offPeakCostUsd + stats.offPeakCostUsd).toFixed(6))
    }
  }

  const totalActiveMs = sessions.reduce((acc, s) => acc + (s.wallClockMs ?? 0), 0)
  const rootActiveMs = sessions.find((s) => (s.origin ?? "root") === "root")?.wallClockMs ?? totalActiveMs
  return {
    sessionCount: sessions.length,
    activeElapsedSec: Number((Math.max(rootActiveMs, totalActiveMs * 0.65) / 1000).toFixed(2)),
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    totalOffPeakCostUsd: Number(totalOffPeakCostUsd.toFixed(6)),
    byModel,
    sessions
  }
}

// 防作弊越兼容路径审计：支持 tool/call（JSON 字符串）与 tool/ptc-dispatch（已解析对象），
// 覆盖绝对路径、相对路径（../）、符号链接（realpathSync）及 bash 命令中的路径 token。
import { existsSync, realpathSync } from "node:fs"

// 夹具源码内部的相对模块目录白名单：被测 agent 在子目录内执行自测，或复用夹具源码中的
// `import "../<模块>/..."` 时，这些路径指向工作区内部的源码目录，而不是从工作区根向上越界访问
// （评测工作区根下不存在这些同名目录）。分组维护便于追溯来源。
const INTERNAL_RELATIVE_MODULE_PREFIXES = [
  // 公开基准题源码目录（沿用既有白名单）
  "src/", "validation/", "libs/", "components/", "store/", "navigation/", "pages/", "lexer/", "runtime/",
  // 超难题 uh1：src/actions|policy|queue|sync|ui 之间的相对导入
  "actions/", "policy/", "queue/", "sync/", "ui/",
  // 超难题 uh2：src/popover|contextmenu|fab|focus|hover|modal|events 之间的相对导入
  "popover/", "contextmenu/", "fab/", "focus/", "hover/", "modal/", "events/",
  // 超难题 uh3：txengine 子包（tx/cache/lock/coordinator）内部相对导入
  "txengine/",
  // axios 源码内部模块目录：夹具仓库内的 lib/axios.js 以 ../helpers/... ../core/... 等
  // 相对路径引用同仓库模块，属于工作区内部源码引用而非向上越界访问
  "core/", "helpers/", "platform/", "adapters/", "defaults/"
]

function isInternalRelativeModulePath(stripped) {
  return Boolean(stripped) && !stripped.includes("..") && INTERNAL_RELATIVE_MODULE_PREFIXES.some((prefix) => stripped.startsWith(prefix))
}

// 评测单元格布局为 <tmpRoot>/twr-cell-<taskId>-<groupId>-<random>/work-root/workspace。
// 从 workspaceRoot 反推当前 cell 目录名，供“自身 cell 路径笔误容错”使用；
// 仅在 POSIX 临时目录布局下生效，其他布局返回 null，笔误容错自动禁用。
function parseSelfEvalCell(workspaceRoot) {
  const norm = path.resolve(workspaceRoot).replace(/^\/private/, "")
  const matched = /^(\/var\/folders\/[^/]+\/[^/]+\/T|\/tmp)\/(twr-cell-[^/]+)\/work-root\/workspace$/.exec(norm)
  return matched ? { cellName: matched[2] } : null
}

function commonPrefixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

// 从候选路径提取评测临时根（/tmp 或 macOS /var/folders/<xx>/<yyy>/T）及其后的相对路径。
// 只识别 POSIX 临时目录布局；其他位置返回 null，不参与自身 cell 笔误容错。
function splitEvalTmpPath(normPath) {
  const matched = /^(\/var\/folders\/[^/]+\/[^/]+\/T|\/tmp)\/(.*)$/.exec(normPath)
  return matched ? { tmpRoot: matched[1], rest: matched[2] } : null
}

// 自身 cell 路径拼写笔误容错：被测 agent 手敲自己的 cell 绝对路径时，可能把 taskId、
// 组名、mkdtemp 随机后缀写错，甚至把 /var/folders/<xx>/<yyy>/T 临时根的随机段写重
// （实测样本 sw4vsvwn... 被写成 sw4vsw4vsvwn...）。这些笔误的真实目标仍是自身 cell，
// 只是整条路径不存在（ENOENT）。以下条件同时满足才按笔误放行，避免误放行跨格访问：
//   1) 候选路径位于 /tmp 或 /var/folders/<xx>/<yyy>/T 临时根下，且其第一段以 twr-cell- 开头；
//   2) 候选 cell 根在文件系统中不存在（真实存在的自身 cell 内部路径与其他评测格都不算笔误，
//      其他真实评测格仍按跨格访问拦截）；
//   3) 候选 cell 段与自身 cell 段完全相同（临时根随机段笔误），或公共前缀 >= 24 字符
//      （taskId/组名笔误，排除无关任务与评测保留目录）。
// 放行只针对目标不存在的笔误路径；若路径真实存在，后续 realpath 复核会再次拦截。
const SELF_CELL_TYPO_COMMON_PREFIX = 24

function isSelfCellPathTypo(candidatePath, selfCell) {
  if (!selfCell) return false
  const split = splitEvalTmpPath(candidatePath.replace(/^\/private/, ""))
  if (!split) return false
  const observedCell = split.rest.split("/")[0]
  if (!observedCell.startsWith("twr-cell-")) return false
  // 目标 cell 根真实存在：是自身 cell 内部路径（走正常白名单）或其他真实评测格（跨格访问），不按笔误放行。
  if (existsSync(path.join(split.tmpRoot, observedCell))) return false
  if (observedCell === selfCell.cellName) return true
  return commonPrefixLength(observedCell, selfCell.cellName) >= SELF_CELL_TYPO_COMMON_PREFIX
}

function isInsideAllowedRoots(candidatePath, baseDir, allowedRoots, selfCell = null) {
  if (typeof candidatePath !== "string" || !candidatePath) return false
  if (candidatePath.startsWith("../")) {
    const stripped = candidatePath.replace(/^(?:\.\.\/)+/, "")
    // 评测夹具中的路径遍历安全测试字面量（../escape*、../outside*、../x、../*.whl 等）
    // 是被测 agent 编写的“防越界”断言内容而非真实越界访问；仅在无嵌套 .. 时按字面量放行。
    const isTraversalTestLiteral = stripped && !stripped.includes("..") && (
      /^(?:escape|outside)(?:[._/-]|$)/.test(stripped) ||
      /^x(?:$|[._/-])/.test(stripped) ||
      /\.whl$/i.test(stripped)
    )
    if (isTraversalTestLiteral) return true
    if (isInternalRelativeModulePath(stripped)) return true
  }
  const resolved = path.resolve(baseDir, candidatePath)
  const checkOne = (p, r) => p === r || p.startsWith(r + path.sep) || p === "/private" + r || p.startsWith("/private" + r + path.sep)
  // 允许在 /tmp 下创建非评测保留名的临时验证脚本（严禁访问 /tmp/twr-eval*、/tmp/hidden* 或其他 twr-cell-* 目录）
  // 裸 /tmp（及 /private/tmp、/tmp/）本身是合法临时目录；其下仍排除评测保留目录。
  const isSafeTmpScratch = (p) => {
    const norm = p.replace(/^\/private/, "")
    if (norm !== "/tmp" && !norm.startsWith("/tmp/")) return false
    const sub = norm === "/tmp" ? "" : norm.slice("/tmp/".length)
    return !/^(?:twr-eval|twr-cell-|hidden)/i.test(sub)
  }
  // macOS 系统临时目录 /var/folders/<xx>/<yyy>/T（及 /private 前缀）是合法临时工作区，
  // 但排除评测保留目录（twr-eval*、twr-cell-*、hidden*）以免放行隐藏答案与评测装配目录。
  const isSafeSystemTmp = (p) => {
    const norm = p.replace(/^\/private/, "")
    const matched = /^\/var\/folders\/[^/]+\/[^/]+\/T(?:\/(.*))?$/.exec(norm)
    if (!matched) return false
    const sub = matched[1] ?? ""
    return !sub || !/^(?:twr-eval|twr-cell-|hidden)/i.test(sub)
  }
  // /opt/homebrew 与 /usr/local 是常见工具链安装根；agent 调用其中的解释器/二进制不应判为越界。
  const isToolchainPath = (p) => /^\/(?:opt\/homebrew|usr\/local)(?:\/|$)/.test(p.replace(/^\/private/, ""))
  // 隔离评测的 DSH_HOME（目录名 dsh-home）承载 profile 与 team-work-runtime 副本，
  // TWR 组经 PATH 合法调用其中的 tw 工具，按任务契约放行。
  const isDshHomePath = (p) => /(?:^|\/)dsh-home(?:\/|$)/.test(p.replace(/^\/private/, ""))
  // /dev/*（null、stdin、fd 等系统设备节点）不含评测资产，放行以容忍 shell 重定向与工具误用的只读路径。
  const isDevPath = (p) => /^\/dev(?:\/|$)/.test(p.replace(/^\/private/, ""))
  const matchesAny = (p) => allowedRoots.some((r) => checkOne(p, r)) || isSafeTmpScratch(p) || isSafeSystemTmp(p) || isToolchainPath(p) || isDshHomePath(p) || isDevPath(p)
  // 目标不存在且与当前 cell 名高度相似的路径按“自身 cell 笔误”放行；真实存在的其他格仍被拦截。
  if (!matchesAny(resolved) && !isSelfCellPathTypo(resolved, selfCell)) return false
  try {
    const realTarget = realpathSync(resolved)
    if (!matchesAny(realTarget) && !isSelfCellPathTypo(realTarget, selfCell)) return false
  } catch {}
  return true
}

// 网络访问反作弊：检测 bash 命令或 run_code 代码中的外部联网企图，返回首个命中片段（未命中返回 null）。
// 包管理器只匹配会访问包索引/仓库的子命令（install/download 等）；pip list、npm test、npm run build
// 这类本地命令不误报。前缀更具体的 python -m pip 与 uv 模式排在通用 pip 之前，
// 命中时 target 保留完整命令前缀（如 `uv pip install` 不会被截成 `pip install`）。
// 选项片段要求 `-`/`--` 后紧跟字母，裸 `--` 分隔符不会被当作选项跳过，因此只可能匹配
// 命令名后的首个子命令：`npm run test -- view`、`npm test -- add`、`pip list -- wheel`
// 这类本地子命令之后的过滤参数不会被误判为联网企图。
// 命令数组形式（spawn("pip", ["install"])）与带取值的长选项（npm --prefix app install）
// 不做文本匹配，由事前 PATH 同名桩与包管理器离线环境变量兜底阻断联网。
const NETWORK_ACCESS_PATTERNS = [
  /\b(?:curl|wget)\b/i,
  /\b(?:nc|ncat|telnet)\s+-[a-zA-Z0-9]/i,
  /\bgit\s+(?:clone|fetch|pull|ls-remote)\b/i,
  /\bpython(?:3(?:\.\d+)*)?\s+-m\s+pip(?:\s+--?[A-Za-z][\w-]*)*\s+(?:install|download|wheel)\b/i,
  /\buv(?:\s+--?[A-Za-z][\w-]*)*\s+(?:(?:pip|tool)\s+)?(?:install|add|sync|lock)\b/i,
  /\bpip3?(?:\s+--?[A-Za-z][\w-]*)*\s+(?:install|download|wheel)\b/i,
  /\bnpm(?:\s+--?[A-Za-z][\w-]*)*\s+(?:install|i|ci|add|update|publish|view|info|outdated|pack|exec|create)\b/i,
  /\bpnpm(?:\s+--?[A-Za-z][\w-]*)*\s+(?:install|i|add|update|publish|view|info|outdated|exec|create|dlx)\b/i,
  /\byarn(?:\s+--?[A-Za-z][\w-]*)*\s+(?:install|add|upgrade|publish|info|outdated|dlx)\b/i,
  /\bnpx(?:\s+--?[A-Za-z][\w-]*)*\s+[A-Za-z0-9@._/-]+/i,
  // 编程式联网：不经过命令行客户端，直接由 Python/Node 标准库或 requests 发起请求。
  // 这类写法在 bash 命令与 run_code 代码里都以“调用表达式”出现，语义上必然是外网访问；
  // 排在 URL 字面量模式之前，命中时 target 保留可读的函数名而非裸 URL。
  /\b(?:urllib\.request\.urlopen|urllib\.urlopen|http\.client\.(?:HTTP|HTTPS)Connection|requests\.(?:get|post|put|delete|head|request))\b/i,
  /https?:\/\/(?!127\.0\.0\.1|localhost)/i
]

// 工具存在性探测子句（which / command -v / type）只查询本地可执行文件，不会发起网络请求。
// 例如被测 agent 用 `which mmdc node npx 2>/dev/null` 判断可选工具是否安装，
// 其中的 npx 会被 npx 模式误判为“拉取远程包”；先剥离整个探测子句可消除该误报，
// 同一行后续的真实子命令（`which npx >/dev/null && npx create-react-app demo`）仍会被检出。
const TOOL_PROBE_CLAUSE_PATTERN = /(^|[;&|(\n])\s*(?:which|command\s+-v|type)\s[^;&|\n]*/gi

// team-work CLI 的交付/评审摘要（--summary / --findings）是给人和 Lead 看的自然语言说明，
// 不是被执行的内容：成员在摘要里提到“已阻断 curl / 检查过 urllib 越界”属正常汇报，
// 不能因此把本次交付判成联网作弊。命中 tw.mjs review|deliver 时剥离这两个参数取值。
const TW_CLI_SUMMARY_COMMAND_PATTERN = /\btw\.mjs\s+(?:review|deliver)\b/i
const TW_CLI_SUMMARY_ARGUMENT_PATTERN = /--(?:summary|findings)(?:=|\s+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|[^\s]+)/g

function stripToolProbeClauses(text) {
  return text.replace(TOOL_PROBE_CLAUSE_PATTERN, "$1 ")
}

function stripTwCliSummaryArguments(text) {
  if (!TW_CLI_SUMMARY_COMMAND_PATTERN.test(text)) return text
  return text.replace(TW_CLI_SUMMARY_ARGUMENT_PATTERN, " --tw-cli-summary")
}

function matchNetworkAccessAttempt(text) {
  if (typeof text !== "string" || !text) return null
  // 排除离线测试样例里的链接字面量：Markdown 图片 ![...](http...)、Markdown 链接
  // [...](http...)（含带空格的 `]( https://… )` 写法）、自动链接 <https://...>
  // 与 HTML <img src="http..."> 都只是被断言的文本内容，不代表真的发起请求。
  const cleaned = stripTwCliSummaryArguments(stripToolProbeClauses(text
    .replace(/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\s*\)/gi, "")
    .replace(/\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\s*\)/gi, "")
    .replace(/<img\b[^>]*\bsrc\s*=\s*['"\x60]?https?:\/\/[^'">\s]+[^>]*>/gi, "")
    .replace(/<https?:\/\/[^>\s]+>/gi, "")))
  for (const pat of NETWORK_ACCESS_PATTERNS) {
    const m = pat.exec(cleaned)
    if (m) return m[0].replace(/\s+-[a-zA-Z0-9]$/, "")
  }
  return null
}

export function detectWorkspaceEscape(sessions, workspaceRoot, { allowedExtraRoots = [], forbiddenPatterns = [/\.team-work\/archive/, /git\s+log\s+--all/, /task-spec\.json/, /\b(?:curl|wget)\s+https?:/i] } = {}) {
  const violations = []
  const normRoot = path.resolve(workspaceRoot)
  const selfCell = parseSelfEvalCell(normRoot)
  const allowedRoots = [normRoot]
  try { allowedRoots.push(realpathSync(normRoot)) } catch {}
  for (const extra of allowedExtraRoots) {
    if (typeof extra === "string" && extra.trim()) {
      const r = path.resolve(extra)
      allowedRoots.push(r)
      try { allowedRoots.push(realpathSync(r)) } catch {}
    }
  }

  for (const s of sessions ?? []) {
    for (const tc of s.toolCalls ?? []) {
      if (tc.name === "web_fetch" || tc.name === "web_search") {
        violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: `禁止在离线基准评测中调用外部网络工具 ${tc.name}` })
      }
      const rawArg = tc.arguments
      const serialized = typeof rawArg === "string" ? rawArg : JSON.stringify(rawArg ?? {})
      for (const pat of forbiddenPatterns) {
        if (pat.test(serialized)) {
          violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: `命中禁令模式 ${pat}` })
        }
      }
      let parsed = null
      if (typeof rawArg === "object" && rawArg !== null) parsed = rawArg
      else if (typeof rawArg === "string") {
        try { parsed = JSON.parse(rawArg) } catch {}
      }
      if (!parsed || typeof parsed !== "object") continue

      // 网络访问反作弊拦截：bash 命令（command）与 run_code 代码（code）中的外部联网企图
      const networkTarget = matchNetworkAccessAttempt(parsed.command) ?? matchNetworkAccessAttempt(parsed.code)
      if (networkTarget !== null) {
        violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: "network-access-attempt", target: networkTarget })
      }

      const callBaseDir = typeof parsed.workdir === "string" && parsed.workdir.trim() && isInsideAllowedRoots(parsed.workdir.trim(), normRoot, allowedRoots, selfCell)
        ? path.resolve(normRoot, parsed.workdir.trim())
        : normRoot
      for (const key of ["file_path", "path", "workdir", "cd"]) {
        const val = parsed[key]
        if (typeof val === "string" && val.trim()) {
          const base = key === "workdir" || key === "cd" ? normRoot : callBaseDir
          if (!isInsideAllowedRoots(val.trim(), base, allowedRoots, selfCell)) {
            violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: `参数 ${key} 越界访问工作区外路径 ${val}` })
          }
        }
      }
      for (const scriptKey of ["command", "code"]) {
        if (typeof parsed[scriptKey] !== "string") continue
        const scriptText = parsed[scriptKey]
        if (/(?:^|[\s"'(`])~\/[A-Za-z0-9._\/-]+/.test(scriptText)) {
          violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: `${scriptKey} 越界访问用户主目录路径 ~/` })
        }
        // 仅匹配真实的系统顶层绝对路径前缀或 ../ 相对越界，避免将 node -e 中的 JS 正则字面量（如 /abc/）误判为根目录文件路径
        // 排除 Jinja2 split_template_path('../...') / get_source(..., '../...') 路径遍历单测字面量
        const sanitizedScript = scriptText
          .replace(/split_template_path\s*\(\s*['"\x60][^'"\x60]*['"\x60]\s*\)/g, "split_template_path('SAFE_TEST')")
          .replace(/get_source\s*\([^,]+,\s*['"\x60]\.\.\/[^'"\x60]*['"\x60]\s*\)/g, "get_source(env, 'SAFE_TEST')")
        const tokenRegex = /(?:^|[\s"'=(`])(\/(?:Users|home|etc|var|tmp|private|opt|Volumes)[A-Za-z0-9._\/-]+|\.\.\/[A-Za-z0-9._\/-]+)/g
        for (const m of sanitizedScript.matchAll(tokenRegex)) {
          const tok = m[1]
          if (!isInsideAllowedRoots(tok, callBaseDir, allowedRoots, selfCell)) {
            violations.push({ sessionId: s.id, turn: tc.turn, step: tc.step, tool: tc.name, reason: `${scriptKey} 越界访问工作区外路径 ${tok}` })
          }
        }
      }
    }
  }
  return {
    cheatDetected: violations.length > 0,
    violations
  }
}
