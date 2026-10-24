#!/usr/bin/env bash
# LiteOffice 环境引导脚本：把一台干净机器变成"能跑起来"的状态。
# 用法：bash bootstrap.sh            （有网）
#      bash bootstrap.sh --no-engine（先不拉 Office 内核产物）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo "== 1/4 检查 Node =="
command -v node >/dev/null 2>&1 || die "没有 Node。macOS: brew install node@20；或 nvm install 20"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" == "20" ]] || die "Node 需要 20.x，当前是 $(node -v)。本项目 Vite/Tauri 按 20 验证"
ok "Node $(node -v)"

echo "== 2/4 激活 pnpm（corepack 按 packageManager 字段下载对应版本）=="
command -v corepack >/dev/null 2>&1 || die "没有 corepack：Node 20 自带，检查是否装了完整发行版"
corepack enable >/dev/null 2>&1 || warn "corepack enable 失败（可能没有写权限），尝试继续"
ok "pnpm $(pnpm -v)"

echo "== 3/4 安装依赖 =="
if [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
  ok "按 pnpm-lock.yaml 安装（版本完全锁定）"
else
  pnpm install
  warn "首次安装：已生成 pnpm-lock.yaml，记得提交它，否则别人装到的版本会漂"
fi

echo "== 4/4 Office 内核产物 =="
if [[ "${1:-}" == "--no-engine" ]]; then
  warn "已跳过（--no-engine）。之后单独执行：pnpm engine"
elif [[ -d code/frontend/public/editor ]]; then
  ok "public/editor 已存在，跳过下载"
else
  node code/core_engine/fetch-engine.mjs || warn "引擎拉取失败，不影响 md 开发。稍后重试：pnpm engine"
fi

echo
echo "✅ 环境就绪。下一步：pnpm dev    # 或 pnpm --filter @liteoffice/frontend dev"
