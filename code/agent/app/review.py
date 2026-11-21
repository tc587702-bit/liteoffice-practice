"""
深度分析：让模型读文档结构后给出「具体问题 + 可直接采用的改写」

与规则版（improve.py）的分工：
  规则版   快（0.02s）、稳定、只覆盖可计算的确定性问题
  深度版   慢（3–15s）、能读懂语义、能给出改写，但需要模型

设计要点：
  1. 按章节送模型（每章一次），避免超长 prompt 丢重点
  2. 规则初筛结果作为「线索」给模型，允许它否定（规则会误报）
  3. 强制输出 JSON：每条必须带 quote（原文片段）与 rewrite（改后文本），
     禁止「建议补充…」这类套话
  4. 输出映射回内部 issue 结构（level/where/why/how/excerpt/block），
     前端可直接复用检查报告与 diff 替换

对外：
    review(html, genre=None, model=None, max_sections=6) -> {issues, summary, sections, mock}
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from . import docmap
from .classify_genre import GENRE_LABEL, classify
from .llm import complete, has_credentials
from .tools import split_blocks, strip_tags

MAX_CHARS_PER_SECTION = 1200

# 被护栏丢弃的建议（每次 review 前清空，供前端提示"模型有 N 条被拦下"）
_DROPPED: list[str] = []

# 深度分析必须用「非推理模型」：
# deepseek-flash 会把 1200~3000 token 全花在 reasoning 上，content 返回空。
# 实测 deepseek-chat：2.5s 出 4 条具体建议。
REVIEW_MODEL = os.getenv("LITEOFFICE_REVIEW_MODEL", "deepseek/deepseek-chat")
LEVEL_MAP = {"must": "error", "should": "warning", "nice": "info"}


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型输出里取第一个括号配平的 JSON 对象（容忍 ```json 围栏）"""
    t = re.sub(r"^```[a-zA-Z]*\s*", "", (text or "").strip())
    start = t.find("{")
    while start != -1:
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(t)):
            ch = t[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[start : i + 1])
                    except json.JSONDecodeError:
                        break
        start = t.find("{", start + 1)
    return None


def _sections(html: str, limit: int) -> list[dict[str, Any]]:
    """按章节切分待分析的正文；没有章节的文档按块聚合成若干段"""
    dm = docmap.build(html)
    blocks = split_blocks(html)
    out: list[dict[str, Any]] = []

    if dm.sections:
        for sec in dm.sections[:limit]:
            text = "\n".join(
                b.text for b in blocks[sec.block_start : sec.block_end + 1] if b.type != "table"
            ).strip()
            if len(text) < 20:
                continue
            out.append(
                {
                    "title": sec.title,
                    "start": sec.block_start,
                    "text": text[:MAX_CHARS_PER_SECTION],
                }
            )
        if out:
            return out

    # 无章节：按 1500 字切
    buf = ""
    start = 0
    for idx, b in enumerate(blocks):
        if b.type == "table":
            continue
        if not buf:
            start = idx
        buf += b.text + "\n"
        if len(buf) >= MAX_CHARS_PER_SECTION:
            out.append({"title": "", "start": start, "text": buf[:MAX_CHARS_PER_SECTION]})
            buf = ""
    if buf.strip():
        out.append({"title": "", "start": start, "text": buf[:MAX_CHARS_PER_SECTION]})
    return out[:limit]


def _prompt(genre_label: str, section: dict[str, Any], hints: list[str]) -> str:
    hint_text = "；".join(hints[:6]) if hints else "（无）"
    title = section.get("title") or "（本段无标题）"
    return f"""你是资深中文编辑，帮作者改这篇{genre_label}。只报真正影响意思表达或文体规范的问题，不要套话。

本段标题：{title}
规则初筛给的线索（可能误报，允许你否定）：{hint_text}

正文：
{section['text']}

要求：
1. 最多报 4 条，只报确定的问题；风格偏好标 nice，不要什么都报 must
2. 每条必须给出 quote（正文里连续 8–20 字，用于定位）和 rewrite（把这段改好的文本，可直接替换）
3. rewrite 必须是成品句子，禁止写「建议补充…」「可以考虑…」这类空话
4. 若这段没问题，返回空数组
5. 只输出 JSON，不要解释：
{{"issues":[{{"level":"must|should|nice","quote":"原文片段","problem":"一句话说问题","why":"为什么是问题（不超过 40 字）","rewrite":"改后的文本"}}],"comment":"对这段的一句话评价"}}
"""



