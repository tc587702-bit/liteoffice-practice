"""三种融合策略对比（库内向量 + BM25）：等权 RRF / 加权 RRF / 并集优先"""
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

KB_ID = "gongwen"

# doc_id → 文档名（向量命中里没有 docName，判分前必须补齐，否则会冤枉向量）
DOC_NAME: dict[str, str] = {}


def prime_doc_names() -> None:
    conn = kb.connect()
    for doc_id, name in conn.execute("select id, name from kb_doc where kb_id=?", (KB_ID,)):
        DOC_NAME[str(doc_id)] = str(name)


def with_name(hits: list[dict]) -> list[dict]:
    out = []
    for h in hits:
        h = dict(h)
        doc_id = str(h.get("docId") or h.get("doc_id") or "")
        h["docId"] = doc_id
        h.setdefault("docName", DOC_NAME.get(doc_id, ""))
        out.append(h)
    return out


def load(name: str) -> list[dict]:
    return [json.loads(x) for x in (ROOT / "data" / "eval" / name).read_text(encoding="utf-8").splitlines() if x.strip()]


def key(h: dict) -> str:
    return str(h.get("chunkId") or h.get("id") or "") + str(h.get("docId") or h.get("doc") or "")


def ok(hits: list[dict], row: dict, k: int) -> bool:
    target = str(row["doc"])
    anyw = row.get("any") or []
    for h in hits[:k]:
        if target in str(h.get("docName") or "") or target in str(h.get("docId") or ""):
            return True
        if anyw and all(w in str(h.get("text", "")) for w in anyw):
            return True
    return False


def rrf(lists: list[list[dict]], weights: list[float], top_k: int = 3) -> list[dict]:
    score: dict[str, float] = {}
    store: dict[str, dict] = {}
    for hits, w in zip(lists, weights):
        for rank, h in enumerate(hits, 1):
            k = key(h)
            score[k] = score.get(k, 0.0) + w / (60 + rank)
            store.setdefault(k, h)
    order = sorted(score, key=lambda x: -score[x])[:top_k]
    return [store[k] for k in order]


def union(bm25: list[dict], vec: list[dict], top_k: int = 3) -> list[dict]:
    """BM25 命中的排前面，向量命中补空位（保精确匹配、补语义召回）"""
    out: list[dict] = []
    seen: set[str] = set()
    for h in bm25:
        k = key(h)
        if k not in seen:
            seen.add(k)
            out.append(h)
        if len(out) >= top_k:
            return out
    for h in vec:
        k = key(h)
        if k not in seen:
            seen.add(k)
            out.append(h)
        if len(out) >= top_k:
            break
    return out


def main() -> int:
    prime_doc_names()
    emb = get_embedder()
    for name, title in (("synonyms.jsonl", "换说法题"), ("questions.jsonl", "原词题")):
        rows = load(name)
        stats = {m: [0, 0] for m in ("bm25", "vec", "rrf_eq", "rrf_w", "union")}
        for row in rows:
            q = row.get("q") or row.get("q_original") or ""
            bm, _ = search_expanded(kb, KB_ID, q, top_k=10)
            bm = with_name(bm)
            vh = with_name(embed.vector_search(KB_ID, emb.embed_query(q), top_k=10))
            cands = {
                "bm25": bm[:3],
                "vec": vh[:3],
                "rrf_eq": rrf([bm, vh], [1.0, 1.0]),
                "rrf_w": rrf([bm, vh], [1.0, 0.35]),
                "union": union(bm, vh),
            }
            for mode, hits in cands.items():
                stats[mode][0] += ok(hits, row, 1)
                stats[mode][1] += ok(hits, row, 3)
        n = len(rows)
        print(f"\n{title}（{n} 道）")
        labels = {"bm25": "BM25", "vec": "纯向量", "rrf_eq": "等权RRF", "rrf_w": "加权RRF(0.35)", "union": "并集优先"}
        for mode in ("bm25", "vec", "rrf_eq", "rrf_w", "union"):
            r1, r3 = stats[mode]
            print(f"  {labels[mode]:<14} recall@1 {r1:>2}/{n}   recall@3 {r3:>2}/{n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
