"""
知识库自检（不依赖模型、不需要网络）

    python -m app.test_kb
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

os.environ["LITEOFFICE_KB_DB"] = str(Path(tempfile.mkdtemp(prefix="lo-kb-")) / "kb.db")

from app import kb  # noqa: E402

FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
    if not ok:
        FAILED += 1


SPEC = """
<h1>实验报告写作规范</h1>
<h2>第 3 节 数据记录</h2>
<p>测量结果应给出不确定度，有效数字应与仪器精度一致。电压单位 V，电流单位 mA，数值与单位之间留一个空格。</p>
<p>同一物理量多次测量时，应给出平均值与标准偏差，不得只写一个结果。</p>
<h2>第 4 节 结论</h2>
<p>结论部分应说明误差来源与改进建议，不得只写"符合预期"。若偏差超过 5%，须分析原因。</p>
"""

EXAMPLE = """
<h1>往届优秀范文 · 结论段</h1>
<p>由表 1 可见，正向压降随电流增大而缓慢上升，0.6 V 时约 1.2 mA，与理论值偏差 4%，主要来自接触电阻与温度漂移。</p>
"""

DRAFT = '实验一测了硅二极管的伏安特性，0.6V 的时候电流是1.2mA，基本符合预期。'


def main() -> int:
    KB = "kb_shared"

    print("\n=== 1) 入库 ===")
    r1 = kb.add_document(KB, "实验报告写作规范.md", SPEC)
    check("规范入库", r1["ok"] and r1["chunks"] >= 2, f"块数={r1['chunks']}")
    r2 = kb.add_document(KB, "往届范文.md", EXAMPLE)
    check("范文入库", r2["ok"] and r2["chunks"] >= 1, f"块数={r2['chunks']}")

    print("\n=== 2) 去重 ===")
    r3 = kb.add_document(KB, "重复上传.md", SPEC)
    check("同内容不重复入库", r3["deduped"] is True, f"docId={r3['docId'][:12]}…")

    print("\n=== 3) 术语表 ===")
    added = kb.add_terms(KB, [
        {"term": "硅二极管", "canonical": "硅整流二极管", "note": "标准术语"},
        {"term": "测了", "canonical": "测量", "note": "书面语"},
    ])
    check("术语入库", added == 2, f"新增={added}")
    hits = kb.match_terms(KB, DRAFT)
    check("匹配到 2 条术语", len(hits) == 2, str([(h.term, h.canonical) for h in hits]))
    check("长词优先（硅二极管而非二极管）", any(h.term == "硅二极管" for h in hits))

    print("\n=== 4) 关键词检索 ===")
    res = kb.search(KB, "测量结果的不确定度怎么给", top_k=3)
    check("检索有结果", len(res) > 0, f"命中={len(res)}")
    check("命中的是规范而不是范文", res and "规范" in res[0]["docName"], res[0]["docName"] if res else "-")
    check("带出处（文档名 + 块序号 + 章节）",
          res and res[0]["docName"] and res[0]["ord"] >= 0 and res[0]["heading"] != "",
          f"{res[0]['docName']} / ord={res[0]['ord']} / {res[0]['heading']}" if res else "-")
    check("分数降序", all(res[i]["score"] >= res[i + 1]["score"] for i in range(len(res) - 1)))

    res2 = kb.search(KB, "结论要写什么", top_k=3)
    check("第二个问题也能命中", len(res2) > 0 and "结论" in (res2[0]["text"] + res2[0]["heading"]), res2[0]["heading"] if res2 else "-")

    print("\n=== 5) 改写用材料包 ===")
    ev = kb.build_evidence(KB, DRAFT, top_k=2)
    check("含术语替换项", len(ev["terms"]) == 2, str(ev["terms"]))
    check("含规范片段", len(ev["chunks"]) >= 1, f"{len(ev['chunks'])} 段")
    check("含统计信息", ev["stats"]["documents"] == 2, str(ev["stats"]))

    print("\n=== 6) 删除与统计 ===")
    docs = kb.list_documents(KB)
    check("文档列表有 2 份", len(docs) == 2, f"{len(docs)} 份")
    ok = kb.delete_document(docs[0]["id"])
    check("删除成功", ok)
    left = kb.list_documents(KB)
    check("删除后剩 1 份", len(left) == 1, f"{len(left)} 份")
    check("块也级联删除", kb.kb_stats(KB)["chunks"] < 5, str(kb.kb_stats(KB)))

    print("\n=== 7) 空库与无命中 ===")
    check("空库检索返回空", kb.search("kb_none", "任意问题") == [])
    check("无命中返回空", kb.search(KB, "量子纠缠拓扑绝缘体") == [])

    print(f"\n结果：{'全部通过' if FAILED == 0 else str(FAILED) + ' 项失败'}")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
