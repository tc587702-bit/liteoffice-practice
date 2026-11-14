"""
本地深度分析：不调用任何云 API，用本机 CPU 跑一个小 instruct 模型。

与 review.py（云端）的关系：
  同一个 prompt 结构、同一套 JSON 解析；
  区别只在推理后端：这里是 transformers + torch（CPU），模型文件在 data/models/。

为什么选 1.5B：
  · 3B 在 16 核 CPU 上单段要 60s+，演示不可接受
  · 0.5B 能快 3 倍，但"看懂公文结构并改写"经常答非所问
  · 1.5B 是速度/质量的可接受折中

对外：
    available() -> bool
    review_local(html, genre=None, max_sections=3) -> dict
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from .classify_genre import GENRE_LABEL, classify
from .review import _extract_json, _prompt, _sections, _to_issue
from .tools import strip_tags

MODEL_DIR = Path(__file__).resolve().parents[1] / "data" / "models" / "qwen2.5-1.5b-instruct"
MAX_NEW_TOKENS = int(os.getenv("LITEOFFICE_LOCAL_MAX_NEW", "512"))

_model = None
_tokenizer = None
_load_error = ""


def available() -> bool:
    """模型文件是否就绪（不加载模型，只查目录）"""
    return (MODEL_DIR / "config.json").exists()


def _load():
    """惰性加载；CPU 上首次加载约 10–20 秒"""
    global _model, _tokenizer, _load_error
    if _model is not None or _load_error:
        return
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        _tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR))
        _model = AutoModelForCausalLM.from_pretrained(
            str(MODEL_DIR),
            torch_dtype=torch.float32,  # CPU 上 fp32 最稳；bf16 视 CPU 而定
            low_cpu_mem_usage=True,
        )
        _model.eval()
    except Exception as exc:  # noqa: BLE001 缺依赖/缺文件都转成可读错误
        _load_error = f"{type(exc).__name__}: {exc}"


def _generate(prompt: str) -> tuple[str, float]:
    """本地生成；返回 (文本, 耗时秒)"""
    import torch

    _load()
    if _model is None or _tokenizer is None:
        raise RuntimeError(_load_error or "本地模型未就绪")

    messages = [{"role": "user", "content": prompt}]
    text = _tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = _tokenizer(text, return_tensors="pt")

    t0 = time.time()
    with torch.no_grad():
        out = _model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,          # 贪心解码：结果稳定，便于复现
            temperature=None,
            top_p=None,
            repetition_penalty=1.1,
            pad_token_id=_tokenizer.eos_token_id,
        )
    gen = out[0][inputs["input_ids"].shape[1] :]
    return _tokenizer.decode(gen, skip_special_tokens=True), time.time() - t0


def review_local(
    html: str,
    genre: str | None = None,
    max_sections: int = 3,
) -> dict[str, Any]:
    """本地版深度分析；结构与 review.review() 一致，方便前端复用"""
    plain = strip_tags(html)
    if not plain.strip():
        return {"ok": False, "reason": "文档为空", "issues": [], "summary": ""}

    if not available():
        return {
            "ok": False,
            "reason": "本地模型未安装（运行 python -m tools.fetch_local_model）",
            "issues": [],
            "summary": "",
            "mock": True,
        }

    if genre is None:
        genre = classify(plain).get("genre")
    genre_label = GENRE_LABEL.get(genre or "", "文档")

    sections = _sections(html, max_sections)
    started = time.time()
    issues: list[dict[str, Any]] = []
    per_section: list[dict[str, Any]] = []

    for sec in sections:
        prompt = _prompt(genre_label, sec, [])
        try:
            raw, cost = _generate(prompt)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": f"本地推理失败：{exc}", "issues": [], "summary": ""}

        data = _extract_json(raw)
        found = 0
        if data:
            for item in (data.get("issues") or [])[:3]:
                if not isinstance(item, dict):
                    continue
                mapped = _to_issue(item, sec, html)
                if mapped:
                    mapped["source"] = "local-model"
                    issues.append(mapped)
                    found += 1
        per_section.append({"title": sec.get("title") or f"第 {sec['start'] + 1} 段", "seconds": round(cost, 1), "issues": found})

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda x: order.get(x["level"], 3))

    total = time.time() - started
    if not issues:
        summary = f"本地模型（1.5B）通读 {len(sections)} 段，没有发现需要改的地方。"
    else:
        summary = f"本地模型（1.5B）分析 {len(sections)} 段，给出 {len(issues)} 条建议，用时 {total:.0f} 秒"

    return {
        "ok": True,
        "issues": issues,
        "summary": summary,
        "sections": len(sections),
        "seconds": round(total, 1),
        "perSection": per_section,
        "mock": False,
        "offline": True,
        "model": "qwen2.5-1.5b-instruct",
        "genre": genre,
        "genreLabel": GENRE_LABEL.get(genre or "", ""),
    }


def _demo() -> int:
    """自测：跑一段文字，看能不能出结构化的建议"""
    html = (
        "<p>外婆家屋后有一块菜园，面积不大大约三十来平方米，反正我从小就觉得那块地特别神奇。</p>"
        "<p>记得那年暑假我回到乡下，一进院门就看见外婆弯着腰在菜地里拔草，她的背比以前更驼了。</p>"
    )
    print("模型就绪:", available())
    out = review_local(html, max_sections=1)
    print("ok:", out.get("ok"), " 建议:", len(out.get("issues") or []), " 用时:", out.get("seconds"))
    for it in (out.get("issues") or [])[:3]:
        print(f"  [{it['levelLabel']}] {it['problem']} → 改成：{it['how'][:40]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_demo())
