# LiteOffice

**在浏览器里打开、预览、编辑 Office 文档。** 核心功能全程本地完成，文件不上传；
另附可选的协作后端与 AI Agent 服务，按需启动。

> 软件实践课程小组项目。前端是默认入口，`code/backend/` 与 `code/agent/` 是可选服务，
> 三者可独立运行，当前代码尚未互相接线（见「已知限制」）。

---

## 项目概况

| 工程 | 目录 | 技术栈 | 作用 |
|---|---|---|---|
| 前端 | `code/frontend/` | Vue 3 + Vite + TypeScript + Pinia + Tailwind | 解析、预览、编辑、导出，离线可用 |
| 协作后端 | `code/backend/` | Node.js + 原生 `http` / `ws` + Yjs + `node:sqlite` | 分享链接、Yjs 增量同步、在线人数 |
| Agent 服务 | `code/agent/` | Python + FastAPI + LangGraph + LiteLLM | 文档工具、编排、BM25 知识库 |

---

## 能力矩阵

| 格式 | 打开 | 编辑 | 导出 |
|---|---|---|---|
| **docx** | ✅ 标题 / 段落 / 表格 / 图片 / 编号列表 | ✅ 富文本 | ✅ 回写 OOXML |
| **xlsx** | ✅ 多工作表 | ✅ 单元格 | ✅ 回写（保留表名） |
| **md** | ✅ 标题 / 列表 / 代码块 / 表格 | ✅ | ✅ Markdown / 文本 |
| **pdf** | ✅ 文本层 + canvas 渲染 | ❌ 只读 | 原始文件 / 文本副本 |
| **pptx** | ✅ 文本抽取 | ❌ 只读 | 原始文件 / 文本副本 |

编辑能力不依赖 ONLYOFFICE：由 `contenteditable` + 自研 OOXML 解析/回写实现，
代价是复杂排版保真度低于专业内核。

---

## 架构

```
┌──────────────────────────────────────────────┐
│ 前端 code/frontend（Vue 3 + Vite）            │
│ 解析 / 渲染 / 编辑 / 导出，全程本地，可断网     │
└───────────────┬──────────────────────────────┘
                │ 部署时可被后端托管 dist
                ▼
┌──────────────────────────────┐        ┌───────────────────────────────┐
│ 协作后端 code/backend（Node） │        │ Agent 服务 code/agent（Python）│
│ 分享链接 / Yjs 同步 / 消毒     │        │ 工具 / LangGraph / LiteLLM / KB│
│ SQLite: liteoffice.db        │        │ SQLite: kb.db                 │
└──────────────────────────────┘        └───────────────────────────────┘
```

- 前端构建产物是纯静态文件，可由任意静态服务器托管，也可由后端在 3000 端口一并托管。
- 后端提供 `/agent/*` 反向代理，指向 Agent 的 8100 端口。
- 前端目前没有调用后端或 Agent 的代码；协作与 AI 能力以独立服务的形式提供与验证。

---

## 目录结构

```
liteoffice-git/
├── code/
│   ├── frontend/              Vue 3 单页应用
│   │   ├── src/
│   │   │   ├── pages/         Home / Editor
│   │   │   ├── components/    app / editor / ui
│   │   │   ├── stores/        Pinia workspace
│   │   │   ├── lib/           docx / xlsx / pdf / md / zip / xml / db / exporter …
│   │   │   └── router/         hash 路由
│   │   ├── scripts/           端到端验收脚本
│   │   └── tools/             测试素材生成、工具一致性检查
│   ├── backend/
│   │   ├── server/            HTTP / WebSocket / SQLite / 消毒
│   │   └── public/d.html      分享页
│   └── agent/
│       └── app/               FastAPI / LangGraph / 工具 / 知识库
├── docs/
│   ├── requirements/          需求工程（FR / NFR / US / 问题定义）
│   ├── mgmt/                  沟通、风险、GitHub Projects
│   ├── assignments/           三次课程作业
│   ├── software/              结构、代码地图、Agent / RAG 设计、审查报告
│   └── prototype/             冻结的交互原型（只读设计基准）
├── tests/                     测试占位（尚未落地）
├── tools/                     仓库级脚本
└── .github/workflows/         CI 占位
```

