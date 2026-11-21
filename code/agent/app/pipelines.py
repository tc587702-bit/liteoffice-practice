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

import os
import re
from typing import Any

from . import embed, grammar, kb
from .classify_genre import GENRE_LABEL, classify
from .llm import DEFAULT_MODEL, complete, has_credentials
from .query_expand import search_expanded
from .tools import strip_tags

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


_embedder = None
_embedder_tried = False


def _get_embedder():
    """惰性加载本地向量模型；没装模型/没装 torch 时返回 None（自动退回 BM25）"""
    global _embedder, _embedder_tried
    if _embedder_tried:
        return _embedder
    _embedder_tried = True
    try:
        from .embed_local import get_embedder

        _embedder = get_embedder()
    except Exception:  # noqa: BLE001 缺模型/缺依赖都不该影响主流程
        _embedder = None
    return _embedder


def retrieve(kb_id: str, query: str, top_k: int = 5) -> tuple[list[dict], list[str]]:
    """
    检索：优先「BM25 + 向量」加权混合，向量不可用时退回 BM25 + 同义扩展。

    可关闭混合：设置 LITEOFFICE_RETRIEVAL=bm25；默认 hybrid。

    两条路径最后都过 `_relevance_gate`：向量下限调到 0.38 后召回变宽，
    若不拦，「火星探测器着陆」这类无关问题也会捞到公文片段，"无命中就拒答"就失效了。
    """
    from .multigenre import _relevance_gate

    mode = os.getenv("LITEOFFICE_RETRIEVAL", "hybrid")
    vectors = 0
    if mode == "hybrid":
        try:
            vectors = int(embed.vector_stats(kb_id).get("embedded") or 0)
        except Exception:  # noqa: BLE001
            vectors = 0
    if mode == "hybrid" and vectors:
        emb = _get_embedder()
        if emb is not None:
            try:
                out = embed.hybrid_search(kb_id, query, embedder=emb, top_k=top_k + 4)
                hits = _relevance_gate(query, out.get("hits") or [])
                if hits:
                    cleaned = [h for h in hits if not _is_noisy(h["text"])]
                    return (cleaned or hits)[:top_k], out.get("variants") or [query]
            except Exception:  # noqa: BLE001 混合失败就退回 BM25，不能让检索挂掉
                vectors = 0  # 降级为纯 BM25，不让检索挂掉

    hits, variants = search_expanded(kb, kb_id, query, top_k=top_k + 4)
    if not hits:
        hits, variants = kb.search(kb_id, query, top_k=top_k + 4), [query]
    hits = _relevance_gate(query, hits)
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



# ---------------------------------------------------------------- 续写

def genre_label(g: str) -> str:
    return GENRE_LABEL.get(g, g)


_CONT_CODE = re.compile(r"```|\bdef\s+\w+\s*\(|\bprint\s*\(|\bfunction\s*\w*\s*\(|<script", re.IGNORECASE)
_CONT_MARKUP = re.compile(r"(?m)^\s{0,3}(#{1,6}\s|[-*+]\s|\|.+\||\d+\.\s)")


