const fs = require('node:fs');
const path = require('node:path');
const { runLegalResearchTask } = require('../legalResearchTask.cjs');
const { createPipelineStageRunner } = require('./pipelineStageTasks.cjs');
const {
  getTechnicalPlanTenderMarkdownPath,
  getRejectionCheckDir,
  getRejectionCheckDocumentMarkdownPath,
} = require('../../utils/paths.cjs');

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

function readMarkdownSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function readWorkspaceTenderText(app) {
  if (!app) return '';
  const parts = [];
  const primaryPaths = [
    getTechnicalPlanTenderMarkdownPath(app),
    getRejectionCheckDocumentMarkdownPath(app, 'tender', 'tender'),
  ];
  for (const filePath of primaryPaths) {
    const text = readMarkdownSafe(filePath);
    if (text) parts.push(text);
  }
  const tendersDir = path.join(getRejectionCheckDir(app), 'tenders');
  try {
    if (fs.existsSync(tendersDir)) {
      for (const name of fs.readdirSync(tendersDir)) {
        if (!name.toLowerCase().endsWith('.md')) continue;
        const text = readMarkdownSafe(path.join(tendersDir, name));
        if (text) parts.push(text);
      }
    }
  } catch {
    // 目录不存在或不可读时按无材料处理，不影响流水线。
  }
  return parts.join('\n\n');
}

function bindActivity(ctx, onActivity) {
  return (event) => {
    const text = formatActivityEvent(event);
    if (text) ctx.appendLog(text);
    if (typeof onActivity === 'function') onActivity(event);
  };
}

function requirementsFromUpstream(upstream) {
  const parts = [];
  const parseOutput = upstream?.parse;
  if (parseOutput && typeof parseOutput === 'object') {
    const groups = [
      ['资格条件', parseOutput.qualification],
      ['实质性条款', parseOutput.substantive],
      ['评分办法', parseOutput.scoring],
      ['技术要求', parseOutput.technical],
      ['商务要求', parseOutput.commercial],
    ];
    for (const [label, list] of groups) {
      if (Array.isArray(list) && list.length) parts.push(`${label}：${list.join('；')}`);
    }
    if (parseOutput.summary) parts.push(String(parseOutput.summary));
  }
  const qualificationOutput = upstream?.qualification;
  if (qualificationOutput && typeof qualificationOutput === 'object' && qualificationOutput.conclusion) {
    parts.push(`资格结论：${qualificationOutput.conclusion}`);
  }
  return parts.filter(Boolean).join('\n');
}

function searchKnowledge(store, keywords, limit = 6) {
  if (!store || typeof store.search !== 'function') return '';
  const seen = new Set();
  const hits = [];
  for (const raw of keywords) {
    const keyword = String(raw || '').trim();
    if (!keyword) continue;
    let result;
    try {
      result = store.search({ keyword, page: 1 });
    } catch {
      continue;
    }
    for (const item of result?.items || []) {
      const id = String(item.item_id || item.document_id || item.title || item.snippet || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      hits.push(item);
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  if (!hits.length) return '';
  const lines = hits.map((item, index) => {
    const title = String(item.title || '').trim();
    const snippet = String(item.snippet || item.resume || '').trim();
    const head = `《${String(item.file_name || '知识库文档')}》${title ? ` ${title}` : ''}`;
    return `${index + 1}. ${head}：${snippet}`.trim();
  });
  return ['【知识库参考资料（仅作线索；证据不足不得当作已具备材料）】', ...lines].join('\n');
}

function createKnowledgeRunner({ agentService, stageKey, store, keywords }) {
  const inner = createPipelineStageRunner({ agentService, stageKey });
  return async (ctx) => {
    const upstreamText = requirementsFromUpstream(ctx.upstream);
    const upstreamKeywords = upstreamText.split(/[；;。，,\s、]+/).filter(Boolean).slice(0, 6);
    const merged = [...(keywords || []), ...upstreamKeywords];
    ctx.context = { ...(ctx.context || {}), knowledgeHits: searchKnowledge(store, merged) };
    return inner(ctx);
  };
}

function createLegalRunner({ agentService }) {
  return async (ctx) => {
    const requirements = requirementsFromUpstream(ctx.upstream);
    const result = await runLegalResearchTask({
      agentService,
      taskId: `pipeline-legal-${Date.now()}`,
      signal: ctx.signal,
      context: {
        projectOverview: ctx.context?.projectOverview,
        requirements,
      },
      onActivity: bindActivity(ctx),
    });
    return { outputs: result };
  };
}

function createParseRunner({ agentService, app }) {
  const inner = createPipelineStageRunner({ agentService, stageKey: 'parse' });
  return async (ctx) => {
    ctx.context = { ...(ctx.context || {}), tenderText: readWorkspaceTenderText(app) };
    return inner(ctx);
  };
}

function createDefaultRunners({ agentService, app, knowledgeBaseStore }) {
  return {
    parse: createParseRunner({ agentService, app }),
    qualification: createKnowledgeRunner({ agentService, stageKey: 'qualification', store: knowledgeBaseStore, keywords: ['资质', '业绩', '证书', '人员', '财务', '许可'] }),
    technical: createKnowledgeRunner({ agentService, stageKey: 'technical', store: knowledgeBaseStore, keywords: ['技术方案', '案例', '业绩', '参数', '设备', '人员'] }),
    legal: createLegalRunner({ agentService }),
    generate: createKnowledgeRunner({ agentService, stageKey: 'generate', store: knowledgeBaseStore, keywords: ['投标文件', '章节', '方案', '模板', '业绩'] }),
    consistency: createPipelineStageRunner({ agentService, stageKey: 'consistency' }),
  };
}

module.exports = {
  createDefaultRunners,
  createLegalRunner,
};
