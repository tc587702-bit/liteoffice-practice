# LiteOffice AI 工作副本（agent + RAG + 协作）

> **这不是 GitHub 上的那一份。** 独立副本，没有 `.git`，无法误提交、误推送。
> 上游仓库：`C:\Users\16595\Documents\GitHub\liteoffice-practice`（分支 `feat/vue-rewrite`）
> 项目总览见 [README.md](README.md)，本文只讲 AI 部分的设计与实测。

## 为什么单独一份

```
上游仓库   保持与 GitHub 一致，只做"已验收"的改动
本副本     随便改、随便试、可以跑不起来，不影响上游
```

没有 `.git`，`git push` 在这里根本不存在，物理上不可能污染 GitHub。
**代价是改动不可回滚**——编辑前先读文件，别整目录覆盖。

---

## 三个服务，各管一段

| 服务 | 位置 | 端口 | 职责 |
|---|---|---|---|
| 前端 | `code/frontend/` | 5173 | 编辑器；直连 agent |
| agent | `code/agent/` | 8101 | ReAct + RAG + 语病检查（FastAPI） |
| 协作 | `code/backend/` | 3000 | Yjs CRDT 多人同步（Node） |

协作服务另有反向代理 `/agent/*` → `127.0.0.1:8100`（`AGENT_ORIGIN` 可改）。
**注意端口默认值不一致**：`start-agent.ps1` 用 8101，代理默认指 8100，同时用两者时需对齐。

---

## 模块地图

### 检索链路

| 文件 | 职责 |
|---|---|
| `app/kb.py` | SQLite 4 表；中文 2-gram 分词；手写 BM25(k1=1.2, b=0.75)；标题感知切块 |
| `app/embed.py` | 向量层：写入/校验/检索/RRF 融合；`MIN_SIM_DEFAULT` 阈值 |
| `app/embed_local.py` | 本地嵌入器（`bge-small-zh-v1.5`，512 维，进程内单例） |
| `app/query_expand.py` | 同义词扩展 + `rrf_merge` |
| `app/multigenre.py` | 11 类文体分库：路由 / 切块策略 / 同义词组 / 术语表 |
| `app/classify_genre.py` | 纯规则文体判定（饱和归一化 + 置信度 + 反向特征） |

### 生成与检查链路

| 文件 | 职责 |
|---|---|
| `app/graph.py` | ReAct：think → act → 循环 → final，步数上限 5 |
| `app/llm.py` | 模型层：直连 OpenAI 兼容接口 + LiteLLM 路由；无 Key 降级 |
| `app/pipelines.py` | 问答 / 改写；**改写四道护栏** |
| `app/grammar.py` | 通用语病检查 8 类 + `fix_text()` 确定性修正 |
| `app/improve.py` | 文档检查入口，按文体分流（公文四维 vs 通用语病） |
| `app/consistency.py` | 编号断号、数字矛盾、表头、单位混写 |
| `app/feedback.py` | 「这条不用改」记忆，同处不再报 |

### 协作

| 文件 | 职责 |
|---|---|
| `server/index.mjs` | HTTP + WebSocket；Yjs 房间；快照持久化；只读/编辑权限 |
| `server/db.mjs` | `node:sqlite`：documents / shares / updates / snapshots |
| `server/share.mjs` | 128 位随机 token；失败限速；撤销与过期 |
| `server/sanitize.mjs` | 防存储型 XSS |
| `public/d.html` | 分享页，已接入 Yjs 协作层 |

---

## 关键设计决策

**① 文体 = 独立知识库，不是一张大表加一列**

混存会让 BM25 的 IDF 被跨领域词频污染。分库后每类的 IDF、同义词表、术语表都保持领域内口径。
代价是路由必须准：`classify_genre` 的置信度是一等公民，低置信时**跨文体并查**而不是赌一个。

**② 短查询要用另一套判定**

`classify()` 有 20 字下限（对文档正确），但会把所有短问题拒判，导致一律走跨文体并查、小库被淹没。
解法是 `_quick_genre_hint()`：**只对已被主判定拒绝的短文本**做关键词兜底，不碰长文本行为。
用**绝对命中数 ≥1** 而非归一化分数——各类特征词表大小差异大（11–12 个词的表，单命中归一化后仅 0.08，会被阈值误拦）。

**③ 切块必须按语义单元，不能一刀切**

合同按条（300）、简历最小块不重叠（200）、法律文书最大块（600，说理是长链条推理）、
新闻保导语完整（400）、教材按知识点（350）、实验报告重复表头。

**④ 规则检查器必须先分文体再扩容**

公文评分清单套到记叙文上会产出**自信的错误建议**（实测 130 字记叙文被判「缺现状/缺措施」需返工，
而 8 处真实语病一条没报）。所以 `improve.analyze()` 按文体分流，
但**语病检查与文体无关，对所有文体包括公文都跑**。

