const fs = require('node:fs');
const path = require('node:path');
const { getTechnicalPlanDir } = require('../../utils/paths.cjs');

const ARTIFACT_FIELD_LABELS = {
  qualification: '资格条件',
  substantive: '实质性条款',
  technical: '技术要求',
  commercial: '商务要求',
  scoring: '评分办法',
  checks: '资格核查',
  gaps: '材料缺口',
  topics: '技术主题',
  strengths: '竞争优势',
  weaknesses: '薄弱环节',
  outline: '方案大纲',
  laws: '法规依据',
  cases: '类似案例',
  risks: '风险提示',
  sources: '检索来源',
  sections: '正文章节',
  issues: '质检问题',
  notes: '注意事项',
};

function fieldLabel(key) {
  return ARTIFACT_FIELD_LABELS[key] || key;
}

function resumeFromObject(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const candidates = [entry.title, entry.name, entry.scope, entry.description, entry.suggestion, entry.gap, entry.issue, entry.law, entry.case];
  return candidates.filter((v) => typeof v === 'string' && v.trim()).slice(0, 2).join('：');
}

// 把阶段产物 JSON 落到工作区 technical-plan 目录，便于留档与离线核对。
// 返回 { wrote, error }。
function persistStageFile(app, stageKey, outputs) {
  if (!app) return { wrote: false, error: null };
  try {
    const dir = getTechnicalPlanDir(app);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${stageKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(outputs ?? null, null, 2), 'utf-8');
    return { wrote: true, error: null };
  } catch (error) {
    return { wrote: false, error: `阶段产物落盘失败：${error?.message || String(error)}` };
  }
}

// 阶段产物回写本地知识库；返回 { wrote, error }。
function persistArtifact(knowledgeBaseStore, config, outputs) {
  if (!knowledgeBaseStore || typeof knowledgeBaseStore.importPipelineArtifact !== 'function') return { wrote: false, error: null };
  if (!outputs || typeof outputs !== 'object' || outputs.placeholder) return { wrote: false, error: null };
  try {
    const summary = typeof outputs.summary === 'string' ? outputs.summary.trim() : '';
    const items = [];
    let order = 0;
    for (const [key, value] of Object.entries(outputs)) {
      if (key === 'summary' || key === '_metrics') continue;
      if (Array.isArray(value)) {
        value.slice(0, 10).forEach((entry, idx) => {
          const content = typeof entry === 'object' && entry ? JSON.stringify(entry, null, 2) : String(entry);
          items.push({
            id: `${config.key}-${order++}`,
            title: `${config.label} · ${fieldLabel(key)}${value.length > 1 ? ` ${idx + 1}` : ''}`,
            resume: resumeFromObject(entry) || summary,
            content,
          });
        });
      } else if (value && typeof value === 'object') {
        items.push({
          id: `${config.key}-${order++}`,
          title: `${config.label} · ${fieldLabel(key)}`,
          resume: summary,
          content: JSON.stringify(value, null, 2),
        });
      } else {
        items.push({
          id: `${config.key}-${order++}`,
          title: `${config.label} · ${fieldLabel(key)}`,
          resume: String(value),
          content: String(value),
        });
      }
    }
    if (!items.length) return { wrote: false, error: null };
    const markdown = `# ${config.label}\n\n${summary ? `> ${summary}\n\n` : ''}${items.map((it) => `## ${it.title}\n${it.content}`).join('\n\n')}`;
    knowledgeBaseStore.importPipelineArtifact({
      folderName: '流水线产物',
      documentName: `${config.label}（${config.key}）`,
      summary,
      items,
      markdown,
    });
    return { wrote: true, error: null };
  } catch (error) {
    return { wrote: false, error: `产物回写知识库失败：${error?.message || String(error)}` };
  }
}

module.exports = {
  fieldLabel,
  resumeFromObject,
  persistStageFile,
  persistArtifact,
};
