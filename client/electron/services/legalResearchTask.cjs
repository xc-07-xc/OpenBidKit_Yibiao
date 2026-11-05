const Ajv = require('ajv');
const { LEGAL_RESEARCH_OUTPUT_FILE } = require('./pipeline/pipelineAgentConfig.cjs');

const LEGAL_RESEARCH_SCHEMA = {
  type: 'object',
  required: ['laws', 'cases', 'risks', 'sources'],
  additionalProperties: false,
  properties: {
    laws: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'point'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          point: { type: 'string', minLength: 1 },
          source_url: { type: 'string' },
          applicability: { type: 'string' },
        },
      },
    },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'point'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          point: { type: 'string', minLength: 1 },
          source_url: { type: 'string' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string', minLength: 1 } },
    sources: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

const legalAjv = new Ajv({ allErrors: true, strict: true });
const validateLegalSchema = legalAjv.compile(LEGAL_RESEARCH_SCHEMA);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeEntryList(value, withUrl) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const entry = {
        title: String(item.title || '').trim(),
        point: String(item.point || '').trim(),
      };
      if (withUrl) entry.source_url = String(item.source_url || '').trim();
      if (item.applicability !== undefined) entry.applicability = String(item.applicability || '').trim();
      return entry.title && entry.point ? entry : null;
    })
    .filter(Boolean);
}

function normalizeLegalResearchOutput(generated) {
  return {
    laws: normalizeEntryList(generated?.laws, true),
    cases: normalizeEntryList(generated?.cases, true),
    risks: normalizeStringList(generated?.risks),
    sources: normalizeStringList(generated?.sources),
  };
}

function validateLegalResearchOutput(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || '').trim());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      value: null,
      issues: [{ severity: 'blocking', file: LEGAL_RESEARCH_OUTPUT_FILE, message: `${LEGAL_RESEARCH_OUTPUT_FILE} 不是合法 JSON：${error.message}` }],
    };
  }
  if (!validateLegalSchema(parsed)) {
    return {
      value: parsed,
      issues: validateLegalSchema.errors.map((item) => ({
        severity: 'blocking',
        file: LEGAL_RESEARCH_OUTPUT_FILE,
        path: item.instancePath || '/',
        message: `${LEGAL_RESEARCH_OUTPUT_FILE} 格式错误：${item.instancePath || '/'} ${item.message}`,
      })),
    };
  }
  return { value: normalizeLegalResearchOutput(parsed), issues: [] };
}

function buildLegalPrompt(context) {
  const overview = String(context?.projectOverview || '').trim() || '未提供项目概述。';
  const requirements = String(context?.requirements || '').trim() || '未提供提取出的招标要求。';
  return [
    '你是投标团队的法规与案例检索 Agent。请围绕本次投标项目，联网检索公开可核验的适用法规、规范性文件、类似公开案例与合规风险提示。',
    '',
    '检索边界与红线：',
    '1. 只搜索公开网页，使用 parallel-web-search / parallel-web-fetch 工具；',
    '2. 搜索词只能包含项目所属行业、采购类别、通用法规主题等公开信息，严禁把招标文件原文、本公司资信、业绩、人员、客户名称等非公开信息带进搜索词；',
    '3. 检索不到的法规或案例如实留空，不得编造法条编号、文号、案例名称、裁判文书或网页链接；',
    '4. 每条法规或案例必须能对应到公开来源，source_url 无法核验时留空字符串；',
    '5. 输出内容仅供投标参考，不替代正式法律意见。',
    '',
    `项目概述：\n${overview}`,
    '',
    `已提取的招标要求：\n${requirements}`,
    '',
    `完成后把结果写入 ${LEGAL_RESEARCH_OUTPUT_FILE}，结构如下：`,
    '{"laws":[{"title":"法规或规范性文件名称","point":"与本次投标相关的要点","source_url":"公开来源链接或留空","applicability":"对本项目的适用说明或留空"}],"cases":[{"title":"公开案例名称","point":"可借鉴的做法或风险提示","source_url":"公开来源链接或留空"}],"risks":["需要提示的合规或应答风险"],"sources":["本次实际参考的公开网页链接"]}',
  ].join('\n');
}

function buildLegalFiles(context) {
  const files = [];
  const overview = String(context?.projectOverview || '').trim();
  const requirements = String(context?.requirements || '').trim();
  if (overview) files.push({ path: '项目概述.md', content: overview });
  if (requirements) files.push({ path: '招标要求.md', content: requirements });
  return files;
}

async function runLegalResearchTask({ agentService, taskId, signal, context, onActivity }) {
  const agentResult = await agentService.runTask({
    task_id: taskId,
    title: '法规与案例检索',
    summary_enabled: false,
    prompt: buildLegalPrompt(context || {}),
    output_file: LEGAL_RESEARCH_OUTPUT_FILE,
    files: buildLegalFiles(context || {}),
    signal,
    // 法规阶段唯一允许联网的 Agent：只开放只读检索工具与结果校验，不开放交互问答。
    active_tools: ['json-validation', 'report-failure', 'parallel-web-search', 'parallel-web-fetch'],
    parallel_search: true,
    json_validation_schemas: {
      [LEGAL_RESEARCH_OUTPUT_FILE]: LEGAL_RESEARCH_SCHEMA,
    },
    validateOutput: (candidate) => validateLegalResearchOutput(candidate.output_content),
    onActivity,
  });
  return agentResult.validation_result || normalizeLegalResearchOutput(null);
}

module.exports = {
  LEGAL_RESEARCH_SCHEMA,
  LEGAL_RESEARCH_OUTPUT_FILE,
  validateLegalResearchOutput,
  normalizeLegalResearchOutput,
  buildLegalPrompt,
  runLegalResearchTask,
};
