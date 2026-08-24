// build.mjs — 插件构建：skill 构建期拷贝 + client bundle + npm pack 双向断言
// 用法：node packages/dsh-plugin/build.mjs  （在仓库根执行）
// 产物：packages/dsh-plugin/dist/{skill/**, client.js}
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const NL = String.fromCharCode(10)

function indent(src, n) {
  const pad = " ".repeat(n)
  return src.split(NL).map((l) => (l.trim() ? pad + l : l)).join(NL)
}

async function main() {
  await rm(path.join(here, "dist"), { recursive: true, force: true })
  await mkdir(path.join(here, "dist"), { recursive: true })

  // 1) skill 构建期拷贝（与 tw init 文件通道同源同版本）
  await cp(path.join(repoRoot, "skills", "team-work-v3"), path.join(here, "dist", "skill"), { recursive: true })
  console.log("OK dist/skill（SKILL.md + references）")

  // 2) client bundle：badge 源码本身即 CJS（module.exports），零语法转换纯包装
  const badgeSrc = await readFile(path.join(here, "src-client", "badge.js"), "utf8")
  const bundle = [
    "// 由 build.mjs 生成——勿手改。工厂式 CJS（dsh client 插件装载约定）",
    "var factory = function (module, exports) {",
    indent(badgeSrc, 2),
    "};",
    "var api = (typeof window !== 'undefined' ? window : globalThis).__ModuleLoader__;",
    "if (api && api.load) {",
    "  var m = { exports: {} };",
    "  api.load({ id: " + JSON.stringify("team-work-runtime-dsh") + ", factory: factory });",
    "}",
  ].join(NL)
  await writeFile(path.join(here, "dist", "client.js"), bundle, "utf8")
  console.log("OK dist/client.js（工厂式 bundle）")

  // 3) npm pack 双向断言（不多不少；npm notice 走 stderr 合并判断；--cache 规避宿主 EPERM）
  await assertPack(here, "插件包", ["dist/client.js", "dist/skill/SKILL.md", "src/index.js", "README.md", "package.json"], ["roadmap", "tests/", "charter", "team-topology", "pre-phase3"])
  await assertPack(repoRoot, "主包（不含插件）", null, ["packages/", "dsh-plugin"])
  console.log("OK npm pack 双向断言通过")
}

async function assertPack(cwd, label, mustContain, mustNotContain) {
  const { stdout, stderr } = await run("npm", ["pack", "--dry-run", "--ignore-scripts", "--cache", path.join(repoRoot, ".npm-cache-tmp")], { cwd })
  const listing = String(stdout) + String(stderr)
  if (mustContain) {
    for (const frag of mustContain) {
      if (!listing.includes(frag)) throw new Error(label + " 打包缺失：" + frag + NL + listing)
    }
  }
  for (const frag of mustNotContain) {
    if (listing.includes(frag)) throw new Error(label + " 打包含多余内容：" + frag)
  }
  console.log("  " + label + "：清单断言通过")
}

main().catch((error) => { console.error("构建失败：", error.message); process.exit(1) })
