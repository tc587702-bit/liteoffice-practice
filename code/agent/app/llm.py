"""
模型层：LiteLLM 统一调用（对应图上的「模型层：模型调用、路由和成本控制」）

设计：
  1. 统一走 LiteLLM，模型字符串决定服务商：
       deepseek/deepseek-chat      → DeepSeek
       openai/gpt-4o-mini          → OpenAI
       anthropic/claude-3-5-haiku  → Claude
       gemini/gemini-1.5-flash     → Gemini
       ollama/qwen2.5:7b           → 本地 Ollama
  2. 没有 API Key 时进入 mock 模式：不联网，返回确定性文本，便于离线演示与测试
  3. 统一返回 {ok, text, model, mock, error}
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

from .logging_conf import get_logger

log = get_logger("llm")

DEFAULT_MODEL = os.getenv("LITEOFFICE_MODEL", "deepseek/deepseek-chat")

# 各服务商需要的环境变量（用于判断是否具备真实调用条件）
KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "ollama": "OLLAMA_HOST",  # 本地无需 Key
}


@dataclass
class LlmResult:
    ok: bool
    text: str
    model: str
    mock: bool = False
    error: str | None = None


def provider_of(model: str) -> str:
    return model.split("/", 1)[0] if "/" in model else "deepseek"


def has_credentials(model: str) -> bool:
    provider = provider_of(model)
    env = KEY_ENV.get(provider)
    if env is None:
        return False
    if provider == "ollama":
        return True  # 本地推理，不需要 Key
    return bool(os.getenv(env))


def _mock_reply(prompt: str) -> str:
    """无 Key 时的确定性回复：用于离线演示与自检"""
    head = prompt.strip().splitlines()[0][:40] if prompt.strip() else "（空）"
    return f"（离线模拟）已收到请求：{head}…\n当前未配置 API Key，因此不联网。配置 DEEPSEEK_API_KEY 后可获得真实结果。"


def complete(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 800,
    allow_mock: bool = True,
) -> LlmResult:
    model = model or DEFAULT_MODEL
    prompt = "\n".join(m.get("content", "") for m in messages)

    if not has_credentials(model):
        if allow_mock:
            # 每次 mock 都要留痕：否则线上「模型没配好」会被当成正常回答很久
            log.warning(
                "未配置模型凭据，返回离线模拟结果",
                model=model,
                provider=provider_of(model),
                keyEnv=KEY_ENV.get(provider_of(model)),
            )
            return LlmResult(True, _mock_reply(prompt), model, mock=True)
        missing = KEY_ENV.get(provider_of(model), "API Key")
        log.error("缺少模型凭据且不允许 mock", model=model, keyEnv=missing)
        return LlmResult(False, "", model, mock=False, error=f"缺少 {missing}")

    started = time.perf_counter()
    try:
        import litellm  # 延迟导入：避免没用到时拖慢启动

        # 关掉 LiteLLM 的远程成本表拉取（离线环境会卡几秒）
        litellm.suppress_debug_info = True
        resp = litellm.completion(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=45,
        )
        text = (resp.choices[0].message.content or "").strip()
        log.info(
            "模型调用成功",
            model=model,
            durationMs=round((time.perf_counter() - started) * 1000, 1),
            promptChars=len(prompt),
            replyChars=len(text),
        )
        return LlmResult(True, text, model)
    except Exception as exc:
        # 走到这里说明「有凭据但调用失败」（限流 / 欠费 / 网络 / 模型名错）。
        # 绝不能返回 mock 成功，否则前端会把占位文本当成真实回答。
        # 记录完整 traceback，便于区分是超时、鉴权还是额度问题。
        log.exception(
            "模型调用失败",
            model=model,
            provider=provider_of(model),
            durationMs=round((time.perf_counter() - started) * 1000, 1),
            errorType=type(exc).__name__,
            error=str(exc)[:300],
        )
        return LlmResult(False, "", model, mock=False, error=str(exc)[:200])


def info() -> dict[str, Any]:
    """给 /v1/llm/info 用：说明当前配置与是否 mock"""
    return {
        "model": DEFAULT_MODEL,
        "provider": provider_of(DEFAULT_MODEL),
        "hasCredentials": has_credentials(DEFAULT_MODEL),
        "keyEnv": KEY_ENV.get(provider_of(DEFAULT_MODEL)),
        "supported": list(KEY_ENV.keys()),
    }
