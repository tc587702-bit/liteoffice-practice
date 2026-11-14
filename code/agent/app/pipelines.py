"""
两条固定链路：问答（QA）与专业改写（REWRITE）

设计要点：
  1. 都用同一个检索能力（kb.search + 同义扩展 + RRF）
  2. 都有"无依据就直说"的分支，绝不硬编
  3. 无模型 Key 时走**抽取式**降级：答案直接来自检索到的原文句子，
     并如实标注 mock，绝不编造
  4. 每一步都记进 steps[]，接口层原样返回，前端可展示

对外：
    qa(kb_id, question)              -> {answer, citations, steps, mock}
    rewrite(kb_id, selection, genre) -> {candidate, evidence, changes, steps, mock}
"""
from __future__ import annotations

import re
from typing import Any

from . import kb
from .classify_genre import GENRE_LABEL, classify
from .llm import DEFAULT_MODEL, complete, has_credentials
from .query_expand import search_expanded

MAX_EVIDENCE_CHARS = 1200


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？；])", text.replace("\n", " "))
    return [s.strip() for s in parts if len(s.strip()) >= 12]


def _clip(text: str, limit: int = MAX_EVIDENCE_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


def _is_noisy(text: str) -> bool:
    """
    判断块是不是"表格碎片/目录噪声"：
      同一短语重复 3 次以上、或几乎全是数字与分隔符。
    """
    flat = re.sub(r"\s+", "", text)
    if len(flat) < 20:
        return False
    # 找重复片段：取前 12 个字，看它在全文出现几次
    probe = flat[:12]
    if probe and flat.count(probe) >= 3:
        return True
    digits = sum(ch.isdigit() or ch in "|.-/%" for ch in flat)
    return digits / len(flat) > 0.55


def retrieve(kb_id: str, query: str, top_k: int = 5) -> tuple[list[dict], list[str]]:
    """检索 + 同义扩展 + RRF；过滤表格碎片等噪声块"""
    hits, variants = search_expanded(kb, kb_id, query, top_k=top_k + 4)
    if not hits:
        hits, variants = kb.search(kb_id, query, top_k=top_k + 4), [query]
    cleaned = [h for h in hits if not _is_noisy(h["text"])]
    return (cleaned or hits)[:top_k], variants


def _citations(hits: list[dict], start: int = 1) -> list[dict]:
    """知识库命中 → 引用（source = kb）"""
    return [
        {
            "n": i,
            "source": "kb",
            "doc": h["docName"],
            "heading": h.get("heading", ""),
            "ord": h["ord"],
            "score": round(h["score"], 3),
            "snippet": _clip(h["text"], 160),
        }
        for i, h in enumerate(hits, start)
    ]


def _block_text(block: Any) -> str:
    """表格块保留行列结构，其余返回纯文本"""
    if block.type != "table":
        return block.text
    rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", block.html, re.IGNORECASE)
    lines: list[str] = []
    for row in rows:
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row, re.IGNORECASE)]
        deduped: list[str] = []
        for c in cells:
            if c and (not deduped or deduped[-1] != c):
                deduped.append(c)
        if deduped:
            lines.append("| " + " | ".join(deduped) + " |")
    return "\n".join(lines)


def _doc_hits(doc_html: str, question: str, limit: int = 3) -> list[dict]:
    """当前文档侧检索：返回段落号 + 整段正文（不是 snippet）"""
    from . import docmap
    from .tools import split_blocks

    if not (doc_html or "").strip():
        return []
    blocks = split_blocks(doc_html)
    dm = docmap.build(doc_html)

    def title_of(index: int) -> str:
        for sec in dm.sections:
            if sec.block_start <= index <= sec.block_end:
                return sec.title
        return ""

    out: list[dict] = []
    for hit in docmap.search(doc_html, question, limit=limit):
        idx = int(hit.get("block", 0))
        if 0 <= idx < len(blocks):
            out.append(
                {
                    "para": idx,
                    "heading": title_of(idx),
                    "text": _block_text(blocks[idx]),
                    "snippet": str(hit.get("snippet", "")),
                }
            )
    return out[:limit]


