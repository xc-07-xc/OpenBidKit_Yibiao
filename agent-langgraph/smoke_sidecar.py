r"""端到端验证打包后的 sidecar（不依赖 Electron 与模型）。

用法（先构建 sidecar）：
    python smoke_sidecar.py
    python smoke_sidecar.py --exe path\to\yibiao-langgraph.exe

流程：起一个 mock Node 执行器 → 拉起 sidecar → 健康检查 → 启动一轮流水线 →
逐个通过闸门 → 断言 6 次闸门、2 轮返工、最终 success。

端口可用环境变量覆盖：SIDECAR_TEST_NODE_PORT / SIDECAR_TEST_SERVICE_PORT。
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_EXE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "client",
    "vendor",
    "langgraph-sidecar",
    "win32-x64",
    "yibiao-langgraph.exe",
)
NODE_PORT = int(os.environ.get("SIDECAR_TEST_NODE_PORT", "18788"))
SERVICE_PORT = int(os.environ.get("SIDECAR_TEST_SERVICE_PORT", "8766"))

OUTPUTS = {
    "parse": {"summary": "sidecar mock", "qualification": [], "substantive": [], "scoring": [], "technical": [], "commercial": [], "notes": []},
    "qualification": {"checks": [], "gaps": [], "conclusion": "ok"},
    "technical": {"topics": [], "strengths": [], "weaknesses": [], "outline": []},
    "legal": {"laws": [], "cases": [], "risks": [], "sources": []},
    "generate": {"sections": [], "summary": "draft"},
    "consistency": {
        "issues": [{"scope": "口径", "severity": "high", "description": "不一致", "suggestion": "统一", "category": "consistency"}],
        "score": 60,
        "passed": False,
        "summary": "未通过",
    },
}


class NodeHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        stage = payload.get("stage_key", "")
        body = json.dumps({"outputs": OUTPUTS.get(stage, {}), "logs": [{"stage": stage, "message": "mock ok"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{SERVICE_PORT}{path}", data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, json.loads(resp.read())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default=DEFAULT_EXE)
    args = parser.parse_args()
    if not os.path.exists(args.exe):
        print(f"未找到 sidecar：{args.exe}\n请先执行 cd client; npm run prepare-langgraph-sidecar")
        return 2

    mock = ThreadingHTTPServer(("127.0.0.1", NODE_PORT), NodeHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ, LANGGRAPH_SERVICE_PORT=str(SERVICE_PORT), NODE_INTERNAL_BASE_URL=f"http://127.0.0.1:{NODE_PORT}")
    process = subprocess.Popen([args.exe], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started_at = time.monotonic()
    try:
        healthy = False
        for _ in range(120):
            if process.poll() is not None:
                raise SystemExit(f"sidecar 提前退出，code={process.returncode}")
            try:
                status, _ = call("GET", "/health")
                if status == 200:
                    healthy = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not healthy:
            raise SystemExit("sidecar 健康检查超时")
        print(f"[health] 启动耗时 {time.monotonic() - started_at:.1f}s")

        _, snapshot = call("POST", "/graph/start", {"run_id": "sidecar-e2e", "context": {"projectOverview": "mock"}})
        assert snapshot["run_id"] == "sidecar-e2e", snapshot
        print(f"[start] active={snapshot['active']} status={snapshot['status']}")

        gates = 0
        for _ in range(80):
            time.sleep(0.2)
            _, state = call("GET", "/graph/state?run_id=sidecar-e2e")
            if state["error"]:
                raise SystemExit(f"图执行异常：{state['error']}")
            if state["interrupts"]:
                stage_key = state["interrupts"][0]["stage_key"]
                call("POST", "/graph/approve", {"run_id": "sidecar-e2e", "stage_key": stage_key, "note": "ok"})
                gates += 1
                continue
            if not state["active"]:
                break
        else:
            raise SystemExit("流水线未结束")

        _, final = call("GET", "/graph/state?run_id=sidecar-e2e")
        assert final["status"] == "success", final
        assert final["rework_count"] == 2, final
        assert gates == 6, gates
        print(f"[final] status={final['status']} rework={final['rework_count']} gates={gates}")
        print("SIDECAR E2E OK")
        return 0
    finally:
        # PyInstaller onefile 会派生服务子进程，必须按进程树结束，否则端口被旧实例占住。
        if process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else:
                process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        mock.shutdown()


if __name__ == "__main__":
    sys.exit(main())
