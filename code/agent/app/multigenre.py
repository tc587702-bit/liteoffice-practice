"""
多文体知识库：把「公文 RAG」扩成「全文体 RAG」。

核心思路：文体 = 独立知识库（kb_id），而不是在一个大库里混存。
  · 不改 kb.py 的表结构（kb_chunk 没有 genre 列，也不需要）
  · 复用现有的 kb_id 分区能力：search / stats / add_document 全都按 kb_id 过滤
  · 路由 = 判断该查哪个 kb_id；低置信度时跨文体并查，结果带文体标签

为什么要分库而不是加一列：
  混库检索时，「保障措施」这种词在公文里是章节标题、在论文里是研究局限，
  BM25 的 IDF 会被跨领域词频污染；分库后每个库的 IDF 与同义词表都是领域内的，
  召回质量与可解释性都更好。代价是路由必须准 —— 所以 classify_genre 的
  置信度在这里是一等公民，低置信不硬判，改为跨库并查。

每个文体各自独立配置四件事：
  同义词组 / 切块策略 / 术语表 / 写作检查清单
前三件在本模块，检查清单沿用 pipelines.CHECKLIST。

入库：
    ingest(name, content, genre=None)     不给 genre 就自动判定
    ingest_many([...])                    批量
查询：
    route(query)                          只看路由决策，不检索
    ask(query, ...)                       路由 + 检索 + 融合
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import kb
from .classify_genre import GENRE_LABEL, GENRES, classify
from .query_expand import expand, rrf_merge, search_expanded

# 低置信度阈值：低于它就跨文体并查，而不是赌一个
ROUTE_MIN_CONFIDENCE = 0.30

# 嵌入器懒加载状态（见 _get_embedder）。torch 与模型是可选依赖，
# 缺失时置 None 并记录原因，检索退化为纯 BM25 而不是整个模块报错。
_EMBEDDER: Any = None
_EMBEDDER_TRIED = False
_EMBEDDER_ERROR = ""

# 文体 → 知识库 id。
#
# ⚠️ 命名撞车警告：现有 build_kb.py 用 KB_ID = "lab" 装了 25 份【公文】，
# 而 classify_genre 的 "lab" 指【实验报告】文体。两者同名但含义完全不同。
# 所以实验报告的库用 "lab_report"，并把既有 "lab" 库里的公文迁到 "gongwen"
# （见 tools/migrate_genre_kb.py）。
# 迁移前不要直接对 "lab" 库跑本模块的实验报告相关逻辑 —— 会拿公文当范文。
LEGACY_KB_ID = "lab"          # 既有库 id（内容是公文）
GENRE_KB: dict[str, str] = {
    "gongwen": "gongwen",
    "lab": "lab_report",       # 实验报告；不叫 "lab"，避开既有公文库
    "thesis": "thesis",
    "essay_arg": "essay_arg",
    "essay_narr": "essay_narr",
    "expository": "expository",
    "contract": "contract",
    "resume": "resume",
    "news": "news",
    "legal": "legal",
    "textbook": "textbook",
}


# ---------------------------------------------------------------- 分文体同义词组

# 从 query_expand.SYNONYM_GROUPS 拆出公文相关组，并按文体补齐。
# 拆分原因：原 18 组混着「绿色工厂」「职业病」「稻谷补贴」等外地网页公文词，
# 对其他文体是纯噪声；分库后每个库只用自己的词表。
GENRE_SYNONYMS: dict[str, list[list[str]]] = {
    "gongwen": [
        ["补贴", "补助", "资助", "资金"],
        ["拆迁户", "安置对象", "被征收人", "被拆迁人", "拆迁群众"],
        ["安置房", "回迁房", "安置住房", "安置小区"],
        ["历史遗留问题", "老问题", "遗留问题"],
        ["一案一策", "单独处理", "逐案化解", "个案处置"],
        ["货币补偿", "现金补偿", "补偿款"],
        ["政府信息公开", "政务公开", "信息公开"],
        ["牵头", "负责", "组织实施", "主管"],
        ["申报", "推荐", "报送", "申报材料"],
        ["截止时间", "时限", "期限"],
        ["化解", "处理", "解决", "处置"],
        ["信访", "上访", "来信来访"],
        ["作风", "作风问题", "不良作风"],
        ["征地拆迁", "征收动迁", "征拆"],
        ["工作安排", "工作部署", "工作任务"],
        ["过渡费", "临时安置费", "租房补贴"],
        ["请示", "报请", "呈报"],
        ["落实情况", "执行情况", "推进情况"],
    ],
    "lab": [
        ["误差", "偏差", "不确定度"],
        ["测量", "测定", "测得"],
        ["电压", "电势差", "压降"],
        ["电流", "电流值"],
        ["器材", "仪器", "设备", "装置"],
        ["步骤", "操作过程", "实验流程"],
        ["结论", "实验结果", "结果分析"],
        ["原理", "理论依据", "实验原理"],
        ["量程", "测量范围"],
        ["校准", "标定", "调零"],
    ],
    "thesis": [
        ["摘要", "内容提要", "概要"],
        ["关键词", "主题词"],
        ["研究方法", "研究设计", "方法论"],
        ["文献综述", "研究现状", "既有研究"],
        ["参考文献", "引用文献", "资料来源"],
        ["样本", "样本量", "受试者"],
        ["显著", "具有统计学意义"],
        ["结论", "研究结论", "主要发现"],
        ["局限", "不足", "研究限制"],
        ["数据来源", "数据采集", "数据获取"],
    ],
    "essay_arg": [
        ["论点", "观点", "主张", "看法"],
        ["论据", "依据", "证据", "理由"],
        ["论证", "论述", "说理"],
        ["然而", "但是", "不过"],
        ["因此", "所以", "由此可见", "综上"],
        ["首先", "第一", "其一"],
        ["反驳", "批驳", "质疑"],
        ["例子", "事例", "举例"],
    ],
    "essay_narr": [
        ["回忆", "记得", "想起"],
        ["那时", "当时", "那年", "那天"],
        ["心情", "感受", "心里"],
        ["描写", "刻画", "描绘"],
        ["细节", "画面", "场景"],
        ["忽然", "突然", "猛地"],
        ["感动", "温暖", "触动"],
    ],
    "expository": [
        ["定义", "是指", "概念"],
        ["特点", "特征", "特性"],
        ["分类", "类型", "种类", "分为"],
        ["原理", "机制", "工作方式"],
        ["作用", "功能", "用途"],
        ["构成", "组成", "结构", "部件"],
        ["例如", "比如", "举例"],
        ["过程", "步骤", "流程"],
    ],
    "contract": [
        ["甲方", "委托方", "发包方", "出租方"],
        ["乙方", "受托方", "承包方", "承租方"],
        ["违约金", "赔偿金", "违约责任"],
        ["合同期限", "履行期限", "有效期"],
        ["解除", "终止", "撤销"],
        ["付款", "支付", "结算"],
        ["标的", "标的物", "合同标的"],
        ["争议解决", "仲裁", "诉讼"],
        ["不可抗力", "免责"],
        ["签订", "签署", "订立"],
    ],
    "resume": [
        ["求职意向", "应聘岗位", "期望职位"],
        ["工作经验", "工作经历", "任职经历"],
        ["教育背景", "教育经历", "学历"],
        ["专业技能", "技能特长", "掌握技能"],
        ["自我评价", "个人简介", "自我描述"],
        ["项目经历", "项目经验"],
        ["负责", "承担", "主导"],
        ["实习", "见习"],
    ],
    "news": [
        ["记者", "本报记者", "新华社记者"],
        ["获悉", "了解到", "得知"],
        ["表示", "指出", "强调", "透露"],
        ["近日", "日前", "前不久"],
        ["发布会", "新闻发布会", "通气会"],
        ["举行", "召开", "举办"],
        ["报道", "消息", "通讯"],
    ],
    "legal": [
        ["原告", "起诉方", "申诉人"],
        ["被告", "被诉方", "被申请人"],
        ["本院认为", "本庭认为", "经查"],
        ["诉讼请求", "请求事项", "诉请"],
        ["判决如下", "裁定如下", "裁判结果"],
        ["证据", "举证", "质证"],
        ["驳回", "不予支持"],
        ["上诉", "申诉", "抗诉"],
    ],
    "textbook": [
        ["教学目标", "教学目的", "学习目标"],
        ["教学重点", "重点", "核心内容"],
        ["教学难点", "难点", "疑点"],
        ["知识点", "考点", "要点"],
        ["例题", "示例", "例子"],
        ["课后作业", "练习", "习题"],
        ["掌握", "理解", "了解", "学会"],
        ["课时", "学时"],
    ],
}


# ---------------------------------------------------------------- 分文体切块策略

@dataclass
class ChunkPolicy:
    """
    每个文体的切块参数。

    target：目标块长。叙事文要长（切碎会毁掉场景连贯），
            实验报告与说明文要短（便于精确定位到某一步/某一特性）。
    overlap：相邻块重叠的句数，防止语义被切断。
    split_on_heading：是否遇到标题就断块（公文/论文有真实层级，需要）。
    repeat_table_header：表格是否把表头重复到每个行块。
            实验报告的「电压-电流」表若不重复表头，检索到某一行时
            模型不知道那串数字是什么量。
    drop_patterns：入库前整段丢弃的内容（论文的参考文献列表是典型：
            它会命中大量年份与作者名，却对回答问题毫无价值）。
    """

    target: int = 400
    overlap: int = 1
    split_on_heading: bool = False
    repeat_table_header: bool = False
    drop_patterns: list[str] = field(default_factory=list)


CHUNK_POLICY: dict[str, ChunkPolicy] = {
    # 公文：层级分明（一、（一）1.），必须按标题断块
    "gongwen": ChunkPolicy(
        target=400, overlap=1, split_on_heading=True, repeat_table_header=True,
    ),
    # 实验报告：块要小，定位到"第几步/哪个数据"；表格必须带表头
    "lab": ChunkPolicy(
        target=280, overlap=1, split_on_heading=True, repeat_table_header=True,
    ),
    # 论文：按章节断块，丢弃参考文献列表
    "thesis": ChunkPolicy(
        target=450, overlap=1, split_on_heading=True, repeat_table_header=True,
        drop_patterns=[r"^参考文献", r"^\[\d+\]\s*\S"],
    ),
    # 议论文：论点-论据成段，不宜切碎
    "essay_arg": ChunkPolicy(target=500, overlap=1),
    # 记叙文：场景连贯性最重要，块最长、不拆
    "essay_narr": ChunkPolicy(target=650, overlap=2),
    # 说明文：定义-分类-特点各自成块
    "expository": ChunkPolicy(target=350, overlap=1, split_on_heading=True),
    # 合同：语义单元是"条"，必须按条断块，否则检索到半条无法据以判断权利义务。
    # 块长偏小，保证命中即定位到具体某一条。
    "contract": ChunkPolicy(
        target=300, overlap=1, split_on_heading=True, repeat_table_header=True,
    ),
    # 简历：每个板块（教育/工作/技能）本身很短，块长最小，
    # 避免把"教育背景"和"工作经历"混进同一块导致检索串味。
    "resume": ChunkPolicy(target=200, overlap=0, split_on_heading=True),
    # 新闻：倒金字塔结构，导语（首段）信息密度最高，段落本身短，
    # 按段聚合但不拆散；块长中等，保证导语与背景不被切断。
    "news": ChunkPolicy(target=400, overlap=1),
    # 法律文书：说理段落（"本院认为"）是长链条推理，切碎会断掉论证，
    # 故块长最大；按标题/条款断块，判决主文需单独成块。
    "legal": ChunkPolicy(
        target=600, overlap=2, split_on_heading=True, repeat_table_header=True,
    ),
    # 教材讲义：知识点各自成块，便于精确定位"哪个知识点/哪道例题"。
    "textbook": ChunkPolicy(
        target=350, overlap=1, split_on_heading=True, repeat_table_header=True,
    ),
}

DEFAULT_POLICY = ChunkPolicy()


# ---------------------------------------------------------------- 分文体术语表

# 术语走字符串精确匹配，比向量准且可解释（见 kb.py:6-7 的设计注释）。
# 每个文体一份；入库时用 kb.add_terms 写进对应库。
# 现有库里那条「硅二极管→硅整流二极管」属 lab 领域，归位到这里。
GENRE_TERMS: dict[str, list[dict[str, str]]] = {
    "gongwen": [
        {"term": "拆迁户", "canonical": "被征收人", "note": "公文规范表述"},
        {"term": "给钱", "canonical": "货币补偿", "note": "口语转书面"},
        {"term": "老问题", "canonical": "历史遗留问题", "note": "公文规范表述"},
        {"term": "上报", "canonical": "报送", "note": "公文规范表述"},
        {"term": "管这事", "canonical": "牵头负责", "note": "口语转书面"},
        {"term": "老百姓", "canonical": "群众", "note": "公文规范表述"},
        {"term": "赶紧", "canonical": "尽快", "note": "口语转书面"},
        {"term": "弄好", "canonical": "落实到位", "note": "口语转书面"},
    ],
    "lab": [
        {"term": "硅二极管", "canonical": "硅整流二极管", "note": "标准名"},
        {"term": "测了", "canonical": "测量", "note": "书面语"},
        {"term": "电压值", "canonical": "电压", "note": "去冗余"},
        {"term": "仪器", "canonical": "实验器材", "note": "报告规范表述"},
        {"term": "不准", "canonical": "存在系统误差", "note": "书面语"},
        {"term": "差不多", "canonical": "近似", "note": "书面语"},
    ],
    "thesis": [
        {"term": "我做了", "canonical": "本研究采用", "note": "去第一人称"},
        {"term": "很多", "canonical": "大量", "note": "书面语"},
        {"term": "证明了", "canonical": "研究结果表明", "note": "避免过度断言"},
        {"term": "肯定", "canonical": "显著", "note": "统计学表述"},
        {"term": "查了资料", "canonical": "文献综述显示", "note": "学术表述"},
    ],
    "essay_arg": [
        {"term": "我觉得", "canonical": "我认为", "note": "书面语"},
        {"term": "大家都知道", "canonical": "众所周知", "note": "避免以偏概全"},
        {"term": "举例子", "canonical": "以…为例", "note": "书面语"},
        {"term": "所以说", "canonical": "由此可见", "note": "论证衔接"},
    ],
    "essay_narr": [
        {"term": "然后", "canonical": "随后", "note": "减少口头连接词"},
        {"term": "很开心", "canonical": "（建议改为具体动作与细节）", "note": "情感宜通过动作表达"},
        {"term": "非常", "canonical": "（建议删去或改为具体描写）", "note": "弱化空洞副词"},
    ],
    "expository": [
        {"term": "这个东西", "canonical": "该装置", "note": "指代明确化"},
        {"term": "大概是", "canonical": "通常为", "note": "说明文需准确"},
        {"term": "好多", "canonical": "多种", "note": "书面语"},
    ],
    # 以下五类的术语只收「口语→书面」的单向替换。
    # 刻意不收 canonical 里包含 term 的条目（如「牵头→牵头负责」），
    # 否则原文已含该词时会拼出「牵头牵头负责」这类重复（历史上踩过这个坑）。
    "contract": [
        {"term": "给的", "canonical": "支付", "note": "合同规范表述"},
        {"term": "说好了", "canonical": "双方约定", "note": "书面语"},
        {"term": "反悔", "canonical": "单方解除", "note": "合同规范表述"},
        {"term": "赔钱", "canonical": "承担赔偿责任", "note": "合同规范表述"},
        {"term": "不管了", "canonical": "不再履行", "note": "书面语"},
        {"term": "签字画押", "canonical": "签字盖章", "note": "规范表述"},
    ],
    "resume": [
        {"term": "干过", "canonical": "任职于", "note": "书面语"},
        {"term": "做过", "canonical": "负责", "note": "书面语"},
        {"term": "会一点", "canonical": "熟悉", "note": "避免弱化能力表述"},
        {"term": "特别厉害", "canonical": "熟练掌握", "note": "以能力事实替代主观形容"},
        {"term": "帮忙", "canonical": "协助", "note": "书面语"},
    ],
    "news": [
        {"term": "搞了", "canonical": "举办", "note": "书面语"},
        {"term": "很多人", "canonical": "众多", "note": "新闻用语需准确"},
        {"term": "特别好", "canonical": "成效显著", "note": "避免主观形容"},
        {"term": "大家", "canonical": "与会者", "note": "指代明确化"},
        {"term": "说了", "canonical": "表示", "note": "新闻规范表述"},
    ],
    "legal": [
        {"term": "告他", "canonical": "提起诉讼", "note": "法律规范表述"},
        {"term": "打官司", "canonical": "诉讼", "note": "书面语"},
        {"term": "不算数", "canonical": "无效", "note": "法律规范表述"},
        {"term": "赔了", "canonical": "已承担赔偿责任", "note": "法律规范表述"},
        {"term": "找法院", "canonical": "向人民法院起诉", "note": "法律规范表述"},
    ],
    "textbook": [
        {"term": "这个东西", "canonical": "该概念", "note": "指代明确化"},
        {"term": "记住", "canonical": "掌握", "note": "教学规范表述"},
        {"term": "很简单", "canonical": "属于基础内容", "note": "避免轻视学生理解难度"},
        {"term": "考试会考", "canonical": "本知识点为考查重点", "note": "教学规范表述"},
        {"term": "懂了吧", "canonical": "请确认是否理解", "note": "书面语"},
    ],
}


# ---------------------------------------------------------------- 入库

def _should_drop(text: str, policy: ChunkPolicy) -> bool:
    return any(re.search(p, text.strip()) for p in policy.drop_patterns)


def _chunk_with_policy(html: str, policy: ChunkPolicy) -> list[kb.Chunk]:
    """
    按文体策略切块。在 kb 的切块之上加三件事：
      ① 表格重复表头   ② 丢弃噪声段（如参考文献）   ③ 块长与重叠按文体取值
    """
    chunks: list[kb.Chunk] = []
    heading = ""
    lines: list[str] = []
    table_header: list[str] = []

    def flush() -> None:
        nonlocal lines
        if not lines:
            return
        for c in kb.chunk_text(
            "\n".join(lines), target=policy.target, overlap_sentences=policy.overlap
        ):
            if not _should_drop(c.text, policy):
                c.heading = heading
                chunks.append(c)
        lines = []

    for m in kb.BLOCK_RE.finditer(html):
        tag = m.group(1).lower()
        inner = m.group(2)

        if tag.startswith("h"):
            # 只在策略要求时因标题断块；否则标题并入正文，保留上下文
            if policy.split_on_heading:
                flush()
            heading = kb.strip_tags(inner)[:60]
            lines.append(heading)

        elif tag == "table":
            rows = list(kb.ROW_RE.finditer(inner))
            table_header = []
            for ri, row in enumerate(rows):
                cells: list[str] = []
                for cell in kb.CELL_RE.finditer(row.group(1)):
                    text = kb.strip_tags(cell.group(2)).strip()
                    # 合并单元格会重复返回同一段文字，连续去重
                    if text and (not cells or cells[-1] != text):
                        cells.append(text)
                if not cells:
                    continue
                if ri == 0:
                    table_header = cells
                    lines.append(" | ".join(cells))
                elif policy.repeat_table_header and table_header:
                    # 关键：每个数据行都带上表头，否则"0.6 | 1.2"无法被理解
                    lines.append(
                        " | ".join(table_header) + "\n" + " | ".join(cells)
                    )
                else:
                    lines.append(" | ".join(cells))
        else:
            lines.append(kb.strip_tags(inner))

    flush()
    for i, c in enumerate(chunks):
        c.ord = i
    return chunks


def ensure_genre(genre: str) -> str:
    """确保该文体对应的知识库存在，返回 kb_id"""
    kb_id = GENRE_KB.get(genre, genre)
    kb.ensure_kb(kb_id, name=GENRE_LABEL.get(genre, genre))
    return kb_id


def seed_terms(genre: str) -> int:
    """把该文体的术语表写进库里（幂等：kb.add_terms 靠 UNIQUE(kb_id, term) 去重）"""
    kb_id = ensure_genre(genre)
    return kb.add_terms(kb_id, GENRE_TERMS.get(genre, []))


def ingest(
    name: str,
    content: str,
    genre: str | None = None,
    min_confidence: float = ROUTE_MIN_CONFIDENCE,
) -> dict[str, Any]:
    """
    入库一份文档。

    genre 为 None 时用 classify_genre 自动判定；置信度不足则不猜，
    返回 genre=None 与候选清单，由调用方决定（让用户选，或入通用库）。
    """
    raw = content if isinstance(content, str) else str(content)
    if not raw.strip():
        return {"ok": False, "reason": "内容为空"}

    judged = classify(raw, min_confidence=min_confidence)
    if genre is None:
        genre = judged.get("genre")
        if not genre:
            return {
                "ok": False,
                "reason": judged.get("reason", "文体特征不足"),
                "confidence": judged.get("confidence", 0.0),
                "ranking": judged.get("ranking", []),
            }
    if genre not in GENRE_KB:
        return {"ok": False, "reason": f"未知文体：{genre}", "known": sorted(GENRE_KB)}

    kb_id = ensure_genre(genre)
    policy = CHUNK_POLICY.get(genre, DEFAULT_POLICY)

    # 与 kb.add_document 同一套去重口径：同库内 sha256 相同即跳过
    import hashlib

    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    conn = kb.connect()
    exists = conn.execute(
        "SELECT id FROM kb_doc WHERE kb_id = ? AND sha256 = ?", (kb_id, digest)
    ).fetchone()
    conn.close()
    if exists:
        return {
            "ok": True, "docId": exists["id"], "chunks": 0, "deduped": True,
            "genre": genre, "kbId": kb_id,
        }

    looks_html = re.search(r"<(p|h[1-6]|table|div|ul|ol|br)\b", raw[:800], re.IGNORECASE) is not None
    if looks_html:
        chunks = _chunk_with_policy(raw, policy)
    else:
        # 纯文本包一层 <p> 走同一套策略，保证表格/标题逻辑一致
        wrapped = "".join(f"<p>{p.strip()}</p>" for p in raw.split("\n") if p.strip())
        chunks = _chunk_with_policy(wrapped, policy) if wrapped else []
    if not chunks:
        chunks = kb.chunk_text(raw, target=policy.target)

    doc_id = kb.uid("doc")
    conn = kb.connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO kb_doc (id, kb_id, name, sha256, bytes, chunks, status, added_at)"
                " VALUES (?,?,?,?,?,?,'ready',?)",
                (doc_id, kb_id, name, digest, len(raw.encode("utf-8")), len(chunks), kb.now()),
            )
            conn.executemany(
                "INSERT INTO kb_chunk (id, doc_id, kb_id, ord, text, heading) VALUES (?,?,?,?,?,?)",
                [(kb.uid("chk"), doc_id, kb_id, c.ord, c.text, c.heading) for c in chunks],
            )
    finally:
        conn.close()

    return {
        "ok": True, "docId": doc_id, "chunks": len(chunks), "deduped": False,
        "genre": genre, "genreLabel": GENRE_LABEL.get(genre, genre),
        "confidence": judged.get("confidence"), "kbId": kb_id,
    }


# ---------------------------------------------------------------- 路由

@dataclass
class RouteDecision:
    genres: list[str]          # 要检索的文体（按置信度排序）
    primary: str | None        # 单一最优判定；跨文体并查时为 None
    confidence: float
    reason: str
    forced: bool = False       # 是否由调用方强制指定


def _quick_genre_hint(text: str) -> tuple[str | None, int]:
    """
    轻量文体提示：用各文体 RULES.strong 特征词做子串扫描，命中最多的胜出。

    为什么需要：classify() 有 20 字硬门槛，用户问题天然就短（10–15 字），
    直接传进去会被拒成 genre=None，导致所有短问题都走"跨全部文体并查"，
    结果被大库主导、新加的小库轮不上。

    本函数只做 strong 特征词的精确子串匹配（不做 regex、不看 weak/anti），
    所以速度快、可解释、不会误判长文本。返回值是 (最佳文体, 命中数)，
    命中数为 0 时返回 (None, 0)。

    注意：这只是「提示」，不是判定。route() 会把它与 classify() 的结果综合使用：
    · 长文本仍以 classify() 为准（它看完整信号，更准）
    · 短文本（<20 字）且 classify() 拒判时，只要命中 ≥1 个 strong 词就采信
      （不归一化：strong 词表大小差异大，归一化会让小词表的文体永远过不了阈值）
    """
    from .classify_genre import RULES

    text = (text or "").strip()
    if not text:
        return None, 0

    best_genre: str | None = None
    best_hits = 0

    for genre, rule in RULES.items():
        if not rule.strong:
            continue
        hits = sum(1 for w in rule.strong if w in text)
        if hits > best_hits:
            best_hits = hits
            best_genre = genre

    if best_hits == 0 or best_genre is None:
        return None, 0
    return best_genre, best_hits


def route(query: str, hint_text: str = "", force_genre: str | None = None) -> RouteDecision:
    """
    决定查哪些库。

    · force_genre：调用方已明确（用户选了文体），直接采信
    · hint_text：当前文档正文。有文档时优先按文档判文体，比按问题猜准得多
    · 短查询（<20 字）且 classify() 拒判时，用 _quick_genre_hint() 兜底，
      避免所有短问题都走"跨全部文体并查"被大库主导
    · 置信度不足 → 跨全部文体并查，宁多不少（漏检比多检代价高）
    """
    if force_genre and force_genre in GENRE_KB:
        return RouteDecision([force_genre], force_genre, 1.0, "调用方指定文体", forced=True)

    basis = hint_text if len(hint_text.strip()) >= 40 else query
    source = "当前文档" if basis is hint_text else "问题文本"
    judged = classify(basis, min_confidence=ROUTE_MIN_CONFIDENCE)
    genre = judged.get("genre")

    if genre:
        return RouteDecision(
            [genre], genre, judged.get("confidence", 0.0),
            f"按{source}判定为{GENRE_LABEL.get(genre, genre)}",
        )

    # classify() 拒判（通常是文本过短或特征不足）时，用轻量关键词匹配兜底。
    # 只对短查询生效：长文本已被 classify() 充分评估过，不应再用简化逻辑覆盖。
    # 命中 ≥1 个 strong 词即采信（不归一化，避免词表大小差异导致误拦）。
    if len(basis.strip()) < 20:
        quick_genre, quick_hits = _quick_genre_hint(basis)
        if quick_genre and quick_hits >= 1:
            return RouteDecision(
                [quick_genre], quick_genre, min(quick_hits * 0.15, 0.9),
                f"按{source}关键词提示为{GENRE_LABEL.get(quick_genre, quick_genre)}（短查询命中 {quick_hits} 个特征词）",
            )

    # 低置信：取排名前二的候选，仍不足就全库并查
    ranking = judged.get("ranking") or []
    top = [r["genre"] for r in ranking[:2] if r.get("score", 0) > 0]
    if len(top) == 2:
        return RouteDecision(
            top, None, judged.get("confidence", 0.0),
            f"{source}文体不明确，并查 {GENRE_LABEL.get(top[0], top[0])} 与 {GENRE_LABEL.get(top[1], top[1])}",
        )
    return RouteDecision(
        list(GENRE_KB), None, judged.get("confidence", 0.0),
        f"{source}无法判定文体，跨全部 {len(GENRE_KB)} 个文体并查",
    )


# ---------------------------------------------------------------- 查询

# 提问套话：几乎每条语料里都出现，判定相关性时必须先剔除
_META_WORDS = (
    "知识库", "库里", "文档", "文件", "资料", "说说", "讲讲", "请问", "帮我",
    "看看", "有没有", "什么", "怎么", "如何", "哪些", "一下", "关于",
)


def _relevance_gate(query: str, hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    召回之后再拦一道：与问句没有任何词面重叠的命中一律丢掉。

    为什么需要：向量相似度下限从 0.45 降到 0.38 后，换说法的召回率上去了，
    但无关问题也可能捞到东西，「无命中就拒答」这条行为被破坏。
    这里不调阈值，而是要求命中至少有一个 2-gram 与问句相同——
    「火星探测器着陆」与公文库没有任何共同片段，因此会正确返回空。
    """
    flat = re.sub(r"[^\u4e00-\u9fa5a-zA-Z0-9]", "", query or "")
    # 先去掉「知识库/文档/说说」这类提问套话：它们几乎在每条语料里都出现，
    # 留着会让无关问题也"有词面重叠"，门槛形同虚设。
    for word in _META_WORDS:
        flat = flat.replace(word, "")
    grams = {flat[i : i + 2] for i in range(max(0, len(flat) - 1))}
    if len(grams) < 2:
        return hits

    kept: list[dict[str, Any]] = []
    for h in hits:
        text = (h.get("text") or "") + (h.get("title") or "")
        if any(g in text for g in grams):
            kept.append(h)
    return kept


