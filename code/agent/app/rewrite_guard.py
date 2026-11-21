"""
改写护栏：四道确定性校验，拦住模型擅自增删内容。

设计要点（对应任务书第四节）：
  ② 可枚举内容保留  数字/日期/引号内容必须全部保留，且不得凭空新增
  ③ 幅度校验        比例超 20% 或绝对字符差超 30，任一成立即拦
  ④ 新增实词校验    out 有、base 没有的中文 2-gram（剥掉允许替换的词）非空即拦
  ① 提示约束        prompt 里写明，但只作为第一层，不作为唯一防线

为什么必须有 ④：
  事故用例里模型加的「车轮一打滑」不含数字、不带引号、只占 2.9% 长度，
  ② 和 ③ 都放行。只有 2-gram 差异能抓到这类"纯叙述句添加"。

基线一律用 base = 规则修正后的文本（不是 selection）：
  规则层会合法删字（「涉及到」→「涉及」），拿原文当基线会把这类正常修改误判成"内容丢失"。
"""
from __future__ import annotations

import re
from typing import Any

# ② 可枚举内容
_CN_DIGIT = "〇零一二三四五六七八九十百千万两"
# 阿拉伯数字整体；中文数字只认 2 字以上（三十、二十），避免把「十分」的「十」当数字
_NUM_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?|[一二三四五六七八九十百千万两]{2,}")
_DATE_RE = re.compile(
    # 年月日
    r"\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日"
    r"|[一二三四五六七八九十两]{2,3}\s*[年月日]"
    # 时刻：必须带时段前缀（下午三点），或写成两位数字（十二点）
    # 「差一点」「有点」里的"一点"不是时间，不能被当成时间比对，
    # 否则「差一点摔倒 → 险些摔倒」这种正常改写会被判成"时间被改动"。
    r"|(?:上午|下午|中午|晚上|早上|凌晨|傍晚|半夜|夜里)\s*[一二三四五六七八九十两\d]{1,3}\s*[点时]"
    r"|[一二三四五六七八九十两]{2,3}\s*[点时]"
    r"|\d{1,2}\s*[点时]"
    r"|\d{1,2}\s*分"
    # 单个中文数字 + 点（"三点开始"）也算时间，但排除"差一点/有点/一点点"这类副词
    r"|(?<![差有这那么一多好])[一二三四五六七八九十]{1,3}\s*[点时]"
)
_QUOTE_RE = re.compile(r"「([^」]{1,40})」|“([^”]{1,40})”|『([^』]{1,40})』|\"([^\"]{1,40})\"")

# ④ 允许的润色替换：程度副词、常见同义形容词/动词、纯虚词
_ALLOWED_WORDS = [
    "十分", "非常", "格外", "极其", "极为", "特别", "相当", "略微", "稍稍",
    "更加", "愈发", "越发", "分外", "无比", "异常", "格外地", "尤为",
    "喜悦", "高兴", "开心", "愉快", "欢欣", "快活", "舒畅",
    "美丽", "漂亮", "好看", "秀美", "优美", "绚丽",
    "迅速", "快速", "飞快", "急速", "迅捷",
    "寂静", "安静", "宁静", "静谧", "恬静", "幽静",
    "慢慢", "缓缓", "徐徐", "渐渐", "逐渐",
    "立即", "立刻", "马上", "即刻", "顿时", "随即",
    "突然", "忽然", "猛地", "骤然", "忽然间",
    "轻轻", "悄悄", "静静", "默默", "偷偷", "缓缓地",
]
_PARTICLES = set("的地得了着过而却便就又也还才正在把被给让和与及或很太更最颇")

THRESHOLDS = {
    "ratio": 0.20,
    "abs": 30,
    "min_change_len": 2,   # 增/删 2 字以上才判定为内容变化（1 字的「到」属于合法删减）
}


def _grams(text: str) -> set[str]:
    flat = re.sub(r"[^\u4e00-\u9fa5]", "", text or "")
    return {flat[i : i + 2] for i in range(len(flat) - 1)}


