#!/bin/bash
# 确定性复现 F-N1：rework finding 使用未定义字段 packages（而非 package）时，
# Runtime 不拒绝，按“未点名”处理，导致全部已交付包返工。
# 用法：EVAL_ROOT=<隔离根> [TW=<tw.mjs路径>] [REPO_DIR=<仓库根>] ./repro-finding-package-field.sh
# 安全：要求 EVAL_ROOT 是 setup-isolation.sh 创建的真实隔离根，位于仓库和真实 HOME 之外；
#      项目目录必须尚不存在（拒绝已有目录/软链），用非递归 mkdir 独占创建；不做 rm -rf。
set -euo pipefail
EVAL_ROOT="${EVAL_ROOT:?set EVAL_ROOT}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../../.." && pwd -P)}"
REAL_HOME_ABS=$(cd "$HOME" && pwd -P)
case "$EVAL_ROOT" in /*) : ;; *) echo "repro: EVAL_ROOT must be absolute" >&2; exit 2;; esac
[ -d "$EVAL_ROOT" ] || { echo "repro: EVAL_ROOT missing: $EVAL_ROOT" >&2; exit 2; }
[ ! -L "$EVAL_ROOT" ] || { echo "repro: EVAL_ROOT must not be a symlink" >&2; exit 2; }
ROOT_PHYS=$(cd "$EVAL_ROOT" && pwd -P)
REPO_PHYS=$(cd "$REPO_DIR" && pwd -P)
[ -f "$ROOT_PHYS/evidence/isolation-env.txt" ] || { echo "repro: EVAL_ROOT lacks setup marker evidence/isolation-env.txt" >&2; exit 2; }
case "$ROOT_PHYS/" in
  "$REPO_PHYS"/*) echo "repro: EVAL_ROOT inside repo; refuse" >&2; exit 2;;
  "$REAL_HOME_ABS"/*) echo "repro: EVAL_ROOT inside real HOME; refuse" >&2; exit 2;;
esac
PROJECT="$ROOT_PHYS/cli-repro-finding-field"
if [ -e "$PROJECT" ] || [ -L "$PROJECT" ]; then
  echo "repro: target already exists (refuse to reuse/overwrite): $PROJECT" >&2
  echo "repro: use a fresh eval root or remove it manually only if you created it for this run" >&2
  exit 2
fi
mkdir "$PROJECT" || { echo "repro: cannot create $PROJECT" >&2; exit 2; }
cd "$PROJECT"
TW="${TW:-$ROOT_PHYS/home/.dsh/profiles/headless/node_modules/team-work-runtime/bin/tw.mjs}"
case "$TW" in "$ROOT_PHYS"/*) : ;; *) echo "repro: TW must stay inside EVAL_ROOT: $TW" >&2; exit 2;; esac
[ -f "$TW" ] || { echo "repro: TW missing: $TW" >&2; exit 2; }
export TW_DSH_CONFIG='{"tiers":{"junior":{"provider":"zai-coding-cn","model":"glm-5.3","effort":"max"},"senior":{"provider":"zai-coding-cn","model":"glm-5.3","effort":"max"},"expert":{"provider":"zai-coding-cn","model":"glm-5.3","effort":"max"}},"entryId":"team-work-dsh","profile":"eval-cli"}'
node "$TW" open --name finding-shape --objective "预检：finding 字段形状" --raw-requirement "两包各写一行" --entry implementation >/dev/null
node "$TW" plan --task finding-shape --packages '[{"id":"a","writable":["docs/a.md:doc"],"done":["写 a"],"dependsOn":[]},{"id":"b","writable":["docs/b.md:doc"],"done":["写 b"],"dependsOn":[]}]' >/dev/null
A=$(node -e "const j=JSON.parse(require('child_process').execFileSync(process.execPath,[process.argv[1],'dispatch-plan','--task','finding-shape'],{encoding:'utf8'}));console.log(j.card.decisionId)" "$TW")
node "$TW" decide --task finding-shape --choice 1 --decision-id "$A" >/dev/null
W1=$(node "$TW" dispatch-plan --task finding-shape)
mkdir -p docs; echo "虚构 a" > docs/a.md; echo "虚构 b" > docs/b.md
for key_pkg in $(node -e "const j=JSON.parse(process.argv[1]);for(const w of j.waves)console.log(w.dispatchKey+':'+w.package)" "$W1"); do
  key="${key_pkg%%:*}"; pkg="${key_pkg##*:}"
  node "$TW" deliver --task finding-shape --key "$key" --outcome delivered --summary "虚构交付 $pkg" --paths "docs/$pkg.md" >/dev/null
done
W2=$(node "$TW" dispatch-plan --task finding-shape)
KEY=$(node -e "const j=JSON.parse(process.argv[1]);console.log(j.waves.find(w=>w.role==='challenger').dispatchKey)" "$W2")
echo "## 提交只点名 a 的 rework finding（错误字段名 packages）"
node "$TW" review --task finding-shape --key "$KEY" --recommendation rework --summary "虚构评审：只点名 a" --findings '[{"severity":"blocker","statement":"虚构缺陷","packages":["a"]}]'
echo
echo "## 下一次推进的实际返工波次"
node "$TW" dispatch-plan --task finding-shape | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify({stop:j.stop,waves:(j.waves||[]).map(w=>({role:w.role,package:w.package,key:w.dispatchKey,round:w.round}))},null,2))})"
echo
echo "## 本脚本创建的项目（保留供审计，不删除）：$PROJECT"
