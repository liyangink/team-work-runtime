#!/bin/bash
# 为 code→ptc 改名前的历史会话创建用户级别名预设（不改写任何历史数据，可随时回退）
# 用法: bash scripts/fix-dsh-code-preset-alias.sh
set -euo pipefail

SRC=/Users/liyang/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc
DST=/Users/liyang/.dsh/.agent-presets/code

if [ -e "$DST" ]; then
  echo "已存在: $DST （跳过，避免覆盖）"
  exit 0
fi

mkdir -p /Users/liyang/.dsh/.agent-presets
cp -R "$SRC" "$DST"

cat > "$DST/preset.yml" <<'EOF'
name: PTC 模式（code 兼容）
description: 由内置 PTC 预设复制而来，为 code→ptc 改名前的历史会话提供兼容别名；仅用于恢复历史会话，新会话请直接选 PTC 模式。
order: 5
EOF

echo "完成。目录内容:"
find "$DST" -type f | sort
echo
echo "回滚方式: rm -rf /Users/liyang/.dsh/.agent-presets/code"
