# LiteOffice 项目结构说明

| 项目 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-11-07 |
| 适用代码 | `995b3ac` 之后的仓库现状 |
| 用途 | 回答「仓库里有什么、每个文件负责什么、改东西该动哪里」 |
| 配套文档 | [代码职责地图](code-map.md)、[Agent 架构](agent-architecture.md)、[RAG 设计](rag-design.md)、[代码审查报告](review-report.md) |

> v1.1 变化：补充**前端与后端每个文件**的详细职责、关键导出与注意事项。
> 算法实现细节仍以 [code-map.md](code-map.md) 为准，本文侧重「文件级地图」。

---

## 一、一句话概括

LiteOffice 是一个仓库、三个可独立运行的服务：

```
浏览器端（离线可用）         Node 协作后端            Python Agent 服务
Vue 3 + Vite                 分享链接 / Yjs 同步      工具 / LangGraph / 知识库
code/frontend      ←─部署时─→  code/backend     ←─代理─→  code/agent
```

- **前端**：文档解析、渲染、编辑、导出全部在浏览器完成，文件不上传。
- **后端**：可选的协作能力（分享页、Yjs 增量同步、在线状态），单文件 SQLite 持久化。
- **Agent**：可选的 AI 能力（7 个文档工具、LangGraph 编排、BM25 知识库、LiteLLM 多模型调用）。

三者代码上互不 import，只通过 HTTP / WebSocket 约定交互；前端当前可完全离线单跑。

---

## 二、顶层目录

```
liteoffice-git/
├── code/                     三个可独立运行的服务
│   ├── frontend/             Vue 3 单页应用（唯一有构建产物的服务）
│   ├── backend/              Node 协作后端（分享 / Yjs / SQLite）
│   └── agent/                Python Agent 服务（FastAPI / LangGraph / KB）
├── docs/                     课程作业、需求、管理与设计文档
├── tests/                    测试占位目录（尚未落地）
├── tools/                    仓库级脚本（同步、自动审查）
├── .github/workflows/        CI 占位（当前只有 .gitkeep）
├── README.md                 项目门面：定位、快速开始、能力边界
└── .gitignore                忽略 node_modules / dist / 本地数据库等
```

根目录**没有** `package.json`，不存在 workspace 编排；每个服务各自安装依赖、各自启动。

---

## 三、`code/frontend/` —— Vue 3 前端

### 3.1 分层

```
pages（页面）
   ↓
stores（Pinia 会话状态）
   ↓
lib（纯逻辑：解析 / 导出 / 存储 / 工具）
   ↑
components（只消费状态与回调，不直接调解析器）
```

依赖方向单向；`lib` 内部按底层到高层引用：

```
zip.ts / xml.ts  ←  docx.ts / xlsx.ts / markdown.ts  ←  exporter.ts
                         ↑
                    file.ts（格式识别）
pdf.ts ← pdfjs-dist；parseClient.ts → workers/*
```

### 3.2 目录树

```
code/frontend/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── package.json
├── package-lock.json
├── README.md
├── public/                   # 空目录，不依赖外链 CDN
├── scripts/
│   ├── check-docx-export.mjs
│   ├── check-large-file.mjs
│   └── check-pdf.mjs
├── tools/
│   ├── check-agent-tools.mjs
│   ├── gen-large-fixtures.mjs
│   └── gen_large_pdf_docx.py
└── src/
    ├── main.ts
    ├── App.vue
    ├── index.css
    ├── router/index.ts
    ├── pages/Home.vue  pages/Editor.vue
    ├── stores/workspace.ts
    ├── components/
    │   ├── app/（8 个）
    │   ├── editor/（3 个）
    │   └── ui/（6 个 + iconRegistry.ts）
    ├── lib/（12 个 + agent/tools.ts + workers/2 个）
    └── types/sheetjs.d.ts
```

> `dist/`、`node_modules/` 是本地构建与依赖目录，已被 `.gitignore` 忽略，不在下文的「源文件」范围内。

### 3.3 前端逐文件说明

#### 3.3.1 根目录与构建配置

| 文件 | 职责 | 关键点 |
|---|---|---|
| `index.html` | 唯一 HTML 入口 | `lang="zh-CN"`；`#app` 挂载点；引入 `/src/main.ts`；含 title / description / theme-color 元信息 |
| `package.json` | 依赖与脚本 | `dev` / `build`（先 `vue-tsc` 再 `vite build`）/ `preview` / `typecheck`；运行时 5 个依赖，开发时 7 个 |
| `package-lock.json` | 依赖锁文件 | 锁定实际安装版本，保证构建可复现 |
| `vite.config.ts` | Vite 配置 | 只启用 `@vitejs/plugin-vue`；`base: './'` 让产物可部署到任意子路径 |
| `tsconfig.json` | TypeScript 配置 | `strict`、`noUnusedLocals`、`noUnusedParameters`、`noEmit`；检查 `src/**/*.{ts,d.ts,vue}` |
| `tailwind.config.js` | Tailwind 配置 | `content` 覆盖 `index.html` 与 `src/**/*.{vue,ts}`；扩展冻结色板（ink/card/accent 等）与 24px 卡片圆角 |
| `postcss.config.js` | PostCSS 配置 | 只挂 `tailwindcss` 与 `autoprefixer` |
| `README.md` | 前端工程说明 | 常用命令、目录结构、设计冻结值（颜色/圆角/阴影）、依赖与已知边界 |
| `public/` | 静态资源目录 | 当前为空；项目刻意不使用 CDN，所有资源随包构建 |

