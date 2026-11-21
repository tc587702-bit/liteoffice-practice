"""深度分析护栏回归用例（mock 模型，无 Key 也能跑）

覆盖：模型返回代码 / 表格 / 跑题内容时必须被丢弃，正常改写要保留。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import llm, review

PASS = 0
FAIL = 0
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILS.append(f"{name} | {detail}")
        print(f"  FAIL  {name}  {detail}")


HTML = "<p>昨天下完雨后，我骑车去公园。路面很滑，我差一点摔倒，幸好反应快。公园里的花开得很鲜艳。</p>"
QUOTE = "路面很滑，我差一点摔倒"


def model_return(rewrite: str, problem: str = "表达可更紧凑"):
    payload = (
        '{"issues":[{"level":"should","quote":"'
        + QUOTE
        + '","problem":"'
        + problem
        + '","why":"读起来拖沓","rewrite":"'
        + rewrite.replace('"', '\\"')
        + '"}]}'
    )
    return llm.LlmResult(True, payload, "fake/model", mock=False)


def run_review(rewrite: str, problem: str = "表达可更紧凑") -> dict:
    with mock.patch.object(review, "has_credentials", return_value=True), mock.patch.object(
        review, "complete", return_value=model_return(rewrite, problem)
    ):
        return review.review(HTML, genre="essay_narr", max_sections=1)


print("=== 1) 模型返回代码：必须丢弃 ===")
for code in [
    "print('hello')",
    "def f(x):\\n    return x + 1",
    "const el = document.querySelector('.x');",
    "SELECT name FROM users;",
    "<script>alert(1)</script>",
]:
    r = run_review(code)
    check(
        f"丢弃：{code[:22]}",
        len(r.get("issues") or []) == 0 and r.get("dropped", 0) >= 1,
        f"issues={len(r.get('issues') or [])} dropped={r.get('dropped')}",
    )

print("\n=== 2) 正常改写：必须保留 ===")
r = run_review("路面湿滑，我险些摔倒")
check("保留正常改写", len(r.get("issues") or []) == 1, f"issues={len(r.get('issues') or [])}")
if r.get("issues"):
    check("改写内容正确带入", "湿滑" in r["issues"][0]["how"], r["issues"][0]["how"][:30])

print("\n=== 3) 跑题/夸大改写：按润色护栏丢弃 ===")
r = run_review("路面湿滑，我车轮一打滑，重重摔在地上，膝盖流血不止")
check("拦下擅自加的情节", len(r.get("issues") or []) == 0, f"dropped={r.get('dropped')} {r.get('droppedReasons')}")

print("\n=== 4) 改写里混入分号与花括号但仍是中文 ===")
r = run_review("路面湿滑；我险些摔倒")
check("少量标点不误判为代码", len(r.get("issues") or []) == 1, f"issues={len(r.get('issues') or [])}")

print("\n=== 5) 正常中文改写不得被误杀 ===")
# 原来这里用的改写是「改成更简洁的说法」，看着像正常文本，
# 实际是 prompt 明令禁止的空话（不是可直接替换的成品句），
# 且与原文毫无用词重合 —— 加了话题检测后会被判跑题丢弃，这是正确行为。
# 故改用真实成品句测「不误杀」，另起一条测空话该被丢弃。
r = run_review("路面湿滑，我险些摔倒")
check("正常文本不受影响", len(r.get("issues") or []) == 1,
      f"dropped={r.get('dropped')} {r.get('droppedReasons')}")

print("\n=== 6) 空话式改写（不是成品句）应丢弃 ===")
r = run_review("改成更简洁的说法", problem="原文格式问题")
check("空话被丢弃", len(r.get("issues") or []) == 0,
      f"issues={len(r.get('issues') or [])}")

print("\n" + "=" * 60)
print(f"结果：PASS {PASS} / FAIL {FAIL}")
for f in FAILS:
    print("  FAIL:", f)
raise SystemExit(0 if FAIL == 0 else 1)
