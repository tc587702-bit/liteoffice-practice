"""验证文档优化建议（定性版，无分数）"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from docx import Document

from app import improve

SRC = Path(r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx")


def docx_html(path: Path) -> str:
    doc = Document(str(path))
    out = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if t:
            out.append(f"<p>{t}</p>")
    return "\n".join(out)


html = docx_html(SRC)
r = improve.analyze(html)

print(f"文档：{SRC.name}")
print(f"概览：{r['summary']}")
print()
for d in r["dims"].values():
    print(f"  {d['label']:<4} {d['status']:<6} {d['count']} 条")

print(f"\n共 {len(r['issues'])} 条建议：")
for i, it in enumerate(r["issues"], 1):
    print(f"\n  {i}. [{it['levelLabel']}] {it['problem']}")
    print(f"     位置：{it['where']}")
    print(f"     为什么：{it['why']}")
    print(f"     怎么改：{it['how']}")
    if it["excerpt"]:
        print(f"     原文：{it['excerpt'][:50]}…")
