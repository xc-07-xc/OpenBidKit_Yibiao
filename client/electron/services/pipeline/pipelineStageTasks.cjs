const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: true });

function strList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeEntryList(value, keys) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const entry = {};
      for (const key of keys) entry[key] = String(item[key] || '').trim();
      return entry;
    })
    .filter(Boolean);
}

function summarizeUpstream(upstream) {
  const entries = Object.entries(upstream || {}).filter(([, outputs]) => outputs && typeof outputs === 'object');
  if (!entries.length) return '（上游暂无产物）';
  return entries
    .map(([stageKey, outputs]) => {
      const safe = JSON.stringify(outputs, null, 2);
      return `【上游阶段：${stageKey}】\n${safe}`;
    })
    .join('\n\n');
}

function knowledgeSection(context) {
  const hits = String(context?.knowledgeHits || '').trim();
  return hits ? `\n【本地知识库参考】\n${hits}\n` : '';
}

function feedbackSection(context) {
  const notes = String(context?.feedbackNotes || '').trim();
  return notes ? `\n【上一轮质检反馈，本轮必须优先回应并逐条消除】\n${notes}\n` : '';
}

function makeValidator({ outputFile, schema, normalize }) {
  const validate = ajv.compile(schema);
  return function validateOutput(content) {
    let parsed;
    try {
      parsed = JSON.parse(String(content || '').trim());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {
        value: null,
        issues: [{ severity: 'blocking', file: outputFile, message: `${outputFile} 不是合法 JSON：${error.message}` }],
      };
    }
    if (!validate(parsed)) {
      return {
        value: parsed,
        issues: validate.errors.map((item) => ({
          severity: 'blocking',
          file: outputFile,
          path: item.instancePath || '/',
          message: `${outputFile} 格式错误：${item.instancePath || '/'} ${item.message}`,
        })),
      };
    }
    return { value: normalize(parsed), issues: [] };
  };
}

const PARSE_SCHEMA = {
  type: 'object',
  required: ['qualification', 'substantive', 'scoring', 'technical', 'commercial', 'notes', 'summary'],
  additionalProperties: false,
  properties: {
    qualification: { type: 'array', items: { type: 'string' } },
    substantive: { type: 'array', items: { type: 'string' } },
    scoring: { type: 'array', items: { type: 'string' } },
    technical: { type: 'array', items: { type: 'string' } },
    commercial: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

const QUALIFICATION_SCHEMA = {
  type: 'object',
  required: ['checks', 'gaps', 'conclusion'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'required', 'status', 'evidence', 'suggestion'],
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          required: { type: 'string' },
          status: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string', minLength: 1 } },
    conclusion: { type: 'string' },
  },
};

const TECHNICAL_SCHEMA = {
  type: 'object',
  required: ['topics', 'strengths', 'weaknesses', 'outline'],
  additionalProperties: false,
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'requirement', 'responseStrategy', 'risk'],
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          requirement: { type: 'string' },
          responseStrategy: { type: 'string' },
          risk: { type: 'string' },
        },
      },
    },
    strengths: { type: 'array', items: { type: 'string', minLength: 1 } },
    weaknesses: { type: 'array', items: { type: 'string', minLength: 1 } },
    outline: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

const GENERATE_SCHEMA = {
  type: 'object',
  required: ['sections', 'summary'],
  additionalProperties: false,
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['heading', 'content'],
        additionalProperties: false,
        properties: {
          heading: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

const CONSISTENCY_SCHEMA = {
  type: 'object',
  required: ['issues', 'score', 'passed', 'summary'],
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['scope', 'severity', 'description', 'suggestion'],
        additionalProperties: false,
        properties: {
          scope: { type: 'string' },
          severity: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
          category: { type: 'string' },
        },
      },
    },
    score: { type: 'number', minimum: 0, maximum: 100 },
    passed: { type: 'boolean' },
    summary: { type: 'string' },
  },
};

// 阶段工具白名单：只启用该角色需要的自定义工具，read/write/edit/bash 等原生工具由 Pi 运行时保留。
// 自动流水线里禁用 ask-user，避免阶段停在交互问答；联网检索只对法规阶段开放。
const STAGE_ACTIVE_TOOLS = {
  parse: ['json-validation', 'report-failure'],
  qualification: ['json-validation', 'report-failure'],
  technical: ['json-validation', 'report-failure'],
  generate: ['json-validation', 'report-failure'],
  consistency: ['json-validation', 'report-failure'],
};

