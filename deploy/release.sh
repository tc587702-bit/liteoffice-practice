#!/usr/bin/env bash
# LiteOffice 一键构建 + 部署脚本（在本地 Mac/Linux 仓库根目录运行）
#
# 用法：
#   SERVER=root@1.2.3.4 bash deploy/release.sh             # 日常更新
#   SERVER=root@1.2.3.4 bash deploy/release.sh --init      # 首次部署
#   SERVER=root@1.2.3.4 bash deploy/release.sh --agent     # 只装/重启 Agent
#   SERVER=root@1.2.3.4 bash deploy/release.sh --init --agent
#   SERVER=root@1.2.3.4 SSH_PORT=2222 bash deploy/release.sh
#
# 脚本会：
#   1. 本地 npm ci + npm run build（不要在 1.6G 小机器上 build）
#   2. rsync 代码、dist、Agent 知识库/模型到服务器
#   3. 同步 systemd unit
#   4. 首次部署时跑 setup-server.sh（Node/Python/swap/初始 KB）
#   5. 服务器上装后端依赖并重启服务
#   6. 需要时安装并重启 Agent

set -euo pipefail

INIT=0
AGENT=0
for arg in "$@"; do
  case "${arg}" in
    --init) INIT=1 ;;
    --agent) AGENT=1 ;;
    -h|--help)
      cat <<'USAGE'
用法：
  SERVER=root@1.2.3.4 bash deploy/release.sh             # 日常更新
  SERVER=root@1.2.3.4 bash deploy/release.sh --init      # 首次部署
  SERVER=root@1.2.3.4 bash deploy/release.sh --agent     # 只装/重启 Agent
  SERVER=root@1.2.3.4 bash deploy/release.sh --init --agent
  SERVER=root@1.2.3.4 SSH_PORT=2222 bash deploy/release.sh
USAGE
      exit 0
      ;;
    *)
      echo "未知参数：${arg}" >&2
      echo "可用参数：--init  --agent" >&2
      exit 1
      ;;
  esac
done

: "${SERVER:?请设置 SERVER，例如：SERVER=root@1.2.3.4 bash deploy/release.sh --init}"

APP_DIR="${APP_DIR:-/opt/liteoffice}"
SSH_PORT="${SSH_PORT:-22}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 本地构建前端"
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

echo "==> 同步 systemd unit"
scp -P "${SSH_PORT}" "${ROOT_DIR}/deploy/systemd/"*.service \
  "${SERVER}:/etc/systemd/system/"

if [[ "${INIT}" -eq 1 ]]; then
  echo "==> 首次初始化服务器（Node/Python/swap/初始知识库）"
  # 必须先初始化：liteoffice 用户由 setup-server.sh 创建，后面才能 chown
  ssh -p "${SSH_PORT}" "${SERVER}" "bash '${APP_DIR}/deploy/setup-server.sh'"
fi

echo "==> 修正代码权限"
ssh -p "${SSH_PORT}" "${SERVER}" \
  "chmod -R a+rX '${APP_DIR}' && chown -R liteoffice:liteoffice '${APP_DIR}'"

if ! ssh -p "${SSH_PORT}" "${SERVER}" 'command -v node >/dev/null 2>&1'; then
  echo "服务器还没有 Node。请先运行：SERVER=${SERVER} bash deploy/release.sh --init" >&2
  exit 1
fi

echo "==> 安装后端依赖并重启"
ssh -p "${SSH_PORT}" "${SERVER}" bash -s <<EOF
set -e
cd '${APP_DIR}/code/backend'
npm ci --omit=dev
systemctl daemon-reload
systemctl enable liteoffice-backend
systemctl restart liteoffice-backend
systemctl --no-pager --lines=5 status liteoffice-backend || true
EOF

if [[ "${AGENT}" -eq 1 ]]; then
  echo "==> 安装/重启 Agent"
  ssh -p "${SSH_PORT}" "${SERVER}" "bash '${APP_DIR}/deploy/setup-agent.sh'"
fi

echo
echo "完成。访问：http://${SERVER#*@}:3000/"
echo "如果打不开，先看 deploy/README.md 第 9 节排障。"
