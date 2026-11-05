"""LangGraph 流水线共享状态定义。

图状态与 Electron 侧 SQLite 黑板字段对齐：
- context: 运行上下文（项目概述、公司资质概况、质检反馈等）
- outputs: 各阶段产物，键为 stage_key
- upstream: 上游阶段产物快照，供节点拼装提示词
- logs: 阶段执行日志
- rework_count: 自动整改轮次
- status: 流水线总体状态
- approval: 人工闸门决议

并行扇出（technical ∥ legal）会在同一 step 并发写回，因此 dict 字段
用浅合并 reducer、logs 用追加 reducer，避免 last_value 通道冲突。
"""

from operator import add
from typing import Annotated, Any, TypedDict


def merge_dict(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any]:
    return {**(left or {}), **(right or {})}


class StageLog(TypedDict):
    stage: str
    message: str
    at: str


class ApprovalDecision(TypedDict, total=False):
    stage_key: str
    decision: str  # pending | approved | rejected
    note: str


class PipelineState(TypedDict, total=False):
    context: dict[str, Any]
    outputs: Annotated[dict[str, Any], merge_dict]
    upstream: Annotated[dict[str, Any], merge_dict]
    logs: Annotated[list[StageLog], add]
    rework_count: int
    status: str
    approval: ApprovalDecision
