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


_shared: TorchEmbedder | None = None


def get_embedder() -> TorchEmbedder:
    """进程内单例：模型加载约 1 秒，别每请求都加载"""
    global _shared
    if _shared is None:
        _shared = TorchEmbedder()
    return _shared
