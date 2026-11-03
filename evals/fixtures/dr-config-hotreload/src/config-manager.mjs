import { readFile, writeFile } from "node:fs/promises"
import { watch } from "node:fs"

export let activeConfig = { version: 1, routes: {} }

export function sanitizeForSave(raw) {
  return {
    version: 1,
    routes: Object.fromEntries(
      Object.entries(raw.routes ?? {}).map(([k, v]) => [
        k,
        { endpoint: v.endpoint, apiKeyRef: v.apiKeyRef }
      ])
    )
  }
}

export async function saveConfig(configPath, draft) {
  const clean = sanitizeForSave(draft)
  await writeFile(configPath, JSON.stringify(clean, null, 2), "utf8")
}

export function startWatcher(configPath) {
  return watch(configPath, async () => {
    const text = await readFile(configPath, "utf8")
    activeConfig = JSON.parse(text)
  }).unref()
}

export async function executeRequest(routeId, transport) {
  const keyRef = activeConfig.routes[routeId]?.apiKeyRef
  await transport.authenticate(keyRef)
  const endpoint = activeConfig.routes[routeId]?.endpoint
  return transport.send(endpoint)
}