# 代码/标记特征：命中即判定「不是正文文本」，一律不进报告
_CODE_PAT = re.compile(
    r"(?m)(?:^\s*(?:def|class|import|from|return|function|const|let|var|public|private|void|int|float)\b)"
    r"|\bprint\s*\("
    r"|\bconsole\.log\b"
    r"|\bSELECT\s+.+\s+FROM\b"
    r"|<\s*/?\s*(?:script|div|span|p|html|body|table)\b"
    r"|```"
    r"|^\s*[{}]\s*$"
    r"|;\s*$"
)
# OpenAI/代码风格的关键符号密度：分号与花括号在某些正文里合法，
# 但密集出现基本就是代码片段
_CODE_SYMBOLS = re.compile(r"[{};]|=>|&&|\|\||\bself\b")


def _looks_like_code(text: str) -> bool:
    """判断一段文本是不是代码/标记，而不是自然语言正文"""
    if not text:
        return False
    if _CODE_PAT.search(text):
        return True
    if len(text) >= 8:
        symbols = len(_CODE_SYMBOLS.findall(text))
        if symbols >= 2 and symbols / len(text) > 0.06:
            return True
    return False

# 结构性标记：编号、项目符号、表格线。
# 用法是「原文没有 → 改写里出现」，即结构被换掉。
# 不直接按模式匹配拦，是因为法律文书/公文本身就有这些标记，
# 拿它当通用规则会误杀；但「原文没有、改写凭空多出」在任何文体里都不是润色。
_MARKER_PATS = (
    ("中文编号", re.compile(r"(?m)^\s*[一二三四五六七八九十]+\s*[、.．]")),
    ("数字编号", re.compile(r"(?m)^\s*\d+\s*[.．]\s*\S")),
    ("条款号", re.compile(r"第[一二三四五六七八九十百\d]+[条章节款]")),
    ("项目符号", re.compile(r"(?m)^\s*[-*+•]\s+\S")),
    ("表格线", re.compile(r"(?m)^\s*\|.*\|")),
)


def _markers(text: str) -> set[str]:
    return {name for name, pat in _MARKER_PATS if pat.search(text or "")}


# 相似度依赖本地向量模型；缺 torch / 缺模型时会一直失败。
# 缓存失败状态，既避免每段反复尝试导入，也让「漂移检测没生效」变成可见信息
# —— 静默跳过会让人以为跑题已被拦住。
_SIM_STATE: dict[str, Any] = {"usable": None, "error": ""}


def _similarity(a: str, b: str) -> float | None:
    if _SIM_STATE["usable"] is False:
        return None
    try:
        from . import embed
        from .embed_local import get_embedder

        emb = get_embedder()
        val = embed.cosine(emb.embed_query(a), emb.embed_query(b))
        _SIM_STATE["usable"] = True
        return val
    except Exception as e:  # noqa: BLE001 缺依赖属预期分支，降级但必须留痕
        _SIM_STATE["usable"] = False
        _SIM_STATE["error"] = f"{type(e).__name__}: {e}"
        return None


