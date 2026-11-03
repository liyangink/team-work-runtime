// pricing.mjs — 四款评测基准模型的官方公开 API 计费规则（单位：USD / 1M Tokens）
// 依据宿主 @deepseek-ai/dsh-llm-pi-ai 与 @earendil-works/pi-ai 语义：
// usage.inputTokens 已扣除 cacheReadTokens 与 cacheWriteTokens（即纯未命中输入），
// usage.outputTokens 已包含思维链 reasoningTokens，按字段直乘单价不会重复计费。

export const MODEL_PRICING_PER_1M = Object.freeze({
  "deepseek-flash": Object.freeze({
    tier: "junior",
    input: 0.30,
    cacheRead: 0.006,
    cacheWrite: 0.00,
    output: 1.20,
    offPeak: Object.freeze({
      input: 0.15,
      cacheRead: 0.003,
      cacheWrite: 0.00,
      output: 0.60
    })
  }),
  "glm-5.3": Object.freeze({
    tier: "senior",
    input: 1.40,
    cacheRead: 0.26,
    cacheWrite: 0.00,
    output: 4.40
  }),
  "gpt-6.1-sol": Object.freeze({
    tier: "expert",
    input: 2.00,
    cacheRead: 0.10,
    cacheWrite: 2.50,
    output: 10.00
  }),
  "claude-opus-5-5": Object.freeze({
    tier: "ceiling",
    input: 4.00,
    cacheRead: 0.20,
    cacheWrite: 5.00,
    output: 20.00
  })
})

export function calculateUsageCostUsd(model, usage = {}, { useOffPeak = false } = {}) {
  const spec = MODEL_PRICING_PER_1M[model]
  if (!spec) {
    const err = new Error(`未知或未配置单价的模型 ID：${String(model)}；请在 evals/pricing.mjs 中补充官方单价`)
    err.code = "PRICING_MODEL_UNRESOLVED"
    throw err
  }
  const rate = useOffPeak && spec.offPeak ? spec.offPeak : spec
  const checkNonNeg = (v, name) => {
    const n = Number(v ?? 0)
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`非法 Token 计数 ${name}=${String(v)}：必须为非负有限数`)
    return n
  }
  const inputTokens = checkNonNeg(usage.inputTokens, "inputTokens")
  const cacheReadTokens = checkNonNeg(usage.cacheReadTokens, "cacheReadTokens")
  const cacheWriteTokens = checkNonNeg(usage.cacheWriteTokens, "cacheWriteTokens")
  const outputTokens = checkNonNeg(usage.outputTokens, "outputTokens")
  const costUsd = (
    inputTokens * rate.input +
    cacheReadTokens * rate.cacheRead +
    cacheWriteTokens * rate.cacheWrite +
    outputTokens * rate.output
  ) / 1e6
  return {
    model,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    costUsd
  }
}
