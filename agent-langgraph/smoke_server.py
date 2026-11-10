"""离线冒烟：验证异步 HTTP 编排服务（不依赖 Electron，也不调用模型）。

覆盖：
- `/graph/start` 立即返回（不等阶段执行完），带 run_id；
- 轮询 `/graph/state` 能看到阶段推进与闸门 interrupt；
- `/graph/approve` 逐闸恢复，最终走到 END；
- 一致性 high 问题触发两轮返工（MAX_REWORK_ROUNDS）。
"""

import asyncio
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MOCK_PORT = 8799
os.environ["NODE_INTERNAL_BASE_URL"] = f"http://127.0.0.1:{MOCK_PORT}"

OUTPUTS = {
    "parse": {"summary": "mock 招标要点", "qualification": [], "substantive": [], "scoring": [], "technical": [], "commercial": [], "notes": []},
    "qualification": {"checks": [], "gaps": [], "conclusion": "mock 资格结论"},
    "technical": {"topics": [], "strengths": [], "weaknesses": [], "outline": []},
    "legal": {"laws": [], "cases": [], "risks": [], "sources": []},
    "generate": {"sections": [], "summary": "mock 成稿"},
    "consistency": {
        "issues": [
            {"scope": "口径", "severity": "high", "description": "技术与工期口径不一致", "suggestion": "统一口径", "category": "consistency"},
        ],
        "score": 66,
        "passed": False,
        "summary": "mock 质检未通过",
    },
}


class MockNodeExecutor(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - http.server 约定
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        stage_key = payload.get("stage_key", "")
        time.sleep(0.1)
        body = json.dumps(
            {
                "outputs": OUTPUTS.get(stage_key, {}),
                "logs": [{"stage": stage_key, "message": f"mock 阶段完成：{stage_key}"}],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 静默访问日志
        return


mock_server = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockNodeExecutor)
threading.Thread(target=mock_server.serve_forever, daemon=True).start()

import httpx  # noqa: E402

from app.server import app  # noqa: E402  （导入前已设置 NODE_INTERNAL_BASE_URL）


async def main() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=10) as client:
        started_at = time.monotonic()
        response = await client.post(
            "/graph/start",
            json={"run_id": "smoke-run", "context": {"projectOverview": "mock"}},
        )
        elapsed = time.monotonic() - started_at
        assert response.status_code == 200, response.text
        assert elapsed < 2.0, f"/graph/start 耗时 {elapsed:.2f}s，未实现异步启动"
        snapshot = response.json()
        assert snapshot["run_id"] == "smoke-run"
        assert snapshot["active"] is True, snapshot
        print(f"[start] {elapsed * 1000:.0f}ms 返回，run_id={snapshot['run_id']}")

        approved = 0
        for _ in range(60):
            await asyncio.sleep(0.15)
            state = (await client.get("/graph/state", params={"run_id": "smoke-run"})).json()
            if state["error"]:
                raise AssertionError(f"图执行异常：{state['error']}")
            if state["interrupts"]:
                stage_key = state["interrupts"][0]["stage_key"]
                approve = await client.post(
                    "/graph/approve",
                    json={"run_id": "smoke-run", "stage_key": stage_key, "note": "smoke 通过"},
                )
                assert approve.status_code == 200, approve.text
                approved += 1
                print(f"[gate {approved}] 通过 {stage_key}")
                continue
            if not state["active"]:
                break
        else:
            raise AssertionError("轮询超过上限，流水线未结束")

        final = (await client.get("/graph/state", params={"run_id": "smoke-run"})).json()
        assert final["status"] == "success", final
        assert final["rework_count"] == 2, final
        assert final["outputs"].keys() >= {"parse", "qualification", "technical", "legal", "generate", "consistency"}
        # 两轮返工各自会重新经过 generate 闸门：parse / qualification / legal / generate ×3 = 6 次。
        assert approved == 6, f"闸门数量应为 6，实际 {approved}"
        print(f"[final] status={final['status']} rework={final['rework_count']} gates={approved}")

        missing = await client.get("/graph/state", params={"run_id": "no-such-run"})
        assert missing.status_code == 404, missing.text
        duplicate = await client.post("/graph/start", json={"run_id": "smoke-run", "context": {}})
        assert duplicate.status_code == 409, duplicate.text

        # 闸门打回只能重跑本阶段，不能顺带触发下一阶段（回归：Command(goto)+静态边双触发）。
        await client.post("/graph/start", json={"run_id": "smoke-reject", "context": {}})
        first_gate = None
        for _ in range(40):
            await asyncio.sleep(0.1)
            state = (await client.get("/graph/state", params={"run_id": "smoke-reject"})).json()
            if state["interrupts"]:
                first_gate = state["interrupts"][0]["stage_key"]
                break
        assert first_gate == "parse", first_gate
        await client.post("/graph/reject", json={"run_id": "smoke-reject", "stage_key": "parse", "note": "reject test"})
        for _ in range(60):
            await asyncio.sleep(0.1)
            state = (await client.get("/graph/state", params={"run_id": "smoke-reject"})).json()
            if state["interrupts"]:
                assert state["interrupts"][0]["stage_key"] == "parse", state["interrupts"]
                assert "qualification" not in state["outputs"], state["outputs"].keys()
                break
        else:
            raise AssertionError("打回后没有重新停在解析闸门")
        print("[reject] 打回只重跑 parse，未提前触发 qualification")
        print("SERVER SMOKE OK")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        mock_server.shutdown()