def _review_verdict(base: str, out: str) -> str:
    """
    深度分析用的护栏：通过返回空串，否则返回被拦原因。

    为什么不用 polish_guard.check：
      那套要求「几乎不新增词语」（为了"写优美"），而深度分析的建议常常是
      「很滑 → 湿滑」这种同义替换，用它会误杀好建议。
    所以幅度放宽到 0.5–2.0 倍，但**事实与结构底线一条不能松**：
      ① 数字/日期/引号内容不得改动或新增
      ② 不得新增事件动词、主谓小句（凭空多出情节/人物）
      ③ 语义骨架不得翻转：否定、人称主体、时态、情感极性、具体实体
      ④ 不得凭空引入编号/列表/表格等原文没有的结构
      ⑤ 字数偏离 0.5–2.0 倍之外判「另写一段」
      ⑥ 相似度极低判跑题（依赖本地向量模型，不可用时在 guardNotes 里说明）

    ②③④ 是对抗测试补上的：原先只守 ①⑤，实测「心里很难过」「他坐在长椅上」
    「我曾坐在」「轮椅」等 7 条改义内容全部进了报告，前端一键修改会直接写进正文。
    """
    from . import polish_guard

    base = (base or "").strip()
    out = (out or "").strip()
    if not out:
        return "改写结果为空"

    b_enum, o_enum = polish_guard._enumerable(base), polish_guard._enumerable(out)
    for key, label in (("numbers", "数字"), ("dates", "日期/时间"), ("quotes", "引号内容")):
        lost = b_enum[key] - o_enum[key]
        added = o_enum[key] - b_enum[key]
        if lost:
            return f"{label}被改动或丢失：{'、'.join(sorted(lost)[:3])}"
        if added:
            return f"{label}凭空新增：{'、'.join(sorted(added)[:3])}"

    new_verbs = polish_guard._new_event_verbs(base, out)
    if new_verbs:
        return f"新增原文没有的事件：{'、'.join(new_verbs[:3])}"

    new_clauses = polish_guard._new_clauses(base, out)
    if new_clauses:
        return f"新增原文没有的情节：{'、'.join(new_clauses[:3])}"

    skeleton = polish_guard._skeleton_changes(base, out)
    if skeleton:
        return skeleton[0]["detail"]

    new_marks = _markers(out) - _markers(base)
    if new_marks:
        return f"凭空引入原文没有的结构：{'、'.join(sorted(new_marks))}"

    lb, lo = len(polish_guard._han(base)), len(polish_guard._han(out))
    if lb and lo and (lo / lb < 0.5 or lo / lb > 2.0):
        return f"改动幅度异常（原文 {lb} 字 → 改写 {lo} 字）"

    sim = _similarity(base, out)
    if sim is not None and sim < polish_guard.THRESHOLDS["topic_drift"]:
        return f"整段话题已改变（语义相似度 {sim:.2f}）"
    if sim is None:
        # 相似度不可用时兜底，否则跑题检测静默失效（本机缺 transformers 正是这种状态）
        keep = polish_guard.retain_ratio(base, out)
        if keep < polish_guard.THRESHOLDS["min_retain"]:
            return f"整段话题已改变（原文用词仅保留 {keep:.0%}）"
    return ""


def _to_issue(raw: dict[str, Any], section: dict[str, Any], html: str) -> dict[str, Any] | None:
    quote = str(raw.get("quote") or "").strip()
    rewrite = str(raw.get("rewrite") or "").strip()
    problem = str(raw.get("problem") or "").strip()
    if not problem:
        return None

    level = LEVEL_MAP.get(str(raw.get("level") or "should"), "warning")
    # 定位：先在章节范围内找 quote，再全文找
    block = None
    if quote:
        blocks = split_blocks(html)
        for idx in range(section["start"], min(section["start"] + 40, len(blocks))):
            if quote[:12] in blocks[idx].text:
                block = idx
                break
        if block is None:
            for idx, b in enumerate(blocks):
                if quote[:12] in b.text:
                    block = idx
                    break

    # ---- 护栏：模型给的改写必须过润色护栏 ----
    # 为什么必须在这里拦：前端「一键修改」直接把 issue 里的改写写进正文，
    # 模型返回代码、表格、跑题内容都会原样落到文档里。
    # 判定用确定性代码（polish_guard + 代码特征），不依赖模型自觉，也不依赖有没有 Key。
    dropped_reason = ""
    if rewrite:
        if _looks_like_code(rewrite):
            dropped_reason = "改写结果包含代码/标记"
        elif _looks_like_code(quote):
            dropped_reason = "原文片段包含代码/标记"
        else:
            dropped_reason = _review_verdict(quote or problem, rewrite)
    if dropped_reason:
        _DROPPED.append(dropped_reason)
        return None

    where = f"「{section['title']}」" if section.get("title") else (f"第 {block + 1} 段" if block is not None else "全文")
    return {
        "level": level,
        "levelLabel": {"error": "必须改", "warning": "建议改", "info": "可选"}[level],
        "rule": problem,
        "ruleId": "model:" + re.sub(r"\D", "", problem)[:0] + problem[:20],
        "where": where,
        "problem": problem,
        "why": str(raw.get("why") or "")[:120],
        "how": rewrite or "（模型未给出改写）",
        "excerpt": quote,
        "block": block,
        "source": "model",
    }


