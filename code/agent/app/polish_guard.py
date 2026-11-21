"""
润色护栏：允许「写得更好看」，但拦住「编造新事实」。

与 rewrite_guard 的分工（两套模式，两套标准）：

    rewrite_guard  规范修正：一个字都不许多，幅度 ≤20%，增删即拦
    polish_guard   优美润色：允许加意象/换句式/调节奏，只守事实底线

为什么不能共用一套：
    实测「我坐在长椅上看着风景，心里十分开心。」→
        「我靠着长椅，看风把树影摇成细碎的斑，心里头像被阳光晒过一样舒展。」
    这是好润色（事实没变），但 rewrite_guard 判「幅度过大 78%」直接拦掉。
    紧了就不可能优美，松了就会改坏原文 —— 必须分开。

为什么不用向量相似度当主闸门（实测否证）：
    好润色相似度区间 0.6679 ~ 0.9214
    坏改写相似度区间 0.3193 ~ 0.8487   ← 完全重叠
    「擅自加车轮一打滑」相似度 0.8487，比中度润色（0.8019）还高。
    bge 测的是「话题相近」，不是「有没有编造」：加一句同场景动作，话题没变，分数自然高。
    所以相似度只作为**辅助信号**（低于下限提示可能跑题），不作为采纳依据。

真正管用的是确定性的事实约束：
    ① 可枚举内容    数字/日期/引号内容必须保留，不得新增（复用 rewrite_guard）
    ② 新增专有名词  原文没有的人名/地名/机构名 → 编造
    ③ 新增事实动作  「动词 + 新宾语」构成新事件 → 编造（车轮一打滑就属于这类）
    ④ 幅度上限      宽松但仍有上限，防止无限膨胀
"""
from __future__ import annotations

import re
from typing import Any

from .rewrite_guard import _enumerable

# ④ 幅度：润色允许变长（加修饰），但不允许无限膨胀。
# 初值给宽，实际取值由 tools/calibrate_polish.py 实测标定后写死在这里。
THRESHOLDS = {
    "max_growth_ratio": 1.20,   # 最多变长 120%
    "max_shrink_ratio": 0.35,   # 最多缩短 35%（优美化常删冗余，但不能删掉大半）
    "min_similarity": 0.55,     # 辅助提示线：低于此值提醒人工确认（不拒绝）
    # 话题漂移：主判据用相似度。实测跑题 0.3193、最重的好润色 0.6679，低分区有足够间隔。
    # 曾把「2-gram 保留率 <25%」当相似度的**叠加条件**，实测被否证：
    # 好润色（加意象换句式）保留率仅 13.3%，低于该值会误拦好润色。
    "topic_drift": 0.35,
    # 但保留率作为**相似度不可用时的兜底**是成立的 —— 二者用法不同：
    # 叠加时要求「同时低于两条」，误杀重度润色；兜底时取远低于好润色的阈值。
    # 本机缺 torch/transformers 时相似度恒为 None，漂移检测会静默失效
    # （实测跑题内容因此直接进了报告），必须有兜底。
    # 同一原文实测：好润色（含最重的加比喻）最低 13.3%，
    #              跑题三类（物理/公文/代码）全部 0.0% → 取 8% 为界。
    "min_retain": 0.08,
}

# ② 专有名词线索：只用**多字后缀**，不用单字。
#
# 单字后缀（省/市/长/号…）误报极高：实测「我靠着长椅」被当成地名「我靠着长」，
# 「绝缘体研究」被当成机构名。中单字歧义太大，宁可漏报也不误报 ——
# 漏掉的名字由 ③ 事实动作与 ③-b 非修饰插入兜底。
_NAME_SUFFIXES = ("先生", "女士", "小姐", "老师", "同学", "同志", "师傅", "医生", "护士", "经理", "主任", "书记", "校长", "院长", "局长", "处长", "科长")
_PLACE_SUFFIXES = ("小区", "街道", "马路", "公园", "广场", "村庄", "县城", "小区门", "号楼", "单元")
_ORG_SUFFIXES = ("公司", "集团", "工厂", "学校", "学院", "大学", "医院", "银行", "委员会", "办公室", "研究院", "研究所", "派出所")
_ALL_SUFFIXES = _NAME_SUFFIXES + _PLACE_SUFFIXES + _ORG_SUFFIXES

