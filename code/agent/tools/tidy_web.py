"""整理抓取结果：去重 + 文体抽检

    python tools/tidy_web.py data/web/gongwen
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.classify_genre import classify


def norm(text: str) -> str:
    return re.sub(r"[\s\u3000]+", "", text)


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python tools/tidy_web.py <目录>")
        return 2
    d = Path(sys.argv[1])
    files = sorted(d.glob("*.txt"))
    print(f"原始文件：{len(files)} 份")

    seen: dict[str, Path] = {}
    removed = 0
    for f in files:
        h = hashlib.sha256(norm(f.read_text(encoding="utf-8")).encode()).hexdigest()[:16]
        if h in seen:
            f.unlink()
            meta = f.with_suffix(".meta.json")
            if meta.exists():
                meta.unlink()
            removed += 1
            print(f"  去重删除：{f.name}（与 {seen[h].name} 相同）")
        else:
            seen[h] = f

    kept = sorted(d.glob("*.txt"))
    total = sum(len(f.read_text(encoding="utf-8")) for f in kept)
    print(f"\n去重后：{len(kept)} 份 / {total:,} 字（删除 {removed} 份重复）")

    print("\n=== 文体抽检（全部应为公文）===")
    ok = 0
    for f in kept:
        text = f.read_text(encoding="utf-8")
        r = classify(text)
        mark = "OK" if r["genre"] == "gongwen" else "!!"
        if r["genre"] == "gongwen":
            ok += 1
        title = ""
        meta = f.with_suffix(".meta.json")
        if meta.exists():
            title = json.loads(meta.read_text(encoding="utf-8")).get("title", "")
        print(f"  {mark} {len(text):5d} 字  公文置信={r['confidence']:.2f}  {title[:40]}")
    print(f"\n判为公文：{ok}/{len(kept)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
