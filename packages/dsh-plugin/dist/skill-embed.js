// skill-embed.js — 构建期内嵌 skill 的运行期注册
// 构建期（build.mjs）把仓库 skills/team-work-v3 全树拷入 dist/skill/（与 tw init 文件通道同源同版本）；
// 运行期读 dist/skill/SKILL.md 与 frontmatter 注册，references 经 resourceBase directory 提供。
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
  const skillDir = config?.skillDir ?? path.join(here, "..", "dist", "skill")
  const md = await readFile(path.join(skillDir, "SKILL.md"), "utf8")
  const fm = parseFrontmatter(md)
  ctx.skills.register({
    name: fm.name || "team-work-v3",
    description: fm.description || "team-work 多智能体研发工作流",
    content: md,
    resourceBase: { kind: "directory", path: path.join(skillDir, "references") },
  })
}
