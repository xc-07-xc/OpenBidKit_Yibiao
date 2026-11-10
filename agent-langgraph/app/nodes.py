"""LangGraph 图节点。

节点分三类：
- `<stage>_run`：回调 Node 执行器跑真实业务，把产物/上游/日志写回图状态后返回；
- `<stage>_gate`：只负责 `interrupt()` 挂起等待人工决议，不执行模型调用；
- `review_ingest`：人工上传标书复审时，把上传成稿直接写进 `outputs["generate"]`，
  不重跑解析与生成，随后直接进一致性检查。

闸门不返回 `Command(goto=...)`：命令式跳转会和静态边同时生效，导致“打回本阶段”的同一次
superstep 里下一阶段也被触发。改为只写 `approval` 状态，由 `graph.py` 的条件边决定
是回到本阶段执行节点，还是进入下一阶段。

自动返工闭环（consistency → 清空旧稿 → 携带意见重生成 → 再次质检）由 `rework_pending`
驱动：生成节点完成后，`route_after_generate` 看到该标记会直接回到一致性检查，
不再要求人工在“成稿定稿”闸门重复确认，保证闭环可以自动跑完。
"""

from datetime import datetime
from typing import Any

from langgraph.types import interrupt

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

        # 新成稿落地后，上一轮的终审结论失效，必须重新签发。
        if stage_key == "generate":
            update["final_approval"] = {"decision": "pending", "note": ""}
            if state.get("rework_pending"):
                # rework_count 在质检节点已按 1 起累加，这里直接用它，避免“第 3 轮”其实只跑了两轮。
                round_no = max(1, int(state.get("rework_count") or 1))
                update["logs"] = logs + [
                    {
                        "stage": "generate",
                        "message": f"按质检意见完成第 {round_no} 轮重生成（仅重写受影响章节）。",
                        "at": _now(),
                    }
                ]

        # 一致性检查产出后，若存在可自纠的 high 一致性问题，累加整改轮次（上限由条件边判定）。
        if stage_key == "consistency":
            all_issues = outputs.get("issues") or []
            consistency_high = [
                issue
                for issue in high_issues(outputs)
                if classify_issue(issue) == "consistency"
            ]
            rework_count = int(state.get("rework_count") or 0)
            should_rework = bool(consistency_high) and rework_count < MAX_REWORK_ROUNDS
            update["rework_pending"] = should_rework
            if should_rework:
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
            elif consistency_high:
                update["logs"] = logs + [
                    {
                        "stage": "consistency",
                        "message": (
                            f"已达自动整改上限 {MAX_REWORK_ROUNDS} 轮，仍有 "
                            f"{len(consistency_high)} 项 high 一致性问题，转终审人工处置。"
                        ),
                        "at": _now(),
                    }
                ]

        return update

    return node


def build_gate_node(stage_key: str):
    async def node(state: dict[str, Any]) -> dict[str, Any]:
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
            # 人工打回：清空本阶段产物，条件边会把执行流送回 `<stage>_run` 重跑。
            outputs = dict(state.get("outputs") or {})
            outputs[stage_key] = {}
            update["outputs"] = outputs
            update["logs"] = list(state.get("logs") or []) + [
                {"stage": stage_key, "message": "人工打回，重新执行本阶段。", "at": _now()}
            ]

        return update

    return node


def build_final_gate_node():
    """终审闸门：通过才允许导出 Word；打回则携带意见退回重生成。"""

    async def node(state: dict[str, Any]) -> dict[str, Any]:
        decision = interrupt(
            {"stage_key": "final_approval", "kind": "final_approval", "label": "终审签发"}
        )
        approved = bool(decision.get("approved"))
        note = str(decision.get("note") or "")
        logs = list(state.get("logs") or [])
        update: dict[str, Any] = {
            "final_approval": {
                "decision": "approved" if approved else "rejected",
                "note": note,
                "at": _now(),
            },
            "approval": {
                "stage_key": "final_approval",
                "decision": "approved" if approved else "rejected",
                "note": note,
            },
        }

        if approved:
            update["status"] = "ready_to_export"
            update["logs"] = logs + [
                {"stage": "final_approval", "message": "终审通过，允许导出 Word。", "at": _now()}
            ]
            return update

        # 打回：清空成稿、保留上一轮原件，把终审意见写成 feedbackNotes 交给生成节点。
        outputs = dict(state.get("outputs") or {})
        previous_draft = outputs.get("generate")
        outputs["generate"] = {}
        update["outputs"] = outputs
        update["rework_pending"] = True
        update["rework_count"] = int(state.get("rework_count") or 0) + 1
        update["context"] = {
            **dict(state.get("context") or {}),
            "feedbackNotes": note or "终审打回：请按评审意见修订后重新提交。",
            "previousDraft": previous_draft if isinstance(previous_draft, dict) else {},
            "finalReject": True,
        }
        update["logs"] = logs + [
            {
                "stage": "final_approval",
                "message": f"终审打回：{note or '未填写意见'}；已退回生成节点重写受影响章节。",
                "at": _now(),
            }
        ]
        return update

    return node


def build_review_ingest_node():
    """人工上传标书复审：把上传文本直接塞进 `outputs["generate"]`。

    不重跑解析与生成；`review_reference` 里的历史解析产物只作为比对基准，
    不会被标记为“本轮已执行”，避免前端误以为解析阶段又跑了一遍。
    """

    async def node(state: dict[str, Any]) -> dict[str, Any]:
        draft = dict(state.get("review_draft") or {})
        reference = dict(state.get("review_reference") or {})
        sections = draft.get("sections") if isinstance(draft.get("sections"), list) else []
        chars = int(draft.get("chars") or 0)
        logs = list(state.get("logs") or [])
        logs.append(
            {
                "stage": "generate",
                "message": (
                    f"人工上传标书已注入 outputs[generate]：{len(sections)} 节 / {chars} 字，"
                    "跳过解析与生成，直接进入一致性检查。"
                ),
                "at": _now(),
            }
        )
        return {
            "mode": "review",
            "outputs": {"generate": draft},
            "upstream": {**reference, "generate": draft},
            "logs": logs,
        }

    return node