def _doc_citations(doc_hits: list[dict], start: int = 1) -> list[dict]:
    """当前文档命中 → 引用（source = doc）"""
    return [
        {
            "n": i,
            "source": "doc",
            "doc": "当前文档",
            "heading": h.get("heading", ""),
            "para": h["para"],
            "snippet": _clip(h["text"], 160),
        }
        for i, h in enumerate(doc_hits, start)
    ]


# 这些开头的行是目录/附件清单，回答问题时要跳过
_JUNK_PREFIX = re.compile(r"^(附件|目\s*录|注[:：]|表\s*\d|图\s*\d|\d+[\.、])")


def _extractive_answer(hits: list[dict], doc_hits: list[dict] | None = None) -> str:
    """
    无模型时的抽取式回答（支持「当前文档 + 知识库」双源）。

    策略：按检索排序取 block，而不是按句子的字面重合度——
    重合度高的句子常常是"附件清单""目录"这类噪声。
    引用标记带来源：当前文档用 [文档·N]，知识库用 [kb·N]。
    """
    doc_hits = doc_hits or []
    picked: list[tuple[str, str]] = []

    for h in doc_hits[:2]:
        good = [
            s
            for s in _sentences(h["text"])
            if len(s) >= 20 and not _JUNK_PREFIX.match(s) and "…" not in s[:3]
        ]
        marker = f"[文档·{h['para'] + 1}]"
        if good:
            picked.append((good[0], marker))

    for idx, h in enumerate(hits[:2], 1):
        good = [
            s
            for s in _sentences(h["text"])
            if len(s) >= 20 and not _JUNK_PREFIX.match(s) and "…" not in s[:3]
        ]
        if good:
            picked.append((good[0], f"[kb·{idx}]"))

    if not picked:
        if doc_hits:
            head = re.sub(r"\s+", " ", doc_hits[0]["text"])[:120]
            return f"{head} [文档·{doc_hits[0]['para'] + 1}]"
        if not hits:
            return ""
        head = re.sub(r"\s+", " ", hits[0]["text"])[:120]
        return f"{head} [kb·1]"

    seen: set[str] = set()
    lines: list[str] = []
    for text, marker in picked:
        if text in seen:
            continue
        seen.add(text)
        lines.append(f"{text} {marker}")
    return "\n".join(lines[:3])