#### 3.3.2 应用骨架

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/main.ts` | 应用启动 | `createApp(App).use(createPinia()).use(router).mount('#app')`，并引入全局样式 |
| `src/App.vue` | 根组件 / 外壳 | 组合 `ErrorBoundary` → `FileDropProvider` → `RouterView`；挂载全局的 `ImportProgress`、`Toaster`、`ConfirmDialog`、`FatalDialog`；渲染 `.lo-ambient` 背景光晕 |
| `src/index.css` | 全局样式 | Tailwind 三层指令；深色设计令牌（CSS 变量）；`.lo-card` / `.lo-btn-*` / `.lo-glass` 等组件类；动画 keyframes；`prefers-reduced-motion` 降级 |
| `src/router/index.ts` | 路由 | `createWebHashHistory`；`/` → Home、`/editor` → Editor、其余重定向首页；切换时回到顶部 |

#### 3.3.3 页面

| 文件 | 约行数 | 职责 | 关键行为 |
|---|---:|---|---|
| `src/pages/Home.vue` | 276 | 首页 / 文件入口 | 拖放导入、文件列表、隐私卖点卡片（「次上传」恒为 0）、鼠标跟随光斑、打开文档跳编辑页、导出当前文档 |
| `src/pages/Editor.vue` | 712 | 编辑页主体 | 分块虚拟渲染（窗口 + 双向补块/回收）、选区与工具栏命令、撤销/重做栈、粘贴安全拦截、导出保存、原始文件下载、文本副本导出、大纲跳转、字数统计 |

`Editor.vue` 的关键内部函数：

| 函数 | 作用 |
|---|---|
| `splitBlocks(html)` | 按顶层块切 HTML，供虚拟滚动使用 |
| `renderWindow()` / `appendNextChunk()` / `prependPrevChunk()` | 只把窗口内块放入 DOM，滚动时增量补齐 |
| `recycleTop()` / `recycleBottom()` | 回收远离视口的块，控制 DOM 规模 |
| `onInput()` / `persistNow()` | 同步编辑结果到 store，并维护 dirty 与撤销栈 |
| `onCommand(command)` | 执行加粗/斜体/列表/标题等命令；撤销重做走自维护栈 |
| `onPaste()` | 检测不可信 HTML 时降级为纯文本插入 |
| `handleSave()` | 调 `exportDocument` 并按结果提示 |
| `jumpToHeading(index)` | 大纲点击后滚动到对应标题 |

#### 3.3.4 状态管理

| 文件 | 约行数 | 职责 |
|---|---:|---|
| `src/stores/workspace.ts` | 647 | 全局唯一 Pinia store：文档会话、导入流水线、解析进度、确认弹层、致命错误兜底、Toast、IndexedDB 持久化 |

关键状态与动作：

| 成员 | 作用 |
|---|---|
| `docs` / `activeId` / `activeDoc` | 当前会话文档列表与选中项；`docs` 用 `shallowRef` 避免代理二进制字段 |
| `job` / `startJob` / `updateJobPhase` / `cancelJob` / `endJob` | 解析等待态：阶段、耗时、进度、可取消 |
| `confirmRequest` / `askConfirm` / `resolveConfirm` | 基于 Promise 的通用确认弹层（超大文件、大工作簿） |
| `fatal` / `dismissFatal` / `downloadFatal` | OOM / 解析崩溃兜底，保留原始 `Blob` 供下载 |
| `hydrate()` | 启动时从 IndexedDB 恢复文档与上次会话 |
| `importFiles(files)` | 导入主流程：格式过滤 → 体积分级 → 确认 → 解析 → 落库 → 激活；含 16 MB / 64 MB / 128 MB 三档阈值 |
| `updateDoc` / `updateCell` / `resetDoc` | 编辑落库、表格单元格更新、恢复到解析初稿 |
| `removeDoc` / `setActive` | 移除文档（同时清 PDF 缓存）、切换当前文档 |

`buildRecord()` 是导入流水线的核心：按 `detectKind` 分流到 docx / xlsx / md / pdf / pptx 解析器，
统一生成 `DocRecord`，并收集提示（编码、截断、PDF 文本层缺失等）。

#### 3.3.5 组件

**`src/components/app/` —— 应用壳组件**

| 文件 | 约行数 | 职责 | 接口 / 关键点 |
|---|---:|---|---|
| `TopBar.vue` | 72 | 顶栏 | props `saving` / `statusText`；emit `save`；显示当前文档、会话数量、导入/保存按钮 |
| `Sidebar.vue` | 149 | 左侧文档列表 | props `activeId`、`variant`（home/editor）；emit `select` / `remove` / `reserved`；按格式着色、显示大小与格式徽标 |
| `Toaster.vue` | 52 | 全局轻提示 | 读取 store 的 `toasts`；按 info/success/warning/error 配图标与颜色；右下角堆叠 |
| `SlotNumber.vue` | 66 | 老虎机数字动画 | props `value` / `animate`；纯类名驱动，不直接操作 DOM；尊重 `prefers-reduced-motion` |
| `ImportProgress.vue` | 45 | 解析进度浮层 | 读取 `job`；显示文件名、阶段、已耗时、已加载/总数、取消按钮 |
| `FileDropProvider.vue` | 112 | 整页拖放 + 文件选择器 | 统一「按钮 / 整页拖拽 / 拖放框」三个入口到 `store.importFiles`；用 `provide` 暴露 API |
| `fileDropContext.ts` | 19 | 拖放 API 的注入上下文 | `provideFileDrop` / `useFileDrop`；未包裹时抛错，避免静默失效 |
| `ErrorBoundary.vue` | 33 | 渲染错误边界 | `onErrorCaptured` 捕获子组件错误，展示错误信息与刷新按钮，避免整页白屏 |

**`src/components/editor/` —— 编辑相关**

| 文件 | 约行数 | 职责 | 关键点 |
|---|---:|---|---|
| `Toolbar.vue` | 85 | 编辑工具栏 | props `disabled` / `active` / `canUndo` / `canRedo`；emit `command`；按钮表集中在 `TOOLS`，带分隔线 |
| `SheetView.vue` | 196 | 表格视图 | 多工作表切换、表内搜索、单元格编辑后调 `store.updateCell`；只读渲染大表，避免每个单元格一个组件 |
| `PdfPages.vue` | 175 | PDF 页面渲染 | 用 `pdfCache` 复用 `PDFDocumentProxy`；按可视区排队渲染 canvas，先预加载 2 页；单页失败只影响该页 |

**`src/components/ui/` —— 无依赖基础组件**

| 文件 | 约行数 | 职责 |
|---|---:|---|
| `AppButton.vue` | 39 | 按钮：`primary` / `secondary` / `ghost` / `outline` / `danger`，`sm/md/lg/icon` 四种尺寸 |
| `AppCard.vue` | 9 | 卡片容器，套用冻结的 `.lo-card` 样式 |
| `AppBadge.vue` | 24 | 徽标：`reserved` / `solid` / `soft` / `outline` / `warn` / `ok` 六种语义色 |
| `AppIcon.vue` | 22 | 内联 SVG 图标：从 `iconRegistry` 按 name 取 path，`stroke-width` 可调 |
| `ConfirmDialog.vue` | 53 | 通用确认弹层：绑定 store 的 `confirmRequest`，确认/取消后 resolve Promise |
| `FatalDialog.vue` | 38 | 致命错误弹层：展示原因，提供「下载原始文件」与关闭 |
| `iconRegistry.ts` | 58 | 全部图标 path 的集中表；新增图标只改这里，避免引入图标库 |

#### 3.3.6 `src/lib/` —— 解析、导出与存储

| 文件 | 约行数 | 职责 | 关键导出 / 说明 |
|---|---:|---|---|
| `docx.ts` | 985 | **docx 解析与 OOXML 回写** | `parseDocx`、`buildDocx`、`renderItems`、`formatCounter`、`LIST_FORMATS`、`DocxExportReport`；处理编号、图片 rels、表格、标题；导出后可回读自检 |
| `xlsx.ts` | 465 | 表格读写 | `parseXlsx`（SheetJS 主路径）、`parseXlsxWithSheetJS`、`parseXlsxFallback`（自研 OOXML 回退）、`inspectXlsxWorkbook`、`buildWorkbook`、`persistedFromSheet`、`setCell`、`sheetText`、`findInSheets`、`columnLabel` |
| `pdf.ts` | 257 | PDF 文本提取与错误分类 | 动态 `import('pdfjs-dist')`；`loadPdfDocument`、`extractPdfText`、`renderPdfPageToCanvas`、`classifyPdfError`、`PDF_MESSAGES`；worker 走本地打包，不指向 CDN |
| `pdfCache.ts` | 25 | PDF 句柄缓存 | `rememberPdfDocument` / `getPdfDocument` / `forgetPdfDocument`；`PDFDocumentProxy` 不可结构化克隆，绝不能进 IndexedDB |
| `markdown.ts` | 355 | Markdown ↔ HTML | `renderMarkdown`（自研、无依赖）、`htmlToMarkdown`、`htmlToPlainText`、`escapeHtml`；链接协议白名单防 `javascript:` |
| `file.ts` | 142 | 文件识别与轻量解析 | `detectKind`（扩展名）、`decodeText`（BOM/编码）、`parsePptx` / `parsePptxText`（文本抽取）、`KIND_LABEL` / `KIND_EXT`、`formatSize` / `formatTime` |
| `zip.ts` | 222 | 最小 ZIP 读写 | `unzip`（`DecompressionStream`，兼容 store/deflate）、`zip`（store 写入）、`entryText` / `entryBytes`、`listByPrefix`、`hasZipHeader`；docx/xlsx/pptx 的底层 |
| `xml.ts` | 107 | XML 解析与查询 | 惰性创建 `DOMParser`；`parseXml` / `parseXmlFromZip`；`descendants` / `childElements` / `firstChild` / `firstDescendant` / `attr` / `findByAttr` / `escapeXml` |
| `exporter.ts` | 207 | 导出与下载 | `exportDocument` 总入口；`exportDocx`、`exportXlsx`、`exportMarkdown`、`exportTextCopy`、`downloadOriginal`；下载后做回读自检并返回 `details` |
| `db.ts` | 181 | IndexedDB 封装 | `DocRecord` / `SessionState`；`loadAll`、`saveDoc`、`deleteDoc`、`saveSession`、`clearAll`、`isDegraded`；不可用时降级为「仅当前页面」 |
| `parseClient.ts` | 108 | Worker 调用封装 | `renderMarkdownInWorker`、`parseXlsxInWorker`；统一处理 id、进度、取消（AbortSignal）、错误归一 |
| `sheetjs-loader.ts` | 25 | SheetJS 懒加载 | `loadSheetJS`；从 npm 包 `xlsx` 适配为内部最小接口，保持独立 chunk，不进入首屏 |
| `agent/tools.ts` | 469 | 7 个本地文档工具 | `getStats`、`getOutline`、`searchDocument`、`checkTables`、`checkHeadings`、`checkDuplicates`、`diagnoseReport`；另含 `splitBlocks`、`tableToCsv`、`tableToMarkdown`；全部纯函数、离线可用 |

**`src/lib/workers/` —— Web Worker**

| 文件 | 约行数 | 职责 |
|---|---:|---|
| `md.worker.ts` | 30 | 在 Worker 里执行 `renderMarkdown`，接收 `{id,text}`，回传结果或错误 |
| `xlsx.worker.ts` | 28 | 在 Worker 里执行 `parseXlsxWithSheetJS`，并转发解析进度 |

为什么只有这两个：`docx` 解析依赖 `DOMParser`，`pdf` 自带 worker，都不适合搬进这里的 Worker。

#### 3.3.7 类型声明

| 文件 | 职责 |
|---|---|
| `src/types/sheetjs.d.ts` | 为运行时模块 `sheetjs` 声明项目使用到的最小类型（`SheetJsModule`、`WorkBookLike`、`SheetCell`、`CellRange`），供 TS 检查 |

#### 3.3.8 `scripts/` 与 `tools/`

| 文件 | 职责 | 运行方式 |
|---|---|---|
| `scripts/check-docx-export.mjs` | docx 导出图片自检：解析 → 导出 → 解包统计 `word/media` → 断言图片数一致 → 回读 | `node scripts/check-docx-export.mjs <input.docx>` |
| `scripts/check-large-file.mjs` | 大文件「不截断」自检：md 12 万块、xlsx 5 万行、PDF 500 页、docx 50 图 2000 段 | `node scripts/check-large-file.mjs <big.md> <big.xlsx> <big.pdf> <big.docx>` |
| `scripts/check-pdf.mjs` | 用与应用同版本的 `pdfjs-dist` 在 Node 侧提取 PDF 文本，输出页数/字符数/耗时/失败原因 | `node scripts/check-pdf.mjs <a.pdf> ...` |
| `tools/check-agent-tools.mjs` | 构造「有毛病」和「干净」两份文档，断言 7 个工具能发现问题且不误报 | `node tools/check-agent-tools.mjs`（Node 24 原生类型擦除） |
| `tools/gen-large-fixtures.mjs` | 生成大文件测试素材；md/xlsx 用 Node 生成，pdf/docx 调 Python 脚本 | `node tools/gen-large-fixtures.mjs <outdir>` |
| `tools/gen_large_pdf_docx.py` | 用 reportlab / python-docx 生成 500 页 PDF 与 20 MB docx | 由上一个脚本调用，或单独 `python tools/gen_large_pdf_docx.py <outdir>` |

### 3.4 前端约束

- 路由用 `createWebHashHistory()`，Vite `base: './'`，`dist/` 可直接丢到任意静态目录。
- 运行时依赖只有 5 个：`vue`、`vue-router`、`pinia`、`xlsx`、`pdfjs-dist`。
- 没有 UI 组件库、图标库、动画库；图标是内联 SVG，动画是 CSS keyframes。
- Worker 只承载 md 与 xlsx 主路径；docx / PDF 留在主线程或各自 worker。
- 手机窄屏未做自适应，属于已知边界而非遗漏。
- 编辑内容先写 store 再异步落 IndexedDB；超过 2 MB 的文件先出内容、后台落库。

---

## 四、`code/backend/` —— Node 协作后端

### 4.1 目录树

```
code/backend/
├── package.json
├── package-lock.json
├── .gitkeep
├── public/
│   └── d.html
├── server/
│   ├── index.mjs
│   ├── db.mjs
│   ├── share.mjs
│   ├── sanitize.mjs
│   ├── smoke.mjs
│   └── test-db-seq.mjs
└── data/                     # 运行时创建，已忽略
    └── liteoffice.db
