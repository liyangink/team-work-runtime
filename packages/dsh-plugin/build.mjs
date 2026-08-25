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

  // 1b) host 源码拷贝入 dist（F5：发布只含 dist——入口 dist/index.js；src 不进包）
  await cp(path.join(here, "src"), path.join(here, "dist"), { recursive: true })
  console.log("OK dist/*.js（host 插件源码拷贝）")

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
  await assertPack(here, "插件包", ["dist/client.js", "dist/skill/SKILL.md", "dist/index.js", "dist/inject.js", "README.md", "package.json"], ["roadmap", "tests/", "charter", "team-topology", "pre-phase3", "src/index.js"])
  // 主包 tarball 携带插件全套（packages/dsh-plugin/**）：市场 git 源码安装按仓库根构建——
  // 根清单 files 收编插件产物，子目录保留独立 package.json（市场 #path: 子目录插件自动收录，多平台=加子目录）
  await assertPack(repoRoot, "主包（含插件子目录，市场 git 通道）", ["packages/dsh-plugin/dist/index.js", "packages/dsh-plugin/dist/client.js", "packages/dsh-plugin/cordis.patch.yml", "packages/dsh-plugin/package.json"], ["src/index.js"])
  console.log("OK npm pack 双向断言通过")

  // 4) dist 提交态脏检查：dist 已随 git 分发（市场 git 安装不执行构建脚本），
  //    源码改动后忘 rebuild 会造成 git 安装拿到旧产物——build 后 dist 与 git 提交态不一致时提醒。
  const { stdout: st } = await run("git", ["status", "--porcelain", "--", "packages/dsh-plugin/dist"], { cwd: repoRoot }).catch(() => ({ stdout: "" }))
  if (String(st).trim() !== "") console.warn("提醒：dist 有未提交改动——记得提交，否则市场 git 安装拿到旧产物")
  console.log("OK dist 提交态检查")
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
