#!/bin/bash
# 在已核验的隔离根内运行独立 DSH CLI 顶层会话（v3 安全门）。
# 用法：run-headless.sh <eval-root> <tag> <session-id|-> <task-file> [provider-env-name]
# 安全边界：
#  - EVAL_ROOT 与 HOME/DSH_HOME/project/evidence 每一级都拒绝软链，并校验解析后的物理路径在根内；
#  - TAG 只允许单段 [A-Za-z0-9._-]；输出文件已存在（含软链）即拒绝，避免重定向逃逸；
#  - TASKFILE/DSH_BIN/ELECTRON_BIN 在 cd 前解析为绝对路径，避免切换 cwd 后丢失；
#  - cd 失败立即退出，不回落调用者目录；凭据只从调用方环境变量读取，不落盘、不打印。
# 未覆盖：检查与使用之间的 TOCTOU 竞态、硬链接替换、恶意外部 PATH。
set -euo pipefail
if [ "$#" -lt 4 ]; then
  echo "usage: run-headless.sh <eval-root> <tag> <session-id|-> <task-file> [provider-env-name]" >&2
  exit 2
fi
EVAL_ROOT="$1"
TAG="$2"
SESSION="$3"
TASKFILE="$4"
if [ "$#" -ge 5 ]; then PROVIDER_ENV="$5"; else PROVIDER_ENV=EVAL_PROVIDER_API_KEY; fi

refuse() { echo "run-headless: refuse: $*" >&2; exit 2; }
abspath() { case "$1" in /*) printf '%s\n' "$1";; *) printf '%s/%s\n' "$PWD" "$1";; esac; }

case "$TAG" in ""|.|..) refuse "invalid TAG: $TAG";; esac
case "$TAG" in *[!A-Za-z0-9._-]*) refuse "TAG must be one segment of [A-Za-z0-9._-]: $TAG";; esac
TAG_LEN=$(printf '%s' "$TAG" | wc -c | tr -d ' ')
[ "$TAG_LEN" -le 64 ] || refuse "TAG too long (max 64)"
case "$PROVIDER_ENV" in [A-Za-z_][A-Za-z0-9_]*) : ;; *) refuse "invalid provider env name: $PROVIDER_ENV";; esac

[ -d "$EVAL_ROOT" ] || refuse "EVAL_ROOT is not a directory: $EVAL_ROOT"
[ ! -L "$EVAL_ROOT" ] || refuse "EVAL_ROOT is a symlink: $EVAL_ROOT"
EVAL_PHYS=$(cd "$EVAL_ROOT" && pwd -P) || refuse "cannot resolve EVAL_ROOT: $EVAL_ROOT"

CHECK=""
check_dir_inside() {
  local p="$1" label="$2" phys
  if [ ! -d "$p" ]; then echo "run-headless: refuse: $label missing: $p" >&2; return 2; fi
  if [ -L "$p" ]; then echo "run-headless: refuse: $label is a symlink: $p" >&2; return 2; fi
  phys=$(cd "$p" && pwd -P) || { echo "run-headless: refuse: cannot resolve $label: $p" >&2; return 2; }
  case "$phys/" in "$EVAL_PHYS"/*) : ;; *) echo "run-headless: refuse: $label escapes EVAL_ROOT: $phys" >&2; return 2;; esac
  CHECK="$phys"
}
check_dir_inside "$EVAL_PHYS/home" "HOME" || exit 2
HOME_PHYS="$CHECK"
check_dir_inside "$HOME_PHYS/.dsh" "DSH_HOME" || exit 2
DSH_PHYS="$CHECK"
check_dir_inside "$EVAL_PHYS/project" "project" || exit 2
PROJECT_PHYS="$CHECK"

EVID="$EVAL_PHYS/evidence"
if [ -e "$EVID" ] || [ -L "$EVID" ]; then
  check_dir_inside "$EVID" "evidence" || exit 2
  EVID="$CHECK"
else
  mkdir "$EVID"
  EVID=$(cd "$EVID" && pwd -P) || refuse "cannot resolve evidence dir"
fi
OUT_JSONL="$EVID/$TAG.jsonl"
OUT_ERR="$EVID/$TAG.err"
OUT_EXIT="$EVID/$TAG.exit"
for f in "$OUT_JSONL" "$OUT_ERR" "$OUT_EXIT"; do
  if [ -e "$f" ] || [ -L "$f" ]; then refuse "output already exists (refusing to follow/replace it): $f"; fi
done

if [ -z "$(printenv DSH_BIN || true)" ]; then refuse "set DSH_BIN to the installed dsh lib/bin.js"; fi
if [ -z "$(printenv ELECTRON_BIN || true)" ]; then refuse "set ELECTRON_BIN to the app executable"; fi
DSH_BIN=$(printenv DSH_BIN)
ELECTRON_BIN=$(printenv ELECTRON_BIN)
TASKFILE_ABS=$(abspath "$TASKFILE")
DSH_BIN_ABS=$(abspath "$DSH_BIN")
ELECTRON_ABS=$(abspath "$ELECTRON_BIN")
[ -f "$TASKFILE_ABS" ] || refuse "task file missing: $TASKFILE (resolved: $TASKFILE_ABS)"
[ -f "$DSH_BIN_ABS" ] || refuse "DSH_BIN is not a file: $DSH_BIN_ABS"
[ -x "$ELECTRON_ABS" ] || refuse "ELECTRON_BIN is not executable: $ELECTRON_ABS"
[ -n "$(printenv "$PROVIDER_ENV" || true)" ] || refuse "provider env $PROVIDER_ENV is not set"

unset DSH_PROFILE_DIR DSH_PROFILE DSH_SESSION_ID DSH_WEB_URL DSH_SHELL DSH_NODE_EXECUTABLE DSH_TOOLS_MODE
export HOME="$HOME_PHYS"
export DSH_HOME="$DSH_PHYS"
export DSH_PERMISSION_MODE=danger-full-access
export ELECTRON_RUN_AS_NODE=1

cd "$PROJECT_PHYS"
[ "$(pwd -P)" = "$PROJECT_PHYS" ] || refuse "cwd mismatch after cd: $(pwd -P)"

set +e
if [ "$SESSION" = "-" ]; then
  "$ELECTRON_ABS" "$DSH_BIN_ABS" --profile headless --json - < "$TASKFILE_ABS" > "$OUT_JSONL" 2> "$OUT_ERR"
else
  "$ELECTRON_ABS" "$DSH_BIN_ABS" --profile headless --json --session-id "$SESSION" - < "$TASKFILE_ABS" > "$OUT_JSONL" 2> "$OUT_ERR"
fi
status=$?
set -e
echo "$status" > "$OUT_EXIT"
exit "$status"
