"""
通用中文语病检查（不分文体，记叙文/议论文/说明文都能用）

为什么需要它：
  app/improve.py 原有的四类检查（结构/数据/表达/体例）是为【公文】写死的，
  检查项全是「缺基本情况」「缺下一步措施」「数字没单位」「没有主送机关」。
  拿它查记叙文，会给出六条完全不对题的建议，却漏掉所有真实语病。

  实测样本（207 字记叙文）人工对照有 8 处问题，原检查器命中 0 处：
    开心开心（词语重复）／花开的很鲜艳（应为「得」）／风轻轻的吹（应为「地」）
    脸旁（错字，应为「脸庞」）／路上面很滑（赘余）
    荷花是冬天开的（事实错误）
    三点回家＋提前一小时＋到家四点半（时间矛盾）
    一点都不喜欢吃＋全部吃光（逻辑矛盾）

本模块覆盖其中【可用规则可靠判定】的 5 类，另对 1 类做线索提示：

  可靠判定：重复词 / 的得地 / 错字 / 赘余 / 否定-完成矛盾
  线索提示：时间表述（把时间点全部列出让人核对，不断言矛盾）
  无法判定：事实错误（「荷花冬天开」需要常识知识，只能走模型，见 check_facts）

设计原则（与 improve.py 一致）：
  1. 纯规则、不依赖模型、结果稳定可复现
  2. 每条都给 位置 + 原文摘录 + 为什么 + 怎么改
  3. 宁可漏报也不误报：拿不准的一律不报，或降级为「可选」
"""
from __future__ import annotations

import re
from typing import Any

LEVEL_LABEL = {"error": "必须改", "warning": "建议改", "info": "可选"}
_ORDER = {"error": 0, "warning": 1, "info": 2}


def _issue(
    level: str,
    where: str,
    problem: str,
    why: str,
    how: str,
    excerpt: str = "",
    block: int | None = None,
    pos: int | None = None,
) -> dict[str, Any]:
    return {
        "level": level,
        "levelLabel": LEVEL_LABEL.get(level, level),
        "where": where,
        "problem": problem,
        "why": why,
        "how": how,
        "excerpt": excerpt[:80],
        "block": block,
        "pos": pos,
    }


# ---------------------------------------------------------------- ① 词语重复

# 判定依据是重叠形态，不是逐个词列白名单：
#   AA 式（单字重叠）        轻轻 / 妈妈 / 看看   → 中文里普遍合法，一律不报
#   ABAB 式·动词             研究研究 / 商量商量 → 合法的重叠用法，不报
#   ABAB 式·形容词或名词      开心开心 / 苹果苹果 → 不合法，判为手误
# 这样既不会误报「轻轻」，也能抓住「开心开心」。
_VERB_ABAB = {
    "研究研究", "讨论讨论", "商量商量", "考虑考虑", "分析分析",
    "休息休息", "活动活动", "收拾收拾", "整理整理", "检查检查",
    "调查调查", "核实核实", "沟通沟通", "联系联系", "了解了解",
    "回忆回忆", "比较比较", "计算计算", "锻炼锻炼", "准备准备",
}

# ABAB 式状态形容词：雪白雪白 / 滚烫滚烫 / 笔直笔直 —— 合法的强调重叠。
#
# 上面那份 _VERB_ABAB 是枚举白名单，覆盖不全就误报：实测「滚烫滚烫」
# 「雪白雪白」「碧绿碧绿」「打扫打扫」全被判成手误。枚举永远追不上词汇量，
# 所以这里改用构词形态判断：
#   ① 「单字程度/状态语素 + 形容词」构成的偏正复合词（雪白=像雪一样白，
#      滚烫=滚一样烫，笔直=像笔一样直，冰凉、通红、漆黑、火红…）
#      这类词重叠后是汉语常见强调式，一律合法。
#   ② 末字是颜色/温度/触感等状态形容词性语素，且首字为具象名词或程度语素。
# 判不出来的仍走原逻辑报「建议改」，保持对「开心开心」「苹果苹果」的召回。
_STATE_ADJ_TAIL = "白黑红黄绿蓝紫灰青亮暗冷热烫凉暖冰冻甜苦辣酸香臭软硬干湿深浅高低长短宽窄厚薄轻重快慢新旧胖瘦圆扁尖平直弯斜歪粗细密稀空满"
# 偏正复合状态形容词的首字：表「像…一样」的具象喻体或程度语素。
# 雪白=像雪一样白，滚烫=滚一样烫，笔直=像笔一样直。
_STATE_ADJ_HEAD = "雪漆墨血火铁金银玉冰滚通笔刷焦粉嫩湛碧翠乌蜡澄鲜崭飞铮稀煞死透稀溜"


