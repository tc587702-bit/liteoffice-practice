"""
API 层：FastAPI（对应图上的「API 层：鉴权、限流、接口管理」）

路由：
  GET  /health              健康检查
  GET  /v1/tools            工具清单（Tool Registry 的可读视图）
  POST /v1/tools/{name}     直接调用某个工具（不经模型）
  POST /v1/agent/run        走 LangGraph 编排（规划 → 工具 → 回答）
  POST /v1/chat             纯对话（LiteLLM，无工具）
  GET  /v1/llm/info         当前模型配置与是否 mock

鉴权与限流（图上 API 层的职责）：
  · 可选 X-API-Token：设置 LITEOFFICE_API_TOKEN 后必须携带，否则 401
  · 简单限流：同一 IP 每分钟最多 60 次，超出 429
"""
from __future__ import annotations

import os
import time
from collections import defaultdict
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import feedback as FEEDBACK
from . import improve as IMPROVE
from . import review as REVIEW
from . import review_local as REVIEW_LOCAL
from . import kb as KB
from . import pipelines as PIPE
from .graph import run_agent
from .llm import complete
from .llm import info as llm_info
from .tools import run_tool, tool_manifest

API_TOKEN = os.getenv("LITEOFFICE_API_TOKEN", "")
RATE_LIMIT = int(os.getenv("LITEOFFICE_RATE_LIMIT", "60"))
WINDOW = 60.0

app = FastAPI(
    title="LiteOffice Agent API",
    version="0.1.0",
    description="按「AI Agent 技术栈」图实现：FastAPI（API 层）+ LangGraph（Agent 层）+ LiteLLM（模型层）",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 课程演示放开；生产应改为具体域名
    allow_methods=["*"],
    allow_headers=["*"],
)

_hits: dict[str, list[float]] = defaultdict(list)


def _check_token(token: str | None) -> None:
    if API_TOKEN and token != API_TOKEN:
        raise HTTPException(status_code=401, detail="缺少或错误的 X-API-Token")


def _rate_limit(ip: str) -> None:
    now = time.time()
    bucket = [t for t in _hits[ip] if now - t < WINDOW]
    if len(bucket) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail=f"请求过于频繁（每分钟上限 {RATE_LIMIT} 次）")
    bucket.append(now)
    _hits[ip] = bucket


class DocPayload(BaseModel):
    html: str = Field("", description="当前文档的 HTML")
    query: str = Field("", description="用户指令")


class ChatPayload(BaseModel):
    messages: list[dict[str, str]]
    model: str | None = None
    temperature: float = 0.3
    max_tokens: int = 800


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path.startswith("/v1") and request.url.path != "/v1/llm/info":
        ip = (request.client.host if request.client else "unknown") or "unknown"
        try:
            _rate_limit(ip)
        except HTTPException as exc:
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return await call_next(request)


# ---------------- 会话级跨轮记忆（只存内存，不落盘） ----------------

_SESSIONS: dict[str, dict[str, Any]] = {}
SESSION_TTL = 30 * 60          # 30 分钟
SESSION_LIMIT = 200            # 条目上限


def _session_get(session_id: str) -> dict[str, Any] | None:
    if not session_id:
        return None
    rec = _SESSIONS.get(session_id)
    if not rec:
        return None
    if time.time() - rec.get("ts", 0) > SESSION_TTL:
        _SESSIONS.pop(session_id, None)
        return None
    return rec


def _session_put(session_id: str, record: dict[str, Any]) -> None:
    """写入会话记录；超上限时按 ts 淘汰最旧（不存 html，只存摘要）"""
    if not session_id:
        return
    _SESSIONS[session_id] = {**record, "ts": time.time()}
    if len(_SESSIONS) > SESSION_LIMIT:
        oldest = sorted(_SESSIONS.items(), key=lambda kv: kv[1].get("ts", 0))
        for key, _ in oldest[: len(_SESSIONS) - SESSION_LIMIT]:
            _SESSIONS.pop(key, None)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "liteoffice-agent", "version": "0.1.0"}


