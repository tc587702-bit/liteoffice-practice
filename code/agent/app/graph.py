"""
Agent 编排层：LangGraph + ReAct 循环

ReAct = Reason（想）→ Act（做）→ Observe（看结果）→ 再想 → … → Final（答）

图结构：
    START → think ──有下一步──→ act ──→ think
              │
              └──没有下一步──→ final → END

约束（缺一不可）：
  1. 步数上限 MAX_STEPS（默认 5），防止无限循环
  2. 非检索类工具不重复调用；检索类（doc_search / search_document / kb_search）
     允许最多 2 次，且第 2 次必须换词（相同 query 视为重复）
  3. 没有可用工具时直接给最终答案
  4. 每一步都记进 steps[]，前端可显示"想→做→看"全过程
  5. think 阶段能看到每个工具的关键 data（不是只有 summary）
  6. final 阶段的上下文由 docmap 按需组装，不再盲截开头

无 Key 时走启发式 planner（按关键词挑工具），流程与 ReAct 一致，便于离线演示。
"""
from __future__ import annotations

import json
import os
import re
from contextlib import suppress
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import DEFAULT_MODEL, complete, has_credentials
from .tools import run_tool, split_blocks, strip_tags, tool_manifest

MAX_STEPS = int(os.getenv("LITEOFFICE_AGENT_MAX_STEPS", "5"))

# 检索类工具：允许换词重查（最多 MAX_REPEAT 次）
RETRIEVAL_TOOLS = {"doc_search", "search_document", "kb_search"}
MAX_REPEAT = 2

# 每个工具允许模型给的参数（白名单；不在表里的工具不接受任何参数）
TOOL_PARAMS: dict[str, set[str]] = {
    "search_document": {"query"},
    "doc_search": {"query"},
    "doc_section": {"key"},
    "kb_search": {"query", "kbId", "top"},
}

# 关键词 → 工具（顺序即优先级；一个请求可触发多个工具）
# 注意：同一关键词只保留在优先级最高的那一条，避免互相遮蔽（原 M1 缺陷）
INTENTS: list[tuple[str, str]] = [
    (r"优化|改进|提升|润色建议|哪里要改|有什么问题|建议", "doc_improve"),
    (r"第\s*[一二三四五六七八九十\d]+\s*(部分|节|章)|哪一节|这一节|那一节", "doc_section"),
    (r"分几(个)?部分|几个章节|讲了什么|概要|概括", "doc_brief"),
    (r"表格|表里|行列", "doc_tables"),
    (r"知识库|规范|标准|依据|参照|范文|政策|文件里", "kb_search"),
    (r"文档里|本文里|文中|这份文档中|正文里", "doc_search"),
    (r"统计|字数|多少字|几个表|图片数|阅读|篇幅", "get_stats"),
    (r"大纲|目录|几级标题|章节", "get_outline"),
    (r"体检|检查|毛病|校对|诊断", "diagnose_report"),
    (r"表格.{0,8}(检查|问题|列|对齐)|列数", "check_tables"),
    (r"标题.{0,8}(检查|问题|跳级)|层级", "check_headings"),
    (r"重复|一样|两次|雷同", "check_duplicates"),
    (r"搜索|查找|找一下|在哪|检索|关键词", "search_document"),
]

ZH_NUM = {
    "一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
    "六": "6", "七": "7", "八": "8", "九": "9", "十": "10",
}

SUMMARIZE_RE = r"总结|概括|摘要|讲了什么|主要内容|归纳|大意|核心内容"


class AgentState(TypedDict, total=False):
    html: str
    query: str
    model: str | None
    pending: list[str]      # 待执行工具（启发式计划）
    used: list[str]         # 已执行工具
    observations: list[dict[str, Any]]
    steps: list[dict[str, Any]]
    answer: str
    mock: bool
    action_params: dict[str, Any]   # think 解析出的 action_input，供 act 消费
    selection: str                  # 用户在正文里选中的文本（为空表示没选）
    selection_anchor: int | None    # 选区起始块号（0 起），供答案定位


def _step(state: AgentState, phase: str, detail: str) -> list[dict[str, Any]]:
    steps = list(state.get("steps") or [])
    steps.append({"phase": phase, "detail": detail})
    return steps


# ---------------------------------------------------------------- 参数推导