def review(html: str, genre: str | None = None, model: str | None = None, max_sections: int = 6) -> dict[str, Any]:
    plain = strip_tags(html)
    if not plain.strip():
        return {"ok": False, "reason": "文档为空", "issues": [], "summary": ""}

    if genre is None:
        genre = classify(plain).get("genre")
    genre_label = GENRE_LABEL.get(genre or "", "文档")

    model = model or REVIEW_MODEL
    if not has_credentials(model):
        return {
            "ok": False,
            "reason": "深度分析需要模型凭据（未配置 DEEPSEEK_API_KEY）",
            "issues": [],
            "summary": "",
            "mock": True,
        }

    _DROPPED.clear()
    sections = _sections(html, max_sections)
    if not sections:
        return {"ok": False, "reason": "没有可分析的正文", "issues": [], "summary": ""}

    issues: list[dict[str, Any]] = []
    comments: list[str] = []
    mocked = False

    for sec in sections:
        res = complete(
            [{"role": "user", "content": _prompt(genre_label, sec, [])}],
            model=model,
            max_tokens=1200,
        )
        mocked = mocked or res.mock
        data = _extract_json(res.text)
        if not data:
            continue
        for raw in (data.get("issues") or [])[:4]:
            if not isinstance(raw, dict):
                continue
            mapped = _to_issue(raw, sec, html)
            if mapped:
                issues.append(mapped)
        if data.get("comment"):
            comments.append(str(data["comment"])[:60])

    # 去重：同 quote + 同 problem 只留一条
    seen: set[tuple[str, str]] = set()
    uniq: list[dict[str, Any]] = []
    for it in issues:
        key = (it["excerpt"][:12], it["problem"][:12])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)

    order = {"error": 0, "warning": 1, "info": 2}
    uniq.sort(key=lambda x: order.get(x["level"], 3))

    if not uniq:
        summary = "模型通读后没有发现需要修改的地方。"
    else:
        must = sum(1 for i in uniq if i["level"] == "error")
        summary = f"模型分析 {len(sections)} 段，给出 {len(uniq)} 条具体建议" + (f"，其中 {must} 条必须改" if must else "")

    # 话题漂移检测依赖本地向量模型。缺依赖时它其实没跑，
    # 必须说清楚 —— 否则用户会以为「跑题」也被拦住了。
    notes: list[str] = []
    if _SIM_STATE["usable"] is False:
        notes.append(
            "话题漂移检测本次未生效（本地向量模型不可用："
            f"{_SIM_STATE['error']}）；其余事实与结构过滤不受影响。"
        )

    return {
        "ok": True,
        "issues": uniq,
        "summary": summary,
        "comments": comments[:3],
        "sections": len(sections),
        "dropped": len(_DROPPED),
        "droppedReasons": sorted(set(_DROPPED))[:3],
        "guardNotes": notes,
        "mock": mocked,
        "genre": genre,
        "genreLabel": genre_label,
    }
