#!/usr/bin/env bash
# 在服务器上安装/重启 Agent（由 deploy/release.sh --agent 调用，也可单独运行）
#
# 用法：sudo bash /opt/liteoffice/deploy/setup-agent.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/liteoffice}"
AGENT_DIR="${APP_DIR}/code/agent"
ENV_FILE="/etc/liteoffice/agent.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 或 sudo 运行" >&2
  exit 1
fi

cd "${AGENT_DIR}"

echo "==> 创建 Python venv（已存在则复用）"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi

echo "==> 安装线上依赖（不含 torch / 本地大模型）"
.venv/bin/pip install -r requirements.txt

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> 生成 ${ENV_FILE}"
  mkdir -p /etc/liteoffice
  install -m 600 "${APP_DIR}/deploy/agent.env.example" "${ENV_FILE}"
  echo "已生成模板；如需真实 AI，编辑 ${ENV_FILE} 填入 DEEPSEEK_API_KEY"
  echo "留空则进入 mock 模式，不联网、不花钱。"
fi

echo "==> 安装 systemd unit"
cp "${APP_DIR}/deploy/systemd/liteoffice-agent.service" /etc/systemd/system/

echo "==> 修正权限"
chown -R liteoffice:liteoffice "${AGENT_DIR}"

echo "==> 启动 Agent"
systemctl daemon-reload
systemctl enable liteoffice-agent
systemctl restart liteoffice-agent

echo "==> 健康检查"
ok=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "${ok}" -eq 1 ]]; then
  echo "Agent 已就绪：http://127.0.0.1:8100/health"
else
  echo "Agent 健康检查失败，最近日志：" >&2
  journalctl -u liteoffice-agent -n 30 --no-pager >&2 || true
  exit 1
fi
