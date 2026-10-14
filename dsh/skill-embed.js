// 注册唯一根制品内的三个独立技能；一条不可用不影响其余条目。
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)

// frontmatter 解析（name/description 两字段足够注册）
const FM_RE = new RegExp("^---" + BS + "n([\\s\\S]*?)" + BS + "n---")
const KV_RE = new RegExp("^(\\w[\\w-]*):\\s*(.+)$")

export function parseFrontmatter(text) {
  const m = FM_RE.exec(text)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split(NL)) {
    const kv = KV_RE.exec(line.trim())
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "")
  }
  return out
}

export async function registerEmbeddedSkill(ctx, config) {
  const root = path.join(here, "..", "skills")
  const disposers = []
  for (const [directory, name, description] of [
    ["team-work-v3", "team-work", "多智能体研发工作流"],
    ["clarity-writing", "clarity-writing", "面向人类的明晰表达"],
    ["clarity-review", "clarity-review", "关键取舍与核心阻碍审阅"],
  ]) {
    const custom = directory === "team-work-v3" && config?.skillDir != null
    const skillDir = custom ? config.skillDir : path.join(root, directory)
    try {
      const md = await readFile(path.join(skillDir, "SKILL.md"), "utf8")
      const fm = parseFrontmatter(md)
      const dispose = ctx.skills.register({
        name: fm.name || name,
        description: fm.description || description,
        source: "team-work-runtime",
        content: md,
        // 显式自定义 team-work 保留旧基址；随包布局与 filesystem provider 一致。
        resourceBase: { kind: "directory", path: custom ? path.join(skillDir, "references") : skillDir },
      })
      if (typeof dispose === "function") disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: 技能 " + name + " 未启用（" + skillDir + "）：" + String(error?.message ?? error) + "；请检查随包资源或显式自定义目录，可用 tw init 文件通道")
    }
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) { ctx.logger?.warn?.("team-work-dsh: 技能释放失败：" + String(error?.message ?? error)) }
    }
  }
}