def _get_embedder() -> Any:
    """
    懒加载本地嵌入器；拿不到就返回 None，检索自动退化为纯 BM25。

    不在模块顶层 import：torch/模型是可选依赖，缺了不该让整个 multigenre 无法导入。
    首次加载约 1 秒，之后走 embed_local 的进程内单例。
    """
    global _EMBEDDER, _EMBEDDER_TRIED, _EMBEDDER_ERROR
    if _EMBEDDER_TRIED:
        return _EMBEDDER
    _EMBEDDER_TRIED = True
    try:
        from .embed_local import get_embedder

        _EMBEDDER = get_embedder()
    except Exception as e:  # noqa: BLE001 缺 torch/模型/显存都归这里，检索退化为 BM25 而不是整体失败
        _EMBEDDER = None
        _EMBEDDER_ERROR = f"{type(e).__name__}: {e}"
    return _EMBEDDER


def search_genre(
    genre: str,
    query: str,
    top_k: int = 5,
    use_vector: bool = True,
) -> list[dict[str, Any]]:
    """
    在单个文体的库里检索：BM25（该文体同义词组）∪ 向量 → RRF。

    原来只有 BM25 一路，导致库里 2486 块向量在这个主入口完全用不上，
    同义改写召回率只有 70%（原词 100%）。接上向量补的就是这个缺口。

    use_vector=False 时退回纯 BM25，用于对比评测。
    返回项带 genre / genreLabel，供跨文体融合后仍能标明来源。
    """
    kb_id = GENRE_KB.get(genre, genre)
    # 该文体没有词表时传空表：expand 只返回原句，自然退化为单次 BM25，不会误用全局词表
    groups = GENRE_SYNONYMS.get(genre, [])

    emb = _get_embedder() if use_vector else None
    if emb is not None:
        from . import embed as embed_mod

        res = embed_mod.hybrid_search(kb_id, query, emb, top_k=top_k, groups=groups)
        # 检索后再拦一道：与问句毫无词面重叠的命中丢掉（保「无命中就拒答」）
        hits = _relevance_gate(query, res["hits"])
    else:
        hits, _variants = search_expanded(kb, kb_id, query, top_k=top_k, groups=groups)

    for h in hits:
        h["genre"] = genre
        h["genreLabel"] = GENRE_LABEL.get(genre, genre)
        h["kbId"] = kb_id
    return hits


