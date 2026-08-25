// skill-embed.js — 注册根市场制品内随包发布的 team-work skill。
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
  const skillDir = config?.skillDir ?? path.join(here, "..", "skills", "team-work-v3")
  const md = await readFile(path.join(skillDir, "SKILL.md"), "utf8")
  const fm = parseFrontmatter(md)
  ctx.skills.register({
    name: fm.name || "team-work",
    description: fm.description || "team-work 多智能体研发工作流",
    // 宿主 validateCandidate 契约：source 必须是 string（runtimeCandidate 原样透传，
    // 缺省 undefined 在消费侧抛 "source must be a string"——skill 工具装载即失败）
    source: "team-work-runtime",
    content: md,
    resourceBase: { kind: "directory", path: path.join(skillDir, "references") },
  })
}
