export { digestValue, digestBytes, BYTES_DIGEST_ALGORITHM } from "../../policy/kernel.mjs"
import { digestValue } from "../../policy/kernel.mjs"

export function digestEffect(effect) {
  const { effectDigest: _effectDigest, ...intent } = effect
  return digestValue(intent)
}
