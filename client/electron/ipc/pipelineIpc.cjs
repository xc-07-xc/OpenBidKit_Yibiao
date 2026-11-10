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

  // 辅线：选择一份已写好的标书，仅解析成文本，不写入招标文件工作区。
  ipcMain.handle('pipeline:pick-review-draft', async () => {
    if (!fileService?.importTechnicalPlanDocument) {
      return { success: false, message: '文件解析服务不可用' };
    }
    const result = await fileService.importTechnicalPlanDocument('投标文件', { assetScopePrefix: 'pipeline-review' });
    if (!result?.success) {
      return { success: false, message: result?.message || '标书解析失败' };
    }
    const text = String(result.file_content || '').trim();
    if (!text) {
      return { success: false, message: '未提取到有效文本，请检查文件内容' };
    }
    return {
      success: true,
      message: result.message || '投标文件已解析',
      text,
      fileName: result.file_name || '',
      chars: text.length,
      parserLabel: result.parser_label || '',
    };
  });

  ipcMain.handle('pipeline:submit-review', (_event, payload) =>
    orchestrator.review({
      text: payload?.text,
      fileName: payload?.fileName,
      projectOverview: payload?.projectOverview,
      companyProfile: payload?.companyProfile,
      strictConsistency: payload?.strictConsistency,
    }),
  );

  ipcMain.handle('pipeline:get-schema', async () => {
    try {
      return await orchestrator.getSchema();
    } catch (error) {
      return { success: false, message: error?.message || '节点输出结构不可用' };
    }
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
    // 终审签发是导出前置条件：没有人工确认过的成稿不能直接落成 Word。
    const finalStage = stages.find((stage) => stage.stage_key === 'final_approval');
    if (!finalStage || finalStage.approval?.decision !== 'approved') {
      return {
        success: false,
        message: '终审尚未签发：请先在「终审签发」闸门点击通过，确认成稿可提交后再导出 Word。',
      };
    }
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
    const result = await exportService.exportWord({ project_name: projectName, outline });
    // 质检未通过仍允许导出，但把风险随结果带回，避免调用方把草稿当终稿。
    const consistency = stages.find((stage) => stage.stage_key === 'consistency');
    const qc = consistency && consistency.outputs && typeof consistency.outputs === 'object' ? consistency.outputs : null;
    if (qc && qc.passed === false && result && typeof result === 'object') {
      const highCount = Array.isArray(qc.issues) ? qc.issues.filter((issue) => issue && issue.severity === 'high').length : 0;
      const warning = `质检未通过${highCount ? `（${highCount} 项 high）` : ''}：导出文档仅供草稿，请人工复核后再投标。`;
      return { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), warning] };
    }
    return result;
  });
}

module.exports = {
  registerPipelineIpc,
  registerPipelineExportIpc,
};
