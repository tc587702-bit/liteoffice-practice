"""
知识库（共享）：入库、切块、术语匹配、关键词检索

设计要点：
  1. 共享库：所有人可读；写操作由上层用管理口令保护
  2. 零外部服务：SQLite 存块与元数据，向量先留 BLOB 字段（后续接嵌入）
  3. 术语表单独结构化：几百条术语用字符串匹配，比向量准且快
  4. 引用可定位：每个块带 doc_id + ord + heading_path，供前端跳回原文

本模块不依赖模型，可单独测试。
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

DB_PATH = os.getenv("LITEOFFICE_KB_DB", str(Path(__file__).resolve().parents[1] / "data" / "kb.db"))

TAG_RE = re.compile(r"<[^>]+>")
BLOCK_RE = re.compile(r"<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)</\1>", re.IGNORECASE)
ROW_RE = re.compile(r"<tr\b[^>]*>([\s\S]*?)</tr>", re.IGNORECASE)
CELL_RE = re.compile(r"<(td|th)\b[^>]*>([\s\S]*?)</\1>", re.IGNORECASE)

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS kb (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'public',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_doc (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  chunks      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  added_at    INTEGER NOT NULL,
  UNIQUE(kb_id, sha256)
);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES kb_doc(id) ON DELETE CASCADE,
  kb_id       TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  heading     TEXT NOT NULL DEFAULT '',
  vec         BLOB,
  UNIQUE(doc_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_chunk_kb ON kb_chunk(kb_id);

CREATE TABLE IF NOT EXISTS term (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL,
  term        TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE(kb_id, term)
);
CREATE INDEX IF NOT EXISTS idx_term_kb ON term(kb_id);
"""


def connect() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def now() -> int:
    return int(time.time())


def uid(prefix: str) -> str:
    return f"{prefix}_{hashlib.sha256(os.urandom(16)).hexdigest()[:16]}"


# ---------------- 切块 ----------------

@dataclass
class Chunk:
    ord: int
    text: str
    heading: str = ""

    def __repr__(self) -> str:  # 便于调试
        return f"Chunk({self.ord}, {self.text[:20]}...)"


