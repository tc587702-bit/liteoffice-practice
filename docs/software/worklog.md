# 工作日志

最后更新：2026-11-07 17:30

关于两种「日志」，先说清区别：

| 类型 | 位置 | 用途 |
|---|---|---|
| **运行时日志** | `code/agent/logs/*.log` | 服务输出的错误与访问记录，**已被 git 忽略** |
| **工作日志**（本文） | `docs/software/worklog.md` | 人工记录的改动、验证、遗留问题，进版本库 |

---

## 一、运行时日志怎么看

```powershell
# Agent 服务日志
cd C:\deepseekharness\liteoffice-ai\code\agent
Get-ChildItem logs | Sort-Object LastWriteTime -Descending | Select-Object -First 4
Get-Content logs\api8.err.log -Tail 20        # 最近的报错

# 只保留最近的日志（旧的可删）
Get-ChildItem logs\*.log | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item
```

启动方式（日志按次数编号，不会覆盖）：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8101 `
  *> logs\api_$(Get-Date -Format HHmm).out.log
```

`.gitignore` 已包含 `logs`、`*.log`、`code/agent/logs/`，**运行时日志不会进仓库**。

---

## 二、2026-11-07 工作记录

### 1. 建立隔离副本（16:20）

| 动作 | 结果 |
|---|---|
| 复制上游仓库到 `C:\deepseekharness\liteoffice-ai` | 121 个文件 |
| 排除 `.git` / `node_modules` / `dist` / `data` | 副本无 git，无法误推 |
| 把实验区成果搬进副本 | agent 代码、语料、评测集、知识库 |

验证：`副本文件数 148，含 .git = False`，上游 `git status` 干净。

### 2. 后端 Agent + RAG 落地（14:00–17:00）

新增：

```
app/pipelines.py        214 行  问答 / 专业改写两条链路
app/query_expand.py      88 行  18 组同义词 + RRF 融合
app/classify_genre.py   146 行  文体判定（6 类）
app/test_pipelines.py    66 行  16 项自检
app/test_agent_kb.py     53 行  12 项自检
tools/e2e_api.py         41 行  接口端到端
tools/e2e_real.py        54 行  真模型三条链路
tools/scrape.py         138 行  网页抓取（守 robots、限速）
tools/build_kb.py        81 行  建库（网页 + docx）
tools/eval_kb.py         58 行  22 题检索评测
tools/eval_expand.py     57 行  同义扩展前后对比
```

修改：

```
graph.py    ReAct 循环（think → act → 循环 → final，上限 5 步）
graph.py    总结类问题跳过工具、final 阶段带正文
tools.py    新增 kb_search；search_document 改 2-gram 按词匹配
llm.py      DeepSeek 直连 + 三重重试（LiteLLM 保留给其他服务商）
main.py     +2 路由：/v1/kb/{kb}/qa、/v1/kb/{kb}/rewrite
kb.py       HTML 判定修复（公文标题里的 < > 曾误判）
```

验证数字：

| 项 | 结果 |
|---|---|
| 知识库 | 25 份 / 147 块 / 4.5 万字 |
| 原词提问 recall@1 | 22/22 = 100% |
| 换说法 recall@1 | 70% → 80%（同义扩展） |
| 换说法 recall@3 | 70% → 90% |
| precision@3 | 0.682（缺重排） |
| 真模型问答 | 6 秒，带 `[1][2]` 引用 |
| 真模型改写 | 2.5 秒，术语替换 + 检查清单 |
| 真模型总结 | 7–39 秒（DeepSeek 负载波动） |

### 3. 前端接入与清理（13:00–17:00）

```
同步墨刀 AI 面板          AiAssistantPanel.vue / agentClient.ts / aiPanelState.ts
                         Sidebar 角标「预留」→「可用」，点击打开面板
                         Toaster 面板打开时让到左侧（原来挡住输入框）
删除孤儿文件              src/lib/agent/tools.ts（423 行，能力已迁到后端）
                         tools/check-agent-tools.mjs（随之失效）
删空目录                  src/lib/agent/
前端规模                  59 文件 / 7,215 行 → 42 文件 / 6,107 行
```

