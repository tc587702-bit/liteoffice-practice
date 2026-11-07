# LiteOffice 代码职责地图

用途：说明每个文件"负责什么"，以及最复杂、最容易出事的地方在哪。
配套：[code-review.md](code-review.md)（问题清单）、[agent-architecture.md](agent-architecture.md)（Agent 设计）

---

## 一、三个服务，各管一段

```
┌──────────────────────────────────────────────────────────────┐
│ 前端 code/frontend（Vue 3 + Vite）                            │
│   打开/解析/渲染/编辑/导出 —— 全程本地，可断网                  │
└───────────────┬──────────────────────────────┬───────────────┘
                │ REST /api/*, WS /ws          │ REST /agent/*
                ▼                              ▼
┌──────────────────────────────┐  ┌───────────────────────────────┐
│ 协作后端 code/backend（Node） │  │ Agent 服务 code/agent（Python）│
│   分享链接 / 多人同步 / 消毒   │  │  KB 检索 / LangGraph / LiteLLM │
│   SQLite（node:sqlite）       │  │  SQLite（kb.db）               │
└──────────────────────────────┘  └───────────────────────────────┘
```

三者互不依赖：前端可以只跑自己（单人离线），也可以走协作，也可以走 Agent。

---

## 二、前端：谁负责什么

| 文件 | 行数 | 负责 | 关键函数 |
|---|---|---|---|
| `lib/docx.ts` | 897 | **docx 解析 + 回写**（最核心） | `parseDocx`、`buildDocx`、`buildNumbering`、`renderLvlText`、`loadRelations` |
| `pages/Editor.vue` | 665 | 编辑器：分块虚拟渲染、选区、替换、保存 | `splitBlocks`、`renderWindow`、`appendNextChunk`、`markLazyImages` |
| `stores/workspace.ts` | 599 | 会话状态：导入、解析进度、内存兜底、持久化 | `buildRecord`、`isMemoryError`、`memoryHint`、`startJob` |
| `lib/xlsx.ts` | 432 | 表格读写 | `parseXlsx`、`parseXlsxFallback`、`buildWorkbook`、`setCell` |
| `lib/agent/tools.ts` | 423 | **7 个本地 AI 工具**（不依赖模型） | `getStats`、`getOutline`、`searchDocument`、`checkTables`、`checkHeadings`、`checkDuplicates`、`diagnoseReport` |
| `lib/markdown.ts` | 325 | md 渲染与转换 | `renderMarkdown`、`htmlToMarkdown`、`htmlToPlainText` |
| `pages/Home.vue` | 253 | 首页：拖放、文件列表、隐私条 | — |
| `lib/pdf.ts` | 234 | PDF 文本提取 + 页面交给 `PdfPages.vue` | `extractPdfText`、`classifyPdfError` |
| `lib/file.ts` | ~200 | 格式识别、解码、pptx 文本 | `detectKind`、`decodeText`、`parsePptx` |
| `lib/workers/*.ts` | 26 / 25 | 把 md / xlsx 解析移出主线程 | — |
| `lib/parseClient.ts` | 97 | Worker 调用封装（含降级） | — |
| `lib/exporter.ts` | 189 | 导出 docx/xlsx/md/txt/html | `exportDocument` |
| `lib/db.ts` | 168 | IndexedDB 封装 | — |
| `lib/zip.ts` / `xml.ts` | 196 / 90 | ZIP 解压、XML 解析（底层） | `unzip`、`parseXml` |

**依赖方向**：`pages` → `stores` → `lib/*`，没有反向依赖。`lib` 之间只允许低层被高层引用（zip/xml ← docx/xlsx ← exporter）。

---

## 三、协作后端：谁负责什么

| 文件 | 行数 | 负责 | 关键点 |
|---|---|---|---|
| `server/index.mjs` | 402 | HTTP 路由 + 静态托管 + WebSocket + Yjs 房间 + Agent 反向代理 | `handleApi`、`proxyToAgent`、`wss.on('connection')` |
| `server/db.mjs` | 170 | SQLite 四张表（documents/shares/updates/snapshots） | `appendUpdate`（跨表单调）、`latestSeq`、`pruneUpdates` |
| `server/sanitize.mjs` | 91 | HTML 白名单消毒（防分享页 XSS） | `sanitizeHtml` |
| `server/share.mjs` | 54 | token 生成/校验/限速 | `makeShare`、`checkShare` |
| `server/smoke.mjs` | 127 | 12 项端到端自检 | — |
| `server/test-db-seq.mjs` | 63 | 17 项单元自检（序号 + 消毒） | — |
| `public/d.html` | — | 分享页（只读/可编辑 + 在线人数） | — |