def _clean_search_query(query: str) -> str:
    """去掉疑问词与标点，留实词当检索词"""
    kw = re.sub(r"[？?。，,！!；;：:]|多少|是什么|是哪些|怎么样|如何|是否|吗|呢|请问|帮我|查一下", " ", query)
    return re.sub(r"\s+", " ", kw).strip()


def _has_substance(text: str) -> bool:
    """判断一句话里有没有可检索的实词（去掉疑问词后还剩 2 个以上汉字）"""
    return len(re.sub(r"[^\u4e00-\u9fa5]", "", _clean_search_query(text))) >= 2


def _search_seed(query: str, selection: str) -> str:
    """
    检索词来源：用户原句优先；原句只是指代（"这段""它有什么问题"）时改用选区。

    原缺陷：用户选中一段后问"这段有什么问题"，_clean_search_query 把疑问词
    全删掉后只剩"这段"，检索必然落空。
    """
    if _has_substance(query):
        return query
    sel = (selection or "").strip()
    if len(sel) >= 4:
        return sel[:200]
    return query


def _params_from_query(tool: str, query: str, attempt: int = 0, selection: str = "") -> dict[str, Any]:
    """
    从用户原句用正则推导工具参数（兜底路径）。

    attempt > 0 表示这是第 2 次调用同一个检索工具：把 query 换一种说法。
    selection 非空时，指代型问题（"这段…"）改用选区内容当检索词。
    """
    if tool == "doc_section":
        m = re.search(r"第\s*([一二三四五六七八九十\d]+)\s*(?:部分|节|章)", query)
        if m:
            return {"key": ZH_NUM.get(m.group(1), m.group(1))}
        key = re.sub(r"读一下|看看|讲讲|这一节|那一节|的内容|是什么", "", query).strip()
        return {"key": key}

    seed = _search_seed(query, selection)

    if tool == "doc_search":
        q = re.sub(r"文档里|本文里|文中|找一下|搜索|查一下|在哪|[？?。，,]", "", seed).strip() or seed
        return {"query": _variant(q, attempt)}

    if tool == "search_document":
        q = _clean_search_query(seed) or seed.strip()
        return {"query": _variant(q, attempt)}

    if tool == "kb_search":
        q = re.sub(r"知识库|规范|标准|依据|参照|范文|政策|帮我|看看|查一下|查查", "", query).strip() or query
        return {"query": q, "kbId": os.getenv("LITEOFFICE_KB_ID", "lab")}

    return {}


def _variant(query: str, attempt: int) -> str:
    """第 2 次检索换了说法：优先用同义词扩展，其次加"相关"后缀"""
    if attempt <= 0 or not query:
        return query
    variants: list[str] = []
    # 同义扩展不可用时不该影响主流程，直接用"相关"后缀兜底
    with suppress(Exception):
        from .query_expand import expand

        variants = [v for v in expand(query) if v != query]
    if variants:
        return variants[min(attempt - 1, len(variants) - 1)]
    return f"{query} 相关"


def _sanitize_params(action: str, raw: Any) -> dict[str, Any]:
    """
    校验模型给的 action_input：只接受白名单内的键与 str/int 值。

    action_input 属不可信输入，白名单外一律丢弃。
    """
    allowed = TOOL_PARAMS.get(action, set())
    if not allowed or not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in allowed or isinstance(value, bool):
            continue
        if isinstance(value, int):
            out[key] = value
        elif isinstance(value, str) and value.strip():
            out[key] = value.strip()
    if action == "kb_search":
        out.setdefault("kbId", os.getenv("LITEOFFICE_KB_ID", "lab"))
    return out


# ---------------------------------------------------------------- 观察摘要

