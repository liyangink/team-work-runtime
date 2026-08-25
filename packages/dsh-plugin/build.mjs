// build.mjs — 插件构建（精简版）：skill 拷贝 + client 形态校验 + npm pack 双向断言
// 用法：node packages/dsh-plugin/build.mjs  （在仓库根执行）
// 产物：packages/dsh-plugin/dist/skill/**（仅插件单包 npm 通道需要——git/根包通道免构建直载 src）
import { cp, mkdir, rm, readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const NL = String.fromCharCode(10)

async function main() {
  await rm(path.join(here, "dist"), { recursive: true, force: true })
  await mkdir(path.join(here, "dist"), { recursive: true })

  // 1) skill 构建期拷贝（仅插件单包 npm 通道消费；git/根包通道运行期直读仓库 skills/team-work-v3）
  await cp(path.join(repoRoot, "skills", "team-work-v3"), path.join(here, "dist", "skill"), { recursive: true })
  console.log("OK dist/skill（SKILL.md + references，npm 单包通道）")

  // 2) client 形态校验（免构建：badge 源自带工厂形态，exports["./client"] 直指源文件）
  const badgeSrc = await readFile(path.join(here, "src-client", "badge.js"), "utf8")
  if (!badgeSrc.includes("__ModuleLoader__") || !badgeSrc.includes("var factory = function (module, exports)")) {
    throw new Error("src-client/badge.js 工厂形态不完整（装载协议：__ModuleLoader__.load 注册工厂）")
  }
  console.log("OK src-client/badge.js（工厂形态自足，免构建）")

  // 3) npm pack 双向断言（不多不少；npm notice 走 stderr 合并判断；--cache 规避宿主 EPERM）
  await assertPack(here, "插件包", ["src/index.js", "src-client/badge.js", "dist/skill/SKILL.md", "README.md", "package.json", "cordis.patch.yml"], ["roadmap", "tests/", "charter", "team-topology", "pre-phase3", "dist/index.js", "dist/client.js"])
  // 主包 tarball 携带插件源码全套（免构建，市场 git 通道同构）：根清单 files 收编插件目录，
  // 子目录保留独立 package.json + dsh 声明（装载方按子目录收录；多平台=新增 packages/<平台> 子目录）
  await assertPack(repoRoot, "主包（含插件子目录）", ["packages/dsh-plugin/src/index.js", "packages/dsh-plugin/src-client/badge.js", "packages/dsh-plugin/cordis.patch.yml", "packages/dsh-plugin/package.json"], ["packages/dsh-plugin/dist/index.js"])
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
