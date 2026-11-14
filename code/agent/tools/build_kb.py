"""把抓取的网页公文 + 桌面 docx 一起入库（实验区独立库）

    python tools/build_kb.py

数据来源：
  data/web/gongwen/*.txt        网上抓取的公文（7 份）
  C:/Users/16595/Desktop/朵文件/*.docx   本地公文（4 份）

输出：data/kb.db（agent、API、评测共用这一份）
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
os.environ["LITEOFFICE_KB_DB"] = str(LAB / "data" / "kb.db")
sys.path.insert(0, str(LAB))

from docx import Document

from app import kb
from app.multigenre import GENRE_KB

# 本脚本装的是【公文】。原来写 "lab"，而 multigenre 的 "lab" 指实验报告，
# 同名不同义曾导致公文被当实验报告范文、评测查空库出 0%。
KB_ID = GENRE_KB["gongwen"]
WEB = LAB / "data" / "web" / "gongwen"
DESKTOP = Path(r"C:\Users\16595\Desktop\朵文件")


def docx_to_html(path: Path) -> str:
    """把 docx 转成带标题层级的 HTML，便于 kb 按标题切块"""
    doc = Document(str(path))
    out: list[str] = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        style = (p.style.name or "").lower()
        if style.startswith("heading"):
            lvl = "".join(ch for ch in style if ch.isdigit()) or "2"
            lvl = lvl if lvl in "123456" else "2"
            out.append(f"<h{lvl}>{t}</h{lvl}>")
        else:
            out.append(f"<p>{t}</p>")
    for t in doc.tables:
        rows = []
        for row in t.rows:
            seen: list[str] = []
            for c in row.cells:
                text = c.text.strip()
                # 合并单元格在 python-docx 里会把同一段文字重复返回，连续去重
                if text and (not seen or seen[-1] != text):
                    seen.append(text)
            if seen:
                rows.append("<tr>" + "".join(f"<td>{t2}</td>" for t2 in seen) + "</tr>")
        if rows:
            out.append("<table>" + "".join(rows) + "</table>")
    return "\n".join(out)


def main() -> int:
    # 每次从空库开始，保证结果可复现
    db = Path(os.environ["LITEOFFICE_KB_DB"])
    if db.exists():
        db.unlink()
        for suffix in ("-wal", "-shm"):
            p = Path(str(db) + suffix)
            if p.exists():
                p.unlink()
    print(f"库文件：{db}（已清空重建）\n")

    total = 0
    added = 0

    print("=== 网上抓取的公文 ===")
    for f in sorted(WEB.glob("*.txt")):
        text = f.read_text(encoding="utf-8")
        r = kb.add_document(KB_ID, f.name, text)
        total += 1
        if not r["deduped"]:
            added += 1
        print(f"  {len(text):5d} 字 → {r['chunks']:2d} 块  {f.name}{'（重复跳过）' if r['deduped'] else ''}")

    print("\n=== 本地 docx ===")
    for f in sorted(DESKTOP.glob("*.docx")):
        html = docx_to_html(f)
        if len(html) < 200:
            print(f"  跳过（内容过短）: {f.name}")
            continue
        r = kb.add_document(KB_ID, f.name, html)
        total += 1
        if not r["deduped"]:
            added += 1
        print(f"  {len(html):5d} 字符 → {r['chunks']:2d} 块  {f.name[:40]}")

    stats = kb.kb_stats(KB_ID)
    print("\n=== 入库完成 ===")
    print(f"  文档 {stats['documents']} 份 / 块 {stats['chunks']} 个 / 约 {stats['bytes']:,} 字节")
    print(f"  实际新增 {added} / 扫描 {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