def ask(
    query: str,
    hint_text: str = "",
    force_genre: str | None = None,
    top_k: int = 5,
    per_genre: int = 8,
) -> dict[str, Any]:
    """
    全文体检索入口：路由 → 各库检索 → RRF 融合 → 带文体标签返回。

    单文体命中时不做融合（融合一个列表没有意义，且会改变分数口径）。
    """
    q = (query or "").strip()
    if len(q) < 2:
        return {"ok": False, "hits": [], "reason": "问题太短"}

    decision = route(q, hint_text=hint_text, force_genre=force_genre)
    per_genre_results: dict[str, list[dict[str, Any]]] = {}
    for g in decision.genres:
        hits = search_genre(g, q, top_k=per_genre)
        if hits:
            per_genre_results[g] = hits

    lists = [v for v in per_genre_results.values() if v]
    if not lists:
        return {
            "ok": True, "hits": [], "route": decision.__dict__,
            "reason": "相关文体的库里都没有命中；可换个说法，或先把该文体语料入库",
            "perGenreCounts": {},
        }

    fused = lists[0][:top_k] if len(lists) == 1 else rrf_merge(lists, top_k=top_k)

    return {
        "ok": True,
        "hits": fused,
        "route": decision.__dict__,
        "perGenreCounts": {g: len(v) for g, v in per_genre_results.items()},
        "citations": [
            {
                "n": i,
                "genre": h.get("genre"),
                "genreLabel": h.get("genreLabel"),
                "doc": h.get("docName"),
                "heading": h.get("heading", ""),
                "ord": h.get("ord"),
                "score": round(float(h.get("score", 0.0)), 4),
                "snippet": re.sub(r"\s+", " ", h.get("text", ""))[:160],
            }
            for i, h in enumerate(fused, 1)
        ],
    }


