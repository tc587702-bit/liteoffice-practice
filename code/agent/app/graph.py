"""
Agent 编排层：LangGraph 状态图（对应图上的「Agent 层：Prompt、工具调用、状态和流程编排」）

流程：
    START → plan（决定用哪个工具）→ call_tool（本地执行）→ respond（模型汇总）→ END

设计要点：
  1. plan 优先用规则匹配（零成本、可预测、离线可用）；没匹配上才问模型
  2. call_tool 永远在服务端本地执行，不经模型
  3. respond 走 LiteLLM；无 Key 时自动 mock，不阻塞流程
  4. 全程记录 steps，便于界面显示"我做了什么"
"""
from __future__ import annotations

import re
import time
from typing import Any, TypedDict

from langgraph.graph import StateGraph, START, END

from .llm import complete
from .tools import run_tool, tool_manifest
from .errors import AppError
from .logging_conf import get_logger

log = get_logger("graph")

MAX_STEPS = 4

# 规则路由：关键词 → 工具
RULES: list[tuple[str, str]] = [
    (r"统计|字数|多少字|几个表|图片数|阅读|篇幅", "get_stats"),
    (r"大纲|目录|结构|几级标题|章节", "get_outline"),
    (r"体检|检查|问题|毛病|错误|规范|校对|诊断", "diagnose_report"),
    (r"表格.{0,6}(检查|问题|列|对齐)|列数", "check_tables"),
    (r"标题.{0,6}(检查|问题|跳级)|层级", "check_headings"),
    (r"重复|一样|两次", "check_duplicates"),
    (r"搜索|查找|找一下|在哪|检索", "search_document"),
]


class AgentState(TypedDict, total=False):
    html: str
    query: str
    model: str | None
    tool: str
    params: dict[str, Any]
    tool_summary: str
    tool_data: dict[str, Any]
    answer: str
    steps: list[dict[str, Any]]
    mock: bool


def _step(state: AgentState, name: str, detail: str) -> list[dict[str, Any]]:
    steps = list(state.get("steps") or [])
    steps.append({"node": name, "detail": detail})
    return steps


def node_plan(state: AgentState) -> AgentState:
    query = state.get("query", "")
    tool = ""
    params: dict[str, Any] = {}

    for pattern, name in RULES:
        if re.search(pattern, query):
            tool = name
            break

    # 检索类需要关键词：从引号或"找 xxx"里抽
    if tool == "search_document":
        m = re.search(r"[「“\"']([^」”\"']+)[」”\"']", query) or re.search(r"(?:搜索|查找|找)(?:一下)?\s*([^\s，。]+)", query)
        params["query"] = m.group(1) if m else ""

    if tool:
        log.debug("规则命中工具", tool=tool, queryChars=len(query))
        return {
            **state,
            "tool": tool,
            "params": params,
            "steps": _step(state, "plan", f"规则命中：{tool}"),
        }

    # 没有命中规则：让模型决定（无 Key 时 mock 返回，仍能给出可读回复）
    manifest = ", ".join(t["name"] for t in tool_manifest())
    log.debug("规则未命中，改为模型决策", queryChars=len(query))
    res = complete(
        [
            {"role": "system", "content": f"你是文档助手。可用工具：{manifest}。只输出工具名，不要解释。"},
            {"role": "user", "content": query},
        ],
        model=state.get("model"),
        max_tokens=20,
    )
    if not res.ok:
        # 模型选择失败不算致命：下面 call_tool 会跳过，respond 用文档内容兜底
        log.warning("模型选择工具失败，将直接基于文档回答", model=res.model, error=res.error)
    guess = (res.text or "").strip().split()[0] if res.text else ""
    guessed = guess if guess in {t["name"] for t in tool_manifest()} else ""
    return {
        **state,
        "tool": guessed,
        "params": {},
        "mock": res.mock,
        "steps": _step(state, "plan", f"模型选择：{guessed or '无（直接用文档内容回答）'}"),
    }


