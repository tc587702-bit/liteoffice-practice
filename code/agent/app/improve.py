"""
文档优化建议：指出「哪里需要改」和「该怎么改」

设计：
  1. 纯规则打分，不依赖模型（离线可用、结果稳定、可解释）
  2. 四类检查：结构 / 数据 / 表达 / 规范
  3. 每条问题都给：位置（第几节第几段）+ 原文摘录 + 为什么 + 怎么改
  4. 可选模式：传 model=True 时，让模型为前 3 条问题生成改写示例

对外：
    analyze(html, use_model=False) -> {score, dims, issues, summary}
"""
from __future__ import annotations

import re
from typing import Any

from . import docmap
from .tools import split_blocks, strip_tags

# ---------------- 词表 ----------------

COLLOQUIAL = [
    "我们认为", "我觉得", "还行", "差不多", "大概", "可能吧", "比较好",
    "很多", "不少", "一些", "什么的", "等等等", "反正", "其实",
]

STRUCTURE_NEEDS = {
    "现状": ["基本情况", "现状", "当前情况", "工作开展", "总体情况", "主要内容", "主要依据"],
    "问题": ["存在问题", "风险", "不足", "困难"],
    "措施": ["下一步", "工作打算", "建议", "措施", "整改", "计划"],
}

# 文种 → 各部分的权重要求（10 = 必须有，6 = 建议有，0 = 不要求）
DOC_TYPE_RULES = {
    "汇报": {"现状": 10, "问题": 6, "措施": 10},
    "方案": {"现状": 6, "问题": 6, "措施": 10},
    "通知": {"现状": 0, "问题": 0, "措施": 6},
    "纪要": {"现状": 6, "问题": 0, "措施": 10},
    "其他": {"现状": 10, "问题": 6, "措施": 10},
}


def detect_doc_type(text: str) -> str:
    """从标题判断文种（只看前 200 字）"""
    head = text[:200]
    if "汇报" in head or "报告" in head:
        return "汇报"
    if "实施方案" in head or "方案" in head:
        return "方案"
    if "通知" in head:
        return "通知"
    if "纪要" in head:
        return "纪要"
    return "其他"

# 百分比/数字的口径提示词
TIME_HINT = re.compile(r"截至|目前|当前|今年|本年度|202\d年|本季度|上半年|年底")
PERCENT_RE = re.compile(r"\d+(?:\.\d+)?\s*%")
NUMBER_UNIT_RE = re.compile(r"\d+(?:\.\d+)?\s*(万|亿|千)?\s*(平方米|㎡|人|户|万元|亿元|元|个|套|公里|千米|吨|亩|件|项)")


# ---------------- 检查项 ----------------

def _issue(
    level: str,
    where: str,
    problem: str,
    why: str,
    how: str,
    excerpt: str = "",
    block: int | None = None,
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
    }


def _locate(html: str, block_index: int) -> str:
    """把块号翻译成「第X节 第Y段」"""
    dm = docmap.build(html)
    section = None
    for s in dm.sections:
        if s.block_start <= block_index <= s.block_end:
            section = s
    if section:
        return f"「{section.title[:20]}」内"
    return f"第 {block_index + 1} 段"


def check_structure(html: str) -> tuple[int, list[dict]]:
    dm = docmap.build(html)
    titles = " ".join(s.title for s in dm.sections)
    body = strip_tags(html)
    score = 0
    issues: list[dict] = []

    doc_type = detect_doc_type(body)
    weights = DOC_TYPE_RULES[doc_type]

    # 强信号：出现在全文里也算（如正文中间写了"二、存在问题"）
    STRONG = {
        "现状": ["基本情况", "总体情况", "工作开展情况"],
        "问题": ["存在问题", "主要问题", "存在问题及原因"],
        "措施": ["下一步", "工作打算", "下步工作", "保障措施"],
    }

    for name, words in STRUCTURE_NEEDS.items():
        need = weights.get(name, 0)
        if need == 0:
            continue
        found = any(w in titles for w in words) or any(w in body for w in STRONG.get(name, []))
        if found:
            score += need
        else:
            issues.append(
                _issue(
                    "error" if need >= 10 and name != "问题" else "warning",
                    "整体结构",
                    f"缺少「{name}」部分",
                    "汇报/方案类公文的标准结构是：基本情况 → 存在问题 → 下一步措施；缺一段会让读者觉得不完整",
                    {
                        "现状": "补一节「一、基本情况」，用 3–5 条数据说明当前进展",
                        "问题": "补一节「二、存在问题」，列出 2–4 条具体问题（带数据）",
                        "措施": "补一节「三、下一步措施」，每条对应上面的问题，写清责任与时限",
                    }[name],
                )
            )

    # 编号连续
    if dm.sections:
        nums = [s.number for s in dm.sections if s.number]
        levels = [s.level for s in dm.sections]
        if levels and max(levels) - min(levels) > 1:
            issues.append(
                _issue(
                    "warning",
                    "整体结构",
                    "标题层级跳级",
                    "一、下面直接出现 1.（缺（一）这一层），层级不连贯",
                    "把中间层补齐，或把 1. 改成（一）",
                )
            )
        if len(nums) >= 2 and len(set(nums)) < len(nums) - 1:
            issues.append(
                _issue(
                    "info",
                    "整体结构",
                    "编号重复或断号",
                    f"识别到的编号为：{', '.join(nums[:8])}",
                    "检查是否漏号（如一、二、四）或重复编号",
                )
            )
    return min(score, 30), issues


