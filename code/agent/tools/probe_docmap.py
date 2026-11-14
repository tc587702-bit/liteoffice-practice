"""验证 agent 对"当前文档"的理解程度（无模型也能跑）

    python tools/probe_docmap.py [文件.docx]
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from docx import Document

from app import docmap
from app.graph import run_agent


def docx_html(path: Path) -> str:
    doc = Document(str(path))
    out: list[str] = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        style = (p.style.name or "").lower()
        if style.startswith("heading"):
            lvl = "".join(ch for ch in style if ch.isdigit()) or "2"
            out.append(f"<h{lvl}>{t}</h{lvl}>")
        else:
            out.append(f"<p>{t}</p>")
    for tbl in doc.tables:
        rows = []
        for row in tbl.rows:
            seen: list[str] = []
            for c in row.cells:
                text = c.text.strip()
                if text and (not seen or seen[-1] != text):
                    seen.append(text)
            if seen:
                rows.append("<tr>" + "".join(f"<td>{x}</td>" for x in seen) + "</tr>")
        if rows:
            out.append("<table>" + "".join(rows) + "</table>")
    return "\n".join(out)


src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx")
html = docx_html(src)
print(f"文档：{src.name}   HTML {len(html)} 字符\n")

print("=== 1) 结构识别（不需要 Word 标题样式）===")
for it in docmap.outline(html):
    print(f"  {it['no']:>2}. [L{it['level']}] {it['number']:<6} {it['title'][:36]}  ({it['chars']} 字)")

print("\n=== 2) 概要 ===")
print(docmap.brief(html))

print("\n=== 3) 按序号读第 2 节 ===")
sec = docmap.find_section(html, "2")
print(f"  标题：{sec.title if sec else '没找到'}")
if sec:
    print("  正文：" + sec.text[:200].replace("\n", " "))

print("\n=== 4) 按标题词找「养老保险」===")
sec2 = docmap.find_section(html, "养老保险")
print(f"  标题：{sec2.title if sec2 else '没找到'}")
if sec2:
    print("  正文：" + sec2.text[:160].replace("\n", " "))

print("\n=== 5) 文档内检索「缺口」===")
for h in docmap.search(html, "缺口", limit=4):
    print(f"  段落 {h['block']}  命中 {h['hits']}  {h['snippet'][:80]}")

print("\n=== 6) agent 自己决定用什么工具 ===")
for q in ["这份文档分几个部分", "第 2 部分讲了什么", "文档里提到缺口的有哪些地方"]:
    r = run_agent(html, q)
    print(f"  问：{q}")
    print(f"    工具：{r['toolsUsed']}")
    print(f"    答：{r['answer'][:110].replace(chr(10), ' | ')}")
