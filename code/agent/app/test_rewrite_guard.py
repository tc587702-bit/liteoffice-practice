"""改写护栏回归用例（mock 模型，无 Key 也能跑）

对应任务书第七节的 8 个必测用例。
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import llm, pipelines, rewrite_guard

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


BASE_TEXT = (
    "昨天下完雨后，我骑车去公园。路面很滑，我差一点摔倒，幸好我反应快。"
    "公园里的花开得很鲜艳，有玫瑰、菊花，还有冬天开的荷花。"
)


@contextmanager
def fake_model(output: str, ok: bool = True):
    """把模型替换成固定输出"""
    with mock.patch.object(llm, "has_credentials", return_value=True), mock.patch.object(
        pipelines,
        "has_credentials",
        return_value=True,
    ), mock.patch.object(
        pipelines,
        "complete",
        return_value=llm.LlmResult(ok, output, "fake/model", mock=False, error=None if ok else "boom"),
    ):
        yield


def run(text: str, output: str, ok: bool = True) -> dict:
    with fake_model(output, ok):
        return pipelines.rewrite("gongwen", text, genre="essay_narr", allow_model_polish=True)


print("=== 1) 加内容：「车轮一打滑」（原方案漏掉的用例）===")
out1 = BASE_TEXT.replace("我差一点摔倒", "我差一点摔倒，车轮一打滑")
r = run(BASE_TEXT, out1)
check(
    "被第④道拦下",
    r.get("guard") and any(b["rule"] == "novel_content" for b in r["guard"]["blocked"]),
    str(r.get("guardMessage"))[:60],
)
# 矩阵第 3 行：规则层也没改动时没有"规则版"可退，应返回 noChange 且文案不谎称已退回
check(
    "无规则版可退时返回 noChange",
    r.get("candidate") == BASE_TEXT or (r.get("noChange") is True and "没有发现需要修改" in (r.get("reason") or "")),
    str(r.get("reason")),
)

print("\n=== 2) 删时间：昨天下完雨后 → 昨天雨后 ===")
out2 = BASE_TEXT.replace("昨天下完雨后", "昨天雨后")
r = run(BASE_TEXT, out2)
check(
    "被第④道拦下（时间细节丢失）",
    bool(r.get("guard")),
    str(r.get("guardMessage"))[:60],
)

print("\n=== 3) 改数字：三点 → 四点 ===")
NUM_TEXT = "我本来打算下午三点回家，但是手机没电了。"
out3 = NUM_TEXT.replace("三点", "四点")
r = run(NUM_TEXT, out3)
check(
    "被第②道拦下",
    r.get("guard") and any(b["rule"] == "enumerable" for b in r["guard"]["blocked"]),
    str(r.get("guardMessage"))[:60],
)

print("\n=== 4) 改引号内容 ===")
Q_TEXT = "外婆说「你快去洗手」，然后就去做饭了。"
out4 = Q_TEXT.replace("你快去洗手", "你赶紧去洗手")
r = run(Q_TEXT, out4)
check(
    "被第②道拦下",
    r.get("guard") and any(b["rule"] == "enumerable" for b in r["guard"]["blocked"]),
    str(r.get("guardMessage"))[:60],
)

print("\n=== 5) 合法润色不被误拦 ===")
P_TEXT = "我坐在长椅上看着风景，心里十分开心。"
out5 = "我坐在长椅上看着风景，心里格外喜悦。"
v = rewrite_guard.check(P_TEXT, out5)
check("十分开心 → 格外喜悦 放行", v["ok"], str(v["blocked"]))
D_TEXT = "公园里的花开的很鲜艳。"
out6 = "公园里的花开得很鲜艳。"
v = rewrite_guard.check(D_TEXT, out6)
check("的→得 放行", v["ok"], str(v["blocked"]))

print("\n=== 6) 短选区合法赘余删除不被误拦 ===")
S_TEXT = "本报告涉及到三个方面的问题。"
out7 = "本报告涉及三个方面的问题。"
v = rewrite_guard.check(S_TEXT, out7)
check("涉及到 → 涉及 放行（基线是规则修正后文本时）", v["ok"], str(v["blocked"]))

print("\n=== 7) 无 Key 时零调用 ===")
with mock.patch.object(pipelines, "has_credentials", return_value=False), mock.patch.object(
    pipelines,
    "complete",
    side_effect=AssertionError("无 Key 时不应调用模型"),
) as m:
    r = pipelines.rewrite("gongwen", BASE_TEXT, genre="essay_narr", allow_model_polish=True)
check("调用次数为 0", m.call_count == 0, f"call_count={m.call_count}")
check("仍返回结果", r.get("ok") is True)

print("\n=== 8) 模型调用失败不污染规则层 ===")
r = run(BASE_TEXT, "", ok=False)
check("标记 modelFailed 或退回规则版", r.get("modelFailed") is True or r.get("mock") is True, str(r.keys())[:80])
check("候选为规则版原文", (r.get("candidate") or "") == BASE_TEXT or r.get("noChange") is True)

print("\n" + "=" * 60)
print(f"结果：PASS {PASS} / FAIL {FAIL}")
for f in FAILS:
    print("  FAIL:", f)
raise SystemExit(0 if FAIL == 0 else 1)
