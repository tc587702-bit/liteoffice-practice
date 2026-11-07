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
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .llm import complete, info as llm_info
from . import kb as KB
from .graph import run_agent
from .tools import run_tool, tool_manifest
from .errors import AppError, BadRequest, RateLimited, Unauthorized
from .error_handlers import install_error_handlers
from .logging_conf import get_logger, request_id_ctx, setup_logging

API_TOKEN = os.getenv("LITEOFFICE_API_TOKEN", "")
RATE_LIMIT = int(os.getenv("LITEOFFICE_RATE_LIMIT", "60"))
WINDOW = 60.0

setup_logging()
log = get_logger("main")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """启动/关闭只做「可观测」的事：打印配置、预热知识库、记录退出。"""
    log.info(
        "Agent 服务启动",
        version="0.1.0",
        rateLimit=RATE_LIMIT,
        authEnabled=bool(API_TOKEN),
        adminAuthEnabled=bool(os.getenv("LITEOFFICE_ADMIN_TOKEN", "")),
        llm=llm_info(),
    )
    try:
        stats = KB.kb_stats(os.getenv("LITEOFFICE_KB_ID", "kb_shared"))
        log.info("知识库就绪", stats=stats)
    except Exception:
        # 知识库不可用不应阻止聊天/工具类接口启动，但必须记录
        log.exception("知识库初始化检查失败")
    yield
    log.info("Agent 服务关闭")


app = FastAPI(
    title="LiteOffice Agent API",
    version="0.1.0",
    description="按「AI Agent 技术栈」图实现：FastAPI（API 层）+ LangGraph（Agent 层）+ LiteLLM（模型层）",
    lifespan=lifespan,
)

install_error_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 课程演示放开；生产应改为具体域名
    allow_methods=["*"],
    allow_headers=["*"],
)

_hits: dict[str, list[float]] = defaultdict(list)


def _check_token(token: str | None) -> None:
    if API_TOKEN and token != API_TOKEN:
        raise Unauthorized("缺少或错误的 X-API-Token", code="BAD_API_TOKEN")


def _rate_limit(ip: str) -> None:
    now = time.time()
    bucket = [t for t in _hits[ip] if now - t < WINDOW]
    if len(bucket) >= RATE_LIMIT:
        raise RateLimited(f"请求过于频繁（每分钟上限 {RATE_LIMIT} 次）")
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
async def request_context(request: Request, call_next):
    """
    请求级横切：分配 requestId → 限流 → 计时 → 访问日志 → 兜底异常。

    注意：中间件里抛出的异常不会被 FastAPI 的 exception_handler 捕获，
    因此这里的兜底是必须的，否则会变成无日志的 500 或直接断开连接。
    """
    rid = (request.headers.get("x-request-id") or uuid.uuid4().hex)[:64]
    token = request_id_ctx.set(rid)
    started = time.perf_counter()
    req_log = log.child(path=request.url.path, method=request.method)
    try:
        if request.url.path.startswith("/v1") and request.url.path != "/v1/llm/info":
            ip = (request.client.host if request.client else "unknown") or "unknown"
            try:
                _rate_limit(ip)
            except AppError as exc:
                req_log.warning("触发限流", ip=ip, code=exc.code, limit=RATE_LIMIT)
                return JSONResponse(
                    {"detail": exc.message, "code": exc.code, "requestId": rid},
                    status_code=exc.status_code,
                    headers={"X-Request-Id": rid},
                )

        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        req_log.info(
            "请求完成",
            status=response.status_code,
            durationMs=round((time.perf_counter() - started) * 1000, 1),
        )
        return response
    except Exception as exc:  # noqa: BLE001 —— 这里就是要兜住所有异常
        req_log.exception(
            "请求处理异常（中间件层兜底）",
            errorType=type(exc).__name__,
            error=str(exc),
            durationMs=round((time.perf_counter() - started) * 1000, 1),
        )
        return JSONResponse(
            {"detail": "服务器内部错误", "code": "INTERNAL", "requestId": rid},
            status_code=500,
            headers={"X-Request-Id": rid},
        )
    finally:
        request_id_ctx.reset(token)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "liteoffice-agent", "version": "0.1.0"}