**⑤ 形态学规则优于白名单**

叠词判定：AA 式（轻轻）合法、ABAB 动词（研究研究）合法、ABAB 状态形容词（雪白雪白）合法、
其余（开心开心/苹果苹果）判手误。按构词形态判断，不靠枚举——
枚举白名单曾导致「滚烫滚烫/碧绿碧绿/打扫打扫」全部误报。

**⑥ 宁可留缺口，不造假完整**

`check_facts()` 无 Key 时返回 `[]` 并标 `factCheckState=nokey`，不假装已覆盖事实检查。
模型输出必须**逐字命中原文**才采纳（防幻觉），且与规则层按位置去重。

---

## 怎么跑

### 第一次运行

```powershell
cd code/agent
pip install -r requirements.txt

Copy-Item .env.example .env      # 可选
notepad .env                     # 填 DEEPSEEK_API_KEY=你的key

cd ../..
pwsh -File scripts/start-agent.ps1
# http://127.0.0.1:8101/health → {"ok":true}
```

局域网内其他机器要访问时：`pwsh -File scripts/start-agent.ps1 -HostAddr 0.0.0.0`
（默认绑 127.0.0.1，**只有本机能访问**）。

**Key 绝不进代码**：`.env.example` 只列变量名，值只在运行它的那台机器上。
别人拉下代码就是「没有 Key」的降级状态，不会泄露额度。

没有 Key 时：

```
Agent       启发式规划 + 抽取式回答，mock=true
语病检查    规则层 7 类照常；事实检查跳过并标注 nokey
知识库问答  抽取式：命中原文 + 来源标注
改写        规则修正 + 术语替换，不生成新句子
```

### 协作服务

```powershell
cd code/backend
npm install
npm start                        # 监听 3000，绑所有网卡
node server/test-collab.mjs      # 双客户端同步测试
```

分享链接分 `view` / `edit` 两种权限，只读连接的写入被服务端静默丢弃。
协作库依赖走本机 `/vendor/*`（白名单托管 yjs 与 lib0），**不依赖 CDN**，断网可用。

### 日常自检

```powershell
cd code/agent
foreach ($m in @('app.test_kb','app.test_react','app.test_pipelines','app.test_agent_kb',
                 'app.test_rewrite_guard','app.multigenre','app.embed','app.grammar')) {
  python -m $m
}
python tools/eval_kb.py           # 22 道原词题
python tools/eval_expand.py       # 同义扩展前后对比
python tools/eval_synonyms.py     # 纯 BM25 的同义改写短板
python tools/list_docs.py         # 各文体规模
python tools/list_docs.py gongwen # 某一类逐份清单
```

`app.embed` 自测在**临时库**运行，不会碰生产库。

---

## 当前实测数字

### 语料

**77 份 / 2486 块 / 55 条术语**，向量 **2486/2486 全覆盖**
（`bge-small-zh-v1.5`，512 维，清单见 `data/kb.db.vecmeta.json`）

| 文体 | kb_id | 文档 | 块数 |
|---|---|---|---|
| 公文 | gongwen | 25 | 145 |
| 实验报告 | lab_report | 3 | 395 |
| 学术论文 | thesis | 12 | 1337 |
| 议论文 | essay_arg | 6 | 84 |
| 记叙文 | essay_narr | 5 | 153 |
| 说明文 | expository | 5 | 36 |
| 合同 | contract | 3 | 39 |
| 简历 | resume | 4 | 34 |
| 新闻报道 | news | 6 | 25 |
| 法律文书 | legal | 5 | 197 |
| 教材讲义 | textbook | 3 | 41 |

### 检索

| 指标 | 值 |
|---|---|
| 原词 recall@1 / @3 | 22/22 = 100% / 100% |
| MRR | 1.000 |
| precision@3 | 0.667（缺重排） |
| 同义改写 recall@1 | 70% → 80% |
| 同义改写 recall@3 | 70% → 90% |
| 文体判定 | 33/33 样本正确 |

`MIN_SIM_DEFAULT = 0.38`，11 库 × (22 相关 + 33 无关) 查询标定：

```
0.35 → 漏相关 0/22，放进无关 7/33
0.38 → 漏相关 0/22，放进无关 3/33   ← 取这个
0.40 → 漏相关 1/22，放进无关 1/33
0.45 → 漏相关 3/22，放进无关 0/33（原值，议论文/记叙文正确命中被滤掉）
```

bge-small-zh 在 2–3 字中文短查询上分数天然偏低（「论点」0.4467、「细节描写」0.3999）。
**改这个值前请重跑标定，别凭感觉调。**

### 语病检查

10 篇瑕疵记叙文测试集（37 条标注）：**规则可判类 4/4 = 100%**。
语义层 33 条需模型，未配 Key 时不检查（如实标注，不虚报）。

### 改写护栏

`app.test_rewrite_guard`：**12 项全过**。四道护栏见下节。