def check_data(html: str) -> tuple[int, list[dict]]:
    text = strip_tags(html)
    score = 0
    issues: list[dict] = []

    # 只要"像数量"的数字：两位以上整数或带小数（排除 1. 2. 这类列表编号）
    numbers = [n for n in re.findall(r"\d+(?:\.\d+)?", text) if len(n) >= 2 or "." in n]
    with_unit = NUMBER_UNIT_RE.findall(text)
    if numbers:
        ratio = len(with_unit) / max(1, len(numbers))
        score += int(10 * min(1.0, ratio * 2))
        if ratio < 0.5:
            issues.append(
                _issue(
                    "warning",
                    "数据表述",
                    "部分数字没有单位",
                    f"共 {len(numbers)} 个数字，只有 {len(with_unit)} 个带单位；公文里数字必须带单位（人/户/万元/平方米）",
                    "给每个数字补上单位，例如“2713 人、969 户、21.32 万平方米”",
                )
            )
    else:
        score += 6

    percents = PERCENT_RE.findall(text)
    if percents:
        if TIME_HINT.search(text):
            score += 8
        else:
            issues.append(
                _issue(
                    "warning",
                    "数据口径",
                    "出现百分比但没有时间口径",
                    "百分比必须说明统计时点（截至什么时候），否则无法判断是否有效",
                    "在百分比前加口径，例如“截至今年 1 季度，完成比例 85%”",
                )
            )
    else:
        score += 8

    if TIME_HINT.search(text):
        score += 7
    else:
        issues.append(
            _issue(
                "warning",
                "数据口径",
                "全文没有时间口径",
                "数据没有“截至何时”，读者无法判断新旧",
                "在开头或每段数据前加“截至 2025 年 X 月”",
            )
        )
    return min(score, 25), issues


def check_writing(html: str) -> tuple[int, list[dict]]:
    blocks = split_blocks(html)
    score = 0
    issues: list[dict] = []

    long_paras = [(i, b.text) for i, b in enumerate(blocks) if b.type == "paragraph" and len(b.text) > 300]
    if long_paras:
        i, text = long_paras[0]
        score += max(0, 10 - 2 * len(long_paras))
        issues.append(
            _issue(
                "warning",
                _locate(html, i),
                f"有 {len(long_paras)} 个段落超过 300 字",
                "公文一段只讲一件事；超过 300 字读者容易抓不住重点",
                "按“现状—问题—措施”拆成 2–3 段，每段首句写结论",
                text,
                block=i,
            )
        )
    else:
        score += 10

    long_sents = 0
    first_long_block: int | None = None
    for bi, b in enumerate(blocks):
        for s in re.split(r"[。；！？]", b.text):
            if len(s.strip()) > 80:
                long_sents += 1
                if first_long_block is None:
                    first_long_block = bi
    if long_sents:
        score += max(0, 5 - long_sents)
        issues.append(
            _issue(
                "info",
                "全文",
                f"有 {long_sents} 个长句超过 80 字",
                "一个句子只表达一个意思，长句容易产生歧义",
                "在逗号处断句，或改成“因为…所以…”“一方面…另一方面…”",
                block=first_long_block,
            )
        )
    else:
        score += 5

    hits = [(w, b) for b in blocks for w in COLLOQUIAL if w in b.text]
    if hits:
        word, block = hits[0]
        idx = next(i for i, b in enumerate(blocks) if b is block)
        score += max(0, 10 - 3 * len(hits))
        issues.append(
            _issue(
                "warning",
                _locate(html, idx),
                f"出现口语化表达「{word}」等 {len(hits)} 处",
                "公文应使用书面语；“我们认为”“还行”会削弱权威性",
                f"「{word}」改成“经分析”“结果表明”“基本正常”等书面表达",
                block.text,
                block=idx,
            )
        )
    else:
        score += 10
    return min(score, 25), issues


