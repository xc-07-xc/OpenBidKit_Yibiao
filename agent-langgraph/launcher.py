"""LangGraph sidecar 入口。

开发态由 `python -m uvicorn app.server:app` 启动；
PyInstaller 打包后直接运行本入口，用 uvicorn 在进程内拉起同一份 FastAPI app。
"""

import os

import uvicorn

from app.server import app


def main() -> None:
    port = int(os.environ.get("LANGGRAPH_SERVICE_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