### 协作

`server/test-collab.mjs`：**8 项全过**——双向同步、并发收敛、只读隔离、新连接取历史。

---

## 改写四道护栏

模型润色的风险是**擅自增删内容**。真实事故：把「昨天下完雨后」改成「昨天雨后」，还加了「车轮一打滑」。

```
① 提示约束    只改表达，不得增删事实情节、数字、时间、人名
② 内容校验    数字/日期/引号内容全部保留，不得凭空新增
③ 幅度校验    比例 + 绝对字数双上限
④ 新增实词    原文没出现过的名词/动作一律拦
      ↓
任一不过 → 不采用模型结果，退回规则版，说明是哪一道拦的
```

**为什么必须有第 ④ 道**：「车轮一打滑」不含数字/日期/引号（②过），6 字 / 207 字 = 2.9%（③过）。
只靠前三道，这个真实事故用例**全部通过**。擅自添加最常见的形态就是纯叙述句，正好是 ② 的盲区。

**②③ 的基线是规则修正后的文本（`fixed`），不是原文**——
`grammar.fix_text()` 本身会做赘余删除（「涉及到」→「涉及」），拿原文比会把合法删除误判成内容丢失。

**记叙类默认不走模型**：`allow_model_polish=False`。护栏 ④ 是启发式（2-gram 差集 + 白名单），
可能误拦合理同义替换，不把风险默认摊给所有用户。

---

## 已知问题

```
① app.multigenre §8「记叙文『细节描写』向量补回召回」失败
   根因：_relevance_gate 词面重叠闸门把纯语义召回也砍了
        混合检索 3 条 → 过闸门 0 条（「细节描写」字面不在语料里）
   性质：「拒答可信」与「语义召回」的取舍未定，不是 bug 而是设计冲突
   ⚠️ 不要为了让测试变绿而削弱这条断言

② 语义层瑕疵必须配 Key，规则层无法覆盖（常识错误、前后矛盾）

③ 代词指代检索不到（「这个项目怎么处理」缺少指代对象）

④ 缺重排，precision@3 停在 0.667

⑤ Vue 编辑器未接协作层，目前只有分享页支持多人编辑
   协作正文用 Y.Text 纯文本，跨端富文本格式不保真

⑥ 未做云部署与鉴权体系，仅限可信局域网
```

---

## 踩过的坑（别重踩）

**命名撞车**：`build_kb.py` 曾用 `KB_ID="lab"` 装**公文**，而 `multigenre` 的 `lab` 指**实验报告**。
同名不同义导致公文被当实验报告范文、评测查空库出 0%。现已统一为 `gongwen` / `lab_report`，
所有脚本引用 `GENRE_KB[...]` 而非写死字符串。

**评测静默失效**：库名漂移后 `eval_kb.py` 显示 recall 0%，看着像检索能力差，实际是查了空库。
现已加空库报警——**空库跑出的 0% 是配置错误，不该当成能力问题**。

**误导文案**：向量路无命中时原来一律说「可能还没建向量」，把阈值问题误导向重建向量。
现已区分「没建向量」与「建了但最高分低于阈值」并给出实际分数。

**PowerShell 内联引号**：`python -c "...f\"...\"..."` 会被引号 mangling 破坏。
**任何非平凡脚本都写成 `.py` / `.mjs` 文件再跑**，别用内联。

**测试沉默 ≠ 通过**：某模块无输出通常是导入期 SyntaxError（曾出现文件被外部改坏）。
改动后跑全量 `ast.parse` 扫描。

**筛选正则漏报**：只匹配「失败 N 项」会漏掉「1 项失败」这种措辞，导致误报全绿。

**备份含敏感信息**：`data/kb.bak-*.db` 是**脱敏前**的库，含原始身份证号。
对外分享或部署只带 `kb.db` + `kb.db.vecmeta.json`，**不要打包整个 data 目录**。

**抓取边界**：robots.txt 禁止的站点不绕过；站点使用条款禁止批量抓取的直接排除。
多数 gov.cn 新闻正文是 JS 渲染，静态抓取只得十几字——这是工具能力边界，换源或改用本地文件。

---

## 怎么把成果搬回上游

**只搬验证过的文件，逐个来**：

```powershell
Copy-Item C:\deepseekharness\liteoffice-ai\code\agent\app\graph.py `
          C:\Users\16595\Documents\GitHub\liteoffice-practice\code\agent\app\graph.py
# 然后在上游跑一遍自检，确认没退步，再提交
```

**不要整目录覆盖**——上游有它自己的 docs 与配置，覆盖会丢东西。

## 隔离规则

```
1. 本副本不做 git init（保持"不可推送"）
2. 上游的改动先在本副本验证，再手动搬
3. 数据文件（kb.db、抓取网页）只留在副本，不进上游
4. 抓取内容仅用于课程实验，引用须注明来源（见各 meta.json）
```