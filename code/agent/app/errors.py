"""
错误模型与 FastAPI 统一异常出口

本模块刻意不 import FastAPI：知识库等纯逻辑模块也需要抛这些错误，
而它们应当能在没有装 fastapi 的环境下被单独测试。HTTP 映射见 error_handlers.py。

原则与后端一致：
  1. 业务错误用 AppError 子类（带 HTTP 状态码 + 机器可读 code），端点里直接 raise
  2. 未预期异常统一在处理器里记录 traceback，对外只回通用文案，不泄漏内部细节
  3. 响应体沿用 FastAPI 约定 {"detail": ...}，附加 code / requestId 便于排查
  4. 4xx 记 warning（用户输入问题），5xx 记 error（服务缺陷）
"""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    """所有可预期业务错误的基类。"""

    status_code: int = 500
    code: str = "INTERNAL"
    default_message: str = "服务器内部错误"
    expose: bool = True

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: Any = None,
        cause: BaseException | None = None,
    ) -> None:
        self.message = message or self.default_message
        if code:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.details = details
        super().__init__(self.message)
        if cause is not None:
            self.__cause__ = cause


class BadRequest(AppError):
    status_code = 400
    code = "BAD_REQUEST"
    default_message = "请求参数不合法"


class Unauthorized(AppError):
    status_code = 401
    code = "UNAUTHORIZED"
    default_message = "未授权"


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"
    default_message = "资源不存在"


class RateLimited(AppError):
    status_code = 429
    code = "RATE_LIMITED"
    default_message = "请求过于频繁，请稍后再试"


class UpstreamError(AppError):
    status_code = 502
    code = "UPSTREAM_ERROR"
    default_message = "上游服务（模型/依赖）调用失败"


class ServiceUnavailable(AppError):
    status_code = 503
    code = "SERVICE_UNAVAILABLE"
    default_message = "服务暂时不可用"
