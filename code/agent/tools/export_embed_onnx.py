"""把 bge-small-zh-v1.5 导出成 ONNX（int8），供服务器无 torch 时做向量检索

    python tools/export_embed_onnx.py

产物（默认写进 data/models/bge-small-zh-v1.5/onnx/）：
  model-int8.onnx     约 23 MB，随仓库分发
  tokenizer.json 等   分词器，必需

注意：池化必须与 app/embed_local.py 的 TorchEmbedder 一致
（attention_mask 加权 mean pooling + L2 归一化），否则等于换了模型。
"""

from pathlib import Path

import shutil

import torch
from transformers import AutoModel, AutoTokenizer

ROOT = Path(r"C:\deepseekharness\liteoffice-ai\code\agent\data\models\bge-small-zh-v1.5")
OUT = ROOT / "onnx"
OUT.mkdir(parents=True, exist_ok=True)

tokenizer = AutoTokenizer.from_pretrained(str(ROOT))
model = AutoModel.from_pretrained(str(ROOT))
model.eval()


class MeanPool(torch.nn.Module):
    """与 embed_local.TorchEmbedder 完全一致的池化：mask 加权平均 + L2 归一化"""

    def __init__(self, m: torch.nn.Module) -> None:
        super().__init__()
        self.m = m

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        hidden = self.m(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).float()
        pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-6)
        return torch.nn.functional.normalize(pooled, p=2, dim=1)


wrapped = MeanPool(model).eval()
dummy = tokenizer(["测试句子"], return_tensors="pt", padding=True, truncation=True, max_length=64)

fp32 = OUT / "model.onnx"
for stale in (OUT / "model.onnx.data", OUT / "model.onnx", OUT / "model-int8.onnx"):
    if stale.exists():
        stale.unlink()

print("导出 fp32 ONNX（mean pooling）…")
torch.onnx.export(
    wrapped,
    (dummy["input_ids"], dummy["attention_mask"]),
    str(fp32),
    input_names=["input_ids", "attention_mask"],
    output_names=["sentence_embedding"],
    dynamic_axes={
        "input_ids": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "seq"},
        "sentence_embedding": {0: "batch"},
    },
    opset_version=17,
    do_constant_folding=True,
)

data_file = OUT / "model.onnx.data"
size = (fp32.stat().st_size + (data_file.stat().st_size if data_file.exists() else 0)) / 1024 / 1024
print(f"  fp32: {size:.1f} MB")

from onnxruntime.quantization import QuantType, quantize_dynamic

int8 = OUT / "model-int8.onnx"
print("量化 int8 …")
quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)
print(f"  int8: {int8.stat().st_size / 1024 / 1024:.1f} MB")

# fp32 权重不再需要（仓库只放 int8 + 分词器）
if data_file.exists():
    data_file.unlink()
if fp32.exists():
    fp32.unlink()
print("  已清理 fp32，只留 int8")