def _enumerable(text: str) -> dict[str, set[str]]:
    quotes: set[str] = set()
    for m in _QUOTE_RE.finditer(text or ""):
        inner = next((g for g in m.groups() if g), "")
        if inner:
            quotes.add(inner.strip())
    return {
        "numbers": set(_NUM_RE.findall(text or "")),
        "dates": {x.replace(" ", "") for x in _DATE_RE.findall(text or "")},
        "quotes": quotes,
    }


def _segment_by_allowed(seg: str) -> bool:
    """这一段能否完全由「允许替换的词」拼出来（格外喜悦 → 格外 + 喜悦）"""
    if not seg:
        return True
    for word in sorted(_ALLOWED_WORDS, key=len, reverse=True):
        if seg.startswith(word) and _segment_by_allowed(seg[len(word) :]):
            return True
    return all(ch in _PARTICLES for ch in seg)


def _content_changes(base: str, out: str) -> list[dict[str, str]]:
    """
    字符级 diff：找出「新增」与「删除」的内容段。

    为什么不用 2-gram 集合：词边界会切出「外喜」「里格」这种假新增，
    真正需要抓的是「车轮一打滑」这种整段插入。
    """
    from difflib import SequenceMatcher

    blocked: list[dict[str, str]] = []
    added: list[str] = []
    removed: list[str] = []
    min_len = THRESHOLDS["min_change_len"]

    for tag, i1, i2, j1, j2 in SequenceMatcher(None, base, out, autojunk=False).get_opcodes():
        if tag == "insert":
            seg = out[j1:j2]
            if len(seg) >= min_len and not _segment_by_allowed(seg):
                added.append(seg)
        elif tag == "delete":
            seg = base[i1:i2]
            if len(seg) >= min_len and not _segment_by_allowed(seg):
                removed.append(seg)

    if added:
        blocked.append({"rule": "novel_content", "detail": "检测到原文没有的内容：" + "、".join(added[:3])})
    if removed:
        blocked.append({"rule": "content_loss", "detail": "原文内容被删掉：" + "、".join(removed[:3])})
    return blocked


def check(base: str, out: str) -> dict[str, Any]:
    """跑四道护栏（①提示在 prompt 里，这里检查 ②③④）"""
    base = (base or "").strip()
    out = (out or "").strip()
    blocked: list[dict[str, str]] = []

    if not out:
        return {"ok": False, "blocked": [{"rule": "empty", "detail": "模型返回空内容"}]}

    # ② 可枚举内容
    b_enum, o_enum = _enumerable(base), _enumerable(out)
    for key, label in (("numbers", "数字"), ("dates", "日期/时间"), ("quotes", "引号内容")):
        lost = b_enum[key] - o_enum[key]
        if lost:
            blocked.append({"rule": "enumerable", "detail": f"{label}被改动或丢失：{'、'.join(sorted(lost)[:5])}"})
        added_enum = o_enum[key] - b_enum[key]
        if added_enum:
            blocked.append({"rule": "enumerable", "detail": f"{label}凭空新增：{'、'.join(sorted(added_enum)[:5])}"})

    # ③ 幅度
    diff = abs(len(out) - len(base))
    ratio = diff / max(1, len(base))
    if ratio > THRESHOLDS["ratio"] or diff > THRESHOLDS["abs"]:
        blocked.append(
            {
                "rule": "magnitude",
                "detail": f"改动幅度过大（{diff} 字，{ratio:.0%}；上限 {THRESHOLDS['abs']} 字或 {THRESHOLDS['ratio']:.0%}）",
            }
        )

    # ④ 增删内容
    blocked.extend(_content_changes(base, out))

    # ⑤ 语义骨架：否定/主体/时态/情感极性。
    #
    # 规范修正同样不许改义，但这四类字数几乎不变、字符 diff 抓不到：
    # 实测「我坐在长椅上」→「他坐在长椅上」曾被本护栏放行。
    # 复用润色护栏的实现，避免两套标准对「什么算改事实」产生分歧。
    from .polish_guard import _skeleton_changes

    blocked.extend(_skeleton_changes(base, out))

    return {"ok": not blocked, "blocked": blocked}
