"""扫一遍向量权重，找「换说法不掉、原词也不掉」的点"""
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
DOC_NAME: dict[str, str] = {}


def load(name: str) -> list[dict]:
    return [json.loads(x) for x in (ROOT / "data" / "eval" / name).read_text(encoding="utf-8").splitlines() if x.strip()]


def prime() -> None:
    conn = kb.connect()
    for doc_id, name in conn.execute("select id, name from kb_doc where kb_id=?", (KB_ID,)):
        DOC_NAME[str(doc_id)] = str(name)


def judge(hits: list[dict], row: dict, k: int) -> bool:
    tgt = str(row["doc"])
    anyw = row.get("any") or []
    for h in hits[:k]:
        if tgt in str(DOC_NAME.get(str(h.get("docId") or h.get("doc_id") or ""), "")):
            return True
        if anyw and all(w in str(h.get("text", "")) for w in anyw):
            return True
    return False


def wtd(bm: list[dict], vh: list[dict], w: float, top_k: int = 3) -> list[dict]:
    score: dict[str, float] = {}
    store: dict[str, dict] = {}
    for hits, weight in ((bm, 1.0), (vh, w)):
        for rank, h in enumerate(hits, 1):
            key = str(h.get("chunkId") or h.get("id") or "")
            score[key] = score.get(key, 0.0) + weight / (60 + rank)
            store.setdefault(key, h)
    return [store[k] for k in sorted(score, key=lambda x: -score[x])[:top_k]]


def main() -> int:
    prime()
    emb = get_embedder()
    syn, full = load("synonyms.jsonl"), load("questions.jsonl")

    bm_cache: dict[str, list[dict]] = {}
    vh_cache: dict[str, list[dict]] = {}

    def prep(rows: list[dict]) -> None:
        for row in rows:
            q = row.get("q") or row.get("q_original") or ""
            if q in bm_cache:
                continue
            bm_cache[q] = search_expanded(kb, KB_ID, q, top_k=10)[0]
            vh_cache[q] = embed.vector_search(KB_ID, emb.embed_query(q), top_k=10, min_sim=0.45)

    prep(syn)
    prep(full)

    print(f"{'权重':<8}{'换说法 r@1':<12}{'换说法 r@3':<12}{'原词 r@1':<10}{'原词 r@3':<10}")
    for w in (0.0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.5, 1.0):
        line = [f"{w:<8.2f}"]
        for rows in (syn, full):
            r1 = r3 = 0
            for row in rows:
                q = row.get("q") or row.get("q_original") or ""
                hits = wtd(bm_cache[q], vh_cache[q], w) if w > 0 else bm_cache[q][:3]
                r1 += judge(hits, row, 1)
                r3 += judge(hits, row, 3)
            line.append(f"{r1}/{len(rows):<10}")
            line.append(f"{r3}/{len(rows):<10}")
        print("".join(f"{x:<22}" if i == 0 else f"{x:<12}" for i, x in enumerate(line)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
