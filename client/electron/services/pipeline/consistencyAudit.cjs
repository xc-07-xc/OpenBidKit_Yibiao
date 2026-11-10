/**
 * 一致性检查的确定性审计。
 *
 * 模型质检有两个不稳定点：
 * 1. 同一份成稿两次调用可能一次报 high、一次放过；
 * 2. 只给自然语言问题，不产出“逐条比对报告”，人工复审时无法逐项核对。
 *
 * 这里在模型结果之上再跑一层纯规则审计，只做能从文本直接判定的硬事实：
 * - 章节正文为空 / 过短；
 * - 仍残留【待补充…】类占位；
 * - 招标实质性条款、资格条件、评分办法在成稿中零命中；
 * - 工期数字前后打架。
 *
 * 规则问题带 `source: 'rule_audit'`，因此演示时同一份数据每次都会稳定报出同样的 high，
 * 不依赖模型随机性；有问题的判定也都能指到具体章节，可以直接交给生成节点定点重写。
 */

const PLACEHOLDER_PATTERN = /【\s*(?:待补充|待填写|待确认|待完善|待定|略)[^】]*】|(?:XXX|xxx|×××)/g;

// 命中这些词的占位属于“缺外部材料”，改文风解决不了，归 missing_material，不触发自动返工。
const MATERIAL_HINTS = [
  '资质', '业绩', '报价', '价格', '证书', '人员', '财务', '社保', '纳税',
  '营业执照', '公章', '复印件', '检测报告', '证明材料', '发票', '保证金',
];

const MIN_SECTION_CHARS = 12;
const MIN_DRAFT_CHARS = 200;

function sectionsOf(draft) {
  const sections = Array.isArray(draft?.sections) ? draft.sections : [];
  return sections
    .map((section) => ({
      heading: String(section?.heading || section?.title || '').trim(),
      content: String(section?.content || section?.body || section?.text || '').trim(),
    }))
    .filter((section) => section.heading || section.content);
}

function draftText(draft) {
  return sectionsOf(draft)
    .map((section) => `${section.heading}\n${section.content}`)
    .join('\n')
    .trim();
}

function compact(text) {
  return String(text || '').replace(/\s+/g, '');
}

/**
 * 分值类短语（“5分”“共40分”“得5分”）不承载“是否响应”的语义：
 * 评分办法条目里出现，正文里也必然出现（“本项 5 分”），命中它说明不了任何事。
 */
function isNoiseKey(key) {
  const value = String(key || '').trim();
  if (!value) return true;
  if (/^(?:共|满分|共计)?\d+(?:\.\d+)?分$/.test(value)) return true;
  if (/^[得扣加减]\d+(?:\.\d+)?分$/.test(value)) return true;
  if (/^\d+(?:\.\d+)?$/.test(value)) return true;
  if (/^(?:以上|以下|其他|其余|等等|详见|见附件|附表|如下|前述|上述|本条)$/.test(value)) return true;
  return false;
}