def qa(
    kb_id: str,
    question: str,
    model: str | None = None,
    top_k: int = 5,
    doc_html: str = "",
    doc_top_k: int = 3,
) -> dict[str, Any]:
    """
    知识库问答，可选「当前文档」双源检索。

    doc_html 为空时行为与改造前完全一致（只查知识库）。
    """
    steps: list[dict[str, str]] = []
    question = (question or "").strip()
    if len(question) < 2:
        return {"ok": False, "answer": "问题太短", "citations": [], "steps": steps, "mock": False}

    steps.append({"phase": "retrieve", "detail": f"检索知识库：{question}"})
    hits, variants = retrieve(kb_id, question, top_k=top_k)
    steps.append(
        {
            "phase": "retrieve",
            "detail": f"命中 {len(hits)} 块（查询变体 {len(variants)} 个）",
        }
    )

    # 当前文档侧检索（可选）
    doc_hits = _doc_hits(doc_html, question, limit=doc_top_k) if doc_html.strip() else []
    if doc_html.strip():
        steps.append({"phase": "retrieve", "detail": f"当前文档命中 {len(doc_hits)} 段"})

    if not hits and not doc_hits:
        return {
            "ok": True,
            "answer": "知识库和当前文档里都没有找到相关内容。可换个说法，或先上传相关文档。",
            "citations": [],
            "steps": steps + [{"phase": "answer", "detail": "无命中，直接返回（不调用模型）"}],
            "mock": False,
        }

    citations = _doc_citations(doc_hits) + _citations(hits, start=len(doc_hits) + 1)
    real_model = has_credentials(model or DEFAULT_MODEL)

    if not real_model:
        answer = _extractive_answer(hits, doc_hits)
        steps.append({"phase": "answer", "detail": "无模型 Key，用抽取式回答（原文句子 + 引用）"})
        return {
            "ok": True,
            "answer": answer or "资料里没有直接对应的句子，请查看下面的引用。",
            "citations": citations,
            "steps": steps,
            "mock": True,
        }

    # 每块压到 500 字：推理模型对长 prompt 尤其费 token，容易把预算耗在思考上
    doc_block = ""
    if doc_hits:
        doc_block = "【当前文档】\n" + "\n\n".join(
            f"[{i}] 第 {h['para'] + 1} 段｜{h.get('heading', '')}\n{_clip(h['text'], 500)}"
            for i, h in enumerate(doc_hits, 1)
        )
    kb_start = len(doc_hits) + 1
    kb_block = "【知识库】\n" + "\n\n".join(
        f"[{i}] 《{c['doc']}》 {c['heading']}\n{_clip(h['text'], 500)}"
        for i, (c, h) in enumerate(zip(citations[len(doc_hits):], hits), kb_start)
    )
    materials = "\n\n".join(x for x in (doc_block, kb_block) if x)

    rules = [
        "你是公文写作助理。只依据下面的材料回答，不得编造。",
        "回答要求：",
        "1. 第一句给结论（一句话，不超过 60 字）",
        "2. 再用 2–4 个要点说明依据，每点不超过 80 字，保留原文的数字与单位",
        "3. 禁止整段复制原文；不要输出“附件”“目录”“第X条”这类清单行",
        "4. 每个要点后用 [编号] 标注来源",
        "5. 材料不足时直接说“材料中没有足够信息”，不要猜测",
    ]
    if doc_hits:
        rules.append(
            "6. 回答“本文是否符合规范”这类对照问题时，必须同时引用【当前文档】与【知识库】两侧的编号"
        )
        rules.append("7. 只有知识库有依据、当前文档没有对应内容时，明确说“本文未提及”")
    prompt = "\n".join(rules) + f"\n\n材料：\n{materials}\n\n问题：{question}\n"
    res = complete([{"role": "user", "content": prompt}], model=model, max_tokens=2500)
    answer = (res.text or "").strip()

    if not answer:
        # 推理模型可能把预算全花在思考上 → 用更短的指令重试一次
        retry_prompt = (
            "只输出最终答案，不要思考过程。格式：第一句结论（≤60字），"
            "随后 2–3 个要点，每点≤80字，末尾标 [编号]。\n\n"
            f"材料：\n{materials}\n\n问题：{question}"
        )
        res = complete([{"role": "user", "content": retry_prompt}], model=model, max_tokens=3000)
        answer = (res.text or "").strip()

    if not answer:
        # 推理模型偶尔把预算全花在思考上，content 为空 → 回退抽取式，不返回空答案
        answer = _extractive_answer(hits, doc_hits)
        steps.append(
            {"phase": "answer", "detail": f"模型未返回正文（{res.error or 'content 为空'}），回退抽取式"}
        )
    else:
        steps.append({"phase": "answer", "detail": f"模型生成（{res.model}）"})
    return {"ok": True, "answer": answer, "citations": citations, "steps": steps, "mock": res.mock}


def _apply_terms(text: str, terms: list[dict]) -> tuple[str, list[dict]]:
    """按术语表做替换，返回新文本与改动清单"""
    out = text
    changes: list[dict] = []
    for t in terms:
        src, dst = t["from"], t["to"]
        if src and dst and src in out and src != dst:
            out = out.replace(src, dst)
            changes.append({"type": "term", "from": src, "to": dst, "note": t.get("note", "")})
    return out, changes


