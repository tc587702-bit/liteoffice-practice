"""
向量层：为 kb_chunk.vec 填充向量，并提供向量检索与混合检索。

与现有代码的关系（不破坏任何既有行为）：
  · 不改 app/kb.py 的 BM25 内核与 search() 签名
  · 融合复用 app/query_expand.py 的 rrf_merge()（按 chunkId 排名融合，无需调权重）
  · 返回结构与 kb.search() 完全一致，可直接替换或并联使用

为什么单独一层：
  embedding 后端（本地 ONNX / 云端 API / 外部算好灌入）差别很大，
  但「向量怎么存、怎么校验、怎么融合」是稳定的。稳定部分固化在这里，
  后端可换，检索口径不变。

向量进入库的三种方式：
  ① embed_pending()        传一个 embedder，自动补齐库里所有空向量
  ② set_vectors()          直接给 {chunk_id: [float, ...]} 写入 —— 「直接向库中输入」
  ③ import_vectors_file()  从 JSON 文件批量灌入，供外部工具 / 脚本 / notebook 使用

一个 kb 只用一种 embedding 模型（换模型请重建向量）。
维度在写入与检索两端都强校验，防止不同维度混存导致余弦计算出错或静默产出垃圾结果。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import struct
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from . import kb
from .query_expand import search_expanded

# 一个 kb 内允许的向量维度（写入时记录，检索时校验）
DEFAULT_DIM = 512

# 混合检索的向量相似度下限。
#
# 由 11 个文体库实测标定（22 个相关查询 + 33 个无关查询）：
#   0.35 → 漏相关 0/22，放进无关 7/33
#   0.38 → 漏相关 0/22，放进无关 3/33   ← 取这个
#   0.40 → 漏相关 1/22，放进无关 1/33
#   0.45 → 漏相关 3/22，放进无关 0/33（原默认值，议论文/记叙文的正确命中被滤掉）
# bge-small-zh 在 2-3 字中文短查询上分数天然偏低（「论点」0.4467、「细节描写」0.3999），
# 用 0.45 会把它们全判成「无命中」。改这个值前请重新跑分布标定，别凭感觉调。
MIN_SIM_DEFAULT = 0.38


# ---------------------------------------------------------------- 向量编解码

def vec_to_blob(vec: Sequence[float]) -> bytes:
    """list[float] → float32 小端字节串（存入 kb_chunk.vec）"""
    return struct.pack(f"<{len(vec)}f", *(float(x) for x in vec))


def blob_to_vec(blob: bytes | None) -> list[float]:
    """float32 小端字节串 → list[float]；空值返回 []"""
    if not blob:
        return []
    if len(blob) % 4:
        raise ValueError(f"向量字节数 {len(blob)} 不是 4 的倍数，不是合法的 float32 序列")
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


def normalize(vec: Sequence[float]) -> list[float]:
    """L2 归一化：归一化后余弦相似度等于点积，检索时可省一次开方"""
    norm = math.sqrt(sum(float(x) * float(x) for x in vec))
    if norm == 0.0:
        return [0.0] * len(vec)
    return [float(x) / norm for x in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """余弦相似度（输入未归一化时也正确）"""
    if len(a) != len(b):
        raise ValueError(f"维度不一致：{len(a)} vs {len(b)}，不能计算相似度")
    dot = sum(float(x) * float(y) for x, y in zip(a, b))
    na = math.sqrt(sum(float(x) * float(x) for x in a))
    nb = math.sqrt(sum(float(y) * float(y) for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------- 模型清单（旁路，不改表结构）

def _manifest_path() -> Path:
    """模型清单与库文件同目录；不用 ALTER TABLE，避免改动既有 schema"""
    return Path(str(kb.DB_PATH) + ".vecmeta.json")


def read_manifest() -> dict[str, Any]:
    p = _manifest_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def write_manifest(model: str, dim: int) -> dict[str, Any]:
    m = read_manifest()
    m.update({"model": model, "dim": int(dim), "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
    _manifest_path().write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    return m


def _check_dim(dim: int) -> None:
    """维度冲突时直接报错，不静默混存"""
    m = read_manifest()
    recorded = int(m.get("dim") or 0)
    if recorded and recorded != dim:
        raise ValueError(
            f"维度冲突：库里已记录 {recorded} 维（模型 {m.get('model')}），"
            f"本次要写 {dim} 维。换模型请先清空向量：clear_vectors()"
        )


# ---------------------------------------------------------------- 写入通道

def list_chunks(kb_id: str, only_missing: bool = False) -> list[dict[str, Any]]:
    """
    列出待向量化的块。only_missing=True 时只返回 vec 为空的。

    返回项含 embedText —— 这是真正送去 embedding 的文本，
    默认带章节标题前缀（见 embed_text_of 的说明）。
    """
    conn = kb.connect()
    sql = """SELECT c.id, c.doc_id, c.ord, c.text, c.heading, d.name AS doc_name
             FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id
             WHERE c.kb_id = ?"""
    if only_missing:
        sql += " AND c.vec IS NULL"
    sql += " ORDER BY d.name, c.ord"
    rows = conn.execute(sql, (kb_id,)).fetchall()
    conn.close()
    return [
        {
            "chunkId": r["id"],
            "docId": r["doc_id"],
            "docName": r["doc_name"],
            "ord": r["ord"],
            "heading": r["heading"],
            "text": r["text"],
            "embedText": embed_text_of(r["text"], r["heading"]),
        }
        for r in rows
    ]


def embed_text_of(text: str, heading: str = "") -> str:
    """
    构造送去 embedding 的文本：章节标题 + 正文。

    为什么要拼标题：库里 heading 与 text 是两个独立列（kb.py:278-281），
    若只向量化 text，「三、保障措施」下面那段正文的向量里不含"保障措施"这个语义，
    用户问"保障措施有哪些"就会召回不到。拼上标题是公文语料最划算的一处改进。
    """
    body = (text or "").strip()
    head = (heading or "").strip()
    if not head or head in body[: len(head) + 4]:
        return body
    return f"{head}\n{body}"


def set_vectors(
    kb_id: str,
    vectors: dict[str, Sequence[float]],
    model: str = "unknown",
    dim: int | None = None,
) -> dict[str, Any]:
    """
    直接向库中输入向量：{chunk_id: [float, ...]}。

    · 自动 L2 归一化后写入（检索时点积即余弦）
    · 校验维度一致性，且只接受属于该 kb 的 chunk_id
    · 不认识的 id 不写入，原样回报，避免静默丢失
    """
    if not vectors:
        return {"ok": False, "written": 0, "reason": "没有要写入的向量"}

    observed = {len(v) for v in vectors.values()}
    if len(observed) != 1:
        return {"ok": False, "written": 0, "reason": f"传入向量维度不统一：{sorted(observed)}"}
    real_dim = dim or observed.pop()
    try:
        _check_dim(real_dim)
    except ValueError as exc:
        # 维度冲突要让调用方看到 ok=False 而不是抛异常中断建库流程
        return {"ok": False, "written": 0, "reason": str(exc)}

    conn = kb.connect()
    valid = {
        r["id"]
        for r in conn.execute("SELECT id FROM kb_chunk WHERE kb_id = ?", (kb_id,)).fetchall()
    }
    unknown = [cid for cid in vectors if cid not in valid]
    payload = [
        (vec_to_blob(normalize(v)), cid) for cid, v in vectors.items() if cid in valid
    ]
    try:
        with conn:
            conn.executemany("UPDATE kb_chunk SET vec = ? WHERE id = ?", payload)
    finally:
        conn.close()

    write_manifest(model, real_dim)
    return {
        "ok": True,
        "written": len(payload),
        "skipped": len(unknown),
        "unknownIds": unknown[:10],
        "dim": real_dim,
        "model": model,
    }


def embed_pending(
    kb_id: str,
    embedder: Callable[[list[str]], list[list[float]]],
    model: str = "unknown",
    batch: int = 16,
) -> dict[str, Any]:
    """
    补齐库里所有空向量。embedder 签名：一批文本 → 一批向量（顺序对应）。

    分批是为了控制单次请求体积；失败时已写入的批次保留，可重复调用续传。
    """
    todo = list_chunks(kb_id, only_missing=True)
    if not todo:
        return {"ok": True, "written": 0, "pending": 0, "reason": "没有待向量化的块"}

    written = 0
    for i in range(0, len(todo), batch):
        group = todo[i : i + batch]
        vecs = embedder([c["embedText"] for c in group])
        if len(vecs) != len(group):
            return {
                "ok": False,
                "written": written,
                "reason": f"embedder 返回 {len(vecs)} 条，与输入 {len(group)} 条不一致",
            }
        r = set_vectors(kb_id, {c["chunkId"]: v for c, v in zip(group, vecs)}, model=model)
        if not r["ok"]:
            return {"ok": False, "written": written, "reason": r.get("reason", "写入失败")}
        written += r["written"]

    return {"ok": True, "written": written, "pending": 0, "model": model}


def import_vectors_file(kb_id: str, path: str | Path, model: str = "unknown") -> dict[str, Any]:
    """
    从 JSON 文件灌入向量，供外部工具（JS / notebook / 其他语言的脚本）使用。

    文件格式二选一：
      {"chunkId1": [0.1, ...], "chunkId2": [...]}
      [{"chunkId": "...", "vec": [...]}, ...]
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        vectors = {k: v for k, v in data.items() if isinstance(v, list)}
    elif isinstance(data, list):
        vectors = {d["chunkId"]: d["vec"] for d in data if d.get("chunkId") and d.get("vec")}
    else:
        return {"ok": False, "written": 0, "reason": "JSON 顶层必须是对象或数组"}
    return set_vectors(kb_id, vectors, model=model)


