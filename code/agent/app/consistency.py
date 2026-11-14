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
        rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", getattr(tbl, "html", "") or "", re.I)
        if not rows:
            continue
        cells = [
            re.sub(r"<[^>]+>", "", c).strip()
            for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", rows[0], re.I)
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


CHECKS = (
    check_number_conflict,
    check_heading_gap,
    check_numbering_mixed,
    check_duplicate_block,
    check_table_header,
    check_unit_mixed,
    check_percent_base,
)


def analyze(html: str) -> list[dict[str, Any]]:
    """跑全部一致性检查；返回按严重程度排序的问题（无跳转的排后面）"""
    model = _model(html)
    issues: list[dict[str, Any]] = []
    for check in CHECKS:
        try:
            issues.extend(check(model))
        except Exception:  # noqa: BLE001 单个检查器抛错不应影响其它检查
            continue
    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda x: (order.get(x["level"], 3), x["block"] is None))
    return issues
