# LiteOffice 代码评审报告

评审日期 2026-10-26｜评审范围 `code/frontend`（墨刀生成）· `code/backend`（协作）· `code/agent`（FastAPI + LangGraph + LiteLLM）

---

## 一、规模与基础指标

| 模块 | 文件数 | 行数 |
|---|---|---|
| `code/frontend/src` | 40 | 5,997 |
| `code/backend/server` | 4 | 711 |
| `code/agent/app` | 5 | 619 |
| 合计 | 49 | **7,327** |

静态检查信号：

| 项目 | 结果 | 评价 |
|---|---|---|
| `any` 类型 | 0 | 好 |
| `@ts-ignore` | 0 | 好 |
| `TODO / FIXME` | 0 | 好 |
| `eval` / `new Function` | 0 | 好 |
| `localStorage`（存 Key 的地方） | 0 | 好（Key 只在 sessionStorage） |
| `catch {}` 空实现 | 0 | 好 |
| `console.log` 残留 | 5（仅服务启动日志与测试脚本） | 可接受 |
| `v-html` | 1（`AppIcon.vue` 内联 SVG） | 可接受，但需控制来源 |
| `innerHTML` | 1（`Editor.vue:106` 渲染文档块） | 设计如此，见 P0-2 |

类型检查：`vue-tsc --noEmit` 零错误；构建产物 2.68 MB。
已有自检：`check-pdf` · `check-docx-export` · `check-large-file` · `check-agent-tools` · `server/smoke`。

---

## 二、问题清单

### P0-1 快照序号与增量序号混用，重启会丢数据

**位置**：`code/backend/server/index.mjs:275`、`:351`，配合 `db.mjs` 的 `latestSnapshot` / `listUpdates`

```js
// 写入快照时用时间戳当 at_seq
saveSnapshot(docId, Date.now(), Buffer.from(Y.encodeStateAsUpdate(doc)))
```

而增量表用的是**递增序号**（`seq = MAX(seq) + 1`），恢复时：

```js
const snap = latestSnapshot(docId)              // at_seq = 17xxxxxxxxxxx（时间戳）
for (const row of listUpdates(docId, snap.at_seq))   // seq > 时间戳 → 永远为空
```

**后果**：只要写过一次快照，之后写入的增量在**下一次启动时全部丢失**。快照本身是完整状态，所以"快照那一刻"的数据在，但快照之后的内容没了。

**修法**（10 行）：写入快照时记录当时的最大 `seq`，而不是时间戳。

```js
const atSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM updates WHERE doc_id=?').get(docId).s
saveSnapshot(docId, atSeq, state)
```

### P0-2 分享页把服务端 HTML 直接注入，存在 XSS

**位置**：`code/backend/public/d.html`（`docEl.innerHTML = doc.html`）+ `POST /api/docs` 接受任意 `html`

**后果**：上传一个带 `<script>` 或 `<img onerror=...>` 的文档并生成分享链接，任何人打开该链接即在 `localhost:3000` 源上执行脚本，可读取同源的 `IndexedDB`、调用 `/api/*`。

**修法**（二选一）：
1. 上传时用白名单消毒（只允许 `p/h1-h6/table/td/tr/img[src^=data:]/ul/ol/li/strong/em`）；
2. 分享页改成 `<iframe sandbox="allow-same-origin">` 承载内容。

推荐 1，顺便保护前端渲染路径。

### P0-3（已修复，记录备查）只读连接可越权写入

**位置**：`index.mjs` WS 消息处理

**原状**：用 `syncProtocol.readSyncMessage()` 时，`role=view` 的写入也会被应用到文档。
**现状**：改为按帧类型判断，`view` 只应答 step1，`step2/update` 一律忽略。冒烟测试已验证（`before=15字 after=15字`）。

---

### P1-1 协作房间永不释放，长跑内存泄漏

**位置**：`index.mjs:239` `const rooms = new Map()`

`rooms.delete` 全文件 **0 处**。每个房间持有完整 `Y.Doc` + `Awareness`，断开后仍常驻。

**修法**：`ws.on('close')` 里当 `conns.size === 0` 时延迟 30 秒回收（留重连窗口），并删 Map 项。

