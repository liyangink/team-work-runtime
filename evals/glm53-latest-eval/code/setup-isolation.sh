#!/bin/bash
# 构造 GLM-5.3 最新版隔离评测环境（v4）：只创建全新专用临时根，不删除根外内容，不复制凭据。
# 与旧版 v3 的差异：
#  - 被测包来自当前工作区源码（未发布、含未提交改动），不再使用已发布 tgz；
#  - 复制完整的包内实现文件清单，并计算源码树指纹，供报告对照；
#  - 其余安全边界沿用并加强：拒绝预存目标/软链/仓库内/HOME 内，复制后全树软链扫描。
# 用法（环境变量）：
#   EVAL_ROOT=<尚不存在的路径> REPO=<repo 根> PROVIDER=<provider> PROVIDER_ENV=<apiKeyEnv 名> MODEL=<model> EFFORT=<effort>
#   [EXPECTED_SKILL_SHA256=<hash>]
# 安全边界：
#  - 目标必须不存在；父目录必须存在且为真实目录；不得在 REPO 或 HOME 内创建；
#  - 不读取、不复制任何凭据文件；凭据只由调用方在运行会话时以环境变量提供。
set -euo pipefail

need() {
  local v
  v=$(printenv "$1" || true)
  if [ -z "$v" ]; then echo "setup-isolation: missing required env $1" >&2; exit 2; fi
}
for name in EVAL_ROOT REPO PROVIDER PROVIDER_ENV MODEL EFFORT; do need "$name"; done
EVAL_ROOT=$(printenv EVAL_ROOT)
REPO=$(printenv REPO)
PROVIDER=$(printenv PROVIDER)
PROVIDER_ENV=$(printenv PROVIDER_ENV)
MODEL=$(printenv MODEL)
EFFORT=$(printenv EFFORT)
EXPECTED_SKILL_SHA256=$(printenv EXPECTED_SKILL_SHA256 || true)

refuse() { echo "setup-isolation: refuse: $*" >&2; exit 2; }

