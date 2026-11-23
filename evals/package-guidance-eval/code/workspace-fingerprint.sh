#!/bin/bash
# 记录真实工作区只读指纹：技能/测试/方案文件哈希、git 状态、.team-work 元数据摘要（不读文件内容）。
# 用法：workspace-fingerprint.sh <repo-root>
set -euo pipefail
REPO="${1:?repo root}"
cd "$REPO"
shasum -a 256 skills/team-work-v3/SKILL.md tests/repository-contract.test.mjs docs/lead-reporting-alignment-plan.md docs/parallel-package-guidance-plan.md 2>/dev/null
echo "git_status:"
git status --porcelain
echo "teamwork_files=$(find .team-work -type f | wc -l | tr -d ' ')"
echo "teamwork_meta_sha256=$(find .team-work -type f -print0 | xargs -0 stat -f '%m %z %N' | sort | shasum -a 256 | cut -d' ' -f1)"
