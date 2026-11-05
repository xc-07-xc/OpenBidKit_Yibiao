"""LangGraph 流水线图定义。

拓扑（闸门阶段拆 `<stage>_run` 执行节点 + `<stage>_gate` 审批节点）：

    START → parse_run → parse_gate → qualification_run → qualification_gate
        ├→ technical_run ──────────────┐
        └→ legal_run → legal_gate ─────┼→ generate_run → generate_gate
                                       ↓
                              consistency_run（自动质检，无人工闸门）
                                       ↓
        质检条件边：一致性 high 且未超整改上限 → 回退 generate_run；否则 END。

并行：technical 与 legal 由资格闸门扇出并行，汇合到生成节点。
"""

from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from .classify import classify_issue, high_issues
from .config import MAX_REWORK_ROUNDS, PIPELINE_STAGES
from .nodes import build_gate_node, build_run_node
from .state import PipelineState


def route_after_consistency(state: dict[str, Any]) -> str:
    outputs = state.get("outputs", {}).get("consistency", {})
    high = high_issues(outputs)
    consistency_high = [issue for issue in high if classify_issue(issue) == "consistency"]
    rework_count = int(state.get("rework_count") or 0)

    if consistency_high and rework_count < MAX_REWORK_ROUNDS:
        return "generate_run"
    return END


def build_graph(executor: Any):
    graph = StateGraph(PipelineState)

    for cfg in PIPELINE_STAGES:
        graph.add_node(f"{cfg['key']}_run", build_run_node(cfg["key"], executor))
        if cfg.get("gate"):
            graph.add_node(f"{cfg['key']}_gate", build_gate_node(cfg["key"]))

    graph.add_edge(START, "parse_run")
    graph.add_edge("parse_run", "parse_gate")
    graph.add_edge("parse_gate", "qualification_run")
    graph.add_edge("qualification_run", "qualification_gate")
    graph.add_edge("qualification_gate", "technical_run")
    graph.add_edge("qualification_gate", "legal_run")
    graph.add_edge("technical_run", "generate_run")
    graph.add_edge("legal_run", "legal_gate")
    graph.add_edge("legal_gate", "generate_run")
    graph.add_edge("generate_run", "generate_gate")
    graph.add_edge("generate_gate", "consistency_run")
    graph.add_conditional_edges(
        "consistency_run",
        route_after_consistency,
        {"generate_run": "generate_run", END: END},
    )

    return graph.compile(checkpointer=InMemorySaver())
