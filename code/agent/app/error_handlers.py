"""
FastAPI 统一异常出口

把 errors.py 里的 AppError 以及框架异常，统一映射成带 code / requestId 的 JSON。

为什么要单独一个模块：errors.py 需要被 kb.py 这类不依赖 Web 框架的模块复用，
而这里依赖 FastAPI，拆开后知识库测试不需要安装 fastapi。
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .errors import AppError
from .logging_conf import get_logger, request_id_ctx

log = get_logger("errors")


def _body(exc: AppError, request_id: str) -> dict[str, Any]:
    return {
        "detail": exc.message if exc.expose else "服务器内部错误",
        "code": exc.code,
        "requestId": request_id,
    }


def install_error_handlers(app: FastAPI) -> None:
    """把各类异常统一映射成 JSON 响应，并保证「有日志可查」。"""

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        rid = request_id_ctx.get()
        # 细节（SQL、参数、上游报错）只进日志，不回给客户端
        if exc.status_code >= 500:
            log.error(
                "请求处理失败",
                code=exc.code,
                path=request.url.path,
                method=request.method,
                detail=str(exc),
                details=exc.details,
                exc_info=exc.__cause__ is not None,
            )
        else:
            log.warning(
                "请求被拒绝",
                code=exc.code,
                path=request.url.path,
                method=request.method,
                detail=str(exc),
            )
        return JSONResponse(_body(exc, rid), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        rid = request_id_ctx.get()
        # 只保留「字段 + 原因」，避免把整个请求体写进响应
        problems = [
            {"loc": ".".join(str(p) for p in err.get("loc", [])), "msg": err.get("msg", "")}
            for err in exc.errors()[:10]
        ]
        log.warning(
            "请求参数校验失败",
            code="VALIDATION_ERROR",
            path=request.url.path,
            method=request.method,
            problems=problems,
        )
        return JSONResponse(
            {"detail": "请求参数格式不正确", "code": "VALIDATION_ERROR", "requestId": rid, "problems": problems},
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        rid = request_id_ctx.get()
        level = log.error if exc.status_code >= 500 else log.warning
        level(
            "HTTP 异常",
            code=f"HTTP_{exc.status_code}",
            status=exc.status_code,
            path=request.url.path,
            method=request.method,
            detail=str(exc.detail),
        )
        return JSONResponse(
            {"detail": exc.detail, "code": f"HTTP_{exc.status_code}", "requestId": rid},
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        rid = request_id_ctx.get()
        # 未预期异常必须带 traceback，否则线上无法定位
        log.exception(
            "未处理异常",
            code="INTERNAL",
            path=request.url.path,
            method=request.method,
            errorType=type(exc).__name__,
            error=str(exc),
        )
        return JSONResponse(
            {"detail": "服务器内部错误", "code": "INTERNAL", "requestId": rid},
            status_code=500,
        )