/** 把一条要求拆成可用于“是否被回应”判断的关键词。 */
function keywordsOf(item) {
  const text = String(item || '').trim();
  if (!text) return [];
  const segments = text
    .split(/[，。；、：:,.!?！？\s（）()《》【】\[\]"“”'‘’/]+/)
    .map((segment) => segment.replace(/^(应当|必须|需|应|具有|提供|具备|满足|不得|禁止)/, '').trim())
    .filter((segment) => segment.length >= 2);
  const keys = [];
  for (const segment of segments) {
    if (segment.length <= 6) {
      if (!isNoiseKey(segment)) keys.push(segment);
      continue;
    }
    // 长句按 4 字滑窗取样，成稿只要复述了其中几段就算“提到过”。
    for (let index = 0; index + 4 <= Math.min(segment.length, 16); index += 3) {
      const key = segment.slice(index, index + 4);
      if (!isNoiseKey(key)) keys.push(key);
    }
  }
  return Array.from(new Set(keys)).slice(0, 12);
}

function coverageOf(text, item) {
  const keys = keywordsOf(item);
  if (!keys.length) return null;
  const haystack = compact(text);
  const matched = keys.filter((key) => haystack.includes(compact(key)));
  // 按片段长度加权：命中的是长片段才算真“覆盖”，两三个字的碎片命中不足以判定已响应。
  const totalWeight = keys.reduce((sum, key) => sum + compact(key).length, 0) || 1;
  const matchedWeight = matched.reduce((sum, key) => sum + compact(key).length, 0);
  const ratio = matchedWeight / totalWeight;
  let status = 'missing';
  if (ratio >= 0.6) status = 'responded';
  else if (ratio >= 0.35) status = 'partial';
  return { status, matched, total: keys.length, ratio };
}

function locateSection(sections, keywords) {
  let best = null;
  for (const section of sections) {
    const heading = compact(section.heading);
    if (!heading) continue;
    let hits = 0;
    for (const keyword of keywords) {
      const key = compact(keyword);
      if (!key || key.length < 2) continue;
      if (heading.includes(key) || key.includes(heading)) hits += 1;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { heading: section.heading, hits };
  }
  return best ? best.heading : '';
}

function numericConflicts(text) {
  const conflicts = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(日历天|天|个月|月|年)/g;
  const groups = new Map();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[1]);
    const unit = match[2];
    const start = Math.max(0, match.index - 12);
    const context = text.slice(start, match.index + match[0].length);
    if (!/工期|日历天|总工期|完工|竣工|交付/.test(context)) continue;
    if (!groups.has(unit)) groups.set(unit, new Set());
    groups.get(unit).add(value);
  }
  for (const [unit, values] of groups) {
    if (values.size > 1) {
      conflicts.push({
        unit,
        values: Array.from(values).sort((a, b) => a - b),
      });
    }
  }
  return conflicts;
}

function dedupeIssues(existing, incoming) {
  const merged = [...existing];
  for (const issue of incoming) {
    const duplicate = merged.some((item) => {
      if (String(item?.scope || '') !== String(issue.scope || '')) return false;
      const a = compact(item?.description || '').slice(0, 10);
      const b = compact(issue?.description || '').slice(0, 10);
      return Boolean(a) && (a === b || compact(item?.description || '').includes(b));
    });
    if (!duplicate) merged.push(issue);
  }
  return merged;
}

/**
 * 对成稿做规则审计。
 *
 * @param {object} draft   outputs.generate：{ sections: [{heading, content}] }
 * @param {object} options { parse: outputs.parse, strict: boolean }
 * @returns {{ issues: object[], comparison: object[], stats: object }}
 */
function auditDraft(draft, options = {}) {
  const sections = sectionsOf(draft);
  const text = draftText(draft);
  const strict = options?.strict === true;
  const minSectionChars = strict ? 20 : MIN_SECTION_CHARS;
  const parse = options?.parse && typeof options.parse === 'object' ? options.parse : {};
  const issues = [];

  if (!text) {
    return {
      issues: [
        {
          scope: '全局',
          severity: 'high',
          description: '成稿为空，没有任何可核对的正文内容',
          suggestion: '上传或生成完整标书正文后重新质检',
          category: 'consistency',
          source: 'rule_audit',
        },
      ],
      comparison: [],
      stats: { sections: 0, chars: 0, placeholders: 0, missing: 0, conflicts: 0 },
    };
  }

  // 1) 空章节 / 过短章节
  const thinSections = sections.filter((section) => section.content.length < minSectionChars);
  for (const section of thinSections.slice(0, 5)) {
    issues.push({
      scope: section.heading || '未命名章节',
      severity: 'high',
      description: `章节正文仅 ${section.content.length} 字，未形成有效响应`,
      suggestion: '补齐该章节正文，明确对应招标要求的响应措施与承诺',
      category: 'consistency',
      source: 'rule_audit',
    });
  }

  // 2) 残留占位
  const placeholders = [];
  for (const section of sections) {
    const found = section.content.match(PLACEHOLDER_PATTERN);
    if (found) placeholders.push({ section, found });
  }
  const placeholderCount = placeholders.reduce((total, item) => total + item.found.length, 0);
  for (const item of placeholders.slice(0, 5)) {
    const sample = item.found[0];
    const missingMaterial = MATERIAL_HINTS.some((hint) => sample.includes(hint));
    issues.push({
      scope: item.section.heading || '未命名章节',
      severity: 'high',
      description: `章节内仍残留占位内容「${sample}」`,
      suggestion: missingMaterial
        ? '补齐对应证明材料后再提交，占位内容不能随标书发出'
        : '依据上游技术要求补写该处正文，删除占位标记',
      category: missingMaterial ? 'missing_material' : 'consistency',
      source: 'rule_audit',
    });
  }

  // 3) 逐条比对：实质性条款 / 资格条件 / 评分办法
  //    评分办法是“怎么打分”，不是“必须做到什么”，没有响应与否的概念，
  //    只核对成稿里有没有对应章节，标 n\a，避免整列假绿。
  const comparison = [];
  const groups = [
    { key: 'substantive', label: '实质性条款' },
    { key: 'qualification', label: '资格条件' },
    { key: 'scoring', label: '评分办法' },
  ];
  for (const group of groups) {
    const list = Array.isArray(parse[group.key]) ? parse[group.key] : [];
    for (const item of list.slice(0, 20)) {
      const coverage = coverageOf(text, item);
      if (!coverage) continue;
      const anchor = locateSection(sections, keywordsOf(item));
      if (group.key === 'scoring') {
        comparison.push({
          item: String(item || '').trim(),
          required: group.label,
          status: 'n/a',
          anchor: anchor || '',
          evidence: anchor
            ? `评分项，不计响应；正文对应章节「${anchor}」，请核对分值是否写全`
            : '评分项，不计响应；正文未找到对应章节，建议确认该评分点是否漏写',
        });
        continue;
      }
      comparison.push({
        item: String(item || '').trim(),
        required: group.label,
        status: coverage.status,
        anchor: anchor || '',
        evidence: coverage.matched.length
          ? `命中关键词：${coverage.matched.slice(0, 4).join('、')}${anchor ? `（见「${anchor}」）` : ''}`
          : '全文未命中该条要求的关键表述',
      });
    }
  }

  const missingItems = comparison.filter((entry) => entry.status === 'missing');
  for (const entry of missingItems.slice(0, 8)) {
    const keywords = keywordsOf(entry.item);
    issues.push({
      scope: locateSection(sections, keywords) || '全局',
      severity: 'high',
      description: `成稿未回应${entry.required}「${entry.item}」`,
      suggestion: '在该章节补充明确响应条款，不要用套话带过',
      category: 'consistency',
      source: 'rule_audit',
    });
  }

  // 4) 工期口径打架
  const conflicts = numericConflicts(text);
  for (const conflict of conflicts.slice(0, 2)) {
    issues.push({
      scope: '全局',
      severity: 'high',
      description: `工期口径冲突：文中同时出现 ${conflict.values.join(' / ')} ${conflict.unit}`,
      suggestion: '统一为招标文件要求的工期，全文核对进度计划与承诺函',
      category: 'consistency',
      source: 'rule_audit',
    });
  }

  // 5) 全文过短（多半是上传错了文件或只传了目录）
  if (compact(text).length < MIN_DRAFT_CHARS) {
    issues.push({
      scope: '全局',
      severity: 'high',
      description: `成稿全文仅 ${compact(text).length} 字，明显不足以构成完整标书`,
      suggestion: '确认上传的是完整投标文件，而不是目录或封面',
      category: 'consistency',
      source: 'rule_audit',
    });
  }

  return {
    issues,
    comparison,
    stats: {
      sections: sections.length,
      chars: compact(text).length,
      placeholders: placeholderCount,
      missing: missingItems.length,
      conflicts: conflicts.length,
    },
  };
}

module.exports = {
  auditDraft,
  coverageOf,
  keywordsOf,
  numericConflicts,
  sectionsOf,
  draftText,
  dedupeIssues,
  locateSection,
  compact,
  isNoiseKey,
  PLACEHOLDER_PATTERN,
};
