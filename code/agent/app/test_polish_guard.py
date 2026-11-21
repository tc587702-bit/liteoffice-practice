"""润色护栏自测：好润色要放过，编造要拦住。不联网、不加载生成模型。

    python -m app.test_polish_guard
"""
from __future__ import annotations

from . import polish_guard as PG

FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  → {detail}" if detail else ""))
    if not ok:
        FAILED += 1


ORIG = "我坐在长椅上看着风景，心里十分开心。"

# 应当放过的润色：只动表达，事实没变
GOOD = [
    ("换形容词", "我坐在长椅上看着风景，心里格外舒畅。"),
    ("换句式", "我坐在长椅上，望着眼前的风景，心里舒展极了。"),
    ("加比喻意象", "我靠着长椅，看风把树影摇成细碎的斑，心里头像被阳光晒过一样舒展。"),
    ("加感官修饰", "我坐在长椅上看着风景，阳光柔和，心里十分开心。"),
    ("压缩冗余", "我坐在长椅上看风景，心里舒展。"),
]

# 应当拦住的改写：引入新事实
BAD = [
    ("擅自加动作", "我坐在长椅上看着风景，忽然车轮一打滑，心里十分开心。", "new_event"),
    ("编造情节", "我坐在长椅上看着风景，想起去年在海边度过的那个夏天。", None),
    ("新增人名", "我坐在长椅上看着风景，小明走过来，心里十分开心。", None),
    ("新增数字", "我坐在长椅上看着风景，心里十分开心，等了三十分钟。", "fact_new"),
    ("改数字", "我三点坐在长椅上看着风景。", None),
    # 跑题需要相似度信号：它换掉全部实词但不触发事实规则，
    # 只有「相似度极低 + 原文词几乎不保留」双条件能识别（实测 0.3193）
    ("完全跑题", "量子纠缠是拓扑绝缘体研究中的核心问题。", "topic_drift"),
    ("删掉大半", "我开心。", "too_short"),
]


