# LiteOffice

浏览器里打开、预览、编辑 Office 文档的轻量办公工具，配套本地 AI 助手（文体识别 / 语病检查 / 知识库问答 / 多人协作）。

> 软件实践课程小组项目。**本目录是 AI 工作副本，没有 `.git`，物理上无法误推送到 GitHub。**
> 上游仓库：`Documents\GitHub\liteoffice-practice`（分支 `feat/vue-rewrite`）。
> AI 部分的详细设计与实测数据见 [README-AI.md](README-AI.md)。

---

## 隐私边界（先读这一节）

前端本身**不上传文档**：解析、编辑、导出全在浏览器内存与 IndexedDB 完成。

但本副本新增的 AI 功能会按需把内容发到本机服务，请按需启用：

| 功能 | 数据去向 | 是否需要 Key |
|---|---|---|
| 打开 / 编辑 / 导出文档 | 只在浏览器本地 | 否 |
| 语病检查（规则层） | 本机 FastAPI（127.0.0.1） | 否 |
| 知识库检索 / 问答 | 本机 FastAPI + 本地 SQLite | 否 |
| 事实常识检查、模型改写 | **会发往模型服务商**（如 DeepSeek） | 是 |
| 局域网多人协作 | **同一局域网内的其他参与者** | 否 |

**不配 Key 时不会有任何内容离开本机。** 需要模型的功能默认关闭，须显式开启。

---

## 项目结构

```
liteoffice-ai/
├── code/
│   ├── frontend/          Vue 3 应用（50 个源文件）
│   ├── agent/             FastAPI：ReAct 编排 + RAG + 语病检查
│   └── backend/           Node：局域网协作服务（Yjs CRDT + WebSocket）
├── docs/                  需求 / 管理 / 设计 / 作业文档
├── scripts/
│   └── start-agent.ps1    启动 agent（自动读 code/agent/.env）
└── README-AI.md           AI 工作副本说明与实测数字
```

`docs/software/prototype/` 是**冻结的设计基准**：配色、间距、动效以它为准，只读不改。

---

## 快速开始

### 只用编辑器（无需后端）

```bash
cd code/frontend
npm install          # 5 个运行时依赖：vue / vue-router / pinia / xlsx / pdfjs-dist
npm run dev          # http://localhost:5173/
npm run build        # 类型检查 + 生产构建
npm run typecheck    # vue-tsc --noEmit
```

### 加上 AI 助手

```powershell
cd code/agent
pip install -r requirements.txt

# 配 Key（可选，不配也能跑，只是降级为离线模式）
Copy-Item .env.example .env
notepad .env         # 填 DEEPSEEK_API_KEY=你的key

cd ../..
pwsh -File scripts/start-agent.ps1
# 看到 http://127.0.0.1:8101/health 返回 {"ok":true} 即成功
```

**Key 只从环境变量 / `.env` 读取，绝不写进代码。** `.env.example` 只列变量名。
这样别人拉下代码是「没有 Key」的降级状态，不会泄露额度。

没有 Key 时的行为：

```
Agent        启发式规划（关键词选工具）+ 抽取式回答，返回 mock=true
语病检查     规则层照常（8 类检查全部可用）
知识库问答   抽取式：给检索命中的原文 + 来源标注
改写         规则修正 + 术语替换，不生成新句子
事实检查     跳过，返回 factCheckState=nokey 并如实说明
```

前端会显示「离线模拟」标签，避免把规则结果误认成模型输出。

### 局域网多人协作

```powershell
cd code/backend
npm install          # ws / yjs / y-protocols
npm start            # 监听 3000，绑定所有网卡
```

默认监听全部网卡，同一局域网可访问。用本机 WLAN 地址（如 `http://10.40.10.248:3000`）分享给他人。
文档通过分享链接打开，链接分**只读**与**可编辑**两种权限，只读连接的写入会被服务端丢弃。

> 协作服务会把编辑内容在局域网参与者之间传输。仅在可信网络内使用。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3（`<script setup lang="ts">`）+ Vite + TypeScript + TailwindCSS |
| 路由 / 状态 | vue-router + Pinia |
| 文档解析 | 自研 `docx.ts` / `xlsx.ts` / `markdown.ts` / `zip.ts` / `xml.ts` |
| PDF | `pdfjs-dist`（worker 本地打包，不依赖 CDN） |
| 前端持久化 | IndexedDB（刷新可恢复） |
| AI 服务 | FastAPI + LangGraph（ReAct）+ SQLite |
| 检索 | 手写 BM25 + `bge-small-zh-v1.5` 向量（512 维）+ RRF 融合 |
| 协作 | Node + Yjs CRDT + `ws`，`node:sqlite` 持久化 |