def all_stats() -> dict[str, Any]:
    """各文体库的规模一览（答辩/自检用）"""
    out: dict[str, Any] = {}
    for genre, kb_id in GENRE_KB.items():
        s = kb.kb_stats(kb_id)
        out[genre] = {
            "label": GENRE_LABEL.get(genre, genre),
            "kbId": kb_id,
            "documents": s["documents"],
            "chunks": s["chunks"],
            "terms": s["terms"],
            "synonymGroups": len(GENRE_SYNONYMS.get(genre, [])),
        }
    return out


def seed_all_terms() -> dict[str, int]:
    """把全部文体的术语表写入对应库"""
    return {g: seed_terms(g) for g in GENRE_KB}


# ---------------------------------------------------------------- 自测

def _selftest(samples_path: str | None = None) -> int:
    """
    用 data/samples.jsonl（每类文体各若干条）验证判定与路由，不写入任何库。
    检索类断言需要一个有数据的库；库为空时自动跳过并说明。
    """
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    path = Path(samples_path) if samples_path else (
        Path(__file__).resolve().parents[1] / "data" / "samples.jsonl"
    )
    samples: list[dict[str, str]] = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                samples.append(json.loads(line))

    print(f"\n=== 0) 配置一致性（{len(GENRES)} 类文体） ===")
    check(f"{len(GENRES)} 类文体都有 kb 映射", set(GENRE_KB) == set(GENRES), str(sorted(GENRE_KB)))
    check(f"{len(GENRES)} 类文体都有同义词组", set(GENRE_SYNONYMS) == set(GENRES))
    check(f"{len(GENRES)} 类文体都有切块策略", set(CHUNK_POLICY) == set(GENRES))
    check(f"{len(GENRES)} 类文体都有术语表", set(GENRE_TERMS) == set(GENRES))
    check("术语条目格式合法", all(
        t.get("term") and t.get("canonical") for rows in GENRE_TERMS.values() for t in rows
    ))
    check("同义词组内无重复词", all(
        len({w for g in groups for w in g}) == sum(len(g) for g in groups)
        for groups in GENRE_SYNONYMS.values()
    ))

    print("\n=== 1) 切块策略差异化 ===")
    check("记叙文块长 > 议论文 > 实验报告",
          CHUNK_POLICY["essay_narr"].target > CHUNK_POLICY["essay_arg"].target > CHUNK_POLICY["lab"].target,
          f"{CHUNK_POLICY['essay_narr'].target} > {CHUNK_POLICY['essay_arg'].target} > {CHUNK_POLICY['lab'].target}")
    check("实验报告重复表头", CHUNK_POLICY["lab"].repeat_table_header is True)
    check("论文丢弃参考文献", bool(CHUNK_POLICY["thesis"].drop_patterns))
    check("记叙文不因标题断块", CHUNK_POLICY["essay_narr"].split_on_heading is False)

    print("\n=== 2) 表格表头重复（实验报告关键） ===")
    tbl = "<table><tr><th>电压</th><th>电流</th></tr><tr><td>0.6</td><td>1.2</td></tr></table>"
    cs = _chunk_with_policy(tbl, CHUNK_POLICY["lab"])
    check("切出块", len(cs) > 0, str(len(cs)))
    check("数据行带上了表头", cs and "电压" in cs[0].text and "0.6" in cs[0].text,
          cs[0].text.replace("\n", " / ")[:60] if cs else "-")
    cs2 = _chunk_with_policy(tbl, ChunkPolicy(target=400, repeat_table_header=False))
    check("关闭该选项时不重复表头", cs2 and cs2[0].text.count("电压") <= 1)

    print("\n=== 3) 参考文献被丢弃 ===")
    thesis_html = "<h2>结论</h2><p>本文提出的方案显著降低首屏时间。</p><h2>参考文献</h2><p>[1] 张三. 文档解析研究. 2024.</p>"
    cs3 = _chunk_with_policy(thesis_html, CHUNK_POLICY["thesis"])
    joined = "\n".join(c.text for c in cs3)
    check("结论段保留", "显著降低首屏时间" in joined)
    check("参考文献段被丢弃", "张三" not in joined, joined[:60])

    print("\n=== 4) 同义词组不跨文体污染 ===")
    g_gong = expand("补贴发放情况", groups=GENRE_SYNONYMS["gongwen"])
    g_lab = expand("补贴发放情况", groups=GENRE_SYNONYMS["lab"])
    check("公文组能扩展出同义词", len(g_gong) > 1, str(g_gong[:3]))
    check("实验组不含公文词", not any("补助" in v for v in g_lab), str(g_lab))
    lab_q = expand("测量误差分析", groups=GENRE_SYNONYMS["lab"])
    check("实验组能扩展出误差同义词", any("偏差" in v or "不确定度" in v for v in lab_q), str(lab_q[:3]))

    print(f"\n=== 5) 文体判定（{len(GENRES)} 类 / {len(samples)} 条样本） ===")
    if not samples:
        print(f"  SKIP  找不到样本文件：{path}")
    else:
        correct = 0
        wrong: list[str] = []
        for s in samples:
            r = classify(s["text"], min_confidence=ROUTE_MIN_CONFIDENCE)
            if r.get("genre") == s["genre"]:
                correct += 1
            else:
                wrong.append(f'{s["genre"]}→{r.get("genre") or "未判定"}')
        check(f"判定正确 {correct}/{len(samples)}", correct == len(samples),
              "；".join(wrong) if wrong else "全部正确")
        genres_seen = {s["genre"] for s in samples}
        check(f"样本覆盖全部 {len(GENRES)} 类", genres_seen == set(GENRES), str(sorted(genres_seen)))

    print("\n=== 6) 路由决策 ===")
    d1 = route("这份公文该怎么写", force_genre="gongwen")
    check("强制指定文体被采信", d1.genres == ["gongwen"] and d1.forced, d1.reason)
    doc = "关于安置房建设和拆迁安置工作有关情况的汇报：一、项目建设基本情况。二、存在问题。三、下一步工作安排。特此汇报。"
    d2 = route("缺口是多少", hint_text=doc)
    check("按文档而非问题判文体", d2.primary == "gongwen", f"{d2.primary} / {d2.reason}")
    d3 = route("嗯")
    check("无信息时跨文体并查", d3.primary is None and len(d3.genres) > 1, str(len(d3.genres)))
    d4 = route("实验误差来源有哪些", hint_text="")
    check("无文档时按问题判", d4.primary in ("lab", None), f"{d4.primary} / {d4.reason}")
    check("未知文体不会被强制采信", route("x", force_genre="不存在的文体").forced is False)

    # 短查询轻量匹配：classify() 因 <20 字拒判时，_quick_genre_hint 应能兜底
    d5 = route("甲方逾期付款违约金")
    check("短问题「甲方逾期付款违约金」→ 合同", d5.primary == "contract",
          f"{d5.primary} / {d5.reason}")
    d6 = route("教学目标怎么写")
    check("短问题「教学目标怎么写」→ 教材讲义", d6.primary == "textbook",
          f"{d6.primary} / {d6.reason}")
    d7 = route("原告举证责任")
    check("短问题「原告举证责任」→ 法律文书", d7.primary == "legal",
          f"{d7.primary} / {d7.reason}")
    d8 = route("求职意向写什么")
    check("短问题「求职意向写什么」→ 简历", d8.primary == "resume",
          f"{d8.primary} / {d8.reason}")
    # 无特征词的短查询仍应走并查，不应乱猜
    d9 = route("怎么办")
    check("无特征短查询仍并查", d9.primary is None and len(d9.genres) > 1,
          f"{d9.primary} / {len(d9.genres)} 类")
    # 长文本仍以 classify() 为准，不被轻量匹配覆盖
    long_doc = "关于安置房建设和拆迁安置工作有关情况的汇报：一、项目建设基本情况。二、存在问题。三、下一步工作安排。特此汇报。"
    d10 = route("甲方", hint_text=long_doc)
    check("有文档时长文本优先按文档判（不被问题关键词覆盖）",
          d10.primary == "gongwen", f"{d10.primary} / {d10.reason}")

    print("\n=== 7) 入库与检索（需要库中有数据） ===")
    stats = all_stats()
    total_chunks = sum(v["chunks"] for v in stats.values())
    print("  各库规模：" + "；".join(f"{v['label']} {v['documents']}份/{v['chunks']}块" for v in stats.values()))
    if total_chunks == 0:
        print("  SKIP  所有文体库都是空的，先跑 tools/build_multigenre_kb.py 建库")
    else:
        busy = max(stats, key=lambda g: stats[g]["chunks"])
        # 查询词必须匹配目标文体：用公文词查实验报告库必然命中 0（旧版就是栽在这里）。
        # 每个文体给一个一定在其语料里出现的代表性词；新增文体须同步补这里，
        # 否则会落到 "的" 兜底词，检索断言就失真了。
        probe_query_map = {
            "gongwen": "安置房",
            "lab": "实验",
            "thesis": "研究",
            "essay_arg": "然而",
            "essay_narr": "我",
            "expository": "特点",
            "contract": "甲方",
            "resume": "求职",
            "news": "记者",
            "legal": "原告",
            "textbook": "教学",
        }
        probe_query = probe_query_map.get(busy, "的")
        missing_probe = set(GENRE_KB) - set(probe_query_map)
        check("每个文体都有探测词", not missing_probe, str(sorted(missing_probe)) if missing_probe else "")
        r = ask(probe_query, force_genre=busy, top_k=3)
        check(f"指定文体[{busy}]检索有结果（查询词「{probe_query}」）",
              len(r["hits"]) > 0, f"{busy} 命中 {len(r['hits'])}")
        check("命中项带文体标签", bool(r["hits"]) and r["hits"][0].get("genre") == busy,
              str(r["hits"][0].get("genreLabel")) if r["hits"] else "-")
        check("citations 与 hits 数量一致", len(r.get("citations", [])) == len(r["hits"]))
        cross = ask("补偿标准是什么", top_k=5)
        check("跨文体查询不报错", cross.get("ok") is True, cross.get("reason", ""))
        check("返回里有路由说明", bool(cross.get("route", {}).get("reason")), str(cross["route"]["reason"])[:50])

        # 向量接入回归：这三条查询纯 BM25 必然 0 条（词不在语料里），
        # 只有向量路能召回。若哪天退回纯 BM25 或阈值又被调高，这里立刻失败。
        print("\n=== 8) 向量路生效（同义改写召回） ===")
        if _get_embedder() is None:
            print(f"  SKIP  嵌入器不可用：{_EMBEDDER_ERROR or '未安装 torch/模型'}")
        else:
            vec_probes = [("essay_arg", "论点"), ("essay_arg", "论据"), ("essay_narr", "细节描写")]
            for g, q in vec_probes:
                if not all_stats()[g]["chunks"]:
                    print(f"  SKIP  {GENRE_LABEL[g]} 库为空")
                    continue
                bm = search_genre(g, q, top_k=3, use_vector=False)
                hy = search_genre(g, q, top_k=3, use_vector=True)
                check(f"{GENRE_LABEL[g]}「{q}」向量补回召回", len(hy) > len(bm),
                      f"纯BM25 {len(bm)} → 混合 {len(hy)}")
            # 阈值下调不能把无关内容放进来（0.38 的标定前提）
            for g, q in [("essay_arg", "火星探测器着陆点"), ("essay_narr", "量子纠缠拓扑绝缘体")]:
                if not all_stats()[g]["chunks"]:
                    continue
                hy = search_genre(g, q, top_k=3, use_vector=True)
                check(f"{GENRE_LABEL[g]} 无关查询仍被挡住「{q}」", len(hy) == 0, f"命中 {len(hy)}")

    print(f"\n结果：{'全部通过' if not fails else f'失败 {len(fails)} 项：' + '、'.join(fails)}")
    return len(fails)


if __name__ == "__main__":
    import sys

    raise SystemExit(1 if _selftest(sys.argv[1] if len(sys.argv) > 1 else None) else 0)