@app.get("/v1/tools")
def tools() -> dict[str, Any]:
    manifest = tool_manifest()
    return {"tools": manifest, "count": len(manifest)}


@app.post("/v1/tools/{name}")
def call_tool(name: str, payload: DocPayload, x_api_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_api_token)
    started = time.perf_counter()
    log.info("直接调用工具", tool=name, htmlChars=len(payload.html), hasQuery=bool(payload.query))
    result = run_tool(name, payload.html, {"query": payload.query} if payload.query else {})
    log.info(
        "工具调用完成",
        tool=result.tool,
        ok=result.ok,
        durationMs=round((time.perf_counter() - started) * 1000, 1),
    )
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
        raise BadRequest("query 不能为空", code="EMPTY_QUERY")
    started = time.perf_counter()
    log.info("Agent 编排开始", htmlChars=len(payload.html), queryChars=len(payload.query))
    out = run_agent(payload.html, payload.query)
    log.info(
        "Agent 编排完成",
        tool=out.get("tool") or "-",
        mock=out.get("mock"),
        steps=len(out.get("steps") or []),
        durationMs=round((time.perf_counter() - started) * 1000, 1),
    )
    return out


@app.post("/v1/chat")
def chat(payload: ChatPayload, x_api_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_api_token)
    started = time.perf_counter()
    res = complete(payload.messages, model=payload.model, temperature=payload.temperature, max_tokens=payload.max_tokens)
    log.info(
        "对话完成",
        model=res.model,
        mock=res.mock,
        ok=res.ok,
        messages=len(payload.messages),
        durationMs=round((time.perf_counter() - started) * 1000, 1),
    )
    # 失败原因回给调用方（前端会展示），同时 error 字段已在上游记录过日志
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
        raise Unauthorized("需要管理口令（X-Admin-Token）", code="BAD_ADMIN_TOKEN")


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
    log.info("知识库入库请求", kbId=kb_id, name=payload.name, chars=len(payload.content))
    r = KB.add_document(kb_id, payload.name, payload.content)
    log.info("知识库入库完成", kbId=kb_id, docId=r.get("docId"), chunks=r.get("chunks"), deduped=r.get("deduped"))
    return {**r, "stats": KB.kb_stats(kb_id)}


@app.delete("/v1/kb/{kb_id}/documents/{doc_id}")
def kb_delete_document(
    kb_id: str,
    doc_id: str,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(x_admin_token)
    ok = KB.delete_document(doc_id)
    if not ok:
        # 删除不存在的文档：属于可预期的用户操作，记 warn 而不是 error
        log.warning("删除不存在的知识库文档", kbId=kb_id, docId=doc_id)
    else:
        log.info("删除知识库文档", kbId=kb_id, docId=doc_id)
    return {"ok": ok, "stats": KB.kb_stats(kb_id)}


@app.post("/v1/kb/{kb_id}/terms")
def kb_add_terms(
    kb_id: str,
    payload: KbTermPayload,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_admin(x_admin_token)
    n = KB.add_terms(kb_id, payload.terms)
    log.info("写入术语表", kbId=kb_id, added=n, total=len(payload.terms))
    return {"added": n, "stats": KB.kb_stats(kb_id)}


@app.post("/v1/kb/{kb_id}/search")
def kb_search(kb_id: str, payload: KbQueryPayload) -> dict[str, Any]:
    """出口 A：问答用 —— 返回相关段落 + 出处。"""
    started = time.perf_counter()
    hits = KB.search(kb_id, payload.query, top_k=payload.topK)
    log.debug(
        "知识库检索完成",
        kbId=kb_id,
        queryChars=len(payload.query),
        hits=len(hits),
        durationMs=round((time.perf_counter() - started) * 1000, 1),
    )
    return {"query": payload.query, "hits": hits, "count": len(hits)}


@app.post("/v1/kb/{kb_id}/evidence")
def kb_evidence(kb_id: str, payload: KbEvidencePayload) -> dict[str, Any]:
    """出口 B：改写用 —— 返回术语 + 规范片段，供拼 prompt。"""
    out = KB.build_evidence(kb_id, payload.selection, top_k=payload.topK)
    log.debug("知识库证据组装完成", kbId=kb_id, terms=len(out.get("terms") or []), chunks=len(out.get("chunks") or []))
    return out


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