# ③ 事实性动作：这些动词带宾语时构成「事件」，不是修饰。
# 「看/望/瞧」等感官动词允许（润色常改写观察方式），但宾语必须是原文已有的。
_EVENT_VERBS = (
    "摔倒|跌倒|打滑|碰撞|撞上|撞倒|吃掉|吃完|喝了|喝完|买了|卖掉|丢了|捡到|"
    "打了|打人|骂了|哭了|笑了|跑了|跑进|跑出|跳了|跳进|飞了|游了|爬了|"
    "拿起|放下|打开|关闭|推开|拉住|抓住|扔了|递给|送给|交给|收到|"
    "想起|记起|回忆|梦见|遇到|碰见|看见|听见|闻到|摸到|"
    "生病|受伤|流血|发烧|住院|去世|死了|活了|救了|"
    "下雨|下雪|刮风|打雷|地震|着火|爆炸"
)
_EVENT_RE = re.compile(_EVENT_VERBS)

# 允许的修饰性插入：比喻/感官/程度词，这些不引入新事实
_METAPHOR_MARK = ("像", "好像", "仿佛", "如同", "似的", "一样", "般", "宛如", "犹如")
_SENSORY_WORDS = (
    "阳光|月光|风|树影|光影|影子|斑|细碎|温暖|温热|清凉|柔软|舒展|轻快|"
    "明亮|柔和|淡淡|微微|静静|悄悄|缓缓|轻轻|安静|宁静|柔和|暖|亮|"
    # 补充：嗅觉/味觉/触觉/声音 —— 「饭香里」这类也属于感官描写
    "香|味|气息|味道|气味|颜色|色彩|声音|声响|动静|温度|热度|凉意|暖意|"
    "甜|苦|酸|辣|涩|滑|粗糙|细腻|沉|轻飘|湿润|干爽|明亮|昏黄|斑驳|"
    # 光/色/质感类意象（实测「竹色」「温润」「泛着」被误判为新增事实）
    "光|色|色泽|竹色|木色|温润|润|泛着|泛出|透出|映|漾|浮|笼|洒|铺|铺开|"
    "淡青|浅灰|金黄|暖黄|青灰|素白|暗红|微光|光里|影里|风里|香气|饭香"
)
_SENSORY_RE = re.compile(_SENSORY_WORDS)

# 纯修饰/虚词片段：换句式时必然产生的连接成分，不构成新事实。
# 「眼前的」「反复」「极了」这类若不放行，任何句式调整都会被误拦。
_FUNCTIONAL_WORDS = (
    "眼前|面前|周围|四周|耳边|心里|心头|心底|心间|仿佛|似乎|好像|犹如|宛如|"
    "反复|不断|一直|始终|依旧|依然|仍然|终究|毕竟|简直|实在|确实|当真|"
    "极了|得很|不已|万分|无比|格外|尤为|特别|十分|非常|颇|略微|稍稍|"
    "于是|然后|接着|随后|这时|那时|此刻|顿时|瞬间|一时|片刻|那一刻|那会儿|那时候|这刻|"
    "着|了|的|地|得|把|被|让|使|令|将|又|也|还|就|才|而|却|便|只是|不过|倒是|反而|竟然|竟|况且|而且|"
    "一|个|些|种|片|缕|丝|抹|团|阵|股|道|层"
)
_FUNC_RE = re.compile(_FUNCTIONAL_WORDS)


def _strip_functional(seg: str) -> str:
    """剥掉纯修饰与虚词后剩下的实义内容"""
    return _han(_FUNC_RE.sub("", seg or ""))


def _han(text: str) -> str:
    return re.sub(r"[^\u4e00-\u9fa5]", "", text or "")


