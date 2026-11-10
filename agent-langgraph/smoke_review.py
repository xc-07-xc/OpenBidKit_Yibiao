"""离线冒烟：人工上传标书复审（辅线）+ 终审闸门闭环。

覆盖：
- `/graph/review` 不重跑解析与生成，直接把上传文本塞进 outputs["generate"]；
- 一致性检查 immediately 基于上传成稿运行，产出比对报告；
- 终审闸门 interrupt；打回后走「清空旧稿 → 携意见重生成 → 再次质检」；
- 再次通过后终审 approve，快照 export_ready=true 且 status=success；
- `/graph/schema` 返回各节点产物结构。
"""

import asyncio

import httpx

from app.server import app


class MockExecutor:
    def __init__(self):
        self.calls = []
        self.round = 0
        self.consistency_calls = 0

    async def run_stage(self, stage_key, context, upstream):
        self.calls.append(stage_key)
        if stage_key == "generate":
            self.round += 1
            return {
                "outputs": {
                    "sections": [
                        {"heading": "第一章 工程概况", "content": "本项目工期 30 日历天，已明确响应。"},
                        {"heading": "第二章 施工方案", "content": f"第 {self.round} 轮按终审意见补充的施工方案正文。"},
                    ],
                    "summary": "mock 重生成成稿",
                },
                "logs": [],
            }
        if stage_key == "consistency":
            self.consistency_calls += 1
            return {
                "outputs": {
                    "issues": [],
                    "score": 88,
                    "passed": True,
                    "summary": "mock 复审通过",
                    "comparison": [
                        {
                            "item": "工期不得超过 30 日历天",
                            "required": "实质性条款",
                            "status": "responded",
                            "evidence": "命中「30 日历天」",
                        }
                    ],
                },
                "logs": [],
            }
        return {"outputs": {}, "logs": []}


async def main() -> None:
    from app import server as server_module

    executor = MockExecutor()
    server_module.registry._executor_factory = lambda: executor

    draft = {
        "sections": [
            {"heading": "第一章 工程概况", "content": "本项目为场馆防水维修，工期 30 日历天。"},
            {"heading": "第二章 施工方案", "content": "【待补充：屋面基层处理工艺】"},
        ],
        "summary": "人工上传的既有标书",
        "chars": 68,
        "source": "manual",
        "fileName": "既有投标文件.docx",
    }
    reference = {
        "parse": {
            "qualification": [],
            "substantive": ["工期不得超过 30 日历天"],
            "scoring": [],
            "technical": [],
            "commercial": [],
            "notes": [],
            "summary": "mock 招标要点",
        }
    }

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=15) as client:
        schema = (await client.get("/graph/schema")).json()
        assert "nodes" in schema and "consistency" in schema["nodes"], schema
        print("[schema] 节点：", ", ".join(schema["nodes"].keys()))

        started = await client.post(
            "/graph/review",
            json={"run_id": "smoke-review", "context": {"projectOverview": "mock"}, "draft": draft, "reference": reference},
        )
        assert started.status_code == 200, started.text
        snapshot = started.json()
        assert snapshot["mode"] == "review", snapshot
        assert snapshot["active"] is True, snapshot

        # 1) 应当直接停在终审闸门（跳过 parse/qualification/technical/legal）
        for _ in range(80):
            await asyncio.sleep(0.1)
            state = (await client.get("/graph/state", params={"run_id": "smoke-review"})).json()
            if state["error"]:
                raise AssertionError(f"复审执行异常：{state['error']}")
            if state["interrupts"]:
                break
        else:
            raise AssertionError("复审未进入终审闸门")

        waiting = state["interrupts"][0]["stage_key"]
        assert waiting == "final_approval", waiting
        assert "parse" not in state["outputs"], state["outputs"].keys()
        assert state["outputs"]["generate"]["source"] == "manual", state["outputs"]["generate"]
        comparison = state["outputs"]["consistency"].get("comparison")
        assert isinstance(comparison, list) and comparison, state["outputs"]["consistency"]
        assert executor.calls == ["consistency"], executor.calls
        print(f"[review] 直接进入终审闸门，比对报告 {len(comparison)} 条")

        # 2) 终审打回 → 重生成 → 再次质检 → 重新停在终审闸门
        rejected = await client.post(
            "/graph/reject",
            json={"run_id": "smoke-review", "stage_key": "final_approval", "note": "第二章占位内容未补齐"},
        )
        assert rejected.status_code == 200, rejected.text
        for _ in range(80):
            await asyncio.sleep(0.1)
            state = (await client.get("/graph/state", params={"run_id": "smoke-review"})).json()
            if state["interrupts"]:
                break
        else:
            raise AssertionError("终审打回后未回到终审闸门")
        assert state["interrupts"][0]["stage_key"] == "final_approval", state["interrupts"]
        assert state["rework_count"] == 1, state
        assert state["outputs"]["consistency"]["passed"] is True, state["outputs"]["consistency"]
        assert executor.calls == ["consistency", "generate", "consistency"], executor.calls
        print(f"[self-loop] 调用序列 {executor.calls}，rework={state['rework_count']}")

        # 3) 终审通过 → 结束且 export_ready
        approved = await client.post(
            "/graph/approve",
            json={"run_id": "smoke-review", "stage_key": "final_approval", "note": "终审通过"},
        )
        assert approved.status_code == 200, approved.text
        for _ in range(40):
            await asyncio.sleep(0.1)
            final = (await client.get("/graph/state", params={"run_id": "smoke-review"})).json()
            if not final["active"]:
                break
        assert final["status"] == "success", final
        assert final["export_ready"] is True, final
        assert final["final_approval"]["decision"] == "approved", final
        print(f"[final] status={final['status']} export_ready={final['export_ready']}")

        # 4) 闸门不匹配时必须拒绝，防止误放行
        bad = await client.post(
            "/graph/reject",
            json={"run_id": "smoke-review", "stage_key": "parse", "note": "x"},
        )
        assert bad.status_code in (404, 409), bad.text

        print("REVIEW SMOKE OK")


if __name__ == "__main__":
    asyncio.run(main())
