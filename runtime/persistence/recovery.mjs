import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { StoreError } from "./store-error.mjs"

export async function recoverTransactions(transactionRoot, recoverOne) {
  let names
  try {
    names = (await readdir(transactionRoot)).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", "cannot inspect task transaction directory", [{ message: error.message }])
  }
  if (names.length > 1) {
    throw new StoreError("STATE_CORRUPT", "task contains multiple unfinished transactions")
  }
  for (const name of names) {
    const manifestPath = path.join(transactionRoot, name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    } catch (error) {
      throw new StoreError("STATE_CORRUPT", `transaction ${name} is unreadable`, [{ message: error.message }])
    }
    await recoverOne(manifest, manifestPath, name.slice(0, -5))
  }
}

