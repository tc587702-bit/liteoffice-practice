"""列出知识库各文体的文档清单与规模

    python tools/list_docs.py            # 全部文体概览
    python tools/list_docs.py gongwen    # 只看某一类的逐份清单
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
os.environ["LITEOFFICE_KB_DB"] = str(LAB / "data" / "kb.db")
sys.path.insert(0, str(LAB))

from app import kb
from app.multigenre import GENRE_KB, GENRE_LABEL, all_stats


def main() -> int:
    want = sys.argv[1] if len(sys.argv) > 1 else ""

    if want:
        kb_id = GENRE_KB.get(want, want)
        docs = kb.list_documents(kb_id)
        print(f"=== {GENRE_LABEL.get(want, want)}（{kb_id}）===")
        for d in docs:
            print(f"{d['chunks']:4d} 块  {d['name'][:70]}")
        stat = kb.kb_stats(kb_id)
        print(f"总计 {len(docs)} 份 / {stat['chunks']} 块")
        return 0

    print("=== 全部文体概览 ===")
    stats = all_stats()
    total_docs = total_chunks = 0
    for v in stats.values():
        total_docs += v["documents"]
        total_chunks += v["chunks"]
        flag = "" if v["chunks"] else "  ← 空库"
        print(f"  {v['label']:<6} {v['kbId']:<12} {v['documents']:3d} 份 / {v['chunks']:5d} 块 / {v['terms']:2d} 术语{flag}")
    print(f"\n合计 {total_docs} 份 / {total_chunks} 块")
    print("\n看某一类的逐份清单：python tools/list_docs.py <文体>")
    print("可用文体：" + " ".join(GENRE_KB))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())