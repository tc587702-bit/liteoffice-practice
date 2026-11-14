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

    return {
        "ok": True,
        "issues": uniq,
        "summary": summary,
        "comments": comments[:3],
        "sections": len(sections),
        "mock": mocked,
        "genre": genre,
        "genreLabel": genre_label,
    }
