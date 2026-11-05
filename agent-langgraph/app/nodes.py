"""LangGraph 图节点。

为每个闸门阶段拆成两类节点：
- `<stage>_run`：回调 Node 执行器跑真实业务，把产物/上游/日志写回图状态后返回；
- `<stage>_gate`：只负责 `interrupt()` 挂起等待人工决议，不执行模型调用。

拆分原因：节点内直接 `interrupt()` 时，本次返回的状态更新尚未落库，挂起期间
快照读不到产物；拆成两个节点后，执行结果在进入闸门前已持久化到 checkpoint。
"""

from datetime import datetime
from typing import Any

from langgraph.types import Command, interrupt

from .classify import classify_issue, high_issues
from .config import MAX_REWORK_ROUNDS, STAGE_BY_KEY


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _is_populated(value: Any) -> bool:
    return isinstance(value, dict) and len(value) > 0


def build_run_node(stage_key: str, executor: Any):
    async def node(state: dict[str, Any]) -> dict[str, Any]:
        context = dict(state.get("context") or {})
        upstream = dict(state.get("upstream") or {})
        prior_outputs = dict(state.get("outputs") or {}).get(stage_key)
        logs = list(state.get("logs") or [])

        # 重入时已有非空产物则复用，避免重复调用模型；
        # 一致性检查必须基于最新成稿每次重新质检，不沿用旧报告。
        reuse_prior = _is_populated(prior_outputs) and stage_key != "consistency"
        if reuse_prior:
            outputs = prior_outputs
        else:
            result = await executor.run_stage(stage_key, context, upstream)
            outputs = result.get("outputs") or {}
            logs.append({"stage": stage_key, "message": "阶段执行完成。", "at": _now()})

        new_outputs = {**dict(state.get("outputs") or {}), stage_key: outputs}
        new_upstream = {**upstream, stage_key: outputs}

        update: dict[str, Any] = {
            "outputs": new_outputs,
            "upstream": new_upstream,
            "logs": logs,
        }

        # 一致性检查产出后，若存在可自纠的 high 一致性问题，累加整改轮次（上限由条件边判定）。
        if stage_key == "consistency":
            all_issues = outputs.get("issues") or []
            consistency_high = [
                issue
                for issue in high_issues(outputs)
                if classify_issue(issue) == "consistency"
            ]
            rework_count = int(state.get("rework_count") or 0)
            if consistency_high and rework_count < MAX_REWORK_ROUNDS:
                feedback_issues = [
                    issue for issue in all_issues if classify_issue(issue) == "consistency"
                ]
                feedback_notes = "\n".join(
                    f"- [{issue.get('severity', '')}] {issue.get('scope', '')}: "
                    f"{issue.get('description', '')}（建议：{issue.get('suggestion', '')}）"
                    for issue in feedback_issues
                )
                update["rework_count"] = rework_count + 1
                # 回传质检反馈与上一轮成稿：生成节点据此只改受影响章节，其余保持原样；
                # 清空旧成稿是为了让图重新执行 generate 节点，而不是复用旧产物。
                previous_draft = new_outputs.get("generate")
                update["context"] = {
                    **context,
                    "feedbackNotes": feedback_notes,
                    "previousDraft": previous_draft if isinstance(previous_draft, dict) else {},
                }
                update["outputs"] = {**new_outputs, "generate": {}}
                update["logs"] = logs + [
                    {
                        "stage": "generate",
                        "message": (
                            f"质检发现 {len(consistency_high)} 项一致性 high 问题，进入第 {rework_count + 1} 轮返工；"
                            "已回传上一轮成稿，本轮只重写受影响章节。"
                        ),
                        "at": _now(),
                    }
                ]

        return update

    return node


def build_gate_node(stage_key: str):
    async def node(state: dict[str, Any]) -> Command[dict[str, Any]]:
        cfg = STAGE_BY_KEY[stage_key]
        decision = interrupt(
            {"stage_key": stage_key, "kind": "approval", "label": cfg["label"]}
        )
        approved = bool(decision.get("approved"))
        update: dict[str, Any] = {
            "approval": {
                "stage_key": stage_key,
                "decision": "approved" if approved else "rejected",
                "note": decision.get("note", ""),
            }
        }

        if not approved:
            # 人工打回：清空本阶段产物，回到执行节点重跑，等待再次确认。
            outputs = dict(state.get("outputs") or {})
            outputs[stage_key] = {}
            update["outputs"] = outputs
            update["logs"] = list(state.get("logs") or []) + [
                {"stage": stage_key, "message": "人工打回，重新执行本阶段。", "at": _now()}
            ]
            return Command(goto=f"{stage_key}_run", update=update)

        return update

    return node
