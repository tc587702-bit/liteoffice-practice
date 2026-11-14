"""单文件体检：文体判定 + 是否已入库 + 检索抽样

    python tools/inspect_doc.py <文件.docx>
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
os.environ["LITEOFFICE_KB_DB"] = str(LAB / "data" / "lab_kb.db")
sys.path.insert(0, str(LAB))

from docx import Document

from app import kb
from app.classify_genre import classify


def extract(path: Path) -> tuple[str, list[str]]:
    doc = Document(str(path))
    paras = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    return "\n".join(paras), paras


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python tools/inspect_doc.py <文件.docx>")
        return 2
    path = Path(sys.argv[1])
    text, paras = extract(path)

    print("=== 基本信息 ===")
    print("  文件    :", path.name)
    print("  段落数  :", len(paras))
    print("  字数    :", len(text.replace("\n", "")))
    print("\n=== 前 160 字 ===")
    print("  " + text[:160].replace("\n", " / "))

    print("\n=== 文体判定 ===")
    r = classify(text)
    print("  结果    :", r.get("label") or "未判定", f" 置信度={r['confidence']:.3f}")
    print("  理由    :", r.get("reason", ""))
    for it in r["ranking"][:3]:
        s = it["signals"]
        print(f"    {it['label']:<6} {it['score']:.3f}  强={s['strong']} 弱={s['weak']} 格式={s['regex']}")

    print("\n=== 是否已在知识库 ===")
    docs = kb.list_documents("lab")
    same = [d for d in docs if path.stem[:12] in d["name"] or d["name"][:12] in path.stem]
    if same:
        for d in same:
            print(f"  已入库：{d['name'][:50]}  {d['chunks']} 块")
    else:
        print("  未入库（可用 tools/build_kb.py 重新入库）")

    print("\n=== 检索抽样（针对本文件主题）===")
    for q in ["城乡统筹发展服务中心近期开展了哪些工作", "服务中心的重点任务和推进情况"]:
        hits = kb.search("lab", q, top_k=2)
        print(f"  问：{q}  命中 {len(hits)}")
        for i, h in enumerate(hits, 1):
            print(f"    {i}. [{h['score']:.2f}] {h['docName'][:34]}  #{h['ord']}")
            print(f"       {h['text'].replace(chr(10), ' ')[:80]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
