"""
多文体语料抓取：把公开网页按文体分类抓取并入库。

与现有 scrape.py 的区别：
  · 没有公文特征分门槛（原版只认公文，其他文体会被跳过）
  · 接受 --genre 参数，抓完直接入对应文体的库（multigenre.ingest）
  · 保留 scrape.py 的礼貌规范：robots.txt、限速、UA、meta.json

用法：
    # 实验报告
    python tools/scrape_multigenre.py --genre lab --out data/web/lab \
        https://www.ilab-x.com/details/page?id=2631 \
        https://www.ilab-x.com/details/page?id=3070

    # 说明文
    python tools/scrape_multigenre.py --genre expository --out data/web/expository \
        https://www.kepuchina.cn/article/articleinfo?ar_id=756961&business_type=100

    # 批量（从文件读 URL，每行一个）
    python tools/scrape_multigenre.py --genre essay_arg --out data/web/essay_arg \
        --from-file urls_essay_arg.txt
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

LAB_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_ROOT))

from app import multigenre as MG

UA = "LiteOffice-CourseBot/0.2 (course project; multi-genre corpus; contact: local)"
TIMEOUT = 20
DELAY = 1.5  # 比原版稍慢，尊重教育站点

# 通用正文容器选择器（覆盖政府、教育、科普、文学站点）
CONTENT_SELECTORS = [
    "div.article", "div.article-content", "div.TRS_Editor", "div.pages_content",
    "div#UCAP-CONTENT", "div.b12c", "div#zoom", "div.zw", "div#content",
    "div.content", "div.main-content", "div.view", "div.detail", "div.text",
    "article", "div.post-body", "div.entry-content", "div.rich_media_content",
    "div.cont_txt", "div.art_content", "div.news_content", "div.reading-content",
    "div.chapter-content", "div.book-content",
]

NOISE_TAGS = ["script", "style", "nav", "header", "footer", "iframe", "form",
              "noscript", "aside", "ins", "svg"]


def robots_ok(base: str, path: str) -> bool:
    try:
        rp = RobotFileParser()
        rp.set_url(f"{base}/robots.txt")
        rp.read()
        return rp.can_fetch(UA, base + path)
    except Exception:  # noqa: BLE001
        return True


def extract_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(NOISE_TAGS):
        tag.decompose()

    title = (soup.title.get_text(strip=True) if soup.title else "").strip()

    node = None
    for sel in CONTENT_SELECTORS:
        cand = soup.select_one(sel)
        if cand and len(cand.get_text(strip=True)) > 100:
            node = cand
            break
    if node is None:
        best, best_len = None, 0
        for cand in soup.find_all(["div", "td", "article", "section"]):
            ln = len(cand.get_text(" ", strip=True))
            if ln > best_len:
                best, best_len = cand, ln
        node = best or soup.body or soup

    paras = []
    for p in node.find_all(["p", "div", "li", "h1", "h2", "h3", "h4"]):
        t = p.get_text(" ", strip=True)
        if len(t) >= 8 and not re.fullmatch(r"[\W\d_]+", t) and t not in paras:
            paras.append(t)

    text = "\n".join(paras)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text


def slugify(url: str, index: int) -> str:
    p = urlparse(url)
    tail = re.sub(r"[^a-zA-Z0-9]+", "-", p.path.strip("/"))[-40:].strip("-")
    # 保留查询参数里的关键 id（ilab-x 的 ?id=、kepuchina 的 ?ar_id=）
    qs = dict(re.findall(r"([a-z_]+)=(\d+)", p.query.lower()))
    qid = qs.get("id") or qs.get("ar_id") or ""
    suffix = f"-{qid}" if qid else ""
    return f"{index:02d}-{tail or p.netloc}{suffix}"


def main() -> int:
    ap = argparse.ArgumentParser(description="多文体语料抓取")
    ap.add_argument("urls", nargs="*", help="要抓取的 URL")
    ap.add_argument("--genre", required=True, choices=list(MG.GENRE_KB.keys()),
                    help="文体类别")
    ap.add_argument("--out", default=None, help="输出目录（默认 data/web/<genre>）")
    ap.add_argument("--delay", type=float, default=DELAY)
    ap.add_argument("--from-file", default=None, help="从文件读取 URL（每行一个）")
    ap.add_argument("--min-chars", type=int, default=200, help="正文最短字数")
    args = ap.parse_args()

    urls = list(args.urls or [])
    if args.from_file:
        fp = Path(args.from_file)
        if fp.exists():
            urls.extend(line.strip() for line in fp.read_text(encoding="utf-8").splitlines()
                        if line.strip() and not line.strip().startswith("#"))

    if not urls:
        print("没有 URL。用位置参数或 --from-file 提供。")
        return 1

    outdir = Path(args.out) if args.out else (LAB_ROOT / "data" / "web" / args.genre)
    outdir.mkdir(parents=True, exist_ok=True)

    print(f"文体：{MG.GENRE_LABEL.get(args.genre, args.genre)} ({args.genre})")
    print(f"输出：{outdir}")
    print(f"共 {len(urls)} 个 URL\n")

    ok = 0
    for i, url in enumerate(urls, 1):
        p = urlparse(url)
        if not p.scheme.startswith("http"):
            print(f"  [{i}] 跳过（非 http）: {url}")
            continue
        if not robots_ok(f"{p.scheme}://{p.netloc}", p.path):
            print(f"  [{i}] 跳过（robots.txt 禁止）: {url}")
            continue

        try:
            resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": UA})
        except Exception as e:  # noqa: BLE001
            print(f"  [{i}] 失败（{type(e).__name__}）: {url}")
            continue

        if resp.status_code != 200:
            print(f"  [{i}] 失败（HTTP {resp.status_code}）: {url}")
            continue

        resp.encoding = resp.apparent_encoding or resp.encoding
        title, body = extract_text(resp.text)
        text = (title + "\n" + body) if title else body
        if len(text) < args.min_chars:
            print(f"  [{i}] 跳过（正文过短 {len(text)} 字）: {url}")
            continue

        slug = slugify(url, i)
        txt_path = outdir / f"{slug}.txt"
        meta_path = outdir / f"{slug}.meta.json"

        txt_path.write_text(text, encoding="utf-8")
        meta = {
            "url": url,
            "title": title,
            "chars": len(text),
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "genre": args.genre,
            "license_note": "公开网页；仅用于课程项目内部实验，引用请注明来源",
        }
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

        # 入库
        r = MG.ingest(f"{slug}.txt", text, genre=args.genre)
        status = "✓" if r.get("ok") else "✗"
        dedup = "（重复跳过）" if r.get("deduped") else ""
        chunks = r.get("chunks", 0)
        reason = r.get("reason", "")
        extra = f"  ← {reason}" if not r.get("ok") else ""
        print(f"  [{i}] {status} {len(text):5d} 字 → {chunks:2d} 块  {slug}{dedup}{extra}")
        if r.get("ok"):
            ok += 1

        time.sleep(args.delay)

    print(f"\n完成：成功 {ok} / 共 {len(urls)}")
    print(f"输出目录：{outdir}")

    # 打印该文体库的最新规模
    kb_id = MG.GENRE_KB[args.genre]
    from app import kb
    s = kb.kb_stats(kb_id)
    print(f"库 [{kb_id}] 当前：文档 {s['documents']} / 块 {s['chunks']} / 术语 {s['terms']}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