def continue_text(
    html: str,
    genre: str | None = None,
    instruction: str = "",
    model: str | None = None,
    max_chars: int = 1200,
    cursor_context: str = "",
) -> dict[str, Any]:
    """
    续写：接着正文末尾写一段，保持同一文体与叙述口吻。

    与 rewrite 的区别：续写必然新增内容，所以不校验"不得增删事实"，
    只校验"不是代码/标记、长度合理、不是 Markdown 结构"。
    """
    plain = strip_tags(html)
    if len(plain.strip()) < 20:
        return {"ok": False, "reason": "文档太短，无法判断文风", "continuation": ""}

    g = genre if genre and genre in GENRE_LABEL else (classify(plain).get("genre") or "gongwen")
    if not has_credentials(model or DEFAULT_MODEL):
        return {"ok": False, "reason": "续写需要模型凭据（未配置 Key）", "continuation": "", "mock": True}

    # 续写必须接着"光标所在位置"的前文，而不是文末：
    # 用文末内容生成、再插到中间，句子之间接不上。
    cursor_ctx = (cursor_context or "").strip()
    if len(cursor_ctx) >= 20:
        tail = cursor_ctx[-600:]
        context_used = "cursor"
    else:
        tail = plain.strip()[-600:]
        context_used = "tail"
    style = CHECKLIST.get(g, [])
    # 锚句：上下文里的最后一句。续写必须从这一句往下接，否则读者会觉得"跳了"
    anchor = ""
    for seg in re.split(r"(?<=[。！？…])", tail):
        if seg.strip():
            anchor = seg.strip()
    prompt = (
        f"下面是{genre_label(g)}已经写到的部分。请**紧接着最后一句**往下写。\n"
        f"硬性要求：\n"
        f"1. 必须承接最后一句「{anchor[-60:]}」的动作/场景/时间，读者读起来要连贯\n"
        f"2. 不要更换场景、地点、时间，不要回头重述已经发生过的事\n"
        f"3. 保持同一人称与叙述视角，不要突然跳视角\n"
        f"4. 只输出续写的正文：不要解释、不要标题、不要 Markdown 符号、不要复述原文\n"
        f"5. 控制在 150–400 字\n"
        + (f"6. 文体要点：{'；'.join(style[:3])}\n" if style else "")
        + (f"7. 用户额外要求：{instruction[:80]}\n" if instruction.strip() else "")
        + f"\n已经写到：\n{tail}\n\n紧接着「{anchor[-60:]}」继续写："
    )
    res = complete([{"role": "user", "content": prompt}], model=model, max_tokens=1200)
    text = (res.text or "").strip()

    # ---- 护栏 ----
    if not res.ok or not text:
        return {"ok": False, "reason": f"模型未返回内容（{res.error or '空'}）", "continuation": "", "mock": res.mock}
    if _CONT_CODE.search(text):
        return {"ok": False, "reason": "模型返回了代码，已拒绝", "continuation": "", "mock": res.mock, "blocked": "code"}
    if _CONT_MARKUP.search(text):
        return {
            "ok": False,
            "reason": "模型返回了 Markdown 结构（标题/列表/表格），正文里不合适",
            "continuation": "",
            "mock": res.mock,
            "blocked": "markup",
        }
    body = text.lstrip("#*- \n")
    if len(body) < 30:
        return {"ok": False, "reason": f"续写太短（{len(body)} 字），可能被截断", "continuation": "", "mock": res.mock}
    body = body[:max_chars]
    # 不许重复原文最后一句
    last_line = tail.split("。")[-2] if "。" in tail else ""
    if last_line and body.startswith(last_line.strip()[:12]):
        body = body[len(last_line.strip()[:12]) :].lstrip("，。 ")

    # ---- 衔接自检（只提示，不拦）----
    # 依据：续写开头若与锚句没有任何共同汉字（2-gram），多半是"跳到另一个场景"
    def _grams_of(t: str) -> set[str]:
        flat = re.sub(r"[^\u4e00-\u9fa5]", "", t or "")
        return {flat[i : i + 2] for i in range(len(flat) - 1)}

    anchor_grams = _grams_of(anchor)
    head_grams = _grams_of(body[:80])
    linked = bool(anchor_grams & head_grams) if anchor_grams else True
    needs_review = not linked

    return {
        "ok": True,
        "continuation": body,
        "anchor": anchor[-60:],
        "linked": linked,
        "needsReview": needs_review,
        "genre": g,
        "genreLabel": genre_label(g),
        "chars": len(body),
        "contextUsed": context_used,
        "mock": res.mock,
        "steps": [
            {
                "phase": "continue",
                "detail": f"续写 {len(body)} 字（{res.model}，依据：{'光标前文' if context_used == 'cursor' else '文末'}）",
            }
        ],
    }


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
    "contract": ["主体与标的明确", "权利义务对等", "违约责任可执行", "争议解决方式与管辖明确"],
    "resume": ["用动词开头描述成果", "成果量化（数字与规模）", "不写与岗位无关的经历", "不用主观自夸形容"],
    "news": ["导语含时间地点人物事件", "倒金字塔（重要信息在前）", "引语标明出处", "事实与评论分离"],
    "legal": ["当事人称谓准确", "诉讼请求与事实理由对应", "援引法条写明条款号", "裁判主文可执行"],
    "textbook": ["目标可测量（掌握/理解/了解）", "重难点分明", "例题配解答过程", "术语首次出现即定义"],
}

