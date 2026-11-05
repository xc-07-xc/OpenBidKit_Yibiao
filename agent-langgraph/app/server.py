"""LangGraph 流水线 FastAPI 服务（异步执行 + 多 run 隔离）。

对外端点：
- POST /graph/start            提交一轮流水线，立即返回 run_id 与当前快照，图在后台执行
- GET  /graph/state?run_id=    查询指定 run 的图状态与待处理闸门
- POST /graph/approve          人工闸门通过
- POST /graph/reject           人工闸门打回
- GET  /health                 健康检查

与旧实现的差异：
1. `/graph/start` 不再同步等到第一个闸门：阶段执行由 `asyncio.create_task` 在后台跑，
   HTTP 只负责提交，Electron 侧改为轮询 `/graph/state`，因此不会再出现「30 秒超时但
   Python 仍在跑」的假失败。
2. 每次 start 生成独立 run_id，对应独立 thread_id 与独立 graph 实例，
   同一进程可以同时容纳多条流水线，不再被固定 `pipeline-main` 串行化。
3. 后台任务异常写入快照的 `error` 字段，Electron 把它投影成阶段失败，而不是静默卡住。
"""

import asyncio
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from langgraph.types import Command
from pydantic import BaseModel

from .graph import build_graph
from .node_client import NodeStageExecutor

app = FastAPI(title="Yibiao LangGraph Pipeline")


class RunHandle:
    """一轮流水线的图实例、线程配置与后台任务状态。"""

    __slots__ = ("run_id", "graph", "config", "task", "error")

    def __init__(self, run_id: str, graph: Any):
        self.run_id = run_id
        self.graph = graph
        self.config = {"configurable": {"thread_id": run_id}}
        self.task: asyncio.Task | None = None
        self.error: str | None = None


def _interrupts(state: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for task in getattr(state, "tasks", []) or []:
        for interrupt in getattr(task, "interrupts", []) or []:
            result.append(interrupt.value)
    return result


class RunRegistry:
    """按 run_id 管理图实例，负责启动、恢复与快照。"""

    def __init__(self, executor_factory: Any = NodeStageExecutor):
        self._executor_factory = executor_factory
        self._runs: dict[str, RunHandle] = {}
        self._lock = asyncio.Lock()

    def get(self, run_id: str) -> RunHandle:
        handle = self._runs.get(run_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"未找到流水线运行：{run_id}")
        return handle

    async def start(self, context: dict[str, Any], run_id: str | None = None) -> str:
        handle_id = run_id or f"run-{uuid.uuid4().hex[:12]}"
        async with self._lock:
            if handle_id in self._runs:
                raise HTTPException(status_code=409, detail=f"流水线运行已存在：{handle_id}")
            handle = RunHandle(handle_id, build_graph(self._executor_factory()))
            self._runs[handle_id] = handle
            initial: dict[str, Any] = {
                "context": context,
                "outputs": {},
                "upstream": {},
                "logs": [],
                "rework_count": 0,
                "status": "running",
            }
            handle.task = asyncio.create_task(
                self._guard(handle, handle.graph.ainvoke(initial, handle.config))
            )
        return handle_id

    async def resume(self, run_id: str, approved: bool, note: str) -> str:
        async with self._lock:
            handle = self.get(run_id)
            if handle.task and not handle.task.done():
                raise HTTPException(status_code=409, detail="当前运行仍在执行，尚无待处理闸门")
            state = handle.graph.get_state(handle.config)
            if not _interrupts(state):
                raise HTTPException(status_code=409, detail="当前运行没有待处理闸门")
            handle.error = None
            handle.task = asyncio.create_task(
                self._guard(
                    handle,
                    handle.graph.ainvoke(
                        Command(resume={"approved": approved, "note": note}),
                        handle.config,
                    ),
                )
            )
        return run_id

    async def _guard(self, handle: RunHandle, coroutine: Any) -> None:
        try:
            await coroutine
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # 后台任务异常不能静默丢失，写进快照交给前端
            handle.error = f"{type(exc).__name__}: {exc}"

    def snapshot(self, run_id: str) -> dict[str, Any]:
        handle = self.get(run_id)
        state = handle.graph.get_state(handle.config)
        values = state.values or {}
        interrupts = _interrupts(state)
        next_nodes = list(state.next or [])
        running = bool(handle.task and not handle.task.done())

        if handle.error:
            status = "error"
        elif interrupts:
            status = "waiting_approval"
        elif running or next_nodes:
            status = "running"
        elif values.get("outputs"):
            status = "success"
        else:
            status = "idle"

        return {
            "run_id": run_id,
            "status": status,
            "active": running or bool(next_nodes) or bool(interrupts),
            "outputs": values.get("outputs", {}),
            "upstream": values.get("upstream", {}),
            "logs": values.get("logs", []),
            "rework_count": values.get("rework_count", 0),
            "approval": values.get("approval", {}),
            "next": next_nodes,
            "interrupts": interrupts,
            "error": handle.error,
        }


registry = RunRegistry()


class StartPayload(BaseModel):
    run_id: str = ""
    context: dict[str, Any] = {}


class DecisionPayload(BaseModel):
    run_id: str
    stage_key: str
    note: str = ""


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/graph/start")
async def start(payload: StartPayload) -> dict[str, Any]:
    run_id = await registry.start(payload.context, payload.run_id or None)
    return registry.snapshot(run_id)


@app.get("/graph/state")
async def state(run_id: str) -> dict[str, Any]:
    return registry.snapshot(run_id)


@app.post("/graph/approve")
async def approve(payload: DecisionPayload) -> dict[str, Any]:
    await registry.resume(payload.run_id, True, payload.note)
    return registry.snapshot(payload.run_id)


@app.post("/graph/reject")
async def reject(payload: DecisionPayload) -> dict[str, Any]:
    await registry.resume(payload.run_id, False, payload.note)
    return registry.snapshot(payload.run_id)