每个文件的职责见 **[项目结构说明](docs/software/project-structure.md)**。

---

## 快速开始

### 环境要求

- Node.js **22+**（后端使用内置 `node:sqlite`）
- Python **3.10+**（仅 Agent 服务需要）

### 1. 前端（默认，离线可用）

```bash
cd code/frontend
npm install
npm run dev          # http://localhost:5173/
npm run typecheck    # vue-tsc --noEmit
npm run build        # 类型检查 + 生产构建，产物在 dist/
```

无需后端、无需环境变量。

### 2. 协作后端（可选）

```bash
cd code/backend
npm install
npm start            # http://localhost:3000
npm run smoke        # 另开终端，端到端自检（需服务已启动）
```

- 数据库自动创建在 `code/backend/data/liteoffice.db`，可用 `LITEOFFICE_DB` 覆盖。
- 若已执行前端 `npm run build`，后端会同时托管 `code/frontend/dist`，只开 3000 端口即可。

### 3. Agent 服务（可选）

```bash
cd code/agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8100
python -m app.test_kb     # 另开终端，知识库自检
```

- 默认模型 `deepseek/deepseek-chat`，可用 `LITEOFFICE_MODEL` 覆盖。
- 未配置 `DEEPSEEK_API_KEY` 等凭据时自动进入 mock 模式，流程不阻塞。
- 环境变量需由 shell 导出；项目没有内置 `.env` 自动加载。
- 后端已把 `/agent/*` 代理到 8100，也可直接访问 `http://localhost:8100/docs`。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端框架 | Vue 3（`<script setup lang="ts">`）+ Vite + TypeScript |
| 路由 / 状态 | vue-router（hash）+ Pinia |
| 样式 | TailwindCSS + 冻结深色令牌（纯黑底、24px 卡片、内联 SVG 图标） |
| 文档解析 | 自研 OOXML：`docx.ts` / `xlsx.ts` / `zip.ts` / `xml.ts` / `markdown.ts` |
| PDF | `pdfjs-dist`（worker 由 Vite 本地打包，不依赖 CDN） |
| 本地持久化 | IndexedDB（会话与编辑内容，刷新可恢复） |
| 后端 | Node 原生 `http` + `ws` + `yjs` / `y-protocols` + `node:sqlite` |
| Agent | FastAPI + LangGraph + LiteLLM + SQLite（BM25 检索） |

前端运行时依赖只有 5 个：`vue`、`vue-router`、`pinia`、`xlsx`、`pdfjs-dist`；
没有 UI 组件库、图标库、动画库。

---

## 接口速览

**协作后端**

| 方法 | 路径 | 作用 |
|---|---|---|
| POST / GET | `/api/docs` | 上传文档 / 文档列表 |
| GET | `/api/docs/:id` | 读取文档 |
| POST | `/api/docs/:id/share` | 生成分享链接（view / edit） |
| GET / POST | `/api/share/:token` `/revoke` | 按链接读取 / 撤销 |
| GET | `/d/:token` | 分享页 |
| WS | `/ws?token=...` | Yjs 同步 + 在线人数 |

