"""把语料建成公文知识库（agent、API、评测共用 data/kb.db）

    python tools/build_kb.py

语料来源（按顺序找，找到就用；也可用环境变量覆盖）：
  1. 环境变量 LITEOFFICE_CORPUS   自定义目录，多个用 ; 分隔
  2. data/corpus/                 仓库内语料目录（推荐，随代码 clone）
  3. data/web/gongwen/            网上抓取的公文 txt
  4. 桌面 朵文件/                  旧的本机路径（存在才用，别人机器上没有）

支持 .txt / .md / .docx。

注意：本脚本会清空重建 data/kb.db；一份语料都没找到时报错退出，不产出空库。
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime
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

CORPUS_SUFFIXES = (".txt", ".md", ".docx")


def corpus_dirs() -> list[Path]:
    """按优先级列出真实存在的语料目录"""
    candidates: list[Path] = []
    custom = os.getenv("LITEOFFICE_CORPUS", "").strip()
    if custom:
        # 只用分号分隔：Windows 路径里的冒号是盘符，不能当分隔符
        for chunk in custom.split(";"):
            chunk = chunk.strip()
            if chunk:
                candidates.append(Path(chunk).expanduser())
    # 只用显式指定的目录（用于自测"没有语料"的分支）
    if os.getenv("LITEOFFICE_CORPUS_ONLY") == "1" and custom:
        candidates = candidates[: len(candidates)]
    else:
        candidates.append(LAB / "data" / "corpus")
        candidates.append(LAB / "data" / "web" / "gongwen")
        candidates.append(Path.home() / "Desktop" / "朵文件")

    out: list[Path] = []
    seen: set[str] = set()
    for d in candidates:
        if not d.is_dir():
            continue
        key = str(d.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


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
    # 先确认有语料，再动库文件 —— 否则一份都没有时已经把库清空了，报错也救不回
    dirs = corpus_dirs()
    if not dirs:
        print("找不到任何语料目录。请把语料放到 code/agent/data/corpus/，")
        print("或设置环境变量 LITEOFFICE_CORPUS 指向语料目录。")
        return 2

    files: list[Path] = []
    for d in dirs:
        for f in sorted(d.rglob("*")):
            if f.is_file() and f.suffix.lower() in CORPUS_SUFFIXES:
                files.append(f)
    if not files:
        print("这些目录里没有任何 .txt / .md / .docx，已中止（原有知识库未改动）。")
        return 2

    # 每次从空库开始，保证结果可复现（先备份）
    db = Path(os.environ["LITEOFFICE_KB_DB"])
    if db.exists():
        # 先备份：重建是从当前语料重新算的，万一语料不全，旧库还能找回来
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = db.with_name(f"{db.stem}.bak-{stamp}{db.suffix}")
        shutil.copy2(db, backup)
        print(f"已备份旧库 → {backup.name}")
        db.unlink()
        for suffix in ("-wal", "-shm"):
            p = Path(str(db) + suffix)
            if p.exists():
                p.unlink()
    print(f"库文件：{db}（已清空重建）\n")

    total = 0
    added = 0

    for d in dirs:
        print(f"  语料目录：{d}")

    print(f"共发现 {len(files)} 份语料")
    for f in files:
        try:
            if f.suffix.lower() == ".docx":
                content = docx_to_html(f)
            else:
                content = f.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:  # noqa: BLE001 单个文件坏了不该拖垮整次重建
            print(f"  跳过（读取失败）: {f.name} — {type(e).__name__}")
            continue
        if len(content) < 200:
            print(f"  跳过（内容过短）: {f.name}")
            continue
        r = kb.add_document(KB_ID, f.name, content)
        total += 1
        if not r["deduped"]:
            added += 1
        print(f"  {len(content):6d} → {r['chunks']:2d} 块  {f.name[:44]}{'（重复跳过）' if r['deduped'] else ''}")

    stats = kb.kb_stats(KB_ID)
    print()
    print("=== 入库完成 ===")
    print(f"  文档 {stats['documents']} 份 / 块 {stats['chunks']} 个 / 约 {stats['bytes']:,} 字节")
    print(f"  实际新增 {added} / 扫描 {total}")
    if total == 0:
        print()
        print("一份都没入库：检查语料内容是否过短、格式是否支持。")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
