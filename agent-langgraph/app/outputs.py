"""流水线各节点产物的对外契约（JSON Schema + 示例）。

这份契约同时服务三个消费方：
1. `/graph/schema` 端点：前端据此画真实 UI 或构造假数据；
2. 文档快照 `docs/pipeline-node-outputs.json`（由 `scripts/dump_schema.py` 生成）；
3. 人工复审与导出链路：校验上传标书注入 `outputs["generate"]` 的结构是否合法。

字段名与 Node 侧 `pipelineStageTasks.cjs` 的校验 schema 保持一一对应；
新增字段必须先改这里，再改 Node 侧 schema，否则 `json-validation` 会把整份产物判为格式错误。
"""

from typing import Any

# 每个节点的产物结构：key 与图里的 stage_key 一致。
STAGE_OUTPUT_SPECS: dict[str, dict[str, Any]] = {
    "parse": {
        "label": "文档解析与要求提取",
        "agent_id": 2,
        "output_file": "parse-requirements.json",
        "description": "招标文件的资格条件、实质性条款、评分办法、技术与商务要求。",
        "schema": {
            "type": "object",
            "required": ["qualification", "substantive", "scoring", "technical", "commercial", "notes", "summary"],
            "additionalProperties": False,
            "properties": {
                "qualification": {"type": "array", "items": {"type": "string"}},
                "substantive": {"type": "array", "items": {"type": "string"}},
                "scoring": {"type": "array", "items": {"type": "string"}},
                "technical": {"type": "array", "items": {"type": "string"}},
                "commercial": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "array", "items": {"type": "string"}},
                "summary": {"type": "string"},
            },
        },
        "example": {
            "qualification": ["投标人须具备建筑工程施工总承包三级及以上资质", "近三年具有至少 1 项类似防水工程业绩"],
            "substantive": ["工期不得超过 30 日历天", "投标文件须逐页加盖公章"],
            "scoring": ["施工方案与技术措施 40 分", "质量保证体系 15 分"],
            "technical": ["屋面防水采用 SBS 改性沥青卷材，厚度不小于 4mm"],
            "commercial": ["预算金额 132.13 万元", "付款方式：竣工验收后支付 95%"],
            "notes": ["投标文件须分别编制资格、商务、技术三册"],
            "summary": "某体育中心场馆防水与采光板维修项目，预算 132.13 万元，工期 30 日历天。",
        },
    },
    "qualification": {
        "label": "资格审查与材料匹配",
        "agent_id": 3,
        "output_file": "qualification-match.json",
        "description": "资格条款逐项匹配结果、材料缺口与总体结论。",
        "schema": {
            "type": "object",
            "required": ["checks", "gaps", "conclusion"],
            "additionalProperties": False,
            "properties": {
                "checks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["item", "required", "status", "evidence", "suggestion"],
                        "additionalProperties": False,
                        "properties": {
                            "item": {"type": "string"},
                            "required": {"type": "string"},
                            "status": {"type": "string", "enum": ["pass", "gap", "unknown"]},
                            "evidence": {"type": "string"},
                            "suggestion": {"type": "string"},
                        },
                    },
                },
                "gaps": {"type": "array", "items": {"type": "string"}},
                "conclusion": {"type": "string"},
            },
        },
        "example": {
            "checks": [
                {
                    "item": "施工总承包资质",
                    "required": "建筑工程施工总承包三级及以上",
                    "status": "pass",
                    "evidence": "资信库已登记：建筑工程施工总承包二级",
                    "suggestion": "无需补充",
                }
            ],
            "gaps": ["近三年类似业绩证明材料尚未归档"],
            "conclusion": "主体资格满足，需补齐业绩证明后提交。",
        },
    },
    "technical": {
        "label": "技术分析",
        "agent_id": 4,
        "output_file": "technical-analysis.json",
        "description": "技术评分要点、响应策略、优劣势与正文章节建议。",
        "schema": {
            "type": "object",
            "required": ["topics", "strengths", "weaknesses", "outline"],
            "additionalProperties": False,
            "properties": {
                "topics": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["topic", "requirement", "responseStrategy", "risk"],
                        "additionalProperties": False,
                        "properties": {
                            "topic": {"type": "string"},
                            "requirement": {"type": "string"},
                            "responseStrategy": {"type": "string"},
                            "risk": {"type": "string"},
                        },
                    },
                },
                "strengths": {"type": "array", "items": {"type": "string"}},
                "weaknesses": {"type": "array", "items": {"type": "string"}},
                "outline": {"type": "array", "items": {"type": "string"}},
            },
        },
        "example": {
            "topics": [
                {
                    "topic": "屋面防水施工工艺",
                    "requirement": "SBS 卷材厚度不小于 4mm，二级设防",
                    "responseStrategy": "双道设防 + 阴阳角附加层，附节点大样",
                    "risk": "雨季施工窗口短，需明确排水与成品保护措施",
                }
            ],
            "strengths": ["自有防水专业班组，可承诺 30 日历天"],
            "weaknesses": ["高处作业安全方案需细化"],
            "outline": ["工程概况及施工范围", "防水施工工艺", "质量保证措施"],
        },
    },
    "legal": {
        "label": "法规与案例检索",
        "agent_id": 5,
        "output_file": "legal-research.json",
        "description": "可核验的公开法规、类似案例、合规风险与来源链接。",
        "schema": {
            "type": "object",
            "required": ["laws", "cases", "risks", "sources"],
            "additionalProperties": False,
            "properties": {
                "laws": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["title", "point", "source_url", "applicability"],
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string"},
                            "point": {"type": "string"},
                            "source_url": {"type": "string"},
                            "applicability": {"type": "string"},
                        },
                    },
                },
                "cases": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["title", "point", "source_url"],
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string"},
                            "point": {"type": "string"},
                            "source_url": {"type": "string"},
                        },
                    },
                },
                "risks": {"type": "array", "items": {"type": "string"}},
                "sources": {"type": "array", "items": {"type": "string"}},
            },
        },
        "example": {
            "laws": [
                {
                    "title": "建设工程质量管理条例",
                    "point": "施工单位对施工质量负责，防水工程保修期不低于 5 年",
                    "source_url": "https://www.gov.cn/",
                    "applicability": "需在质量承诺章节明确 5 年保修",
                }
            ],
            "cases": [
                {"title": "某体育馆屋面防水改造案例", "point": "采用分区流水施工缩短工期", "source_url": "https://example.com/case"}
            ],
            "risks": ["高空作业需专项安全方案"],
            "sources": ["https://www.gov.cn/"],
        },
    },
    "generate": {
        "label": "投标文档生成",
        "agent_id": 6,
        "output_file": "bid-draft.json",
        "description": "成稿章节与概述；人工上传复审时由上传文本直接填充，`source=manual`。",
        "schema": {
            "type": "object",
            "required": ["sections", "summary"],
            "additionalProperties": False,
            "properties": {
                "sections": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["heading", "content"],
                        "additionalProperties": False,
                        "properties": {
                            "heading": {"type": "string"},
                            "content": {"type": "string"},
                        },
                    },
                },
                "summary": {"type": "string"},
            },
        },
        "example": {
            "sections": [
                {"heading": "第一章 工程概况及施工范围", "content": "本工程为某体育中心场馆防水及采光板维修……"},
                {"heading": "第二章 施工方案与技术措施", "content": "【待补充：屋面基层处理工艺】"},
            ],
            "summary": "共 8 章 84 节，约 13.5 万字。",
            "source": "manual",
            "fileName": "投标文件_周口市体育事业发展中心.docx",
            "chars": 135543,
        },
    },
    "consistency": {
        "label": "一致性检查",
        "agent_id": 7,
        "output_file": "consistency-report.json",
        "description": "问题清单、评分、是否通过，以及逐条比对报告（comparison）。",
        "schema": {
            "type": "object",
            "required": ["issues", "score", "passed", "summary"],
            "additionalProperties": False,
            "properties": {
                "issues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["scope", "severity", "description", "suggestion"],
                        "additionalProperties": False,
                        "properties": {
                            "scope": {"type": "string"},
                            "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                            "description": {"type": "string"},
                            "suggestion": {"type": "string"},
                            "category": {"type": "string", "enum": ["consistency", "missing_material", ""]},
                            "source": {"type": "string", "enum": ["model", "rule_audit"]},
                        },
                    },
                },
                "score": {"type": "number", "minimum": 0, "maximum": 100},
                "passed": {"type": "boolean"},
                "summary": {"type": "string"},
                "comparison": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["item", "required", "status", "evidence"],
                        "additionalProperties": False,
                        "properties": {
                            "item": {"type": "string"},
                            "required": {"type": "string"},
                            "status": {"type": "string", "enum": ["responded", "partial", "missing"]},
                            "evidence": {"type": "string"},
                        },
                    },
                },
            },
        },
        "example": {
            "issues": [
                {
                    "scope": "第二章 施工方案与技术措施",
                    "severity": "high",
                    "description": "成稿对实质性条款「工期不得超过 30 日历天」未作明确响应",
                    "suggestion": "在该章节补充工期承诺与进度计划，明确 30 日历天",
                    "category": "consistency",
                    "source": "rule_audit",
                }
            ],
            "score": 61,
            "passed": False,
            "summary": "发现 1 项 high 一致性问题，可自动回退整改。",
            "comparison": [
                {
                    "item": "工期不得超过 30 日历天",
                    "required": "实质性条款",
                    "status": "missing",
                    "evidence": "全文未出现「30 日历天」",
                }
            ],
        },
    },
    "final_approval": {
        "label": "终审签发",
        "agent_id": 1,
        "output_file": None,
        "description": "人工终审闸门。approve 后才允许导出 Word；reject 会把意见回传生成节点重跑。",
        "schema": {
            "type": "object",
            "required": ["decision", "note"],
            "additionalProperties": False,
            "properties": {
                "decision": {"type": "string", "enum": ["pending", "approved", "rejected"]},
                "note": {"type": "string"},
                "at": {"type": "string"},
            },
        },
        "example": {"decision": "approved", "note": "终审通过，允许导出", "at": "2026-11-06T23:20:00"},
    },
}


def schema_payload() -> dict[str, Any]:
    """给前端的完整节点契约。"""
    return {
        "version": 2,
        "nodes": STAGE_OUTPUT_SPECS,
        "notes": [
            "issues[].category=consistency 的 high 问题会触发自动回退重生成；missing_material 只提示人工补料。",
            "凡带 source=rule_audit 的问题来自规则审计，不依赖模型，演示时可稳定复现。",
            "comparison 为逐条比对报告：responded/partial/missing 三态。",
        ],
    }
