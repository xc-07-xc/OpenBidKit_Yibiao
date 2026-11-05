import type { PipelineStageStatus } from '../../shared/types/ipc';

export const AGENT_NAMES: Record<number, string> = {
  1: '总控编排 Agent',
  2: '文档解析与要求提取 Agent',
  3: '资格审查与材料匹配 Agent',
  4: '技术分析 Agent',
  5: '法规与案例检索 Agent',
  6: '投标文档生成 Agent',
  7: '一致性检查 Agent',
};

export const STATUS_META: Record<PipelineStageStatus, { label: string; tone: string }> = {
  pending: { label: '待执行', tone: 'is-pending' },
  running: { label: '执行中', tone: 'is-running' },
  waiting_approval: { label: '待人工确认', tone: 'is-gate' },
  success: { label: '已通过', tone: 'is-success' },
  error: { label: '失败', tone: 'is-error' },
  blocked: { label: '阻塞', tone: 'is-error' },
};

export interface TeamContract {
  agentId: number;
  role: string;
  tools: string[];
  inputs: string[];
  outputs: string[];
  dependsOn: string[];
  parallelGroup?: string | null;
}

export const TEAM_CONTRACTS: TeamContract[] = [
  {
    agentId: 1,
    role: '幕后大管家',
    tools: ['黑板读写', '闸门调度', '状态追踪'],
    inputs: ['项目概述', '资质概况', '招标文件'],
    outputs: ['流水线状态与阶段日志'],
    dependsOn: [],
  },
  {
    agentId: 2,
    role: '要求提取',
    tools: ['read', '文档解析', 'json-validation'],
    inputs: ['招标文件原文', '项目概述'],
    outputs: ['parse-requirements.json'],
    dependsOn: [],
  },
  {
    agentId: 3,
    role: '资格匹配',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['解析产物', '公司材料概况', '本地知识库'],
    outputs: ['qualification-match.json'],
    dependsOn: ['文档解析与要求提取'],
  },
  {
    agentId: 4,
    role: '技术响应',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['解析产物', '资格结论', '本地知识库'],
    outputs: ['technical-analysis.json'],
    dependsOn: ['文档解析与要求提取', '资格审查与材料匹配'],
    parallelGroup: 'analysis',
  },
  {
    agentId: 5,
    role: '法规案例',
    tools: ['联网检索', 'json-validation'],
    inputs: ['解析产物（资格与技术要求）'],
    outputs: ['legal-research.json'],
    dependsOn: ['文档解析与要求提取'],
    parallelGroup: 'analysis',
  },
  {
    agentId: 6,
    role: '正文生成',
    tools: ['read', '知识库检索', 'json-validation'],
    inputs: ['各上游阶段产物', '质检反馈清单', '本地知识库'],
    outputs: ['bid-draft.json'],
    dependsOn: ['文档解析', '资格审查', '技术分析', '法规检索'],
  },
  {
    agentId: 7,
    role: '质量守门员',
    tools: ['read', 'json-validation', '结果自检'],
    inputs: ['全上游产物', '投标成稿'],
    outputs: ['consistency-report.json'],
    dependsOn: ['投标文档生成'],
  },
];

export const PIPELINE_STATUS_LABELS: Record<string, string> = {
  idle: '未启动',
  running: '流水线执行中',
  waiting_approval: '等待人工闸门确认',
  success: '流水线已完成',
  error: '流水线出现错误',
};
