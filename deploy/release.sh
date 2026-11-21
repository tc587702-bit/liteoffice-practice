#!/usr/bin/env bash
# LiteOffice 一键发布脚本（在本地 Mac/Linux 仓库根目录运行）
#
# 用法：
#   SERVER=root@1.2.3.4 bash deploy/release.sh
#   SERVER=root@1.2.3.4 SSH_PORT=2222 bash deploy/release.sh
#
# 做四件事：
#   1. 本地构建前端
#   2. rsync 同步到服务器
#   3. 安装后端依赖
#   4. 重启 systemd 服务

set -euo pipefail

: "${SERVER:?请设置 SERVER，例如：SERVER=root@1.2.3.4 bash deploy/release.sh}"

APP_DIR="${APP_DIR:-/opt/liteoffice}"
SSH_PORT="${SSH_PORT:-22}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 构建前端"
(
  cd "${ROOT_DIR}/code/frontend"
  npm ci
  npm run build
)

echo "==> 同步代码到 ${SERVER}:${APP_DIR}"
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude '.tmp' \
  --exclude 'code/backend/data' \
  --exclude 'code/agent/data/feedback.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude 'logs' \
  --exclude '*.log' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  -e "ssh -p ${SSH_PORT}" \
  "${ROOT_DIR}/" "${SERVER}:${APP_DIR}/"

echo "==> 修正权限（避免本地 600 文件导致服务读不到）"
ssh -p "${SSH_PORT}" "${SERVER}" \
  "chmod -R a+rX '${APP_DIR}' && chown -R liteoffice:liteoffice '${APP_DIR}'"

echo "==> 安装后端依赖并重启"
ssh -p "${SSH_PORT}" "${SERVER}" bash -s <<EOF
set -e
cd '${APP_DIR}/code/backend'
npm ci --omit=dev

systemctl restart liteoffice-backend
if [ -f /etc/systemd/system/liteoffice-agent.service ] \
   && [ -x '${APP_DIR}/code/agent/.venv/bin/uvicorn' ]; then
  systemctl restart liteoffice-agent
fi

systemctl --no-pager --lines=5 status liteoffice-backend || true
EOF

echo
echo "完成。访问：http://${SERVER#*@}:3000/"
echo "如果打不开，先看 deploy/README.md 第 9 节排障。"
