"""对比两份公文（定性版）"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from docx import Document

from app import improve

DOCS = [
    Path(r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx"),
    Path(r"C:\Users\16595\Desktop\朵文件\关于新盐关街小学建设项目国有土地上房屋征收货币补偿有关情况的汇报.docx"),
]


def docx_html(path: Path) -> str:
    doc = Document(str(path))
    out = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if t:
            out.append(f"<p>{t}</p>")
    return "\n".join(out)


for path in DOCS:
    if not path.exists():
        print(f"跳过（不存在）：{path.name}")
        continue
    r = improve.analyze(docx_html(path))
    print("=" * 70)
    print(f"文档：{path.name[:38]}")
    print(f"概览：{r['summary']}")
    for d in r["dims"].values():
        print(f"   {d['label']:<4} {d['status']:<6} {d['count']} 条")
    for it in r["issues"]:
        print(f"   [{it['levelLabel']}] {it['problem']}｜{it['where']}")
    print()
