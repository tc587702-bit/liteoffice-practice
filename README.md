# LiteOffice

> 本地优先、可离线使用的轻量文档工作台。桌面版（Tauri）是主场，Web 是第二入口，AI 是可选助手。
>
> 目标格式：`.docx / .xlsx / .pptx / .pdf / .md`，同一套外壳、同一套快捷键、同一套状态栏。

**当前进度（Day 1）**：外壳骨架 + md 闭环（打开 / 编辑 / 保存）已通；Office 格式待 Day 2 接入 ONLYOFFICE。

## 运行（零构建，不需要 npm 依赖）

```bash
# 任选一种起静态服务（不要直接双击 index.html，file:// 下模块加载会被浏览器拦）
pnpm serve
# 或
python3 -m http.server 5191 --directory code/frontend

# 浏览器打开
open http://127.0.0.1:5191
```

只有构建**桌面版**时才需要 Rust（`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm serve` | 起静态服务器（5191 端口） |
| `bash bootstrap.sh` | 检查 Node 版本、拉取 Office 内核产物（Day 2 起需要） |
| `bash bootstrap.sh --no-engine` | 同上，跳过 342 MB 内核产物 |
| `pnpm engine` | 单独拉取 Office 内核产物 |

## 目录

```text
code/frontend    零构建前端：index.html + styles/ + js/（core 会话与文件通道、shell 界面、views 视图）
code/core_engine Office 内核产物拉取脚本、onlyoffice.html、字体替换工具
code/backend     本期无后端（本地优先，刻意不加服务端）
tests/           单测与多格式回归
docs/            需求、架构、代码导读、进度、复盘
```

刚接手的队友先读 **[docs/software/skeleton-walkthrough.md](docs/software/skeleton-walkthrough.md)**（20 分钟看懂主干）。
目录归属见 [docs/software/repo_layout.md](docs/software/repo_layout.md)。

## 环境约定

- Node **20.x**（`.nvmrc`）；pnpm **12.15.0**（`package.json` 的 `packageManager`，由 corepack 获取）
- 前端**没有 npm 依赖**，用浏览器原生 ES module，改完刷新即可
- Rust 版本见 `rust-toolchain.toml`，首次 `cargo build` 成功后钉到具体版本

## 架构（一句话）

```text
main.js 改 state → refresh() → 各视图重画
main.js 调 session（文档）和 fileProvider（文件），二者互不知道对方
```

接口契约见 `code/frontend/js/core/types.js`，改它必须全员同步。

## 合规声明

- 本项目基于 ONLYOFFICE 社区版产物（经 `OnlyofficePersonal` 封装，AGPL-3.0）。
- **ONLYOFFICE 是 Ascensio System SIA 的商标。** 本项目与 ONLYOFFICE 官方无关。
- 内核产物含商业字体，**不进入本仓库、不发布到公网静态站**（见规划 6.3）。
- LiteOffice 为团队自创名称。

## 已知边界

- **Web 端"保存" = 下载**（浏览器不能静默写回磁盘）；桌面端才写回原文件。
- md 目前用 `textarea` 编辑，**还不能导出 PDF**（需要渲染视图，Day 2–3 补）。
- 最近打开列表尚未实现（见 `js/core/recents.js` 的 4 个 TODO）。
- PDF 只读浏览，不做内容编辑。
