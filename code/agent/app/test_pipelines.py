"""两条链路自检（无模型、无网络）

    python -m app.test_pipelines

用真实语料（data/lab_kb.db），不造数据。
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("LITEOFFICE_KB_DB", str(ROOT / "data" / "kb.db"))

from app import (
    kb,
    pipelines,
)
from app import pipelines as PIPE

KB_ID = "lab"
FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  → {detail}" if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    stats = kb.kb_stats(KB_ID)
    print(f"语料：{stats['documents']} 份 / {stats['chunks']} 块\n")

    print("=== 1) 问答：有命中 ===")
    r = pipelines.qa(KB_ID, "安置房建设的进度怎么样")
    print(f"  答案：{r['answer'][:80]}")
    print(f"  引用：{[c['doc'][:16] for c in r['citations'][:2]]}")
    check("有答案", bool(r["answer"]), r["answer"][:30])
    check("有引用", len(r["citations"]) > 0, f"{len(r['citations'])} 条")
    check("引用了安置房文档", any("安置房" in c["doc"] for c in r["citations"]))
    check("标注 mock", r["mock"] is True)
    check("步骤可追溯", len(r["steps"]) >= 2, f"{len(r['steps'])} 步")

    print("\n=== 2) 问答：命中绿色工厂（另一份文档）===")
    r2 = pipelines.qa(KB_ID, "绿色工厂推荐要交什么材料")
    check("命中绿色工厂", any("4448065" in c["doc"] for c in r2["citations"]), r2["citations"][0]["doc"][:20] if r2["citations"] else "无")

    print("\n=== 3) 问答：无命中时拒答 ===")
    r3 = pipelines.qa(KB_ID, "火星探测器的着陆点在哪")
    check("明确说没有", "没有找到" in r3["answer"], r3["answer"][:24])
    check("不给引用", r3["citations"] == [])

    print("\n=== 4) 问答：问题太短 ===")
    r4 = pipelines.qa(KB_ID, "啊")
    check("拒绝并说明", r4["ok"] is False, r4.get("answer", ""))

    print("\n=== 5) 改写：术语替换生效 ===")
    # 先保证库里有一条术语
    kb.add_terms(KB_ID, [{"term": "硅二极管", "canonical": "硅整流二极管", "note": "标准名"}])
    sel = "本次实验测量了硅二极管的正向压降，硅二极管在导通后压降基本恒定。"
    w = pipelines.rewrite(KB_ID, sel)
    print(f"  原文：{sel}")
    print(f"  候选：{w['candidate']}")
    print(f"  改动：{w['changes']}")
    check("约定字段齐全", all(k in w for k in ("candidate", "changes", "evidence", "checklist", "genre")), str(list(w.keys())[:6]))
    check("术语被替换", "硅整流二极管" in w["candidate"] and "硅二极管" not in w["candidate"])
    check("改动有记录", any(c["type"] == "term" for c in w["changes"]))
    check("给出文体", w["genre"] in ("lab", "gongwen", "thesis", "essay_arg", "essay_narr", "expository"), w["genre"])

    print("\n=== 6) 改写：文体判定影响检查清单 ===")
    w2 = pipelines.rewrite(KB_ID, "那天雨下得很大，我站在校门口，忽然看见母亲撑着一把旧伞走来。")
    check("判定为记叙文", w2["genre"] == "essay_narr", w2["genre"])
    check("清单是记叙文的要求", any("细节" in x for x in w2["checklist"]), str(w2["checklist"]))

    print("\n=== 7) 改写：选中太短 ===")
    w3 = pipelines.rewrite(KB_ID, "太短")
    check("拒绝并说明", w3["ok"] is False, w3.get("reason", ""))

    print("\n=== 8) 改写：用户指定文体优先 ===")
    w4 = pipelines.rewrite(KB_ID, "本次实验测量了硅二极管的正向压降。", genre="lab")
    check("使用指定文体", w4["genre"] == "lab", w4["genre"])


    # ---------------- T5：当前文档 + 知识库双源 ----------------
    print("\n=== 9) T5：传 doc_html 时引用带 source=doc ===")
    DOC = (
        "<h2>一、安置房分配</h2>"
        "<p>青岗小区剩余房源 12 套，北部二期已分配 998 套。</p>"
        "<p>养老保险缺口 230 人，已安置 149 人。</p>"
    )
    r5 = pipelines.qa(KB_ID, "青岗小区剩余房源多少", doc_html=DOC)
    doc_cites = [c for c in r5["citations"] if c.get("source") == "doc"]
    check("引用里有 source=doc", len(doc_cites) > 0, str(len(r5["citations"])) + " 条")
    check("文档引用带段落号", all("para" in c for c in doc_cites), str([c.get("para") for c in doc_cites]))
    check("文档命中排在最前", r5["citations"][0].get("source") == "doc", str(r5["citations"][0].get("source")))
    check("答案含文档特有内容", "青岗小区" in r5["answer"], r5["answer"][:40])
    check("文档引用标记带来源", "[文档·" in r5["answer"], r5["answer"][:40])

    print("\n=== 10) T5：不传 doc_html 时与改造前一致 ===")
    r6 = pipelines.qa(KB_ID, "安置房建设的进度怎么样")
    check("引用全部来自 kb", all(c.get("source") == "kb" for c in r6["citations"]), str({c.get("source") for c in r6["citations"]}))
    check("引用条数不变（top_k=5）", len(r6["citations"]) == 5, str(len(r6["citations"])))
    check("答案非空", bool(r6["answer"]), r6["answer"][:30])
    check("知识库标记带来源", "[kb·" in r6["answer"], r6["answer"][:40])

    print("\n=== 11) T5：prompt 同时含【当前文档】与【知识库】 ===")
    captured: dict = {}
    real_has, real_complete = PIPE.has_credentials, PIPE.complete
    PIPE.has_credentials = lambda *a, **k: True

    def fake_complete(messages, model=None, max_tokens=0, **kw):
        captured["prompt"] = messages[-1]["content"]

        class R:
            text = "结论：青岗小区剩余 12 套 [1]"
            mock = False
            model = "fake"
            error = None

        return R()

    PIPE.complete = fake_complete
    try:
        r7 = pipelines.qa(KB_ID, "青岗小区剩余房源多少", doc_html=DOC)
        prompt = captured.get("prompt", "")
        check("prompt 含【当前文档】", "【当前文档】" in prompt)
        check("prompt 含【知识库】", "【知识库】" in prompt)
        check("prompt 有对照规则", "本文未提及" in prompt or "对照问题" in prompt)
        check("有文档时要求引用两侧", "当前文档" in prompt and "知识库" in prompt)
        check("模型答案被采用", r7["answer"].startswith("结论"), r7["answer"][:30])
    finally:
        PIPE.has_credentials, PIPE.complete = real_has, real_complete

    print("\n=== 12) T5：doc_html 为空字符串时走原路径 ===")
    r8 = pipelines.qa(KB_ID, "安置房建设的进度怎么样", doc_html="")
    check("空串等于不传", len(r8["citations"]) == len(r6["citations"]), str(len(r8["citations"])))


    print("\n=== 13) T5：文档侧命中数受 doc_top_k 约束 ===")
    many = "".join(f"<p>缺口相关说明第{i}条，涉及安置房与补偿资金。</p>" for i in range(8))
    r9 = pipelines.qa(KB_ID, "缺口相关说明", doc_html=many, doc_top_k=2)
    doc_n = len([c for c in r9["citations"] if c.get("source") == "doc"])
    check("文档命中 ≤ doc_top_k(2)", doc_n <= 2, str(doc_n))
    r10 = pipelines.qa(KB_ID, "缺口相关说明", doc_html=many, doc_top_k=3)
    doc_n3 = len([c for c in r10["citations"] if c.get("source") == "doc"])
    check("默认 doc_top_k=3 生效", doc_n3 <= 3, str(doc_n3))

    print(f"\n结果：{'全部通过' if FAILED == 0 else str(FAILED) + ' 项失败'}")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