### 4. 代码质量清理（16:00–17:30）

共 **117 条**，明细见 [code-quality-fixes.md](code-quality-fixes.md)。

| 文件 | 条数 |
|---|---|
| `lib/docx.ts` | 16 |
| `lib/markdown.ts` | 14 |
| `lib/pdf.ts` | 5 |
| `lib/xml.ts` | 4 |
| `pages/Editor.vue` | 5 |
| `lib/exporter.ts` | 1 |
| `src/index.css` | 11 |
| `app/pipelines.py` | 1 |
| Python（ruff） | 60 |

顺带修的真 bug：

```
字母编号第 27 项回绕成 "a"（Word 应是 "aa"）
→ 新增 letters()，支持 aa / ab …
```

### 5. 接真模型（15:00–16:30）

| 问题 | 现象 | 处理 |
|---|---|---|
| LiteLLM 拉价格表 | SSL 失败后卡 80 秒 | DeepSeek 改直连，LiteLLM 留给其他服务商 |
| 偶发 500 | 同一请求有时成功有时失败 | 三重重试（5xx 才重试） |
| 空答案 | 推理模型把 token 花在思考上 | 回退抽取式回答，不返回空 |
| 总结没正文 | final 只给工具结果 | 带上 3000 字正文片段 |
| 前端超时 | 30 秒不够 | 放宽到 90 秒 |

---

## 二之二、2026-11-14 Agent 与文档耦合改造（7 个任务）

依据《Agent与文档耦合改造任务书》，让 Agent 真正贴着「当前文档」工作。
约束全部遵守：未 `git init`、未碰上游、数据文件只读、未加依赖、未做向量检索、未让 Agent 写正文。

### 1. 改造项与落点

| 任务 | 改动文件 | 具体做什么 |
|---|---|---|
| T1 Observation 进 prompt | `graph.py` | 新增 `_observation_digest`（单条 ≤600 字、按工具挑字段）与 `_history_text`（总长 ≤3000，超长保留最近 3 条） |
| T2 action_input 打通 | `graph.py` | `AgentState.action_params` + `_sanitize_params`（白名单 + str/int 校验）+ act 三级优先级（模型参数 > 正则兜底），执行后清空 |
| T3 检索类可换词重查 | `graph.py` | `RETRIEVAL_TOOLS` / `MAX_REPEAT=2`；相同 query 拒绝；非检索工具仍不可重复；离线分支保持单次（否则基线第 4 项会变） |
| T4 docmap 组装上下文 | `graph.py` | 新增 `_build_context`：已读章节 → query 指向章节 → 检索命中整段 → 章节标题清单 → 开头兜底，每段带 `【第 N 段｜标题】`，预算 4000 字 |
| T5 QA 双源检索 | `pipelines.py` / `main.py` | `qa(..., doc_html, doc_top_k)`；`_doc_hits` / `_doc_citations`；引用带 `source: doc/kb`；prompt 分【当前文档】/【知识库】；抽取式答案标记 `[文档·N]` / `[kb·N]` |
| T6 前端接选区 + 两入口 | `agentClient.ts` / `kbClient.ts` / `issueMarks.ts` / `AiAssistantPanel.vue` / `index.css` | 传 selection/sessionId；引用标签点击定位（`markRefs`）；选区提示条；「问知识库」「改写选区」按钮；改写结果可复制并提示不会改正文 |
| T7 答案带位置 + 跨轮记忆 | `graph.py` / `main.py` | `run_agent` 返回 `refs`（hits + 答案里的【第 N 段】双重来源）与 `queryUsed`；`resolve_reference` 指代消解（拼接不替换）；`_SESSIONS` 内存缓存（TTL 30 分钟 / 上限 200 / 只存摘要不存 html） |

顺带修掉的原有缺陷：

```
INTENTS 关键词互相遮蔽：doc_brief 与 get_outline 都吃「大纲/目录/结构」，kb_search 与 diagnose_report 都吃「规范」
→ 同一关键词只保留优先级最高的一条
action_input 被 think 解析后直接丢弃（D2 断点）
→ 现在真正传给工具，且过白名单
final 用 html[:3000] 盲截开头
→ 改为按需组装，第 5 节内容不会被截掉
```