def node_call_tool(state: AgentState) -> AgentState:
    tool = state.get("tool") or ""
    if not tool:
        return {**state, "steps": _step(state, "call_tool", "跳过：没有需要调用的工具")}
    started = time.perf_counter()
    result = run_tool(tool, state.get("html", ""), state.get("params") or {})
    log.debug(
        "工具执行完成",
        tool=tool,
        ok=result.ok,
        durationMs=round((time.perf_counter() - started) * 1000, 1),
        summaryChars=len(result.summary or ""),
    )
    return {
        **state,
        "tool_summary": result.summary,
        "tool_data": result.data,
        "steps": _step(state, "call_tool", f"{tool} → {result.summary[:60]}"),
    }


def node_respond(state: AgentState) -> AgentState:
    summary = state.get("tool_summary") or ""
    query = state.get("query", "")

    if summary:
        # 工具已有明确结论：不再调用模型，直接回答（省一次调用）
        return {
            **state,
            "answer": summary,
            "steps": _step(state, "respond", "使用工具结果直接回答"),
        }

    # 没有工具结果：让模型基于文档片段回答
    text = re.sub(r"<[^>]+>", " ", state.get("html", ""))
    text = re.sub(r"\s+", " ", text).strip()[:2000]
    res = complete(
        [
            {"role": "system", "content": "你是文档助手。只用给定内容回答，不要编造；内容不足就说不知道。"},
            {"role": "user", "content": f"文档内容：\n{text}\n\n问题：{query}"},
        ],
        model=state.get("model"),
    )
    if not res.ok:
        # 模型失败但流程不能崩：给出可读兜底，同时把原因记进日志
        log.error("回答生成失败，返回兜底文案", model=res.model, error=res.error)
        return {
            **state,
            "answer": "抱歉，当前无法生成回答（模型服务不可用）。可以稍后重试，或直接使用文档工具查看统计结果。",
            "mock": False,
            "steps": _step(state, "respond", "模型调用失败，已降级"),
        }
    return {
        **state,
        "answer": res.text or "（没有生成内容）",
        "mock": res.mock,
        "steps": _step(state, "respond", f"模型回答（{'mock' if res.mock else res.model}）"),
    }


def build_graph():
    g = StateGraph(AgentState)
    g.add_node("plan", node_plan)
    g.add_node("call_tool", node_call_tool)
    g.add_node("respond", node_respond)
    g.add_edge(START, "plan")
    g.add_edge("plan", "call_tool")
    g.add_edge("call_tool", "respond")
    g.add_edge("respond", END)
    return g.compile()


GRAPH = build_graph()


def run_agent(html: str, query: str, model: str | None = None) -> dict[str, Any]:
    init: AgentState = {"html": html, "query": query, "model": model, "steps": []}
    started = time.perf_counter()
    try:
        out: AgentState = GRAPH.invoke(init)
    except AppError:
        raise
    except Exception as exc:
        # 编排层异常：记录完整 traceback，对外只回「稍后重试」，不泄漏内部结构
        log.exception(
            "Agent 编排失败",
            errorType=type(exc).__name__,
            error=str(exc)[:300],
            durationMs=round((time.perf_counter() - started) * 1000, 1),
        )
        raise AppError(
            "Agent 编排失败，请稍后重试",
            code="AGENT_FAILED",
            status_code=500,
            cause=exc,
        ) from exc

    log.debug(
        "Agent 编排结束",
        tool=out.get("tool") or "-",
        steps=len(out.get("steps") or []),
        durationMs=round((time.perf_counter() - started) * 1000, 1),
    )
    return {
        "ok": True,
        "answer": out.get("answer", ""),
        "tool": out.get("tool", ""),
        "toolSummary": out.get("tool_summary", ""),
        "toolData": out.get("tool_data", {}),
        "steps": out.get("steps", []),
        "mock": bool(out.get("mock", False)),
    }