### P1-2 增量表无上限增长

**位置**：`db.mjs` `appendUpdate`

每次编辑都 append，快照后不清理。一个活跃文档编辑 1 万次就是 1 万行 BLOB。

**修法**：写快照成功后删除 `seq <= atSeq` 的旧增量。

### P1-3 Agent 的 mock 兜底会吞掉真实错误

**位置**：`code/agent/app/llm.py:90-92`

```python
except Exception as exc:
    if allow_mock:
        return LlmResult(True, _mock_reply(prompt), model, mock=True, error=str(exc)[:200])
```

**后果**：配了 Key 但调用失败（限流、欠费、网络）时，接口返回 `ok=True` + 假回答，前端无法区分"真回答"和"占位文本"。

**修法**：`has_credentials()` 为真时 `allow_mock` 强制为 False，失败就返回 `ok=False`，由 UI 提示重试。

### P1-4 API 无鉴权、CORS 全开

**位置**：`code/agent/app/main.py`（`LITEOFFICE_API_TOKEN` 未设置即放行；`allow_origins=["*"]`）

课程演示可接受，但**部署到局域网前**至少要设 Token，否则同网段任何人都能消耗你的模型额度。

---

### P2-1 我的工具集用正则切 HTML，嵌套表格会误判

**位置**：`code/frontend/src/lib/agent/tools.ts` `BLOCK_RE`

正则 `<(h[1-6]|p|li|table)…>(…)</\1>` 对嵌套 `<table>` 只取到第一层闭合。当前 docx 解析产物不会嵌套表格，所以测试全过；但 markdown 表格或用户粘贴的 HTML 可能触发。

**修法**：浏览器内改用 `DOMParser` 遍历；Node 侧保持现状并在文档注明限制。

### P2-2 缺构建与测试的一键入口

目前 5 个自检脚本都是手动运行。建议加：

```json
"test:pdf":   "node scripts/check-pdf.mjs",
"test:docx":  "node scripts/check-docx-export.mjs",
"test:agent": "node tools/check-agent-tools.mjs"
```

### P2-3 服务端只有 stdout 日志

无文件日志、无请求 ID。排查"某个链接为什么 410"只能靠内存。建议把 key 事件（生成/撤销/失败原因）写进 SQLite 或日志文件。

---

## 三、做得好的地方

1. **类型纪律**：0 个 `any`、0 个 `@ts-ignore`，`vue-tsc` 全绿。
2. **解析层自研且可测**：`docx.ts` 698 行、`xlsx.ts` 463 行，配套 3 个自检脚本，还带真实文件基准（PDF 四份、docx 7 图 2 表）。
3. **大文件策略正确**：Worker 化 + 分批渲染 + `FatalDialog` 兜底，而不是简单删常量（这正是任务书要求的顺序）。
4. **导出保真度有实质改进**：docx 导出从 35 KB/0 图变为 502 KB/7 图，且校验了 `r:embed` 悬空与关系目标缺失。
5. **Agent 分层干净**：工具（纯函数）与模型（LLM 封装）分离，7 个工具全部 `needsModel: false`，断网可演示。
6. **协作的关键安全点守住了**：token 128 位随机、撤销即 410、只读连接不能写。

---

## 四、结论

| 维度 | 评价 |
|---|---|
| 可读性 | 良好：命名一致、注释解释"为什么"而非"是什么" |
| 类型安全 | 优秀 |
| 测试覆盖 | 中上：解析与导出有自检，UI 与协作只有冒烟 |
| 健壮性 | 中：两个 P0 与三个 P1 需修 |
| 安全性 | 中：分享页 XSS 是硬伤，其余可接受 |

**能否交付**：核心功能可用，但 **P0-1（重启丢数据）与 P0-2（XSS）必须在演示/上线前修掉**。两者改动都很小（各 10–20 行），不影响现有功能。

修复优先级：

```
1. P0-1 快照序号        10 行   数据正确性
2. P0-2 分享页消毒      20 行   安全
3. P1-3 mock 吞错       5 行    可观测性
4. P1-1 房间回收        15 行   稳定性
5. P1-2 增量裁剪        10 行   长期可用
```