def strip_tags(html: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", text, flags=re.IGNORECASE)
    text = TAG_RE.sub("", text)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')):
        text = text.replace(a, b)
    return re.sub(r"[ \t]+", " ", text).strip()


def chunk_text(raw: str, target: int = 400, overlap_sentences: int = 1) -> list[Chunk]:
    """把纯文本按段落聚合成 300–500 字的块，超长段落按句切分。"""
    paragraphs = [p.strip() for p in re.split(r"\n{1,}", raw) if p.strip()]
    chunks: list[Chunk] = []
    buf: list[str] = []
    size = 0

    def flush():
        nonlocal buf, size
        if buf:
            chunks.append(Chunk(len(chunks), "\n".join(buf)))
            buf = []
            size = 0

    for para in paragraphs:
        if len(para) > target * 2:
            sentences = re.split(r"(?<=[。！？.!?])", para)
            for s in sentences:
                if not s.strip():
                    continue
                if size + len(s) > target:
                    flush()
                buf.append(s.strip())
                size += len(s)
            flush()
            continue

        if size + len(para) > target:
            flush()
        buf.append(para)
        size += len(para)

    flush()

    # 相邻块加一句重叠，避免语义被切断
    if overlap_sentences and len(chunks) > 1:
        for i in range(1, len(chunks)):
            prev_tail = chunks[i - 1].text.split("。")
            tail = prev_tail[-2].strip() if len(prev_tail) > 1 else ""
            if tail and len(tail) < 80:
                chunks[i].text = tail + "。" + chunks[i].text
    return chunks


def chunk_html(html: str, target: int = 400) -> list[Chunk]:
    """按标题切分：把标题作为 heading，供引用时说明"在哪个章节"。"""
    chunks: list[Chunk] = []
    heading = ""
    lines: list[str] = []

    def flush():
        nonlocal lines
        if lines:
            for c in chunk_text("\n".join(lines), target=target, overlap_sentences=0):
                c.heading = heading
                chunks.append(c)
            lines = []

    for m in BLOCK_RE.finditer(html):
        tag = m.group(1).lower()
        inner = m.group(2)
        if tag.startswith("h"):
            flush()
            heading = strip_tags(inner)[:60]
        elif tag == "table":
            # 表格按行转文本：行内单元格去重（合并单元格会重复返回同一段文字）
            for row in ROW_RE.finditer(inner):
                cells: list[str] = []
                for cell in CELL_RE.finditer(row.group(1)):
                    text = strip_tags(cell.group(2)).strip()
                    if text and (not cells or cells[-1] != text):
                        cells.append(text)
                if cells:
                    lines.append(" | ".join(cells))
        else:
            lines.append(strip_tags(inner))
    flush()
    for i, c in enumerate(chunks):
        c.ord = i
    return chunks


# ---------------- 术语表 ----------------

@dataclass
class TermHit:
    term: str
    canonical: str
    note: str
    positions: list[int] = field(default_factory=list)


def add_terms(kb_id: str, rows: list[dict]) -> int:
    """rows: [{term, canonical, note}]"""
    conn = connect()
    added = 0
    with conn:
        for r in rows:
            term = str(r.get("term", "")).strip()
            canonical = str(r.get("canonical", "")).strip() or term
            if not term:
                continue
            cur = conn.execute(
                "INSERT OR REPLACE INTO term (id, kb_id, term, canonical, note) VALUES (?,?,?,?,?)",
                (uid("term"), kb_id, term, canonical, str(r.get("note", ""))),
            )
            added += 1 if cur.rowcount else 0
    conn.close()
    return added


def match_terms(kb_id: str, text: str) -> list[TermHit]:
    """子串匹配（长词优先），返回命中的术语与位置。"""
    conn = connect()
    rows = conn.execute("SELECT term, canonical, note FROM term WHERE kb_id = ?", (kb_id,)).fetchall()
    conn.close()
    hits: list[TermHit] = []
    for r in sorted(rows, key=lambda x: -len(x["term"])):
        term = r["term"]
        if not term:
            continue
        pos = text.find(term)
        if pos >= 0 and r["canonical"] != term:
            hits.append(TermHit(term, r["canonical"], r["note"], [pos]))
    return hits


# ---------------- 入库 ----------------

def ensure_kb(kb_id: str, name: str = "共享知识库") -> None:
    conn = connect()
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO kb (id, name, visibility, created_at) VALUES (?,?,'public',?)",
            (kb_id, name, now()),
        )
    conn.close()


def add_document(kb_id: str, name: str, content: bytes | str) -> dict:
    """
    入库一份文档。返回 {ok, docId, chunks, deduped}
    去重：同一 kb 内 sha256 相同则跳过。
    """
    ensure_kb(kb_id)
    raw = content if isinstance(content, str) else content.decode("utf-8", errors="replace")
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()

    conn = connect()
    exists = conn.execute("SELECT id FROM kb_doc WHERE kb_id = ? AND sha256 = ?", (kb_id, digest)).fetchone()
    if exists:
        conn.close()
        return {"ok": True, "docId": exists["id"], "chunks": 0, "deduped": True}

    doc_id = uid("doc")
    # 不能只看有没有 "<"：公文标题里常出现 《…<…>…》 会被误判成 HTML
    looks_html = re.search(r"<(p|h[1-6]|table|div|ul|ol|br)\b", raw[:800], re.IGNORECASE) is not None
    chunks = chunk_html(raw) if looks_html else chunk_text(raw)
    if not chunks:  # 兜底：HTML 里没切出块就按纯文本切
        chunks = chunk_text(strip_tags(raw))
    with conn:
        conn.execute(
            "INSERT INTO kb_doc (id, kb_id, name, sha256, bytes, chunks, status, added_at) VALUES (?,?,?,?,?,?,'ready',?)",
            (doc_id, kb_id, name, digest, len(raw.encode("utf-8")), len(chunks), now()),
        )
        conn.executemany(
            "INSERT INTO kb_chunk (id, doc_id, kb_id, ord, text, heading) VALUES (?,?,?,?,?,?)",
            [(uid("chk"), doc_id, kb_id, c.ord, c.text, c.heading) for c in chunks],
        )
    conn.close()
    return {"ok": True, "docId": doc_id, "chunks": len(chunks), "deduped": False}


