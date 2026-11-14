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

DEFAULT_MODEL = os.getenv("LITEOFFICE_MODEL", "deepseek/deepseek-flash")

# 各服务商需要的环境变量（用于判断是否具备真实调用条件）
KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "ollama": "OLLAMA_HOST",  # 本地无需 Key
}

# OpenAI 兼容的直连地址（这些服务商用 HTTP 直接调更稳，且能绕开 LiteLLM 的
# 价格表下载与响应解析问题；LiteLLM 仍负责其他服务商的路由）
DIRECT_BASE = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com/v1",
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
            return LlmResult(True, _mock_reply(prompt), model, mock=True)
        return LlmResult(False, "", model, mock=False, error=f"缺少 {KEY_ENV.get(provider_of(model), 'API Key')}")

    provider = provider_of(model)

    # ① OpenAI 兼容服务商：直连（实测比 LiteLLM 稳，不受价格表下载影响）
    if provider in DIRECT_BASE:
        try:
            text = _call_direct(messages, model, max_tokens, temperature).strip()
            return LlmResult(True, text, model)
        except Exception as exc:  # noqa: BLE001 边界兜底，异常转为可读提示
            return LlmResult(False, "", model, mock=False, error=f"直连失败：{str(exc)[:180]}")

    # ② 其他服务商：走 LiteLLM 路由（对应图上"模型层：路由与成本控制"）
    try:
        text = _call_litellm(messages, model, max_tokens, temperature).strip()
        return LlmResult(True, text, model)
    except Exception as exc:  # noqa: BLE001 边界兜底，异常转为可读提示
        # 「有凭据但调用失败」不能返回 mock 成功，否则前端会把占位文本当真实回答
        return LlmResult(False, "", model, mock=False, error=str(exc)[:200])


def _call_direct(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> str:
    """
    直连 OpenAI 兼容接口（DeepSeek / OpenAI）。

    用标准库 urllib，避免额外依赖；30 秒超时；失败抛异常由上层转成 LlmResult。
    """
    import json as _json
    import urllib.error
    import urllib.request

    provider = provider_of(model)
    base = DIRECT_BASE[provider]
    key_name = KEY_ENV[provider]
    api_key = os.getenv(key_name, "")
    model_name = model.split("/", 1)[1] if "/" in model else model

    payload = {
        "model": model_name,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=_json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    last_error = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"] or ""
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
            # 5xx 是服务端抖动，值得重试；4xx（Key/额度/参数）重试也没用
            if exc.code < 500:
                raise
        except Exception as exc:  # noqa: BLE001 边界兜底，异常转为可读提示
            last_error = f"{type(exc).__name__}: {exc}"
        if attempt < 2:
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"连续 3 次失败（{last_error}）")


def _call_litellm(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> str:
    import litellm

    litellm.suppress_debug_info = True
    resp = litellm.completion(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=60,
    )
    return resp.choices[0].message.content or ""


def info() -> dict[str, Any]:
    """给 /v1/llm/info 用：说明当前配置与是否 mock"""
    return {
        "model": DEFAULT_MODEL,
        "provider": provider_of(DEFAULT_MODEL),
        "hasCredentials": has_credentials(DEFAULT_MODEL),
        "keyEnv": KEY_ENV.get(provider_of(DEFAULT_MODEL)),
        "supported": list(KEY_ENV.keys()),
    }
