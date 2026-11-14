"""知识库检索抽样（真实语料）

    python tools/ask_kb.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
os.environ["LITEOFFICE_KB_DB"] = str(LAB / "data" / "kb.db")
sys.path.insert(0, str(LAB))

from app import kb

QUERIES = [
    "绿色工厂推荐的申报条件是什么",
    "稻谷补贴资金怎么发放",
    "职业病危害专项治理的时间范围",
    "安置房建设进度怎么样",
    "指挥部第一次会议提出了哪些要求",
    "货币补偿的标准和依据",
]

for q in QUERIES:
    hits = kb.search("lab", q, top_k=3)
    print("=" * 70)
    print(f"问：{q}   命中 {len(hits)} 条")
    for i, h in enumerate(hits, 1):
        head = f"{h['docName']}"
        if h["heading"]:
            head += f" · {h['heading'][:18]}"
        snippet = h["text"].replace("\n", " ")[:100]
        print(f"  {i}. [{h['score']:.2f}] {head}")
        print(f"     #{h['ord']}  {snippet}…")
    print()
