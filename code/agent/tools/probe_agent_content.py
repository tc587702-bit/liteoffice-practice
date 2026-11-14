"""验证 agent 对文档内容的处理能力（真实 docx → HTML → agent）

    python tools/probe_agent_content.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))
sys.path.insert(0, str(ROOT))

from docx import Document

from app.graph import run_agent
from app.tools import run_tool

SRC = Path(r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx")


def docx_to_html(path: Path) -> str:
    doc = Document(str(path))
    out = []
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
            cells = "".join(f"<td>{c.text.strip()}</td>" for c in row.cells if c.text.strip())
            if cells:
                rows.append(f"<tr>{cells}</tr>")
        if rows:
            out.append("<table>" + "".join(rows) + "</table>")
    return "\n".join(out)


html = docx_to_html(SRC)
print(f"文档 HTML：{len(html)} 字符")

print("\n=== 1) 能不能读出文字 ===")
r = run_tool("get_stats", html)
print("  get_stats:", r.summary)

print("\n=== 2) 能不能在文档里检索 ===")
r2 = run_tool("search_document", html, {"query": "安置房"})
print("  search_document:", r2.summary)
for h in (r2.data or {}).get("hits", [])[:2]:
    print("    ·", str(h)[:120])

print("\n=== 3) 能不能取大纲 ===")
r3 = run_tool("get_outline", html)
print("  get_outline:", r3.summary)

print("\n=== 4) 问一个需要理解内容的问题（无模型）===")
a = run_agent(html, "这段文档主要讲了什么")
print("  工具:", a["toolsUsed"])
print("  答案:", a["answer"][:200].replace("\n", " "))

print("\n=== 5) 问一个能用检索回答的问题 ===")
a2 = run_agent(html, "文档里提到的安置房缺口是多少")
print("  工具:", a2["toolsUsed"])
print("  答案:", a2["answer"][:200].replace("\n", " "))
