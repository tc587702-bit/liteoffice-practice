"""真模型下，验证 agent 对文档的理解（当前文档 vs 知识库）"""
from __future__ import annotations

import time

import requests
from docx import Document

BASE = "http://127.0.0.1:8101"
SRC = r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx"


def docx_html(path: str) -> str:
    doc = Document(path)
    out: list[str] = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if t:
            out.append(f"<p>{t}</p>")
    return "\n".join(out)


html = docx_html(SRC)
print(f"文档 HTML：{len(html)} 字符\n")

QS = [
    "这份文档分几个部分？每部分讲什么？",
    "第 2 部分具体说了什么？把关键数字列出来",
    "文档里缺口数据一共有几处？分别是什么？",
    "这份文档的结论是什么？下一步该做什么？",
]

for i, q in enumerate(QS, 1):
    t0 = time.time()
    r = requests.post(f"{BASE}/v1/agent/run", json={"html": html, "query": q}, timeout=240).json()
    print("=" * 72)
    print(f"[{i}] {q}")
    print(f"     工具 {r['toolsUsed']}  耗时 {time.time()-t0:.1f}s")
    for line in (r["answer"] or "").split("\n")[:6]:
        if line.strip():
            print("     " + line[:150])
    print()