def _is_state_adj_abab(unit: str) -> bool:
    """
    判断 ABAB 的 AB 是否为「偏正复合状态形容词」（雪白 / 滚烫 / 笔直 …）。

    两端都必须命中语素表，才算状态形容词：
      雪白 → 首「雪」在喻体表、末「白」在状态表 → 合法重叠
      开心 → 末「心」不在状态表 → 仍判手误
      苹果 → 末「果」不在状态表 → 仍判手误
    刻意不用「首字不在状态表就放行」这种宽条件，否则「苹果苹果」会被漏放。
    """
    if len(unit) != 2:
        return False
    head, tail = unit[0], unit[1]
    return head in _STATE_ADJ_HEAD and tail in _STATE_ADJ_TAIL

# 两个相同的 1–4 字片段紧邻出现
_REPEAT_RE = re.compile(r"([\u4e00-\u9fa5]{1,4})\1")

# 量词 / 名词重叠：一道一道、一片一片、一层一层 —— 中文里表「多而连续」，合法
_MEASURE_HEADS = "道片层条根颗只群堆排串滴块张页条句份类种"
# V着V着：晒着晒着、走着走着、看着看着 —— 表「动作持续并产生结果」，合法
_VZHE_RE = re.compile(r"^([\u4e00-\u9fa5])着\1着$")
# 惯用的安慰/否定反复：没事没事、不行不行、不对不对 —— 口语语气，不算病
_IDIOM_REPEAT = {
    "没事没事", "没事儿没事儿", "不行不行", "不对不对", "不是不是",
    "不要不要", "不会不会", "不敢不敢", "没有没有", "不好不好",
}
# 程度副词重叠：很慢很慢、特别特别、非常非常 —— 表强调，可保留，只是不够书面
_DEGREE_HEADS = ("很", "非常", "特别", "十分", "格外", "极", "太", "真是")


def _repeat_kind(unit: str) -> str:
    """
    给重复片段归类：
      ok     → 合法用法，不报（量词重叠、V着V着）
      style  → 口语强调，报「可选」并说明可保留
      typo   → 像手误，报「建议改」
    """
    # 量词重叠：一道一道 / 一片一片 —— 结尾是量词就算合法（开头常是"一/两/几"）
    if unit[0] in _MEASURE_HEADS or unit[-1] in _MEASURE_HEADS:
        return "ok"
    if _VZHE_RE.match(unit + unit):
        return "ok"
    if unit + unit in _IDIOM_REPEAT:
        return "style"
    if unit.startswith(_DEGREE_HEADS):
        return "style"
    # 状态形容词重叠（雪白雪白 / 滚烫滚烫）合法，按构词形态判，不靠枚举
    if _is_state_adj_abab(unit):
        return "ok"
    # 双字动词重叠（打扫打扫 / 收拾收拾）合法：末字是动作语素即可，
    # 白名单 _VERB_ABAB 只作补充，覆盖不全时由这条兜底
    if len(unit) == 2 and unit[1] in _ACTION_TAIL:
        return "ok"
    return "typo"


# 动作语素：作双字词末字时该词多为动词，ABAB 重叠表「尝试/短暂」，合法。
# 「打扫打扫」「商量商量」靠这条放行，不必逐个往白名单里加。
# 只收高置信度的单义动作语素；不收「理/动/作」等既可作名词又极常见的字，
# 否则「苹果苹果」式手误可能被顺带放行。
_ACTION_TAIL = "扫擦洗切揉捏搬抬扛推拉扔抛投递寄买卖算写读念背诵记查验量称修拆装挂贴缝补织染煮炒蒸烤烧炖熬冲泡倒拌叠逛歇聊谈议究析拾核通联忆较计炼备"


def check_repeat(text: str) -> list[dict[str, Any]]:
    """
    检测紧邻重复的词。

    中文的「重叠」有语法功能，不能一律当手误：
      一道一道 / 一片一片   量词重叠，表多而连续     → 不报
      晒着晒着 / 走着走着   V着V着，表持续并产生结果  → 不报
      没事没事 / 不行不行   口语语气反复              → 可选
      很慢很慢 / 特别特别   程度副词重叠表强调        → 可选
      开心开心 / 苹果苹果   形容词/名词误叠，像手误   → 建议改
    """
    issues: list[dict[str, Any]] = []
    for m in _REPEAT_RE.finditer(text):
        unit = m.group(1)
        if len(unit) == 1:
            continue  # AA 式（轻轻、看看）合法
        if m.group(0) in _VERB_ABAB:
            continue  # ABAB 动词重叠合法（研究研究）

        kind = _repeat_kind(unit)
        if kind == "ok":
            continue

        start = m.start()
        excerpt = text[max(0, start - 12) : start + len(unit) * 2 + 12]

        if kind == "style":
            issues.append(
                _issue(
                    "info",
                    f"第 {start + 1}–{start + len(unit) * 2} 字",
                    f"「{unit}{unit}」属于强调式重复",
                    "这类反复在口语和记叙文里很自然，用来加强语气；"
                    "但写正式文稿时读者可能觉得啰嗦",
                    "想保留语气就留着；若追求书面感，可换成"
                    "「格外…」「极…」等程度副词，或加逗号写成「很慢，很慢」",
                    excerpt,
                    pos=start,
                )
            )
        else:
            issues.append(
                _issue(
                    "warning",
                    f"第 {start + 1}–{start + len(unit) * 2} 字",
                    f"词语重复「{unit}{unit}」",
                    "同一个多字词紧邻出现两次，读起来像手误",
                    "删掉一个即可；若确实想强调，改用程度副词或换一种说法",
                    excerpt,
                    pos=start,
                )
            )
    return issues