def _observation_digest(obs: dict[str, Any], limit: int = 600) -> str:
    """
    把一个观察结果压缩成「模型看了有用」的文本。

    不是 json.dumps：只挑该工具真正有用的字段，避免 prompt 被表格/长文本灌爆。
    """
    if not obs.get("ok"):
        return str(obs.get("summary", "（工具失败）"))[:limit]

    tool = obs.get("tool", "")
    data = obs.get("data") or {}
    parts: list[str] = []

    if tool in ("doc_search", "search_document"):
        for h in (data.get("hits") or [])[:5]:
            idx = h.get("block", h.get("blockIndex", 0))
            parts.append(f"段落{idx + 1}：{h.get('snippet', '')}")
    elif tool == "kb_search":
        for h in (data.get("hits") or [])[:3]:
            head = f"《{h.get('doc', '')}》"
            if h.get("heading"):
                head += f" {h['heading']}"
            parts.append(f"{head}：{h.get('snippet', '')}")
    elif tool == "doc_brief":
        parts.append(str(data.get("brief", "")))
    elif tool == "doc_section":
        parts.append(f"{data.get('title', '')}：{data.get('text', '')}")
    elif tool == "doc_tables":
        rows = ((data.get("tables") or [{}])[0] or {}).get("rows") or []
        for row in rows[:5]:
            parts.append(" | ".join(row))
    elif tool == "doc_improve":
        report = data.get("report") or {}
        for it in (report.get("issues") or [])[:3]:
            parts.append(f"[{it.get('levelLabel', '')}] {it.get('problem', '')}")
    elif tool == "diagnose_report":
        for it in (data.get("issues") or [])[:3]:
            title = it.get("title") or it.get("detail") or ""
            parts.append(f"[{it.get('severity', '')}] {title}")

    if not parts:
        parts.append(str(obs.get("summary", "")))
    return "\n".join(p for p in parts if p)[:limit]


def _history_text(observations: list[dict[str, Any]], limit_total: int = 3000) -> str:
    """把历史观察拼成 prompt 片段：带参数、带内容摘要，超长时保留最近 3 条"""
    if not observations:
        return "（还没有执行任何动作）"
    blocks: list[str] = []
    for o in observations:
        params = o.get("params") or {}
        pstr = ", ".join(f"{k}={v}" for k, v in params.items())
        blocks.append(
            f"Action: {o.get('tool', '')}({pstr})\nObservation: {_observation_digest(o)}"
        )
    text = "\n\n".join(blocks)
    if len(text) > limit_total:
        text = "\n\n".join(blocks[-3:])[:limit_total]
    return text


# ---------------------------------------------------------------- 上下文组装

def _section_title_of(dm: Any, block_index: int) -> str:
    for sec in dm.sections:
        if sec.block_start <= block_index <= sec.block_end:
            return sec.title
    return ""


def _block_as_text(block: Any) -> str:
    """表格块保留行列结构，其余返回纯文本"""
    if block.type != "table":
        return block.text
    rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", block.html, re.IGNORECASE)
    lines: list[str] = []
    for row in rows:
        cells = [strip_tags(c) for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row, re.IGNORECASE)]
        # 合并单元格会重复返回同一段文字，连续去重
        deduped: list[str] = []
        for c in cells:
            c = c.strip()
            if c and (not deduped or deduped[-1] != c):
                deduped.append(c)
        if deduped:
            lines.append("| " + " | ".join(deduped) + " |")
    return "\n".join(lines)


def _build_context(html: str, query: str, observations: list[dict[str, Any]], budget: int = 4000) -> str:
    """
    按需组装 final 阶段的文档上下文（T4）。

    优先级：已读到的章节 → query 指向的章节 → 检索命中的段落 →
            章节标题清单 → 文档开头兜底。
    每段带【第 N 段｜标题】标记，供答案生成位置引用。
    """
    from . import docmap

    blocks = split_blocks(html)
    dm = docmap.build(html)
    chunks: list[str] = []
    used = 0

    def add(text: str, label: str) -> bool:
        nonlocal used
        body = (text or "").strip()
        if not body:
            return True
        piece = f"{label}{body}"
        if used + len(piece) > budget:
            remain = budget - used
            if remain < 80:
                return False
            piece = piece[:remain]
        chunks.append(piece)
        used += len(piece)
        return used < budget

    def label_of(index: int) -> str:
        title = _section_title_of(dm, index)
        return f"【第 {index + 1} 段｜{title}】" if title else f"【第 {index + 1} 段】"

    # ① 已经通过 doc_section 读到的章节，直接放最前
    for o in observations:
        if o.get("tool") != "doc_section" or not o.get("ok"):
            continue
        data = o.get("data") or {}
        if not add(str(data.get("text", "")), f"【已读章节｜{data.get('title', '')}】"):
            return "\n\n".join(chunks)

    # ② query 明确指向某一节
    sec_params = _params_from_query("doc_section", query)
    key = str(sec_params.get("key", "")).strip()
    if key:
        section = docmap.find_section(html, key)
        if section is None and key.isdigit():
            # "第 5 部分" 在只有"五、…"的文档里查不到：换回中文编号再试
            zh_key = next((zh for zh, num in ZH_NUM.items() if num == key), "")
            if zh_key:
                section = docmap.find_section(html, zh_key)
        if section and section.text and not add(
            section.text, f"【第 {section.block_start + 1} 段｜{section.title}】"
        ):
            return "\n\n".join(chunks)

    # ③ 检索命中的段落（取整段，不用 snippet）
    for hit in docmap.search(html, query, limit=3):
        idx = int(hit.get("block", 0))
        if 0 <= idx < len(blocks) and not add(_block_as_text(blocks[idx]), label_of(idx)):
            return "\n\n".join(chunks)

    # ④ 章节标题清单（让模型知道结构，即使正文没进预算）
    if dm.sections:
        outline = "；".join(f"{s.number}{s.title}" for s in dm.sections[:12])
        if not add(f"文档结构：{outline}", "【结构】"):
            return "\n\n".join(chunks)

    # ⑤ 开头兜底
    head = re.sub(r"\s+", " ", strip_tags(html)).strip()[:800]
    add(head, "【文档开头】")
    return "\n\n".join(chunks)


