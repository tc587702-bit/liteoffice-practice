"""RAG 检索评测：recall@1 / recall@3 / MRR + 逐题明细

    python tools/eval_kb.py

判定标准：
  一条命中算“正确” = 文档名包含期望片段 且 文本含任一期望关键词
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

# 这 22 题问的是公文语料。公文原在 "lab" 库，已迁到 "gongwen"；
# 这里引用映射而不是写死字符串，避免下次改库名时评测又静默变成 0%。
EVAL_KB = GENRE_KB["gongwen"]

QUESTIONS = LAB / "data" / "eval" / "questions.jsonl"


def is_correct(hit: dict, doc_sub: str, words: list[str]) -> bool:
    if doc_sub not in hit["docName"]:
        return False
    text = hit["text"]
    return any(w in text for w in words)


def main() -> int:
    rows = [json.loads(x) for x in QUESTIONS.read_text(encoding="utf-8").splitlines() if x.strip()]
    r1 = r3 = 0
    mrr = 0.0
    precision3 = []
    details = []

    for row in rows:
        hits = kb.search(EVAL_KB, row["q"], top_k=3)
        flags = [is_correct(h, row["doc"], row["any"]) for h in hits]
        first = next((i for i, ok in enumerate(flags, 1) if ok), None)
        if first == 1:
            r1 += 1
        if first and first <= 3:
            r3 += 1
        if first:
            mrr += 1.0 / first
        precision3.append(sum(flags) / 3 if flags else 0.0)
        details.append((row["q"], first, [h["docName"][:26] for h in hits[:3]]))

    n = len(rows)
    stat = kb.kb_stats(EVAL_KB)
    print(f"题目数：{n}   语料库：{EVAL_KB}   {stat['documents']} 份 / {stat['chunks']} 块")
    if not stat["chunks"]:
        # 空库跑出的 0% 是配置错误，不是检索能力差；必须显式报警而不是静默出分
        print(f"  ⚠️ 库 {EVAL_KB} 是空的，本次指标无意义（检查库名或先建库）")
    print()
    print("=== 明细 ===")
    for q, first, names in details:
        mark = "OK  " if first == 1 else ("TOP3" if first else "MISS")
        rank = f"第{first}条" if first else "未命中"
        print(f"  {mark} {rank:8} {q[:28]:30}  {names[0] if names else '-'}")

    print("\n=== 指标 ===")
    print(f"  recall@1     {r1}/{n} = {r1 / n * 100:.1f}%")
    print(f"  recall@3     {r3}/{n} = {r3 / n * 100:.1f}%")
    print(f"  MRR          {mrr / n:.3f}")
    print(f"  precision@3  {sum(precision3) / n:.3f}")

    miss = [q for q, first, _ in details if not first]
    if miss:
        print("\n=== 未命中 ===")
        for q in miss:
            print(f"  · {q}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
