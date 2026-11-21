# LiteOffice 部署手册（IP 直连版）

适用于：阿里云 / 腾讯云 **轻量应用服务器**，Ubuntu 24.04，**没有域名**，直接用
`http://公网IP:3000` 访问。

> 这套配置不需要备案、不需要 HTTPS 证书、不需要 Caddy（可选）。
> 后端会在 3000 端口同时提供前端静态文件、分享页、WebSocket 和 `/agent/*` 代理。

---

## 0. 先做三件事

1. 在轻量服务器控制台的 **防火墙** 里放行：
   - `22/tcp`（SSH）
   - `3000/tcp`（应用）
   - 如果以后想用 80 端口，再放行 `80/tcp`
2. 确认你能 SSH 登录：
   ```bash
   ssh root@你的公网IP
   ```
3. 确认服务器是 Ubuntu 24.04：
   ```bash
   cat /etc/os-release
   ```

> 如果买的是 Alibaba Cloud Linux / CentOS，本文的 `apt` 要换成 `dnf`，其余步骤基本一致。

> 下文所有 `root@你的公网IP` 都假设你用 root 登录（轻量默认如此）。
> 如果你用的是普通用户，请给该用户配置免密 sudo，或把命令前加上 `sudo`。

---

## 最短路径（赶时间看这里）

```bash
# 1. 轻量防火墙放行 22、3000

# 2. 本地：先构建前端（生成 dist/）
cd code/frontend && npm ci && npm run build && cd ../..

# 3. 本地：上传代码（包含 dist）
ssh root@IP 'mkdir -p /opt/liteoffice'
rsync -avz --exclude node_modules --exclude .git --exclude .venv \
  --exclude data --exclude logs --exclude '*.log' \
  ./ root@IP:/opt/liteoffice/

# 4. 服务器：初始化运行时
ssh root@IP 'bash /opt/liteoffice/deploy/setup-server.sh'

# 5. 服务器：装依赖 + 启服务
ssh root@IP 'cd /opt/liteoffice/code/backend && npm ci --omit=dev'
scp deploy/systemd/*.service root@IP:/etc/systemd/system/
ssh root@IP 'chown -R liteoffice:liteoffice /opt/liteoffice && \
  chmod -R a+rX /opt/liteoffice && \
  systemctl daemon-reload && systemctl enable --now liteoffice-backend'

# 6. 浏览器打开
# http://IP:3000/
```

后面的章节是每一步的详细说明和排障。

---

## 1. 上传代码

在**你自己的电脑**（仓库根目录）执行：

```bash
# 先在服务器建目录（只需一次）
ssh root@你的公网IP 'mkdir -p /opt/liteoffice'

# 同步代码（排除依赖、运行时数据、日志）
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude 'data' \
  --exclude 'logs' \
  --exclude '*.log' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  ./ root@你的公网IP:/opt/liteoffice/
```

如果服务器没有 `rsync`：

```bash
ssh root@你的公网IP 'apt-get update && apt-get install -y rsync'
```

> 也可以先在服务器 `git clone`，但仓库是私有的，需要配置 Deploy Key；
> 用 `rsync` 最省事。

---

## 2. 服务器初始化

```bash
ssh root@你的公网IP
bash /opt/liteoffice/deploy/setup-server.sh
```

这个脚本会：

- 安装 `curl`、`git`、`rsync`、`python3`、`python3-venv`；
- 安装 **Node.js 24**（`node:sqlite` 需要 Node 22.13+）；
- 创建系统用户 `liteoffice`；
- 创建 `/var/lib/liteoffice`（SQLite）和 `/var/log/liteoffice`（日志）；
- 如果服务器没有 swap，创建 2G swap。

---

## 3. 构建前端（在本机做，别在 2G 小机器上 build）

```bash
cd code/frontend
npm ci
npm run build
```

构建产物在 `code/frontend/dist/`。后端启动时会自动托管这个目录。

> 如果你在第 1 节上传代码时还没有 `dist/`，构建完再补传一次：
> ```bash
> rsync -avz code/frontend/dist/ root@你的公网IP:/opt/liteoffice/code/frontend/dist/
> ```
>
> 每次改前端都要重新 build，然后重新同步一次。用第 8 节的 `release.sh` 可以一步完成。

---

## 4. 安装后端依赖

```bash
ssh root@你的公网IP
cd /opt/liteoffice/code/backend
npm ci --omit=dev
```

后端只有 `ws`、`yjs`、`y-protocols` 三个依赖，很快。

---

## 5. 安装 Agent（可选）

如果暂时不演示 AI，可以跳过；跳过时后端仍能正常提供编辑器和分享页，
只是 `/agent/*` 会返回 502。

```bash
ssh root@你的公网IP
cd /opt/liteoffice/code/agent

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 配置环境变量
cp /opt/liteoffice/deploy/agent.env.example /etc/liteoffice/agent.env
chmod 600 /etc/liteoffice/agent.env
vi /etc/liteoffice/agent.env
```

`agent.env` 里：

- `DEEPSEEK_API_KEY` 留空 → 自动进入 mock 模式，不联网、不花钱；
- 填真实 Key → 调 DeepSeek；注意账户余额和调用费用；
- `LITEOFFICE_ADMIN_TOKEN` 建议改成一串随机字符，防止别人写知识库。