const STAGE_TASKS = {
  parse: {
    outputFile: 'parse-requirements.json',
    title: '文档解析与要求提取',
    schema: PARSE_SCHEMA,
    requiresSource: true,
    empty: () => ({ qualification: [], substantive: [], scoring: [], technical: [], commercial: [], notes: [], summary: '' }),
    resolveSourceText: (context) => {
      const tender = String(context?.tenderText || '').trim();
      const overview = String(context?.projectOverview || '').trim();
      return [tender, overview].filter(Boolean).join('\n\n');
    },
    normalize: (parsed) => ({
      qualification: strList(parsed.qualification),
      substantive: strList(parsed.substantive),
      scoring: strList(parsed.scoring),
      technical: strList(parsed.technical),
      commercial: strList(parsed.commercial),
      notes: strList(parsed.notes),
      summary: String(parsed.summary || '').trim(),
    }),
    buildPrompt: (context) => {
      const source = STAGE_TASKS.parse.resolveSourceText(context);
      const body = source || '（未提供招标文件原文或概述，工作区也未发现可解析材料）';
      return [
        '你是投标团队的文档解析与要求提取 Agent。请只依据下面给出的招标文本，提取资格条件、实质性条款、评分办法、技术要求与商务要求，供后续阶段使用。',
        '',
        '提取红线：',
        '1. 只做提取与归类，不补充文本中没有的条件，不臆测评分细则；',
        '2. 文本中未出现的类别，对应数组留空；',
        '3. 每条要求尽量保留原文关键表述，避免改写后丢失约束强度；',
        '4. 输入文本不足以判断时，在 notes 中注明缺失项，不要编造。',
        '',
        `招标文本：\n${body}`,
        '',
        `完成后把结果写入 parse-requirements.json，结构如下：`,
        '{"qualification":["资格条件，如资质、业绩、人员、财务要求"],"substantive":["实质性条款或否决项"],"scoring":["评分办法与分值要点"],"technical":["技术要求与参数"],"commercial":["商务、报价、付款、工期要求"],"notes":["其他注意事项或文本缺失说明"],"summary":"一句话概括本次招标要点"}',
      ].join('\n');
    },
    buildFiles: (context) => {
      const source = STAGE_TASKS.parse.resolveSourceText(context);
      return source ? [{ path: '招标文本.md', content: source }] : [];
    },
  },

  qualification: {
    outputFile: 'qualification-match.json',
    title: '资格审查与材料匹配',
    schema: QUALIFICATION_SCHEMA,
    empty: () => ({ checks: [], gaps: [], conclusion: '' }),
    normalize: (parsed) => ({
      checks: normalizeEntryList(parsed.checks, ['item', 'required', 'status', 'evidence', 'suggestion']).map((entry) => ({
        item: entry.item,
        required: entry.required,
        status: ['pass', 'gap', 'unknown'].includes(entry.status) ? entry.status : 'unknown',
        evidence: entry.evidence,
        suggestion: entry.suggestion,
      })),
      gaps: strList(parsed.gaps),
      conclusion: String(parsed.conclusion || '').trim(),
    }),
    buildPrompt: (context) => {
      const requirements = summarizeUpstream(context?.upstream);
      const company = String(context?.companyProfile || '').trim() || '（未提供本公司资质与已有材料概况）';
      return [
        '你是投标团队的资格审查与材料匹配 Agent。请对照上游提取的资格条件，结合本公司已知材料概况，逐项判断满足、存疑或缺件。',
        '',
        '判断红线：',
        '1. 不联网检索；本地知识库条目仅作线索，不能替代本公司真实证明材料；',
        '2. 公司材料概况缺失或无法判断时，status 必须标 unknown，不得臆断为已具备；',
        '3. 缺件或不满足时在 gaps 中列出需补充的证明材料；',
        '4. 每条结论给出可执行的补件或处置建议。',
        '',
        `本公司已知材料概况：\n${company}`,
        '',
        `上游资格要求：\n${requirements}`,
        knowledgeSection(context),
        '',
        `完成后把结果写入 qualification-match.json，结构如下：`,
        '{"checks":[{"item":"资格项名称","required":"招标要求原文要点","status":"pass|gap|unknown","evidence":"已知材料依据或说明无法判断","suggestion":"补件或处置建议"}],"gaps":["需要补充的材料或证明"],"conclusion":"资格匹配总体结论"}',
      ].join('\n');
    },
    buildFiles: (context) => {
      const files = [];
      const company = String(context?.companyProfile || '').trim();
      if (company) files.push({ path: '公司材料概况.md', content: company });
      return files;
    },
  },

  technical: {
    outputFile: 'technical-analysis.json',
    title: '技术分析',
    schema: TECHNICAL_SCHEMA,
    empty: () => ({ topics: [], strengths: [], weaknesses: [], outline: [] }),
    normalize: (parsed) => ({
      topics: normalizeEntryList(parsed.topics, ['topic', 'requirement', 'responseStrategy', 'risk']),
      strengths: strList(parsed.strengths),
      weaknesses: strList(parsed.weaknesses),
      outline: strList(parsed.outline),
    }),
    buildPrompt: (context) => {
      const upstream = summarizeUpstream(context?.upstream);
      return [
        '你是投标团队的技术分析 Agent。请基于上游提取的技术要求与资格结论，梳理技术评分要点、响应策略、方案侧重与需要在正文中展开的技术条目。',
        '',
        '分析红线：',
        '1. 只依据上游产物与给定信息，不虚构技术参数、专利或业绩；',
        '2. 风险条目要指出可能的偏离点与应对方向；',
        '3. outline 用于指导后续正文技术章节编排，按条目列出。',
        '',
        `上游产物：\n${upstream}`,
        knowledgeSection(context),
        '',
        `完成后把结果写入 technical-analysis.json，结构如下：`,
        '{"topics":[{"topic":"技术主题","requirement":"对应招标技术要求","responseStrategy":"响应策略与方案侧重","risk":"偏离风险或注意事项"}],"strengths":["可突出的技术优势方向"],"weaknesses":["需要补强或规避的薄弱点"],"outline":["技术正文章节条目"]}',
      ].join('\n');
    },
    buildFiles: () => [],
  },

  generate: {
    outputFile: 'bid-draft.json',
    title: '投标文档生成',
    schema: GENERATE_SCHEMA,
    empty: () => ({ sections: [], summary: '' }),
    normalize: (parsed) => ({
      sections: normalizeEntryList(parsed.sections, ['heading', 'content']),
      summary: String(parsed.summary || '').trim(),
    }),
    buildPrompt: (context) => {
      const upstream = summarizeUpstream(context?.upstream);
      return [
        '你是投标文档生成 Agent。请依据黑板上游各阶段产物，生成投标文档正文骨架与各章节内容，口径以上游记录为准。',
        '',
        '生成红线：',
        '1. 不编造资质、业绩、人员、奖项、检测报告等需要证明的材料；',
        '2. 上游缺少支撑材料的位置，用明确占位提示（如【待补充：…】）标出，不要虚构；',
        '3. 章节标题与内容对应上游技术分析 outline；',
        '4. 语言为正式投标书面语，不出现口语化表述。',
        '',
        `上游产物：\n${upstream}`,
        feedbackSection(context),
        knowledgeSection(context),
        '',
        `完成后把结果写入 bid-draft.json，结构如下：`,
        '{"sections":[{"heading":"章节标题","content":"章节正文或占位提示"}],"summary":"成稿概述与待办提示"}',
      ].join('\n');
    },
    buildFiles: () => [],
  },

  consistency: {
    outputFile: 'consistency-report.json',
    title: '一致性检查',
    schema: CONSISTENCY_SCHEMA,
    empty: () => ({ issues: [], score: 0, passed: false, summary: '' }),
    normalize: (parsed) => ({
      issues: normalizeEntryList(parsed.issues, ['scope', 'severity', 'description', 'suggestion', 'category']).map((entry) => ({
        scope: entry.scope,
        severity: ['high', 'medium', 'low'].includes(entry.severity) ? entry.severity : 'low',
        description: entry.description,
        suggestion: entry.suggestion,
        category: ['consistency', 'missing_material'].includes(entry.category) ? entry.category : '',
      })),
      score: Number(parsed.score) || 0,
      passed: Boolean(parsed.passed),
      summary: String(parsed.summary || '').trim(),
    }),
    buildPrompt: (context) => {
      const upstream = summarizeUpstream(context?.upstream);
      return [
        '你是一致性检查 Agent（质量守门员）。请核对上游各阶段与成稿之间的口径一致性、资格与承诺一致性、待填写项与明显废标风险，输出问题清单与处置建议。',
        '',
        '检查红线：',
        '1. 只基于上游产物核对，不重新生成标书内容；',
        '2. 问题按严重程度分级 high/medium/low；',
        '3. 每条问题给出定位范围与修改建议；score 为 0-100 的一致性评分，存在 high 级问题时 passed 应为 false；',
        '4. 每条问题必须标注 category：consistency 表示口径/一致性错误（如与招标要求冲突、前后矛盾、承诺与响应不符，可由生成 Agent 自纠）；missing_material 表示材料缺失/占位（如缺报价、资质、业绩、人员、证书等外部输入，需人工补充材料，不能靠自纠消除）。',
        '',
        `上游产物：\n${upstream}`,
        '',
        `完成后把结果写入 consistency-report.json，结构如下：`,
        '{"issues":[{"scope":"问题定位范围","severity":"high|medium|low","description":"不一致或风险描述","suggestion":"处置建议","category":"consistency|missing_material"}],"score":0,"passed":false,"summary":"质检总体结论"}',
      ].join('\n');
    },
    buildFiles: () => [],
  },
};

