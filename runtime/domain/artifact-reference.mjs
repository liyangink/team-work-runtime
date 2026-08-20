import { digestValue } from "./digests.mjs"

export function artifactIdentity(ref) {
  if (typeof ref !== "string" || !ref.startsWith("artifact:")) throw new TypeError("artifact ref must start with artifact:")
  const raw = ref.slice("artifact:".length)
  const kind = raw.split(":")[0]
  const base = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "")
  return {
    artifactId: base.length <= 100 ? base : `${base.slice(0, 70)}-${digestValue(raw).slice(0, 20)}`,
    kind,
  }
}