---

## 四、Agent 服务：谁负责什么

| 文件 | 行数 | 负责 | 关键点 |
|---|---|---|---|
| `app/kb.py` | 326 | **共享知识库**：入库、切块、术语匹配、BM25 检索 | `chunk_html`、`add_document`、`match_terms`、`search`、`build_evidence` |
| `app/tools.py` | 297 | 7 个服务端文档工具 | `diagnose_report` 等 |
| `app/main.py` | 176 | FastAPI 路由（工具 / Agent / KB / 模型信息） | `_require_admin`、`kb_*` 路由 |
| `app/graph.py` | 140 | **LangGraph 编排**：plan → call_tool → respond | `RULES`、`node_plan`、`run_agent` |
| `app/llm.py` | 85 | LiteLLM 封装（五家模型 + mock 兜底） | `complete`、`has_credentials` |
| `app/test_kb.py` | — | 知识库 20 项自检 | — |

---

## 五、五处最复杂的代码（也是最容易出事的）

### ① `docx.ts` 的编号与关系解析

```
buildNumbering(115)  renderLvlText(195)  loadRelations(214)  findMediaEntry(233)
```

复杂在：OOXML 的列表编号是 `numbering.xml` 里的多级定义 + `document.xml` 里的 `numId/ilvl` 引用，
要自己维护计数器并把 `%1.%2` 这类格式串渲染成 `1.2`。图片还要经 `document.xml.rels` 把 `rId` 映射到 `media/` 文件。

**风险**：嵌套列表编号错位、图片 rels 悬空（导出时的 `r:embed` 就属于这一类）。

### ② `Editor.vue` 的分块虚拟渲染

```
splitBlocks(76)  windowStart(46)  renderWindow(103)  appendNextChunk(111)
```

复杂在：把几百个块切出来，只把 `[windowStart, windowEnd)` 这段放进 DOM，
滚动时往后追加、往前回收，同时要保证光标与选区不丢。

**风险**：替换内容后窗口重算导致光标跳位；回收时把正在编辑的块删掉。

### ③ `workspace.ts` 的导入流水线

```
buildRecord(99)  isMemoryError(84)  memoryHint(93)
```

复杂在：一个文件从 File → 解析 → 记录，中间要处理进度、取消、内存不足（catch RangeError）、
不同格式走不同分支，还要写 IndexedDB。

**风险**：OOM 时如果没接住，整个标签页白屏。

### ④ 协作后端的 Yjs 房间与持久化

```
wss.on('connection')  appendUpdate  latestSeq  pruneUpdates  saveSnapshot
```

复杂在：内存里的 `Y.Doc` 与 SQLite 的增量表要一致——序号必须**跨表单调**（增量表 + 快照表取最大），
否则"快照后裁剪 → 新增量序号归零 → 重启 replay 跳过"就会丢数据。

**风险**：这正是评审 P0-1，已修；改动小但极难发现。

### ⑤ 知识库的切块

```
chunk_text  chunk_html  tokenize  BM25
```

复杂在：切块质量决定检索上限。中文按 2-gram 切词、超长段落按句号切、相邻块加一句重叠、
标题要作为 `heading` 带进每块（引用时才能说"在第 3 节"）。

**风险**：切太碎丢上下文，切太大命中率低；表格如果跨块会丢失"列名-值"对应。

---

## 六、三条主要数据流

**① 打开文档（本地，无网络）**

```
拖放 → Home.vue → workspace.buildRecord
   → detectKind（扩展名 + ZIP 头）
   → docx/xlsx/pdf/md 各自解析（大文件在 Worker）
   → 生成 record.html + docxItems
   → 写入 IndexedDB → Editor.vue 分块渲染
```

**② 编辑保存**

```
Editor.vue 选区替换 → innerHTML 变化 → record.html
   → exporter.exportDocument → buildDocx（含 media/rels）
   → 浏览器下载
```

**③ 知识库路径（走 Agent 服务）**

```
上传 → POST /v1/kb/{kb}/documents → kb.chunk_html → 存块
提问 → POST /v1/kb/{kb}/search   → BM25 → 命中块 + 出处
改写 → POST /v1/kb/{kb}/evidence → 术语 + 规范片段 → 拼 prompt
```

---

## 七、如果只能看三个文件

| 目的 | 看这个 |
|---|---|
| 想知道文档怎么被解析的 | `code/frontend/src/lib/docx.ts` |
| 想知道多人协作怎么同步的 | `code/backend/server/index.mjs`（WS 段） |
| 想知道知识库怎么检索的 | `code/agent/app/kb.py` |
