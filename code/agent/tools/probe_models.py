"""列出可用模型，并各试 3 次看稳定性"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

KEY = os.environ.get("DEEPSEEK_API_KEY", "")
if not KEY:
    raise SystemExit("缺少 DEEPSEEK_API_KEY 环境变量：请先 set DEEPSEEK_API_KEY=...")


BASE = "https://api.deepseek.com"


def get(path: str) -> dict:
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def try_once(model: str) -> str:
    payload = {"model": model, "messages": [{"role": "user", "content": "回一个字：好"}], "max_tokens": 10}
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            json.loads(r.read().decode())
            return f"OK {time.time()-t0:.1f}s"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 边界兜底，异常转为可读提示
        return type(e).__name__


models = [m["id"] for m in get("/models")["data"]]
print("可用模型:", models)

for m in models:
    results = [try_once(m) for _ in range(3)]
    ok = sum(1 for r in results if r.startswith("OK"))
    print(f"  {m:22} {ok}/3 成功   {results}")
    time.sleep(0.5)
