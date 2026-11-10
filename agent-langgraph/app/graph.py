"""LangGraph 流水线图定义。

主线拓扑（从零生成）：

    START → parse_run → parse_gate
                 ↑            │ approved
                 └─ rejected ─┴→ qualification_run → qualification_gate
                                        ↑                  │ approved
                                        └── rejected ──────┴→ qualification_fanout
                                                                 ├→ technical_run ─┐
                                                                 └→ legal_run → legal_gate
                                                                         ↑        │ approved
                                                                         └reject──┴→ legal_passed ─┐
                                                                                                    ├→ generate_run → generate_gate
                                                                                                    │        ↑            │ approved
                                                                                                    │        └─rejected───┘
                                                                                                    ↓
                                                                                    consistency_run（自动质检 + 规则审计）
                                                                                                    ↓
                                                                                       final_approval_gate（终审签发）
                                                                                          │ approved        │ rejected
                                                                                          ↓                 ↓
                                                                                        END          generate_run（携意见重生成）

辅线拓扑（人工上传标书复审）：

    START → review_ingest（上传文本塞进 outputs[generate]）→ consistency_run
          → final_approval_gate →（approved → END ｜ rejected → generate_run → consistency_run）

要点：
- 闸门不靠 `Command(goto=...)` 跳转（会和静态边重复触发），只写 `approval`，
  由 `route_gate()` 条件边决定“打回本阶段”还是“进入下一阶段”。
- technical 与 legal 由 `qualification_fanout` 扇出并行；generate 通过
  `add_edge(["technical_run", "legal_passed"], "generate_run")` 等待两个分支都完成，
  避免技术分析先结束就提前生成一版成稿。
- 自动返工的 generate_run 不再经过“成稿定稿”闸门，直接回到 consistency_run，
  这样“清空旧稿 → 携带意见重生成 → 再次质检”才能一次跑完，不必人工重复点通过。
"""

from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from .config import EXECUTABLE_STAGES
from .nodes import build_final_gate_node, build_gate_node, build_review_ingest_node, build_run_node
from .state import PipelineState


def route_after_consistency(state: dict[str, Any]) -> str:
    """一致性节点已判定是否返工；这里只读结果，避免重复计算轮次。"""
    if state.get("rework_pending"):
        return "generate_run"
    return "final_approval_gate"


def route_after_generate(state: dict[str, Any]) -> str:
    """返工场景直接回质检；首次生成仍走人工“成稿定稿”闸门。"""
    if state.get("rework_pending"):
        return "consistency"
    return "gate"


def route_after_final(state: dict[str, Any]) -> str:
    """终审通过才结束（可导出）；打回则退回生成节点。"""
    approval = state.get("final_approval") or {}
    if approval.get("decision") == "approved":
        return END
    return "generate_run"


def route_gate(stage_key: str):
    """闸门路由：打回则回到本阶段执行节点，通过才继续。"""

    def route(state: dict[str, Any]) -> str:
        approval = state.get("approval") or {}
        if approval.get("stage_key") == stage_key and approval.get("decision") == "rejected":
            return "retry"
        return "next"

    return route


def _fanout(_state: dict[str, Any]) -> dict[str, Any]:
    """空节点：把 qualification 闸门通过后的执行流同时送到 technical 与 legal。"""
    return {}


def _passthrough(_state: dict[str, Any]) -> dict[str, Any]:
    """空节点：legal 闸门通过后作为并行汇合的一个输入。"""
    return {}


def build_graph(executor: Any):
    graph = StateGraph(PipelineState)

    for cfg in EXECUTABLE_STAGES:
        graph.add_node(f"{cfg['key']}_run", build_run_node(cfg["key"], executor))
        if cfg.get("gate"):
            graph.add_node(f"{cfg['key']}_gate", build_gate_node(cfg["key"]))
    graph.add_node("qualification_fanout", _fanout)
    graph.add_node("legal_passed", _passthrough)
    graph.add_node("final_approval_gate", build_final_gate_node())

    graph.add_edge(START, "parse_run")
    graph.add_edge("parse_run", "parse_gate")
    graph.add_conditional_edges(
        "parse_gate",
        route_gate("parse"),
        {"retry": "parse_run", "next": "qualification_run"},
    )

    graph.add_edge("qualification_run", "qualification_gate")
    graph.add_conditional_edges(
        "qualification_gate",
        route_gate("qualification"),
        {"retry": "qualification_run", "next": "qualification_fanout"},
    )

    graph.add_edge("qualification_fanout", "technical_run")
    graph.add_edge("qualification_fanout", "legal_run")

    graph.add_edge("legal_run", "legal_gate")
    graph.add_conditional_edges(
        "legal_gate",
        route_gate("legal"),
        {"retry": "legal_run", "next": "legal_passed"},
    )

    # 汇合：technical 与 legal 都完成（legal 还需闸门通过）后才生成成稿。
    graph.add_edge(["technical_run", "legal_passed"], "generate_run")

    graph.add_conditional_edges(
        "generate_run",
        route_after_generate,
        {"gate": "generate_gate", "consistency": "consistency_run"},
    )
    graph.add_edge("generate_gate", "consistency_run")

    graph.add_conditional_edges(
        "consistency_run",
        route_after_consistency,
        {"generate_run": "generate_run", "final_approval_gate": "final_approval_gate"},
    )

    graph.add_conditional_edges(
        "final_approval_gate",
        route_after_final,
        {END: END, "generate_run": "generate_run"},
    )

    return graph.compile(checkpointer=InMemorySaver())


def build_review_graph(executor: Any):
    """人工上传标书复审：跳过解析与生成，直接跑一致性检查 + 终审闸门。"""
    graph = StateGraph(PipelineState)

    graph.add_node("review_ingest", build_review_ingest_node())
    graph.add_node("consistency_run", build_run_node("consistency", executor))
    graph.add_node("generate_run", build_run_node("generate", executor))
    graph.add_node("generate_gate", build_gate_node("generate"))
    graph.add_node("final_approval_gate", build_final_gate_node())

    graph.add_edge(START, "review_ingest")
    graph.add_edge("review_ingest", "consistency_run")
    graph.add_conditional_edges(
        "consistency_run",
        route_after_consistency,
        {"generate_run": "generate_run", "final_approval_gate": "final_approval_gate"},
    )
    graph.add_conditional_edges(
        "generate_run",
        route_after_generate,
        {"gate": "generate_gate", "consistency": "consistency_run"},
    )
    graph.add_edge("generate_gate", "consistency_run")
    graph.add_conditional_edges(
        "final_approval_gate",
        route_after_final,
        {END: END, "generate_run": "generate_run"},
    )

    return graph.compile(checkpointer=InMemorySaver())