@app.get("/v1/tools")
def tools() -> dict[str, Any]:
    return {"tools": tool_manifest(), "count": len(tool_manifest())}


@app.post("/v1/tools/{name}")
def call_tool(name: str, payload: DocPayload, x_api_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_api_token)
    result = run_tool(name, payload.html, {"query": payload.query} if payload.query else {})
    return {
        "ok": result.ok,
        "tool": result.tool,
        "summary": result.summary,
        "data": result.data,
    }


@app.post("/v1/agent/run")
def agent_run(payload: DocPayload, x_api_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_api_token)
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="query 不能为空")
    return run_agent(payload.html, payload.query)


@app.post("/v1/chat")
def chat(payload: ChatPayload, x_api_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_api_token)
    res = complete(payload.messages, model=payload.model, temperature=payload.temperature, max_tokens=payload.max_tokens)
    return {"ok": res.ok, "text": res.text, "model": res.model, "mock": res.mock, "error": res.error}


@app.get("/v1/llm/info")
def llm_information() -> dict[str, Any]:
    return llm_info()

# ---------------- 知识库（共享） ----------------

ADMIN_TOKEN = os.getenv("LITEOFFICE_ADMIN_TOKEN", "")
DEFAULT_KB = os.getenv("LITEOFFICE_KB_ID", "kb_shared")


def _require_admin(token: str | None) -> None:
    """写操作保护：设置了 LITEOFFICE_ADMIN_TOKEN 就必须带对；未设置则放开（仅课程演示）。"""
    if ADMIN_TOKEN and token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="需要管理口令（X-Admin-Token）")


class KbDocPayload(BaseModel):
    name: str = Field(..., description="文件名")
    content: str = Field(..., description="文档内容（HTML 或纯文本）")


class KbTermPayload(BaseModel):
    terms: list[dict]


class KbQueryPayload(BaseModel):
    query: str
    topK: int = 5


class KbEvidencePayload(BaseModel):
    selection: str
    topK: int = 3


@app.get("/v1/kb/{kb_id}/stats")
def kb_stats(kb_id: str) -> dict[str, Any]:
    return {
        "kbId": kb_id,
        "visibility": "public",
        "adminOpen": ADMIN_TOKEN == "",
        "stats": KB.kb_stats(kb_id),
    }


@app.get("/v1/kb/{kb_id}/documents")
def kb_documents(kb_id: str) -> dict[str, Any]:
    return {"documents": KB.list_documents(kb_id)}


