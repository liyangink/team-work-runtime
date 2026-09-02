// writable.mjs — 可写范围匹配纯函数（intake 交付校验 / plan 包间互斥 / 评审清单三处共用）
// 语义（显式尾斜杠）：条目 path 以 "/" 结尾 = 目录授权，其下任意相对路径可写；否则精确匹配。
// 显式语法保证既有派单（全文件条目）授权面不变——目录授权必须显式声明，不静默扩大（可写互斥是并行前提）。
export function writableMatch(writable, rel) {
  for (const w of writable ?? []) {
    const p = typeof w === "string" ? w : w?.path
    if (typeof p !== "string" || p === "" || p === "/") continue
    if (p.endsWith("/") ? rel.startsWith(p) : rel === p) return w
  }
  return null
}

// 覆盖域重叠（plan 包间互斥判定）：路径相等，或互为祖先路径组件（含尾斜杠目录条目与其下路径）。
// 同一路径只一个 inode：docs 与 docs/、docs 与 docs/x 都判重叠（同名文件/目录在文件系统互斥）；
// 兄弟前缀不重叠（docs/ 与 docs-x/）。两条目归一为"目录形"后按前缀判定，尾斜杠与无斜杠语义统一。
export function writablePathsOverlap(a, b) {
  if (a === b) return true
  const dirA = a.endsWith("/") ? a : a + "/"
  const dirB = b.endsWith("/") ? b : b + "/"
  return b.startsWith(dirA) || a.startsWith(dirB)
}