---

## 6. 配置 systemd

```bash
ssh root@你的公网IP
cd /opt/liteoffice

cp deploy/systemd/liteoffice-backend.service /etc/systemd/system/
cp deploy/systemd/liteoffice-agent.service /etc/systemd/system/

# 让服务用户能读代码、写数据
chown -R liteoffice:liteoffice /opt/liteoffice
chmod -R a+rX /opt/liteoffice

systemctl daemon-reload
systemctl enable --now liteoffice-backend

# 只有装了 Agent 才执行
systemctl enable --now liteoffice-agent
```

> 如果 Agent 的 venv 还没建好，`liteoffice-agent` 会启动失败，先跳过后面的
> `systemctl enable`。

---

## 7. 验证

### 服务器本机

```bash
curl -s http://127.0.0.1:3000/ | head
curl -s http://127.0.0.1:3000/agent/health
```

后端日志里应该看到：

```bash
journalctl -u liteoffice-backend -n 20 --no-pager
# 或
tail -f /var/log/liteoffice/backend.log
```

关键一行是 `distExists:true`，说明前端构建产物被找到了。

### 外部访问

手机 4G 或另一台电脑打开：

```
http://你的公网IP:3000/
```

### 测试分享链接

```bash
# 1. 上传一个文档
curl -s -X POST http://你的公网IP:3000/api/docs \
  -H 'content-type: application/json' \
  -d '{"title":"演示文档","kind":"md","html":"<h1>Hello LiteOffice</h1>"}'

# 2. 用返回的 id 生成分享链接
curl -s -X POST http://你的公网IP:3000/api/docs/<id>/share \
  -H 'content-type: application/json' \
  -d '{"role":"edit"}'
```

返回的 `url` 就是 `http://你的公网IP:3000/d/<token>`，可以直接发给同学。

---

## 8. 日常更新

改完代码后，在本地仓库根目录：

```bash
SERVER=root@你的公网IP bash deploy/release.sh
```

它会：

1. 本地 build 前端；
2. rsync 到服务器；
3. 安装后端依赖；
4. 重启 `liteoffice-backend`；
5. 如果 Agent 的 venv 存在，顺带重启 `liteoffice-agent`。

想指定 SSH 端口：

```bash
SERVER=root@你的公网IP SSH_PORT=2222 bash deploy/release.sh
```

---

## 9. 日志与排障

```bash
# 实时日志
journalctl -u liteoffice-backend -f
journalctl -u liteoffice-agent -f

# 落盘日志
tail -f /var/log/liteoffice/backend.log
tail -f /var/log/liteoffice/agent.log

# 端口监听
ss -lntp | grep -E '3000|8100'
```

### 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器打不开 `IP:3000` | 轻量防火墙没放行 3000 | 控制台加规则 `3000/tcp` |
| 能打开但页面 404 | `dist` 没上传或没 build | 本地 `npm run build` 后重传 |
| 页面能开，分享链接 502 | 后端没起来 | `systemctl status liteoffice-backend` |
| `/agent/health` 502 | Agent 没装/没起来 | `systemctl status liteoffice-agent` |
| 启动报 `node:sqlite` | Node 版本太低 | `node -v` 确认 ≥ 22.13 |
| `free -h` 总内存只有 1.6G | 2G 是标称值，扣掉内核保留后正常 | 看 `available` 列，并确认 swap 已挂载 |
| 内存不足 / 进程被杀 | 1.6G 可用内存跑 Agent 偏紧 | 按脚本加 2G swap；先不装 Agent；看 `dmesg \| grep -i oom` |
| 分享链接是 `http://` | 当前就是 IP + HTTP | 正常，不需要改 |
| 端口 80 打不开 | 大陆机房未备案 80 可能被拦 | 继续用 3000，别折腾 |

---

## 10. 可选：用 Caddy 占 80 端口

如果你想让地址变成 `http://公网IP/`（不带 `:3000`），可以装 Caddy：

```bash
apt-get install -y caddy
cp /opt/liteoffice/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

然后放行轻量防火墙的 `80/tcp`，访问 `http://公网IP/`。

Caddy 会自动处理 WebSocket；这个配置**不启用 HTTPS**，因为裸 IP 拿不到受信任证书。

---

## 11. 安全提醒

- 这是课程演示配置：**没有账号体系**，拿到 edit 分享链接的人都能改文档。
- 不要把 `DEEPSEEK_API_KEY` 写进代码或提交到 Git；只放 `/etc/liteoffice/agent.env`。
- 不要把 `8100` 暴露到公网；Agent 只监听 `127.0.0.1`。
- 上传上限 30MB；演示结束可以清空 `code/backend/data/` 或整个数据库。
- 纯 HTTP 是明文传输，别传真实隐私文件。

---

## 12. 备份与重置

```bash
# 备份 SQLite（WAL 模式，不能直接 cp）
sqlite3 /var/lib/liteoffice/liteoffice.db \
  ".backup '/var/backups/liteoffice-$(date +%F).db'"

# 重置演示数据（谨慎）
systemctl stop liteoffice-backend
rm -f /var/lib/liteoffice/liteoffice.db*
systemctl start liteoffice-backend
```