@app.post("/v1/kb/{kb_id}/documents", status_code=201)
def kb_add_document(
    kb_id: str,
    payload: KbDocPayload,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(x_admin_token)
    r = KB.add_document(kb_id, payload.name, payload.content)
    return {**r, "stats": KB.kb_stats(kb_id)}


@app.delete("/v1/kb/{kb_id}/documents/{doc_id}")
def kb_delete_document(
    kb_id: str,
    doc_id: str,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(x_admin_token)
    ok = KB.delete_document(doc_id)
    return {"ok": ok, "stats": KB.kb_stats(kb_id)}


@app.post("/v1/kb/{kb_id}/terms")
def kb_add_terms(
    kb_id: str,
    payload: KbTermPayload,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(x_admin_token)
    n = KB.add_terms(kb_id, payload.terms)
    return {"added": n, "stats": KB.kb_stats(kb_id)}


@app.post("/v1/kb/{kb_id}/search")
def kb_search(kb_id: str, payload: KbQueryPayload) -> dict[str, Any]:
    """出口 A：问答用 —— 返回相关段落 + 出处。"""
    hits = KB.search(kb_id, payload.query, top_k=payload.topK)
    return {"query": payload.query, "hits": hits, "count": len(hits)}


@app.post("/v1/kb/{kb_id}/evidence")
def kb_evidence(kb_id: str, payload: KbEvidencePayload) -> dict[str, Any]:
    """出口 B：改写用 —— 返回术语 + 规范片段，供拼 prompt。"""
    return KB.build_evidence(kb_id, payload.selection, top_k=payload.topK)


@app.get("/v1/kb")
def kb_list() -> dict[str, Any]:
    """当前部署的知识库列表（共享库只有一个也返回数组，便于扩展）。"""
    return {
        "kbs": [
            {
                "id": DEFAULT_KB,
                "name": "共享知识库",
                "visibility": "public",
                "stats": KB.kb_stats(DEFAULT_KB),
            }
        ]
    }

# ---------------- 固定链路：问答 / 专业改写 ----------------

class QaPayload(BaseModel):
    question: str
    topK: int = 5
    model: str | None = None
    html: str = ""          # 当前文档（可选）；为空时只查知识库
    docTopK: int = 3


class RewritePayload(BaseModel):
    selection: str
    genre: str | None = None
    context: str = ""        # 选区前后各 200 字（可选）
    topK: int = 3
    model: str | None = None


@app.post("/v1/kb/{kb_id}/qa")
def kb_qa(kb_id: str, payload: QaPayload) -> dict[str, Any]:
    return PIPE.qa(
        kb_id,
        payload.question,
        model=payload.model,
        top_k=payload.topK,
        doc_html=payload.html,
        doc_top_k=payload.docTopK,
    )


@app.post("/v1/kb/{kb_id}/rewrite")
def kb_rewrite(kb_id: str, payload: RewritePayload) -> dict[str, Any]:
    return PIPE.rewrite(
        kb_id,
        payload.selection,
        genre=payload.genre,
        model=payload.model,
        top_k=payload.topK,
        context=payload.context,
    )

class ImprovePayload(BaseModel):
    html: str


@app.post("/v1/doc/improve")
def doc_improve_route(payload: ImprovePayload) -> dict[str, Any]:
    """文档优化建议：分数 + 带位置的问题清单"""
    return IMPROVE.analyze(payload.html)

class FeedbackPayload(BaseModel):
    fingerprint: str = ""
    rule: str
    snippet: str = ""
    action: str = "dismiss"      # dismiss=不用改 / accept=确实要改
    genre: str = ""


@app.post("/v1/doc/feedback")
def doc_feedback(payload: FeedbackPayload) -> dict[str, Any]:
    """记录「这条不用改」之类的反馈，下次检查同一处不再报"""
    if not payload.fingerprint:
        return {"ok": False, "reason": "缺少文档指纹"}
    return FEEDBACK.record(
        payload.fingerprint,
        payload.rule,
        payload.snippet or payload.rule,
        action=payload.action,
        genre=payload.genre,
    )


@app.get("/v1/doc/feedback/stats")
def doc_feedback_stats() -> dict[str, Any]:
    """反馈汇总：被否最多的规则，用于后续自动降级"""
    return FEEDBACK.stats()

class ReviewPayload(BaseModel):
    html: str
    genre: str | None = None
    model: str | None = None
    maxSections: int = 3
    mode: str = "local"       # local=本机模型（默认，不联网） / cloud=调用云端模型


@app.post("/v1/doc/review")
def doc_review(payload: ReviewPayload) -> dict[str, Any]:
    """
    深度分析：给出具体问题 + 可直接采用的改写。

    mode=local（默认）走本机 1.5B 模型，不发出任何网络请求；
    mode=cloud 才调用云端模型。未装本地模型时如实报错，绝不偷偷走云。
    """
    if payload.mode == "cloud":
        return REVIEW.review(
            payload.html,
            genre=payload.genre,
            model=payload.model,
            max_sections=max(1, min(payload.maxSections, 10)),
        )
    out = REVIEW_LOCAL.review_local(
        payload.html,
        genre=payload.genre,
        max_sections=max(1, min(payload.maxSections, 6)),
    )
    return out


@app.get("/v1/doc/review/status")
def doc_review_status() -> dict[str, Any]:
    """本地模型是否就绪（前端据此禁用/启用「离线深度分析」按钮）"""
    return {
        "localAvailable": REVIEW_LOCAL.available(),
        "model": "qwen2.5-1.5b-instruct",
        "modelDir": str(REVIEW_LOCAL.MODEL_DIR),
    }