def _proper_nouns(text: str) -> set[str]:
    """
    专有名词抽取：多字后缀 + 前面 2–3 个汉字作为名称主体。

    只用于「out 有、base 没有」的差集比对。要求主体全是汉字且不含虚词，
    避免把「我靠着长椅」这类动词短语误当成名称。
    """
    out: set[str] = set()
    flat = text or ""
    for suf in _ALL_SUFFIXES:
        start = 0
        while True:
            i = flat.find(suf, start)
            if i < 0:
                break
            start = i + len(suf)
            head = _han(flat[max(0, i - 3) : i])
            # 名称主体不含虚词/代词，否则是短语不是名字
            if len(head) >= 2 and not any(ch in _PARTICLE_CHARS for ch in head):
                out.add(head + suf)
    return out


# 虚词与代词：出现在「名称主体」里说明这不是名字
_PARTICLE_CHARS = set("的地得了着过而却便就又也还才正在把被给让和与及或很太更最颇我你他她它们这那")


def _new_event_verbs(base: str, out: str) -> list[str]:
    """out 里出现、base 里没有的事实性动词"""
    b = {m.group(0) for m in _EVENT_RE.finditer(base or "")}
    o = {m.group(0) for m in _EVENT_RE.finditer(out or "")}
    return sorted(o - b)


# ── ⑥ 语义骨架：否定 / 主体 / 时态 / 情感极性 ────────────────────────
#
# 这四类是字符 diff 与相似度**都抓不到**的改义方式，实测全部漏放：
#   「心里十分开心」→「心里很难过」      相似度 0.8303（高）
#   「我坐在长椅上」→「他坐在长椅上」    相似度 0.9338
#   「我坐在长椅上」→「我曾坐在长椅上」  相似度 0.9773
#   「长椅」→「轮椅」                   相似度 0.9505
# 它们字数几乎不变、话题没变，所以必须用确定性规则单独守。

_NEGATIONS = ("没有", "没", "无", "别", "莫", "未", "毫不", "并不", "一点也不", "从不", "绝不", "不")
_NEG_RE = re.compile("|".join(sorted(_NEGATIONS, key=len, reverse=True)))

# 「不」在汉语里大量用作**程度强调**而非否定，必须先剔除再计数，
# 否则「说不出的开心」「美不胜收」这类正常润色会被误判成反转原意（实测已出现）。
_NEG_EMPHATIC = (
    "说不出|说不尽|道不出|数不清|恨不得|巴不得|不由得|不由地|不禁|忍不住|"
    "美不胜收|目不暇接|爱不释手|赞不绝口|妙不可言|乐不可支|喜不自胜|"
    "不知不觉|不由自主|不停|不断|不已|不凡|不俗|不亦乐乎"
)
_NEG_EMPHATIC_RE = re.compile(_NEG_EMPHATIC)


def _count_negation(text: str) -> int:
    """真实否定词数量（剔除程度强调用法的「不」）"""
    return len(_NEG_RE.findall(_NEG_EMPHATIC_RE.sub("", text or "")))

# 人称代词：主体被换掉就是改了事实（谁在做这件事）
_PERSONS = ("我们", "你们", "他们", "她们", "我", "你", "您", "他", "她", "它", "咱", "咱们")
_PERSON_RE = re.compile("|".join(sorted(_PERSONS, key=len, reverse=True)))

# 时态/情态标记：把「正在发生」改成「曾经发生」或「将会发生」都是改事实
_TENSE = ("曾经", "曾", "以前", "从前", "当年", "过去", "将来", "以后", "即将", "将要", "打算", "准备要")
_TENSE_RE = re.compile("|".join(sorted(_TENSE, key=len, reverse=True)))

# 情感极性：正向 vs 负向。润色可以换程度词，但不能把开心写成难过。
_POSITIVE = (
    "开心|高兴|快乐|愉快|喜悦|欢喜|舒畅|舒展|畅快|惬意|满足|幸福|欣慰|"
    "兴奋|激动|温暖|甜美|轻松|安宁|恬静|怡然|欣然|雀跃|欢欣"
)
_NEGATIVE = (
    "难过|伤心|悲伤|悲痛|痛苦|难受|苦闷|郁闷|沮丧|失落|惆怅|忧伤|哀伤|"
    "愤怒|生气|恼火|烦躁|焦虑|恐惧|害怕|惊慌|绝望|委屈|心酸|凄凉|孤寂|落寞"
)
_POS_RE = re.compile(_POSITIVE)
_NEG_SENT_RE = re.compile(_NEGATIVE)