def _doc_fingerprint(html: str, budget: int = 800) -> str:
    """
    文档指纹：让 think 阶段在「知道手上这份文档长什么样」的前提下规划工具。

    原缺陷：think 的 prompt 里只有用户那一句话，模型看不到章节结构、篇幅、
    有没有表格，只能靠关键词猜工具 —— 这是"不智能"的主要来源。
    """
    from . import docmap

    if not (html or "").strip():
        return "（当前没有打开文档）"

    blocks = split_blocks(html)
    if not blocks:
        return "（文档没有可解析的内容块）"

    dm = docmap.build(html)
    counts = {
        "段落": sum(1 for b in blocks if b.type == "paragraph"),
        "标题": sum(1 for b in blocks if b.type == "heading"),
        "表格": dm.table_count,
        "列表": sum(1 for b in blocks if b.type == "list"),
    }
    parts = [
        f"规模：{len(blocks)} 块 / 约 {dm.total_chars} 字 / "
        + ("、".join(f"{k} {v}" for k, v in counts.items() if v) or "无正文块")
    ]

    if dm.sections:
        parts.append("章节：" + "；".join(f"{s.number}{s.title}" for s in dm.sections[:10]))
    else:
        parts.append("章节：未识别到标题样式或中文编号（结构可能只体现在段落顺序上）")

    head = next((b.text for b in blocks if b.type == "paragraph" and len(b.text) > 20), "")
    if head:
        parts.append(f"开头：{head[:120]}")

    return "\n".join(parts)[:budget]


# ---------------------------------------------------------------- 规划

def _heuristic_plan(query: str) -> list[str]:
    """启发式规划：按关键词顺序挑工具，最多 3 个"""
    # 总结/摘要类：工具拿不到"理解"，直接交给模型读正文
    # 但"第 2 部分讲了什么"是定位问题，应走 doc_section
    if re.search(SUMMARIZE_RE, query) and not re.search(r"第\s*[一二三四五六七八九十\d]+\s*(部分|节|章)", query):
        return []

    plan: list[str] = []
    for pattern, tool in INTENTS:
        if re.search(pattern, query) and tool not in plan:
            plan.append(tool)
    if "doc_section" in plan and "doc_brief" in plan:
        plan.remove("doc_brief")

    # 问"哪里要改"时，先要知道文档结构，否则建议会脱离章节
    if "doc_improve" in plan and "doc_brief" not in plan and len(plan) < 3:
        plan.insert(0, "doc_brief")

    # 问具体数字/事实但没走检索 → 补一次文档内检索
    # 例外：问的是「字数/篇幅」这类计量问题，get_stats 已经能答，别再查一遍
    if (
        re.search(r"多少|几[个处套人户]|缺口|占比|比例|面积|金额", query)
        and "get_stats" not in plan
        and not ({"doc_search", "search_document", "kb_search"} & set(plan))
    ):
        plan.append("doc_search")

    if not plan:
        # 没有明确意图时也要"先查一遍再回答"：
        # 否则用户问"缺口是多少"这种定位型问题，agent 会什么都不做
        plan.append("search_document")
    return plan[:3]


def _next_offline_tool(pending: list[str], used: list[str]) -> str | None:
    """
    离线分支：只挑「未执行过」的工具。

    换词重查是模型分支的能力（模型能给不同的 action_input.query）；
    离线启发式没有可靠的第二组检索词，强行重查只会把同一句再查一遍。
    """
    for tool in pending:
        if tool not in used:
            return tool
    return None


