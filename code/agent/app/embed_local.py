"""
真·语义向量：用 bge-small-zh-v1.5（本地 torch，无需联网）

配合 embed.py 的三层设计：
  存储层  vec BLOB + manifest（千问已写）
  后端层  HashEmbedder（占位）/ make_onnx_embedder（未实现）/ make_api_embedder（要联网）
  本文件  补上「真语义后端」这一格：TorchEmbedder

用法：
    from app.embed_local import TorchEmbedder
    emb = TorchEmbedder()                 # 默认读 data/models/bge-small-zh-v1.5
    vecs = emb(["安置房缺口 17.55 万平方米"])

池化用 mean（实测比 CLS 区分度高：相关 0.45~0.54 / 无关 0.33）。
查询指令前缀默认关闭：本项目的提问是短句，加前缀反而把差距压平（实测 0.494 vs 0.428）。
"""
from __future__ import annotations

import os
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parents[1] / "data" / "models" / "bge-small-zh-v1.5"

# bge 系列的中文检索指令前缀（只用于 query）
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："

EMBED_DIM = 512  # bge-small-zh-v1.5 的维度


class TorchEmbedder:
    """本地 torch 推理的语义 embedding，接口与 HashEmbedder 一致：list[str] → list[list[float]]"""

    def __init__(self, model_dir: str | Path | None = None, max_length: int = 256, batch_size: int = 16):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self._torch = torch
        path = Path(model_dir or os.getenv("LITEOFFICE_EMBED_MODEL", MODEL_DIR))
        if not path.exists():
            raise FileNotFoundError(f"找不到向量模型目录：{path}（先跑 tools/fetch_embed_model.py）")

        self.tokenizer = AutoTokenizer.from_pretrained(str(path))
        self.model = AutoModel.from_pretrained(str(path))
        self.model.eval()
        self.max_length = max_length
        self.batch_size = batch_size
        self.model_name = "bge-small-zh-v1.5"
        self.dim = EMBED_DIM

    def __call__(self, texts: list[str]) -> list[list[float]]:
        return self.embed(texts)

    def embed(self, texts: list[str], is_query: bool = False) -> list[list[float]]:
        torch = self._torch
        out: list[list[float]] = []
        use_instr = os.getenv("LITEOFFICE_EMBED_INSTR", "0") == "1"
        prepared = [f"{QUERY_INSTRUCTION}{t}" if (is_query and use_instr) else t for t in texts]

        for i in range(0, len(prepared), self.batch_size):
            batch = prepared[i : i + self.batch_size]
            enc = self.tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt",
            )
            with torch.no_grad():
                hidden = self.model(**enc).last_hidden_state
            # mean pooling：按 attention_mask 加权平均，再 L2 归一化
            mask = enc["attention_mask"].unsqueeze(-1).float()
            pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-6)
            pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
            out.extend(pooled.tolist())
        return out

    def embed_query(self, text: str) -> list[float]:
        return self.embed([text], is_query=True)[0]


class OnnxEmbedder:
    """
    用 onnxruntime 跑 bge-small-zh-v1.5（int8），分词用 tokenizers（Rust 实现）。

    为什么不用 transformers：装 transformers 会连带拖 torch 生态（GB 级），
    而这里只需要分词 + 一次前向。tokenizers 是个独立的 5 MB 小包。
    实测与 torch 版句向量余弦 0.967、检索 top-1 全一致。
    """

    def __init__(self, model_dir: str | Path | None = None, max_length: int = 256, batch_size: int = 16) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self._ort = ort
        self.max_length = max_length
        self.batch_size = batch_size

        base = Path(model_dir or os.getenv("LITEOFFICE_EMBED_MODEL", MODEL_DIR))
        onnx_dir = base / "onnx"
        self.onnx_path = onnx_dir / "model-int8.onnx"
        if not self.onnx_path.exists():
            self.onnx_path = onnx_dir / "model.onnx"
        if not self.onnx_path.exists():
            raise FileNotFoundError(f"找不到 ONNX 模型：{onnx_dir}")

        tokenizer_file = onnx_dir / "tokenizer.json"
        if not tokenizer_file.exists():
            tokenizer_file = base / "tokenizer.json"
        if not tokenizer_file.exists():
            raise FileNotFoundError(f"找不到分词器：{tokenizer_file}")

        self.tokenizer = Tokenizer.from_file(str(tokenizer_file))
        self.tokenizer.enable_truncation(max_length=max_length)
        pad_id = 0
        try:
            pad_id = self.tokenizer.token_to_id("[PAD]") or 0
        except Exception:  # noqa: BLE001 没有 [PAD] 时用 0
            pad_id = 0
        self.tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")

        self.session = ort.InferenceSession(str(self.onnx_path), providers=["CPUExecutionProvider"])
        self.backend = "onnx"

    def __call__(self, texts: list[str]) -> list[list[float]]:
        """与 TorchEmbedder 保持同一接口：[str] → [[float]]（检索层直接当函数调用）"""
        return self.embed(texts)

    def embed(self, texts: list[str], is_query: bool = False) -> list[list[float]]:  # noqa: ARG002
        import numpy as np

        if not texts:
            return []
        out: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            encs = self.tokenizer.encode_batch(batch)
            feeds = {
                "input_ids": np.asarray([e.ids for e in encs], dtype=np.int64),
                "attention_mask": np.asarray([e.attention_mask for e in encs], dtype=np.int64),
            }
            vecs = self.session.run(None, feeds)[0]
            out.extend(vecs.tolist())
        return out

    def embed_query(self, text: str) -> list[float]:
        return self.embed([text], is_query=True)[0]


_shared: TorchEmbedder | OnnxEmbedder | None = None
_backend_used = ""


def _backend_order() -> list[str]:
    forced = (os.getenv("LITEOFFICE_EMBED_BACKEND") or "auto").strip().lower()
    if forced in ("torch", "onnx"):
        return [forced]
    return ["torch", "onnx"]


def get_embedder() -> TorchEmbedder | OnnxEmbedder:
    """
    进程内单例。auto 模式下按 torch → onnx 顺序尝试：
    开发机通常有 torch（更准），线上服务器只有 onnxruntime（够用且轻）。
    """
    global _shared, _backend_used
    if _shared is not None:
        return _shared

    errors: list[str] = []
    for backend in _backend_order():
        try:
            if backend == "torch":
                _shared = TorchEmbedder()
                _backend_used = "torch"
                return _shared
            _shared = OnnxEmbedder()
            _backend_used = "onnx"
            return _shared
        except Exception as e:  # noqa: BLE001 缺依赖/缺模型都属正常分支
            errors.append(f"{backend}: {type(e).__name__}: {e}")

    raise RuntimeError(
        "没有可用的 embedding 后端（" + "；".join(errors) + "）。"
        "装 torch+transformers 或 onnxruntime，并把模型放到 data/models/bge-small-zh-v1.5/"
    )


def backend_name() -> str:
    """当前实际使用的后端（torch / onnx / 空串=未初始化）"""
    return _backend_used
