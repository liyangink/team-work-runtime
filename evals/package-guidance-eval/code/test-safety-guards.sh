#!/bin/bash
# 可重复运行的安全夹具（v3）：创建全新的 /tmp 夹具根，不删除既有目录，不启动真实 DSH/模型，不使用凭据。
# 覆盖：预存根/软链根/仓库内/HOME 内、包及内部 skills 软链、依赖软链、HOME/DSH_HOME/evidence 软链、
#       TAG ../ 与斜杠、输出软链、缺 project、缺 provider 变量、相对 TASKFILE/DSH_BIN/ELECTRON_BIN、正常桩运行。
set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$SCRIPT_DIR/../../.." && pwd -P)
SETUP="$SCRIPT_DIR/setup-isolation.sh"
RUN="$SCRIPT_DIR/run-headless.sh"
FIX=$(mktemp -d /tmp/twr-eval-safety-XXXXXX) || { echo "mktemp failed"; exit 9; }
REAL_FIX=$(cd "$FIX" && pwd -P)
FAILED=0
pass() { echo "PASS: $*"; }
fail() { FAILED=1; echo "FAIL: $*"; }
expect() {
  local label="$1" want="$2"
  shift 2
  set +e
  "$@" >"$FIX/$label.out" 2>&1
  local c=$?
  set -e
  if [ "$c" -eq "$want" ]; then pass "$label (exit=$c)"; else fail "$label (exit=$c want=$want) $(head -1 "$FIX/$label.out")"; fi
}
check_file_absent() { if [ -e "$1" ]; then fail "$2 (unexpected $1)"; else pass "$2"; fi; }
check_content() { if [ "$(cat "$1" 2>/dev/null)" = "$2" ]; then pass "$3"; else fail "$3 (content=$(cat "$1" 2>/dev/null))"; fi; }

mkdir -p "$FIX/repo/skills/team-work-v3" "$FIX/pkg/skills/team-work-v3" "$FIX/pkg2/skills"   "$FIX/deps/@deepseek-ai/schemastery" "$FIX/deps/@deepseek-ai/cosmokit" "$FIX/deps/@standard-schema/spec"   "$FIX/deps2/@deepseek-ai" "$FIX/ext-home/.dsh" "$FIX/ext-dsh" "$FIX/ext-ev" "$FIX/ext-skill" "$FIX/ext-dep" "$FIX/ext-project"   "$FIX/lnhome/project" "$FIX/lndsh/home" "$FIX/lnev/home/.dsh" "$FIX/lnev/project"   "$FIX/lnproject2/home/.dsh" "$FIX/lnev2/home/.dsh" "$FIX/lnev2/project" "$FIX/badroot/home/.dsh"
cp "$REPO/skills/team-work-v3/SKILL.md" "$FIX/repo/skills/team-work-v3/SKILL.md"
cp "$REPO/skills/team-work-v3/SKILL.md" "$FIX/pkg/skills/team-work-v3/SKILL.md"
echo KEEP > "$FIX/ext-home/marker"; echo KEEP > "$FIX/ext-dsh/marker"; echo KEEP > "$FIX/ext-ev/marker"
echo KEEP > "$FIX/ext-skill/marker"; echo KEEP > "$FIX/ext-dep/marker"; echo KEEP > "$FIX/pkg/skills/team-work-v3/marker"
ln -s "$FIX/ext-home" "$FIX/lnhome/home"
ln -s "$FIX/ext-dsh" "$FIX/lndsh/home/.dsh"
ln -s "$FIX/ext-ev" "$FIX/lnev2/evidence"
ln -s "$FIX/ext-project" "$FIX/lnproject2/project"
ln -s "$FIX/pkg" "$FIX/pkg-link"
ln -s "$FIX/ext-skill" "$FIX/pkg2/skills/team-work-v3"
ln -s "$FIX/ext-dep" "$FIX/deps2/@deepseek-ai/schemastery"
cat > "$FIX/stub-electron" <<'STUB'
#!/bin/bash
echo "invoked cwd=$(pwd)" >> "$STUB_MARKER"
if [ -n "$STUB_STDIN" ]; then cat > "$STUB_STDIN"; fi
echo "stub-cwd=$(pwd)"
echo "stub-argv=$*"
exit 0
STUB
chmod +x "$FIX/stub-electron"
printf '' > "$FIX/dummy-dsh-bin"
echo noop > "$FIX/task.md"
echo KEEP > "$FIX/existing"

