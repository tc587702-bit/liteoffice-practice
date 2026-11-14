"""
向量 vs BM25 vs 混合：同一批题目的 recall 对比

    python tools/eval_hybrid.py

题目来自 data/eval/synonyms.jsonl（10 道"换说法"）+ questions.jsonl（22 道原词）。
判分口径与 eval_expand.py 一致：命中目标文档即算 recall 命中。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

from app import embed, kb
from app.embed_local import get_embedder
from app.query_expand import search_expanded

LAB = ROOT
KB_ID = os.getenv("LITEOFFICE_EVAL_KB", "gongwen")


def load_rows(name: str) -> list[dict]:
    path = LAB / "data" / "eval" / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def hit_doc(hit: dict) -> str:
    return str(hit.get("docId") or hit.get("docName") or "")


def score(hits: list[dict], row: dict, k: int) -> bool:
    target = str(row["doc"])
    any_words = row.get("any") or []
    for h in hits[:k]:
        doc_id = str(h.get("docId") or "")
        if target in doc_id or target in str(h.get("docName") or ""):
            return True
        text = str(h.get("text") or "")
        if any_words and all(w in text for w in any_words):
            return True
    return False


def evaluate(rows: list[dict], mode: str, emb=None) -> dict:
    r1 = r3 = 0
    mrr = 0.0
    for row in rows:
        q = row.get("q") or row.get("q_original") or ""
        if mode == "bm25":
            hits, _ = search_expanded(kb, KB_ID, q, top_k=3)
        elif mode == "vector":
            qv = emb.embed_query(q)
            hits = embed.vector_search(KB_ID, qv, top_k=3)
        else:
            out = embed.hybrid_search(KB_ID, q, embedder=emb, top_k=3)
            hits = out.get("hits") or []
        if score(hits, row, 1):
            r1 += 1
        if score(hits, row, 3):
            r3 += 1
        for rank, h in enumerate(hits[:3], 1):
            if score([h], row, 1):
                mrr += 1.0 / rank
                break
    n = max(1, len(rows))
    return {"n": len(rows), "r1": r1, "r3": r3, "mrr": mrr / n}


def line(tag: str, res: dict) -> str:
    return f"  {tag:<10} recall@1 {res['r1']}/{res['n']}   recall@3 {res['r3']}/{res['n']}   MRR {res['mrr']:.3f}"


def main() -> int:
    syn = load_rows("synonyms.jsonl")
    full = load_rows("questions.jsonl")
    print(f"库：{KB_ID}   换说法题 {len(syn)} 道   原词题 {len(full)} 道\n")

    emb = get_embedder()
    stats = embed.vector_stats(KB_ID)
    print(f"向量覆盖：{stats}\n")

    for title, rows in (("换说法题", syn), ("原词题", full)):
        print(f"{title}")
        print(line("BM25", evaluate(rows, "bm25")))
        print(line("向量", evaluate(rows, "vector", emb)))
        print(line("混合", evaluate(rows, "hybrid", emb)))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