CHECKLIST = {
    "gongwen": ["称谓与落款完整", "不使用第一人称抒情", "数据带单位与时间口径"],
    "lab": ["给出误差来源", "单位与有效数字一致", "结论回应实验目的"],
    "thesis": ["摘要含方法与结果", "图表有编号与标题", "引用格式统一"],
    "essay_arg": ["论点明确", "论据具体", "结尾不喊口号"],
    "essay_narr": ["有细节与场景", "时间线清楚", "情感通过动作表达"],
    "expository": ["定义准确", "顺序清晰", "少用修饰"],
}


def rewrite(
    kb_id: str,
    selection: str,
    genre: str | None = None,
    model: str | None = None,
    top_k: int = 3,
    context: str = "",
) -> dict[str, Any]:
    steps: list[dict[str, str]] = []
    selection = (selection or "").strip()
    if len(selection) < 10:
        return {"ok": False, "candidate": "", "reason": "选中内容太短（至少 10 字）", "steps": steps}

    # ① 文体：用户指定优先，否则自动判定
    if genre and genre in GENRE_LABEL:
        g, g_conf, g_reason = genre, 1.0, "用户指定"
    else:
        r = classify(selection)
        g = r["genre"] or "gongwen"
        g_conf = r["confidence"]
        g_reason = r.get("reason", "")
    steps.append({"phase": "genre", "detail": f"文体：{GENRE_LABEL.get(g, g)}（置信度 {g_conf:.2f}，{g_reason}）"})

    # ② 证据：术语 + 规范片段
    ev = kb.build_evidence(kb_id, selection, top_k=top_k)
    terms, chunks = ev["terms"], ev["chunks"]
    steps.append(
        {
            "phase": "evidence",
            "detail": f"术语 {len(terms)} 条，规范片段 {len(chunks)} 块",
        }
    )

    # ③ 规则改写：术语替换（不依赖模型）
    candidate, changes = _apply_terms(selection, terms)
    checklist = CHECKLIST.get(g, [])

    # ④ 无模型：返回规则建议，明确标注
    real_model = has_credentials(model or DEFAULT_MODEL)
    if not real_model:
        steps.append({"phase": "rewrite", "detail": "无模型 Key，只做术语层面的规则建议"})
        return {
            "ok": True,
            "genre": g,
            "genreLabel": GENRE_LABEL.get(g, g),
            "genreConfidence": round(g_conf, 3),
            "candidate": candidate,
            "changes": changes,
            "checklist": checklist,
            "evidence": {"terms": terms, "chunks": _citations(chunks)},
            "steps": steps,
            "mock": True,
        }

    # ⑤ 有模型：术语约束 + 规范 + 文体要求一起进 prompt
    material = "\n\n".join(f"[{i}] 《{c['docName']}》\n{_clip(c['text'], 500)}" for i, c in enumerate(chunks, 1))
    term_line = "；".join(f"{t['from']}→{t['to']}" for t in terms) or "（无）"
    prompt = (
        f"你是一位中文写作审校。按「{GENRE_LABEL.get(g, g)}」的要求改写下面的段落。\n"
        f"硬性要求：\n1. 必须使用这些术语：{term_line}\n"
        f"2. 只用材料里的规范，不要编造：\n{material}\n"
        f"3. 保持原意与事实（数字、单位、时间不得改动）\n"
        f"4. 只输出改写后的正文，不要解释\n"
        + (f"\n上下文（仅供理解，不要改写）：\n{context[:400]}\n" if context.strip() else "")
        + f"\n原文：\n{selection}\n"
    )
    res = complete([{"role": "user", "content": prompt}], model=model, max_tokens=2500)
    steps.append({"phase": "rewrite", "detail": f"模型改写（{res.model}）"})
    return {
        "ok": True,
        "genre": g,
        "genreLabel": GENRE_LABEL.get(g, g),
        "genreConfidence": round(g_conf, 3),
        "candidate": res.text.strip() or candidate,
        "changes": changes,
        "checklist": checklist,
        "evidence": {"terms": terms, "chunks": _citations(chunks)},
        "steps": steps,
        "mock": res.mock,
    }