def _parse_react(text: str) -> dict[str, Any]:
    """解析模型的 ReAct 输出：优先 JSON，退化到关键词行"""
    t = (text or "").strip()
    m = re.search(r"\{[\s\S]*\}", t)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    action = None
    mm = re.search(r"Action\s*[:：]\s*([a-z_]+)", t, re.IGNORECASE)
    if mm:
        action = mm.group(1)
    fa = re.search(r"Final\s*Answer\s*[:：]\s*([\s\S]+)", t, re.IGNORECASE)
    return {"action": action, "final_answer": fa.group(1).strip() if fa else None, "thought": t[:200]}


# ---------------------------------------------------------------- 节点

def node_think(state: AgentState) -> AgentState:
    """想：决定下一步做什么（或直接回答）"""
    query = state.get("query", "")
    used = list(state.get("used") or [])
    observations = list(state.get("observations") or [])
    selection = str(state.get("selection") or "").strip()

    real_model = has_credentials(state.get("model") or DEFAULT_MODEL)

    if not real_model:
        pending = list(state.get("pending") or [])
        if not pending:
            pending = _heuristic_plan(query)
        nxt = _next_offline_tool(pending, used)
        if nxt is None:
            return {
                **state,
                "steps": _step(state, "think", "没有更多可执行的动作，准备回答"),
            }
        params = _params_from_query(nxt, query, attempt=used.count(nxt), selection=selection)
        return {
            **state,
            "pending": pending,
            "action_params": params,
            "steps": _step(state, "think", f"决定调用工具：{nxt}"),
        }

    # 有模型：走标准 ReAct 提示（history 带关键内容，见 T1）
    tools_desc = "\n".join(f"- {t['name']}：{t['description']}" for t in tool_manifest())
    history = _history_text(observations)
    fingerprint = _doc_fingerprint(state.get("html", ""))
    selection_line = (
        f"\n用户当前选中的正文（问题优先针对这段）：\n{selection[:600]}\n" if selection else ""
    )
    prompt = f"""你是一个文档助手，按 ReAct 方式工作：先想，再决定调用工具，看结果后再决定下一步。

可用工具：
{tools_desc}

选工具的依据（先判断问题类型，再选一个）：
- 结构类（分几部分/讲了什么/大纲）→ doc_brief 或 doc_outline，一次就够
- 定位类（第 N 部分/某节）→ doc_section，action_input 用 {{"key":"N"}}
- 事实类（某个数字/说法在哪）→ doc_search，action_input 用 {{"query":"实词"}}；没命中换说法再查一次
- 建议类（哪里要改/有什么问题/怎么优化）→ doc_improve
- 规范类（标准/别人怎么写/依据）→ kb_search
- 计量类（字数/表格数/标题层级）→ get_stats / check_tables / check_headings

当前文档：
{fingerprint}
{selection_line}
已执行（含结果摘要）：
{history}

用户请求：{query}

规则：
1. 需要工具时只输出 JSON：{{"thought":"...","action":"工具名","action_input":{{}}}}
2. 已经能回答时只输出 JSON：{{"thought":"...","final_answer":"..."}}
3. 非检索工具不要重复调用；检索类（doc_search / search_document / kb_search）最多 2 次，
   第二次必须换关键词（把 action_input.query 改成同义说法）。
4. 先判断「当前文档」里是否已能直接回答；能答就不要调工具。
   文档没有表格时不要调 doc_tables，没有章节结构时不要调 doc_section。
5. 引用文档位置时用【第 N 段】标注，N 与上面的块序号一致（从 1 开始）。
6. 最多 {MAX_STEPS} 步。
"""
    res = complete([{"role": "user", "content": prompt}], model=state.get("model"), max_tokens=400)
    parsed = _parse_react(res.text)

    if parsed.get("final_answer"):
        return {
            **state,
            "answer": str(parsed["final_answer"]).strip(),
            "mock": res.mock,
            "steps": _step(state, "think", f"得出结论（{parsed.get('thought', '')[:40]}）"),
        }

    action = parsed.get("action")
    valid = {t["name"] for t in tool_manifest()}
    if action not in valid:
        return {
            **state,
            "steps": _step(state, "think", f"无可执行动作（{action or '无'}），准备回答"),
        }

    # T2：模型给的 action_input 优先
    params = _sanitize_params(action, parsed.get("action_input"))

    # T3：检索类允许换词重查，其余工具不可重复
    if action in RETRIEVAL_TOOLS:
        if used.count(action) >= MAX_REPEAT:
            return {
                **state,
                "steps": _step(state, "think", f"{action} 已调用 {MAX_REPEAT} 次，准备回答"),
            }
        this_query = str(params.get("query", "") or _params_from_query(action, query).get("query", ""))
        prev_queries = [
            str((o.get("params") or {}).get("query", ""))
            for o in observations
            if o.get("tool") == action
        ]
        if not params and action != "kb_search":
            params = _params_from_query(action, query)
            this_query = str(params.get("query", ""))
        if this_query and this_query in [q for q in prev_queries if q]:
            return {
                **state,
                "steps": _step(state, "think", f"{action} 的检索词重复（{this_query[:20]}），准备回答"),
            }
    elif action in used:
        return {
            **state,
            "steps": _step(state, "think", f"无可执行动作（{action}），准备回答"),
        }

    return {
        **state,
        "pending": [action],
        "action_params": params,
        "steps": _step(state, "think", f"决定调用工具：{action}"),
    }


