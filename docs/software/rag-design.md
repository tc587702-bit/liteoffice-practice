# LiteOffice RAG 设计

版本 v1.0｜2026-10-26｜目标：让 AI 回答"基于当前文档"，并能点回原文段落

---

## 一、先定三件事

| 决策 | 选项 | 本项目选择 | 理由 |
|---|---|---|---|
| **索引放哪** | 浏览器 / 服务端 | **浏览器（IndexedDB）** | 单文档问答、断网可用、文件不上传；服务端版留作可选 |
| **embedding 谁算** | 本地模型 / API | **两者都支持，默认本地** | 本地=零成本零上传；API=中文质量更好，用户可选 |
| **检索方式** | 纯向量 / 纯关键词 / 混合 | **混合（向量 + BM25，RRF 融合）** | 向量对"同义改写"好，关键词对"专有名词/编号"好，混合最稳 |

> 只做向量是常见误区：查"1N4001"这种型号，关键词召回比向量准得多。

---

## 二、整体流程

```
文档 HTML
   │ ① 切块（按标题层级 + 段落，300–500 字，带元信息）
   ▼
 块列表 [{id, text, meta:{blockIndex, headingPath, type}}]
   │ ② 向量化（本地模型或 API）      ③ 关键词索引（BM25，可即时建）
   ▼                                   ▼
 IndexedDB: chunks + vec         内存倒排表
   │ ④ 检索：向量 top-k ∪ BM25 top-k → RRF 融合
   ▼
 top 5 块 + 元信息
   │ ⑤ 组装 prompt：编号材料 + 问题，要求输出 [n] 引用
   ▼
 回答（含 [1][2]）
   │ ⑥ 点 [n] → meta.blockIndex → 滚动并高亮 2 秒
```

---

## 三、① 切块策略（决定上限）

| 规则 | 取值 | 原因 |
|---|---|---|
| 基本单位 | 标题 → 段落 → 表格行组 | 段落是最小语义单元 |
| 目标长度 | 300–500 字 | 太短丢上下文，太长挤占 prompt |
| 超长段落 | 按句号切，重叠 1 句 | 避免语义被切断 |
| 表格 | 表头 + 每 10 行一块 | 保留"列名-值"对应关系 |
| 块元信息 | `blockIndex`（用于定位）、`headingPath`（用于回答里说"在第 2 章"）、`type` | 引用可追溯的关键 |

> 切块质量比 embedding 模型重要。同样 384 维模型，切得好差 20 个点。

---

## 四、② 向量化

### 方案 A（默认）：本地 transformers.js

```ts
// 首次使用时下载 ~23 MB 模型，之后浏览器缓存
import { pipeline } from '@huggingface/transformers'
const embed = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5')
const vec = await embed(text, { pooling: 'mean', normalize: true })   // 512 维
```

| 优点 | 缺点 |
|---|---|
| 零 API 成本、离线可用、内容不出本机 | 模型 23 MB，首启慢；中文质量中等 |

### 方案 B：API（OpenAI 兼容）

```http
POST {baseURL}/embeddings
{ "model": "text-embedding-3-small", "input": ["块1", "块2"] }
```

| 服务商 | 模型 | 维度 | 备注 |
|---|---|---|---|
| OpenAI | text-embedding-3-small | 1536 | 中文不错，按量计费 |
| 智谱 | embedding-3 | 2048 | 国内直连，但浏览器 CORS 未验 |
| 本地 Ollama | nomic-embed-text | 768 | 需要本地起服务 |

### 缓存（必须做）

```
key   = sha256(块文本)
value = 向量
```

同一段文字改了又改回，不会重复计算；换 embedding 模型时按 `model` 分命名空间。

---

## 五、③ 存储：IndexedDB

```ts
// 复用现有 src/lib/db.ts 的封装
interface ChunkRow {
  id: string          // `${docId}:${blockIndex}`
  docId: string
  text: string
  meta: { blockIndex: number; headingPath: string; type: string }
  vec: Float32Array   // 512 或 1536 维
  model: string       // 换模型时区分
  hash: string        // 内容哈希，文件变了就失效
}
```

索引：`docId`（取某文档所有块）、`hash`（去重）。

---

## 六、④ 检索：混合 + RRF

