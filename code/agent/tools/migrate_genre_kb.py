"""
迁移既有 "lab" 库（内容是 25 份公文）到按文体分库的结构。

为什么需要：
  build_kb.py 用 KB_ID = "lab" 装的是【公文】，而 multigenre 的 "lab"
  指【实验报告】文体。同名不同义，不迁移就会拿公文当实验报告范文。

做什么：
  1. 把 kb_doc / kb_chunk 里 kb_id='lab' 的记录改到 kb_id='gongwen'
  2. 术语表里那条「硅二极管→硅整流二极管」属实验报告领域，
     从 gongwen 库删掉（multigenre.GENRE_TERMS['lab'] 里已归位）
  3. 为六类文体各写入术语表与 kb 记录

不做什么：
  · 不重新切块。既有 145 块是用 kb.chunk_html 切的（无文体策略），
    迁移后仍可用；要用新策略需重新入库（--rechunk，见下）。
  · 不动向量。vec 字段本来就是空的。

用法：
    # 先演练（只打印，不写库）
    python tools/migrate_genre_kb.py --dry-run

    # 实际迁移（会先备份库文件）
    python tools/migrate_genre_kb.py

    # 迁移 + 用文体策略重新切块（需要原始文档还在，会重建 gongwen 库）
    python tools/migrate_genre_kb.py --rechunk

备份：迁移前把库文件复制成 <库名>.bak-<时间戳>，失败可手工还原。
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT))

from app import kb
from app import multigenre as MG


def backup_db(db_path: Path) -> Path | None:
    """迁移前备份库文件（含 -wal/-shm）"""
    if not db_path.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = db_path.with_name(f"{db_path.stem}.bak-{stamp}{db_path.suffix}")
    shutil.copy2(db_path, bak)
    return bak


def migrate(dry_run: bool = False) -> int:
    src = MG.LEGACY_KB_ID          # "lab"（内容是公文）
    dst = MG.GENRE_KB["gongwen"]   # "gongwen"

    db_path = Path(kb.DB_PATH)
    print(f"库文件：{db_path}")
    print(f"迁移方向：kb_id '{src}' → '{dst}'")

    conn = kb.connect()
    docs = conn.execute("SELECT COUNT(*) c FROM kb_doc WHERE kb_id = ?", (src,)).fetchone()["c"]
    chunks = conn.execute("SELECT COUNT(*) c FROM kb_chunk WHERE kb_id = ?", (src,)).fetchone()["c"]
    terms = conn.execute("SELECT COUNT(*) c FROM term WHERE kb_id = ?", (src,)).fetchone()["c"]
    already = conn.execute("SELECT COUNT(*) c FROM kb_doc WHERE kb_id = ?", (dst,)).fetchone()["c"]
    print(f"  待迁移：文档 {docs} 份 / 块 {chunks} 个 / 术语 {terms} 条")
    print(f"  目标库已有：文档 {already} 份")

    if docs == 0:
        print("\n源库没有数据，无需迁移（可能已经迁移过，或库是空的）。")
        conn.close()
        return 0

    if already:
        print(f"\n⚠️ 目标库 '{dst}' 已有 {already} 份文档。")
        print("   两个库都保留会产生重复召回。请先确认目标库内容，再决定是否继续。")
        conn.close()
        return 1

    if dry_run:
        print("\n[演练模式] 不写入任何改动。实际执行会做：")
        print(f"  UPDATE kb_doc   SET kb_id='{dst}' WHERE kb_id='{src}'   → {docs} 行")
        print(f"  UPDATE kb_chunk SET kb_id='{dst}' WHERE kb_id='{src}'   → {chunks} 行")
        print(f"  DELETE FROM term WHERE kb_id='{dst}' AND term='硅二极管' → 该条属实验报告领域")
        print("  为六类文体写入 kb 记录与术语表")
        conn.close()
        return 0

    bak = backup_db(db_path)
    if bak:
        print(f"\n已备份：{bak}")

    try:
        with conn:
            conn.execute("UPDATE kb_doc SET kb_id = ? WHERE kb_id = ?", (dst, src))
            conn.execute("UPDATE kb_chunk SET kb_id = ? WHERE kb_id = ?", (dst, src))
            # 那条电子领域术语不该留在公文库；multigenre.GENRE_TERMS['lab'] 已收录
            conn.execute(
                "DELETE FROM term WHERE kb_id = ? AND term = ?", (dst, "硅二极管")
            )
            conn.execute("DELETE FROM kb WHERE id = ?", (src,))
        print("  已迁移文档与块")
    finally:
        conn.close()

    print("  写入六类文体的 kb 记录与术语表…")
    seeded = MG.seed_all_terms()
    for g, n in seeded.items():
        print(f"    {MG.GENRE_LABEL.get(g, g):6} 术语 {n} 条")

    conn = kb.connect()
    print("\n=== 迁移后各库规模 ===")
    for g, kb_id in MG.GENRE_KB.items():
        s = kb.kb_stats(kb_id)
        print(
            f"  {MG.GENRE_LABEL.get(g, g):6} [{kb_id:12}] "
            f"文档 {s['documents']:2} / 块 {s['chunks']:3} / 术语 {s['terms']:2}"
        )
    leftover = conn.execute("SELECT COUNT(*) c FROM kb_doc WHERE kb_id = ?", (src,)).fetchone()["c"]
    conn.close()
    print(f"\n源库 '{src}' 残留文档：{leftover}（应为 0）")
    print("完成。请跑一遍自检确认没退步：python -m app.multigenre")
    return 0 if leftover == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="把既有 lab 库（公文）迁移到按文体分库结构")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做的改动，不写库")
    ap.add_argument(
        "--rechunk", action="store_true",
        help="迁移后用文体切块策略重建 gongwen 库（需原始文档仍可访问）",
    )
    args = ap.parse_args()

    rc = migrate(dry_run=args.dry_run)
    if rc != 0 or args.dry_run:
        return rc

    if args.rechunk:
        print(
            "\n⚠️ --rechunk 需要原始公文文件（data/web/gongwen/*.txt 与桌面 docx）。\n"
            "   做法：清空 gongwen 库后，用 multigenre.ingest(name, content, genre='gongwen')\n"
            "   逐份重新入库 —— 这样才会走 _chunk_with_policy（表格带表头、按标题断块）。\n"
            "   本次未自动执行，避免误删既有数据。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