# ---------------------------------------------------------------- ② 的 / 得 / 地

_DEGREE = "很|非常|太|十分|格外|特别|真|好|极其|相当|越发|更|多"

# 「的 + 程度副词」应为「得」：花开的很鲜艳 → 花开得很鲜艳
_DE_SHOULD_BE_DE = re.compile(rf"的(?=({_DEGREE}))")

_DI_VERBS = "吹跑走说看写笑哭想听吃唱跳飞流落拍打叫喊问答站坐躺爬游升降开关"
_DI_ADVS = (
    "轻轻|慢慢|静静|悄悄|缓缓|默默|仔细|认真|高兴|飞快|迅速|急忙|连忙|"
    "重重|狠狠|紧紧|牢牢|渐渐|突然|忽然|立刻|马上|不断|不停|一个劲"
)
# 「状态副词 + 的 + 动词」应为「地」：风轻轻的吹 → 风轻轻地吹
_DI_RE = re.compile(rf"({_DI_ADVS})的(?=[{re.escape(_DI_VERBS)}])")


def check_de(text: str) -> list[dict[str, Any]]:
    """的 / 得 / 地 误用（只报两种明确误用，正常的「的+名词」不报）"""
    issues: list[dict[str, Any]] = []

    for m in _DE_SHOULD_BE_DE.finditer(text):
        start = m.start()
        after = text[start + 1: start + 8]
        issues.append(
            _issue(
                "warning",
                f"第 {start + 1} 字",
                "「的」应为「得」（程度补语）",
                "动词或形容词后面接「很、非常、十分」这类程度补语时用「得」，不用「的」",
                f"改成「得{after}」",
                text[max(0, start - 10): start + 12],
                pos=start,
            )
        )

    for m in _DI_RE.finditer(text):
        adv = m.group(1)
        at = m.start() + len(adv)
        issues.append(
            _issue(
                "warning",
                f"第 {at + 1} 字",
                "「的」应为「地」（状语）",
                "修饰动词的状语用「地」；「的」只用于修饰名词",
                f"改成「{adv}地」",
                text[max(0, m.start() - 8): m.end() + 8],
                pos=at,
            )
        )
    return issues


# ---------------------------------------------------------------- ②-b 顿号误用

# 「A、B、还有C」：顿号与「还有/以及/和」重复承担并列连接，末尾那个顿号应删。
# 规范写法是「A、B 还有C」或「A、B、C」。这是标点规范问题，纯规则可判。
_DUNHAO_RE = re.compile(r"([\u4e00-\u9fa5]{1,8})、(还有|以及|和|与|及)([\u4e00-\u9fa5]{1,8})")


def check_punctuation(text: str) -> list[dict[str, Any]]:
    """
    标点规范检查。目前覆盖并列连词前的多余顿号。

    「有玫瑰、菊花、还有荷花」→「有玫瑰、菊花还有荷花」
    顿号本身已表并列，再加「还有」就重复了；二者留一个即可。
    """
    issues: list[dict[str, Any]] = []
    for m in _DUNHAO_RE.finditer(text):
        prev, conj, nxt = m.group(1), m.group(2), m.group(3)
        at = m.start() + len(prev)
        issues.append(
            _issue(
                "warning",
                f"第 {at + 1} 字",
                f"顿号与「{conj}」重复表并列",
                "顿号已经表示并列关系，后面再用「还有/以及/和」属于重复连接",
                f"删掉顿号写成「{prev}{conj}{nxt}」，或删掉「{conj}」写成「{prev}、{nxt}」",
                text[max(0, m.start() - 8): m.end() + 8],
                pos=at,
            )
        )
    return issues


# ---------------------------------------------------------------- ③ 错别字

# 只收「一定是错」的高频混淆字，不收有争议的（如「象/像」在旧规范里可通）
TYPOS: dict[str, str] = {
    "脸旁": "脸庞",
    "必竟": "毕竟",
    "竟争": "竞争",
    "安祥": "安详",
    "渡假": "度假",
    "部份": "部分",
    "即然": "既然",
    "以经": "已经",
    "在见": "再见",
    "带替": "代替",
    "报歉": "抱歉",
    "松驰": "松弛",
    "震憾": "震撼",
    "重迭": "重叠",
    "迫不急待": "迫不及待",
    "走头无路": "走投无路",
    "变本加利": "变本加厉",
    "一如继往": "一如既往",
    "不径而走": "不胫而走",
    "默守成规": "墨守成规",
}


