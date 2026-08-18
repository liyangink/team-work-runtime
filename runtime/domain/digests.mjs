import { createHash } from "node:crypto"

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function digestValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function digestEffect(effect) {
  const { effectDigest: _effectDigest, ...intent } = effect
  return digestValue(intent)
}
