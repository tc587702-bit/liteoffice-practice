"""Agent + 知识库联调自检（无模型、无网络）

    python -m app.test_agent_kb
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

from app import kb
from app.graph import run_agent
from app.tools import run_tool, tool_manifest

FAILED = 0
DOC = "<p>当前文档：一份关于安置房建设的汇报。</p>"


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  → {detail}" if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    print(f"语料：{kb.kb_stats('lab')['documents']} 份 / {kb.kb_stats('lab')['chunks']} 块\n")

    print("=== 1) 工具已注册 ===")
    names = [t["name"] for t in tool_manifest()]
    check("kb_search 在工具清单里", "kb_search" in names, str(len(names)) + " 个工具")
    check("清单里带描述", any(t["name"] == "kb_search" and t["description"] for t in tool_manifest()))

    print("\n=== 2) 直接调工具 ===")
    r = run_tool("kb_search", DOC, {"query": "安置房建设进度"})
    check("工具成功", r.ok is True, r.summary[:40])
    check("返回命中", len((r.data or {}).get("hits", [])) > 0, str(len((r.data or {}).get("hits", []))) + " 条")
    check("带出处", bool((r.data or {})["hits"][0]["doc"]), (r.data or {})["hits"][0]["doc"][:24])

    print("\n=== 3) 缺检索词 ===")
    r2 = run_tool("kb_search", DOC, {})
    check("拒绝并说明", r2.ok is False and "检索词" in r2.summary, r2.summary)

    print("\n=== 4) agent 自己决定查知识库 ===")
    a = run_agent(DOC, "按知识库说说安置房建设的进度")
    check("选了 kb_search", "kb_search" in a["toolsUsed"], str(a["toolsUsed"]))
    check("答案含片段而非只有摘要", "·" in a["answer"] and len(a["answer"]) > 80, a["answer"][:40])
    check("答案含文档名", "安置" in a["answer"])
    check("过程可追溯", any(s["phase"] == "act" for s in a["steps"]), str(len(a["steps"])) + " 步")

    print("\n=== 5) 无命中时如实说 ===")
    a2 = run_agent(DOC, "按知识库说说火星探测器着陆")
    check("提示无命中", "无相关命中" in a2["answer"] or "没有" in a2["answer"], a2["answer"][:40])

    print("\n=== 6) 文档工具与知识库可共存 ===")
    a3 = run_agent(
        "<h1>报告</h1><p>这是一段足够长的正文，用来参与统计与重复检查。</p>",
        "统计字数，并按知识库说说绿色工厂推荐",
    )
    check("用了两个以上工具", len(a3["toolsUsed"]) >= 2, str(a3["toolsUsed"]))
    check("含 kb_search", "kb_search" in a3["toolsUsed"])
    check("含文档工具", any(t != "kb_search" for t in a3["toolsUsed"]))


    # ---------------- T7：会话缓存上限 ----------------
    print("\n=== 会话缓存上限 ===")
    from app import main as M

    M._SESSIONS.clear()
    for i in range(M.SESSION_LIMIT + 20):
        M._session_put(f"s{i}", {"lastQuery": f"q{i}", "lastAnswerHead": "", "lastRefs": []})
    check("条目不超过上限", len(M._SESSIONS) <= M.SESSION_LIMIT, str(len(M._SESSIONS)))
    M._SESSIONS.clear()
    M._session_put("keep", {"lastQuery": "q", "lastAnswerHead": "", "lastRefs": []})
    check("写入后可读回", (M._session_get("keep") or {}).get("lastQuery") == "q")
    M._SESSIONS["keep"]["ts"] = 0  # 人为过期
    check("过期条目读不到", M._session_get("keep") is None)
    check("空 sessionId 不写", (M._session_put("", {"lastQuery": "x"}) or True) and "" not in M._SESSIONS)

    print(f"\n结果：{'全部通过' if FAILED == 0 else str(FAILED) + ' 项失败'}")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