def _polarity(text: str) -> str:
    """粗判情感极性：pos / neg / mixed / neutral"""
    p, n = bool(_POS_RE.search(text or "")), bool(_NEG_SENT_RE.search(text or ""))
    if p and n:
        return "mixed"
    if p:
        return "pos"
    if n:
        return "neg"
    return "neutral"


def _skeleton_changes(base: str, out: str) -> list[dict[str, str]]:
    """
    比对语义骨架：否定、人称主体、时态、情感极性。

    只报「发生了翻转/新增」的情况，不要求字面完全一致 ——
    润色允许「十分开心」→「格外舒畅」（同为正向），但不允许翻成负向。
    """
    issues: list[dict[str, str]] = []

    # 否定词数量变化：新增否定往往直接反转句意（已剔除「说不出的」这类强调用法）
    bn, on = _count_negation(base), _count_negation(out)
    if on > bn:
        issues.append({"rule": "negation", "detail": f"新增否定词（{bn} → {on} 处），可能反转原意"})

    # 人称主体：种类集合发生变化即视为换了主体
    bp = {m.group(0) for m in _PERSON_RE.finditer(base or "")}
    op = {m.group(0) for m in _PERSON_RE.finditer(out or "")}
    # 「我」→「我们」这类单复数变化也算改主体
    if bp != op and (op - bp):
        issues.append({"rule": "subject", "detail": f"人称主体改变：{'、'.join(sorted(bp)) or '无'} → {'、'.join(sorted(op)) or '无'}"})

    # 时态标记新增
    bt = {m.group(0) for m in _TENSE_RE.finditer(base or "")}
    ot = {m.group(0) for m in _TENSE_RE.finditer(out or "")}
    new_t = ot - bt
    if new_t:
        issues.append({"rule": "tense", "detail": "新增时态/情态标记：" + "、".join(sorted(new_t))})

    # 情感极性翻转
    pb, po = _polarity(base), _polarity(out)
    if pb in ("pos", "neg") and po in ("pos", "neg") and pb != po:
        label = {"pos": "正向", "neg": "负向"}
        issues.append({"rule": "polarity", "detail": f"情感极性翻转：{label[pb]} → {label[po]}"})

    # 具体实体被换掉：「长椅」→「轮椅」相似度 0.9505，字符 diff 只看到一字之差。
    # 做法：原文里的具体名词若在输出中整体消失，且出现了同尾字的新词，判为实体替换。
    lost_entities = _replaced_entities(base, out)
    if lost_entities:
        issues.append({"rule": "entity_swap", "detail": "具体事物被替换：" + "、".join(lost_entities[:3])})

    return issues


# 具体事物名词：可指认的实体，不是抽象情绪或修饰。
# 润色可以改形容词，但不能把「长椅」写成「轮椅」——那是换了事实。
_CONCRETE_NOUNS = (
    "长椅|轮椅|椅子|凳子|沙发|床|桌子|书桌|台阶|栏杆|窗台|阳台|门口|走廊|"
    "自行车|单车|汽车|公交|地铁|火车|飞机|轮船|三轮车|电动车|"
    "手机|电话|电脑|书包|雨伞|杯子|碗|筷子|钥匙|钱包|眼镜|手表|"
    "公园|操场|教室|图书馆|食堂|宿舍|医院|车站|码头|河边|湖边|海边|山上|树下"
)
_CONCRETE_RE = re.compile(_CONCRETE_NOUNS)


def _replaced_entities(base: str, out: str) -> list[str]:
    """原文有、输出没有的具体实体（且输出里出现了别的同类实体）"""
    b = {m.group(0) for m in _CONCRETE_RE.finditer(base or "")}
    o = {m.group(0) for m in _CONCRETE_RE.finditer(out or "")}
    lost = b - o
    if not lost:
        return []
    # 只有当输出引入了新的同类实体时才算「替换」；
    # 单纯省略（如压缩句子）由幅度护栏管，不在这里重复拦。
    return sorted(lost) if (o - b) else []


