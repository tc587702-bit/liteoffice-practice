#!/usr/bin/env bash
# LiteOffice 环境引导：把一台干净机器变成"能跑起来"的状态。
#
# 本项目前端零构建、零 npm 依赖，所以这里只需要：
#   1. 确认 Node 20（只用于 pnpm 任务脚本和 JS 语法检查）
#   2. 按需拉取 Office 内核产物（342 MB，Day 2 起才需要）
#
# 用法：bash bootstrap.sh            有网，拉内核产物
#      bash bootstrap.sh --no-engine 跳过内核产物
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo "== 1/2 检查 Node =="
command -v node >/dev/null 2>&1 || die "没有 Node。macOS: brew install node@20；或 nvm install 20"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" == "20" ]] || die "Node 需要 20.x，当前是 $(node -v)"
ok "Node $(node -v)"

echo "== 2/2 Office 内核产物 =="
if [[ "${1:-}" == "--no-engine" ]]; then
  warn "已跳过（--no-engine）。之后单独执行：pnpm engine"
elif [[ -d code/frontend/public/editor ]]; then
  ok "public/editor 已存在，跳过下载"
else
  node code/core_engine/fetch-engine.mjs || warn "引擎拉取失败，不影响 md 开发。稍后重试：pnpm engine"
fi

echo
echo "✅ 环境就绪。启动：pnpm serve  然后打开 http://127.0.0.1:5191"
