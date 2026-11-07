"""
统一日志配置（Agent 服务）

目标与后端保持一致：一行一条、可被机器解析、带请求 ID 可串联。

用法：
    from .logging_conf import get_logger, setup_logging, request_id_ctx

    setup_logging()                     # 进程启动时调用一次（main.py 已调用）
    log = get_logger(__name__)          # 也可以在模块级：log = get_logger("kb")
    log.info("文档入库", docId=doc_id, chunks=n)
    log.error("模型调用失败", model=model, exc_info=True)

约定：
    1. event 用简短中文短语，变量一律走关键字参数，不要 f-string 拼日志
    2. 异常用 log.exception(...) 或 exc_info=True，自动带 traceback
    3. 敏感字段（token / api key / password）自动脱敏
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

SERVICE_NAME = os.getenv("LITEOFFICE_SERVICE_NAME", "liteoffice-agent")

#: 当前请求 ID；中间件写入，日志过滤器读取，保证同一次请求的日志能聚合
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

_SENSITIVE_KEYS = {
    "token",
    "api_token",
    "api_key",
    "apikey",
    "password",
    "secret",
    "authorization",
    "x_api_token",
    "x_admin_token",
    "x-api-token",
    "x-admin-token",
}
_MAX_STR = 500
_MAX_REPR = 300


def _redact(key: str, value: Any) -> Any:
    if key.lower() in _SENSITIVE_KEYS:
        return f"<redacted:{len(value) if isinstance(value, str) else 0}>"
    if isinstance(value, str):
        return value if len(value) <= _MAX_STR else f"{value[:_MAX_STR]}…(+{len(value)})"
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        items = [_redact("", item) for item in value[:20]]
        if len(value) > 20:
            items.append(f"…(+{len(value) - 20})")
        return items
    if isinstance(value, dict):
        return {k: _redact(str(k), v) for k, v in list(value.items())[:40]}
    text = repr(value)
    return text if len(text) <= _MAX_REPR else f"{text[:_MAX_REPR]}…"


class RequestIdFilter(logging.Filter):
    """把 contextvar 里的请求 ID 注入每条日志记录。"""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "service": SERVICE_NAME,
            "logger": record.name,
            "msg": record.getMessage(),
            "requestId": getattr(record, "request_id", "-"),
        }
        fields = getattr(record, "fields", None)
        if fields:
            payload.update({k: _redact(str(k), v) for k, v in fields.items()})
        if record.exc_info:
            exc_type, exc_value, exc_tb = record.exc_info
            payload["error"] = {
                "type": exc_type.__name__ if exc_type else "Error",
                "message": str(exc_value),
                "stack": "".join(traceback.format_exception(exc_type, exc_value, exc_tb)).splitlines()[:12],
            }
        return json.dumps(payload, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        head = (
            f"{time.strftime('%H:%M:%S', time.localtime(record.created))} "
            f"{record.levelname:<5} [{record.name}] {record.getMessage()}"
        )
        fields = getattr(record, "fields", None) or {}
        tail = " ".join(f"{k}={_redact(str(k), v)}" for k, v in fields.items())
        rid = getattr(record, "request_id", "-")
        if rid and rid != "-":
            tail = f"{tail} requestId={rid}".strip()
        line = f"{head} {tail}".rstrip()
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup_logging(level: str | None = None) -> None:
    """初始化根 logger。重复调用安全（幂等）。"""
    root = logging.getLogger()
    if getattr(root, "_liteoffice_configured", False):
        return

    chosen = (level or os.getenv("LITEOFFICE_LOG_LEVEL", "INFO")).upper()
    root.setLevel(getattr(logging, chosen, logging.INFO))

    fmt = os.getenv("LITEOFFICE_LOG_FORMAT", "json").lower()
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt != "text" else TextFormatter())
    handler.addFilter(RequestIdFilter())

    root.handlers = [handler]
    # uvicorn 的启动/错误日志与业务日志保持同一格式
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = [handler]
        lg.propagate = False
    # 访问日志由 main 的中间件统一输出（带 requestId / 耗时 / 状态码），
    # 关掉 uvicorn.access 以免同一请求出现两条重复日志
    logging.getLogger("uvicorn.access").disabled = True

    root._liteoffice_configured = True  # type: ignore[attr-defined]


class BoundLogger:
    """带固定上下文字段的 logger，避免每次调用重复传参。"""

    def __init__(self, logger: logging.Logger, fields: dict[str, Any] | None = None):
        self._logger = logger
        self._fields = fields or {}

    def child(self, **fields: Any) -> "BoundLogger":
        return BoundLogger(self._logger, {**self._fields, **fields})

    def _log(self, level: int, event: str, exc_info: bool = False, **fields: Any) -> None:
        merged = {**self._fields, **fields}
        self._logger.log(level, event, extra={"fields": merged}, exc_info=exc_info, stacklevel=2)

    def debug(self, event: str, **fields: Any) -> None:
        self._log(logging.DEBUG, event, **fields)

    def info(self, event: str, **fields: Any) -> None:
        self._log(logging.INFO, event, **fields)

    def warning(self, event: str, **fields: Any) -> None:
        self._log(logging.WARNING, event, **fields)

    def error(self, event: str, *, exc_info: bool = False, **fields: Any) -> None:
        self._log(logging.ERROR, event, exc_info=exc_info, **fields)

    def exception(self, event: str, **fields: Any) -> None:
        self._log(logging.ERROR, event, exc_info=True, **fields)


def get_logger(name: str, **base_fields: Any) -> BoundLogger:
    return BoundLogger(logging.getLogger(name), base_fields)


@contextmanager
def bind_request_id(request_id: str | None = None) -> Iterator[str]:
    """在一次请求/任务内绑定 request_id，结束自动还原。"""
    rid = request_id or uuid.uuid4().hex[:16]
    token = request_id_ctx.set(rid)
    try:
        yield rid
    finally:
        request_id_ctx.reset(token)


@contextmanager
def timed(log: BoundLogger, event: str, **fields: Any) -> Iterator[None]:
    """记录一段逻辑的耗时；异常时记录失败并继续抛出。"""
    started = time.perf_counter()
    try:
        yield
    except Exception as exc:
        log.error(
            f"{event}失败",
            durationMs=round((time.perf_counter() - started) * 1000, 1),
            error=str(exc),
            **fields,
        )
        raise
    else:
        log.info(f"{event}完成", durationMs=round((time.perf_counter() - started) * 1000, 1), **fields)
