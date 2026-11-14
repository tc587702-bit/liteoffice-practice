"""
文体判定（纯规则版，不调模型）

用途：文档改写前判断这段属于哪种文体，从而只取该文体的规范与范文。
设计原则：
  1. 规则可解释：每类文体靠"特征词 + 反特征"打分，出问题能改词表
  2. 低置信不硬判：返回候选与置信度，由上层决定是否调模型或让用户选
  3. 无依赖：只读文本，不联网

输出：
    {"genre": "gongwen", "confidence": 0.72, "ranking": [...], "signals": {...}}
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

GENRES = [
    "gongwen",     # 公文
    "lab",         # 实验报告
    "thesis",      # 学术论文 / 课程报告
    "essay_arg",   # 议论文
    "essay_narr",  # 记叙文
    "expository",  # 说明文
]


@dataclass
class GenreRule:
    strong: list[str] = field(default_factory=list)   # 命中 +3
    weak: list[str] = field(default_factory=list)     # 命中 +1
    anti: list[str] = field(default_factory=list)     # 命中 -2
    regex: list[str] = field(default_factory=list)    # 命中 +2


RULES: dict[str, GenreRule] = {
    "gongwen": GenreRule(
        strong=["兹", "遵照", "特此", "此致", "妥否", "请批示", "现将", "收悉", "函告", "特予", "此复", "定于", "召开", "出席", "请予", "务请", "随函", "实施方案", "方案", "汇报", "领导小组", "印发", "抄送", "办公室", "如下"],
        weak=["关于", "通知", "请示", "报告", "批复", "单位", "主管部门", "报送", "附件", "截至", "累计", "涉及", "已完成", "我区", "我县", "我局", "下一步", "存在问题", "工作打算", "同比"],
        anti=["那天", "记得", "忽然", "我心里", "他说："],
        regex=[
            r"关于[\s\S]{2,60}?的(实施)?(通知|请示|报告|函|方案|意见|办法|细则|规定|批复|纪要)",
            r"(?m)^[\s\u3000]*[一二三四五六七八九十]、",
            r"(?m)^[\s\u3000]*[（(][一二三四五六七八九十][）)]",
            r"(区|县|市|局|委|办|领导小组|办公室)",
            r"\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日",
        ],
    ),
    "lab": GenreRule(
        strong=["实验目的", "实验原理", "实验器材", "实验步骤", "数据处理", "误差分析", "结论", "测得", "示波器", "万用表"],
        weak=["记录", "数据", "表格", "电压", "电流", "电阻", "测量", "结果", "图 1", "表 1"],
        anti=["此致", "综上所述", "我认为", "那天", "现将", "领导小组", "实施方案", "印发", "抄送", "我区", "我县", "我局"],
        regex=[r"\d+(\.\d+)?\s*(V|mA|A|Ω|mm|cm|℃|Hz)", r"第[一二三四五1-5]\s*[、.]"],
    ),
    "thesis": GenreRule(
        strong=["摘要", "关键词", "引言", "研究方法", "参考文献", "本文", "研究结果表明", "文献综述"],
        weak=["分析", "讨论", "结论", "数据来源", "样本", "假设", "方法"],
        anti=["此致", "那天", "记得"],
        regex=[r"\[\d+\]", r"(图|表)\s*\d+[-.]\d+", r"(19|20)\d{2}"],
    ),
    "essay_arg": GenreRule(
        strong=["首先", "其次", "然而", "因此", "综上所述", "有人认为", "我认为", "由此可见"],
        weak=["例如", "比如", "论据", "观点", "反之", "诚然", "一方面", "另一方面"],
        anti=["兹", "特此", "实验器材"],
        regex=[r"[。！？]\s*(然而|但是|因此)", r"“?[^”]{4,20}”?\s*这句话"],
    ),
    "essay_narr": GenreRule(
        strong=["那天", "记得", "后来", "忽然", "这时", "那时", "我不禁", "眼泪", "心里一"],
        weak=["我", "他", "她", "我们", "走", "看", "说", "笑"],
        anti=["摘要", "关键词", "此致", "实验步骤"],
        regex=[r"[“」].{2,40}[”」]", r"(早上|傍晚|深夜|雨|阳光|风)"],
    ),
    "expository": GenreRule(
        strong=["分为", "包括", "是指", "特点是", "作用是", "主要类型", "构成", "定义"],
        weak=["例如", "一般", "通常", "种类", "结构", "原理", "过程"],
        anti=["那天", "此致", "我认为"],
        regex=[r"所谓.{2,12}，是指", r"分为[^。]{2,20}(类|种|部分)"],
    ),
}

# 文体中文名（给界面与报告用）
GENRE_LABEL = {
    "gongwen": "公文",
    "lab": "实验报告",
    "thesis": "学术论文",
    "essay_arg": "议论文",
    "essay_narr": "记叙文",
    "expository": "说明文",
}


def _count_hits(text: str, words: list[str]) -> int:
    return sum(1 for w in words if w in text)


def score_genre(text: str, genre: str) -> tuple[float, dict]:
    rule = RULES[genre]
    strong = _count_hits(text, rule.strong)
    weak = _count_hits(text, rule.weak)
    anti = _count_hits(text, rule.anti)
    regex = sum(1 for p in rule.regex if re.search(p, text))

    raw = strong * 3 + weak * 1 + regex * 2 - anti * 2
    # 饱和式归一化：raw/(raw+K)
    # 作用：命中 1 个强特征就能到 0.3 左右，不会因为「该类特征词多」而被摊薄
    K = 8.0
    norm = 0.0 if raw <= 0 else raw / (raw + K)
    return norm, {"strong": strong, "weak": weak, "anti": anti, "regex": regex}


def classify(text: str, min_confidence: float = 0.30) -> dict:
    """
    返回 {genre, confidence, ranking, signals}
    genre 为 None 表示无法判定（置信度不足），上层应让用户选或调模型。
    """
    text = (text or "").strip()
    if len(text) < 20:
        return {"genre": None, "confidence": 0.0, "ranking": [], "signals": {}, "reason": "文本过短"}

    scores = []
    signals = {}
    for g in GENRES:
        s, sig = score_genre(text, g)
        scores.append((g, s))
        signals[g] = sig

    scores.sort(key=lambda x: -x[1])
    top_g, top_s = scores[0]
    _, second_s = scores[1] if len(scores) > 1 else (None, 0.0)
    gap = top_s - second_s

    # 置信度 = 领先幅度，兼顾绝对分
    confidence = round(min(1.0, max(0.0, (gap * 0.6 + top_s * 0.4))), 3)

    ranking = [
        {"genre": g, "label": GENRE_LABEL[g], "score": round(s, 3), "signals": signals[g]}
        for g, s in scores[:3]
    ]

    if top_s < min_confidence or gap < 0.05:
        return {
            "genre": None,
            "confidence": confidence,
            "ranking": ranking,
            "signals": signals,
            "reason": "特征不足，建议用户选择文体",
        }

    return {
        "genre": top_g,
        "label": GENRE_LABEL[top_g],
        "confidence": confidence,
        "ranking": ranking,
        "signals": signals,
        "reason": f"命中 {signals[top_g]['strong']} 个强特征、{signals[top_g]['regex']} 个格式特征",
    }


def build_prompt(text: str, result: dict) -> str:
    """模型兜底时用的判定 prompt（结果未定或需复核时调用）"""
    cands = "、".join(GENRE_LABEL[g] for g in GENRES)
    hint = ""
    if result.get("ranking"):
        top = result["ranking"][0]
        hint = f"\n规则初步判断：{top['label']}（分数 {top['score']}）"
    return (
        f"判断下面这段文字属于哪种文体，只输出一项：{cands}、其他。\n"
        f"只看语言特征，不评论内容质量。输出格式：文体|置信度(0-1)|一句话理由。{hint}\n\n"
        f"文字：\n{text[:200]}"
    )
