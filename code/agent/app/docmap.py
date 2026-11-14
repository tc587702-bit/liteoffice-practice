"""
文档地图：让 agent 真正"读懂"手上的这份文档

为什么需要它：
  公文里没有 Word 标题样式（Heading1/2），结构全靠"一、二、（一）1."这种
  编号体现。只按段落切块，agent 只知道"有 19 段"，不知道"分五个部分"。

能力：
  outline()        从标题样式 + 中文编号推断章节树
  section(key)     按章节号/标题/序号读某一节全文
  search(query)    在文档内按词检索（2-gram），返回段落号
  tables()         结构化表格（行列 + 合并单元格去重）
  brief()          一句话概要：几个部分、每部分首句、关键数字
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .tools import split_blocks, strip_tags

# 一、二、三…（一级）
L1_RE = re.compile(r"^\s*[一二三四五六七八九十]+[、.．]")
# （一）（二）…（二级）
L2_RE = re.compile(r"^\s*[（(][一二三四五六七八九十]+[）)]")
# 1. 1、1)（三级）
L3_RE = re.compile(r"^\s*\d+[、.．)）]")
# 第X部分 / 第X章 / 第X节
CHAPTER_RE = re.compile(r"^\s*第[一二三四五六七八九十百\d]+[部分章节]")


@dataclass
class Section:
    index: int
    level: int
    title: str
    block_start: int
    block_end: int = 0
    text: str = ""
    number: str = ""          # 一 / 二 / （一） / 1.
    children: list[int] = field(default_factory=list)


@dataclass
class DocMap:
    sections: list[Section]
    block_count: int
    table_count: int
    total_chars: int


def _heading_level(block) -> int | None:
    """标题层级：优先 h1-h6，其次中文编号推断"""
    if block.type == "heading":
        return block.level or 1
    text = block.text.strip()
    if not text or len(text) > 60:
        return None
    if CHAPTER_RE.match(text):
        return 1
    if L1_RE.match(text):
        return 1
    if L2_RE.match(text):
        return 2
    if L3_RE.match(text):
        return 3
    return None


def _number_of(text: str) -> str:
    m = re.match(r"^\s*([一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)]|\d+[、.．)）]|第[一二三四五六七八九十百\d]+[部分章节])", text)
    return m.group(1) if m else ""


def build(html: str) -> DocMap:
    blocks = split_blocks(html)
    sections: list[Section] = []
    for i, b in enumerate(blocks):
        level = _heading_level(b)
        if level is None:
            continue
        title = b.text.strip()
        # 只取编号与标题前半句，太长的当正文
        if len(title) > 40:
            title = title[:40] + "…"
        sections.append(
            Section(index=len(sections) + 1, level=level, title=title, block_start=i, number=_number_of(b.text))
        )

    # 每个 section 的正文范围：到下一个同级或更高级标题为止
    for idx, sec in enumerate(sections):
        end = len(blocks)
        for nxt in sections[idx + 1 :]:
            if nxt.level <= sec.level:
                end = nxt.block_start
                break
        sec.block_end = end
        body = [blocks[k].text for k in range(sec.block_start + 1, end) if blocks[k].type != "table"]
        sec.text = "\n".join(t for t in body if t).strip()

    total_chars = sum(len(b.text) for b in blocks)
    table_count = sum(1 for b in blocks if b.type == "table")
    return DocMap(sections=sections, block_count=len(blocks), table_count=table_count, total_chars=total_chars)


def outline(html: str) -> list[dict]:
    dm = build(html)
    return [
        {
            "no": s.index,
            "level": s.level,
            "number": s.number,
            "title": s.title,
            "chars": len(s.text),
            "children": sum(1 for x in dm.sections if x.block_start > s.block_start and x.block_end <= s.block_end and x.level > s.level),
        }
        for s in dm.sections
    ]


def find_section(html: str, key: str) -> Section | None:
    """
    按三种方式找章节：
      1. 序号（第 2 节 / 2）
      2. 编号（一、 / （二））
      3. 标题关键词（安置房）
    """
    dm = build(html)
    k = (key or "").strip()
    if not k:
        return None

    # 1) 纯数字 → 按序号
    if k.isdigit():
        idx = int(k)
        if 1 <= idx <= len(dm.sections):
            return dm.sections[idx - 1]
        return None

    # 2) 编号精确匹配
    for s in dm.sections:
        if s.number and (s.number in k or k in s.number):
            return s

    # 3) 标题关键词（取最短的匹配，避免"安置房"匹配到"安置房建设和拆迁安置工作"这种长标题）
    matched = [s for s in dm.sections if k in s.title]
    if matched:
        return min(matched, key=lambda s: len(s.title))
    return None


def search(html: str, query: str, limit: int = 8) -> list[dict]:
    """文档内按 2-gram 检索（比整句 find 可靠）"""
    terms: list[str] = []
    q = (query or "").lower()
    for seg in re.sub(r"[^\u4e00-\u9fa5a-z0-9]", " ", q).split():
        if len(seg) == 1:
            terms.append(seg)
        for i in range(len(seg) - 1):
            terms.append(seg[i : i + 2])
    if not terms:
        return []

    scored: list[tuple[int, int, dict]] = []
    for i, b in enumerate(split_blocks(html)):
        text = b.text.lower()
        hits = [t for t in terms if t in text]
        if not hits:
            continue
        first = min(text.find(t) for t in hits)
        start = max(0, first - 20)
        scored.append(
            (
                len(hits),
                -i,
                {
                    "block": i,
                    "hits": hits[:4],
                    "snippet": ("…" if start else "") + b.text[start : first + 60] + "…",
                },
            )
        )
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [s[2] for s in scored[:limit]]


def tables(html: str) -> list[dict]:
    """结构化表格：行列 + 合并单元格去重"""
    out: list[dict] = []
    for b in split_blocks(html):
        if b.type != "table":
            continue
        rows: list[list[str]] = []
        for row_m in re.finditer(r"<tr\b[^>]*>([\s\S]*?)</tr>", b.html, re.IGNORECASE):
            cells: list[str] = []
            for cell_m in re.finditer(r"<(td|th)\b[^>]*>([\s\S]*?)</\1>", row_m.group(1), re.IGNORECASE):
                text = strip_tags(cell_m.group(2)).strip()
                if text and (not cells or cells[-1] != text):
                    cells.append(text)
            if cells:
                rows.append(cells)
        if rows:
            out.append({"rows": rows, "columns": max(len(r) for r in rows)})
    return out


def brief(html: str, max_sections: int = 6) -> str:
    """一句话概要：几个部分、每部分首句、表格数"""
    dm = build(html)
    if not dm.sections:
        first = strip_tags(html)[:120].replace("\n", " ")
        return f"没有识别到章节结构；开头是：{first}"

    lines = [f"共 {len(dm.sections)} 个章节、{dm.table_count} 个表格、约 {dm.total_chars} 字"]
    for s in dm.sections[:max_sections]:
        first_line = (s.text.split("\n")[0] if s.text else "")[:50]
        lines.append(f"- {s.title}｜{first_line}")
    return "\n".join(lines)
