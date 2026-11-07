"""
工具层：服务端可执行的文档工具（对应图上的「工具调用层」）

全部为纯函数：输入 HTML 文本，输出结构化结果；不依赖数据库、不依赖模型。
与前端 src/lib/agent/tools.ts 保持同一套语义（统计/大纲/检索/表格检查/标题检查）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

TAG_RE = re.compile(r"<[^>]+>")
BLOCK_RE = re.compile(r"<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)</\1>", re.I)
ROW_RE = re.compile(r"<tr\b[^>]*>([\s\S]*?)</tr>", re.I)
CELL_RE = re.compile(r"<(td|th)\b[^>]*>([\s\S]*?)</\1>", re.I)


def strip_tags(html: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", text, flags=re.I)
    text = TAG_RE.sub("", text)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')):
        text = text.replace(a, b)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


@dataclass
class Block:
    type: str
    html: str
    text: str = ""
    level: int = 0


def split_blocks(html: str) -> list[Block]:
    blocks: list[Block] = []
    for m in BLOCK_RE.finditer(html):
        tag = m.group(1).lower()
        inner = m.group(2)
        if tag == "table":
            blocks.append(Block("table", f"<table>{inner}</table>", strip_tags(inner)))
        elif tag.startswith("h"):
            blocks.append(Block("heading", f"<{tag}>{inner}</{tag}>", strip_tags(inner), int(tag[1])))
        else:
            kind = "paragraph" if tag == "p" else "list" if tag == "li" else tag
            blocks.append(Block(kind, f"<{tag}>{inner}</{tag}>", strip_tags(inner)))
    return blocks


@dataclass
class Issue:
    code: str
    severity: str  # error | warning | info
    title: str
    detail: str
    block_index: int | None = None
    fixable: bool = False


@dataclass
class ToolResult:
    ok: bool
    tool: str
    summary: str
    data: dict[str, Any] = field(default_factory=dict)


# ---------------- 各工具 ----------------

def get_stats(html: str) -> ToolResult:
    blocks = split_blocks(html)
    text = "\n".join(b.text for b in blocks if b.text)
    chars = len(re.sub(r"\s", "", text))
    stats = {
        "charsNoSpace": chars,
        "paragraphs": sum(1 for b in blocks if b.type == "paragraph"),
        "headings": sum(1 for b in blocks if b.type == "heading"),
        "tables": sum(1 for b in blocks if b.type == "table"),
        "images": len(re.findall(r"<img\b", html, re.I)),
        "readingMinutes": max(1, round(chars / 350)),
    }
    return ToolResult(
        True,
        "get_stats",
        f"正文 {chars} 字，{stats['paragraphs']} 段，{stats['headings']} 个标题，"
        f"{stats['tables']} 个表格，{stats['images']} 张图片，约 {stats['readingMinutes']} 分钟读完",
        stats,
    )


def get_outline(html: str) -> ToolResult:
    items = [
        {"level": b.level, "text": b.text[:80], "blockIndex": i}
        for i, b in enumerate(split_blocks(html))
        if b.type == "heading"
    ]
    summary = "；".join(f"{'  ' * (it['level'] - 1)}h{it['level']} {it['text']}" for it in items) or "没有标题"
    return ToolResult(True, "get_outline", f"共 {len(items)} 个标题：" + summary, {"outline": items})


def search_document(html: str, query: str, limit: int = 10) -> ToolResult:
    q = (query or "").strip()
    if not q:
        return ToolResult(False, "search_document", "关键词为空", {})
    hits = []
    for i, b in enumerate(split_blocks(html)):
        pos = b.text.lower().find(q.lower())
        if pos >= 0:
            start = max(0, pos - 30)
            hits.append(
                {
                    "blockIndex": i,
                    "position": pos,
                    "snippet": ("…" if start else "") + b.text[start : pos + len(q) + 40] + "…",
                }
            )
    hits = hits[:limit]
    return ToolResult(
        bool(hits),
        "search_document",
        f"「{q}」命中 {len(hits)} 处" if hits else f"没有找到「{q}」",
        {"hits": hits},
    )


def _rows(table_html: str) -> list[list[str]]:
    return [[strip_tags(c.group(2)) for c in CELL_RE.finditer(r.group(1))] for r in ROW_RE.finditer(table_html)]


def check_tables(html: str) -> ToolResult:
    issues: list[Issue] = []
    tables = [(i, b) for i, b in enumerate(split_blocks(html)) if b.type == "table"]
    for ti, (idx, b) in enumerate(tables):
        rows = _rows(b.html)
        if not rows:
            issues.append(Issue("TABLE_EMPTY", "warning", f"第 {ti + 1} 个表格没有可解析的行", "结构异常"))
            continue
        widths = [len(r) for r in rows]
        widest = max(widths)
        odd = [i + 1 for i, w in enumerate(widths) if w != widest]
        if odd:
            issues.append(
                Issue(
                    "TABLE_ROW_WIDTH",
                    "error",
                    f"第 {ti + 1} 个表格列数不一致",
                    f"最多 {widest} 列，第 {'、'.join(map(str, odd))} 行少于 {widest} 列",
                    idx,
                    True,
                )
            )
        empties = [
            f"第{ri + 1}行第{ci + 1}列"
            for ri, r in enumerate(rows)
            for ci, c in enumerate(r)
            if not c.strip()
        ]
        if empties:
            issues.append(
                Issue(
                    "TABLE_EMPTY_CELL",
                    "info",
                    f"第 {ti + 1} 个表格有 {len(empties)} 个空单元格",
                    "、".join(empties[:8]) + (" 等" if len(empties) > 8 else ""),
                    idx,
                )
            )
    ok = not issues
    summary = "表格结构正常" if ok else f"发现 {len(issues)} 个表格问题"
    return ToolResult(True, "check_tables", summary, {"issues": [i.__dict__ for i in issues]})


def check_headings(html: str) -> ToolResult:
    blocks = split_blocks(html)
    outline = [(i, b) for i, b in enumerate(blocks) if b.type == "heading"]
    issues: list[Issue] = []
    if not outline:
        issues.append(Issue("HEADING_NONE", "warning", "文档没有任何标题", "没有标题无法生成大纲"))
    else:
        h1 = [(i, b) for i, b in outline if b.level == 1]
        if not h1:
            issues.append(Issue("HEADING_NO_H1", "warning", "缺少一级标题", "建议至少一个 h1"))
        if len(h1) > 1:
            issues.append(
                Issue(
                    "HEADING_MULTI_H1",
                    "warning",
                    f"有 {len(h1)} 个一级标题",
                    "分别在第 " + "、".join(str(i + 1) for i, _ in h1) + " 块",
                )
            )
        for k in range(1, len(outline)):
            prev_level = outline[k - 1][1].level
            cur_idx, cur = outline[k]
            if cur.level - prev_level > 1:
                issues.append(
                    Issue(
                        "HEADING_SKIP",
                        "warning",
                        f"标题跳级：h{prev_level} → h{cur.level}",
                        f"「{cur.text[:30]}」跳过了 h{prev_level + 1}",
                        cur_idx,
                        True,
                    )
                )
    summary = "标题层级正常" if not issues else f"发现 {len(issues)} 个标题问题"
    return ToolResult(True, "check_headings", summary, {"issues": [i.__dict__ for i in issues]})


def check_duplicates(html: str, min_chars: int = 15) -> ToolResult:
    seen: dict[str, int] = {}
    issues: list[Issue] = []
    for i, b in enumerate(split_blocks(html)):
        if b.type != "paragraph":
            continue
        text = b.text.strip()
        if len(text) < min_chars:
            continue
        key = re.sub(r"\s", "", text).lower()
        if key in seen:
            issues.append(
                Issue(
                    "DUP_PARAGRAPH",
                    "warning",
                    f"第 {i + 1} 块与第 {seen[key] + 1} 块内容重复",
                    text[:50],
                    i,
                )
            )
        else:
            seen[key] = i
    summary = "没有重复段落" if not issues else f"发现 {len(issues)} 处重复段落"
    return ToolResult(True, "check_duplicates", summary, {"issues": [i.__dict__ for i in issues]})


def diagnose_report(html: str) -> ToolResult:
    collected: list[dict[str, Any]] = []
    for fn in (check_tables, check_headings, check_duplicates):
        collected.extend(fn(html).data.get("issues", []))
    order = {"error": 0, "warning": 1, "info": 2}
    collected.sort(key=lambda x: (order.get(x["severity"], 9), x.get("block_index") or 10**9))
    counts = {
        "error": sum(1 for i in collected if i["severity"] == "error"),
        "warning": sum(1 for i in collected if i["severity"] == "warning"),
        "info": sum(1 for i in collected if i["severity"] == "info"),
    }
    summary = (
        "文档体检通过，未发现问题"
        if not collected
        else f"共 {len(collected)} 个问题：{counts['error']} 个错误、{counts['warning']} 个警告、{counts['info']} 个提示"
    )
    return ToolResult(True, "diagnose_report", summary, {"issues": collected, "counts": counts})


# ---------------- 注册表（对应图上的 Tool Registry） ----------------

TOOLS: dict[str, dict[str, Any]] = {
    "get_stats": {
        "fn": lambda html, **_: get_stats(html),
        "label": "文档统计",
        "description": "字数、段落、表格、图片与阅读时长",
        "needs_model": False,
        "destructive": False,
    },
    "get_outline": {
        "fn": lambda html, **_: get_outline(html),
        "label": "提取大纲",
        "description": "按标题层级生成大纲",
        "needs_model": False,
        "destructive": False,
    },
    "search_document": {
        "fn": lambda html, query="", **_: search_document(html, query),
        "label": "全文检索",
        "description": "按关键词检索并返回命中段落",
        "needs_model": False,
        "destructive": False,
    },
    "check_tables": {
        "fn": lambda html, **_: check_tables(html),
        "label": "表格检查",
        "description": "列数不一致、空单元格",
        "needs_model": False,
        "destructive": False,
    },
    "check_headings": {
        "fn": lambda html, **_: check_headings(html),
        "label": "标题检查",
        "description": "标题跳级、缺少或多个一级标题",
        "needs_model": False,
        "destructive": False,
    },
    "check_duplicates": {
        "fn": lambda html, **_: check_duplicates(html),
        "label": "重复段落检查",
        "description": "查找重复段落",
        "needs_model": False,
        "destructive": False,
    },
    "diagnose_report": {
        "fn": lambda html, **_: diagnose_report(html),
        "label": "文档体检",
        "description": "汇总全部检查，按严重级别排序",
        "needs_model": False,
        "destructive": False,
    },
}


def tool_manifest() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "label": meta["label"],
            "description": meta["description"],
            "needsModel": meta["needs_model"],
            "destructive": meta["destructive"],
        }
        for name, meta in TOOLS.items()
    ]


def run_tool(name: str, html: str, params: dict[str, Any] | None = None) -> ToolResult:
    meta = TOOLS.get(name)
    if not meta:
        return ToolResult(False, name, f"未知工具：{name}", {})
    fn: Callable[..., ToolResult] = meta["fn"]
    try:
        return fn(html, **(params or {}))
    except Exception as exc:  # 工具异常不冒泡到接口层
        return ToolResult(False, name, f"工具执行失败：{exc}", {})
