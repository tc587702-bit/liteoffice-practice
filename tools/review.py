#!/usr/bin/env python
"""
LiteOffice 代码审查编排器（Python 侧）

    python tools/review.py

能做的三件事：
  1. 调用各语言的**原生**检查器（TS 用 vue-tsc，Python 用 ruff，Node 用 node --check）
  2. 用正则做**跨语言**的结构统计（文件规模、超大文件、危险模式）
  3. 汇总成一份 Markdown 报告，写到 docs/software/review-report.md

不能做的（要老实说）：
  - TS/Vue 的类型与模板语义：正则看不出来，必须靠 vue-tsc / eslint
  - 运行时行为：靠测试，不靠静态扫描
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FE = ROOT / "code" / "frontend"
BE = ROOT / "code" / "backend"
AG = ROOT / "code" / "agent"
OUT = ROOT / "docs" / "software" / "review-report.md"

SKIP_DIRS = {"node_modules", "dist", ".git", "__pycache__", "data", "logs", ".tmp", ".venv"}

# 危险/可疑模式（正则可得，且真的值得看）
PATTERNS = {
    "any 类型": r":\s*any\b",
    "console.log": r"console\.log",
    "innerHTML 赋值": r"innerHTML\s*=",
    "v-html": r"v-html",
    "eval / new Function": r"eval\(|new Function",
    "localStorage": r"localStorage",
    "TODO / FIXME": r"TODO|FIXME|XXX",
    "@ts-ignore": r"@ts-ignore|@ts-expect-error",
    "裸 except（Python）": r"except\s+Exception\s*:",
    "subprocess shell=True": r"shell\s*=\s*True",
    "硬编码密钥": r"(sk-[A-Za-z0-9]{10,}|api[_-]?key\s*=\s*['\"][^'\"]{8,})",
}

LANG = {".ts": "TS", ".vue": "Vue", ".mjs": "JS", ".js": "JS", ".py": "Py"}


@dataclass
class FileStat:
    path: Path
    lines: int
    lang: str


@dataclass
class Report:
    files: list[FileStat] = field(default_factory=list)
    hits: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    checks: list[tuple[str, bool, str]] = field(default_factory=list)


def walk(base: Path):
    for p in base.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix not in LANG:
            continue
        yield p


def collect() -> Report:
    rep = Report()
    for base in (FE / "src", FE / "scripts", FE / "tools", BE / "server", BE / "public", AG / "app"):
        if not base.exists():
            continue
        for p in walk(base):
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = str(p.relative_to(ROOT)).replace("\\", "/")
            rep.files.append(FileStat(p, text.count("\n") + 1, LANG[p.suffix]))
            for name, pat in PATTERNS.items():
                if name == "console.log" and ("/scripts/" in rel or "/tools/" in rel or "smoke" in rel):
                    continue
                for m in re.finditer(pat, text, re.I):
                    line = text[: m.start()].count("\n") + 1
                    rep.hits.setdefault(name, []).append((rel, line))
    return rep


def run(cmd: list[str], cwd: Path, timeout: int = 300) -> tuple[int, str]:
    try:
        r = subprocess.run(
            cmd, cwd=str(cwd), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout, shell=False,
        )
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except FileNotFoundError:
        return 127, f"命令不存在: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "超时"


def main() -> int:
    rep = collect()

    # ---- 1) 调原生检查器 ----
    if (FE / "package.json").exists():
        npm = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
        code, out = run([npm, "run", "typecheck"], FE)
        tail = out.strip().splitlines()[-1] if out.strip() else ""
        rep.checks.append(("前端类型检查（vue-tsc）", code == 0, tail[:120]))

    code, out = run([sys.executable, "-m", "ruff", "check", ".", "--output-format=concise"], AG)
    count = len([ln for ln in out.splitlines() if re.match(r"^app\\|^app/", ln)])
    rep.checks.append(("Python 静态检查（ruff）", code == 0, f"{count} 项问题"))

    mjs = [p for p in (BE / "server").glob("*.mjs")]
    bad = []
    for p in mjs:
        c, _ = run(["node", "--check", str(p)], BE)
        if c != 0:
            bad.append(p.name)
    rep.checks.append(("后端语法检查（node --check）", not bad, f"{len(mjs)} 个文件" + (f"，失败: {bad}" if bad else "")))

    # ---- 2) 结构统计 ----
    total_lines = sum(f.lines for f in rep.files)
    big = sorted(rep.files, key=lambda f: f.lines, reverse=True)[:10]
    huge = [f for f in rep.files if f.lines > 600]

    # ---- 3) 报告 ----
    lines = ["# LiteOffice 代码审查报告（自动生成）", "", f"生成时间：{_now()}", ""]
    lines += ["## 一、原生检查器结果", "", "| 检查 | 结果 | 说明 |", "|---|---|---|"]
    for name, ok, detail in rep.checks:
        lines.append(f"| {name} | {'✅ 通过' if ok else '❌ 未通过'} | {detail} |")

    lines += ["", "## 二、规模", "", f"共 {len(rep.files)} 个文件，{total_lines:,} 行。", "",
              "| 语言 | 文件数 | 行数 |", "|---|---|---|"]
    for lang in ("TS", "Vue", "JS", "Py"):
        fs = [f for f in rep.files if f.lang == lang]
        if fs:
            lines.append(f"| {lang} | {len(fs)} | {sum(f.lines for f in fs):,} |")

    lines += ["", "### 最大的 10 个文件", "", "| 行数 | 文件 |", "|---|---|"]
    for f in big:
        lines.append(f"| {f.lines} | `{str(f.path.relative_to(ROOT)).replace(chr(92), '/')}` |")

    lines += ["", f"### 超过 600 行的文件（{len(huge)} 个）", ""]
    lines += [f"- `{str(f.path.relative_to(ROOT)).replace(chr(92), '/')}`（{f.lines} 行）" for f in huge] or ["- 无"]

    lines += ["", "## 三、可疑模式统计", "", "| 模式 | 次数 | 示例位置 |", "|---|---|---|"]
    for name, pat in PATTERNS.items():
        hits = rep.hits.get(name, [])
        sample = f"`{hits[0][0]}:{hits[0][1]}`" if hits else "—"
        lines.append(f"| {name} | {len(hits)} | {sample} |")

    lines += ["", "## 四、Python 能审到哪、审不到哪", "",
              "| 能 | 不能 |", "|---|---|",
              "| 调用各语言原生检查器并汇总 | TS/Vue 的类型与模板语义（要靠 vue-tsc） |",
              "| 文件规模、超大文件、热点文件 | 运行时行为（要靠测试） |",
              "| 正则可发现的危险模式 | 复杂数据流、跨文件依赖（要靠 eslint / madge） |",
              "| 统一输出成报告 | 性能问题（要靠 profiling） |"]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ---- 控制台摘要 ----
    print("=== 检查器 ===")
    for name, ok, detail in rep.checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}")
    print(f"\n=== 规模 === {len(rep.files)} 文件 / {total_lines:,} 行")
    print("=== 可疑模式 ===")
    for name in PATTERNS:
        n = len(rep.hits.get(name, []))
        if n:
            print(f"  {name:22} {n}")
    print(f"\n报告已写入 {OUT.relative_to(ROOT)}")
    return 0 if all(ok for _, ok, _ in rep.checks) else 1


def _now() -> str:
    from datetime import datetime

    return datetime.now().strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    raise SystemExit(main())
