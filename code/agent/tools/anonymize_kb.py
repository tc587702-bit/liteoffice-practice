"""
对知识库语料执行脱敏（上云部署前的前置步骤）。

做什么：
  扫描 kb_chunk.text，用 app/anonymize.py 的规则替换个人敏感信息，
  并把被改动块的向量清空（文本变了，旧向量语义已不匹配，需重算）。

不做什么：
  · 不改 kb_doc 的 sha256 与 bytes（那是原始文件的指纹，改了会破坏去重语义）
  · 不删除任何文档或块
  · 不动 term 表

用法：
    python tools/anonymize_kb.py --dry-run     # 只报告，不写库
    python tools/anonymize_kb.py               # 执行（自动备份）
    python tools/anonymize_kb.py --no-contact  # 保留机构公开邮箱/固话

执行后需要重算向量：
    python tools/build_vectors.py
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import os

os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

from app import anonymize as ANON
from app import kb


def backup(db_path: Path) -> Path | None:
    if not db_path.exists():
        return None
    bak = db_path.with_name(f"{db_path.stem}.bak-anon-{time.strftime('%Y%m%d-%H%M%S')}{db_path.suffix}")
    shutil.copy2(db_path, bak)
    return bak


def main() -> int:
    ap = argparse.ArgumentParser(description="知识库语料脱敏")
    ap.add_argument("--dry-run", action="store_true", help="只报告将要做的改动，不写库")
    ap.add_argument("--no-contact", action="store_true", help="保留邮箱/固话（机构公开联系方式）")
    ap.add_argument("--kb", default=None, help="只处理指定 kb_id")
    args = ap.parse_args()

    mask_contact = not args.no_contact
    db_path = Path(kb.DB_PATH)
    print(f"库文件：{db_path}")
    print(f"模式：{'演练（不写库）' if args.dry_run else '执行'}")
    print(f"联系方式脱敏：{'是' if mask_contact else '否（保留邮箱/固话）'}\n")

    conn = kb.connect()
    # kb_doc 与 kb_chunk 都有 kb_id 列，JOIN 后必须加表别名，否则 ambiguous column name
    where = "WHERE c.kb_id = ?" if args.kb else ""
    params = (args.kb,) if args.kb else ()
    rows = conn.execute(
        f"SELECT c.id, c.kb_id, c.doc_id, c.ord, c.text, d.name AS doc_name "
        f"FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id {where} "
        f"ORDER BY d.name, c.ord",
        params,
    ).fetchall()
    print(f"扫描 {len(rows)} 个块…\n")

    changed: list[tuple[str, str, str, Counter]] = []   # (chunk_id, kb_id, doc_name, hits)
    total_hits: Counter = Counter()
    per_doc: dict[str, Counter] = {}
    names_seen: Counter = Counter()

    for r in rows:
        res = ANON.mask_text(r["text"], mask_names=True, mask_contact=mask_contact)
        n = sum(res.hits.values())
        if n == 0:
            continue
        changed.append((r["id"], r["kb_id"], r["doc_name"], res.hits))
        total_hits.update(res.hits)
        key = f"[{r['kb_id']}] {r['doc_name']}"
        per_doc.setdefault(key, Counter()).update(res.hits)
        for nm in res.names:
            names_seen[nm] += 1

    print("=" * 74)
    print(f"受影响：{len(changed)} 个块 / {len(per_doc)} 份文档（共 {len(rows)} 块）")
    print("=" * 74)
    for kind, n in total_hits.most_common():
        print(f"  {kind:14} {n:4} 处")
    print(f"  {'合计':14} {sum(total_hits.values()):4} 处")

    print("\n--- 按文档 ---")
    for doc, hits in sorted(per_doc.items(), key=lambda kv: -sum(kv[1].values())):
        detail = "，".join(f"{k} {v}" for k, v in hits.most_common())
        print(f"  {doc[:56]:58} {detail}")

    if names_seen:
        print("\n--- 识别出的人名（掩码显示，供人工抽查是否误伤）---")
        for nm, c in names_seen.most_common():
            shown = nm[0] + "*" * (len(nm) - 1) if len(nm) > 1 else nm
            print(f"  {shown:6} 出现 {c} 次")

    if not changed:
        print("\n没有需要脱敏的内容。")
        conn.close()
        return 0

    print("\n--- 改动样例（前 3 块，掩码后）---")
    for cid, kb_id, doc_name, hits in changed[:3]:
        before = next(r["text"] for r in rows if r["id"] == cid)
        after = ANON.mask_text(before, mask_names=True, mask_contact=mask_contact).text
        print(f"\n  [{kb_id}] {doc_name[:40]}  ({dict(hits)})")
        # 只打印发生变化的片段附近，避免整块刷屏
        for i, (a, b) in enumerate(zip(before, after)):
            if a != b:
                lo = max(0, i - 25)
                print(f"    改前: …{before[lo:i + 45]}…")
                print(f"    改后: …{after[lo:i + 45]}…")
                break

    if args.dry_run:
        print("\n[演练模式] 未写入任何改动。去掉 --dry-run 即执行（会自动备份库文件）。")
        conn.close()
        return 0

    bak = backup(db_path)
    print(f"\n已备份：{bak}" if bak else "\n⚠️ 未能创建备份")

    try:
        with conn:
            for cid, _kb_id, _doc, _hits in changed:
                row = next(r for r in rows if r["id"] == cid)
                masked = ANON.mask_text(row["text"], mask_names=True, mask_contact=mask_contact).text
                # 同时清空向量：文本已变，旧向量语义不再匹配，必须重算
                conn.execute(
                    "UPDATE kb_chunk SET text = ?, vec = NULL WHERE id = ?", (masked, cid)
                )
    finally:
        conn.close()

    print(f"已脱敏 {len(changed)} 个块，并清空这些块的向量（需重算）。")
    print("\n下一步：python tools/build_vectors.py   # 重算被清空块的向量")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
