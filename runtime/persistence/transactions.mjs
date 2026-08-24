import { open, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { StoreError } from "./store-error.mjs"

export async function syncDirectory(directory) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function atomicWrite(target, content) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
    await syncDirectory(path.dirname(target))
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function atomicJson(target, value) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`)
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    return true
  }
}

const LOCK_STALE_MS = 10_000

async function reclaimOrphanedLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`
  let recoveryHandle
  try {
    recoveryHandle = await open(recoveryPath, "wx", 0o600)
  } catch (error) {
    if (error.code === "EEXIST") return false
    throw error
  }
  try {
    let owner
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return true
      if (error instanceof SyntaxError) {
        // 损坏锁：写入竞态窗口（另一进程 open 后尚未写完）内读到半截 JSON 是毫秒级现象，删除会破坏互斥——
        // 只有超过回收年龄的损坏锁才判定为崩溃残留并回收；年轻的照常重试。
        const ageMs = Date.now() - (await stat(lockPath)).mtimeMs
        if (ageMs > LOCK_STALE_MS) {
          await rm(lockPath)
          return true
        }
        return false
      }
      throw error
    }
    if (processIsAlive(owner.pid)) return false
    await rm(lockPath)
    return true
  } finally {
    await recoveryHandle.close()
    await rm(recoveryPath, { force: true })
  }
}

export async function withOwnerLock(lockPath, action) {
  const ownerId = randomUUID()
  let handle
  const maxAttempts = 401
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (await reclaimOrphanedLock(lockPath)) continue
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        continue
      }
      let owner
      try { owner = JSON.parse(await readFile(lockPath, "utf8")) } catch { owner = null }
      throw new StoreError("LOCK_UNAVAILABLE", "task state is locked by another writer", owner ? [owner] : [])
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ ownerId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    return await action(ownerId)
  } finally {
    if (handle) await handle.close()
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8"))
      if (current.ownerId === ownerId) await rm(lockPath)
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
    }
  }
}