```ts
// 向量：暴力余弦（1 万块 × 512 维 ≈ 5M 次乘加，实测 <30ms）
const vecHits = chunks.map(c => ({ c, s: dot(q, c.vec) })).sort(b => a.s).slice(0, 20)

// 关键词：BM25（k1=1.2, b=0.75），中文按 2-gram 切
const kwHits = bm25.search(query, 20)

// RRF 融合：score = Σ 1/(60 + rank)
const fused = mergeByRRF(vecHits, kwHits).slice(0, 5)
```

**为什么 RRF**：两路分数不可比（余弦 0–1，BM25 无上界），用排名融合不需要调权重。

---

## 七、⑤ 组装 prompt（带引用）

```text
你是文档助手。只依据下面材料回答，不要编造。
每条材料前有编号，引用时写成 [1][2]。

[1] （第 2 章 · 第 14 段）实验采用 1N4001 硅二极管……
[2] （表格 1 · 第 3 行）0.6V / 1.2mA……
[3] （第 3 章 · 第 22 段）……

问题：这次实验测了哪些电压点？
```

要求：材料总长 ≤ 2000 字（约 3000 token），超了按分数截断。

---

## 八、⑥ 引用定位（这是差异化点）

```
回答里出现 [2]
  → 查 fused[1].meta.blockIndex = 42
  → 编辑区滚动到第 42 块，加 class="lo-cite-flash"（2 秒后移除）
```

没有这一步，RAG 就只是"看起来像知道"；有了它，用户能核对，也是评审最看重的"来源可追溯"。

---

## 九、评测（必须做，否则无法证明 RAG 有用）

`scripts/check-rag.mjs`：10 个问题 + 期望命中的块索引。

```
指标：
  recall@3     正确块是否进前 3         目标 ≥ 0.8
  citation@1   引用是否指向正确块       目标 ≥ 0.7
  拒答率       问文档里没有的东西时应说"不知道"   目标 100%
```

三种配置对比，写进报告：

| 配置 | recall@3 | 说明 |
|---|---|---|
| 纯 BM25 | 基线 | 专有名词强、同义改写弱 |
| 纯向量 | 中 | 反之 |
| 混合 RRF | 最高 | 预期 |

---

## 十、落地步骤与工期

| 步骤 | 内容 | 工期 | 依赖 |
|---|---|---|---|
| 1 | 切块 + 元信息 + 单测 | 0.5 天 | 无 |
| 2 | BM25 关键词检索 + 评测脚本（**不需要模型**） | 0.5 天 | 无 |
| 3 | 本地 embedding（transformers.js）+ IndexedDB | 1 天 | 模型下载 |
| 4 | 混合检索 + RRF + prompt 组装 | 0.5 天 | 2、3 |
| 5 | 引用定位（滚动高亮） | 0.5 天 | 4 |
| 6 | 评测报告（三种配置对比） | 0.5 天 | 全部 |

合计 **3.5 天**。**第 2 步就能演示**（纯关键词问答 + 引用），不依赖任何 API Key。

---

## 十一、服务端版（可选，对应图上的数据层）

如果要把 RAG 放进 `code/agent`：

```
POST /v1/rag/index   { docId, chunks[] }        → 存 SQLite BLOB
POST /v1/rag/query   { docId, question, topK }  → 混合检索 + 生成
```

存法：`chunks(doc_id, id, text, meta_json, vec BLOB)`，检索仍是暴力扫描（SQLite 存 1 万条 512 维 ≈ 20 MB，可接受）。

要"图上完整版"再换 PostgreSQL + pgvector：

```sql
CREATE EXTENSION vector;
ALTER TABLE chunks ADD COLUMN embedding vector(512);
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops);
```

**不建议现在做**：pgvector 需要 Docker 或装 Postgres，而浏览器版已经满足"单文档问答"。

---

## 十二、风险与边界

| 风险 | 应对 |
|---|---|
| 模型 23 MB，首次加载慢 | 显示下载进度；缓存后可离线 |
| 中文 embedding 质量一般 | 混合检索兜底；评测证明够用 |
| 大文档块数多（10 万段） | 只索引前 N 块并提示；或分章节按需索引 |
| 文件改了索引过期 | 用内容哈希比对，变化时重建（增量：只重算变化的块） |
| 回答编造 | prompt 明确"只用材料"，并做"无相关材料时拒答"测试 |
| 引用错位 | 引用基于 `blockIndex`，比按文本搜索定位可靠 |
