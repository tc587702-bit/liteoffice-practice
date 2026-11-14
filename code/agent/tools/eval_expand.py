"""对比评测：BM25 原始 vs 同义词扩展 + RRF

    python tools/eval_expand.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
os.environ["LITEOFFICE_KB_DB"] = str(LAB / "data" / "kb.db")
sys.path.insert(0, str(LAB))

from app import kb
from app.query_expand import expand, search_expanded

SYN = LAB / "data" / "eval" / "synonyms.jsonl"
FULL = LAB / "data" / "eval" / "questions.jsonl"


def is_correct(hit: dict, doc_sub: str, words: list[str]) -> bool:
    return doc_sub in hit["docName"] and any(w in hit["text"] for w in words)


def run(rows, use_expand: bool) -> tuple[int, int, float]:
    r1 = r3 = 0
    mrr = 0.0
    for row in rows:
        if use_expand:
            hits, _ = search_expanded(kb, "lab", row["q"], top_k=3)
        else:
            hits = kb.search("lab", row["q"], top_k=3)
        flags = [is_correct(h, row["doc"], row["any"]) for h in hits]
        first = next((i for i, ok in enumerate(flags, 1) if ok), None)
        if first == 1:
            r1 += 1
        if first and first <= 3:
            r3 += 1
        if first:
            mrr += 1.0 / first
    n = len(rows) or 1
    return r1, r3, mrr / n


def main() -> int:
    syn = [json.loads(x) for x in SYN.read_text(encoding="utf-8").splitlines() if x.strip()]
    full = [json.loads(x) for x in FULL.read_text(encoding="utf-8").splitlines() if x.strip()]

    print("=== 同义改写题（10 题，用户换说法）===")
    b1, b3, bm = run(syn, False)
    e1, e3, em = run(syn, True)
    print(f"  原始 BM25      recall@1 {b1}/{len(syn)}  recall@3 {b3}/{len(syn)}  MRR {bm:.3f}")
    print(f"  + 同义扩展     recall@1 {e1}/{len(syn)}  recall@3 {e3}/{len(syn)}  MRR {em:.3f}")
    print(f"  recall@1 变化  {(e1 - b1) / len(syn) * 100:+.0f} 个百分点")

    print("\n=== 原词题（22 题，验证不回归）===")
    f1, f3, fm = run(full, False)
    g1, g3, gm = run(full, True)
    print(f"  原始 BM25      recall@1 {f1}/{len(full)}  recall@3 {f3}/{len(full)}  MRR {fm:.3f}")
    print(f"  + 同义扩展     recall@1 {g1}/{len(full)}  recall@3 {g3}/{len(full)}  MRR {gm:.3f}")

    print("\n=== 扩展样例（看它到底换了什么词）===")
    for q in ["拆迁户怎么安置", "老问题怎么清", "种粮补助发给谁"]:
        print(f"  {q}")
        for v in expand(q):
            print(f"    → {v}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