### 2. 验证数字

| 自检 | 改造前 | 改造后 |
|---|---|---|
| `app.test_kb` | 20 | 20 |
| `app.test_react` | 13 | 43 |
| `app.test_pipelines` | 16 | 34 |
| `app.test_agent_kb` | 12 | 18 |
| 合计 | 61 | 115 |
| `ruff check` | 0 | 0 |
| `vue-tsc --noEmit` | 0 | 0 |
| `vite build` | ✓ | ✓（主包 217.0 kB）|

浏览器端到端（Edge + 真模型，安置情况汇报.docx）：

```
选区提示      已选中 51 字：根据市委市政府工作安排…
引用标签      第 6 段 / 第 16 段 / 第 19 段（点第一个，正文 .lo-ref-flash 命中）
问知识库      依据 7 条，本文·14 + kb·6/kb·7 混排
请求           POST /v1/agent/run（带 selection/sessionId）、POST /v1/kb/lab/qa（带 html）
页面错误      0
```

### 3. 改造中发现的三个坑

| 问题 | 现象 | 处理 |
|---|---|---|
| refs 为空 | 模型选了 `diagnose_report`（无 hits），前端无引用可点 | 从答案的【第 N 段】标记反推 refs，`from: "answer"` |
| 离线分支自动重查 | 基线「默认先检索」断言从 1 个工具变成 2 个 | 换词重查只留给模型分支；离线没有可靠第二组检索词 |
| 数字章节号 | 「第五部分」在只有「五、」的文档里查不到 | 数字 key 映射回中文再查一次 |

---

## 三、当前验证状态

```
vue-tsc --noEmit              0 错误
vite build                    ✓ 通过（主包 217.0 kB）
ruff check                    0 问题
app.test_kb                   20 项 全过
app.test_react                43 项 全过（改造前 13）
app.test_pipelines            34 项 全过（改造前 16）
app.test_agent_kb             18 项 全过（改造前 12）
DOCX 导出（2 图）              图片 2 / 关系 2 / 悬空 0
PDF 解析（4 页）               1199 字 / 199 ms
Markdown 回归                 11 例全过（含 2 条 XSS）
编号回归                      1. 2. a) b) 3. a) 正确
```

服务：

```
http://127.0.0.1:5198/        前端（副本构建版）
http://127.0.0.1:8101/health  Agent + RAG
```

---

## 四、待办

| 优先级 | 事项 | 说明 |
|---|---|---|
| 高 | 知识库问答接前端入口 | ✅ 2026-11-14 已接（面板「问知识库」，带当前文档做双源） |
| 高 | 选区「专业改写」接前端 | ✅ 2026-11-14 已接（面板「改写选区」，结果可复制，不自动改正文） |
| 中 | 把修复同步回上游仓库 | 三份代码目前状态不一致 |
| 中 | 向量检索 + RRF | 补同义词表覆盖不到的说法 |
| 低 | 切块修复（单段超长硬切 600 字） | 有一份 docx 7468 字只有 3 段 |
| 低 | 导出保真度（嵌套列表、页面设置、超链接） | 见技术债 |

---

## 五、给下一位接手的人

```powershell
# 1. 先确认自己在副本，不是上游
cd C:\deepseekharness\liteoffice-ai
Test-Path .git          # 必须是 False

# 2. 跑一遍自检（约 30 秒）
cd code\agent
python -m app.test_kb; python -m app.test_react
python -m app.test_pipelines; python -m app.test_agent_kb

# 3. 起服务
python -m uvicorn app.main:app --port 8101
cd ..\frontend; npm run build

# 4. 浏览器打开
#    http://127.0.0.1:5198/
```

注意三点：

```
① 上游仓库（Documents\GitHub\liteoffice-practice）保持干净，不要直接改
② 墨刀工作区只用来对照，改动以副本为准
③ 涉及模板字符串的代码替换，用 Python 脚本写文件，别用 PowerShell
```
