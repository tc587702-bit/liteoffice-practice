"""
查询扩展（同义词表 + 多查询 RRF 融合）

思路：用户不会用文档里的原词提问。
  1. 建领域同义词组（补助/补贴、拆迁户/安置对象…）
  2. 查询时生成若干变体：把命中的词换成组内其他词
  3. 每个变体各检索一次，用 RRF 融合结果

优点：零依赖、可解释（答辩能说"我们建了领域词表"）、不动检索内核。
"""
from __future__ import annotations

import itertools
import re
from collections.abc import Iterable

# 领域同义词组（每组内的词视为等价；从 25 份语料与公文习惯中整理）
SYNONYM_GROUPS: list[list[str]] = [
    ["补贴", "补助", "资助", "资金"],
    ["拆迁户", "安置对象", "被征收人", "被拆迁人", "拆迁群众"],
    ["安置房", "回迁房", "安置住房", "安置小区"],
    ["历史遗留问题", "老问题", "遗留问题"],
    ["一案一策", "单独处理", "逐案化解", "个案处置"],
    ["绿色工厂", "绿色制造标杆", "绿色制造示范"],
    ["职业病", "尘肺病", "职业健康"],
    ["稻谷补贴", "种粮补助", "粮食补贴"],
    ["货币补偿", "现金补偿", "给钱", "补偿款"],
    ["政府信息公开", "政务公开", "信息公开"],
    ["牵头", "负责", "组织实施", "主管"],
    ["申报", "推荐", "报送", "申报材料"],
    ["截止时间", "时限", "前报", "期限"],
    ["化解", "处理", "解决", "处置"],
    ["信访", "上访", "来信来访"],
    ["作风", "作风问题", "不良作风"],
    ["征地拆迁", "征收动迁", "征拆"],
    ["工作安排", "工作部署", "工作任务"],
]


def expand(query: str, max_variants: int = 6, groups: list[list[str]] | None = None) -> list[str]:
    """
    生成查询变体：原查询 + 把命中的组内词替换成同组其他词。

    groups 为 None 时用模块级 SYNONYM_GROUPS（保持既有行为不变）；
    多文体场景下由调用方传入该文体的同义词组，避免跨领域词表互相干扰。
    """
    q = (query or "").strip()
    if not q:
        return []

    active = SYNONYM_GROUPS if groups is None else groups
    variants = [q]
    hits: list[tuple[str, list[str]]] = []
    for group in active:
        found = [w for w in group if w in q]
        if found:
            alts = [w for w in group if w not in found]
            if alts:
                hits.append((found[0], alts[:2]))

    # 单点替换
    for term, alts in hits:
        for alt in alts:
            variants.append(q.replace(term, alt))

    # 两点替换（只在词很多时用，限制数量防止爆炸）
    if len(hits) >= 2:
        for (t1, a1), (t2, a2) in itertools.islice(itertools.combinations(hits, 2), 2):
            variants.append(q.replace(t1, a1[0]).replace(t2, a2[0]))

    # 去重保序
    seen = set()
    out = []
    for v in variants:
        k = re.sub(r"\s+", "", v)
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out[:max_variants]


def rrf_merge(result_lists: Iterable[list[dict]], k: int = 60, top_k: int = 5) -> list[dict]:
    """Reciprocal Rank Fusion：score = Σ 1/(k + rank)"""
    scores: dict[str, float] = {}
    by_id: dict[str, dict] = {}
    for results in result_lists:
        for rank, hit in enumerate(results, 1):
            cid = hit["chunkId"]
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
            by_id.setdefault(cid, hit)

    merged = []
    for cid, s in sorted(scores.items(), key=lambda x: -x[1])[:top_k]:
        hit = dict(by_id[cid])
        hit["score"] = round(s, 5)
        merged.append(hit)
    return merged


def search_expanded(
    kb_module,
    kb_id: str,
    query: str,
    top_k: int = 5,
    per_query: int = 10,
    groups: list[list[str]] | None = None,
) -> tuple[list[dict], list[str]]:
    """
    先扩展查询，再对每个变体检索，最后 RRF 融合。

    groups 传入时用该文体的同义词组（多文体场景）；为 None 时用全局词表，行为不变。
    """
    variants = expand(query, groups=groups)
    if not variants:
        return [], []
    result_lists = [kb_module.search(kb_id, v, top_k=per_query) for v in variants]
    result_lists = [r for r in result_lists if r]
    if not result_lists:
        return [], variants
    return rrf_merge(result_lists, top_k=top_k), variants