前端依赖刻意收敛：运行时 5 个，无 UI 组件库、图标库、动画库。
**不使用 ONLYOFFICE**：编辑能力由 `contenteditable` + 自研解析器实现，体积 2 MB 级，代价是排版保真度低于专业内核。

---

## 能力与边界

### 文档格式

| 格式 | 打开 | 编辑 | 导出 |
|---|---|---|---|
| docx | ✅ 标题/段落/表格/图片/列表 | ✅ | ✅ 回写 |
| xlsx | ✅ 多工作表 | ✅ 单元格 | ✅ 回写（保留表名） |
| md | ✅ 标题/列表/代码块/表格 | ✅ | ✅ 文本 |
| pdf | ✅ 文本层 + canvas 渲染 | ❌ | 明示不支持回写 |
| pptx | ✅ 文本抽取 | ❌ | 明示不支持回写 |

### AI 能力

**11 类文体独立知识库**（按文体分库，不混存，避免跨领域词频污染 IDF）：

公文 / 实验报告 / 学术论文 / 议论文 / 记叙文 / 说明文 / 合同 / 简历 / 新闻报道 / 法律文书 / 教材讲义

每类有自己的切块策略、同义词组、术语表与评分清单。切块按语义单元定：
合同按条（300 字）、简历最小块不重叠（200）、法律文书最大块（600，说理是长链条）、
新闻保导语完整（400）、教材按知识点（350）。

**语病检查 8 类**：词语重复 / 的地得 / 错别字 / 标点 / 赘余 / 逻辑矛盾 / 时间线索 / 事实常识。
前 7 类纯规则、离线可复现；第 8 类需模型，无 Key 时跳过并如实标注。

**改写四道护栏**（防止模型擅自增删内容）：

```
① 提示约束    只改表达，不得增删事实情节
② 内容校验    数字/日期/引号内容必须全部保留，不得凭空新增
③ 幅度校验    比例与绝对字数双上限
④ 新增实词    原文没出现过的名词/动作一律拦下
      ↓
任一不过 → 不采用模型结果，退回规则版，并说明是哪一道拦的
```

②③ 的比对基线是**规则修正后的文本**，不是原文——否则规则层合法的赘余删除会被误判成内容丢失。
记叙类默认**不**走模型润色，需显式传 `allow_model_polish` 才启用（护栏 ④ 是启发式，有盲区）。

---

## 当前实测数字

语料 **77 份 / 2486 块**，向量 **2486/2486 全覆盖**（`bge-small-zh-v1.5`，512 维）：

| 文体 | 文档 | 块数 | 术语 |
|---|---|---|---|
| 学术论文 | 12 | 1337 | 5 |
| 实验报告 | 3 | 395 | 6 |
| 法律文书 | 5 | 197 | 5 |
| 记叙文 | 5 | 153 | 3 |
| 公文 | 25 | 145 | 8 |
| 议论文 | 6 | 84 | 4 |
| 教材讲义 | 3 | 41 | 5 |
| 合同 | 3 | 39 | 6 |
| 说明文 | 5 | 36 | 3 |
| 简历 | 4 | 34 | 5 |
| 新闻报道 | 6 | 25 | 5 |

检索（公文库 22 道原词题 + 10 道同义题）：

| 指标 | 值 |
|---|---|
| 原词 recall@1 / recall@3 | 22/22 = 100% / 100% |
| 同义改写 recall@1 | 70% → 80%（同义扩展） |
| 同义改写 recall@3 | 70% → 90% |
| precision@3 | 0.667（缺重排） |
| 文体判定 | 33/33 样本正确 |

混合检索相似度下限 `MIN_SIM_DEFAULT = 0.38`，由 11 库 × 55 查询实测标定
（0.45 会漏掉 3/22 个相关查询；0.38 漏 0 个、放进 3/33 个无关）。**改这个值前请重跑标定。**

语病检查（10 篇瑕疵记叙文测试集，37 条标注）：

| 类别 | 召回 |
|---|---|
| 规则可判类 | 4/4 = 100% |
| 语义层类 | 需模型，未配 Key 时不检查 |

协作服务：8 项双客户端测试全过（双向同步、并发收敛、只读隔离、新连接取历史）。

