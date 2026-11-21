#!/usr/bin/env bash
# LiteOffice 服务器初始化脚本（Ubuntu 24.04）
# 用法：sudo bash deploy/setup-server.sh
#
# 做四件事：
#   1. 安装 Node.js 24、Python 3、rsync、git
#   2. 创建服务用户 liteoffice
#   3. 创建数据目录和日志目录
#   4. 没有 swap 时创建 2G swap（2G 内存跑 Agent 时很重要）

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 或 sudo 运行：sudo bash deploy/setup-server.sh" >&2
  exit 1
fi

APP_USER="liteoffice"
APP_DIR="/opt/liteoffice"
DATA_DIR="/var/lib/liteoffice"
LOG_DIR="/var/log/liteoffice"
ENV_DIR="/etc/liteoffice"

echo "==> 安装系统依赖"
apt-get update
apt-get install -y \
  ca-certificates curl gnupg git rsync \
  python3 python3-venv python3-pip \
  sqlite3

echo "==> 检查 Node.js（需要 22.13+，这里装 24 LTS）"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "${major}" -ge 22 ]]; then
    need_node=0
  fi
fi

if [[ "${need_node}" -eq 1 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

echo "==> 创建服务用户与目录"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${ENV_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${LOG_DIR}"
chmod 750 "${DATA_DIR}" "${LOG_DIR}"

echo "==> 配置 swap（已存在则跳过）"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  echo "已创建 2G swap"
else
  echo "已有 swap，跳过"
fi

echo
echo "完成。"
echo "  Node:   $(node -v)"
echo "  Python: $(python3 -V)"
echo "  用户:   ${APP_USER}"
echo "  数据:   ${DATA_DIR}"
echo "  日志:   ${LOG_DIR}"
echo
echo "下一步："
echo "  1. 确认代码已同步到 ${APP_DIR}"
echo "  2. 在本地构建前端：cd code/frontend && npm ci && npm run build"
echo "  3. 继续看 deploy/README.md 第 4 节"
