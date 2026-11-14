"""把全部文体库的块算成向量，写入 kb_chunk.vec。

用法：
    python tools/build_vectors.py            # 补齐所有文体库的空向量
    python tools/build_vectors.py contract   # 只处理指定文体

只处理「vec 为空」的块，可重复运行、可中断续传。
全部库必须用同一个 embedding 模型，否则维度虽同、语义不可比
（embed.set_vectors 会用 manifest 里的维度做一致性校验，维度不同会直接拒绝）。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import os

os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

from app import embed, kb
from app import multigenre as MG
from app.classify_genre import GENRE_LABEL
from app.embed_local import get_embedder

BATCH = 32


def main() -> int:
    # 从 multigenre 动态取全部文体库：写死列表会在新增文体后漏建向量
    # （上一版就是硬编码 5 个库，导致新增的 5 类文体全是 0 向量）。
    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only:
        if only not in MG.GENRE_KB:
            print(f"未知文体：{only}；可选：{', '.join(sorted(MG.GENRE_KB))}")
            return 1
        targets = [(only, MG.GENRE_KB[only])]
    else:
        targets = list(MG.GENRE_KB.items())

    t0 = time.time()
    emb = get_embedder()
    print(f"模型：{emb.model_name}（维度 {emb.dim}），加载用时 {time.time() - t0:.1f}s")
    print(f"目标库：{len(targets)} 个\n")

    total = 0
    for genre, kb_id in targets:
        label = GENRE_LABEL.get(genre, genre)
        pending = embed.list_chunks(kb_id, only_missing=True)
        if not pending:
            have = embed.vector_stats(kb_id)
            note = f"已有向量 {have['embedded']}" if have["embedded"] else "空库，无语料"
            print(f"  {label:6} [{kb_id:<12}] 无待编码块（{note}）")
            continue

        print(f"  {label:6} [{kb_id:<12}] 待编码 {len(pending)} 块", end="", flush=True)
        t1 = time.time()
        done = 0
        for i in range(0, len(pending), BATCH):
            batch = pending[i : i + BATCH]
            texts = [c.get("embedText") or embed.embed_text_of(c["text"], c.get("heading") or "") for c in batch]
            vecs = emb(texts)
            r = embed.set_vectors(kb_id, {c["chunkId"]: v for c, v in zip(batch, vecs)}, model=emb.model_name)
            if not r.get("ok"):
                print(f"\n    ✗ 写入失败：{r.get('reason')}")
                return 1
            done += r["written"]
            print(".", end="", flush=True)
        embed.write_manifest(emb.model_name, emb.dim)
        print(f" → {done} 块，{time.time() - t1:.1f}s")
        total += done

    print(f"\n合计新写入 {total} 块，总用时 {time.time() - t0:.1f}s\n")

    print("=== 向量覆盖汇总 ===")
    missing_total = 0
    for genre, kb_id in targets:
        s = embed.vector_stats(kb_id)
        # vector_stats 返回 total / embedded / missing / dims / manifest（不是 chunks/dim/model）
        chunks = kb.kb_stats(kb_id)["chunks"]
        dims = ",".join(str(d) for d in s["dims"]) or "-"
        model = (s["manifest"] or {}).get("model") or "-"
        missing_total += s["missing"]
        flag = "✓" if s["missing"] == 0 and chunks else ("—" if not chunks else "⚠️")
        print(
            f"  {flag} {GENRE_LABEL.get(genre, genre):6} [{kb_id:<12}] "
            f"{s['embedded']}/{s['total']}  维度 {dims}  模型 {model}"
        )
    print(f"\n  未建向量总计：{missing_total} 块")
    return 0 if missing_total == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
