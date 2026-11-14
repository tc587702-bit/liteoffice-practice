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
    return "typo"


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


def check_facts(text: str) -> list[dict[str, Any]]:
    """
    事实性错误（如「荷花是冬天开的」）无法用规则判定 —— 需要常识知识。

    返回空并配 FACT_CHECK_HINT 说明原因，避免给调用方「已覆盖事实检查」的错觉。
    """
    return []


# ---------------------------------------------------------------- 汇总

DIM_LABEL = {
    "repeat": "重复",
    "de": "的地得",
    "typo": "错字",
    "redundant": "赘余",
    "logic": "逻辑",
    "time": "时间",
}


def analyze(text: str) -> dict[str, Any]:
    """
    跑全部通用语病检查，按严重级别排序。

    返回结构与 improve.analyze() 兼容（都有 issues / dims / summary / docStats），
    便于前端复用同一套展示组件。
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
    issues += check_typos(text)
    issues += check_redundant(text)
    issues += check_contradiction(text)
    issues += check_time_clues(text)
    issues.sort(key=lambda x: (_ORDER.get(x["level"], 3), x.get("pos") if x.get("pos") is not None else 10**6))

    def pick(kind: str) -> list[dict[str, Any]]:
        return [i for i in issues if kind in i["problem"]]

    groups = {
        "repeat": pick("词语重复"),
        "de": pick("应为「得」") + pick("应为「地」"),
        "typo": pick("错别字"),
        "redundant": pick("语义赘余"),
        "logic": pick("前后矛盾"),
        "time": pick("时间表述"),
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
        "factCheckHint": FACT_CHECK_HINT,
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

    print("\n=== 7) 事实类如实说明不覆盖 ===")
    check("check_facts 返回空", check_facts("荷花是冬天开的") == [])
    check("给出说明而非假装覆盖", "无法用规则判定" in FACT_CHECK_HINT)

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