def node_act(state: AgentState) -> AgentState:
    """做：执行工具，记录观察结果（参数优先级：action_input > 正则兜底 > 空）"""
    used = list(state.get("used") or [])
    pending = list(state.get("pending") or [])
    tool = next((t for t in pending if t not in used), None)
    if tool is None and pending:
        tool = pending[0]
    if not tool:
        return state

    # ① 模型给的参数
    params: dict[str, Any] = dict(state.get("action_params") or {})

    # ② 正则兜底（只补缺失的键，不覆盖模型给的）
    fallback = _params_from_query(
        tool,
        state.get("query", ""),
        attempt=used.count(tool),
        selection=str(state.get("selection") or ""),
    )
    for key, value in fallback.items():
        params.setdefault(key, value)

    result = run_tool(tool, state.get("html", ""), params)
    observations = list(state.get("observations") or [])
    observations.append(
        {
            "tool": tool,
            "ok": result.ok,
            "summary": result.summary,
            "data": result.data,
            "params": params,
        }
    )
    return {
        **state,
        "used": used + [tool],
        "observations": observations,
        "action_params": {},
        "steps": _step(state, "act", f"{tool} → {result.summary[:60]}"),
    }


def node_final(state: AgentState) -> AgentState:
    """答：用 docmap 组装上下文 + 工具结果，交给模型组织答案"""
    if state.get("answer"):
        return state

    observations = state.get("observations") or []
    context = _build_context(state.get("html", ""), state.get("query", ""), observations)

    lines: list[str] = []
    for o in observations:
        if not o.get("ok"):
            lines.append(o.get("summary", "（工具失败）"))
            continue
        brief = (o.get("data") or {}).get("brief")
        if brief:
            lines.append(brief)
            continue
        hits = (o.get("data") or {}).get("hits")
        hit_lines: list[str] = []
        if hits:
            for h in hits[:3]:
                if "doc" in h:  # 知识库命中
                    head = f"《{h['doc']}》"
                    if h.get("heading"):
                        head += f" {h['heading']}"
                    hit_lines.append(f"{head}：{h.get('snippet', '')}（第 {h.get('ord', 0)} 块）")
                else:  # 文档内检索
                    idx = h.get("block", h.get("blockIndex", 0))
                    hit_lines.append(f"段落 {idx + 1}：{h.get('snippet', '')}")
        if hit_lines:
            lines.extend(hit_lines)
            continue
        lines.append(o.get("summary", ""))

    material = "\n".join(f"- {x}" for x in lines if x)

    if has_credentials(state.get("model") or DEFAULT_MODEL):
        res = complete(
            [
                {
                    "role": "system",
                    "content": (
                        "你是中文文档分析助手。只依据给定的文档上下文与工具结果回答，不要编造。\n"
                        "输出要求：\n"
                        "1. 第一行给结论（不超过 60 字），不要复述用户问题\n"
                        "2. 接着 2–4 条依据，每条不超过 80 字，尽量带原文的数字与单位\n"
                        "3. 每条依据末尾用【第 N 段】标注出处\n"
                        "4. 用户问“哪里要改/有什么问题”时，按“问题 → 为什么 → 怎么改”三行给出，并指明位置\n"
                        "5. 文档里没有的就写“文档未提及”，不要用常识补\n"
                        "6. 不要输出“根据文档内容可知”这类套话"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"用户问题：{state.get('query', '')}\n\n"
                        f"文档上下文：\n{context}\n\n工具结果：\n{material or '（无）'}"
                    ),
                },
            ],
            model=state.get("model"),
            max_tokens=1200,
        )
        if (res.text or "").strip():
            return {
                **state,
                "answer": res.text.strip(),
                "mock": res.mock,
                "steps": _step(state, "final", "模型基于文档上下文与工具结果生成回答"),
            }

    if not observations:
        return {
            **state,
            "answer": f"（未生成答案）文档上下文：\n{context[:800]}",
            "steps": _step(state, "final", "无工具结果，返回上下文摘要"),
        }

    answer = "\n".join(f"· {x}" for x in lines if x) or "没有可用的结果"
    return {
        **state,
        "answer": answer,
        "steps": _step(state, "final", f"汇总 {len(lines)} 条观察结果"),
    }