---

## 自检

```powershell
cd code/agent
foreach ($m in @('app.test_kb','app.test_react','app.test_pipelines','app.test_agent_kb',
                 'app.test_rewrite_guard','app.multigenre','app.embed','app.grammar')) {
  python -m $m
}

python tools/eval_kb.py          # 检索评测
python tools/eval_expand.py      # 同义扩展前后对比
python tools/list_docs.py        # 各文体语料规模

cd ../backend
node server/test-collab.mjs      # 协作双客户端测试
```

**已知失败 1 项**：`app.multigenre` §8「记叙文『细节描写』向量补回召回」。
根因是 `_relevance_gate` 的词面重叠闸门把纯语义召回也砍掉了（混合检索 3 条 → 过闸门 0 条）。
这是「拒答可信」与「语义召回」的取舍未定，**不要为了让测试变绿而削弱断言**。

改动后建议跑全量语法扫描——本项目曾出现文件被外部改坏导致模块导入静默失败：

```powershell
Get-ChildItem -Recurse -Filter '*.py' -File |
  Where-Object { $_.FullName -notmatch '\.venv|__pycache__' } |
  ForEach-Object { python -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" $_.FullName }
```

---

## 已知限制

**编辑器**

- PDF 只读，扫描件无文字层不支持 OCR（明确提示）
- pptx / pdf 无法回写，导出时明示，不静默产出不符的文件
- 超大工作簿（>2 MB 或 >2 万行）只加载前 N 行并标注截断
- docx 导出是 HTML 重建，分栏、文本框、页眉页脚会丢失
- 手机窄屏未做自适应

**AI**

- 语义层瑕疵（常识错误、前后矛盾）必须配 Key，规则层无法覆盖
- 代词指代检索不到（「这个项目怎么处理」缺少指代对象）
- 缺重排，precision@3 停在 0.667
- 改写护栏 ④ 是启发式，可能误拦合理同义替换，故记叙类默认不启用模型润色

**协作**

- 正文用 Yjs `Y.Text` 承载纯文本，**跨端富文本格式不保真**（换取光标稳定与合并正确）
- Vue 编辑器尚未接入协作层，目前只有分享页 `/d/<token>` 支持多人编辑
- 未做云部署与鉴权体系，仅限可信局域网

---

## 隔离规则

```
1. 本副本不做 git init（保持"不可推送"）
2. 上游的改动先在本副本验证，再手动逐个文件搬回，不要整目录覆盖
3. 数据文件（kb.db、抓取网页）只留在副本，不进上游
4. 抓取内容仅用于课程实验，引用须注明来源（见各 meta.json）
```

> ⚠️ `code/agent/data/` 下的 `kb.bak-*.db` 备份含**脱敏前**的原始个人信息。
> 对外分享或部署时只带 `kb.db` 与 `kb.db.vecmeta.json`，**不要打包整个 data 目录**。

---

## 文档

| 文档 | 内容 |
|---|---|
| [AI 副本说明](README-AI.md) | agent / RAG 设计、实测数据、搬回上游流程 |
| [文档索引](docs/README.md) | 全部文档导航与阅读顺序 |
| [问题定义（5W1H）](docs/requirements/problem_definition.md) | 为什么做、给谁用 |
| [功能需求规范](docs/requirements/functional_spec.md) | 38 条 `FR-*` + 追溯矩阵 + 验收场景 |
| [非功能需求规范](docs/requirements/nonfunctional_spec.md) | `NFR-*` 指标与实测值 |
| [RAG 设计](docs/software/rag-design.md) | 检索链路设计 |
| [Agent 架构](docs/software/agent-architecture.md) | ReAct 编排 |
| [代码地图](docs/software/code-map.md) | 模块职责与调用关系 |

---

## AI 参与说明

**本项目代码与文档由 AI 辅助生成**，人工负责需求提出、取舍决策、验收测试与问题定位。

- 前端与 agent 实现：AI 生成，人工验收（构建、类型检查、真实文件解析实测）
- 设计原型：墨刀 AI 生成，含「豆包AI」标识，按要求保留
- 文档：AI 起草，人工补充实测数据与风险项

如需在课程或公开场合展示，请如实说明上述参与方式。

---

## 许可

本仓库尚未附 LICENSE 文件（课程项目，授权方式待定）。
第三方组件遵循其自身许可：`pdfjs-dist` Apache-2.0、`xlsx` Apache-2.0、Vue MIT、Yjs MIT。