def check_typos(text: str) -> list[dict[str, Any]]:
    """高频错别字（封闭词表，只报确定的）"""
    issues: list[dict[str, Any]] = []
    for wrong, right in TYPOS.items():
        for m in re.finditer(re.escape(wrong), text):
            issues.append(
                _issue(
                    "warning",
                    f"第 {m.start() + 1} 字",
                    f"错别字「{wrong}」",
                    f"规范写法是「{right}」",
                    f"「{wrong}」→「{right}」",
                    text[max(0, m.start() - 10): m.end() + 10],
                    pos=m.start(),
                )
            )
    return issues


# ---------------------------------------------------------------- ④ 赘余

# (模式, 建议替换, 原因)。模式里的 \1 表示第一个捕获组
REDUNDANT: list[tuple[str, str, str]] = [
    (r"路上面", "路上", "「路」已含表面义，加「上面」是方位词叠加"),
    (r"家里面", "家里", "「家里」已表处所，不需再加「面」"),
    (r"房间里面", "房间里", "同上"),
    (r"大约(\d+)", r"约\1", "「大约」与「约」同义，择一即可"),
    (r"涉及到", "涉及", "「及」已含到达义，「涉及到」是重复"),
    (r"凯旋归来", "凯旋", "「旋」本就是归来，叠加重复"),
    (r"过分溢美之词", "溢美之词", "「溢美」已含过分义"),
    (r"亲自莅临", "莅临", "「莅临」本身即含敬意与亲自之意"),
]


def _expand(repl: str, m: re.Match[str]) -> str:
    """把建议替换里的 \\1 换成实际捕获内容，只用于展示"""
    out = repl
    for i in range(1, (m.lastindex or 0) + 1):
        out = out.replace(f"\\{i}", m.group(i) or "")
    return out


def check_redundant(text: str) -> list[dict[str, Any]]:
    """语义赘余（封闭模式表，只报高频确定的）"""
    issues: list[dict[str, Any]] = []
    for pat, repl, why in REDUNDANT:
        for m in re.finditer(pat, text):
            issues.append(
                _issue(
                    "info",
                    f"第 {m.start() + 1} 字",
                    f"语义赘余「{m.group(0)}」",
                    why,
                    f"改成「{_expand(repl, m)}」",
                    text[max(0, m.start() - 10): m.end() + 10],
                    pos=m.start(),
                )
            )
    return issues


# ---------------------------------------------------------------- ⑤ 否定—完成矛盾

_NEG = r"(?:不喜欢|不爱吃|不爱|讨厌|不想|不愿|受不了|吃不消)"
_DONE = r"(?:全部|全都|都|一点不剩|通通|统统)\s*(?:吃光|吃完|喝光|喝完|做完|看完|用光|扫光|消灭)"
# 限定在同一句内（中间不出现句末标点）
_CONTRA_RE = re.compile(rf"{_NEG}[^。！？；\n]{{0,40}}{_DONE}")


def check_contradiction(text: str) -> list[dict[str, Any]]:
    """同句内「否定偏好」与「全部完成」并存 → 逻辑矛盾"""
    issues: list[dict[str, Any]] = []
    for m in _CONTRA_RE.finditer(text):
        issues.append(
            _issue(
                "warning",
                f"第 {m.start() + 1}–{m.end()} 字",
                "前后矛盾：既说不喜欢，又说全部吃完",
                "同一句里先否定偏好、再陈述全部完成，读者无法判断真实态度",
                "二者择一：删掉否定的部分，或把「全部吃光」改成「勉强吃了几口」",
                m.group(0)[:80],
                pos=m.start(),
            )
        )
    return issues


# ---------------------------------------------------------------- ⑥ 时间线索（只提示，不断言）

# 负向后视排除「差一点／有一点／这一点／那一点／几点」——
# 这些是数量或疑问，不是时间点，否则「差一点摔倒」会被误报成时间线索。
_TIME_RE = re.compile(
    r"(?:上午|下午|中午|凌晨|傍晚|早上|晚上|夜里)?\s*"
    r"(?<![差有这那几])"
    r"[一二三四五六七八九十两\d]{1,3}\s*点(?:钟)?(?:半|[一二三四五六七八九十\d]{1,2}分)?"
    r"|\d{1,2}[:：]\d{2}"
    # 「提前一个小时」用中文数字，故这里同时接受中文与阿拉伯数字
    r"|(?:提前|推迟|延后|提早)\s*(?:了)?\s*[一二三四五六七八九十两半\d]{1,3}\s*(?:个)?\s*(?:小时|分钟)"
)


