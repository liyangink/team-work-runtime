#!/bin/bash
# 安全构造隔离评测环境（v3）：只创建全新专用临时根，不删除隔离根外内容，不复制凭据。
# 用法（环境变量）：
#   EVAL_ROOT=<尚不存在的路径> REPO=<repo> TEAM_WORK_PACKAGE=<已发布包目录> TEAM_WORK_DEP_DIR=<含 schemastery 的 node_modules>
#   PROVIDER=<provider> PROVIDER_ENV=<apiKeyEnv 名> MODEL=<model> EFFORT=<effort> [EXPECTED_SKILL_SHA256=<hash>]
# 安全边界：
#  - 目标必须不存在；父目录必须存在且为真实目录；不得在 REPO 或 HOME 内创建；
#  - TEAM_WORK_PACKAGE、TEAM_WORK_DEP_DIR 不得为软链；复制出的插件树若含任何软链则拒绝继续（不做 rm）；
#  - 所有删除只发生在刚创建的新根内，且删除前确认目标是非软链的真实目录；
#  - 不读取、不复制任何凭据文件；凭据只由调用方在运行会话时以环境变量提供。
set -euo pipefail

need() {
  local v
  v=$(printenv "$1" || true)
  if [ -z "$v" ]; then echo "setup-isolation: missing required env $1" >&2; exit 2; fi
}
for name in EVAL_ROOT REPO TEAM_WORK_PACKAGE TEAM_WORK_DEP_DIR PROVIDER PROVIDER_ENV MODEL EFFORT; do need "$name"; done
EVAL_ROOT=$(printenv EVAL_ROOT)
REPO=$(printenv REPO)
TEAM_WORK_PACKAGE=$(printenv TEAM_WORK_PACKAGE)
TEAM_WORK_DEP_DIR=$(printenv TEAM_WORK_DEP_DIR)
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

[ -d "$TEAM_WORK_PACKAGE" ] || refuse "TEAM_WORK_PACKAGE is not a directory: $TEAM_WORK_PACKAGE"
[ ! -L "$TEAM_WORK_PACKAGE" ] || refuse "TEAM_WORK_PACKAGE must not be a symlink: $TEAM_WORK_PACKAGE"
[ ! -L "$TEAM_WORK_PACKAGE/skills" ] || refuse "TEAM_WORK_PACKAGE/skills must not be a symlink"
[ ! -L "$TEAM_WORK_PACKAGE/skills/team-work-v3" ] || refuse "TEAM_WORK_PACKAGE/skills/team-work-v3 must not be a symlink"
[ -d "$TEAM_WORK_DEP_DIR" ] || refuse "TEAM_WORK_DEP_DIR is not a directory: $TEAM_WORK_DEP_DIR"
[ ! -L "$TEAM_WORK_DEP_DIR" ] || refuse "TEAM_WORK_DEP_DIR must not be a symlink: $TEAM_WORK_DEP_DIR"
[ ! -L "$REPO_PHYS/skills" ] || refuse "repo skills dir must not be a symlink"
[ ! -L "$REPO_PHYS/skills/team-work-v3" ] || refuse "repo team-work-v3 dir must not be a symlink"
[ -f "$REPO_PHYS/skills/team-work-v3/SKILL.md" ] || refuse "repo skill snapshot missing: $REPO_PHYS/skills/team-work-v3/SKILL.md"

mkdir "$TARGET_PHYS"
HOME_DIR="$TARGET_PHYS/home"
DSH_DIR="$HOME_DIR/.dsh"
PROFILE="$DSH_DIR/profiles/headless"
PROJECT="$TARGET_PHYS/project"
EVID="$TARGET_PHYS/evidence"
mkdir -p "$PROFILE/node_modules/@deepseek-ai" "$PROJECT" "$EVID"

DEST="$PROFILE/node_modules/team-work-runtime"
cp -R "$TEAM_WORK_PACKAGE" "$DEST"
if [ -L "$DEST" ]; then refuse "copied team-work-runtime is a symlink; refusing to continue (no deletion performed)"; fi
LINK=$(find "$DEST" -type l -print -quit)
if [ -n "$LINK" ]; then refuse "copied team-work-runtime contains a symlink ($LINK); refusing to modify it (no deletion performed)"; fi
DEST_REAL=$(cd "$DEST" && pwd -P) || refuse "cannot resolve copied team-work-runtime"
case "$DEST_REAL/" in "$TARGET_PHYS"/*) : ;; *) refuse "copied team-work-runtime escapes new root: $DEST_REAL";; esac
SKILL_COPY="$DEST/skills/team-work-v3"
[ -d "$SKILL_COPY" ] || refuse "copied skill dir missing: $SKILL_COPY"
[ ! -L "$SKILL_COPY" ] || refuse "copied skill dir is a symlink: $SKILL_COPY"
rm -r "$SKILL_COPY"
cp -R "$REPO_PHYS/skills/team-work-v3" "$DEST/skills/"

cp -R "$TEAM_WORK_DEP_DIR/@deepseek-ai/schemastery" "$PROFILE/node_modules/@deepseek-ai/" 2>/dev/null || true
cp -R "$TEAM_WORK_DEP_DIR/@deepseek-ai/cosmokit" "$PROFILE/node_modules/@deepseek-ai/" 2>/dev/null || true
cp -R "$TEAM_WORK_DEP_DIR/@standard-schema" "$PROFILE/node_modules/" 2>/dev/null || true
LINK2=$(find "$PROFILE/node_modules" -type l -print -quit)
if [ -n "$LINK2" ]; then refuse "copied dependency tree contains a symlink ($LINK2); refusing to continue (no deletion performed)"; fi

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

LOADED_SHA=$(shasum -a 256 "$SKILL_COPY/SKILL.md" | cut -d' ' -f1)
REPO_SHA=$(shasum -a 256 "$REPO_PHYS/skills/team-work-v3/SKILL.md" | cut -d' ' -f1)
if [ "$LOADED_SHA" != "$REPO_SHA" ]; then echo "setup-isolation: skill hash mismatch (loaded=$LOADED_SHA repo=$REPO_SHA)" >&2; exit 3; fi
if [ -n "$EXPECTED_SKILL_SHA256" ] && [ "$LOADED_SHA" != "$EXPECTED_SKILL_SHA256" ]; then
  echo "setup-isolation: skill hash does not match EXPECTED_SKILL_SHA256 (loaded=$LOADED_SHA expected=$EXPECTED_SKILL_SHA256)" >&2
  exit 3
fi
echo "root=$TARGET_PHYS"
echo "project_root=$PROJECT"
echo "skill_sha256=$LOADED_SHA"
echo "repo_skill_sha256=$REPO_SHA"
