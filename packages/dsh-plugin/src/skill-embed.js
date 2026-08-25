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
  // skill 内容多候选解析（免构建分发）：
  //  1) 显式 config.skillDir；
  //  2) 仓库 skills/team-work-v3（git 源码/根包通道——src/../../.. 恰为仓库根或已装主包根）；
  //  3) 包内 dist/skill（插件单包 npm 通道，构建期拷贝）。
  const candidates = config?.skillDir
    ? [config.skillDir]
    : [path.join(here, "..", "..", "..", "skills", "team-work-v3"), path.join(here, "..", "dist", "skill")]
  let skillDir = candidates[0]
  let md
  for (const dir of candidates) {
    try {
      md = await readFile(path.join(dir, "SKILL.md"), "utf8")
      skillDir = dir
      break
    } catch {
      // 试下一候选
    }
  }
  if (md === undefined) throw new Error("skill 内容不可达（候选：" + candidates.join(", ") + "）")
  const fm = parseFrontmatter(md)
  ctx.skills.register({
    name: fm.name || "team-work-v3",
    description: fm.description || "team-work 多智能体研发工作流",
    content: md,
    resourceBase: { kind: "directory", path: path.join(skillDir, "references") },
  })
}
