"""
离线意图识别：字符 n-gram 朴素贝叶斯，纯 Python 实现，不依赖任何模型/服务。

为什么不用关键词：
  "这份文档有什么问题" 同时命中「检查」和「优化」两条正则，
  现在靠 INTENTS 的顺序决定，等于写死规则；
  分类器可以按整句分布判断，且能给出置信度（低置信时回退关键词）。

训练数据在 SEED 里（每个意图 10–14 条），训练结果存 data/intent_model.json，
首次使用时自动训练，之后直接加载（<1MB，加载 1 毫秒）。

对外：
    classify_intent(query) -> {"intent": str, "confidence": float, "scores": {...}}
    train() -> dict   # 强制重训
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

MODEL_PATH = Path(__file__).resolve().parents[1] / "data" / "intent_model.json"

INTENTS = ("structure", "section", "fact", "improve", "kb", "stats")

# 训练语料：贴合真实提问方式（含口语、含错别字、含短句）
SEED: dict[str, list[str]] = {
    "structure": [
        "这份文档分几个部分",
        "文档结构是什么",
        "大纲列一下",
        "一共有几章",
        "讲讲整体结构",
        "这篇文档讲了什么",
        "内容概要",
        "帮我概括一下全文",
        "文档的主要内容包括哪些",
        "整体框架是怎样的",
    ],
    "section": [
        "第 2 部分讲了什么",
        "第三部分说了啥",
        "第五节内容是什么",
        "读一下第二部分",
        "养老保险那节讲了什么",
        "存在问题那一节说了什么",
        "看看第三部分",
        "第二节的具体内容",
    ],
    "fact": [
        # 指向"这一段/这句话"的问法：属于检索（不是章节定位，也不是全文结构）
        "这段话说了什么",
        "这段什么意思",
        "这句话讲的是啥",
        "这一段在说什么",
        "缺口一共多少",
        "安置房还差多少套",
        "有多少人没安置",
        "缺口面积是多少",
        "补偿资金缺口多少万元",
        "文档里提到缺口的有哪些地方",
        "哪一段写了 2918 人",
        "安置房建设进度多少",
        "完成比例是多少",
        "资金投入多少钱",
    ],
    "improve": [
        "这份文档哪里需要改",
        "帮我看看有什么问题",
        "怎么优化这份文档",
        "文档写得怎么样",
        "有什么可以改进的地方",
        "给我一些修改建议",
        "哪里写得不好",
        "结构上有什么毛病",
        "帮我挑挑错",
        "这份汇报合不合格",
    ],
    "kb": [
        "知识库里规范怎么要求",
        "标准里是怎么写的",
        "有没有类似范文",
        "别人一般怎么写",
        "政策依据是什么",
        "按国家标准应该怎么写",
        "参考一下规范",
        "公文格式要求有哪些",
    ],
    "stats": [
        "这份文档有多少字",
        "一共几段",
        "有几个表格",
        "有多少张图片",
        "篇幅多长",
        "字数统计",
        "几级标题",
        "文档多大",
    ],
}

_NGRAM = (2, 3)


def _grams(text: str) -> list[str]:
    """字符 2–3 gram；中文按字切，无需分词器"""
    flat = re.sub(r"[\s，。、；：！？（）()\d]+", "", (text or "").lower())
    out: list[str] = []
    for n in _NGRAM:
        for i in range(max(0, len(flat) - n + 1)):
            out.append(flat[i : i + n])
    return out


def train() -> dict[str, Any]:
    """训练朴素贝叶斯；返回模型字典并落盘"""
    counts: dict[str, Counter[str]] = {k: Counter() for k in INTENTS}
    totals: dict[str, int] = defaultdict(int)
    docs: dict[str, int] = defaultdict(int)
    vocab: set[str] = set()

    for intent, samples in SEED.items():
        for text in samples:
            docs[intent] += 1
            for g in _grams(text):
                counts[intent][g] += 1
                totals[intent] += 1
                vocab.add(g)

    model = {
        "intents": list(INTENTS),
        "vocabSize": len(vocab),
        "docs": dict(docs),
        "counts": {k: dict(v) for k, v in counts.items()},
        "totals": dict(totals),
        "trainedAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
    }
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    MODEL_PATH.write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
    return model


_cache: dict[str, Any] | None = None


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    if MODEL_PATH.exists():
        try:
            _cache = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
            return _cache
        except json.JSONDecodeError:
            pass
    _cache = train()
    return _cache


def classify_intent(query: str) -> dict[str, Any]:
    """
    返回 {"intent": 最可能的意图, "confidence": 0~1, "scores": {意图: 概率}}
    置信度低于 0.35 时调用方应回退到关键词规则。
    """
    model = _load()
    grams = _grams(query)
    if not grams:
        return {"intent": "", "confidence": 0.0, "scores": {}}

    vocab_size = max(1, model["vocabSize"])
    total_docs = max(1, sum(model["docs"].values()))
    logp: dict[str, float] = {}

    for intent in model["intents"]:
        prior = math.log(max(1e-9, model["docs"].get(intent, 0) / total_docs))
        cnt = model["counts"].get(intent, {})
        denom = model["totals"].get(intent, 0) + vocab_size
        s = prior
        for g in grams:
            s += math.log((cnt.get(g, 0) + 1) / denom)
        logp[intent] = s

    # softmax 转概率
    mx = max(logp.values())
    exps = {k: math.exp(v - mx) for k, v in logp.items()}
    z = sum(exps.values()) or 1.0
    probs = {k: v / z for k, v in exps.items()}
    best = max(probs, key=probs.get)

    # 短句/生僻说法：置信度会被拉低，交给调用方回退
    return {"intent": best, "confidence": round(probs[best], 3), "scores": {k: round(v, 3) for k, v in probs.items()}}


def _demo() -> int:
    cases = [
        ("这份文档有什么问题", "improve"),
        ("文档里缺口有哪些", "fact"),
        ("第 2 部分讲了什么", "section"),
        ("知识库里规范怎么要求", "kb"),
        ("这份文档多少字", "stats"),
        ("帮我概括全文", "structure"),
        ("这个菜谱怎么做好吃", ""),
    ]
    print("模型词表:", _load()["vocabSize"], " 意图:", len(INTENTS))
    ok = 0
    for text, want in cases:
        r = classify_intent(text)
        hit = (r["intent"] == want) or (want == "" and r["confidence"] < 0.5)
        ok += 1 if hit else 0
        print(f"  {'OK ' if hit else 'ERR'} {text:<22} → {r['intent']:<10} 置信 {r['confidence']}")
    print(f"命中 {ok}/{len(cases)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_demo())
