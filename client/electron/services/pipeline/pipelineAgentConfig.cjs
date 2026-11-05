const LEGAL_RESEARCH_OUTPUT_FILE = 'legal-research.json';

const STAGE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  SUCCESS: 'success',
  ERROR: 'error',
  BLOCKED: 'blocked',
};

const APPROVAL_DECISION = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const PIPELINE_AGENTS = {
  1: {
    id: 1,
    name: '总控编排 Agent',
    role: '幕后大管家',
    description: '按阶段顺序调度各子 Agent，维护共享黑板，在人工闸门处挂起等待确认，不直接撰写标书内容。',
    tools: ['黑板读写', '闸门调度', '状态追踪'],
    inputs: ['项目概述', '资质概况', '招标文件'],
    outputs: ['流水线状态与阶段日志'],
  },
  2: {
    id: 2,
    name: '文档解析与要求提取 Agent',
    role: '要求提取',
    description: '解析招标文件，提取资格条件、实质性条款、评分办法、商务与技术要求。',
    tools: ['read', '文档解析', 'json-validation'],
    inputs: ['招标文件原文', '项目概述'],
    outputs: ['parse-requirements.json'],
  },
  3: {
    id: 3,
    name: '资格审查与材料匹配 Agent',
    role: '资格匹配',
    description: '比对资信库与资格条款，列出满足项、存疑项与缺件材料，提示需补充的证明。',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['解析产物', '公司材料概况', '本地知识库'],
    outputs: ['qualification-match.json'],
  },
  4: {
    id: 4,
    name: '技术分析 Agent',
    role: '技术响应',
    description: '梳理技术评分要点、方案侧重、响应策略与需要在正文中展开的技术条目。',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['解析产物', '资格结论', '本地知识库'],
    outputs: ['technical-analysis.json'],
  },
  5: {
    id: 5,
    name: '法规与案例检索 Agent',
    role: '法规案例',
    description: '联网检索公开适用法规、类似项目案例与风险提示，只引用可核验的公开来源。',
    tools: ['联网检索', 'json-validation'],
    inputs: ['解析产物（资格与技术要求）'],
    outputs: ['legal-research.json'],
  },
  6: {
    id: 6,
    name: '投标文档生成 Agent',
    role: '正文生成',
    description: '依据解析、资格、技术、检索各阶段产物生成投标文档正文，口径以黑板记录为准。',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['各上游阶段产物', '质检反馈清单', '本地知识库'],
    outputs: ['bid-draft.json'],
  },
  7: {
    id: 7,
    name: '一致性检查 Agent',
    role: '质量守门员',
    description: '核对前后口径、废标风险、材料一致与待填写项，输出问题清单与处置建议。',
    tools: ['read', 'json-validation', '结果自检'],
    inputs: ['全上游产物', '投标成稿'],
    outputs: ['consistency-report.json'],
  },
};

const PIPELINE_STAGES = [
  {
    key: 'parse',
    agentId: 2,
    label: '文档解析与要求提取',
    gate: true,
    gateLabel: '口径澄清确认',
    description: '解析招标文件并提取资格、实质性条款与评分要求。',
    dependsOn: [],
    parallelGroup: null,
  },
  {
    key: 'qualification',
    agentId: 3,
    label: '资格审查与材料匹配',
    gate: true,
    gateLabel: '材料缺口确认',
    description: '比对资信库与资格条款，标记满足、存疑与缺件。',
    dependsOn: ['parse'],
    parallelGroup: null,
  },
  {
    key: 'technical',
    agentId: 4,
    label: '技术分析',
    gate: false,
    description: '梳理技术响应要点与评分侧重。',
    dependsOn: ['parse', 'qualification'],
    parallelGroup: 'analysis',
  },
  {
    key: 'legal',
    agentId: 5,
    label: '法规与案例检索',
    gate: true,
    gateLabel: '检索依据定稿',
    description: '联网检索适用法规、类似案例与风险提示。',
    dependsOn: ['parse'],
    parallelGroup: 'analysis',
  },
  {
    key: 'generate',
    agentId: 6,
    label: '投标文档生成',
    gate: true,
    gateLabel: '成稿定稿',
    description: '汇总各阶段产物生成投标文档正文。',
    dependsOn: ['parse', 'qualification', 'technical', 'legal'],
    parallelGroup: null,
  },
  {
    key: 'consistency',
    agentId: 7,
    label: '一致性检查',
    gate: false,
    gateLabel: '质检问题处置',
    description: '核对口径、废标风险与待填写项，输出问题清单；自动回退上限内重跑，超上限转人工复核。',
    dependsOn: ['generate'],
    parallelGroup: null,
  },
];

function getStageByKey(stageKey) {
  return PIPELINE_STAGES.find((stage) => stage.key === stageKey);
}

module.exports = {
  LEGAL_RESEARCH_OUTPUT_FILE,
  STAGE_STATUS,
  APPROVAL_DECISION,
  PIPELINE_AGENTS,
  PIPELINE_STAGES,
  getStageByKey,
};