# 文体 → 知识库 id。与 app/multigenre.py 的 GENRE_KB 保持一致。
# 单独列一份是为了不让 pipelines 反向依赖 multigenre（后者依赖本模块的 CHECKLIST 语义）。
GENRE_KB_ID = {
    "gongwen": "gongwen",
    "lab": "lab_report",
    "thesis": "thesis",
    "essay_arg": "essay_arg",
    "essay_narr": "essay_narr",
    "expository": "expository",
    "contract": "contract",
    "resume": "resume",
    "news": "news",
    "legal": "legal",
    "textbook": "textbook",
}


def _resolve_kb(kb_id: str, genre: str, inferred: bool) -> str:
    """
    按文体选库；文体不可信、目标库为空或就是当前库时，保持调用方给的 kb_id。

    为什么需要：前端通常不传 genre，调用方给的默认库可能是空库
    （历史遗留的 'lab' 已迁空），术语与规范片段全查不到，
    改写就会退化成「原文原样返回」且不报错。

    为什么要 inferred 这个开关：classify 判不出时会兜底成 gongwen，
    那是猜测而非判定。用猜测去覆盖调用方明确传入的库会帮倒忙 ——
    实测「本次实验测量了硅二极管…」判不出文体，兜底 gongwen，
    若据此切库，实验报告术语就查不到了。所以只有真判定出来才切。
    """
    if not inferred:
        return kb_id
    target = GENRE_KB_ID.get(genre)
    if not target or target == kb_id:
        return kb_id
    try:
        if kb.kb_stats(target)["chunks"] > 0:
            return target
    except Exception:  # noqa: BLE001 库不可用时不该让整个改写失败
        return kb_id
    return kb_id



# ---------------------------------------------------------------- 按事实改正

_CORRECT_CODE = re.compile(r"```|\bdef\s+\w+\s*\(|\bprint\s*\(|<script", re.IGNORECASE)


def _correct_by_fact(
    selection: str,
    problem: str,
    genre: str,
    model: str | None,
    steps: list[dict[str, str]],
) -> dict[str, Any]:
    """
    按事实/概念错误改正一句话。

    与另外两个模式的区别：
      normalize  只改语病，一个字都不许多
      polish     写得好看，但绝不许改事实
      correct    就是来改事实的（荷花冬天开 → 夏天开）
    护栏只守「别胡来」：不能是代码、不能变成另一段、必须真的改了。
    """
    if not has_credentials(model or DEFAULT_MODEL):
        return {
            "ok": False,
            "candidate": "",
            "reason": "按事实改需要模型凭据（未配置 Key）",
            "steps": steps,
            "mock": True,
        }

    prompt = (
        f"下面这句话有错误：{problem[:120]}\n"
        f"请只输出改正后的这一句。要求：\n"
        f"1. 保持原句的句式、人称、长度，只改错的那处\n"
        f"2. 不要解释、不要加引号、不要写「改为…」\n"
        f"3. 不确定正确说法时，就保留原句不动\n"
        f"4. 文体是「{GENRE_LABEL.get(genre, genre)}」，不要写成说明文口吻\n"
        f"\n原句：\n{selection}\n"
    )
    # 推理型模型（deepseek-flash 等）会先输出思考再给正文，
    # 600 token 经常在思考阶段就被截断 → 正文为空 → 报"模型未返回内容"。
    res = complete([{"role": "user", "content": prompt}], model=model, max_tokens=2000)
    steps.append({"phase": "correct", "detail": f"按事实改正（{res.model}）"})
    text = (res.text or "").strip().strip('"“”')

    if not res.ok or not text:
        return {
            "ok": False,
            "candidate": "",
            "reason": f"模型未返回内容（{res.error or '空'}）",
            "steps": steps,
            "mock": res.mock,
        }
    if _CORRECT_CODE.search(text):
        return {
            "ok": False,
            "candidate": "",
            "reason": "模型返回了代码，已拒绝",
            "steps": steps,
            "mock": res.mock,
            "blocked": "code",
        }
    ratio = len(text) / max(1, len(selection))
    if not (0.5 <= ratio <= 2.0):
        return {
            "ok": False,
            "candidate": "",
            "reason": f"改动幅度异常（{len(selection)} 字 → {len(text)} 字），可能是另写了一段",
            "steps": steps,
            "mock": res.mock,
            "blocked": "length",
        }
    if text.strip() == selection.strip():
        return {
            "ok": True,
            "noChange": True,
            "candidate": "",
            "reason": "模型没有改动这句（可能它认为原句没错）",
            "steps": steps,
            "mock": res.mock,
        }
    return {
        "ok": True,
        "candidate": text,
        "changes": [f"按事实改正：{problem[:30]}"],
        "genre": genre,
        "genreLabel": GENRE_LABEL.get(genre, genre),
        "steps": steps,
        "mock": res.mock,
    }