def main() -> int:
    print("=== 1) 好润色必须放过（这是与规范修正护栏的核心差别） ===")
    for name, text in GOOD:
        r = PG.check(ORIG, text)
        check(f"{name} 被采纳", r["ok"], "；".join(b["detail"] for b in r["blocked"]) or "通过")

    print("\n=== 2) 编造/跑题必须拦住 ===")
    for name, text, want_rule in BAD:
        # 跑题判定需要真实相似度；其余用例不传，确保事实护栏独立成立
        sim = PG.similarity(ORIG, text) if want_rule == "topic_drift" else None
        r = PG.check(ORIG, text, similarity=sim)
        hit = (not r["ok"]) and (want_rule is None or any(b["rule"] == want_rule for b in r["blocked"]))
        check(f"{name} 被拦下", hit, "；".join(b["detail"] for b in r["blocked"]) or "★未拦住")

    print("\n=== 3) 数字/引号硬约束（复用规范护栏的抽取器） ===")
    b = "会议定于三点开始，他强调「安全第一」。"
    check("改时间被拦", not PG.check(b, "会议定于四点开始，他强调「安全第一」。")["ok"])
    check("改引号内容被拦", not PG.check(b, "会议定于三点开始，他强调「质量第一」。")["ok"])
    check("保留则可润色", PG.check(b, "会议定于三点开始，他反复强调「安全第一」。")["ok"])

    print("\n=== 4) 相似度只作辅助，不作采纳依据 ===")
    # 「擅自加动作」实测相似度 0.8487（高于中度润色），必须仍被拦
    r = PG.check(ORIG, "我坐在长椅上看着风景，忽然车轮一打滑，心里十分开心。", similarity=0.8487)
    check("高相似度的编造仍被拦", not r["ok"], "；".join(b["detail"] for b in r["blocked"]))
    # 好润色相似度 0.6679 偏低，但不能因此被拒
    r2 = PG.check(ORIG, "我靠着长椅，看风把树影摇成细碎的斑，心里头像被阳光晒过一样舒展。", similarity=0.6679)
    check("低相似度的好润色仍被采纳", r2["ok"], "；".join(b["detail"] for b in r2["blocked"]))
    # 提示区间（topic_drift 0.35 ~ min_similarity 0.55）：只提醒，不拒绝
    r3 = PG.check(ORIG, GOOD[2][1], similarity=0.45)
    check("相似度偏低只给提示不拒绝", r3["ok"] and bool(r3["notes"]), str(r3["notes"]))
    # 低于跑题线：即使内容是好润色，也判话题漂移（宁可保守，交人工复核）
    r4 = PG.check(ORIG, GOOD[2][1], similarity=0.30)
    check("低于跑题线一律拦下", not r4["ok"] and any(b["rule"] == "topic_drift" for b in r4["blocked"]),
          "；".join(b["detail"] for b in r4["blocked"]))

    print("\n=== 5) 边界与降级 ===")
    check("空输出被拦", not PG.check(ORIG, "")["ok"])
    check("完全相同视为通过", PG.check(ORIG, ORIG)["ok"])
    check("无相似度也能判定", PG.check(ORIG, GOOD[0][1], similarity=None)["ok"])

    print("\n=== 6) 与规范修正护栏的分工（同一段，两套结论） ===")
    from . import rewrite_guard as RG

    polish_text = GOOD[2][1]
    rg = RG.check(ORIG, polish_text)
    pg = PG.check(ORIG, polish_text)
    check("规范护栏拦下这段润色", not rg["ok"], "；".join(b["detail"] for b in rg["blocked"]))
    check("润色护栏采纳这段润色", pg["ok"])

    # 以下用例来自对抗测试：曾全部漏放，且相似度 0.72~0.98 全都拦不住，
    # 只能靠确定性规则守。删掉任何一条都会让对应漏洞重新出现。
    print("\n=== 7) 语义骨架：改义但字数几乎不变（相似度救不了） ===")
    SKELETON = [
        ("情感极性翻转", "我坐在长椅上看着风景，心里很难过。", "polarity"),
        ("人称主体替换", "他坐在长椅上看着风景，心里十分开心。", "subject"),
        ("时态改变", "我曾坐在长椅上看着风景，心里十分开心。", "tense"),
        ("具体实体替换", "我坐在轮椅上看着风景，心里十分开心。", "entity_swap"),
        ("否定反转", "我坐在长椅上看着风景，心里一点也不开心。", "negation"),
    ]
    for name, text, rule in SKELETON:
        r = PG.check(ORIG, text)
        check(f"{name} 被拦下", (not r["ok"]) and any(b["rule"] == rule for b in r["blocked"]),
              "；".join(b["detail"] for b in r["blocked"]) or "★未拦住")

    print("\n=== 8) 新增主谓小句：短事件编造（不含枚举动词/名称后缀） ===")
    for name, text in [
        ("新事件·口语动词", "我坐在长椅上看着风景，手机响了。"),
        ("新人物·无后缀", "我坐在长椅上看着风景，小明来了。"),
        ("新事件·未枚举动词", "我坐在长椅上看着风景，忽然晕了过去。"),
    ]:
        r = PG.check(ORIG, text)
        check(f"{name} 被拦下", not r["ok"], "；".join(b["detail"] for b in r["blocked"]) or "★未拦住")

    print("\n=== 9) 「不」作程度强调不算否定（防误拦） ===")
    for name, text in [
        ("说不出的开心", "我坐在长椅上看着风景，心里说不出的开心。"),
        ("美不胜收", "我坐在长椅上看着风景，美不胜收，心里十分开心。"),
        ("忍不住", "我坐在长椅上看着风景，忍不住笑了，心里十分开心。"),
    ]:
        r = PG.check(ORIG, text)
        # 「忍不住笑了」含真实新事件，允许被其他规则拦，但不得因否定误判
        neg_hit = any(b["rule"] == "negation" for b in r["blocked"])
        check(f"{name} 不被误判为否定", not neg_hit,
              "；".join(b["detail"] for b in r["blocked"]) or "通过")

    print("\n=== 10) 规范护栏同样不许改义（两套标准对事实的判定一致） ===")
    for name, text, rule in SKELETON[:3]:
        r = RG.check(ORIG, text)
        check(f"规范护栏拦下{name}", not r["ok"],
              "；".join(b["detail"] for b in r["blocked"]) or "★未拦住")

    print(f"\n结果：{'全部通过' if not FAILED else f'失败 {FAILED} 项'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())