```

### 4.2 后端逐文件说明

#### 4.2.1 `server/index.mjs`（约 458 行）

**入口与编排层**：HTTP 服务、静态托管、WebSocket、Yjs 房间、Agent 反向代理都在这里。

| 区块 | 内容 |
|---|---|
| 常量 | `PORT`（默认 3000）、`MAX_BODY`（30 MB）、`MIME` 表、`PUBLIC_DIR`、`DIST_DIR`（`../frontend/dist`） |
| 响应工具 | `json()` 统一 JSON 响应；`readBody()` 限流读取；`readJson()` 解析并区分 `BAD_JSON` / `BODY_TOO_LARGE` |
| 静态文件 | `serveFile()` 按扩展名给 MIME 与缓存头；`handleStatic()` 优先 `public/`，再 `frontend/dist`，无扩展名时回退 SPA 的 `index.html`；`/d/:token` 固定返回分享页 |
| API | `handleApi()` 解析 `/api/*`，分发到文档、分享、撤销、保存等路由 |
| WebSocket | `wss.on('connection')`：校验 token、建房间、同步状态、广播在线人数、按角色拦截写入、断开时落快照并延迟回收 |
| Yjs 房间 | `rooms` Map、`getRoom()`（先从快照+增量恢复）、`broadcast()`、每 200 次更新落快照并裁剪增量 |
| 代理 | `proxyToAgent()` 把 `/agent/*` 转发到 `AGENT_ORIGIN`（默认 `127.0.0.1:8100`），60 秒超时，Agent 不可达返回 503 |
| 服务器 | `http.createServer` 按前缀分流：`/agent/` → 代理、`/api/` → API、其余 → 静态；兜底 500 |

#### 4.2.2 `server/db.mjs`（约 198 行）

**SQLite 持久化层**，使用 Node 内置 `node:sqlite`（`DatabaseSync`），无需原生编译。

- 启动时 `mkdirSync` 数据目录，开启 WAL 与外键。
- 四张表：`documents` / `shares` / `updates` / `snapshots`，建表语句在模块顶层执行。
- 导出函数：

| 分组 | 函数 | 说明 |
|---|---|---|
| documents | `createDocument`、`getDocument`、`updateDocumentHtml`、`listDocuments`、`deleteDocument` | 文档 CRUD；列表按更新时间倒序，默认 50 条 |
| shares | `createShare`、`resolveShare`、`revokeShare`、`revokeSharesOfDocument`、`listShares` | 128 位随机 token（32 位十六进制）；校验顺序：存在 → 未撤销 → 未过期 |
| updates | `appendUpdate`、`listUpdates`、`latestSeq` | `seq` **跨 updates 与 snapshots 取最大后 +1**，避免裁剪后序号回退导致重放丢数据 |
| snapshots | `latestSnapshot`、`saveSnapshot`、`pruneUpdates` | 快照落盘后裁掉已覆盖增量，防止表无限增长 |

#### 4.2.3 `server/share.mjs`（约 63 行）

**分享链接业务层**：包一层 `db.mjs`，并加失败限速。

- `makeShare({docId, role, expiresInHours})`：校验角色，计算过期时间，生成 token 与 `/d/<token>` URL。
- `checkShare(token)`：委托 `resolveShare`。
- `revoke(token)` / `sharesOf(docId)`：撤销与列表。
- `noteFailure(ip)` / `isBlocked(ip)`：同一 IP 每分钟最多 20 次失败，超过返回 429。
- `reasonText(reason)`：把 `not_found` / `revoked` / `expired` 转成人话。

#### 4.2.4 `server/sanitize.mjs`（约 106 行）

**HTML 白名单消毒**，防存储型 XSS。

- 标签白名单：段落、标题、列表、表格、基础行内样式、`a`、`img`。
- 属性白名单：`class`、`title`、`colspan`、`rowspan`、`align`、`width`、`height`、`alt`、`src`、`href` 等。
- 整段丢弃：`script`、`style`、`iframe`、`object`、`embed`、`noscript`、`template`、`svg`、`math`。
- 图片只允许 `data:image/*;base64`；链接只允许 `http(s)` / `mailto` / `tel` / `#` / `/`。
- 导出 `sanitizeHtml()` 与 `toPlainText()`；`POST /api/docs`、`/save` 都会先消毒。

#### 4.2.5 `server/smoke.mjs`（约 146 行）

**端到端自检**，需要后端已启动（默认 `http://localhost:3000`）。

覆盖 6 组：上传并生成 edit/view 链接 → 两个 edit 连接互相同步 → 只读连接写入被忽略 →
断开重连内容仍在 → 撤销链接返回 410 → 非法 token 返回 410。
内部自带一个极简 Yjs 客户端（`connect()`），不依赖前端代码。

#### 4.2.6 `server/test-db-seq.mjs`（约 74 行）

**单元自检**，使用临时 SQLite，不影响正式数据。

- P0-1：增量序号单调。模拟「写快照 + 裁剪」后继续追加，断言新 `seq > snapshots.at_seq`、重启能重放到它。
- P0-2：HTML 消毒。逐条断言移除 `<script>` / `onerror` / `javascript:` / `onclick` / `<iframe>` / `<style>`，
  同时保留正常段落、`data:image` 与白名单属性。

#### 4.2.7 `public/d.html`（约 127 行）

**分享页（单文件、无构建）**。

- 从 `/d/:token` 取 token，`fetch /api/share/:token` 拉取内容。
- 渲染标题、格式、大小、角色徽标；只读/可编辑用 `contenteditable` 区分。
- 用 WebSocket 连接 `/ws?token=`，只解析文本帧里的 `presence` 消息更新在线人数。
- **边界**：编辑态目前只开了 `contenteditable`，没有接入 Yjs 客户端，
  因此「可编辑」页面的改动不会实时同步；真正的 Yjs 同步能力在服务端协议与 `smoke.mjs` 中验证。

#### 4.2.8 其他

| 文件 | 职责 |
|---|---|
| `package.json` | `start`（`node server/index.mjs`）、`smoke`（`node server/smoke.mjs`）；依赖 `ws`、`yjs`、`y-protocols` |
| `package-lock.json` | 依赖锁文件 |
| `.gitkeep` | 历史遗留，可删除；无实际功能 |

### 4.3 HTTP / WebSocket 面

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 健康检查；若存在 `code/frontend/dist` 则托管前端 |
| POST | `/api/docs` | 上传文档（title / kind / html / contentBase64），HTML 先消毒 |
| GET | `/api/docs` | 最近文档列表（默认 50 条） |
| GET | `/api/docs/:id` | 取单篇文档（含 base64 原始字节） |
| POST | `/api/docs/:id/share` | 生成分享链接（role / expiresInHours） |
| GET | `/api/docs/:id/shares` | 列出该文档的链接 |
| POST | `/api/docs/:id/save` | 覆盖保存 HTML |
| POST | `/api/share/:token/revoke` | 撤销链接 |
| GET | `/api/share/:token` | 按链接取内容（存在 / 撤销 / 过期 / 限速） |
| GET | `/d/:token` | 分享页 |
| WS | `/ws?token=...` | 在线状态 + Yjs 增量转发 |

### 4.4 WebSocket 协议

- 文本帧：`{"type":"presence","online":N}`，用于在线人数。
- 二进制帧：Yjs sync 协议。首字节为消息类型 `0`（messageSync），随后是 sync 子类型：
  - `0` = step1：请求方要状态；服务端回 step2。
  - `1` = step2 / `2` = update：只有 `role === 'edit'` 才允许应用，只读连接静默忽略。
- 连接建立时服务端主动发 step1；新连接加入 / 离开都广播 presence。
- 本地更新经 `doc.on('update')` 落库并广播；每 200 条或房间关闭时写快照并裁增量。
- 房间无人后延迟 30 秒回收，留出重连窗口。

### 4.5 持久化

单文件 SQLite（`node:sqlite`）：

| 表 | 内容 |
|---|---|
| `documents` | 文档主体（HTML + 原始字节） |
| `shares` | token → 权限 / 过期 / 撤销 |
| `updates` | Yjs 增量（按 `seq` 递增） |
| `snapshots` | 定期快照，避免重放全部增量 |

**硬约束**：`updates.seq` 必须跨表单调（与 `snapshots.at_seq` 取最大），
否则「快照后裁剪 → 新增量序号归零 → 重启 replay 跳过」会丢数据。

### 4.6 静态托管与代理

- 前端构建产物路径写死为 `../frontend/dist`，所以「前端 + 后端」可以只起 3000 端口。
- `/agent/*` 反向代理到 `AGENT_ORIGIN`（默认 `http://127.0.0.1:8100`），前端无需处理跨域。
- 分享页固定从 `public/d.html` 读取，不随前端构建变化。

---

## 五、`code/agent/` —— Python Agent 服务

### 5.1 目录树

```
code/agent/
├── requirements.txt
└── app/
    ├── __init__.py
    ├── main.py
    ├── graph.py
    ├── tools.py
    ├── kb.py
    ├── llm.py
    └── test_kb.py
```

### 5.2 逐文件说明

| 文件 | 约行数 | 职责 | 关键点 |
|---|---:|---|---|
| `app/main.py` | 235 | FastAPI 应用与路由 | 工具 / Agent / Chat / LLM 信息 / KB 路由；`X-API-Token` 可选鉴权；IP 限流（默认 60 次/分钟）；CORS 放开 |
| `app/graph.py` | 169 | LangGraph 编排 | `START → plan → call_tool → respond → END`；`RULES` 关键词路由优先，匹配不上才问模型；`MAX_STEPS = 4` |
| `app/tools.py` | 334 | 7 个服务端文档工具 | 与前端 `lib/agent/tools.ts` 同语义；`TOOLS` 注册表、`tool_manifest()`、`run_tool()` |
| `app/kb.py` | 392 | 共享知识库 | 入库、切块、术语匹配、BM25 检索、`build_evidence`；SQLite `kb.db` |
| `app/llm.py` | 104 | LiteLLM 封装 | `complete()` / `info()`；支持 deepseek/openai/anthropic/gemini/ollama；无 Key 返回确定性 mock |
| `app/test_kb.py` | 102 | 知识库自检 | 20 项断言：入库、切块、检索、术语、删除级联、空库 |
| `app/__init__.py` | 1 | 包标记 | 使 `app.*` 可导入 |
| `requirements.txt` | — | 依赖清单 | fastapi / uvicorn / langgraph / langchain-core / langchain-openai / litellm，均带版本约束 |

### 5.3 分层与路由

```
main.py（API 层）
   ├── graph.py（Agent 层：规则路由 + LangGraph）
   │      ├── tools.py（工具层，本地执行）
   │      └── llm.py（模型层，LiteLLM）
   └── kb.py（知识库层，SQLite + BM25）
```

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/tools` | 工具清单 |
| POST | `/v1/tools/{name}` | 直接调用工具，不经模型 |
| POST | `/v1/agent/run` | 走 LangGraph 编排 |
| POST | `/v1/chat` | 纯对话，无工具 |
| GET | `/v1/llm/info` | 当前模型配置与是否 mock |
| GET | `/v1/kb` | 知识库列表 |
| GET | `/v1/kb/{kb_id}/stats` | 知识库统计 |
| GET/POST | `/v1/kb/{kb_id}/documents` | 列出 / 入库 |
| DELETE | `/v1/kb/{kb_id}/documents/{doc_id}` | 删除文档 |
| POST | `/v1/kb/{kb_id}/terms` | 添加术语 |
| POST | `/v1/kb/{kb_id}/search` | BM25 检索（问答出口） |
| POST | `/v1/kb/{kb_id}/evidence` | 术语 + 规范片段（改写出口） |

### 5.4 设计约束

- `plan` 优先关键词规则，零成本、可预测、离线可用。
- `call_tool` 永远在服务端本地执行，不经模型。
- 无 API Key 时返回确定性 mock；有 Key 但调用失败时返回错误，绝不假装成功。
- 知识库写操作由 `LITEOFFICE_ADMIN_TOKEN` 保护，未设置时放开（仅课程演示）。

---

## 六、`docs/` —— 文档体系

```
docs/
├── README.md                 # 文档索引与阅读顺序
├── requirements/             # 需求工程
│   ├── problem_definition.md
│   ├── functional_spec.md
│   ├── nonfunctional_spec.md
│   ├── user_stories.md
│   └── README.md
├── mgmt/                     # 项目管理
│   ├── communication_mgmt_plan.md
│   ├── risk_mgmt_plan.md
│   └── github_projects_setup.md
├── assignments/              # 三次课程作业
├── software/                 # 软件设计与任务书
│   ├── project-structure.md      # 本文
│   ├── code-map.md
│   ├── code-review.md
│   ├── review-report.md
│   ├── agent-architecture.md
│   ├── agent-ui-prototype.md
│   ├── rag-design.md
│   ├── PROMPT-*.txt
│   └── prototype/                # 冻结的交互原型（只读）
├── algorithm/                # 关键算法说明（目前仅 README）
├── retrospection/            # 复盘（占位）
└── .nojekyll                 # GitHub Pages
```

`docs/software/prototype/` 是**冻结的设计基准**：配色、间距、动效以它为准，代码向它对齐，不反过来改原型。

---

## 七、`tests/`、`tools/`、`.github/`

### 7.1 `tests/`

```
tests/
├── unit/.gitkeep
└── integration/.gitkeep
```

目录存在但**没有测试代码**。当前可执行的自检都在各自服务内：

| 自检 | 位置 | 命令 |
|---|---|---|
| 前端类型检查 | `code/frontend` | `npm run typecheck` |
| docx 导出 / 大文件 / PDF | `code/frontend/scripts/` | `node scripts/check-*.mjs` |
| 后端端到端 | `code/backend/server/smoke.mjs` | `npm run smoke`（需服务已启动） |
| 数据库序号与消毒 | `code/backend/server/test-db-seq.mjs` | `node server/test-db-seq.mjs` |
| 知识库 | `code/agent/app/test_kb.py` | `python -m app.test_kb` |

### 7.2 `tools/`

| 文件 | 作用 | 注意 |
|---|---|---|
| `sync-frontend.mjs` | 从墨刀工作区同步最新生成版到 `code/frontend` | 默认源路径写死为 Windows 路径 |
| `review.py` | 自动代码审查，产出 `docs/software/review-report.md` | 依赖本机 ruff / node / vue-tsc |

### 7.3 `.github/workflows/`

只有 `.gitkeep`，**没有 CI**。所有检查目前靠本地命令手动执行。

---

## 八、运行拓扑与配置

### 8.1 端口

| 服务 | 默认端口 | 启动方式 |
|---|---:|---|
| 前端（Vite dev） | 5173 | `cd code/frontend && npm run dev` |
| 协作后端 | 3000 | `cd code/backend && npm start` |
| Agent 服务 | 8100 | `cd code/agent && uvicorn app.main:app --port 8100` |

生产/演示可用「后端 3000 托管前端 dist」的单端口形态，再用 `/agent/*` 代理 Agent。

### 8.2 环境变量

| 服务 | 变量 | 默认 | 说明 |
|---|---|---|---|
| backend | `PORT` | `3000` | HTTP 端口 |
| backend | `LITEOFFICE_DB` | `code/backend/data/liteoffice.db` | SQLite 路径 |
| backend | `AGENT_ORIGIN` | `http://127.0.0.1:8100` | `/agent` 代理目标 |
| agent | `LITEOFFICE_MODEL` | `deepseek/deepseek-chat` | LiteLLM 模型串 |
| agent | `DEEPSEEK_API_KEY` 等 | 无 | 无 Key 时 mock |
| agent | `LITEOFFICE_API_TOKEN` | 空 | 设置后 `/v1` 需 `X-API-Token` |
| agent | `LITEOFFICE_ADMIN_TOKEN` | 空 | 知识库写操作保护 |
| agent | `LITEOFFICE_RATE_LIMIT` | `60` | 每 IP 每分钟请求上限 |
| agent | `LITEOFFICE_KB_DB` | `code/agent/data/kb.db` | 知识库 SQLite 路径 |
| agent | `LITEOFFICE_KB_ID` | `kb_shared` | 默认知识库 id |
| frontend | 无 | — | 不读任何环境变量，纯静态 |

### 8.3 数据落在哪

| 存储 | 位置 | 内容 | 是否入库 |
|---|---|---|---|
| IndexedDB `liteoffice` | 浏览器 | 会话、文档 HTML、表格、PDF 元数据 | 否 |
| SQLite | `code/backend/data/liteoffice.db` | 文档、分享、Yjs 增量与快照 | 否 |
| SQLite | `code/agent/data/kb.db` | 知识库文档、块、术语 | 否 |

---

## 九、依赖方向与模块边界

### 9.1 允许的依赖

| 从 | 到 | 允许？ |
|---|---|---|
| `frontend/pages` | `frontend/stores`、`components` | ✅ |
| `frontend/stores` | `frontend/lib` | ✅ |
| `frontend/lib` 高层 | `frontend/lib` 低层（zip/xml → docx/xlsx → exporter） | ✅ |
| `frontend/components` | `frontend/lib` 解析器 | ❌ 应经 store 或 props |
| `frontend` | `backend` / `agent` | ❌ 当前无任何 fetch / WebSocket 调用 |
| `backend/server/index.mjs` | `db/share/sanitize` | ✅ |
| `agent/app/main.py` | `graph/kb/tools/llm` | ✅ |
| `agent/graph.py` | `tools/llm` | ✅ |
| `backend` / `agent` | `frontend` | ❌ |

### 9.2 两个「平行实现」

同一套 7 个文档工具存在两份代码：

| 位置 | 运行环境 | 依赖模型？ |
|---|---|---|
| `code/frontend/src/lib/agent/tools.ts` | 浏览器 | 否 |
| `code/agent/app/tools.py` | Python 服务端 | 否 |

两份都刻意保持「纯函数、离线可用」，但**没有共享代码**；
新增/修改工具时必须同时改两处，并用 `code/frontend/tools/check-agent-tools.mjs` 校验一致性。

---

## 十、改东西该动哪里

| 需求 | 落点 |
|---|---|
| 支持一种新文件格式 | `src/lib/file.ts`（识别）→ 新解析器 → `stores/workspace.ts`（分支）→ `lib/exporter.ts`（导出） |
| 修 docx 编号/图片导出 | `src/lib/docx.ts`；跑 `scripts/check-docx-export.mjs` |
| 改编辑器交互 | `src/pages/Editor.vue` + `components/editor/*` |
| 改首页/拖放 | `src/pages/Home.vue` + `components/app/FileDropProvider.vue` |
| 改配色/动效 | `src/index.css`；令牌以 `docs/software/prototype/` 为准 |
| 改会话/导入流程 | `src/stores/workspace.ts` |
| 改分享/协作 | `code/backend/server/index.mjs` + `db.mjs` + `public/d.html` |
| 加 Agent 工具 | `code/agent/app/tools.py` **和** `code/frontend/src/lib/agent/tools.ts` |
| 改 Agent 编排 | `code/agent/app/graph.py` 的 `RULES` 与节点 |
| 改知识库检索 | `code/agent/app/kb.py` |
| 改需求/验收 | `docs/requirements/`；保持 `FR-*` 可追溯 |
| 加 CI | `.github/workflows/`（当前为空） |

---

## 十一、结构层面的已知问题

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | `tests/` 为空，自检散落在各服务内 | 无统一测试入口 | 收敛为 `npm test` / `pytest` 或 CI 矩阵 |
| 2 | 无 CI，`ruff` 静态检查未通过（见审查报告） | 合并前无自动门禁 | 补 workflow，先跑 typecheck + node --check |
| 3 | 前端与后端/Agent 尚未接线（无 fetch/WS 调用） | 「协作」「AI」目前是独立服务演示 | 明确接入计划，或在 README 标注能力状态 |
| 4 | 分享页的编辑态没有绑定 Yjs | 「可编辑链接」实际不会实时同步 | 补 yjs 客户端，或把文案改为只读 |
| 5 | 7 个工具前后端各一份实现 | 易漂移 | 用 JSON schema 作单一事实源，或代码生成 |
| 6 | `tools/sync-frontend.mjs` 写死 Windows 路径 | macOS 上默认不可用 | 改为参数/环境变量 |
| 7 | `code/backend/.gitkeep` 与真实文件并存 | 无功能影响 | 可删除 |
| 8 | `docs/software/prototype/vendor/` 约 3.8 MB 静态资源 | 仓库体积 | 已冻结，不建议改动 |
| 9 | 根目录没有 LICENSE | 许可状态不明确 | 补 LICENSE 或明确「保留所有权利」 |

---

## 十二、十分钟上手路径

```bash
# 1. 只跑前端（离线，最常用）
cd code/frontend
npm install
npm run typecheck
npm run dev            # http://localhost:5173/

# 2. 需要协作能力时
cd ../backend
npm install
npm start              # http://localhost:3000
npm run smoke          # 另开终端，端到端自检

# 3. 需要 AI 能力时
cd ../agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8100
python -m app.test_kb  # 另开终端，知识库自检
```

阅读顺序建议：本文 → [code-map.md](code-map.md) → 目标模块源码。
需求背景看 [problem_definition.md](../requirements/problem_definition.md)，
验收标准看 [functional_spec.md](../requirements/functional_spec.md) 的验收场景章节。

---

## 变更记录

| 版本 | 日期 | 变更 | 触发原因 |
|---|---|---|---|
| v1.0 | 2026-11-07 | 初稿：三服务结构、目录树、依赖方向、配置与落点索引 | 仓库已扩展为前端 + 后端 + Agent |
| v1.1 | 2026-11-07 | 补齐前端 41 个源文件与后端 7 个文件的逐文件职责、关键导出与边界 | 需要可逐文件检索的结构文档 |
