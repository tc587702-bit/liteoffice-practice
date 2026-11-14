"""下载本地中文小模型（Qwen2.5-1.5B-Instruct），供「深度分析」离线使用"""
import json
import os
import sys
import time
from pathlib import Path

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from huggingface_hub import snapshot_download  # noqa: E402

ROOT = Path(r"C:\deepseekharness\liteoffice-ai\code\agent\data\models")
TARGET = ROOT / "qwen2.5-1.5b-instruct"

t0 = time.time()
path = snapshot_download(
    repo_id="Qwen/Qwen2.5-1.5B-Instruct",
    local_dir=str(TARGET),
    allow_patterns=["*.json", "*.txt", "*.safetensors", "*.model"],
    ignore_patterns=["*.onnx", "*.h5", "*.msgpack", "*.gguf", "*.bin"],
)
total = sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())
print(
    json.dumps(
        {"ok": True, "path": path, "sizeMB": round(total / 1024 / 1024, 1), "seconds": round(time.time() - t0, 1)},
        ensure_ascii=False,
    )
)
sys.exit(0)
