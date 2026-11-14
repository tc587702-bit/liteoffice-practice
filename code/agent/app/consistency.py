"""
一致性检查层：不靠"一个问题一条正则"，而是先建文档模型，再挂通用检查器。

设计（这是"减少改规则成本"的关键）：
    _model(html)   → 统一模型：块、章节、编号序列、数字（值+单位+所在段）、表格
    每个检查器     → 只读模型、不解析 HTML，十几行即可新增一条
    阈值集中       → 统一放在 THRESHOLDS，调参不用翻代码

目前覆盖：
    number_conflict  同一指标出现两个不同数值（3420 张 vs 3204 张）
    heading_gap      一级编号断号或倒序（一、二、四）
    numbering_mixed  同一层级混用「1.」与「（1）」
    duplicate_block  整段重复（相似度 ≥ 0.85）
    table_header     表格首行看着像数据而不是表头
    unit_mixed       货币单位混写（万元 与 元 同段出现）
    percent_no_base  百分比没有分母/基数说明
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from . import docmap
from .tools import split_blocks

THRESHOLDS = {
    "dup_ratio": 0.85,        # 段落相似度阈值
    "dup_min_len": 60,        # 太短的段落不判重复
    "percent_window": 40,     # 百分比前后多少字内要找分母
    "min_number_len": 2,      # 数字至少两位才参与一致性比对
}

CN_NUM = "一二三四五六七八九十"

# 数字 + 单位（公文常见量纲）
NUM_UNIT_RE = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*"
    r"(万平方米|平方米|万亩|亩|万人|人|万户|户|万张|张|万个|个|家|处|所|万元|亿元|元|%|％|百分点)"
)
# 百分比前后找分母线索
BASE_HINT = re.compile(r"占|其中|总数|总人口|老年人总数|合计|分母|基数|个百分点|同比|环比|较上年|相比")
# 表格首行像不像表头：出现这些词就认为是表头
HEADER_HINT = re.compile(r"名称|单位数量|数量|金额|项目|序号|指标|备注|类别|合计|时间|人口|面积|人数|户数|站点数|床位数")


def _model(html: str) -> dict[str, Any]:
    """把文档解析成检查器共用的结构"""
    blocks = split_blocks(html)
    dm = docmap.build(html)

    numbers: list[dict[str, Any]] = []
    for idx, blk in enumerate(blocks):
        if blk.type == "table":
            continue
        for m in NUM_UNIT_RE.finditer(blk.text):
            raw = m.group(1).replace(",", "")
            try:
                value = float(raw)
            except ValueError:
                continue
            numbers.append(
                {
                    "value": value,
                    "raw": m.group(1),
                    "unit": m.group(2),
                    "block": idx,
                    # 指标名：取数字前 6 个汉字作为比对键（去掉"全区/本年"这类前缀）
                    "label": re.sub(
                        r"^(全区|全区共|本年|今年|目前|共计|累计|合计)", "",
                        re.sub(r"[^\u4e00-\u9fa5]", "", blk.text[max(0, m.start() - 10) : m.start()])[-6:],
                    ),
                    "pos": m.start(),
                }
            )

    # 一级编号序列（一、二、三…）
    l1 = re.findall(r"(?m)^\s*([一二三四五六七八九十]+)、", "\n".join(b.text for b in blocks if b.type != "table"))
    # 二级编号格式：1. 与（1）
    dotted = len(re.findall(r"(?m)^\s*\d+[.．]", "\n".join(b.text for b in blocks if b.type != "table")))
    paren = len(re.findall(r"[（(]\d+[）)]", html))

    tables = [b for b in blocks if b.type == "table"]
    return {"blocks": blocks, "dm": dm, "numbers": numbers, "l1": l1, "dotted": dotted, "paren": paren, "tables": tables}


def _issue(level: str, where: str, problem: str, why: str, how: str, block: int | None) -> dict[str, Any]:
    rule_id = re.sub(r"「[^」]*」|\d+", "", problem).strip() or problem
    return {
        "level": level,
        "levelLabel": {"error": "必须改", "warning": "建议改", "info": "可选"}[level],
        "rule": problem,
        "ruleId": rule_id,
        "where": where,
        "problem": problem,
        "why": why,
        "how": how,
        "excerpt": "",
        "block": block,
        "source": "consistency",
    }


# ---------------------------------------------------------------- 检查器

def check_number_conflict(model: dict[str, Any]) -> list[dict[str, Any]]:
    """同一指标在同一份文档里出现两个不同数值"""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in model["numbers"]:
        label = item["label"]
        if len(label) < 2 or item["unit"] in ("%", "％", "百分点"):
            continue
        # 去掉量词前缀，再取末尾 4 字做归并键：
        # "个养老床位" / "养老床位" / "全区养老床位" 都应归到「养老床位」
        key_label = re.sub(r"^(个|处|张|家|万元|亿元|元|人|户|所)", "", label)
        key_label = key_label[-4:]
        groups.setdefault((key_label, item["unit"]), []).append(item)

    issues: list[dict[str, Any]] = []
    for (label, unit), items in groups.items():
        values = {round(i["value"], 2) for i in items}
        if len(values) < 2:
            continue
        first, second = items[0], items[-1]
        issues.append(
            _issue(
                "error",
                f"第 {first['block'] + 1} 段与第 {second['block'] + 1} 段",
                f"「{label}」前后数字不一致",
                f"同一指标出现 {first['raw']}{unit} 与 {second['raw']}{unit} 两个值，读者无法判断哪个为准",
                "核对数据来源，统一为一组口径；若口径不同（如含/不含护理型床位），需在文中分别注明",
                second["block"],
            )
        )
    return issues


def check_heading_gap(model: dict[str, Any]) -> list[dict[str, Any]]:
    """一级编号断号或倒序"""
    nums = model["l1"]
    if len(nums) < 2:
        return []
    idxs = [CN_NUM.index(n) for n in nums if n in CN_NUM]
    if len(idxs) < 2:
        return []

    problems: list[str] = []
    for i in range(1, len(idxs)):
        if idxs[i] == idxs[i - 1]:
            problems.append("重复编号")
        elif idxs[i] < idxs[i - 1]:
            problems.append("编号倒序")
        elif idxs[i] - idxs[i - 1] > 1:
            missing = "".join(CN_NUM[j] for j in range(idxs[i - 1] + 1, idxs[i]))
            problems.append(f"缺「{missing}」")

    if not problems:
        return []
    seq = "、".join(nums[:8])
    first_block = None
    for idx, b in enumerate(model["blocks"]):
        if b.type != "table" and re.match(r"^\s*[一二三四五六七八九十]+、", b.text):
            first_block = idx
            break
    return [
        _issue(
            "warning",
            "整体结构",
            f"一级编号有问题：{'；'.join(dict.fromkeys(problems))}",
            f"识别到的编号顺序为 {seq}，公文要求连续且升序",
            "按一、二、三重新排序并补齐缺失章节；若确实删过章节，后面的编号要跟着改",
            first_block,
        )
    ]


def check_numbering_mixed(model: dict[str, Any]) -> list[dict[str, Any]]:
    """同一层级混用 1. 与（1）"""
    if model["dotted"] >= 2 and model["paren"] >= 2:
        return [
            _issue(
                "info",
                "整体结构",
                "编号格式混用",
                f"文中同时出现「1.」×{model['dotted']} 与「（1）」×{model['paren']}，层级关系容易看错",
                "同一层级只用一种写法：一级用「一、」，二级用「（一）」，三级用「1.」",
                0,
            )
        ]
    return []


def check_duplicate_block(model: dict[str, Any]) -> list[dict[str, Any]]:
    """整段重复"""
    blocks = [b for b in model["blocks"] if b.type != "table" and len(b.text) >= THRESHOLDS["dup_min_len"]]
    issues: list[dict[str, Any]] = []
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            a, b = blocks[i].text, blocks[j].text
            # 完全相同的前 40 字 → 视为复制（覆盖"长段 + 短段"这种常见情况）
            head_same = len(a) >= 40 and len(b) >= 40 and a[:40] == b[:40]
            ratio = 1.0 if head_same else SequenceMatcher(None, a, b).ratio()
            if head_same or (abs(len(a) - len(b)) <= max(len(a), len(b)) * 0.5 and ratio >= THRESHOLDS["dup_ratio"]):
                idx = model["blocks"].index(blocks[j])
                issues.append(
                    _issue(
                        "warning",
                        f"第 {idx + 1} 段",
                        "整段与前面重复",
                        f"与前面某段相似度 {ratio:.0%}，像是复制后忘删",
                        "保留信息更全的一段，另一段删除或改写成不同角度",
                        idx,
                    )
                )
    return issues[:2]


def check_table_header(model: dict[str, Any]) -> list[dict[str, Any]]:
    """表格首行像数据而不是表头"""
    issues: list[dict[str, Any]] = []
    for tbl in model["tables"]:
        idx = model["blocks"].index(tbl)
        # 表格纯文本是拼接的（没有分隔符），必须回到 HTML 里按单元格取首行
        rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", getattr(tbl, "html", "") or "", re.IGNORECASE)
        if not rows:
            continue
        cells = [
            re.sub(r"<[^>]+>", "", c).strip()
            for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", rows[0], re.IGNORECASE)
        ]
        cells = [c for c in cells if c]
        if not cells:
            continue
        has_hint = any(HEADER_HINT.search(c) for c in cells)
        mostly_number = sum(1 for c in cells if re.fullmatch(r"[\d.,%％]+", c)) >= max(1, len(cells) // 2)
        if mostly_number and not has_hint:
            issues.append(
                _issue(
                    "warning",
                    f"第 {idx + 1} 段（表格）",
                    "表格首行不是表头",
                    "首行是数据而不是列名，读者不知道每列代表什么",
                    "把列名（如「街道 / 站点数 / 床位数」）放到第一行，数据从第二行开始",
                    idx,
                )
            )
    return issues


def check_unit_mixed(model: dict[str, Any]) -> list[dict[str, Any]]:
    """同段货币单位混写（万元 与 元）"""
    issues: list[dict[str, Any]] = []
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        units = [i["unit"] for i in model["numbers"] if i["block"] == idx]
        money = {u for u in units if u in ("元", "万元", "亿元")}
        if len(money) >= 2:
            issues.append(
                _issue(
                    "info",
                    f"第 {idx + 1} 段",
                    "同一段混用货币单位",
                    f"这段同时出现 {'、'.join(sorted(money))}，读者需要自己换算",
                    "统一成一种单位（公文常用「万元」），或加括号注明换算关系",
                    idx,
                )
            )
    return issues[:2]


def check_percent_base(model: dict[str, Any]) -> list[dict[str, Any]]:
    """百分比没有分母/基数说明"""
    issues: list[dict[str, Any]] = []
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        for m in re.finditer(r"(\d+(?:\.\d+)?)\s*[%％]", blk.text):
            around = blk.text[max(0, m.start() - THRESHOLDS["percent_window"]) : m.end() + THRESHOLDS["percent_window"]]
            if BASE_HINT.search(around):
                continue
            issues.append(
                _issue(
                    "info",
                    f"第 {idx + 1} 段",
                    "百分比没有分母",
                    f"「{m.group(0)}」前后没有说明占什么的比例，读者无法判断口径",
                    "补上基数，例如「占全区老年人口的 85%」「较上年提升 5 个百分点」",
                    idx,
                )
            )
            break
    return issues[:2]


# ---------------------------------------------------------------- 第二批检查器

# 裸数字（无单位）也要参与"前后矛盾"比对：
# 「检查企业 3682」与「规模以上企业 3510 家」是同一指标，若只比对带单位的数字就会漏。
_BARE_NUM_RE = re.compile(r"(\d{2,}(?:\.\d+)?)")


def check_bare_number_conflict(model: dict[str, Any]) -> list[dict[str, Any]]:
    """同一指标：一处带单位、一处裸数字，也可能矛盾"""
    groups: dict[str, list[dict[str, Any]]] = {}
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        for m in _BARE_NUM_RE.finditer(blk.text):
            tail = blk.text[m.end() : m.end() + 3].lstrip()
            if tail[:1] in "%％" or re.match(r"[.、）)]", tail):
                continue
            if re.match(r"(万平方米|平方米|万人|万户|万元|亿元|万张|个|人|户|张|家|处|所|亩|元)", tail):
                continue  # 带单位的交给 check_number_conflict
            label = re.sub(r"[^\u4e00-\u9fa5]", "", blk.text[max(0, m.start() - 10) : m.start()])[-4:]
            if len(label) < 2:
                continue
            groups.setdefault(label, []).append({"raw": m.group(1), "block": idx})

    issues: list[dict[str, Any]] = []
    for label, items in groups.items():
        values = {i["raw"] for i in items}
        if len(values) < 2:
            continue
        first, last = items[0], items[-1]
        issues.append(
            _issue(
                "warning",
                f"第 {first['block'] + 1} 段与第 {last['block'] + 1} 段",
                f"「{label}」数字可能不一致",
                f"同一处出现 {first['raw']} 与 {last['raw']}，其中一个还没带单位，读者无法核对",
                "统一口径并给数字补上单位；若确实是两个不同指标，请把指标名写清楚",
                last["block"],
            )
        )
    return issues[:2]


# 时间线矛盾：句子里同时出现两个年份，且拿前一年的节点去完成后一年度的任务
_YEAR = r"(20\d{2})"
_TIMELINE_RE = re.compile(rf"{_YEAR}\s*年[^。；]{{0,20}}(完成|开展|实现|启动)[^。；]{{0,20}}{_YEAR}\s*年度")


def check_timeline(model: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        for m in _TIMELINE_RE.finditer(blk.text):
            y1, y2 = int(m.group(1)), int(m.group(3))
            if y1 < y2:
                issues.append(
                    _issue(
                        "warning",
                        f"第 {idx + 1} 段",
                        "时间线矛盾",
                        f"要用 {y1} 年的节点完成 {y2} 年度任务，逻辑上说不通",
                        "把年份与任务年度对齐，或改成「提前启动」这类表述",
                        idx,
                    )
                )
                break
    return issues


def check_attachment(model: dict[str, Any]) -> list[dict[str, Any]]:
    """正文提到"附件 N"但文末没有附件说明"""
    full = "\n".join(b.text for b in model["blocks"] if b.type != "table")
    refs = re.findall(r"附件\s*[0-9一二三四五六七八九十]+", full)
    if not refs:
        return []
    tail = full[-200:]
    has_list = bool(re.search(r"(附[件表]\s*[:：]|附件[0-9一二三四五六七八九十]+\s*[：:])", tail))
    if has_list:
        return []
    last_block = max(0, len(model["blocks"]) - 1)
    return [
        _issue(
            "info",
            "文末",
            "正文引用了附件，但文末没有附件说明",
            f"文中出现 {refs[0]}，读者找不到对应附件",
            "在文末补「附件：1.××台账 2.××清单」，或删掉正文里的附件引用",
            last_block,
        )
    ]


_ORG_RE = re.compile(r"[\u4e00-\u9fa5]{2,5}(?:局|委|办|中心)")


def check_org_name(model: dict[str, Any]) -> list[dict[str, Any]]:
    """同一机构出现两种简称（应急局 / 应急管理局）"""
    names: dict[str, set[str]] = {}
    blocks_by_name: dict[str, int] = {}
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        for m in _ORG_RE.finditer(blk.text):
            name = m.group(0)
            key = name[:2]
            names.setdefault(key, set()).add(name)
            blocks_by_name.setdefault(name, idx)

    issues: list[dict[str, Any]] = []
    for key, variants in names.items():
        if len(variants) < 2:
            continue
        # 过滤掉"同前缀但确实是不同机构"的情况：只报一个是另一个的子串
        pair = sorted(variants, key=len)
        for i in range(len(pair)):
            for j in range(i + 1, len(pair)):
                if pair[i] in pair[j] and len(pair[i]) >= 3:
                    idx = blocks_by_name.get(pair[j], blocks_by_name.get(pair[i], 0))
                    issues.append(
                        _issue(
                            "info",
                            f"第 {idx + 1} 段",
                            f"机构名称前后不一致（{pair[i]} / {pair[j]}）",
                            "同一个机构出现两种写法，公文中应统一使用全称或规范的简称",
                            "首次出现用全称并注明简称（如「区应急管理局（以下简称区应急局）」），后文统一",
                            idx,
                        )
                    )
                    break
            if issues:
                break
        if issues:
            break
    return issues


# 同一天内的时间顺序（数字越大越晚）
_DAY_ORDER = {
    "凌晨": 0, "清晨": 1, "早晨": 1, "早上": 1, "上午": 2, "中午": 3,
    "午后": 4, "下午": 4, "傍晚": 5, "晚上": 6, "半夜": 7, "深夜": 7,
}
# 这些词出现说明跨了一天，时间顺序重新开始
_NEW_DAY = re.compile(r"第二天|次日|翌日|第三天|几天后|一周后|回家那天|开学")
# 这些词说明是回忆/插叙，不参与顺序判断
_FLASHBACK = re.compile(r"记得|回忆|那时候|那年|当年|小时候|从前|以前|前一天|昨夜|前一天晚上")


def check_narrative_timeline(model: dict[str, Any]) -> list[dict[str, Any]]:
    """
    记叙文的时间线倒序检查。

    只在"同一段内、且没有插叙/跨日标记"的情况下判断：
      · 段落里先写下午、再写早上 → 可疑
      · 出现"记得/那年" → 视为插叙，跳过
      · 出现"第二天/几天后" → 跨日，重新计时
    这样不会把正常的倒叙写法误判成错误。
    """
    issues: list[dict[str, Any]] = []
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        text = blk.text
        # 整段是回忆 → 跳过
        if _FLASHBACK.search(text[:30]):
            continue

        # 按出现顺序收集（时间段, 词）
        found: list[tuple[int, str, int]] = []
        for m in re.finditer("|".join(_DAY_ORDER), text):
            found.append((m.start(), m.group(0), _DAY_ORDER[m.group(0)]))
        if len(found) < 2:
            continue

        for i in range(1, len(found)):
            prev_pos, prev_word, prev_rank = found[i - 1]
            pos, word, rank = found[i]
            between = text[prev_pos:pos]
            if _NEW_DAY.search(between) or _FLASHBACK.search(between):
                continue  # 跨日或插叙
            if rank < prev_rank:
                issues.append(
                    _issue(
                        "warning",
                        f"第 {idx + 1} 段",
                        f"时间顺序倒了（{prev_word} → {word}）",
                        "同一段里后写的时间比前面早，读者会以为时间倒流",
                        "调整叙述顺序；若是回忆，加「记得」「那天早些时候」这类提示词",
                        idx,
                    )
                )
                break
    return issues


# 常见反义/矛盾描述对（同句共现时多半是笔误或前后矛盾）
ANTONYM_PAIRS = [
    ("亮", "暗"), ("亮", "黑"), ("明亮", "昏暗"),
    ("满", "空"), ("坐满", "空位"), ("拥挤", "空荡"),
    ("热", "冷"), ("热", "凉"), ("滚烫", "冰凉"), ("烫", "凉"),
    ("枯萎", "茂盛"), ("凋谢", "盛开"), ("死亡", "茂盛"),
    ("干燥", "潮湿"), ("晴天", "下雨"),
    ("增加", "减少"), ("上升", "下降"), ("提高", "降低"),
    ("成功", "失败"), ("顺利", "失败"), ("完整", "破碎"),
    ("安静", "吵闹"), ("安静", "响亮"), ("寂静", "喧闹"),
    ("喜欢", "讨厌"), ("开心", "难过"), ("高兴", "伤心"),
    ("开始", "结束"), ("出生", "去世"),
    ("白天", "夜晚"), ("白天", "深夜"), ("中午", "深夜"),
    ("东边", "西边"), ("南边", "北边"),
]

# 感叹/程度副词后接"反义"形容词时，最容易出现"又…又…"式自相矛盾
_SENT_SPLIT = re.compile(r"[。！？；\n]")


def check_antonym_conflict(model: dict[str, Any]) -> list[dict[str, Any]]:
    """
    同一句里同时出现相反描述。

    例：「彩灯亮晶晶，灯光黑乎乎」「声音安静又响亮」「冰棍越吃越烫」
    只报 info（可选）：反义词共现有可能是刻意的对比写法，需要人判断。
    """
    issues: list[dict[str, Any]] = []
    for idx, blk in enumerate(model["blocks"]):
        if blk.type == "table":
            continue
        for sent in _SENT_SPLIT.split(blk.text):
            s = sent.strip()
            if len(s) < 6:
                continue
            hit: tuple[str, str] | None = None
            for a, b in ANTONYM_PAIRS:
                if a in s and b in s:
                    # 排除"从…到…"这类正常表述
                    if re.search(rf"从.{0,4}{re.escape(a)}.{0,4}到.{0,4}{re.escape(b)}", s):
                        continue
                    if re.search(rf"先.{0,6}{re.escape(a)}.{0,6}(再|后).{0,4}{re.escape(b)}", s):
                        continue
                    hit = (a, b)
                    break
            if hit:
                issues.append(
                    _issue(
                        "info",
                        f"第 {idx + 1} 段",
                        f"同一句里出现相反描述（{hit[0]} / {hit[1]}）",
                        f"「{s[:24]}…」里同时写了 {hit[0]} 和 {hit[1]}，读者会以为写错了",
                        "确认是否为笔误；若想对比，用「先是…随后…」把时间顺序写清楚",
                        idx,
                    )
                )
                break
    return issues[:3]


CHECKS = (
    check_number_conflict,
    check_bare_number_conflict,
    check_heading_gap,
    check_numbering_mixed,
    check_duplicate_block,
    check_table_header,
    check_unit_mixed,
    check_percent_base,
    check_timeline,
    check_attachment,
    check_org_name,
)

# 只在记叙文类文体里跑的检查器
NARRATIVE_CHECKS = (check_narrative_timeline, check_antonym_conflict)


def analyze(html: str, genre: str | None = None) -> list[dict[str, Any]]:
    """
    跑一致性检查。

    genre 为记叙文类（essay_narr 等）时，改用 NARRATIVE_CHECKS：
    记叙文没有编号体系与公文抬头，套公文检查只会产生噪音。
    """
    _failed: list[str] = []
    model = _model(html)
    is_narrative = (genre or "").startswith("essay") or genre in ("expository",)
    checks = NARRATIVE_CHECKS if is_narrative else CHECKS
    issues: list[dict[str, Any]] = []
    for check in checks:
        try:
            issues.extend(check(model))
        except Exception:  # noqa: BLE001 单个检查器抛错不应影响其它检查
            # 记下是哪个检查器失败：出问题时能定位，而不是静默跳过
            _failed.append(check.__name__)
    # 同一问题重复出现（例如整段重复时两段各报一次）只留第一条
    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for it in issues:
        if it["problem"] in seen:
            continue
        seen.add(it["problem"])
        uniq.append(it)

    if _failed:
        issues.insert(0, _issue(
            "info", "全文", f"{len(_failed)} 个检查器未执行完成",
            "检查器内部异常，本次结果可能不完整", "记录日志后重试；若持续出现请反馈", None,
        ))

    order = {"error": 0, "warning": 1, "info": 2}
    uniq.sort(key=lambda x: (order.get(x["level"], 3), x["block"] is None))
    return uniq
