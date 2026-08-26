// guidance.mjs — 角色/场景公共引导库加载（Team-work 模块数据扩展）。
// 检索层级：team-work/guidance/roles/<role>.md（键 = 派单角色）、
//           team-work/guidance/scenes/<sceneId>.md（键 = 阶段 teamScene）。
// 分层合并：包内默认引导为基线，项目根 team-work/guidance/ 下同名文件逐文件覆盖——
// 项目只需放置要自定义的条目，其余保留基线。
// 热变语义：无模块级缓存，每次调用全量重读——修改引导文件即下次派发/在途重建生效。
// 缺失目录/文件静默跳过：引导是增强不是门禁，缺失不阻塞派发；
// 但项目覆盖层（用户显式配置）单文件读取失败要可诊断，见 readSection 的 onFileError。
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// 读取某层 roles/scenes 目录下的全部 .md。
// 目录缺失（readdir 失败）静默返回空映射——与"没有自定义引导"不可区分，属预期；
// 单文件读取失败（条目在场但读不了 = 文件损坏/不可读）经 onFileError 上报：
// 包内基线静默跳过（回退 = 无该引导，派发不阻塞），项目覆盖层打一次 stderr 警告，
// 避免用户以为自定义覆盖已生效实际却被忽略。
async function readSection(dir, { onFileError = null } = {}) {
  const out = {}
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return out // 目录缺失：空映射（静默）
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const key = entry.slice(0, -".md".length)
    try {
      out[key] = (await readFile(path.join(dir, entry), "utf8")).trim()
    } catch (error) {
      if (onFileError) onFileError(entry, error)
    }
  }
  return out
}

// 项目覆盖层文件读取失败警告（stderr，console.warn 输出到 stderr）：
// 指明是哪个项目根的哪个文件、失败原因与回退行为，一次失败一条。
// projectRoot（resolve 后绝对路径）前缀便于多个项目共用同一 stderr（如宿主进程聚合输出）时定位来源。
function warnProjectFile(projectRoot, section, entry, error) {
  console.warn(`tw: 警告：${projectRoot}/team-work/guidance/${section}/${entry} 读取失败（${error?.code ?? error?.message}），已回退包内基线`)
}

// 返回 { roles: {owner, challenger, expert, ...}, scenes: {implementation, test, ...} }
// 读取顺序：包内基线 → 项目根覆盖（Object.assign 同名覆盖）。
// projectRoot 非空时先 path.resolve 再启用项目覆盖层——相对路径（如 "./proj"）同样生效，
// 与仓库其余路径（store.mjs/cli.mjs 直接 path.join 拼接）行为一致，不再静默跳过覆盖层。
export async function loadGuidance(projectRoot = null) {
  const root = projectRoot ? path.resolve(projectRoot) : null
  const layers = [path.join(PACKAGE_ROOT, "team-work", "guidance")]
  if (root) layers.push(path.join(root, "team-work", "guidance"))
  const roles = {}
  const scenes = {}
  for (const dir of layers) {
    const projectLayer = layers.length > 1 && dir === layers[1]
    Object.assign(roles, await readSection(path.join(dir, "roles"), { onFileError: projectLayer ? (entry, error) => warnProjectFile(root, "roles", entry, error) : null }))
    Object.assign(scenes, await readSection(path.join(dir, "scenes"), { onFileError: projectLayer ? (entry, error) => warnProjectFile(root, "scenes", entry, error) : null }))
  }
  return { roles, scenes }
}