setup_case() { env REPO="$FIX/repo" TEAM_WORK_PACKAGE="$1" TEAM_WORK_DEP_DIR="$FIX/deps" PROVIDER=zai-coding-cn PROVIDER_ENV=TEST_KEY MODEL=glm-5.3 EFFORT=max EVAL_ROOT="$2" bash "$SETUP"; }
setup_case_dep() { env REPO="$FIX/repo" TEAM_WORK_PACKAGE="$1" TEAM_WORK_DEP_DIR="$2" PROVIDER=zai-coding-cn PROVIDER_ENV=TEST_KEY MODEL=glm-5.3 EFFORT=max EVAL_ROOT="$3" bash "$SETUP"; }
setup_case_hash() { env REPO="$FIX/repo" TEAM_WORK_PACKAGE="$FIX/pkg" TEAM_WORK_DEP_DIR="$FIX/deps" PROVIDER=zai-coding-cn PROVIDER_ENV=TEST_KEY MODEL=glm-5.3 EFFORT=max EXPECTED_SKILL_SHA256=deadbeef EVAL_ROOT="$1" bash "$SETUP"; }
runner_case() { env TEST_KEY=dummy DSH_BIN="$1" ELECTRON_BIN="$2" STUB_MARKER="$3" bash "$RUN" "$4" "$5" "$6" "$7" TEST_KEY; }

expect T1 2 setup_case "$FIX/pkg" "$FIX/existing"
check_content "$FIX/existing" KEEP "T1 pre-existing root preserved"
ln -s "$FIX/existing" "$FIX/linkroot"
expect T2 2 setup_case "$FIX/pkg" "$FIX/linkroot"
check_content "$FIX/existing" KEEP "T2 symlink root target preserved"
expect T3 2 setup_case "$FIX/pkg" "$REPO/.twr-v3-harness-should-not-exist-$$"
check_file_absent "$REPO/.twr-v3-harness-should-not-exist-$$" "T3 repo root not created"
expect T4 2 setup_case "$FIX/pkg" "$HOME/.twr-v3-harness-should-not-exist-$$"
check_file_absent "$HOME/.twr-v3-harness-should-not-exist-$$" "T4 HOME root not created"
expect T5 0 setup_case "$FIX/pkg" "$FIX/newroot"
if [ -f "$FIX/newroot/home/.dsh/profiles/headless/node_modules/team-work-runtime/skills/team-work-v3/SKILL.md" ]; then pass "T5 skill copy present"; else fail "T5 skill copy missing"; fi
check_file_absent "$FIX/newroot/home/.dsh/.credentials.yaml" "T5 no credential copy"
expect T19 2 setup_case "$FIX/pkg-link" "$FIX/n19"
check_content "$FIX/pkg/skills/team-work-v3/marker" KEEP "T19 package symlink target preserved"
expect T20 2 setup_case "$FIX/pkg2" "$FIX/n20"
check_content "$FIX/ext-skill/marker" KEEP "T20 internal skill symlink target preserved"
expect T21 2 setup_case_dep "$FIX/pkg" "$FIX/deps2" "$FIX/n21"
check_content "$FIX/ext-dep/marker" KEEP "T21 dependency symlink target preserved"
expect T22 3 setup_case_hash "$FIX/n22"
expect T6 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t6.marker" "$FIX/badroot" t6 - "$FIX/task.md"
check_file_absent "$FIX/t6.marker" "T6 missing project blocks launch"
expect T7 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t7.marker" "$FIX/lnproject2" t7 - "$FIX/task.md"
check_file_absent "$FIX/t7.marker" "T7 project symlink blocks launch"
expect T11 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t11.marker" "$FIX/lnhome" t11 - "$FIX/task.md"
check_file_absent "$FIX/t11.marker" "T11 HOME symlink blocks launch"
expect T12 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t12.marker" "$FIX/lndsh" t12 - "$FIX/task.md"
check_file_absent "$FIX/t12.marker" "T12 DSH_HOME symlink blocks launch"
expect T13 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t13.marker" "$FIX/lnev2" t13 - "$FIX/task.md"
check_file_absent "$FIX/t13.marker" "T13 evidence symlink blocks launch"
expect T14 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t14.marker" "$FIX/newroot" "../escape" - "$FIX/task.md"
check_file_absent "$FIX/t14.marker" "T14 TAG ../escape blocks launch"
check_file_absent "$FIX/newroot/escape.jsonl" "T14 no escaped output"
expect T15 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t15.marker" "$FIX/newroot" "a/b" - "$FIX/task.md"
check_file_absent "$FIX/t15.marker" "T15 TAG with slash blocks launch"
expect T9 2 env -u TEST_KEY DSH_BIN="$FIX/dummy-dsh-bin" ELECTRON_BIN="$FIX/stub-electron" STUB_MARKER="$FIX/t9.marker" bash "$RUN" "$FIX/newroot" t9 - "$FIX/task.md" TEST_KEY
check_file_absent "$FIX/t9.marker" "T9 missing provider env blocks launch"
expect T10 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t10.marker" "$FIX/newroot" t10 - "$FIX/missing-task.md"
check_file_absent "$FIX/t10.marker" "T10 missing task file blocks launch"

