// Seatbelt 已在 exec 边界生效。只在无模型预检时把独立探针发到 FD 3，不污染 CLI 原始 stdout。
import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const encoded = process.env.TWR_ISOLATION_PROBE
if (encoded) {
  delete process.env.TWR_ISOLATION_PROBE
  const proof = createRequire(import.meta.url)('./write-probe.cjs')(encoded)
  writeSync(3, JSON.stringify(proof) + '\n')
}
process.argv.splice(1,1)
await import(pathToFileURL(process.argv[1]).href)
