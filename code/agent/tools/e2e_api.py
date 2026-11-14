"""端到端调接口：/v1/kb/{kb}/qa、/v1/kb/{kb}/rewrite、/v1/agent/run

    python tools/e2e_api.py [base]
"""
from __future__ import annotations

import sys

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8101"


def post(path: str, payload: dict) -> dict:
    r = requests.post(f"{BASE}{path}", json=payload, timeout=60)
    r.raise_for_status()
    return r.json()


print("==", BASE, "==")

print("\n[1] 问答：安置房进度")
qa = post("/v1/kb/lab/qa", {"question": "安置房建设的进度怎么样"})
print("  答案:", qa["answer"][:90].replace("\n", " "))
print("  引用:", [(c["doc"][:18], c["ord"]) for c in qa["citations"][:3]])
print("  mock:", qa["mock"], " 步骤:", len(qa["steps"]))

print("\n[2] 问答：无命中")
qa2 = post("/v1/kb/lab/qa", {"question": "火星探测器着陆点在哪"})
print("  答案:", qa2["answer"][:60], " 引用数:", len(qa2["citations"]))

print("\n[3] 改写：术语 + 文体 + 依据")
sel = "本次实验测量了硅二极管的正向压降，硅二极管导通后压降基本恒定，测得0.7V时电流8.5mA。"
rw = post("/v1/kb/lab/rewrite", {"selection": sel})
print("  文体:", rw["genreLabel"], f"({rw['genreConfidence']})")
print("  候选:", rw["candidate"][:80])
print("  改动:", rw["changes"])
print("  清单:", rw["checklist"])
print("  依据: 术语", len(rw["evidence"]["terms"]), "条 / 片段", len(rw["evidence"]["chunks"]), "块")
print("  mock:", rw["mock"])

print("\n[4] 改写：指定文体（记叙文）")
rw2 = post("/v1/kb/lab/rewrite", {"selection": "那天雨下得很大，我站在校门口，忽然看见母亲撑着一把旧伞走来。", "genre": "essay_narr"})
print("  文体:", rw2["genreLabel"], " 清单:", rw2["checklist"])

print("\n[5] agent：自己决定查知识库")
ag = post("/v1/agent/run", {"html": "<p>当前文档：安置房汇报。</p>", "query": "按知识库说说安置房建设进度"})
print("  工具:", ag["toolsUsed"])
print("  答案:", ag["answer"][:120].replace("\n", " | "))
print("  步骤:", [f"{s['phase']}:{s['detail'][:24]}" for s in ag["steps"]])

print("\n[6] 工具清单")
tools = requests.get(f"{BASE}/v1/tools", timeout=20).json()
print("  ", [t["name"] for t in tools.get("tools", tools if isinstance(tools, list) else [])])
