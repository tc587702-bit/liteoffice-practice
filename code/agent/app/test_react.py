"""ReAct 循环自检（无模型、无网络）

    python -m app.test_react
"""
from __future__ import annotations

import json

from app import graph as G
from app.graph import (
    MAX_REPEAT,
    MAX_STEPS,
    _build_context,
    _history_text,
    _observation_digest,
    _sanitize_params,
    node_act,
    node_think,
    run_agent,
)

DOC = (
    "<h1>实验报告</h1>"
    "<p>这是第一段落，内容足够长以便参与重复检测。</p>"
    "<h3>跳级标题</h3>"
    "<p>这是第一段落，内容足够长以便参与重复检测。</p>"
    "<table><tr><th>电压</th><th>电流</th><th>备注</th></tr>"
    "<tr><td>0.6</td><td>1.2</td></tr>"
    "<tr><td>0.7</td><td></td><td>正常</td></tr></table>"
)

FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    print("\n=== 1) 单步：只问统计 ===")
    r = run_agent(DOC, "这份文档有多少字")
    phases = [s["phase"] for s in r["steps"]]
    check("走了 think→act→think→final", phases[:2] == ["think", "act"] and "final" in phases, str(phases))
    check("只用了 get_stats", r["toolsUsed"] == ["get_stats"], str(r["toolsUsed"]))
    check("答案含字数信息", "正文" in r["answer"] or "字" in r["answer"], r["answer"][:40])

    print("\n=== 2) 多步：统计 + 表格检查 ===")
    r2 = run_agent(DOC, "帮我统计字数，并检查表格有没有问题")
    check("用了两个工具", len(r2["toolsUsed"]) >= 2, str(r2["toolsUsed"]))
    check("包含 get_stats", "get_stats" in r2["toolsUsed"])
    check("包含诊断或表格检查", any(t in r2["toolsUsed"] for t in ("diagnose_report", "check_tables")), str(r2["toolsUsed"]))
    check("答案汇总了多条结果", r2["answer"].count("·") >= 2, r2["answer"].replace("\n", " | ")[:60])
    check("步骤里能看到观察", any(s["phase"] == "act" for s in r2["steps"]))

    print("\n=== 3) 三轮：统计 + 标题 + 重复 ===")
    r3 = run_agent(DOC, "检查标题层级、重复内容，并给我字数")
    check("工具数 >= 2", len(r3["toolsUsed"]) >= 2, str(r3["toolsUsed"]))
    check("不超过步数上限", len(r3["toolsUsed"]) <= MAX_STEPS, f"{len(r3['toolsUsed'])} <= {MAX_STEPS}")

    print("\n=== 4) 没有明确意图：默认先检索 ===")
    r4 = run_agent(DOC, "这段话说了什么")
    # 语义：这类"指向某一段"的问法必须走检索（doc_search 或 search_document 都算），
    # 不能落到 doc_section（那要求用户说出章节号）
    check("默认走了检索", set(r4["toolsUsed"]) & {"search_document", "doc_search"} == set(r4["toolsUsed"]), str(r4["toolsUsed"]))
    check("仍然给出答案", bool(r4["answer"]), r4["answer"][:40])

    print("\n=== 5) 工具不重复调用 ===")
    r5 = run_agent(DOC, "检查表格问题，顺便看看表格列数对不对")
    check("check_tables 只出现一次", r5["toolsUsed"].count("check_tables") <= 1, str(r5["toolsUsed"]))


    # ---------------- T1：Observation 关键内容进 prompt ----------------
    print("\n=== 6) T1：history 带内容摘要，且有长度上限 ===")
    fake_obs = [
        {
            "tool": "doc_search",
            "ok": True,
            "summary": "「缺口」在文档内命中 2 处",
            "data": {"hits": [{"block": 3, "snippet": "征地补偿资金缺口 2455 万元", "hits": ["缺口"]}]},
            "params": {"query": "缺口"},
        },
        {
            "tool": "doc_brief",
            "ok": True,
            "summary": "共 5 个章节",
            "data": {"brief": "共 5 个章节，第一部分是基本情况"},
            "params": {},
        },
    ]
    hist = _history_text(fake_obs)
    check("history 含检索片段原文", "征地补偿资金缺口" in hist, hist[:60].replace("\n", " | "))
    check("history 含参数", "query=缺口" in hist)
    big = [
        {"tool": "doc_search", "ok": True, "summary": "", "data": {"hits": [{"block": i, "snippet": "长" * 200}]}}
        for i in range(10)
    ]
    check("history 总长 ≤3000", len(_history_text(big)) <= 3000, str(len(_history_text(big))))
    check("digest 单条 ≤600", len(_observation_digest(big[0])) <= 600, str(len(_observation_digest(big[0]))))

    # ---------------- T2：action_input 打通 ----------------
    print("\n=== 7) T2：action_input 优先，正则兜底，非法键丢弃 ===")
    ok_params = _sanitize_params("doc_section", {"key": "3"})
    check("合法参数通过", ok_params == {"key": "3"}, str(ok_params))
    dirty = _sanitize_params("doc_section", {"key": "3", "evil": "rm -rf", "flag": True, "n": 2})
    check("非法键被丢弃", dirty == {"key": "3"}, str(dirty))
    check("白名单外工具不接受参数", _sanitize_params("get_stats", {"query": "x"}) == {})

    captured: dict = {}
    real_run_tool = G.run_tool

    def fake_run_tool(name, html, params=None):
        captured["name"] = name
        captured["params"] = dict(params or {})
        return real_run_tool(name, html, params)

    G.run_tool = fake_run_tool
    try:
        st = {"html": DOC, "query": "随便看看", "pending": ["doc_section"], "used": [], "steps": [], "action_params": {"key": "3"}}
        node_act(st)
        check("模型给的 key 被采用", captured["params"].get("key") == "3", str(captured["params"]))
        # 正则兜底：action_params 为空时从原句抠出 key=3
        st2 = {"html": DOC, "query": "读一下第三部分", "pending": ["doc_section"], "used": [], "steps": [], "action_params": {}}
        node_act(st2)
        check("缺失时正则兜底生效", captured["params"].get("key") == "3", str(captured["params"]))
    finally:
        G.run_tool = real_run_tool
    check("act 后清空 action_params", node_act({"html": DOC, "query": "x", "pending": ["get_stats"], "used": [], "steps": [], "action_params": {"key": "9"}}).get("action_params") == {})

    # ---------------- T3：检索类可换词重查 ----------------
    print("\n=== 8) T3：检索类换词重查，其它工具不可重复 ===")
    real_complete = G.complete
    real_has = G.has_credentials
    G.has_credentials = lambda *a, **k: True

    def fake_complete(messages, model=None, max_tokens=0, **kw):
        class R:
            text = json.dumps({"thought": "查一下", "action": "doc_search", "action_input": {"query": "缺口"}})
            mock = False
            model = "fake"

        return R()

    G.complete = fake_complete
    try:
        # 第 1 次：未执行过 → 允许
        s1 = node_think({"html": DOC, "query": "查缺口", "used": [], "observations": [], "steps": []})
        check("第 1 次检索被接受", s1.get("pending") == ["doc_search"], str(s1.get("steps")))
        # 第 2 次：已执行 1 次，不同 query → 允许
        s2 = node_think(
            {
                "html": DOC,
                "query": "换个词查",
                "used": ["doc_search"],
                "observations": [{"tool": "doc_search", "ok": True, "summary": "", "params": {"query": "旧词"}}],
                "steps": [],
            }
        )
        check("不同 query 第 2 次被接受", s2.get("pending") == ["doc_search"], str(s2.get("steps")))
        # 第 3 次：count 已达上限 → 拒绝
        s3 = node_think(
            {
                "html": DOC,
                "query": "再查",
                "used": ["doc_search", "doc_search"],
                "observations": [
                    {"tool": "doc_search", "ok": True, "summary": "", "params": {"query": "a"}},
                    {"tool": "doc_search", "ok": True, "summary": "", "params": {"query": "b"}},
                ],
                "steps": [],
            }
        )
        check("第 3 次被拒绝", s3.get("pending") is None, str(s3.get("steps"))[-80:])
        # 相同 query → 拒绝
        s4 = node_think(
            {
                "html": DOC,
                "query": "查缺口",
                "used": ["doc_search"],
                "observations": [{"tool": "doc_search", "ok": True, "summary": "", "params": {"query": "缺口"}}],
                "steps": [],
            }
        )
        check("相同 query 被拒绝", s4.get("pending") is None, str(s4.get("steps"))[-80:])
        # 非检索工具重复 → 拒绝（让假模型返回 diagnose_report）
        def fake_diagnose(messages, model=None, max_tokens=0, **kw):
            class R2:
                text = json.dumps({"thought": "再检查", "action": "diagnose_report", "action_input": {}})
                mock = False
                model = "fake"

            return R2()

        G.complete = fake_diagnose
        s5 = node_think(
            {
                "html": DOC,
                "query": "再检查",
                "used": ["diagnose_report"],
                "observations": [{"tool": "diagnose_report", "ok": True, "summary": "", "params": {}}],
                "steps": [],
            }
        )
        check("非检索工具不重复", s5.get("pending") is None, str(s5.get("steps"))[-80:])
    finally:
        G.complete = real_complete
        G.has_credentials = real_has
    check("MAX_REPEAT 常量为 2", MAX_REPEAT == 2)

    # ---------------- T4：docmap 组装上下文 ----------------
    print("\n=== 9) T4：final 上下文按需组装，不再盲截开头 ===")
    filler = "".join(f"<p>前置说明第{i}段，这里没有任何关键数据。</p>" for i in range(40))
    long_doc = (
        filler
        + "<h2>五、下一步措施</h2>"
        + "<p>下一步要抓紧推进安置房分配，2025 年完成 81 人安置，资金来源为财政预算。</p>"
    )
    ctx = _build_context(long_doc, "第五部分讲了什么", [])
    check("上下文包含第 5 节内容", "81 人安置" in ctx, ctx[:60].replace("\n", " | "))
    check("上下文长度 ≤4000", len(ctx) <= 4000, str(len(ctx)))
    check("片段带位置标记", "【第" in ctx, ctx[:40])
    check("开头兜底不再占满预算", len(ctx) < 4000)


    # ---------------- T7：答案带位置 + 跨轮记忆 ----------------
    print("\n=== 10) T7：refs 带段落号 ===")
    doc_r = (
        "<h2>一、基本情况</h2><p>累计拆迁 123.70 万平方米，涉及 20609 人。</p>"
        "<h2>二、存在问题</h2><p>安置房缺口 17.55 万平方米，涉及 2918 人、972 户。</p>"
        "<h2>三、养老保险</h2><p>缺口 230 人，已安置 149 人，剩余 81 人。</p>"
    )
    rr = run_agent(doc_r, "文档里缺口有哪些")
    check("返回值含 refs", "refs" in rr, str(list(rr.keys())[-4:]))
    check("refs 的 para 是非负整数", all(isinstance(x["para"], int) and x["para"] >= 0 for x in rr["refs"]), str(rr["refs"][:2]))
    check("refs 带来源工具", all(x.get("from") for x in rr["refs"]), str([x.get("from") for x in rr["refs"][:2]]))

    print("\n=== 11) T7：第二轮指代消解 ===")
    prev = {"lastQuery": "养老保险剩余多少人", "lastAnswerHead": "", "lastRefs": []}
    merged = G.resolve_reference("那第三部分呢", prev)
    check("短句 + 指代词 → 拼接上一轮实词", "养老保险" in merged, merged)
    check("保留原问题", merged.startswith("那第三部分呢"), merged)
    check("prev 为 None 时原样返回", G.resolve_reference("那第三部分呢", None) == "那第三部分呢")
    check("长句不拼接", G.resolve_reference("请详细说明一下第三部分关于养老保险的剩余人数情况", prev) == "请详细说明一下第三部分关于养老保险的剩余人数情况")
    rr2 = run_agent(doc_r, "那第三部分呢", prev=prev)
    check("run_agent 用上了 prev", "养老保险" in rr2["queryUsed"], rr2["queryUsed"])

    print("\n=== 12) T7：prev 缺失时与改造前一致 ===")
    rr3 = run_agent(doc_r, "文档里缺口有哪些")
    rr4 = run_agent(doc_r, "文档里缺口有哪些", prev=None)
    check("两次结果工具一致", rr3["toolsUsed"] == rr4["toolsUsed"], str(rr3["toolsUsed"]))
    check("queryUsed 未被改写", rr4["queryUsed"] == "文档里缺口有哪些", rr4["queryUsed"])

    total_acts = sum(1 for r in (r, r2, r3, r4, r5) for s in r["steps"] if s["phase"] == "act")
    print(f"\n五次请求共执行 {total_acts} 个动作")
    print(f"结果：{'全部通过' if FAILED == 0 else str(FAILED) + ' 项失败'}")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
