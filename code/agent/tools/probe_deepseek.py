"""探测 DeepSeek 当前可用性：模型 × 提示词，看是否全部 500"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

KEY = os.environ.get("DEEPSEEK_API_KEY", "")
if not KEY:
    raise SystemExit("缺少 DEEPSEEK_API_KEY 环境变量：请先 set DEEPSEEK_API_KEY=...")


URL = "https://api.deepseek.com/chat/completions"


def call(model: str, prompt: str) -> str:
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 20}
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.loads(r.read().decode("utf-8"))
            return f"OK {time.time()-t0:.1f}s → {d['choices'][0]['message']['content']!r}"
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body)["error"]["message"][:80]
        except Exception:  # noqa: BLE001 边界兜底，异常转为可读提示
            msg = body[:80]
        return f"HTTP {e.code} ({time.time()-t0:.1f}s) {msg}"
    except Exception as e:  # noqa: BLE001 边界兜底，异常转为可读提示
        return f"{type(e).__name__} {str(e)[:60]}"


print("=== 模型与提示词矩阵 ===")
for model in ("deepseek-chat", "deepseek-reasoner"):
    for prompt, label in (("回一个字：好", "中文"), ("Say OK", "英文")):
        print(f"  {model:18} {label}  {call(model, prompt)}")

print("\n=== 余额 / 模型列表 ===")
for path in ("/user/balance", "/models"):
    req = urllib.request.Request(f"https://api.deepseek.com{path}", headers={"Authorization": f"Bearer {KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(f"  {path}: {r.status} {r.read().decode('utf-8')[:160]}")
    except urllib.error.HTTPError as e:
        print(f"  {path}: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:120]}")
    except Exception as e:  # noqa: BLE001 边界兜底，异常转为可读提示
        print(f"  {path}: {type(e).__name__} {str(e)[:60]}")