def check_format(html: str) -> tuple[int, list[dict]]:
    text = strip_tags(html)
    head = text[:120]
    score = 0
    issues: list[dict] = []

    if re.search(r"(区委|县委|市委|公司|局|委|办)[、，,]?\s*(区政府|县政府)?[：:]", head) or "：" in head[:60]:
        score += 8
    else:
        issues.append(
            _issue(
                "info",
                "文首",
                "没有识别到主送机关（抬头）",
                "汇报类公文一般有“区委、区政府：”这样的主送机关",
                "在标题下方补主送机关，结尾加“特此汇报”",
                block=0,
            )
        )

    if re.search(r"20\d{2}\s*年\s*\d{0,2}\s*月?\s*\d{0,2}\s*日?\s*$", text.strip()[-80:]) or re.search(
        r"^.{0,20}(管委会|人民政府|办公室|局)$", text.strip().split("\n")[-1] if text.strip() else ""
    ):
        score += 6
    else:
        issues.append(
            _issue(
                "info",
                "文末",
                "没有识别到落款单位与日期",
                "公文末尾应有发文单位与成文日期，否则无法确认效力",
                "在结尾补单位名称与日期（右对齐）",
                block=max(0, len(split_blocks(html)) - 1),
            )
        )

    if re.search(r"附件", text):
        score += 4

    # 编号是否连续（一、二、三…不跳号）
    nums = re.findall(r"(?m)^\s*([一二三四五六七八九十]+)、", text)
    order = "一二三四五六七八九十"
    has_l2 = bool(re.search(r"[（(][一二三四五六七八九十]+[）)]", text))
    idxs = [order.index(n) for n in nums if n in order]
    ordered = bool(idxs) and idxs == sorted(idxs) and len(set(idxs)) == len(idxs)

    # 只有一级编号也算规范（很多汇报只有"一、二、三"；再加（一）（二）就更好）
    if (len(nums) >= 1 and has_l2) or (len(nums) >= 2 and ordered):
        score += 8
    elif len(nums) >= 2:
            issues.append(
                _issue(
                    "info",
                    "整体结构",
                    "一级编号不连续",
                    f"识别到的编号为：{'、'.join(nums[:8])}",
                    "按一、二、三顺序排列，不要跳号或重复",
                )
            )
    return min(score, 20), issues


# ---------------- 汇总 ----------------

DIM_LABEL = {"structure": "结构", "data": "数据", "writing": "表达", "format": "体例"}

LEVEL_LABEL = {"error": "必须改", "warning": "建议改", "info": "可选"}


def _status(level: str | None) -> str:
    """把最严重的一条问题翻译成定性状态"""
    if level is None:
        return "没问题"
    return {"error": "需返工", "warning": "建议改进", "info": "小问题"}.get(level, "可优化")


def analyze(html: str) -> dict[str, Any]:
    _, s_issues = check_structure(html)
    _, d_issues = check_data(html)
    _, w_issues = check_writing(html)
    _, f_issues = check_format(html)

    issues = sorted(
        s_issues + d_issues + w_issues + f_issues,
        key=lambda x: {"error": 0, "warning": 1, "info": 2}.get(x["level"], 3),
    )

    # 给能定位的问题补上 anchor（段落前 40 字），前端靠它在编辑器里找到对应块
    blocks = split_blocks(html)
    for it in issues:
        idx = it.get("block")
        if isinstance(idx, int) and 0 <= idx < len(blocks):
            text = re.sub(r"\s+", "", blocks[idx].text)
            it["anchor"] = text[:40]
        else:
            it["anchor"] = ""

    # 每个维度的状态由"该维度最严重的一条"决定，不打分
    groups = {
        "structure": s_issues,
        "data": d_issues,
        "writing": w_issues,
        "format": f_issues,
    }
    dims: dict[str, Any] = {}
    for key, group in groups.items():
        worst = {"error": 0, "warning": 1, "info": 2}
        top_level = min(group, key=lambda x: worst.get(x["level"], 3))["level"] if group else None
        dims[key] = {
            "label": DIM_LABEL[key],
            "status": _status(top_level),
            "count": len(group),
            "problems": [x["problem"] for x in group],
        }

    must = [i for i in issues if i["level"] == "error"]
    dm = docmap.build(html)
    if not issues:
        summary = "没有发现明显问题，结构和表达都符合公文的常见写法。"
    else:
        head = f"共 {len(issues)} 条建议"
        if must:
            head += f"，其中 {len(must)} 条必须处理"
        summary = f"{head}。最需要先解决的是：{issues[0]['problem']}。"

    return {
        "ok": True,
        "dims": dims,
        "issues": issues,
        "summary": summary,
        "docStats": {"sections": len(dm.sections), "blocks": dm.block_count, "chars": dm.total_chars},
    }