def clear_vectors(kb_id: str) -> int:
    """清空该 kb 的全部向量（换 embedding 模型时用）"""
    conn = kb.connect()
    try:
        with conn:
            cur = conn.execute("UPDATE kb_chunk SET vec = NULL WHERE kb_id = ?", (kb_id,))
            n = cur.rowcount
    finally:
        conn.close()
    p = _manifest_path()
    if p.exists():
        p.unlink()
    return n


def vector_stats(kb_id: str) -> dict[str, Any]:
    """向量覆盖情况：已填 / 待填 / 维度是否一致"""
    conn = kb.connect()
    row = conn.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN vec IS NULL THEN 1 ELSE 0 END) AS missing,
                  MIN(LENGTH(vec)) AS min_len, MAX(LENGTH(vec)) AS max_len
             FROM kb_chunk WHERE kb_id = ?""",
        (kb_id,),
    ).fetchone()
    conn.close()
    dims = set()
    for n in (row["min_len"], row["max_len"]):
        if n:
            dims.add(n // 4)
    return {
        "total": row["total"] or 0,
        "embedded": (row["total"] or 0) - (row["missing"] or 0),
        "missing": row["missing"] or 0,
        "dims": sorted(dims),
        "consistent": len(dims) <= 1,
        "manifest": read_manifest(),
    }


# ---------------------------------------------------------------- 检索

def vector_search(kb_id: str, query_vec: Sequence[float], top_k: int = 5, min_sim: float = 0.0) -> list[dict[str, Any]]:
    """
    纯向量检索。返回结构与 kb.search() 一致，可直接喂给 rrf_merge。

    147 块量级用暴力扫描：全量点积在毫秒级，不需要 ANN 索引
    （HNSW/IVF 是千万级才划算，小库上近似误差反而是净损失）。
    """
    conn = kb.connect()
    rows = conn.execute(
        """SELECT c.id, c.doc_id, c.ord, c.text, c.heading, c.vec, d.name AS doc_name
           FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id
           WHERE c.kb_id = ? AND c.vec IS NOT NULL""",
        (kb_id,),
    ).fetchall()
    conn.close()
    if not rows:
        return []

    q = normalize(query_vec)
    scored: list[tuple[float, sqlite3.Row]] = []
    for r in rows:
        v = blob_to_vec(r["vec"])
        if len(v) != len(q):
            # 维度不一致说明混了模型，跳过该块而不是让整次检索崩掉
            continue
        scored.append((sum(a * b for a, b in zip(q, v)), r))
    scored.sort(key=lambda x: -x[0])

    # 低于阈值的命中不返回：语义检索几乎不会返回空，不加门槛时
    # 「火星探测器着陆点」也能召回 0.34 分的无关段落，让「无命中就拒答」失效
    kept = [(s, r) for s, r in scored if s >= min_sim]

    return [
        {
            "chunkId": r["id"],
            "docId": r["doc_id"],
            "docName": r["doc_name"],
            "ord": r["ord"],
            "heading": r["heading"],
            "text": r["text"],
            "score": round(s, 4),
        }
        for s, r in kept[:top_k]
    ]


def _weighted_rrf(result_lists: list[list[dict]], weights: list[float], top_k: int) -> list[dict]:
    """加权 RRF：score = Σ w_i / (k + rank_i)，k 取 60 与 query_expand.rrf_merge 一致"""
    score: dict[str, float] = {}
    store: dict[str, dict] = {}
    for hits, weight in zip(result_lists, weights):
        for rank, hit in enumerate(hits, 1):
            key = str(hit.get("chunkId") or hit.get("id") or "")
            score[key] = score.get(key, 0.0) + weight / (60 + rank)
            store.setdefault(key, hit)
    order = sorted(score, key=lambda x: -score[x])[:top_k]
    return [store[key] for key in order]


def hybrid_search(
    kb_id: str,
    query: str,
    embedder: Callable[[list[str]], list[list[float]]] | None = None,
    top_k: int = 5,
    per_side: int = 10,
    weights: tuple[float, float] = (1.0, 0.2),
    min_sim: float = MIN_SIM_DEFAULT,
    groups: list[list[str]] | None = None,
) -> dict[str, Any]:
    """
    混合检索：BM25（带同义扩展）∪ 向量 → RRF 融合。

    · BM25 侧走 search_expanded；groups 传入时用该文体自己的同义词组。
      多文体场景必须传，否则会用全局词表，把「绿色工厂」等外域词混进来。
    · 向量侧用原始 query（语义召回本身就能覆盖同义改写，再扩展只增加成本）
    · 融合复用现成的 rrf_merge，两路分数不可比的问题由「排名」绕开

    embedder 为 None 时自动退化为纯 BM25，返回里标明 fallback 原因。
    """
    bm25_hits, variants = search_expanded(kb, kb_id, query, top_k=per_side, groups=groups)

    vec_hits: list[dict[str, Any]] = []
    fallback = ""
    if embedder is None:
        fallback = "未提供 embedder，本次只有 BM25 一路"
    else:
        qvecs = embedder([query])
        if qvecs:
            vec_hits = vector_search(kb_id, qvecs[0], top_k=per_side, min_sim=min_sim)
        if not vec_hits:
            # 区分「没建向量」和「建了但都低于阈值」——两者处置完全不同。
            # 原来一律说「可能还没建向量」，把阈值问题误导向重建向量，白跑一遍。
            vs = vector_stats(kb_id)
            if not vs["embedded"]:
                fallback = "向量路无命中：该库还没有向量（先跑 tools/build_vectors.py）"
            else:
                top = vector_search(kb_id, qvecs[0], top_k=1, min_sim=0.0) if qvecs else []
                best = f"{top[0]['score']:.4f}" if top else "-"
                fallback = (
                    f"向量路无命中：已有 {vs['embedded']}/{vs['total']} 块向量，"
                    f"但最高相似度 {best} 低于阈值 {min_sim}"
                )

    fused = _weighted_rrf([bm25_hits, vec_hits], list(weights), top_k) if (bm25_hits and vec_hits) else (bm25_hits or vec_hits)[:top_k]

    return {
        "hits": fused,
        "query": query,
        "variants": variants,
        "bm25Count": len(bm25_hits),
        "vectorCount": len(vec_hits),
        "fallback": fallback,
    }


# ---------------------------------------------------------------- embedding 后端（可插拔）

class HashEmbedder:
    """
    确定性哈希 embedding：无依赖、可复现，用于自测与离线演示。

    原理是把 2-gram 哈希投影到固定维度。它**不是**语义模型 ——
    能区分字面重合度，但抓不到"补贴/补助"这类同义关系。
    只用于验证「写入 → 校验 → 检索 → 融合」链路，不代表真实召回质量。
    """

    def __init__(self, dim: int = 64, model_name: str = "hash-2gram") -> None:
        self.dim = dim
        self.model_name = model_name

    def __call__(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        flat = "".join((text or "").split()).lower()
        grams = [flat[i : i + 2] for i in range(len(flat) - 1)] or [flat]
        for g in grams:
            h = int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16)
            vec[h % self.dim] += 1.0 if (h >> 8) % 2 else -1.0
        return normalize(vec)


def make_onnx_embedder(model_dir: str | Path, dim: int = DEFAULT_DIM) -> Callable[[list[str]], list[list[float]]]:
    """
    本地 ONNX Runtime 后端（需要 pip install onnxruntime，并自备模型文件）。

    惰性导入：没装 onnxruntime 时，本模块其余部分照常可用。
    未在本项目环境实测，接入时需先验证分词器与池化方式与模型匹配。
    """

    def embed(texts: list[str]) -> list[list[float]]:
        import onnxruntime  # noqa: F401 惰性导入，避免硬依赖

        raise NotImplementedError(
            "ONNX 后端需按所选模型补全 tokenizer 与池化：\n"
            f"  模型目录 {model_dir}\n  目标维度 {dim}\n"
            "步骤：加载 tokenizer → session.run → mean pooling → normalize。\n"
            "接入后请先用 vector_stats() 校验维度一致，再跑评测对比 recall。"
        )

    return embed


def make_api_embedder(model: str = "text-embedding-3-small") -> Callable[[list[str]], list[list[float]]]:
    """
    云端 API 后端（复用已有依赖 litellm，见 requirements.txt）。

    注意：走这条路，块文本会离开本机。与 README.md:3「文件不上传到任何服务器」
    的承诺冲突，启用前需要先确认是否接受该取舍。
    """

    def embed(texts: list[str]) -> list[list[float]]:
        import litellm

        res = litellm.embedding(model=model, input=list(texts))
        return [item["embedding"] for item in res.data]

    return embed


# ---------------------------------------------------------------- 自测

def _selftest() -> int:
    """
    在【临时库】上跑通「写入 → 校验 → 检索 → 融合」全链路。

    ⚠️ 绝不碰生产库。本函数会临时把 kb.DB_PATH 指向一个 temp 目录里的
    新文件，灌入两份小测试文档，跑完所有断言后还原并删除临时文件。
    这样 `python -m app.embed` 可随时安全运行，不会污染真实语料。
    （旧版直接对传入的 kb_id 写入，曾把哈希向量灌进生产库——已修正。）
    """
    import tempfile

    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    kb_id = "_selftest"
    original_db = kb.DB_PATH
    tmpdir = tempfile.mkdtemp(prefix="embed-selftest-")
    tmp_db = Path(tmpdir) / "selftest.db"

    try:
        # 把 kb 的连接目标改到临时库；kb.connect() 每次调用都读 kb.DB_PATH，故生效
        kb.DB_PATH = str(tmp_db)
        kb.ensure_kb(kb_id, name="自测库")
        kb.add_document(
            kb_id, "测试文档A.txt",
            "<h2>一、总体要求</h2><p>为切实做好征地拆迁安置工作，现提出如下要求。</p>"
            "<p>补偿资金应按时足额发放，牵头部门负责督办。</p>",
        )
        kb.add_document(
            kb_id, "测试文档B.txt",
            "<h2>二、保障措施</h2><p>建立领导小组，明确责任与时限。</p>"
            "<table><tr><th>项目</th><th>金额</th></tr><tr><td>补偿款</td><td>120万元</td></tr></table>",
        )

        chunks = list_chunks(kb_id)
        print("\n=== 0) 临时库准备 ===")
        print(f"  临时库：{tmp_db}")
        print(f"  块总数 {len(chunks)}；向量情况 {vector_stats(kb_id)}")
        if not chunks:
            check("临时库应能建块", False, "add_document 未产出块")
            return len(fails) or 1

        print("\n=== 1) 编解码往返 ===")
        src = [0.1, -0.25, 3.0, 0.0]
        back = blob_to_vec(vec_to_blob(src))
        check("float32 往返一致", all(abs(a - b) < 1e-6 for a, b in zip(src, back)), str(back))
        check("空 blob 返回空表", blob_to_vec(None) == [] and blob_to_vec(b"") == [])

        print("\n=== 2) 归一化与余弦 ===")
        n = normalize([3.0, 4.0])
        check("归一化后模长为 1", abs(math.sqrt(sum(x * x for x in n)) - 1.0) < 1e-6, str(n))
        check("同向余弦为 1", abs(cosine([1, 2], [2, 4]) - 1.0) < 1e-6)
        check("正交余弦为 0", abs(cosine([1, 0], [0, 1])) < 1e-6)
        check("零向量不崩", cosine([0, 0], [1, 1]) == 0.0)

        print("\n=== 3) 维度校验 ===")
        try:
            cosine([1, 2], [1, 2, 3])
            check("维度不一致应报错", False)
        except ValueError:
            check("维度不一致应报错", True)
        try:
            blob_to_vec(b"\x01\x02\x03")
            check("非 4 倍数字节应报错", False)
        except ValueError:
            check("非 4 倍数字节应报错", True)

        print("\n=== 4) embedText 带章节标题 ===")
        check("有标题时拼在前面", embed_text_of("正文内容", "三、保障措施").startswith("三、保障措施"))
        check("无标题时原样", embed_text_of("正文内容", "") == "正文内容")
        check("标题已在正文开头则不重复", embed_text_of("三、保障措施 正文", "三、保障措施") == "三、保障措施 正文")

        print("\n=== 5) 写入向量（写入临时库）===")
        emb = HashEmbedder()
        r = embed_pending(kb_id, emb, model=emb.model_name)
        check("embed_pending 成功", r.get("ok") is True, str(r))
        st = vector_stats(kb_id)
        check("向量已全部填充", st["missing"] == 0, f"已填 {st['embedded']}/{st['total']}")
        check("维度一致", st["consistent"], str(st["dims"]))
        check("清单已记录模型", st["manifest"].get("model") == emb.model_name, str(st["manifest"]))

        print("\n=== 6) 重复调用不重算 ===")
        r2 = embed_pending(kb_id, emb, model=emb.model_name)
        check("第二次没有待处理块", r2.get("written") == 0, str(r2))

        print("\n=== 7) 非法输入被拒 ===")
        bad = set_vectors(kb_id, {"不存在的id": [0.1] * emb.dim}, model=emb.model_name)
        check("未知 chunkId 不写入", bad.get("written") == 0 and bad.get("skipped") == 1, str(bad))
        mixed = set_vectors(kb_id, {chunks[0]["chunkId"]: [0.1, 0.2]}, model=emb.model_name)
        check("维度冲突被拒绝", mixed.get("ok") is False and "维度冲突" in str(mixed.get("reason")), str(mixed))

        print("\n=== 8) 向量检索 ===")
        target = chunks[0]
        hits = vector_search(kb_id, emb([target["embedText"]])[0], top_k=3)
        check("检索有结果", len(hits) > 0, f"命中 {len(hits)}")
        check("自身排第一", bool(hits) and hits[0]["chunkId"] == target["chunkId"], hits[0]["docName"] if hits else "-")
        check("返回结构含 chunkId 与 score", bool(hits) and "chunkId" in hits[0] and "score" in hits[0])
        check("分数在 [-1,1]", bool(hits) and all(-1.0 <= h["score"] <= 1.0 for h in hits))

        print("\n=== 9) 混合检索与 RRF 融合 ===")
        hy = hybrid_search(kb_id, "征地拆迁安置补偿", emb, top_k=5)
        check("融合有结果", len(hy["hits"]) > 0, f"BM25 {hy['bm25Count']} / 向量 {hy['vectorCount']}")
        check("两路都参与", hy["bm25Count"] > 0 and hy["vectorCount"] > 0)
        check("结果不超过 top_k", len(hy["hits"]) <= 5)
        deg = hybrid_search(kb_id, "征地拆迁安置补偿", None, top_k=5)
        check("无 embedder 时退化并标注", deg["fallback"] != "" and len(deg["hits"]) >= 0, deg["fallback"])
    finally:
        # 还原连接目标，并删除临时库与 vecmeta，绝不留痕
        kb.DB_PATH = original_db
        for suffix in ("", "-wal", "-shm", ".vecmeta.json"):
            p = Path(str(tmp_db) + suffix)
            if p.exists():
                p.unlink()
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass

    print(f"\n结果：{'全部通过' if not fails else '失败 ' + str(len(fails)) + ' 项：' + '、'.join(fails)}")
    print(f"（自测在临时库运行，生产库 {original_db} 未被触碰）")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(1 if _selftest() else 0)