# ── ⑦ 新增主谓小句：编造事件的最常见形态 ──────────────────────────
#
# 「手机响了」「小明来了」这类只有 3–4 字，不含枚举动词、不带专有名词后缀，
# 前面几道全部漏放（实测相似度 0.73 / 0.72，漂移线也拦不住）。
# 共性是「名词 + 动作/变化 + 了/着/过」构成一个**新的小句**。
# 用结构模式识别，不依赖动词枚举 —— 枚举永远追不上口语表达。
_CLAUSE_RE = re.compile(
    r"[\u4e00-\u9fa5]{1,4}(?:响|叫|喊|来|去|走|跑|飞|停|开|关|亮|灭|倒|塌|断|碎|裂|"
    r"笑|哭|闹|吵|说|问|答|点头|摇头|挥手|招手|转身|回头|抬头|低头|站起|坐下|"
    r"出现|消失|靠近|远离|冲|扑|闪|晃|抖|颤|滑|摔|翻|滚)"
    r"(?:了|着|过|起来|过来|过去|下去|上来|出去|进来)"
)


def _new_clauses(base: str, out: str) -> list[str]:
    """out 里新增的主谓小句（base 中没有的）"""
    b = {m.group(0) for m in _CLAUSE_RE.finditer(base or "")}
    o = {m.group(0) for m in _CLAUSE_RE.finditer(out or "")}
    return sorted(o - b)


def _is_decorative(seg: str) -> bool:
    """
    这一段插入是否只是修饰（比喻 / 感官描写），不含新事实。

    判定保守：必须含比喻标记或感官词，且不含事实性动词。
    """
    if not seg:
        return True
    if _EVENT_RE.search(seg):
        return False
    if any(m in seg for m in _METAPHOR_MARK):
        return True
    if _SENSORY_RE.search(seg):
        return True
    # 剥掉虚词与修饰词后没有实义残留 → 只是句式调整，不是加内容
    #
    # 这里曾有「≤4 汉字一律放行」的宽条件，实测被它漏掉：
    #   「小明来了」（新人物）、「手机响了」（新事件）、「晕了过去」（新事件）
    # 短插入恰恰是最常见的编造形态，不能按长度放行。改为只看剥离后是否有实义残留。
    return len(_strip_functional(seg)) < 2


def _added_segments(base: str, out: str) -> list[str]:
    from difflib import SequenceMatcher

    segs: list[str] = []
    for tag, _i1, _i2, j1, j2 in SequenceMatcher(None, base, out, autojunk=False).get_opcodes():
        if tag == "insert":
            # 去掉首尾标点：句号/逗号会被算进"新增内容"，造成「新增非修饰内容：。那一刻」这种误报
            seg = out[j1:j2].strip("，。！？；：、…—-「」“”‘’()（） \t\n")
            if len(_han(seg)) >= 2:
                segs.append(seg)
    return segs


