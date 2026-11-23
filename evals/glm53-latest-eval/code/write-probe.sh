#!/bin/bash
# 外层文件沙箱与网络边界探针（诊断用途，不构成安全证明；不启动模型）。
# 所有探针使用 mktemp 独占创建随机文件名，只删除本脚本刚创建的文件，不触碰既有路径。
# 用法：EVAL_ROOT=<隔离根> ./write-probe.sh
# 仓库与真实 HOME 由脚本位置/环境固定，不接受路径替换。
set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$SCRIPT_DIR/../../.." && pwd -P)
REAL_HOME=$(cd "$HOME" && pwd -P)
EVAL_ROOT="${EVAL_ROOT:?set EVAL_ROOT}"
case "$EVAL_ROOT" in /*) : ;; *) echo "write-probe: EVAL_ROOT must be absolute" >&2; exit 2;; esac
[ -d "$EVAL_ROOT" ] || { echo "write-probe: EVAL_ROOT missing: $EVAL_ROOT" >&2; exit 2; }
[ ! -L "$EVAL_ROOT" ] || { echo "write-probe: EVAL_ROOT must not be a symlink" >&2; exit 2; }
ROOT_PHYS=$(cd "$EVAL_ROOT" && pwd -P)
REPO_PHYS=$(cd "$REPO" && pwd -P)
[ -f "$ROOT_PHYS/evidence/isolation-env.txt" ] || { echo "write-probe: EVAL_ROOT lacks setup marker evidence/isolation-env.txt" >&2; exit 2; }
case "$ROOT_PHYS/" in
  "$REPO_PHYS"/*) echo "write-probe: EVAL_ROOT inside repo; refuse" >&2; exit 2;;
  "$REAL_HOME"/*) echo "write-probe: EVAL_ROOT inside real HOME; refuse" >&2; exit 2;;
esac
probe_deny() {
  local dir="$1" label="$2" f
  if f=$(mktemp "$dir/.eval-probe.XXXXXX" 2>/dev/null); then
    echo "$label: ALLOWED ($f)"
    rm -f "$f"
    return 1
  fi
  echo "$label: DENIED"
  return 0
}
probe_allow() {
  local dir="$1" label="$2" f
  if f=$(mktemp "$dir/.eval-probe.XXXXXX" 2>/dev/null); then
    echo "$label: ALLOWED ($f)"
    rm -f "$f"
    return 0
  fi
  echo "$label: DENIED"
  return 1
}
echo "# 外层文件沙箱写入拒绝探针（mktemp 独占随机名；不触碰既有文件；诊断用途）"
echo "repo=$REPO_PHYS"
echo "real_home=$REAL_HOME"
probe_deny "$REPO_PHYS" "repo-write"
probe_deny "$REAL_HOME" "home-write"
echo "## 子进程继承（预期同父进程）"
bash -c 'f=$(mktemp "$1/.eval-probe.XXXXXX" 2>/dev/null) && { echo "child-home-write: ALLOWED ($f)"; rm -f "$f"; exit 0; } || { echo "child-home-write: DENIED"; exit 1; }' _ "$REAL_HOME"
echo "child-home-exit=$?"
probe_allow "$ROOT_PHYS/evidence" "eval-root-write"
echo "## 网络可达性（真实模型调用前提）"
curl -sS -o /dev/null -w 'http_status=%{http_code}\n' --max-time 8 https://open.bigmodel.cn/ 2>&1
echo "## 嵌套 sandbox-exec 可用性（内层 DSH 无法再套沙箱）"
sandbox-exec -p '(version 1)(allow default)' true 2>&1; echo "sandbox-exit=$?"
echo "## 诊断结论（不作为放行依据）：若 repo-write 为 ALLOWED，则既有项目在沙箱层可写，真实演练入口必须保持禁用。"
exit 0
