"""质检问题分类：与 Electron 侧 orchestrator.cjs 关键词兜底保持一致。"""

from typing import Any

MISSING_MATERIAL_KEYWORDS = [
    "待补充", "待提供", "缺失", "空缺", "占位", "空壳", "未提供", "缺少",
    "报价", "价格", "预算金额", "资质", "业绩", "人员", "设备", "机械",
    "营业执照", "财务", "社保", "纳税", "证明材料", "材料缺口", "承诺函",
    "声明函", "公章", "复印件", "工程量清单", "附件材料",
]
CONSISTENCY_KEYWORDS = [
    "不一致", "冲突", "矛盾", "口径", "偏离", "错误", "遗漏", "前后",
    "响应", "期限", "工期", "承诺", "变更", "修改",
]


def classify_issue(issue: dict[str, Any]) -> str:
    explicit = str(issue.get("category") or "").strip().lower()
    if explicit in ("missing_material", "missing"):
        return "missing"
    if explicit in ("consistency", "consistency_error"):
        return "consistency"
    text = f"{issue.get('scope', '')} {issue.get('description', '')} {issue.get('suggestion', '')}"
    if any(kw in text for kw in MISSING_MATERIAL_KEYWORDS):
        return "missing"
    if any(kw in text for kw in CONSISTENCY_KEYWORDS):
        return "consistency"
    return "consistency"


def high_issues(outputs: dict[str, Any]) -> list[dict[str, Any]]:
    issues = outputs.get("issues") or []
    return [issue for issue in issues if issue.get("severity") == "high"]
