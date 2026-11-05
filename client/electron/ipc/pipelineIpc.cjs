const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');
const {
  getTechnicalPlanTenderMarkdownPath,
  getTechnicalPlanTenderMetaPath,
} = require('../utils/paths.cjs');

function readTenderMeta(app) {
  try {
    const metaPath = getTechnicalPlanTenderMetaPath(app);
    if (!fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
      chars: typeof parsed.chars === 'number' ? parsed.chars : undefined,
      parserLabel: typeof parsed.parserLabel === 'string' ? parsed.parserLabel : '',
    };
  } catch {
    return null;
  }
}

function registerPipelineIpc({ orchestrator, fileService, app }) {
  ipcMain.handle('pipeline:start', (_event, payload) => orchestrator.start(payload));
  ipcMain.handle('pipeline:approve', (_event, payload) => orchestrator.approve(payload?.stageKey, payload?.note));
  ipcMain.handle('pipeline:reject', (_event, payload) => orchestrator.reject(payload?.stageKey, payload?.note));
  ipcMain.handle('pipeline:get-state', () => {
    const state = orchestrator.getState();
    const tender = readTenderMeta(app);
    return tender ? { ...state, tender } : state;
  });

  ipcMain.handle('pipeline:import-tender', async () => {
    if (!fileService?.importRejectionCheckDocument) {
      return { success: false, message: '文件解析服务不可用' };
    }
    const result = await fileService.importRejectionCheckDocument('tender');
    if (!result?.success) {
      return { success: false, message: result?.message || '招标文件解析失败' };
    }
    const documents = Array.isArray(result.documents) ? result.documents : [];
    const markdown = documents
      .map((item) => String(item?.file_content || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (!markdown) {
      return { success: false, message: '未提取到有效文本，请检查文件内容' };
    }
    const targetPath = getTechnicalPlanTenderMarkdownPath(app);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${markdown}\n`, 'utf-8');
    const fileName = documents.map((item) => item?.file_name).filter(Boolean).join('、');
    const parserLabel = documents[0]?.parser_label || '';
    const metaPath = getTechnicalPlanTenderMetaPath(app);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ fileName, chars: markdown.length, parserLabel, importedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
    return {
      success: true,
      message: result.message || '招标文件已解析并写入工作区',
      fileName,
      chars: markdown.length,
      parserLabel,
    };
  });
}

// 导出服务在装配后期才创建，单独注册导出处理器；编排器实例延迟到点击时再取，避免注册时序固化空引用。
function registerPipelineExportIpc({ getOrchestrator, exportService }) {
  ipcMain.handle('pipeline:export-word', async () => {
    if (!exportService?.exportWord) {
      return { success: false, message: '导出服务不可用' };
    }
    const orchestrator = typeof getOrchestrator === 'function' ? getOrchestrator() : null;
    if (!orchestrator) {
      return { success: false, message: '流水线尚未就绪，请稍后再试' };
    }
    const state = orchestrator.getState();
    const stages = Array.isArray(state?.stages) ? state.stages : [];
    const generate = stages.find((stage) => stage.stage_key === 'generate');
    const outputs = generate && generate.outputs && typeof generate.outputs === 'object' ? generate.outputs : {};
    const sections = Array.isArray(outputs.sections) ? outputs.sections : [];
    if (!sections.length) {
      return { success: false, message: '尚未生成投标成稿，无可导出内容' };
    }
    const outline = sections.map((section) => ({
      heading: section.heading || section.title || '',
      content: section.content || section.body || section.text || '',
    }));
    const parseStage = stages.find((stage) => stage.stage_key === 'parse');
    const parseSummary = parseStage?.outputs?.summary || '';
    const projectName = parseSummary ? `投标文件_${parseSummary.slice(0, 24)}` : '投标技术文件';
    return await exportService.exportWord({ project_name: projectName, outline });
  });
}

module.exports = {
  registerPipelineIpc,
  registerPipelineExportIpc,
};
