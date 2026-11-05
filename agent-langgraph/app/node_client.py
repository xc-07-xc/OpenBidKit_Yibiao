"""回调 Electron Node 主进程执行单个阶段。

Node 侧暴露 `POST /internal/run-stage`，复用现有 6 个 Runner：
请求体: { stage_key, context, upstream }
响应体: { outputs: dict, logs: list[{stage, message}] }
"""

from typing import Any

import httpx

from .config import NODE_INTERNAL_BASE_URL


class NodeStageExecutor:
    # 单阶段含真实模型调用，180s 对长标书偏紧；放宽到 15 分钟，超时由编排层转人工。
    def __init__(self, base_url: str = NODE_INTERNAL_BASE_URL, timeout: float = 900.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def run_stage(self, stage_key: str, context: dict[str, Any], upstream: dict[str, Any]) -> dict[str, Any]:
        payload = {"stage_key": stage_key, "context": context, "upstream": upstream}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(f"{self.base_url}/internal/run-stage", json=payload)
            resp.raise_for_status()
            data = resp.json()
        return {"outputs": data.get("outputs") or {}, "logs": data.get("logs") or []}
