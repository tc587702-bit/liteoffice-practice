"""检查与改写的一致性回归：同一处，检查报 ⟺ 改写会改

背景：用户反馈「一圈一圈」检查说错、改写说没问题。
根因有两个（量词表缺词 + fix_text 取错 unit），这里固化用例防止回退。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import grammar

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


# 合法重叠：检查不报，改写也不动
LEGAL = [
    "一圈一圈",
    "一道一道",
    "一层一层",
    "一片一片",
    "一步一步",
    "一遍一遍",
    "一趟一趟",
    "一阵一阵",
    "一声一声",
    "一天一天",
    "雪白雪白",
    "滚烫滚烫",
    "碧绿碧绿",
    "晒着晒着",
    "走着走着",
    "很慢很慢",
    "特别特别",
    "没事没事",
]
# 真手误：检查报，改写能改
TYPOS = ["开心开心", "苹果苹果", "高兴高兴"]

print("=== 1) 合法重叠：检查不报、改写不改 ===")
for text in LEGAL:
    rep = grammar.check_repeat(text)
    out, notes = grammar.fix_text(text)
    # 合法重叠允许"不报"，也允许"可选"（强调式），但不能是"建议改"\n    check(f"{text} 不是必改", all(i["level"] == "info" for i in rep), f"报了 {[i['levelLabel'] for i in rep]}")
    check(f"{text} 改写不改", not notes, f"改了 {notes}")

print("\n=== 2) 真手误：检查报、改写能改（一致性核心）===")
for text in TYPOS:
    rep = grammar.check_repeat(text)
    out, notes = grammar.fix_text(text)
    check(f"{text} 检查报", bool(rep), "没报")
    check(f"{text} 改写改了", bool(notes), "没改（检查说错却改不动 = 不一致）")
    if notes and rep:
        unit = text[: len(text) // 2]
        check(f"{text} 改后不再双写", unit + unit not in out and out == unit, out)

print("\n=== 3) 句子里也能改 ===")
sentence = "我心里开心开心得不得了。"
out, notes = grammar.fix_text(sentence)
check("句中重复被删", "开心开心" not in out, out)
check("改动有记录", any("重复" in n for n in notes), str(notes))

print("\n" + "=" * 60)
print(f"结果：PASS {PASS} / FAIL {FAIL}")
for f in FAILS:
    print("  FAIL:", f)
raise SystemExit(0 if FAIL == 0 else 1)
