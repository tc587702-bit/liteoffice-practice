"""真模型验证：/qa、/rewrite、/agent 三条链路各调一次，带耗时

    python tools/e2e_real.py
"""
from __future__ import annotations

import time

import requests
from docx import Document

BASE = "http://127.0.0.1:8101"


def post(path: str, payload: dict, timeout: int = 120) -> dict:
    t0 = time.time()
    r = requests.post(f"{BASE}{path}", json=payload, timeout=timeout)
    dt = time.time() - t0
    r.raise_for_status()
    data = r.json()
    data["_seconds"] = round(dt, 2)
    return data


def docx_html(path: str) -> str:
    doc = Document(path)
    out = []
    for p in doc.paragraphs:
        t = p.text.strip()
        if t:
            out.append(f"<p>{t}</p>")
    return "\n".join(out)


print("== 模型 ==", requests.get(f"{BASE}/v1/llm/info", timeout=10).json())

print("\n===== 1) 知识库问答（真模型）=====")
qa = post("/v1/kb/lab/qa", {"question": "安置房建设的缺口情况如何？有哪些应对措施？"})
print(f"耗时 {qa['_seconds']}s  mock={qa['mock']}")
print("答案:")
for line in qa["answer"].split("\n"):
    if line.strip():
        print("  " + line[:160])
print("引用:", [(c["doc"][:16], c["ord"]) for c in qa["citations"][:3]])

print("\n===== 2) 专业改写（真模型）=====")
sel = (
    "本次实验测量了硅二极管的正向压降，硅二极管导通后压降基本恒定，"
    "测得0.7V时电流8.5mA，我们认为结果还行。"
)
rw = post("/v1/kb/lab/rewrite", {"selection": sel})
print(f"耗时 {rw['_seconds']}s  mock={rw['mock']}  文体={rw.get('genreLabel')}")
print("原文:", sel)
print("候选:", rw["candidate"][:300])
print("术语改动:", rw["changes"])
print("检查清单:", rw["checklist"])

print("\n===== 3) Agent 读文档并总结（真模型）=====")
html = docx_html(r"C:\Users\16595\Desktop\朵文件\安置情况汇报.docx")
ag = post("/v1/agent/run", {"html": html, "query": "用三句话总结这份文档的核心内容"})
print(f"耗时 {ag['_seconds']}s  mock={ag['mock']}  工具={ag['toolsUsed']}")
print("答案:")
for line in ag["answer"].split("\n"):
    if line.strip():
        print("  " + line[:200])
print("步骤:", [f"{s['phase']}:{s['detail'][:20]}" for s in ag["steps"]])
