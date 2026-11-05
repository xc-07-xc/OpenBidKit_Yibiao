"""服务配置与阶段契约镜像。

阶段配置与 Electron 侧 `pipelineAgentConfig.cjs` 保持一致：
key / agentId / label / gate / dependsOn / parallelGroup。
"""

import os

# Node 主进程内部执行端点（复用现有 Runner）
NODE_INTERNAL_BASE_URL = os.environ.get("NODE_INTERNAL_BASE_URL", "http://127.0.0.1:8788")

# LangGraph 服务自身监听端口
SERVICE_PORT = int(os.environ.get("LANGGRAPH_SERVICE_PORT", "8765"))

MAX_STAGE_RETRY = 1
MAX_REWORK_ROUNDS = 2

# 阶段顺序与闸门声明（镜像 PIPELINE_STAGES）
PIPELINE_STAGES = [
    {
        "key": "parse",
        "agentId": 2,
        "label": "文档解析与要求提取",
        "gate": True,
        "dependsOn": [],
        "parallelGroup": None,
    },
    {
        "key": "qualification",
        "agentId": 3,
        "label": "资格审查与材料匹配",
        "gate": True,
        "dependsOn": ["parse"],
        "parallelGroup": None,
    },
    {
        "key": "technical",
        "agentId": 4,
        "label": "技术分析",
        "gate": False,
        "dependsOn": ["parse", "qualification"],
        "parallelGroup": "analysis",
    },
    {
        "key": "legal",
        "agentId": 5,
        "label": "法规与案例检索",
        "gate": True,
        "dependsOn": ["parse"],
        "parallelGroup": "analysis",
    },
    {
        "key": "generate",
        "agentId": 6,
        "label": "投标文档生成",
        "gate": True,
        "dependsOn": ["parse", "qualification", "technical", "legal"],
        "parallelGroup": None,
    },
    {
        "key": "consistency",
        "agentId": 7,
        "label": "一致性检查",
        "gate": False,
        "dependsOn": ["generate"],
        "parallelGroup": None,
    },
]

STAGE_BY_KEY = {stage["key"]: stage for stage in PIPELINE_STAGES}
