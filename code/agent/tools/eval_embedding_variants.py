"""四配置对比：mean/CLS × 指令开/关，内存里算，不写库"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from app import kb

MODEL = ROOT / "data" / "models" / "bge-small-zh-v1.5"
KB_ID = "gongwen"
INSTR = "为这个句子生成表示以用于检索相关文章："

tok = AutoTokenizer.from_pretrained(str(MODEL))
mdl = AutoModel.from_pretrained(str(MODEL))
mdl.eval()


def load(name: str) -> list[dict]:
    return [json.loads(x) for x in (ROOT / "data" / "eval" / name).read_text(encoding="utf-8").splitlines() if x.strip()]


def encode(texts: list[str], pool: str) -> torch.Tensor:
    enc = tok(texts, padding=True, truncation=True, max_length=256, return_tensors="pt")
    with torch.no_grad():
        h = mdl(**enc).last_hidden_state
    if pool == "cls":
        v = h[:, 0]
    else:
        m = enc["attention_mask"].unsqueeze(-1).float()
        v = (h * m).sum(1) / m.sum(1).clamp(min=1e-6)
    return F.normalize(v, dim=1)


def chunks() -> list[dict]:
    rows = kb.list_chunks(KB_ID) if hasattr(kb, "list_chunks") else []
    if rows:
        return rows
    conn = kb.connect()
    cur = conn.execute(
        "select id, doc_id, ord, heading, text from kb_chunk where kb_id=? order by doc_id, ord", (KB_ID,)
    )
    return [{"id": r[0], "doc": r[1], "ord": r[2], "heading": r[3] or "", "text": r[4]} for r in cur.fetchall()]


def score_at(hits: list[dict], row: dict, k: int) -> bool:
    target = str(row["doc"])
    anyw = row.get("any") or []
    for h in hits[:k]:
        if target in str(h.get("doc", "")):
            return True
        if anyw and all(w in str(h.get("text", "")) for w in anyw):
            return True
    return False


def main() -> int:
    ch = chunks()
    texts = [f"{c['heading']}\n{c['text']}" if c["heading"] else c["text"] for c in ch]
    print(f"块数 {len(ch)}")
    syn, full = load("synonyms.jsonl"), load("questions.jsonl")

    for pool in ("mean", "cls"):
        doc_vecs = encode(texts, pool)
        for use_instr in (False, True):
            qs_syn = [(r["q"], r) for r in syn]
            qs_full = [(r.get("q") or r.get("q_original"), r) for r in full]
            for tag, pairs in (("换说法", qs_syn), ("原词", qs_full)):
                queries = [(INSTR + q) if use_instr else q for q, _ in pairs]
                qv = encode(queries, pool)
                r1 = r3 = 0
                for i, (_, row) in enumerate(pairs):
                    sims = (doc_vecs @ qv[i]).tolist()
                    order = sorted(range(len(sims)), key=lambda j: -sims[j])[:3]
                    hits = [{"doc": ch[j]["doc"], "text": ch[j]["text"]} for j in order]
                    r1 += score_at(hits, row, 1)
                    r3 += score_at(hits, row, 3)
                print(f"  pool={pool:<5} instr={use_instr!s:<5} {tag}: r@1 {r1}/{len(pairs)}  r@3 {r3}/{len(pairs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
