/**
 * 人工上传标书的归一化。
 *
 * 复审只要“文本 → outputs[generate] 的章节结构”，不解析招标文件、不调模型。
 * 章节切分依次尝试：Markdown 标题 → 中文「第X章/节」→ 数字编号 → 按段落定长切块。
 * 切不出标题时也不能丢内容，否则质检会误判成“成稿为空”。
 */

const HEADING_PATTERNS = [
  /^#{1,6}\s+(.+)$/,
  /^第[一二三四五六七八九十百零〇0-9]{1,4}[章节篇部分]\s*[、.．:：]?\s*(.+)$/,
  /^\d+(?:\.\d+){0,3}[、.．\s]\s*(.+)$/,
];

const MAX_SECTIONS = 400;
const CHUNK_CHARS = 1800;

function detectHeading(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 60) return null;
  for (const pattern of HEADING_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { heading: text.replace(/^#+\s*/, '').trim(), title: match[1] || text };
  }
  return null;
}

function chunkParagraphs(lines) {
  const sections = [];
  let buffer = [];
  let length = 0;
  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) {
      sections.push({ heading: `正文（第 ${sections.length + 1} 段）`, content });
    }
    buffer = [];
    length = 0;
  };
  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text) continue;
    buffer.push(text);
    length += text.length;
    if (length >= CHUNK_CHARS) flush();
  }
  flush();
  return sections;
}

/**
 * @param {{ text?: string, fileName?: string }} input
 * @returns {{ sections: {heading: string, content: string}[], summary: string, chars: number, source: 'manual', fileName: string }}
 */
function buildReviewDraft(input = {}) {
  const raw = String(input.text || '').replace(/\r\n?/g, '\n').trim();
  const fileName = String(input.fileName || '').trim();
  if (!raw) {
    return { sections: [], summary: '未提供标书文本', chars: 0, source: 'manual', fileName };
  }

  const lines = raw.split('\n');
  const sections = [];
  let current = null;
  const preamble = [];

  for (const line of lines) {
    const detected = detectHeading(line);
    if (detected) {
      if (current) sections.push(current);
      current = { heading: detected.heading, content: '' };
      continue;
    }
    const text = line.trim();
    if (!text) {
      if (current) current.content += '\n';
      continue;
    }
    if (current) current.content += `${text}\n`;
    else preamble.push(text);
  }
  if (current) sections.push(current);

  const cleaned = sections
    .map((section) => ({
      heading: section.heading,
      content: section.content.trim(),
    }))
    .filter((section) => section.heading || section.content);

  let result = cleaned;
  if (!result.length) {
    result = chunkParagraphs(preamble);
  } else if (preamble.length) {
    // 第一个标题之前的内容（封面、目录）作为前言保留，不能丢。
    result = [{ heading: '封面与前言', content: preamble.join('\n') }, ...result];
  }

  if (result.length > MAX_SECTIONS) {
    // 章节过多时合并尾部，避免把上千个小节推给质检。
    const head = result.slice(0, MAX_SECTIONS - 1);
    const tail = result.slice(MAX_SECTIONS - 1);
    head.push({
      heading: `其余章节（合并 ${tail.length} 节）`,
      content: tail.map((section) => `${section.heading}\n${section.content}`).join('\n\n'),
    });
    result = head;
  }

  const chars = result.reduce((total, section) => total + section.content.length, 0);
  const summary = `人工上传标书：${result.length} 节，约 ${chars} 字${fileName ? `（${fileName}）` : ''}`;
  return { sections: result, summary, chars, source: 'manual', fileName };
}

module.exports = { buildReviewDraft, detectHeading, chunkParagraphs };