set +e
( cd "$FIX" && env TEST_KEY=dummy DSH_BIN="$FIX/dummy-dsh-bin" ELECTRON_BIN="$FIX/stub-electron" STUB_MARKER="$FIX/t8.marker" bash "$RUN" "$FIX/newroot" t8 - "$FIX/task.md" TEST_KEY ) >"$FIX/t8.out" 2>&1
c8=$?
( cd "$FIX" && env TEST_KEY=dummy DSH_BIN=./dummy-dsh-bin ELECTRON_BIN=./stub-electron STUB_MARKER="$FIX/t16.marker" STUB_STDIN="$FIX/t16.stdin" bash "$RUN" "$FIX/newroot" t16 - ./task.md TEST_KEY ) >"$FIX/t16.out" 2>&1
c16=$?
( cd "$FIX" && env TEST_KEY=dummy DSH_BIN=./dummy-dsh-bin ELECTRON_BIN=./stub-electron STUB_MARKER="$FIX/t17.marker" bash "$RUN" "$FIX/newroot" t17 - "$FIX/task.md" TEST_KEY ) >"$FIX/t17.out" 2>&1
c17=$?
set -e
if [ "$c8" -eq 0 ] && grep -q "stub-cwd=$REAL_FIX/newroot/project" "$FIX/newroot/evidence/t8.jsonl" && [ "$(cat "$FIX/newroot/evidence/t8.exit")" = "0" ]; then pass "T8 valid stub run in isolated project"; else fail "T8 valid run (exit=$c8)"; fi
if [ "$c16" -eq 0 ] && [ "$(cat "$FIX/t16.stdin" 2>/dev/null)" = "noop" ]; then pass "T16 relative task file after cd"; else fail "T16 relative task file (exit=$c16)"; fi
if [ "$c17" -eq 0 ] && [ -e "$FIX/t17.marker" ]; then pass "T17 relative DSH_BIN/ELECTRON_BIN after cd"; else fail "T17 relative bins (exit=$c17)"; fi
echo ORIGINAL > "$FIX/ext-ev/out.jsonl"
ln -s "$FIX/ext-ev/out.jsonl" "$FIX/newroot/evidence/t18.jsonl"
expect T18 2 runner_case "$FIX/dummy-dsh-bin" "$FIX/stub-electron" "$FIX/t18.marker" "$FIX/newroot" t18 - "$FIX/task.md"
check_content "$FIX/ext-ev/out.jsonl" ORIGINAL "T18 output symlink target unchanged"
check_file_absent "$FIX/t18.marker" "T18 output symlink blocks launch"

echo "FIX=$FIX"
if [ "$FAILED" -ne 0 ]; then echo "RESULT: FAILED"; exit 1; fi
echo "RESULT: OK"
