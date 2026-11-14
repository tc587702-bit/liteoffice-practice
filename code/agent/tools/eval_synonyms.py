"""同义改写题评测：原词查询 vs 同义词查询（不改任何检索代码）

    python tools/eval_synonyms.py

目的：暴露纯 BM25 的真实短板——用文档里没有的词提问，还能不能检索到。
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
from app.multigenre import GENRE_KB

# 原来指向已废弃的 lab_kb.db + "lab" 库，双重失效；统一到主库的公文分库
EVAL_KB = GENRE_KB["gongwen"]

SRC = LAB / "data" / "eval" / "synonyms.jsonl"


def hit_rank(query: str, doc_sub: str, words: list[str], k: int = 3) -> int | None:
    for i, h in enumerate(kb.search(EVAL_KB, query, top_k=k), 1):
        if doc_sub in h["docName"] and any(w in h["text"] for w in words):
            return i
    return None


def main() -> int:
    rows = [json.loads(x) for x in SRC.read_text(encoding="utf-8").splitlines() if x.strip()]
    n = len(rows)
    orig1 = orig3 = 0
    syn1 = syn3 = 0

    print(f"题目数：{n}\n")
    print("=== 逐题对比 ===")
    print("  原词查询                         同义查询                     原词  同义")
    for r in rows:
        ro = hit_rank(r["q_original"], r["doc"], r["any"])
        rs = hit_rank(r["q"], r["doc"], r["any"])
        if ro == 1:
            orig1 += 1
        if ro and ro <= 3:
            orig3 += 1
        if rs == 1:
            syn1 += 1
        if rs and rs <= 3:
            syn3 += 1
        mark_o = f"第{ro}条" if ro else "未中"
        mark_s = f"第{rs}条" if rs else "未中"
        print(f"  {r['q_original'][:16]:18} {r['q'][:16]:18} {mark_o:6} {mark_s}")

    print("\n=== 指标 ===")
    print(f"  原词查询   recall@1 {orig1}/{n} = {orig1 / n * 100:.0f}%   recall@3 {orig3}/{n} = {orig3 / n * 100:.0f}%")
    print(f"  同义查询   recall@1 {syn1}/{n} = {syn1 / n * 100:.0f}%   recall@3 {syn3}/{n} = {syn3 / n * 100:.0f}%")
    drop = (orig1 - syn1) / n * 100 if n else 0
    print(f"  同义词导致的召回下降：{drop:.0f} 个百分点")

    if syn1 < orig1:
        print("\n结论：纯 BM25 对同义改写敏感，需要向量检索或查询扩展补齐。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