def list_documents(kb_id: str) -> list[dict]:
    conn = connect()
    rows = conn.execute(
        "SELECT id, name, bytes, chunks, status, added_at FROM kb_doc WHERE kb_id = ? ORDER BY added_at DESC",
        (kb_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_document(doc_id: str) -> bool:
    conn = connect()
    with conn:
        conn.execute("DELETE FROM kb_chunk WHERE doc_id = ?", (doc_id,))
        cur = conn.execute("DELETE FROM kb_doc WHERE id = ?", (doc_id,))
    conn.close()
    return cur.rowcount > 0


def kb_stats(kb_id: str) -> dict:
    conn = connect()
    docs = conn.execute("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM kb_doc WHERE kb_id = ?", (kb_id,)).fetchone()
    chunks = conn.execute("SELECT COUNT(*) c FROM kb_chunk WHERE kb_id = ?", (kb_id,)).fetchone()
    terms = conn.execute("SELECT COUNT(*) c FROM term WHERE kb_id = ?", (kb_id,)).fetchone()
    conn.close()
    return {"documents": docs["c"], "bytes": docs["b"], "chunks": chunks["c"], "terms": terms["c"]}


# ---------------- 关键词检索（BM25） ----------------

def tokenize(text: str) -> list[str]:
    """中文按 2-gram，英文/数字按词；保留 1N4001、0.6 这类标识。"""
    text = text.lower()
    tokens: list[str] = []
    for m in re.finditer(r"[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fff]+", text):
        s = m.group(0)
        if re.match(r"[a-z0-9]", s):
            tokens.append(s)
        else:
            tokens.extend(s[i : i + 2] for i in range(len(s) - 1)) if len(s) > 1 else tokens.append(s)
    return tokens


class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.2, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.docs = docs
        self.N = len(docs)
        self.avgdl = (sum(len(d) for d in docs) / self.N) if self.N else 0
        self.df: dict[str, int] = {}
        for d in docs:
            for t in set(d):
                self.df[t] = self.df.get(t, 0) + 1

    def idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        return math.log(1 + (self.N - df + 0.5) / (df + 0.5))

    def score(self, idx: int, query_tokens: list[str]) -> float:
        d = self.docs[idx]
        dl = len(d)
        if not dl:
            return 0.0
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        s = 0.0
        for q in query_tokens:
            f = tf.get(q, 0)
            if not f:
                continue
            s += self.idf(q) * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
        return s


def search(kb_id: str, query: str, top_k: int = 5) -> list[dict]:
    """返回命中块 + 出处 + 分数。"""
    conn = connect()
    rows = conn.execute(
        """SELECT c.id, c.doc_id, c.ord, c.text, c.heading, d.name AS doc_name
           FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id
           WHERE c.kb_id = ?""",
        (kb_id,),
    ).fetchall()
    conn.close()
    if not rows:
        return []

    docs = [tokenize(r["text"]) for r in rows]
    bm25 = BM25(docs)
    qt = tokenize(query)
    scored = [(bm25.score(i, qt), i) for i in range(len(rows))]
    scored = [(s, i) for s, i in scored if s > 0]
    scored.sort(reverse=True)

    out = []
    for s, i in scored[:top_k]:
        r = rows[i]
        out.append(
            {
                "chunkId": r["id"],
                "docId": r["doc_id"],
                "docName": r["doc_name"],
                "ord": r["ord"],
                "heading": r["heading"],
                "text": r["text"],
                "score": round(s, 4),
            }
        )
    return out


def build_evidence(kb_id: str, selection: str, top_k: int = 3) -> dict:
    """改写用：术语 + 规范片段，一起给 prompt。"""
    terms = match_terms(kb_id, selection)
    chunks = search(kb_id, selection, top_k=top_k)
    return {
        "terms": [{"from": t.term, "to": t.canonical, "note": t.note} for t in terms],
        "chunks": chunks,
        "stats": kb_stats(kb_id),
    }
