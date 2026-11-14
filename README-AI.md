# LiteOffice AI 工作副本（agent + RAG 实验区）

> **这不是 GitHub 上的那一份。** 这是独立副本，没有 `.git` 目录，无法误提交、误推送。
> 上游仓库：`C:\Users\16595\Documents\GitHub\liteoffice-practice`（分支 `feat/vue-rewrite`，提交 `995b3ac`）

## 为什么单独一份

```
上游仓库   保持与 GitHub 一致，只做"已验收"的改动
本副本     随便改、随便试、可以跑不起来，不影响上游
```

**没有 `.git`，所以：** `git push` 在这里根本不存在，物理上不可能污染 GitHub。

## 这里比上游多了什么

| 内容 | 位置 | 说明 |
|---|---|---|
| **ReAct 编排** | `code/agent/app/graph.py` | think → act → 循环 → final，步数上限 5 |
| ReAct 自检 | `code/agent/app/test_react.py` | 13 项断言 |
| **文体判定** | `code/agent/app/classify_genre.py` | 6 类：公文/实验报告/论文/议论文/记叙文/说明文 |
| **查询扩展** | `code/agent/app/query_expand.py` | 18 组同义词 + RRF 融合 |
| **知识库** | `code/agent/app/kb.py` | 入库 / 切块 / 术语 / BM25 检索 |
| **语料** | `code/agent/data/web/gongwen/` | 7 份抓取的公文（含 meta.json 来源） |
| **评测集** | `code/agent/data/eval/` | 22 道原词题 + 10 道同义题 |
| **知识库文件** | `code/agent/data/lab_kb.db` | 25 份文档 / 147 块 |
| 工具脚本 | `code/agent/tools/` | 建库、抓取、评测、体检 |

## 怎么跑

### 第一次运行（别人 clone 下来照着做）

```bash
# 1. 装依赖
cd code/agent
pip install -r requirements.txt

# 2. 配 key（可选，不配也能跑）
copy .env.example .env      # Windows
# 编辑 .env，填 DEEPSEEK_API_KEY=sk-你的key
# key 在 https://platform.deepseek.com/api_keys 申请

# 3. 起服务（会自动读取 .env）
cd ../..
pwsh -File scripts/start-agent.ps1
# 打开 http://127.0.0.1:8101/health 看到 {"ok":true} 就算成功
```

**没有 key 会怎样？** 照样能用，只是变"离线模式"：

```
Agent       启发式规划（按关键词选工具）+ 抽取式回答，返回 mock=true
文档检查    纯规则，本来就不用模型（分数、建议都照常）
知识库问答  抽取式：直接给检索命中的原文句子 + 来源标注
专业改写    术语替换 + 文体清单，不生成新句子
```

也就是说：**不填 key 是功能降级，不是不能用**。前端面板会显示「离线模拟」标签，避免让人误以为是模型答的。

> 为什么仓库里没有 key：key 一旦提交，等于把账号额度公开（公开仓库几分钟内就会被扫到）。
> 正确做法是 `.env.example` 只列变量名，`.env` 写本地值并在 `.gitignore` 里排除。

### 日常自检

```bash
cd code/agent

# 1. 知识库自检（不依赖模型）
python -m app.test_kb

# 2. ReAct 循环自检（不依赖模型）
python -m app.test_react

# 3. 文体判定自检
python ../tools/../tests/test_classify.py   # 或直接跑 code/agent/tools 下的脚本

# 4. 检索评测
python tools/eval_kb.py          # 22 道原词题
python tools/eval_expand.py      # 同义扩展前后对比

# 5. 起服务（方式二：直接 uvicorn）
python -m uvicorn app.main:app --port 8100
```

## 当前实测数字

| 指标 | 值 |
|---|---|
| 知识库规模 | 25 份 / 147 块 / 约 4.5 万字 |
| 原词提问 recall@1 | 22/22 = 100% |
| 换说法提问 recall@1 | 70% → **80%**（加同义扩展） |
| 换说法提问 recall@3 | 70% → **90%** |
| precision@3 | 0.682（缺重排） |
| 文体判定（公文族） | 7/7 抓取公文判为公文 |

## 已知问题（待修）

```
① 单段超长的 docx（如 7468 字只有 3 段）切块过大 → 检索精度下降
   修法：切块时对每段再做一次 600 字硬切
② 代词指代检索不到（"这个项目怎么处理"）
③ 没有向量检索 → 同义词表覆盖不到的说法仍会漏
④ 改写的生成链路未接（有材料包，没拼 prompt）
```

## 怎么把成果搬回上游

**只搬经过验证的文件，逐个来**：

```powershell
# 例：把 ReAct 编排搬回上游
Copy-Item C:\deepseekharness\liteoffice-ai\code\agent\app\graph.py `
          C:\Users\16595\Documents\GitHub\liteoffice-practice\code\agent\app\graph.py

# 然后在上游跑一遍自检，确认没退步，再提交
```

**不要整目录覆盖**——上游有它自己的 docs 与配置，覆盖会丢东西。

## 隔离规则

```
1. 本副本不做 git init（保持"不可推送"）
2. 上游的任何改动都要先在本副本验证，再手动搬
3. 数据文件（lab_kb.db、抓取的网页）只留在副本，不进上游
4. 抓取内容仅用于课程实验，引用须注明来源（见各 meta.json）
```