case "$EVAL_ROOT" in -*) refuse "EVAL_ROOT must not start with '-'";; /|.|..|*/..|*/. ) refuse "unsafe EVAL_ROOT: $EVAL_ROOT";; esac
if [ -e "$EVAL_ROOT" ] || [ -L "$EVAL_ROOT" ]; then refuse "EVAL_ROOT already exists: $EVAL_ROOT"; fi
PARENT=$(dirname "$EVAL_ROOT")
BASE=$(basename "$EVAL_ROOT")
case "$BASE" in .|..|/) refuse "invalid basename: $BASE";; esac
[ -d "$PARENT" ] || refuse "parent directory does not exist: $PARENT"
PARENT_PHYS=$(cd "$PARENT" && pwd -P)
TARGET_PHYS="$PARENT_PHYS/$BASE"
if [ -e "$TARGET_PHYS" ] || [ -L "$TARGET_PHYS" ]; then refuse "target resolves to existing path: $TARGET_PHYS"; fi
REPO_PHYS=$(cd "$REPO" && pwd -P) || refuse "REPO is not a directory: $REPO"
HOME_PHYS=$(cd "$HOME" && pwd -P) || refuse "HOME is not a directory"
case "$TARGET_PHYS/" in
  "$REPO_PHYS"/*) refuse "EVAL_ROOT is inside REPO ($REPO_PHYS)";;
  "$HOME_PHYS"/*) refuse "EVAL_ROOT is inside HOME ($HOME_PHYS)";;
esac

for p in package.json bin/tw.mjs dsh/index.js runtime-v3/cli.mjs skills/team-work-v3/SKILL.md policy workflow/definitions team-work/policies team-work/rules; do
  [ -e "$REPO_PHYS/$p" ] || refuse "repo source missing: $p"
done
[ ! -L "$REPO_PHYS/skills" ] || refuse "repo skills dir must not be a symlink"
[ ! -L "$REPO_PHYS/skills/team-work-v3" ] || refuse "repo team-work-v3 dir must not be a symlink"

mkdir "$TARGET_PHYS"
HOME_DIR="$TARGET_PHYS/home"
DSH_DIR="$HOME_DIR/.dsh"
PROFILE="$DSH_DIR/profiles/headless"
PROJECT="$TARGET_PHYS/project"
EVID="$TARGET_PHYS/evidence"
mkdir -p "$PROFILE/node_modules/@deepseek-ai" "$PROJECT" "$EVID"

DEST="$PROFILE/node_modules/team-work-runtime"
mkdir "$DEST"
# 只复制运行时需要的源码文件/目录（与 package.json files 字段一致，外加 README/LICENSE）。
for p in package.json README.md LICENSE cordis.patch.yml bin dsh runtime-v3 policy workflow spec-providers team-work skills; do
  if [ -e "$REPO_PHYS/$p" ]; then cp -R "$REPO_PHYS/$p" "$DEST/"; fi
done
[ -d "$DEST/runtime-v3" ] || refuse "copied runtime-v3 missing"
[ -d "$DEST/skills/team-work-v3" ] || refuse "copied skill missing"
if [ -L "$DEST" ]; then refuse "copied team-work-runtime is a symlink; refusing to continue"; fi
LINK=$(find "$DEST" -type l -print -quit)
if [ -n "$LINK" ]; then refuse "copied team-work-runtime contains a symlink ($LINK); refusing to modify it"; fi
DEST_REAL=$(cd "$DEST" && pwd -P) || refuse "cannot resolve copied team-work-runtime"
case "$DEST_REAL/" in "$TARGET_PHYS"/*) : ;; *) refuse "copied team-work-runtime escapes new root: $DEST_REAL";; esac

# 依赖：只复制插件声明使用的最小依赖（及其传递依赖），沿用仓库 node_modules，不联网安装。
for p in "@deepseek-ai/schemastery" "@deepseek-ai/cosmokit" "@standard-schema/spec"; do
  if [ -e "$REPO_PHYS/node_modules/$p" ]; then
    mkdir -p "$PROFILE/node_modules/$(dirname "$p")"
    cp -R "$REPO_PHYS/node_modules/$p" "$PROFILE/node_modules/$p"
  else
    refuse "missing dependency in repo node_modules: $p"
  fi
done
LINK2=$(find "$PROFILE/node_modules" -type l -print -quit)
if [ -n "$LINK2" ]; then refuse "copied dependency tree contains a symlink ($LINK2); refusing to continue"; fi

cat > "$PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": { "team-work-runtime": "file:node_modules/team-work-runtime" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "team-work-runtime"] } }
}
JSON

cat > "$PROFILE/cordis.patch.yml" <<YAML
# 隔离评测 profile 用户层：单一 provider 路由、默认模型与被测插件档位。不写入任何凭据。
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      "$PROVIDER":
        apiKeyEnv: "$PROVIDER_ENV"
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: "$PROVIDER"
    model: "$MODEL"
    reasoningEffort: "$EFFORT"
- id: team-work-dsh
  config:
    tiers:
      junior: { provider: "$PROVIDER", model: "$MODEL", effort: "$EFFORT" }
      senior: { provider: "$PROVIDER", model: "$MODEL", effort: "$EFFORT" }
      expert: { provider: "$PROVIDER", model: "$MODEL", effort: "$EFFORT" }
YAML

LOADED_SHA=$(shasum -a 256 "$DEST/skills/team-work-v3/SKILL.md" | cut -d' ' -f1)
REPO_SHA=$(shasum -a 256 "$REPO_PHYS/skills/team-work-v3/SKILL.md" | cut -d' ' -f1)
if [ "$LOADED_SHA" != "$REPO_SHA" ]; then echo "setup-isolation: skill hash mismatch (loaded=$LOADED_SHA repo=$REPO_SHA)" >&2; exit 3; fi
if [ -n "$EXPECTED_SKILL_SHA256" ] && [ "$LOADED_SHA" != "$EXPECTED_SKILL_SHA256" ]; then
  echo "setup-isolation: skill hash does not match EXPECTED_SKILL_SHA256 (loaded=$LOADED_SHA expected=$EXPECTED_SKILL_SHA256)" >&2
  exit 3
fi

# 源码树指纹：包内实现文件逐文件 SHA-256（排序），证明实际加载的源码与被测工作区一致。
fingerprint_tree() {
  local root="$1" out="$2"
  ( cd "$root" && find package.json bin dsh runtime-v3 policy workflow spec-providers team-work skills -type f 2>/dev/null \
      | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done ) > "$out"
  shasum -a 256 "$out" | cut -d' ' -f1
}
SRC_FP=$(fingerprint_tree "$REPO_PHYS" "$EVID/source-files.sha256")
LOADED_FP=$(fingerprint_tree "$DEST" "$EVID/loaded-files.sha256")
if [ "$SRC_FP" != "$LOADED_FP" ]; then echo "setup-isolation: source tree fingerprint mismatch (repo=$SRC_FP loaded=$LOADED_FP)" >&2; exit 3; fi

{
  echo "eval_root=$TARGET_PHYS"
  echo "project_root=$PROJECT"
  echo "home=$HOME_DIR"
  echo "dsh_home=$DSH_DIR"
  echo "source_tree_sha256=$SRC_FP"
  echo "loaded_tree_sha256=$LOADED_FP"
  echo "skill_sha256=$LOADED_SHA"
  echo "repo_skill_sha256=$REPO_SHA"
  echo "repo_commit=$(cd "$REPO_PHYS" && git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "repo_dirty=$(cd "$REPO_PHYS" && git status --porcelain | wc -l | tr -d ' ')"
} | tee "$EVID/isolation-env.txt"