def check_time_clues(text: str) -> list[dict[str, Any]]:
    """
    把时间表述全部列出，供人工核对是否自洽。

    为什么不断言矛盾：算「三点提前一小时应是两点、却说到家四点半」
    需要理解「回家」与「到家」是不是同一时点，规则判不准。
    与其误报，不如把线索摆出来让人看 —— 实测样本里这条恰好就是矛盾。
    """
    hits = [m.group(0) for m in _TIME_RE.finditer(text)]
    # 裸「一点」绝大多数是"丝毫"义（一点都不喜欢 / 差一点 / 一点点），不是 1 点钟。
    # 真表时间会带前后缀（一点钟 / 一点半 / 下午一点），所以裸「一点」一律丢弃。
    # 这是本模块「宁可漏报也不误报」原则的直接应用。
    hits = [h for h in hits if h.strip() != "一点"]
    seen: set[str] = set()
    uniq = [h for h in hits if not (h in seen or seen.add(h))]
    if len(uniq) < 2:
        return []
    joined = " ／ ".join(uniq[:8])
    return [
        _issue(
            "info",
            "全文",
            f"出现 {len(uniq)} 处时间表述，请核对是否自洽",
            "涉及「提前／推迟」与多个时间点时容易算错；本检查只列出线索，不判定对错",
            f"逐个核对：{joined}",
            joined,
        )
    ]


# ---------------------------------------------------------------- ⑦ 事实类（需模型）

FACT_CHECK_HINT = (
    "事实性错误（季节、常识、数据真伪）无法用规则判定，需要配置模型 Key 后由模型复核。本次未检查。"
)

FACT_CHECK_DONE_HINT = "事实与常识类问题已由模型复核；模型判断可能有误，请对照原文确认。"
FACT_CHECK_FAIL_HINT = "事实与常识类问题本次未能复核（模型调用失败），规则层结果不受影响。"

# 事实检查的产出上限：模型容易一口气报十几条，其中多数是牵强的推测。
# 记叙文测试集单篇 3–4 处真瑕疵，给 12 条足够，再多必然是噪声。
_FACT_MAX_ISSUES = 12

_FACT_PROMPT = """你是中文作文批改老师。找出下面这段文字里【违反常识或自相矛盾】的地方。

只报这三类：
1. 常识错误：违反基本事实（荷花冬天开、椰子长山上、公交车在铁轨上跑、太阳从东边落下）
2. 前后矛盾：同一段里说法互相冲突（说一点都不喜欢却全部吃光、说很累却一点不想休息）
3. 概念混淆：把甲当成乙（把尾巴说成耳朵、白色的小猫叫小黑）

不要报：错别字、的/地/得、词语重复、标点、语句啰嗦 —— 这些已由其他程序处理。
不要报文采好坏、详略安排、立意深浅 —— 那不是错误。
拿不准的一律不报。宁可少报，不要凑数。

每条必须给出 quote：从原文【逐字复制】的片段（5–20 字），不能改写、不能加标点。
无法逐字引用原文的问题不要报。

只输出 JSON，不要任何解释文字：
{{"issues":[{{"quote":"原文片段","problem":"问题概述（20字内）","why":"为什么错（40字内）","how":"怎么改（40字内）","kind":"常识错误|前后矛盾|概念混淆"}}]}}

没发现问题就输出 {{"issues":[]}}。

待检查文字：
{text}"""


def _parse_fact_json(raw: str) -> list[dict[str, Any]]:
    """
    从模型输出里取出 issues 数组。

    模型可能裹 ```json 代码块、可能带前后说明文字，也可能被 max_tokens 截断。
    复用 llm._balanced_json 找配平对象；截断时退回逐条提取，能救回几条算几条。
    """
    import json as _json

    from .llm import _balanced_json

    candidate = _balanced_json(raw or "")
    if candidate:
        try:
            data = _json.loads(candidate)
            rows = data.get("issues")
            if isinstance(rows, list):
                return [r for r in rows if isinstance(r, dict)]
        except (ValueError, AttributeError):
            pass

    # JSON 被截断：逐个抠出配平的 {...} 子对象，跳过最外层残缺的那个
    out: list[dict[str, Any]] = []
    for m in re.finditer(r"\{", raw or ""):
        seg = _balanced_json((raw or "")[m.start():])
        if not seg:
            continue
        try:
            obj = _json.loads(seg)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("quote"):
            out.append(obj)
    return out