def rewrite(
    kb_id: str,
    selection: str,
    genre: str | None = None,
    model: str | None = None,
    top_k: int = 3,
    context: str = "",
    allow_model_polish: bool = False,
    mode: str = "normalize",
) -> dict[str, Any]:
    """
    mode 决定用哪套标准，两套不能混用：

      normalize  规范修正：别写错（的得地/错别字/赘余）。一个字都不许多，
                 走 rewrite_guard 四道护栏，幅度 ≤20%。结果确定、可一键替换。
      polish     更优美：写得好看（意象/句式/节奏）。必须允许加修饰，
                 走 polish_guard —— 只守事实底线（数字/名称/新事件），放开幅度。

    为什么必须分开：实测「我坐在长椅上看着风景，心里十分开心。」润色成
    「我靠着长椅，看风把树影摇成细碎的斑…」是好改写，但规范护栏判「幅度 78%」拦掉。
    用一套标准管两件事，紧了不可能优美，松了就会改坏原文。

    allow_model_polish：是否允许记叙文/说明文/议论文走模型。
    默认 False —— 护栏有盲区，不把风险默认摊给所有用户。调用方显式要求时才放开。
    mode="polish" 视为显式要求润色，自动放开该限制。
    """
    polish_mode = mode == "polish"
    if polish_mode:
        allow_model_polish = True
    steps: list[dict[str, str]] = []
    selection = (selection or "").strip()
    if len(selection) < 10:
        return {"ok": False, "candidate": "", "reason": "选中内容太短（至少 10 字）", "steps": steps}

    # 按事实改正：这条路径允许改事实（与 polish 相反），所以单独分派，不进通用流程
    if mode == "correct":
        g_c = genre if genre and genre in GENRE_LABEL else (classify(selection).get("genre") or "gongwen")
        return _correct_by_fact(selection, context, g_c, model, steps)

    # ① 文体：用户指定优先，否则自动判定
    #    inferred 标记「这个文体是不是可信的判定结果」——
    #    用户指定或 classify 真判出来时为 True；兜底成 gongwen 时为 False。
    #    _resolve_kb 只在 inferred=True 时才切换库，避免用猜测覆盖调用方的明确意图。
    if genre and genre in GENRE_LABEL:
        g, g_conf, g_reason, inferred = genre, 1.0, "用户指定", False
    else:
        r = classify(selection)
        detected = r["genre"]
        # 判不出时用 gongwen 兜底（沿用既有行为），但标记为不可信
        g = detected or "gongwen"
        g_conf = r["confidence"]
        g_reason = r.get("reason", "")
        inferred = bool(detected)
    steps.append({"phase": "genre", "detail": f"文体：{GENRE_LABEL.get(g, g)}（置信度 {g_conf:.2f}，{g_reason}）"})

    # ①-c 先跑确定性的语言规范修正：这是"一定能改对"的那部分，
    #     改完若没有任何实质改动，就直接告诉用户没问题，不要硬造一版"改写"。
    fixed, fix_notes = grammar.fix_text(selection)
    if fix_notes:
        steps.append({"phase": "fix", "detail": "规则修正：" + "；".join(fix_notes[:3])})

    # ①-b 按文体选库（仅在文体可信时；前端不传 genre 且能判出文体才切）
    resolved = _resolve_kb(kb_id, g, inferred)
    if resolved != kb_id:
        steps.append({"phase": "genre", "detail": f"按文体切换知识库：{kb_id} → {resolved}"})
    kb_id = resolved

    # ② 证据：术语 + 规范片段
    ev = kb.build_evidence(kb_id, selection, top_k=top_k)
    terms, chunks = ev["terms"], ev["chunks"]
    steps.append(
        {
            "phase": "evidence",
            "detail": f"术语 {len(terms)} 条，规范片段 {len(chunks)} 块",
        }
    )

    # ③ 规则改写：先做语言规范修正（的/得/地、错别字、赘余、重复），再做术语替换
    candidate, changes = _apply_terms(fixed, terms)
    changes = list(fix_notes) + list(changes)
    checklist = CHECKLIST.get(g, [])

    # ④ 无模型：返回规则建议，明确标注
    # 记叙文/说明文：只做语言规范修正（的得地、错别字、赘余、重复）。
    # 这类文体"润色"是主观的，模型改写容易把原意改掉（实测把"昨天下完雨后"
    # 改成"昨天雨后"，还擅自加了"车轮一打滑"），所以不走模型。
    narrative_only = g in ("essay_narr", "expository", "essay_arg")
    # 默认：非记叙类才走模型；调用方显式要求润色时，记叙类也走（但仍受护栏约束）
    real_model = has_credentials(model or DEFAULT_MODEL) and (not narrative_only or allow_model_polish)
    if not real_model:
        # 规则层没有任何改动 → 直接说"没问题"，而不是把原文再抛回去一次
        if candidate.strip() == selection.strip():
            steps.append({"phase": "rewrite", "detail": "规则检查未发现需要修改的地方"})
            return {
                "ok": True,
                "noChange": True,
                "candidate": "",
                "reason": "这段没有发现需要修改的地方",
                "changes": [],
                "genre": g,
                "genreLabel": GENRE_LABEL.get(g, g),
                "genreConfidence": round(g_conf, 3),
                "checklist": checklist,
                "evidence": {"terms": terms, "chunks": _citations(chunks)},
                "steps": steps,
                "mock": True,
            }
        steps.append({"phase": "rewrite", "detail": f"按语言规范改了 {len(changes)} 处"})
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
    if polish_mode:
        # 润色：目标是「写得好看」，必须明确允许加修饰，否则模型会按规范修正的
        # 口径一个字都不敢动，产出与原文几乎相同 —— 那这个按钮就名不副实。
        prompt = (
            f"你是一位擅长中文散文的编辑。把下面这段「{GENRE_LABEL.get(g, g)}」改写得更优美。\n"
            "可以做：调整句式与语序、替换更贴切的形容词、加入比喻与感官细节、改善节奏。\n"
            "绝对不能做：\n"
            "1. 不得新增或改动任何数字、日期、时间、人名、地名、引号内内容\n"
            "2. 不得新增原文没有的事件或动作（例如原文没摔倒，就不能写摔倒）\n"
            "3. 不得新增原文没有的人物、地点、机构\n"
            "4. 不得改变原意与事实，不得删掉原文交代的信息\n"
            "只输出改写后的正文，不要解释，不要加标题。\n"
            + (f"\n上下文（仅供理解，不要改写）：\n{context[:400]}\n" if context.strip() else "")
            + f"\n原文：\n{fixed}\n"
        )
    else:
        prompt = (
            f"你是一位中文写作审校。按「{GENRE_LABEL.get(g, g)}」的要求改写下面的段落。\n"
            f"硬性要求：\n1. 必须使用这些术语：{term_line}\n"
            f"2. 只用材料里的规范，不要编造：\n{material}\n"
            f"3. 只改语言表达，不得增删事实与情节；数字、单位、时间、人名、地名、引号内内容一律不得改动\n"
            f"4. 只输出改写后的正文，不要解释\n"
            + (f"\n上下文（仅供理解，不要改写）：\n{context[:400]}\n" if context.strip() else "")
            + f"\n原文：\n{selection}\n"
        )
    res = complete([{"role": "user", "content": prompt}], model=model, max_tokens=2500)
    steps.append({"phase": "rewrite", "detail": f"模型改写（{res.model}）"})

    # 模型调用失败/返回空：退回规则版，如实说明，不把占位文本当结果
    if not res.ok or not (res.text or "").strip():
        steps.append({"phase": "guard", "detail": f"模型未成功（{res.error or '空返回'}），改用规范修正版"})
        rule_candidate = candidate
        if rule_candidate.strip() == selection.strip():
            return {
                "ok": True,
                "noChange": True,
                "candidate": "",
                "reason": "模型调用失败，且规则检查也没有发现需要修改的地方",
                "changes": [],
                "genre": g,
                "genreLabel": GENRE_LABEL.get(g, g),
                "checklist": checklist,
                "evidence": {"terms": terms, "chunks": _citations(chunks)},
                "steps": steps,
                "mock": True,
            }
        return {
            "ok": True,
            "genre": g,
            "genreLabel": GENRE_LABEL.get(g, g),
            "genreConfidence": round(g_conf, 3),
            "candidate": rule_candidate,
            "changes": changes,
            "checklist": checklist,
            "evidence": {"terms": terms, "chunks": _citations(chunks)},
            "steps": steps,
            "mock": True,
            "modelFailed": True,
        }

    # 护栏按模式分派：基线一律用规则修正后的文本（不是原文）——
    # 规则层会合法删字（「涉及到」→「涉及」），拿原文当基线会把它误判成内容丢失。
    raw_model_text = res.text.strip()
    if polish_mode:
        from . import polish_guard

        sim = polish_guard.similarity(fixed, raw_model_text)
        verdict = polish_guard.check(fixed, raw_model_text, similarity=sim)
        guard_name = "润色护栏"
        if verdict.get("notes"):
            steps.append({"phase": "guard", "detail": "；".join(verdict["notes"])})
    else:
        from . import rewrite_guard

        verdict = rewrite_guard.check(fixed, raw_model_text)
        guard_name = "规范护栏"
    # 润色被拦下时再试一次保守版：只允许调整语序与替换同义词，
    # 不许新增任何词语 —— 多数"模型发挥过头"的情况能被这一次救回来。
    if not verdict["ok"] and polish_mode:
        retry_prompt = (
            "把下面这段文字改得更通顺，但严格限制：\n"
            "1. 不得新增任何原文没有的词语（可以替换同义词、调整语序、断句）\n"
            "2. 不得删掉原文任何信息\n"
            "3. 不得新增或改动数字、时间、人名、地名、引号内容\n"
            "只输出改写后的正文。\n\n原文：\n" + fixed
        )
        res2 = complete([{"role": "user", "content": retry_prompt}], model=model, max_tokens=1200)
        if res2.ok and (res2.text or "").strip():
            retry_text = res2.text.strip()
            sim2 = polish_guard.similarity(fixed, retry_text)
            verdict2 = polish_guard.check(fixed, retry_text, similarity=sim2)
            if verdict2["ok"]:
                steps.append({"phase": "guard", "detail": "保守重试通过润色护栏"})
                raw_model_text = retry_text
                verdict = verdict2
            else:
                steps.append({"phase": "guard", "detail": "保守重试仍未通过"})

    if not verdict["ok"]:
        reasons = "；".join(b["detail"] for b in verdict["blocked"][:3])
        steps.append({"phase": "guard", "detail": f"模型结果被{guard_name}拦下 —— {reasons}"})
        rule_candidate = candidate
        guard_info = {"blocked": verdict["blocked"]}
        # 规则层也没改动：没有"规则版"可退，文案不能谎称已退回
        if rule_candidate.strip() == selection.strip():
            return {
                "ok": True,
                "noChange": True,
                "candidate": "",
                "reason": f"模型改写未通过{guard_name}（{reasons}），且规则检查没有发现需要修改的地方",
                "changes": [],
                "genre": g,
                "genreLabel": GENRE_LABEL.get(g, g),
                "checklist": checklist,
                "evidence": {"terms": terms, "chunks": _citations(chunks)},
                "steps": steps,
                "mock": res.mock,
                "guard": guard_info,
            }
        return {
            "ok": True,
            "genre": g,
            "genreLabel": GENRE_LABEL.get(g, g),
            "genreConfidence": round(g_conf, 3),
            "candidate": rule_candidate,
            "changes": changes,
            "checklist": checklist,
            "evidence": {"terms": terms, "chunks": _citations(chunks)},
            "steps": steps,
            "mock": res.mock,
            "guard": guard_info,
            "guardMessage": f"模型改写未通过{guard_name}，已改用规范修正版（{reasons}）",
        }

    steps.append({"phase": "guard", "detail": f"模型结果通过{guard_name}"})
    return {
        "ok": True,
        "genre": g,
        "genreLabel": GENRE_LABEL.get(g, g),
        "genreConfidence": round(g_conf, 3),
        "candidate": raw_model_text,
        "changes": changes,
        "checklist": checklist,
        "evidence": {"terms": terms, "chunks": _citations(chunks)},
        "steps": steps,
        "mock": res.mock,
        "mode": "polish" if polish_mode else "normalize",
    }
