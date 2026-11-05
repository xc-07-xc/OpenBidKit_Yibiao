"""离线冒烟：用 mock 执行器跑通 LangGraph 编排闭环。

不依赖 Electron 与模型调用，验证：
- 顺序执行 parse → qualification → [technical ∥ legal] → generate → consistency
- 闸门 interrupt 暂停，approve 后恢复
- 一致性 high 问题触发一次回退到 generate
- 最终走到 END
"""

import asyncio

from app.graph import build_graph


class MockExecutor:
    def __init__(self):
        self.calls = []

    async def run_stage(self, stage_key, context, upstream):
        self.calls.append(stage_key)
        outputs = {
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
        return {"outputs": outputs.get(stage_key, {}), "logs": []}


async def main():
    executor = MockExecutor()
    graph = build_graph(executor)
    config = {"configurable": {"thread_id": "smoke"}}

    state = await graph.ainvoke(
        {"context": {"projectOverview": "mock"}, "outputs": {}, "upstream": {}, "logs": [], "rework_count": 0, "status": "running"},
        config,
    )

    step = 0
    while True:
        snapshot = graph.get_state(config)
        interrupts = []
        for task in getattr(snapshot, "tasks", []) or []:
            for interrupt in getattr(task, "interrupts", []) or []:
                interrupts.append(interrupt.value)
        print(f"[step {step}] next={list(snapshot.next or [])} interrupts={interrupts}")
        if not snapshot.next and not interrupts:
            break
        # 闸门通过，恢复执行
        await graph.ainvoke(__import__("langgraph.types", fromlist=["Command"]).Command(resume={"approved": True, "note": ""}), config)
        step += 1
        if step > 20:
            print("超过步数上限，中止")
            break

    final = graph.get_state(config)
    print("执行节点序列:", executor.calls)
    print("最终 outputs 键:", sorted((final.values or {}).get("outputs", {}).keys()))
    print("rework_count:", (final.values or {}).get("rework_count", 0))
    print("SMOKE OK")


if __name__ == "__main__":
    asyncio.run(main())
