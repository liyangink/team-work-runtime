// guidance.mjs — 角色/场景公共引导库加载（Team-work 模块数据扩展）。
// 检索层级：team-work/guidance/roles/<role>.md（键 = 派单角色）、
//           team-work/guidance/scenes/<sceneId>.md（键 = 阶段 teamScene）。
// 分层合并：包内默认引导为基线，项目根 team-work/guidance/ 下同名文件逐文件覆盖——
// 项目只需放置要自定义的条目，其余保留基线。
// 缺失目录/文件一律静默跳过：引导是增强不是门禁，缺失不阻塞派发。
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function readSection(dir) {
  const out = {}
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return out // 目录缺失：空映射
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const key = entry.slice(0, -".md".length)
    try {
      out[key] = (await readFile(path.join(dir, entry), "utf8")).trim()
    } catch {
      // 单文件读取失败：跳过该键，其余照常
    }
  }
  return out
}

// 返回 { roles: {owner, challenger, expert, ...}, scenes: {implementation, test, ...} }
// 读取顺序：包内基线 → 项目根覆盖（Object.assign 同名覆盖）。
export async function loadGuidance(projectRoot = null) {
  const layers = [path.join(PACKAGE_ROOT, "team-work", "guidance")]
  if (projectRoot && path.isAbsolute(projectRoot)) {
    layers.push(path.join(projectRoot, "team-work", "guidance"))
  }
  const roles = {}
  const scenes = {}
  for (const dir of layers) {
    Object.assign(roles, await readSection(path.join(dir, "roles")))
    Object.assign(scenes, await readSection(path.join(dir, "scenes")))
  }
  return { roles, scenes }
}