def _should_continue(state: AgentState) -> str:
    used = state.get("used") or []
    pending = state.get("pending") or []
    acts = len([s for s in (state.get("steps") or []) if s["phase"] == "act"])

    if state.get("answer"):
        return "final"
    if acts >= MAX_STEPS:
        return "final"
    if _next_offline_tool(pending, used) is not None:
        return "act"
    return "final"


def build_graph():
    g = StateGraph(AgentState)
    g.add_node("think", node_think)
    g.add_node("act", node_act)
    g.add_node("final", node_final)

    g.add_edge(START, "think")
    g.add_conditional_edges("think", _should_continue, {"act": "act", "final": "final"})
    g.add_edge("act", "think")
    g.add_edge("final", END)
    return g.compile()


GRAPH = build_graph()


def run_agent(html: str, query: str, model: str | None = None, prev: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    跑一轮 agent。

    prev：上一轮的会话摘要（T7），用于指代消解；为空时行为与改造前一致。
    """
    effective_query = resolve_reference(query, prev)
    init: AgentState = {"html": html, "query": effective_query, "model": model, "steps": []}
    out: AgentState = GRAPH.invoke(init)

    observations = out.get("observations") or []
    refs: list[dict[str, Any]] = []
    for o in observations:
        for h in ((o.get("data") or {}).get("hits") or []):
            idx = h.get("block", h.get("blockIndex"))
            if isinstance(idx, int) and idx >= 0:
                refs.append({"para": idx, "snippet": str(h.get("snippet", ""))[:80], "from": o.get("tool", "")})

    # 答案里已经用【第 N 段】标了位置（T4 的上下文标记）：反推成 refs，
    # 这样即使模型选了不含 hits 的工具（如 diagnose_report），前端也能定位。
    for match in re.finditer(r"【第\s*(\d+)\s*段", out.get("answer", "") or ""):
        para = int(match.group(1)) - 1
        if para >= 0:
            refs.append({"para": para, "snippet": "答案引用了这一段", "from": "answer"})
    # 去重（同段落只留第一条）
    seen: set[int] = set()
    uniq_refs: list[dict[str, Any]] = []
    for r in refs:
        if r["para"] in seen:
            continue
        seen.add(r["para"])
        uniq_refs.append(r)

    return {
        "ok": True,
        "answer": out.get("answer", ""),
        "steps": out.get("steps", []),
        "observations": [
            {"tool": o["tool"], "ok": o["ok"], "summary": o["summary"]} for o in observations
        ],
        "toolsUsed": out.get("used", []),
        "mock": bool(out.get("mock", False)),
        "maxSteps": MAX_STEPS,
        "refs": uniq_refs[:8],
        "queryUsed": effective_query,
    }


PRONOUN_RE = r"(那|它|这个|这份|上面|刚才|第[一二三四五六七八九十\d]+(部分|节|章)?呢)"


def resolve_reference(query: str, prev: dict[str, Any] | None) -> str:
    """
    指代消解：上一轮存在且当前句子短且含指代词时，把上一轮实词拼进检索词（拼接而非替换）。
    """
    if not prev:
        return query
    q = (query or "").strip()
    last = str(prev.get("lastQuery", "") or "").strip()
    if not q or not last:
        return query
    if len(q) > 12 or not re.search(PRONOUN_RE, q):
        return query
    # 取上一轮 query 的实词（去掉疑问词与标点）
    core = _clean_search_query(last) or last
    return f"{q} {core}"[:80]
