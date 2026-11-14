"""
反馈记忆：记住用户「这条不用改」，下次不再报同一处。

设计取舍：
  · 独立 sqlite 文件（data/feedback.db），不动 kb.db
  · 主键式去重：同 (文档指纹, 规则, 片段) 只留一条最新记录
  · 两种粒度：
      instance 级 —— 这一处不报（片段完全一致才命中）
      rule 级     —— 这条规则在这份文档里不报（同规则 + 同文体）
  · 只存片段（≤40 字）与规则名，不存全文，避免隐私问题

对外：
    record(fingerprint, rule, snippet, action, genre=None)
    dismissed_keys()            -> {(rule, snippet_norm), ...}
    rule_dismiss_rate(rule, genre) -> (dismiss_count, total_count)
    stats()                     -> 汇总
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "feedback.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS issue_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,       -- 文档指纹（正文 md5 前 12 位）
    rule        TEXT NOT NULL,       -- 规则名（如「词语重复」「缺少「措施」部分」）
    snippet     TEXT NOT NULL,       -- 片段（归一化后 ≤40 字）
    action      TEXT NOT NULL,       -- dismiss / accept
    genre       TEXT,                -- 文体（可选，用于规则级降级）
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_lookup ON issue_feedback(rule, snippet);
CREATE INDEX IF NOT EXISTS idx_fb_doc ON issue_feedback(fingerprint);
"""


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _norm(text: str) -> str:
    """片段归一化：去空白与标点，只留字与数字，便于跨文档比对"""
    return re.sub(r"[\s，。；：、！？（）()\"'“”‘’]", "", text or "")[:40]


def fingerprint(html_or_text: str) -> str:
    return hashlib.md5((html_or_text or "").encode("utf-8")).hexdigest()[:12]


def record(
    fingerprint_value: str,
    rule: str,
    snippet: str,
    action: str = "dismiss",
    genre: str | None = None,
) -> dict[str, Any]:
    """记一条反馈；同 (指纹, 规则, 片段) 覆盖旧记录"""
    fp = fingerprint_value or "unknown"
    rl = (rule or "").strip()[:60]
    sn = _norm(snippet)
    if action not in ("dismiss", "accept") or not rl:
        return {"ok": False, "reason": "参数不合法"}

    conn = _conn()
    try:
        conn.execute(
            "DELETE FROM issue_feedback WHERE fingerprint=? AND rule=? AND snippet=?",
            (fp, rl, sn),
        )
        conn.execute(
            "INSERT INTO issue_feedback(fingerprint, rule, snippet, action, genre, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (fp, rl, sn, action, genre or "", time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "fingerprint": fp, "rule": rl, "snippet": sn, "action": action}


def dismissed_keys() -> set[tuple[str, str]]:
    """所有被标记为「不用改」的 (规则, 片段)"""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT rule, snippet FROM issue_feedback WHERE action='dismiss'"
        ).fetchall()
    finally:
        conn.close()
    return {(r["rule"], r["snippet"]) for r in rows}


def rule_dismiss_rate(rule: str, genre: str | None = None) -> tuple[int, int]:
    """某规则的 (dismiss 次数, 总反馈次数)——用于自动降级"""
    conn = _conn()
    try:
        if genre:
            rows = conn.execute(
                "SELECT action, COUNT(*) AS n FROM issue_feedback WHERE rule=? AND (genre=? OR genre='') GROUP BY action",
                (rule, genre),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT action, COUNT(*) AS n FROM issue_feedback WHERE rule=? GROUP BY action",
                (rule,),
            ).fetchall()
    finally:
        conn.close()
    counts = {r["action"]: r["n"] for r in rows}
    dismiss = counts.get("dismiss", 0)
    total = dismiss + counts.get("accept", 0)
    return dismiss, total


def stats() -> dict[str, Any]:
    conn = _conn()
    try:
        total = conn.execute("SELECT COUNT(*) AS n FROM issue_feedback").fetchone()["n"]
        by_action = {
            r["action"]: r["n"]
            for r in conn.execute("SELECT action, COUNT(*) AS n FROM issue_feedback GROUP BY action")
        }
        top_rules = [
            {"rule": r["rule"], "dismissed": r["n"]}
            for r in conn.execute(
                "SELECT rule, COUNT(*) AS n FROM issue_feedback WHERE action='dismiss'"
                " GROUP BY rule ORDER BY n DESC LIMIT 5"
            )
        ]
    finally:
        conn.close()
    return {"total": total, "byAction": by_action, "topDismissed": top_rules, "db": str(DB_PATH)}


def is_dismissed(rule: str, snippet: str) -> bool:
    """某条建议是否被用户否过（片段归一化后比对）"""
    sn = _norm(snippet)
    if not sn:
        return False
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT 1 FROM issue_feedback WHERE action='dismiss' AND rule=? AND snippet=? LIMIT 1",
            ((rule or "").strip()[:60], sn),
        ).fetchone()
    finally:
        conn.close()
    return row is not None
