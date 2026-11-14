"""
网页抓取（按礼貌方式）：只抓公开页面，限速、查 robots.txt、保存来源与时间。

    python tools/scrape.py --genre gongwen --out data/web https://... https://...

设计约束（重要）：
  1. 先查 robots.txt，被禁止的路径直接跳过
  2. 每秒最多 1 个请求，带 UA 标明用途
  3. 每篇保存 meta.json：url / 标题 / 抓取时间 / 字数 / 许可提示
  4. 只做正文提取，不跟随附件下载（pdf/doc 附件不抓）
  5. 不用于对外分发；入库时须保留来源
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

UA = "LiteOffice-CourseBot/0.1 (course project; contact: local)"
TIMEOUT = 15
DELAY = 1.0

# 常见的正文容器选择器（政府网站多为此类）
CONTENT_SELECTORS = [
    "div.article", "div.article-content", "div.TRS_Editor", "div.pages_content",
    "div#UCAP-CONTENT", "div.b12c", "div#zoom", "div.zw", "div#content",
    "div.content", "div.main-content", "div.view", "div.detail", "div.text", "article",
]

NOISE_TAGS = ["script", "style", "nav", "header", "footer", "iframe", "form", "noscript", "aside"]


def robots_ok(base: str, path: str) -> bool:
    try:
        rp = RobotFileParser()
        rp.set_url(f"{base}/robots.txt")
        rp.read()
        return rp.can_fetch(UA, base + path)
    except Exception:  # noqa: BLE001 边界兜底，异常转为可读提示
        # 没有 robots.txt 或读取失败时按允许处理，但只抓公开页
        return True


def extract_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(NOISE_TAGS):
        tag.decompose()

    title = (soup.title.get_text(strip=True) if soup.title else "").strip()

    node = None
    for sel in CONTENT_SELECTORS:
        cand = soup.select_one(sel)
        if cand and len(cand.get_text(strip=True)) > 200:
            node = cand
            break
    if node is None:
        # 兜底：整块文本最长的 div/td（地方政务网站常把正文塞在 td 里）
        best, best_len = None, 0
        for cand in soup.find_all(["div", "td", "article"]):
            ln = len(cand.get_text(" ", strip=True))
            if ln > best_len:
                best, best_len = cand, ln
        node = best or soup.body or soup

    # 按段落抽，保留换行；过滤过短行（导航、按钮）
    paras = []
    for p in node.find_all(["p", "div", "li", "h1", "h2", "h3"]):
        t = p.get_text(" ", strip=True)
        # 去重：div 套 p 会重复出现同一段
        if len(t) >= 12 and not re.fullmatch(r"[\W\d_]+", t) and t not in paras:
            paras.append(t)

    text = "\n".join(paras)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text


def slugify(url: str, index: int) -> str:
    p = urlparse(url)
    tail = re.sub(r"[^a-zA-Z0-9]+", "-", p.path.strip("/"))[-40:].strip("-")
    return f"{index:02d}-{tail or p.netloc}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--genre", default="web")
    ap.add_argument("--out", default="data/web")
    ap.add_argument("--delay", type=float, default=DELAY)
    args = ap.parse_args()

    outdir = Path(args.out) / args.genre
    outdir.mkdir(parents=True, exist_ok=True)

    ok = 0
    for i, url in enumerate(args.urls, 1):
        p = urlparse(url)
        if not p.scheme.startswith("http"):
            print(f"  跳过（非 http）: {url}")
            continue
        if not robots_ok(f"{p.scheme}://{p.netloc}", p.path):
            print(f"  跳过（robots.txt 禁止）: {url}")
            continue

        try:
            resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": UA})
        except Exception as e:  # noqa: BLE001 边界兜底，异常转为可读提示
            print(f"  失败（{type(e).__name__}）: {url}")
            continue

        if resp.status_code != 200:
            print(f"  失败（HTTP {resp.status_code}）: {url}")
            continue

        resp.encoding = resp.apparent_encoding or resp.encoding
        title, body = extract_text(resp.text)
        # 标题并入正文：公文标题本身是强特征（"关于…的通知"），且对检索有用
        text = (title + "\n" + body) if title else body
        if len(text) < 600:
            print(f"  跳过（正文过短 {len(text)} 字）: {url}")
            continue
        # 质量门槛：公文应含标题句式或层级编号或机关名
        marks = 0
        if re.search(r"关于[\s\S]{2,60}?的(实施)?(通知|方案|报告|请示|意见|办法|细则|规定|批复|纪要)", text):
            marks += 2
        if re.search(r"(?m)^[\s\u3000]*[一二三四五六七八九十]、", text):
            marks += 1
        if re.search(r"(区|县|市|局|委|办|政府|领导小组|办公室)", text):
            marks += 1
        if marks < 2:
            print(f"  跳过（不像公文，特征分 {marks}）: {url}")
            continue

        slug = slugify(url, i)
        (outdir / f"{slug}.txt").write_text(text, encoding="utf-8")
        meta = {
            "url": url,
            "title": title,
            "chars": len(text),
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "genre": args.genre,
            "license_note": "公开政府网页；仅用于课程项目内部实验，引用请注明来源",
        }
        (outdir / f"{slug}.meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  OK  {len(text):5d} 字  {slug}  ← {title[:40]}")
        ok += 1
        time.sleep(args.delay)

    print(f"\n完成：成功 {ok} / 共 {len(args.urls)}")
    print(f"输出目录：{outdir}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
