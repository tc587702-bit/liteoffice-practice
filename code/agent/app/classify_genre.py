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
    "contract",    # 合同 / 协议
    "resume",      # 简历
    "news",        # 新闻报道
    "legal",       # 法律文书（判决书 / 起诉状 / 上诉状）
    "textbook",    # 教材讲义 / 教案
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
        # 「召开/出席/定于」也是会议新闻的必用词，不加反特征会与 news 打平（各 8 分）
        anti=["那天", "记得", "忽然", "我心里", "他说：", "本报讯", "记者", "甲方", "乙方", "原告", "被告", "教学目"],
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
        weak=[
            "我", "他", "她", "我们", "走", "看", "说", "笑",
            # 生活化时间与感受词：短篇记叙文几乎必出现，公文里不会出现
            "昨天", "今天", "晚上", "早上", "下午", "中午",
            "觉得", "发现", "回家", "高兴", "开心", "喜欢", "害怕", "哭", "累",
        ],
        anti=["摘要", "关键词", "此致", "实验步骤", "现将", "特此", "贯彻落实"],
        regex=[
            r"[“」].{2,40}[”」]",
            r"(早上|傍晚|深夜|雨|阳光|风)",
            # 第一人称 + 事件动词 + 了/着/过：记叙文的典型句式
            r"(我|他|她)(们)?[^。！？]{0,12}(了|着|过)",
            r"(周末|假期|暑假|寒假|放学|第二天|星期[一二三四五六日天])",
        ],
    ),
    "expository": GenreRule(
        strong=["分为", "包括", "是指", "特点是", "作用是", "主要类型", "构成", "定义"],
        weak=["例如", "一般", "通常", "种类", "结构", "原理", "过程"],
        anti=["那天", "此致", "我认为"],
        regex=[r"所谓.{2,12}，是指", r"分为[^。]{2,20}(类|种|部分)"],
    ),
    # 合同 / 协议：靠"甲方乙方 + 第X条 + 违约/签订"锚定，与法律文书（原告被告）区分
    "contract": GenreRule(
        strong=["甲方", "乙方", "违约责任", "本合同", "合同期限", "付款方式", "违约金",
                "解除合同", "不可抗力", "争议解决", "双方协商一致", "签订本合同"],
        weak=["标的", "金额", "总价", "价款", "履行", "条款", "权利", "义务", "生效", "签署", "担保"],
        anti=["原告", "被告", "本院认为", "判决书", "那天", "教学目"],
        regex=[
            r"第[一二三四五六七八九十百\d]+条",
            r"甲\s*方[（(：:]",
            r"乙\s*方[（(：:]",
            r"(签订|订立|签署).{0,8}(合同|协议)",
        ],
    ),
    # 简历：靠"个人信息 + 求职意向 + 教育/工作经历 + 技能"锚定
    "resume": GenreRule(
        strong=["求职意向", "期望薪资", "工作经验", "教育背景", "个人简介", "自我评价",
                "专业技能", "项目经历", "毕业院校", "联系电话", "应聘"],
        weak=["姓名", "性别", "学历", "专业", "毕业", "实习", "任职", "负责", "掌握", "熟悉", "证书"],
        anti=["那天", "本院认为", "实验目的", "甲方"],
        regex=[
            r"(电话|手机|邮箱|E-?mail)[：:]",
            r"\d{4}\s*[./-]\s*\d{1,2}\s*[–~至-]\s*\d{4}",
            r"(本科|硕士|博士|大专|学士)",
        ],
    ),
    # 新闻报道：靠"电头/记者 + 时间地点导语 + 倒金字塔"锚定
    "news": GenreRule(
        strong=["本报讯", "记者", "新华社", "电（", "获悉", "报道", "采访", "发布会",
                "近日", "日前", "据悉"],
        weak=["表示", "介绍", "指出", "出席", "召开", "举行", "透露", "强调", "有关", "相关"],
        anti=["那天", "我认为", "实验目的", "甲方", "乙方", "求职意向"],
        regex=[
            r"(本报|新华社|中新社)?[\u4e00-\u9fa5]{2,6}\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*电",
            r"记者\s*[\u4e00-\u9fa5]{2,4}",
            r"（.{2,8}）?讯",
        ],
    ),
    # 法律文书：靠"当事人称谓 + 法院用语 + 判决主文"锚定，与合同（甲方乙方）区分
    "legal": GenreRule(
        strong=["原告", "被告", "本院认为", "判决如下", "上诉人", "被上诉人", "诉讼请求",
                "审理终结", "案由", "证据不足", "驳回", "如不服本判决"],
        weak=["当事人", "法院", "起诉", "答辩", "举证", "庭审", "判决", "裁定", "代理人", "事实与理由"],
        anti=["甲方", "乙方", "求职意向", "实验目的", "那天"],
        regex=[
            r"[\u4e00-\u9fa5]{2,10}(人民法院|法院)",
            r"案号[：:]?\s*[（(]?\d{4}",
            r"第[一二三四五六七八九十百\d]+条.{0,20}(规定|之规定)",
        ],
    ),
    # 教材讲义 / 教案：靠"教学目标 + 重难点 + 课时 + 讲解练习"锚定
    "textbook": GenreRule(
        strong=["教学目标", "教学重点", "教学难点", "课时安排", "教学过程", "本节课",
                "知识点", "例题", "课后作业", "板书设计", "同学们"],
        weak=["讲解", "掌握", "理解", "了解", "学会", "复习", "预习", "小节", "本章", "定义", "公式"],
        anti=["甲方", "原告", "那天", "求职意向", "本报讯"],
        regex=[
            r"第[一二三四五六七八九十百\d]+\s*[章节课]",
            r"(重点|难点)[：:]",
            r"(例|习题|练习)\s*\d+",
        ],
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
    "contract": "合同",
    "resume": "简历",
    "news": "新闻报道",
    "legal": "法律文书",
    "textbook": "教材讲义",
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
