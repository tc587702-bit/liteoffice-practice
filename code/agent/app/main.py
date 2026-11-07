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

from .llm import complete, info as llm_info
from .graph import run_agent
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
