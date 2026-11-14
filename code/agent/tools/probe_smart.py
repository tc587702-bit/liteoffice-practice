"""用三个"需要推理"的问题探测 agent 现在的能力边界"""
from __future__ import annotations

import time

import requests

BASE = "http://127.0.0.1:8101"

QUESTIONS = [
    "安置房缺口和养老保险缺口，哪个更严重？应该先解决哪个？",
    "根据这些材料，高新区在拆迁安置上最大的风险是什么？为什么？",
    "把安置房、补偿资金、养老保险三块的缺口数据列成一句结论。",
]

for i, q in enumerate(QUESTIONS, 1):
    t0 = time.time()
    try:
        r = requests.post(f"{BASE}/v1/kb/lab/qa", json={"question": q, "topK": 5}, timeout=180).json()
    except Exception as exc:  # noqa: BLE001 探测脚本，失败要打印原因
        print(f"[{i}] 请求失败：{exc}")
        continue
    dt = time.time() - t0
    print("=" * 72)
    print(f"[{i}] 问：{q}")
    print(f"     耗时 {dt:.1f}s  引用 {len(r.get('citations', []))} 条  mock={r.get('mock')}")
    ans = (r.get("answer") or "").strip()
    print("     答：")
    for line in ans.split("\n")[:8]:
        if line.strip():
            print("       " + line[:150])
    if not ans:
        print("       （空）")
    print()