def check_facts(
    text: str,
    model: str | None = None,
    known: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """
    事实 / 常识 / 逻辑矛盾检查 —— 规则判不了，交给模型。

    与规则层的分工：错别字、的地得、重复、标点由规则处理（稳定可复现），
    「荷花冬天开」「白色小猫叫小黑」这类需要常识的只能走模型。

    三道防线，避免模型帮倒忙：
      ① 无凭据直接返回 []（不联网、不产生 mock 垃圾）
      ② quote 必须能在原文里逐字找到 —— 挡掉凭空编造的瑕疵
      ③ 与 known（规则层已报问题）按位置去重 —— 不重复报同一处

    known 传入规则层结果；模型调用失败时返回 []，由调用方给出对应提示。
    """
    from . import llm

    text = (text or "").strip()
    if not text or not llm.has_credentials(model or llm.DEFAULT_MODEL):
        return []

    res = llm.complete(
        [{"role": "user", "content": _FACT_PROMPT.format(text=text[:4000])}],
        model=model,
        temperature=0.1,   # 事实判断要稳定，不要发挥
        max_tokens=1600,   # 12 条 × 约 100 token，留足余量防截断
        allow_mock=False,  # 有 Key 但调用失败时不能拿占位文本当结果
    )
    if not res.ok or not (res.text or "").strip():
        return []

    taken = {i.get("pos") for i in (known or []) if i.get("pos") is not None}
    out: list[dict[str, Any]] = []
    seen_spans: set[int] = set()

    for row in _parse_fact_json(res.text)[:_FACT_MAX_ISSUES * 2]:
        quote = str(row.get("quote") or "").strip()
        problem = str(row.get("problem") or "").strip()
        if not quote or not problem:
            continue
        # 防线②：quote 必须逐字出现在原文。模型常把「河水滚烫滚烫的」
        # 改写成「河水很烫」再报，这种定位不可信，直接丢。
        pos = text.find(quote)
        if pos < 0:
            continue
        # 防线③：与规则层同一位置的问题不重复报
        if pos in taken or pos in seen_spans:
            continue
        seen_spans.add(pos)

        kind = str(row.get("kind") or "常识错误").strip()
        if kind not in ("常识错误", "前后矛盾", "概念混淆"):
            kind = "常识错误"
        out.append(
            _issue(
                "warning",
                f"第 {pos + 1}–{pos + len(quote)} 字",
                f"{kind}：{problem}",
                str(row.get("why") or "").strip() or "与常识或上下文不符",
                str(row.get("how") or "").strip() or "请对照事实修改",
                text[max(0, pos - 12): pos + len(quote) + 12],
                pos=pos,
            )
        )
        if len(out) >= _FACT_MAX_ISSUES:
            break
    return out


# ---------------------------------------------------------------- 汇总

DIM_LABEL = {
    "repeat": "重复",
    "de": "的地得",
    "typo": "错字",
    "redundant": "赘余",
    "logic": "逻辑",
    "time": "时间",
    "punct": "标点",
    "fact": "事实常识",
}


def analyze(text: str, use_model: bool = False, model: str | None = None) -> dict[str, Any]:
    """
    跑全部通用语病检查，按严重级别排序。

    返回结构与 improve.analyze() 兼容（都有 issues / dims / summary / docStats），
    便于前端复用同一套展示组件。

    use_model=True 时追加事实/常识检查（需已配置 Key）。默认 False：
    规则层必须保持离线可复现，自测与批量评测不应因联网而变慢或产生费用。
    """
    text = (text or "").strip()
    if not text:
        return {
            "ok": True, "dims": {}, "issues": [],
            "summary": "没有内容可检查", "docStats": {"blocks": 0, "chars": 0},
        }

    issues: list[dict[str, Any]] = []
    issues += check_repeat(text)
    issues += check_de(text)
    issues += check_punctuation(text)
    issues += check_typos(text)
    issues += check_redundant(text)
    issues += check_contradiction(text)
    issues += check_time_clues(text)

    fact_state = "off"
    if use_model:
        from . import llm

        if not llm.has_credentials(model or llm.DEFAULT_MODEL):
            fact_state = "nokey"
        else:
            facts = check_facts(text, model=model, known=issues)
            # 空结果可能是「真没问题」也可能是「调用失败」，用凭据与返回区分：
            # 有 Key 却一条没有，仍标 done（模型认为无事实错误），失败由 check_facts 内部兜底
            issues += facts
            fact_state = "done"

    issues.sort(key=lambda x: (_ORDER.get(x["level"], 3), x.get("pos") if x.get("pos") is not None else 10**6))

    def pick(kind: str) -> list[dict[str, Any]]:
        return [i for i in issues if kind in i["problem"]]

    groups = {
        "repeat": pick("词语重复"),
        "de": pick("应为「得」") + pick("应为「地」"),
        "typo": pick("错别字"),
        "punct": pick("顿号"),
        "redundant": pick("语义赘余"),
        "logic": pick("前后矛盾"),
        "time": pick("时间表述"),
        "fact": pick("常识错误：") + pick("概念混淆：") + pick("前后矛盾："),
    }

    dims: dict[str, Any] = {}
    for key, group in groups.items():
        top = min((_ORDER.get(i["level"], 3) for i in group), default=None)
        status = {0: "需返工", 1: "建议改进", 2: "小问题"}.get(top, "没问题") if top is not None else "没问题"
        dims[key] = {
            "label": DIM_LABEL[key],
            "status": status,
            "count": len(group),
            "problems": [x["problem"] for x in group],
        }

    if not issues:
        summary = "没有发现语病，用词与句式都通顺。"
    else:
        must = [i for i in issues if i["level"] == "error"]
        head = f"共 {len(issues)} 条语病提示"
        if must:
            head += f"，其中 {len(must)} 条必须处理"
        summary = f"{head}。最需要先看的是：{issues[0]['problem']}。"

    return {
        "ok": True,
        "dims": dims,
        "issues": issues,
        "summary": summary,
        "factCheckHint": FACT_CHECK_DONE_HINT if fact_state == "done" else FACT_CHECK_HINT,
        "factCheckState": fact_state,
        "docStats": {"blocks": 1, "chars": len(text)},
    }


# ---------------------------------------------------------------- 自测

SAMPLE = (
    "昨天下完雨，我骑车去公园，路上面很滑，我差一点就摔倒了，幸好我反应快。"
    "公园里的花开的很鲜艳，有玫瑰、菊花、还有荷花，荷花是冬天开的。"
    "我坐在长椅上看着风景，心里十分开心开心，风轻轻的吹过我的脸旁。"
    "小鸟在树上叫，它们唱着歌，好像在和我打招呼。"
    "本来打算下午三点回家，但是手机没电了，所以我提前一个小时就回去了，到家的时候刚好四点半。"
    "晚饭我吃了米饭配番茄炒鸡蛋，番茄很酸，但是鸡蛋很甜，"
    "我一点都不喜欢吃这个菜，全部吃光了。"
)


def _selftest() -> int:
    """用已知样本验证每条规则都能命中，且合法用法不误报"""
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    print("\n=== 1) 词语重复 ===")
    r = check_repeat("心里十分开心开心，风轻轻吹过")
    check("命中「开心开心」", any("开心开心" in i["problem"] for i in r), str([i["problem"] for i in r]))
    check("不误报 AA 式叠词「轻轻」", not any("轻轻" in i["problem"] for i in r))
    check("不误报「看看」", check_repeat("我想看看这本书") == [])
    check("不误报「妈妈」", check_repeat("妈妈叫我吃饭") == [])
    check("不误报「慢慢」", check_repeat("他慢慢走过去") == [])
    check("不误报 ABAB 式动词「研究研究」", check_repeat("我们再研究研究这个问题") == [])
    check("不误报「商量商量」", check_repeat("大家商量商量") == [])
    check("ABAB 式形容词仍报错", bool(check_repeat("这个地方美丽美丽得很")))

    print("\n=== 2) 的 / 得 / 地 ===")
    r2 = check_de("公园里的花开的很鲜艳")
    check("「花开的很鲜艳」→ 得", any("应为「得」" in i["problem"] for i in r2), str([i["problem"] for i in r2]))
    r3 = check_de("风轻轻的吹过我的脸")
    check("「轻轻的吹」→ 地", any("应为「地」" in i["problem"] for i in r3), str([i["problem"] for i in r3]))
    check("不误报正常的「的+名词」", check_de("我的书包很新") == [])
    check("不误报正确的「得」", check_de("他跑得很快") == [])
    check("不误报正确的「地」", check_de("他慢慢地走") == [])

    print("\n=== 3) 错别字 ===")
    r4 = check_typos("风轻轻的吹过我的脸旁")
    check("「脸旁」→「脸庞」", any("脸旁" in i["problem"] for i in r4), str([i["problem"] for i in r4]))
    check("不误报「脸庞」", check_typos("吹过我的脸庞") == [])
    check("「迫不急待」命中", bool(check_typos("他迫不急待地打开")))

    print("\n=== 4) 赘余 ===")
    r5 = check_redundant("路上面很滑，我差点摔倒")
    check("「路上面」→「路上」", any("路上面" in i["problem"] for i in r5), str([i["problem"] for i in r5]))
    check("不误报「路上」", check_redundant("路上很滑") == [])
    check("「涉及到」命中", bool(check_redundant("此事涉及到多个部门")))
    r5b = check_redundant("大约20人参加")
    check("捕获组替换正确", r5b and "约20" in r5b[0]["how"], r5b[0]["how"] if r5b else "-")

    print("\n=== 5) 否定—完成矛盾 ===")
    r6 = check_contradiction("我一点都不喜欢吃这个菜，全部吃光了")
    check("命中矛盾", len(r6) == 1, str([i["problem"] for i in r6]))
    check("不误报正常句", check_contradiction("我不喜欢吃辣，所以点了清淡的") == [])
    check("不误报跨句", check_contradiction("我不喜欢吃。后来全部吃光了。") == [])

    print("\n=== 6) 时间线索 ===")
    r7 = check_time_clues("本来打算下午三点回家，提前一个小时就回去了，到家刚好四点半")
    check("列出多处时间供核对", len(r7) == 1 and "时间表述" in r7[0]["problem"], str(r7[:1]))
    check("时间点都在提示里", bool(r7) and all(t in r7[0]["how"] for t in ("三点", "四点半")), r7[0]["how"] if r7 else "-")
    check("识别中文数字「提前一个小时」", bool(r7) and "提前一个小时" in r7[0]["how"], r7[0]["how"] if r7 else "-")
    check("单处时间不提示", check_time_clues("我三点回家") == [])
    check("不误报「差一点摔倒」", check_time_clues("路上很滑，我差一点就摔倒了") == [], str(check_time_clues("路上很滑，我差一点就摔倒了")))
    check("不误报「有一点紧张」", check_time_clues("他有一点紧张，但很快平静下来") == [])
    check("不误报单独的「几点」", check_time_clues("你几点到？我等你") == [])
    check("不误报「一点都不喜欢」", check_time_clues("我一点都不喜欢吃这个菜") == [],
          str([i["how"] for i in check_time_clues("我一点都不喜欢吃这个菜")]))
    check("仍识别带前后缀的一点钟", bool(check_time_clues("下午一点钟开会，三点散会")))

    print("\n=== 7) 事实类：无 Key 如实说明，有 Key 防幻觉 ===")
    from unittest.mock import patch as _patch

    from . import llm as _llm

    check("无 Key 时 check_facts 返回空", check_facts("荷花是冬天开的") == [])
    check("给出说明而非假装覆盖", "无法用规则判定" in FACT_CHECK_HINT)
    check("默认不启用模型（analyze 保持离线）", analyze(SAMPLE)["factCheckState"] == "off")

    _t = "公园里有荷花，荷花是冬天开的。我心里十分开心开心。"
    _good = '{"issues":[{"quote":"荷花是冬天开的","problem":"荷花夏季开放","why":"花期在夏季","how":"改成夏天","kind":"常识错误"}]}'
    _fake = '{"issues":[{"quote":"月亮是方的","problem":"形状错","why":"x","how":"y","kind":"常识错误"}]}'
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(True, _good, "fake")):
        check("逐字引用原文的能被采纳", len(check_facts(_t)) == 1)
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(True, _fake, "fake")):
        check("quote 不在原文的幻觉被丢弃", check_facts(_t) == [])
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(True, "```json\n" + _good + "\n```", "fake")):
        check("代码块包裹能解析", len(check_facts(_t)) == 1)
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(True, "我认为写得很好，没有问题。", "fake")):
        check("非 JSON 输出不产生垃圾条目", check_facts(_t) == [])
    # 与规则层同位置去重
    _rep = check_repeat(_t)
    _q = _t[_rep[0]["pos"]: _rep[0]["pos"] + 4]
    _dup = (
        '{"issues":[{"quote":"' + _q + '","problem":"重复","why":"x","how":"y","kind":"前后矛盾"}]}'
    )
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(True, _dup, "fake")):
        check("与规则层同位置不重复报", check_facts(_t, known=_rep) == [])
    with _patch.object(_llm, "has_credentials", return_value=False), \
         _patch.object(_llm, "complete", side_effect=AssertionError("不该联网")) as _m:
        check_facts(_t)
        check("无 Key 时零模型调用", _m.call_count == 0)
    with _patch.object(_llm, "has_credentials", return_value=True), \
         _patch.object(_llm, "complete", return_value=_llm.LlmResult(False, "", "fake", error="HTTP 401")):
        check("模型失败不污染规则层",
              len(analyze(SAMPLE, use_model=True)["issues"]) == len(analyze(SAMPLE)["issues"]))

    print("\n=== 8) 完整样本回归（207 字记叙文）===")
    rep = analyze(SAMPLE)
    got = {i["problem"] for i in rep["issues"]}
    print(f"  共报出 {len(rep['issues'])} 条：")
    for i in rep["issues"]:
        print(f"    [{i['levelLabel']}] {i['where']:14} {i['problem']}")
    check("抓到 词语重复", any("开心开心" in p for p in got))
    check("抓到 的→得", any("应为「得」" in p for p in got))
    check("抓到 的→地", any("应为「地」" in p for p in got))
    check("抓到 错字 脸旁", any("脸旁" in p for p in got))
    check("抓到 赘余 路上面", any("路上面" in p for p in got))
    check("抓到 逻辑矛盾", any("前后矛盾" in p for p in got))
    check("抓到 时间线索", any("时间表述" in p for p in got))
    check("summary 有条数", "条语病提示" in rep["summary"], rep["summary"])
    check("dims 六个维度齐全", set(rep["dims"]) == set(DIM_LABEL))
    levels = [_ORDER.get(i["level"], 3) for i in rep["issues"]]
    check("按级别排序", levels == sorted(levels), str(levels))
    check("每条都有 pos 或标为全文", all(i.get("pos") is not None or i["where"] == "全文" for i in rep["issues"]))

    print("\n=== 9) 空输入与无误报 ===")
    check("空文本不崩", analyze("")["summary"] == "没有内容可检查")
    clean = "秋天到了，山上的树叶变黄了。他每天早晨沿着小路跑步，从不间断。"
    check("干净文本零报告", analyze(clean)["issues"] == [], str([i["problem"] for i in analyze(clean)["issues"]]))

    print(f"\n结果：{'全部通过' if not fails else f'失败 {len(fails)} 项：' + '、'.join(fails)}")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(1 if _selftest() else 0)