def check(base: str, out: str, similarity: float | None = None) -> dict[str, Any]:
    """
    润色护栏。base = 规则修正后的原文，out = 模型润色结果。

    similarity 可选（本地 bge 余弦）：只作为辅助提示，不单独据此拒绝 ——
    实测它与「好坏」不可分离，当主闸门会同时误拦好润色、放过编造。
    """
    base = (base or "").strip()
    out = (out or "").strip()
    blocked: list[dict[str, str]] = []
    notes: list[str] = []

    if not out:
        return {"ok": False, "blocked": [{"rule": "empty", "detail": "模型返回空内容"}], "notes": []}

    # ① 可枚举内容：数字/日期/引号必须保留且不得新增
    b_enum, o_enum = _enumerable(base), _enumerable(out)
    for key, label in (("numbers", "数字"), ("dates", "日期/时间"), ("quotes", "引号内容")):
        lost = b_enum[key] - o_enum[key]
        if lost:
            blocked.append({"rule": "fact_loss", "detail": f"{label}丢失或被改动：{'、'.join(sorted(lost)[:5])}"})
        added = o_enum[key] - b_enum[key]
        if added:
            blocked.append({"rule": "fact_new", "detail": f"{label}凭空新增：{'、'.join(sorted(added)[:5])}"})

    # ② 新增专有名词
    new_names = _proper_nouns(out) - _proper_nouns(base)
    if new_names:
        blocked.append({"rule": "new_proper_noun", "detail": "新增原文没有的名称：" + "、".join(sorted(new_names)[:4])})

    # ③ 新增事实性动作
    new_verbs = _new_event_verbs(base, out)
    if new_verbs:
        blocked.append({"rule": "new_event", "detail": "新增原文没有的事件：" + "、".join(new_verbs[:4])})

    # ③-b 非修饰性插入：既不含比喻也不含感官词的整段新增，视为加内容
    plain_added = [s for s in _added_segments(base, out) if not _is_decorative(s)]
    if plain_added:
        blocked.append({"rule": "new_content", "detail": "新增非修饰内容：" + "、".join(x[:20] for x in plain_added[:3])})

    # ⑥ 语义骨架：否定/主体/时态/情感极性（字符 diff 与相似度都抓不到）
    blocked.extend(_skeleton_changes(base, out))

    # ⑦ 新增主谓小句：「手机响了」「小明来了」这类短事件编造
    new_clauses = _new_clauses(base, out)
    if new_clauses:
        blocked.append({"rule": "new_clause", "detail": "新增原文没有的情节：" + "、".join(new_clauses[:3])})

    # ④ 幅度
    lb, lo = len(_han(base)), len(_han(out))
    if lb:
        growth = (lo - lb) / lb
        if growth > THRESHOLDS["max_growth_ratio"]:
            blocked.append({"rule": "too_long", "detail": f"膨胀过多（+{growth:.0%}，上限 +{THRESHOLDS['max_growth_ratio']:.0%}）"})
        elif growth < -THRESHOLDS["max_shrink_ratio"]:
            blocked.append({"rule": "too_short", "detail": f"删减过多（{growth:.0%}，下限 -{THRESHOLDS['max_shrink_ratio']:.0%}）"})

    # ⑤ 整体话题漂移：整段在说另一件事 → 不是润色而是另写。
    #
    # 这是相似度**唯一**站得住的用法：判「整段是否还在说同一件事」。
    # 实测跑题 0.3193、好润色最低 0.6679，**低分区可分离**；
    # 高分区不可分离（编造「车轮一打滑」0.8487 高于中度润色 0.8019），
    # 所以绝不能用相似度判编造 —— 那由 ①②③ 的确定性事实约束负责。
    if similarity is not None:
        if similarity < THRESHOLDS["topic_drift"]:
            blocked.append({
                "rule": "topic_drift",
                "detail": f"整段话题已改变（语义相似度 {similarity:.2f}，低于 {THRESHOLDS['topic_drift']}）",
            })
        elif similarity < THRESHOLDS["min_similarity"]:
            notes.append(f"语义相似度偏低（{similarity:.2f}），建议人工确认是否跑题")
    else:
        # 相似度不可用（缺 torch/transformers）时的兜底：字面保留率。
        # 不兜底的话这一整条检测会静默失效，实测跑题内容直接进了报告。
        keep = retain_ratio(base, out)
        if keep < THRESHOLDS["min_retain"]:
            blocked.append({
                "rule": "topic_drift",
                "detail": f"整段话题已改变（原文用词仅保留 {keep:.0%}，且语义模型不可用）",
            })

    return {"ok": not blocked, "blocked": blocked, "notes": notes}


def retain_ratio(base: str, out: str) -> float:
    """
    原文 2-gram 在输出中的保留比例（0–1）。相似度的离线兜底。

    只在「整段是否还在说同一件事」这个粗粒度判断上用，
    不用于判编造 —— 那必须靠确定性的事实约束。
    """
    bg = _bigrams(base)
    if not bg:
        return 1.0
    return len(bg & _bigrams(out)) / len(bg)


def _bigrams(text: str) -> set[str]:
    h = _han(text)
    return {h[i : i + 2] for i in range(len(h) - 1)}


def similarity(a: str, b: str) -> float | None:
    """
    本地 bge 余弦相似度；模型不可用时返回 None（护栏不依赖它，故可缺省）。

    注意接口名：embed_local 的入口是 embed_query / __call__，没有 encode。
    """
    try:
        from . import embed
        from .embed_local import get_embedder

        emb = get_embedder()
        return embed.cosine(emb.embed_query(a), emb.embed_query(b))
    except Exception:  # noqa: BLE001 缺 torch/模型时静默降级，不影响事实护栏
        return None