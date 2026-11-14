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

# 「有量纲」的尾巴：单位、量词、时间后缀都算
UNIT_TAIL_RE = re.compile(
    r"(?:千米|公里|平方米|立方米|平方|万元|亿元|百分点|个百分点|人|户|元|万|亿|个|套|张|间|处|所|座|台|"
    r"件|条|项|份|篇|页|行|列|次|倍|成|年|月|日|季|季度|天|小时|分钟|秒|号|期|批|轮|层|栋|"
    r"米|吨|升|度|岁|名|位|家|辆|兆瓦|千瓦|%|％)"
)


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
    rule_id = re.sub(r"「[^」]*」|\d+", "", problem).strip() or problem
    return {
        "level": level,
        "levelLabel": LEVEL_LABEL.get(level, level),
        "rule": problem,
        "ruleId": rule_id,
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
    # 注意：「措施」只认标题级出现。正文里出现「保障措施」四个字（比如章节名是
    # 「四、保障措施」但内容是保障而不是下一步动作）会误判为"已有措施"，所以
    # 现状/问题允许全文强信号，措施要求出现在标题或章节标题清单里。
    STRONG = {
        "现状": ["基本情况", "总体情况", "工作开展情况"],
        "问题": ["存在问题", "主要问题", "存在问题及原因"],
        "措施": ["下一步", "工作打算", "下步工作", "整改措施", "下一步措施"],
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
                    # 结构缺失也要能跳转：现状/问题跳文首，措施跳文末（该补的位置）
                    block=0 if name == "现状" else max(0, len(split_blocks(html)) - 1),
                )
            )

    # 编号连续
    if dm.sections:
        nums = [s.number for s in dm.sections if s.number]
        levels = [s.level for s in dm.sections]
        if levels and max(levels) - min(levels) > 1:
            jump_block = None
            for sec in dm.sections:
                if sec.level >= 2:
                    jump_block = sec.block_start
                    break
            issues.append(
                _issue(
                    "warning",
                    "整体结构",
                    "标题层级跳级",
                    "一、下面直接出现 1.（缺（一）这一层），层级不连贯",
                    "把中间层补齐，或把 1. 改成（一）",
                    block=jump_block,
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

    # 找出「没有跟单位」的数字：两位以上整数或带小数（排除 1. 2. 这类列表编号，
    # 也排除百分数——百分数单独按「数据口径」检查）
    bare: list[str] = []
    for match in re.finditer(r"\d+(?:\.\d+)?", text):
        token = match.group(0)
        if len(token) < 2 and "." not in token:
            continue
        # 年份、时间点不算「缺单位」（2025 年、2026 年）
        if re.fullmatch(r"(?:19|20)\d{2}", token):
            continue
        tail = text[match.end() : match.end() + 6].lstrip()
        # 后面跟着量词/单位/时间后缀，就算有量纲
        if UNIT_TAIL_RE.match(tail):
            continue
        # 序号：1. / 2、/ (3)
        if re.match(r"[.、）)]", tail):
            continue
        bare.append(token)

    if bare:
        score += max(0, 10 - 2 * len(bare))
        sample = "、".join(dict.fromkeys(bare))[:40]
        # 定位到第一个含裸数字的段落，点建议能跳过去
        first_token = bare[0]
        loc = None
        for bi, blk in enumerate(split_blocks(html)):
            if blk.type != "table" and first_token in blk.text:
                loc = bi
                break
        issues.append(
            _issue(
                "warning",
                "数据表述",
                f"有 {len(bare)} 个数字没带单位",
                f"取值为 {sample}；公文里数字必须带单位（人/户/万元/平方米/个），否则会被误读成别的东西",
                "给这些数字补上单位，例如“1132 户”“3420 张”，或注明统计口径",
                block=loc,
            )
        )
    else:
        score += 10

    percents = PERCENT_RE.findall(text)
    if percents:
        if TIME_HINT.search(text):
            score += 8
        else:
            pct_block = None
            for bi, blk in enumerate(split_blocks(html)):
                if "%" in blk.text or "％" in blk.text:
                    pct_block = bi
                    break
            issues.append(
                _issue(
                    "warning",
                    "数据口径",
                    "出现百分比但没有时间口径",
                    "百分比必须说明统计时点（截至什么时候），否则无法判断是否有效",
                    "在百分比前加口径，例如“截至今年 1 季度，完成比例 85%”",
                    block=pct_block,
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
                block=0,
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

DIM_LABEL = {"structure": "结构", "data": "数据", "writing": "表达", "format": "体例", "consistency": "一致性"}

LEVEL_LABEL = {"error": "必须改", "warning": "建议改", "info": "可选"}

_ORDER = {"error": 0, "warning": 1, "info": 2}
_STATUS = {"error": "需返工", "warning": "建议改进", "info": "小问题"}


def _status(level: str | None) -> str:
    """把最严重的一条问题翻译成定性状态"""
    if level is None:
        return "没问题"
    return _STATUS.get(level, "可优化")


def _add_anchors(issues: list[dict], html: str, plain: str) -> None:
    """给能定位的问题补 anchor（前端靠它在编辑器里找到对应块）"""
    blocks = split_blocks(html)
    for it in issues:
        idx = it.get("block")
        if isinstance(idx, int) and 0 <= idx < len(blocks):
            it["anchor"] = re.sub(r"\s+", "", blocks[idx].text)[:40]
        elif isinstance(it.get("pos"), int) and plain:
            # 语病检查给的是字符偏移，按偏移取原文片段当 anchor
            p = it["pos"]
            it["anchor"] = re.sub(r"\s+", "", plain[max(0, p - 10): p + 24])
        else:
            it["anchor"] = ""


def _dims_of(groups: dict[str, list[dict]], labels: dict[str, str]) -> dict[str, Any]:
    dims: dict[str, Any] = {}
    for key, group in groups.items():
        top = min((_ORDER.get(i["level"], 3) for i in group), default=None)
        dims[key] = {
            "label": labels[key],
            "status": _status({0: "error", 1: "warning", 2: "info"}.get(top)) if top is not None else "没问题",
            "count": len(group),
            "problems": [x["problem"] for x in group],
        }
    return dims


def _attach_blocks(issues: list[dict], html: str, plain: str) -> None:
    """
    给语病问题补 block（跳转目标）。

    优先用 excerpt 前 12 字在块里找；找不到再按 pos 落在哪一段推算。
    """
    blocks = split_blocks(html)
    texts = [b.text for b in blocks]
    spans: list[tuple[int, int]] = []
    cursor = 0
    for text in texts:
        spans.append((cursor, cursor + len(text)))
        cursor += len(text) + 1

    for it in issues:
        if it.get("block") is not None:
            continue
        excerpt = (it.get("excerpt") or "").strip()[:12]
        if excerpt:
            for idx, text in enumerate(texts):
                if excerpt in text:
                    it["block"] = idx
                    break
            if it.get("block") is not None:
                continue
        pos = it.get("pos")
        if isinstance(pos, int):
            for idx, (start, end) in enumerate(spans):
                if start <= pos < end:
                    it["block"] = idx
                    break


def check_prose(html: str) -> list[dict]:
    """
    通用文体的「可读性」检查：长段落与长句。

    与公文共用同一套阈值（段落 300 字、句子 80 字），
    但记叙文/议论文本来就容易写长句，所以只报「可选」。
    """
    blocks = split_blocks(html)
    issues: list[dict] = []

    long_paras = [(i, b.text) for i, b in enumerate(blocks) if len(b.text) > 300]
    if long_paras:
        idx, text = long_paras[0]
        issues.append(
            _issue(
                "info",
                f"第 {idx + 1} 段",
                f"有 {len(long_paras)} 个段落超过 300 字",
                "一段只讲一件事；超过 300 字读者容易走神，也不利于手机上阅读",
                "按时间或场景拆成 2–3 段，每段结尾留一句过渡",
                text,
                block=idx,
            )
        )

    long_sents = 0
    first_block = None
    for i, b in enumerate(blocks):
        for s in re.split(r"[。！？；]", b.text):
            if len(s.strip()) > 80:
                long_sents += 1
                if first_block is None:
                    first_block = i
    if long_sents:
        issues.append(
            _issue(
                "info",
                "全文",
                f"有 {long_sents} 个长句超过 80 字",
                "一句话只表达一个意思；宾语套宾语的长句容易读丢主语",
                "在逗号处断句，或拆成两句",
                block=first_block,
            )
        )
    return issues


def analyze(html: str, genre: str | None = None) -> dict[str, Any]:
    """
    文档优化建议。

    文体分流（关键）：
      · 公文        → 原有四维（结构/数据/表达/体例）：三段式、数字带单位、抬头落款
      · 其他文体    → 通用语病检查（重复/的地得/错字/赘余/逻辑/时间）

    为什么必须分流：原实现把所有非公文都落到 DOC_TYPE_RULES["其他"]，
    要求「现状 10 分 + 措施 10 分」。实测一段记叙文被判「需返工」，
    理由是「缺基本情况」「缺下一步措施」——六条建议全部不对题，
    而该段真实的 8 处语病一条都没报。

    genre 为 None 时自动判定；判定不出按公文处理（保持既有行为，不产生回归）。
    """
    from . import grammar
    from .classify_genre import GENRE_LABEL, classify

    plain = strip_tags(html)
    if genre is None:
        judged = classify(plain)
        genre = judged.get("genre")
    is_gongwen = genre in (None, "gongwen")

    dm = docmap.build(html)
    doc_stats = {"sections": len(dm.sections), "blocks": dm.block_count, "chars": dm.total_chars}

    if is_gongwen:
        _, s_issues = check_structure(html)
        _, d_issues = check_data(html)
        _, w_issues = check_writing(html)
        _, f_issues = check_format(html)
        # 公文也跑通用语病：的/得/地、错字、重复词对公文同样成立
        g_issues = grammar.analyze(plain)["issues"]
        for it in g_issues:
            it.setdefault("block", None)

        # 一致性层：编号断号、数字前后矛盾、整段重复、表格表头、单位混写、百分比无分母
        from . import consistency

        c_issues = consistency.analyze(html)
        for it in c_issues:
            it.setdefault("block", None)

        issues = sorted(
            s_issues + d_issues + w_issues + f_issues + g_issues + c_issues,
            key=lambda x: (_ORDER.get(x["level"], 3), x.get("pos") if x.get("pos") is not None else 10**6),
        )
        _add_anchors(issues, html, plain)
        dims = _dims_of(
            {
                "structure": s_issues,
                "data": d_issues,
                "writing": w_issues + g_issues,
                "format": f_issues,
                "consistency": c_issues,
            },
            DIM_LABEL,
        )
        clean_msg = "没有发现明显问题，结构和表达都符合公文的常见写法。"
        genre_label = "公文"
    else:
        g_rep = grammar.analyze(plain)
        issues = g_rep["issues"]
        _attach_blocks(issues, html, plain)
        _add_anchors(issues, html, plain)
        # 语病之外再查可读性：长段落/长句与文体无关
        prose = check_prose(html)
        for it in prose:
            it.setdefault("block", None)
        dims = {k: v for k, v in g_rep["dims"].items()}
        if prose:
            dims["prose"] = {
                "label": "篇幅",
                "status": "小问题",
                "count": len(prose),
                "problems": [p["problem"] for p in prose],
            }
            issues = issues + prose
        clean_msg = "没有发现语病，用词与句式都通顺。"
        genre_label = GENRE_LABEL.get(genre, genre or "")

    # ---- 反馈记忆：用户否过的建议不再报 ----
    from . import feedback as FB

    # 语病模块（grammar）的 issue 没有 rule 字段，这里统一补：
    # rule = 问题标题，ruleId = 去掉引号内容与数字后的稳定标识
    for _it in issues:
        _it.setdefault("rule", _it.get("problem", ""))
        _it.setdefault("ruleId", re.sub(r"「[^」]*」|\d+", "", _it.get("problem", "")).strip())

    fp = FB.fingerprint(plain)
    dismissed = 0
    kept: list[dict] = []
    for it in issues:
        if FB.is_dismissed(it.get("rule", ""), it.get("excerpt") or it.get("problem", "")):
            dismissed += 1
            continue
        kept.append(it)
    issues = kept

    must = [i for i in issues if i["level"] == "error"]
    if not issues:
        summary = clean_msg
    else:
        head = f"共 {len(issues)} 条建议"
        if must:
            head += f"，其中 {len(must)} 条必须处理"
        summary = f"{head}。最需要先解决的是：{issues[0]['problem']}。"

    out = {
        "ok": True,
        "dims": dims,
        "issues": issues,
        "summary": summary,
        "docStats": doc_stats,
        "genre": genre or "gongwen",
        "genreLabel": genre_label,
        "fingerprint": fp,
        "dismissedCount": dismissed,
    }
    if not is_gongwen:
        # 非公文不做抬头落款与三段式检查，如实说明，避免"检查通过"被误解为全面通过
        out["scopeNote"] = (
            f"按「{genre_label}」检查语病与逻辑；未套用公文的三段式结构、"
            "数字单位与抬头落款规则。"
        )
        out["factCheckHint"] = grammar.FACT_CHECK_HINT
    return out