**Agent 服务**

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/tools` | 工具清单 |
| POST | `/v1/tools/{name}` | 直接调用工具 |
| POST | `/v1/agent/run` | LangGraph 编排 |
| POST | `/v1/chat` | 纯对话 |
| GET | `/v1/llm/info` | 模型配置 |
| POST | `/v1/kb/{id}/documents` `/search` `/evidence` | 知识库入库 / 检索 / 改写素材 |

完整路由与参数见 [项目结构说明](docs/software/project-structure.md)。

---

## 设计原则

1. **本地优先**：默认场景零上传、零网络请求；外部服务必须显式启动。
2. **失败要说话**：PDF 无文字层、扫描件、格式不支持、内存不足都给出明确提示，
   并保留「下载原始文件」的出口，不静默产出不符的文件。
3. **依赖收敛**：能自己写的解析器不引第三方；不为了一个图标或动画引入整库。
4. **原型冻结**：`docs/software/prototype/` 是设计基准，代码向它对齐，不反向修改。
5. **可访问性兜底**：错误边界、进度反馈、`prefers-reduced-motion`、ARIA 标记。

---

## 已知限制

- **前端与后端 / Agent 尚未接线**：当前前端不发起任何 `fetch` / WebSocket 请求，
  协作与 AI 能力需直接使用对应服务的接口。
- **分享页编辑未绑定 Yjs**：服务端已实现 Yjs 同步协议并通过冒烟测试，
  但 `public/d.html` 的可编辑模式只开了 `contenteditable`，改动不会实时同步。
- **PDF 只读**，扫描件无文字层时不支持 OCR，会明确提示。
- **pptx / pdf 无法回写**，导出只提供原始文件或文本副本。
- **docx 导出是 HTML 重建**：分栏、文本框、页眉页脚等复杂排版会丢失。
- **大文件不截断**：超过 64 MB 会提示内存风险，超过 128 MB 直接停止解析并允许下载原文件。
- **协作后端没有账号体系**：链接即权限，拿到 edit 链接即可编辑；适合演示，不适合生产。
- **手机窄屏未做自适应**。
- **`tests/` 为空、无 CI**：现有检查是各服务内的脚本，需手动执行。
- **仓库暂未附带 LICENSE 文件**，默认保留所有权利；第三方组件遵循其自身许可。

---

## 文档

| 文档 | 内容 |
|---|---|
| [项目结构说明](docs/software/project-structure.md) | 三个服务、逐文件职责、依赖方向、配置、改动落点 |
| [代码职责地图](docs/software/code-map.md) | 最复杂的五处代码与三条数据流 |
| [Agent 架构](docs/software/agent-architecture.md) | 分层、工具清单、隐私与落地分级 |
| [RAG 设计](docs/software/rag-design.md) | 切块、混合检索、引用定位 |
| [代码审查报告](docs/software/review-report.md) | 自动审查结果与规模统计 |
| [文档索引](docs/README.md) | 全部文档导航与阅读顺序 |
| [问题定义](docs/requirements/problem_definition.md) | 5W1H：为什么做、给谁用 |
| [功能需求规范](docs/requirements/functional_spec.md) | `FR-*`、追溯矩阵、验收场景 |
| [非功能需求规范](docs/requirements/nonfunctional_spec.md) | `NFR-*` 指标与实测值 |
| [用户故事](docs/requirements/user_stories.md) | `US-*` / `AC-*`、INVEST 自检 |
| [风险管理计划](docs/mgmt/risk_mgmt_plan.md) | 风险登记册与应急预案 |

---

## 验证与自检

```bash
# 前端
cd code/frontend
npm run typecheck
node tools/check-agent-tools.mjs          # 7 个本地工具一致性
node scripts/check-docx-export.mjs x.docx # 需先准备输入文件
node scripts/check-large-file.mjs ...     # 需先用 tools/gen-large-fixtures.mjs 生成素材
node scripts/check-pdf.mjs x.pdf

# 后端
cd code/backend
node server/test-db-seq.mjs               # 序号单调 + HTML 消毒（临时库）
npm run smoke                             # 端到端（需先 npm start）

# Agent
cd code/agent
python -m app.test_kb                     # 知识库自检（无需模型与网络）
```

---

## 参与与约定

- 需求变更先改 `docs/requirements/`，保持 `FR-*` 可追溯。
- 前端新增依赖前先问「能不能自研」；当前没有 UI / 图标 / 动画库。
- 中文文件不要用 shell 的 `cat` / `echo` 往返读写，会损坏编码。
- 提交信息建议使用 `feat(scope):` / `fix(scope):` / `docs:` 前缀。

---

## AI 参与说明

**本项目代码与文档由 AI 辅助生成**，人工负责需求提出、取舍决策、验收测试与问题定位。

- 前端实现：AI 生成（Vue 3 工程），人工验收（构建、类型检查、真实文件解析实测）
- 协作后端与 Agent：AI 生成，人工补充测试与边界修正
- 设计原型：墨刀 AI 生成，含「豆包AI」标识，按要求保留
- 文档：AI 起草，人工补充实测数据与风险项

如需在课程/公开场合展示，请如实说明上述参与方式。

---

## 许可

仓库暂未附带 `LICENSE` 文件。第三方组件遵循其自身许可：
`pdfjs-dist` Apache-2.0、`xlsx` Apache-2.0、Vue MIT、`yjs` MIT。