async function runStageTask({ agentService, stageKey, taskId, signal, context, onActivity }) {
  const task = STAGE_TASKS[stageKey];
  if (!task) throw new Error(`未配置流水线阶段任务：${stageKey}`);
  const resolvedContext = context || {};
  const sourceText = task.resolveSourceText ? task.resolveSourceText(resolvedContext) : '';
  if (task.requiresSource && !sourceText) {
    const empty = task.empty();
    empty.notes = ['未提供招标文件原文或项目概述，工作区也未发现可解析材料；请先在工作区上传招标文件，或在项目概述中粘贴招标原文后重跑本阶段。'];
    empty.summary = '缺少招标材料，暂无可提取的资格条件、条款与评分办法。';
    return empty;
  }
  const validateOutput = makeValidator(task);
  const agentResult = await agentService.runTask({
    task_id: taskId,
    title: task.title,
    summary_enabled: false,
    prompt: task.buildPrompt(resolvedContext),
    output_file: task.outputFile,
    files: task.buildFiles(resolvedContext),
    signal,
    active_tools: STAGE_ACTIVE_TOOLS[stageKey],
    json_validation_schemas: { [task.outputFile]: task.schema },
    validateOutput: (candidate) => validateOutput(candidate.output_content),
    onActivity,
  });
  return agentResult.validation_result || task.empty();
}

function textFromEvent(event) {
  for (const field of ['message', 'title', 'activity_text']) {
    if (typeof event[field] === 'string' && event[field].trim()) return event[field].trim();
  }
  return '';
}

function formatActivityEvent(event) {
  if (event == null) return '';
  if (typeof event === 'string') return event.trim();
  if (typeof event !== 'object') return '';
  // activity / visible 是布尔标志位，不是文本，不能兜底成 "true" / "false"。
  return textFromEvent(event);
}

function createPipelineStageRunner({ agentService, stageKey }) {
  return async (ctx) => {
    const result = await runStageTask({
      agentService,
      stageKey,
      taskId: `pipeline-${stageKey}-${Date.now()}`,
      signal: ctx.signal,
      context: {
        projectOverview: ctx.context?.projectOverview,
        companyProfile: ctx.context?.companyProfile,
        tenderText: ctx.context?.tenderText,
        upstream: ctx.upstream,
      },
      onActivity: (event) => {
        const text = formatActivityEvent(event);
        if (text) ctx.appendLog(text);
      },
    });
    return { outputs: result };
  };
}

module.exports = {
  STAGE_TASKS,
  STAGE_ACTIVE_TOOLS,
  makeValidator,
  runStageTask,
  createPipelineStageRunner,
};
