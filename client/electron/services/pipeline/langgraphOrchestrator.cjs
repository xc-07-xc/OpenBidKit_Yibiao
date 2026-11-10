const {
  APPROVAL_DECISION,
  PIPELINE_STAGES,
  REVIEW_SKIP_STAGE_KEYS,
  STAGE_STATUS,
} = require('./pipelineAgentConfig.cjs');
const { persistStageFile, persistArtifact } = require('./pipelineArtifacts.cjs');
const { buildReviewDraft } = require('./pipelineReview.cjs');

// Python 侧已改为「提交即返回、后台执行」，Electron 侧用轮询把图状态投影回黑板。
const POLL_INTERVAL_MS = 2000;

function derivePipelineStatus(stages) {
  if (stages.some((stage) => stage.status === STAGE_STATUS.ERROR)) return 'error';
  // blocked=重启后上一轮被中断且无法自动续跑，不能继续显示“执行中”。
  if (stages.some((stage) => stage.status === STAGE_STATUS.BLOCKED)) return 'error';
  if (stages.some((stage) => stage.status === STAGE_STATUS.WAITING_APPROVAL)) return 'waiting_approval';
  if (stages.some((stage) => stage.status === STAGE_STATUS.RUNNING)) return 'running';
  // 人工复审会跳过部分阶段，skipped 与 success 一样视为“已完成”。
  const done = (stage) => stage.status === STAGE_STATUS.SUCCESS || stage.status === STAGE_STATUS.SKIPPED;
  if (stages.length > 0 && stages.every(done)) return 'success';
  if (stages.length > 0 && stages.every((stage) => stage.status === STAGE_STATUS.PENDING)) return 'idle';
  return 'running';
}

function outputsFingerprint(outputs) {
  if (!outputs || typeof outputs !== 'object') return '';
  try {
    return JSON.stringify(outputs);
  } catch {
    return '';
  }
}

function createRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * LangGraph 编排适配器：对外接口与自研 orchestrator 一致
 * （start / approve / reject / getState），内部通过桥接调用 Python 图服务，
 * 并把图状态快照投影回 SQLite 黑板，复用现有落盘与知识库回写逻辑。
 */
function createLangGraphOrchestrator({ pipelineStore, knowledgeBaseStore, app, emit, bridge }) {
  let active = false;
  let runId = null;
  let pollTimer = null;
  let polling = false;
  let lastErrorText = '';
  // 返工评分轨迹：每触发一轮返工记录当时的质检分与 high 问题数，供前端展示“返工前 → 返工后”。
  let scoreHistory = [];
  let lastReworkCount = 0;
  // full=从零生成；review=人工上传标书复审（跳过解析与生成）。
  let mode = 'full';

  function getState() {
    const stages = pipelineStore.loadAll();
    const finalStage = stages.find((stage) => stage.stage_key === 'final_approval');
    return {
      status: derivePipelineStatus(stages),
      active,
      runId,
      mode,
      orchestrator: 'langgraph',
      stages,
      // 终审签发是导出的前置条件：前端据此决定“导出 Word”是否可点。
      exportReady: finalStage?.approval?.decision === APPROVAL_DECISION.APPROVED,
    };
  }

  function broadcast() {
    if (typeof emit === 'function') emit(getState());
  }

  function appendStageLog(stageKey, message) {
    pipelineStore.appendLog(stageKey, message);
  }

  function markInterruptedByError(message) {
    const stages = pipelineStore.loadAll();
    for (const stage of stages) {
      if (stage.status !== STAGE_STATUS.RUNNING && stage.status !== STAGE_STATUS.WAITING_APPROVAL) continue;
      pipelineStore.patchStage(stage.stage_key, { status: STAGE_STATUS.ERROR });
      pipelineStore.appendLog(stage.stage_key, message);
    }
    active = false;
  }

  const stageKeys = PIPELINE_STAGES.map((stage) => stage.key).sort((a, b) => b.length - a.length);
  // 图里的节点名是 `final_approval_gate`、`generate_run` 这种形式，要映射回 stage_key；
  // 按最长前缀匹配，否则 final_approval 会被切成 final。
  const baseOf = (node) => {
    const name = String(node || '');
    const hit = stageKeys.find((key) => name === key || name.startsWith(`${key}_`));
    return hit || name.split('_')[0];
  };

  function projectSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const outputs = snapshot.outputs || {};
    const logs = snapshot.logs || [];
    const interrupts = Array.isArray(snapshot.interrupts) ? snapshot.interrupts : [];
    const waitingKey = interrupts.length ? interrupts[0].stage_key : null;
    const next = Array.isArray(snapshot.next) ? snapshot.next : [];
    const nextBase = next.map(baseOf);
    const approval = snapshot.approval || {};
    const finalDecision = (snapshot.final_approval || {}).decision || '';

    active = Boolean(snapshot.active);

    for (const cfg of PIPELINE_STAGES) {
      const existing = pipelineStore.loadStage(cfg.key);
      const hasOutputs = Object.prototype.hasOwnProperty.call(outputs, cfg.key);
      const stageOutputs = hasOutputs ? outputs[cfg.key] : existing?.outputs ?? null;

      let status = existing?.status || STAGE_STATUS.PENDING;
      // 人工复审跳过的阶段保持“已跳过”，不能被“没有产物”重新算回 pending。
      if (status !== STAGE_STATUS.SKIPPED && stageOutputs && Object.keys(stageOutputs).length > 0) {
        status = STAGE_STATUS.SUCCESS;
      }
      if (waitingKey === cfg.key) status = STAGE_STATUS.WAITING_APPROVAL;
      else if (nextBase.includes(cfg.key)) status = STAGE_STATUS.RUNNING;

      // 终审闸门没有产物，状态只看人工决议与是否正在等待。
      if (cfg.key === 'final_approval') {
        if (finalDecision === 'approved') status = STAGE_STATUS.SUCCESS;
        else if (finalDecision === 'rejected' && waitingKey !== cfg.key) status = STAGE_STATUS.PENDING;
      }

      const stageLogs = existing?.logs ? [...existing.logs] : [];
      for (const entry of logs) {
        if (!entry || entry.stage !== cfg.key) continue;
        const message = String(entry.message || '');
        if (!stageLogs.some((log) => log.message === message)) {
          stageLogs.push({ at: entry.at || new Date().toISOString(), message });
        }
      }

      let stageApproval = existing?.approval || { decision: APPROVAL_DECISION.PENDING };
      if (approval.stage_key === cfg.key && approval.decision) {
        stageApproval = {
          decision: approval.decision,
          note: approval.note || '',
          decided_at: new Date().toISOString(),
        };
      }

      // 终审挂起时补一条说明，界面能直接看出“流水线为什么没结束”。
      if (cfg.key === 'final_approval' && status === STAGE_STATUS.WAITING_APPROVAL) {
        const waitingMessage = '已提交人工终审：通过后解锁导出 Word，打回则携带意见退回生成节点重写。';
        if (!stageLogs.some((log) => log.message === waitingMessage)) {
          stageLogs.push({ at: new Date().toISOString(), message: waitingMessage });
        }
      }

      pipelineStore.upsertStage({
        stage_key: cfg.key,
        agent_id: cfg.agentId,
        label: cfg.label,
        status,
        inputs: existing?.inputs ?? null,
        outputs: stageOutputs,
        approval: stageApproval,
        logs: stageLogs,
        started_at: existing?.started_at,
        updated_at: new Date().toISOString(),
      });

      // 仅在产物发生变化时落盘与回写知识库，避免轮询重复导入。
      const prevFingerprint = outputsFingerprint(existing?.outputs);
      const nextFingerprint = outputsFingerprint(stageOutputs);
      if (stageOutputs && Object.keys(stageOutputs).length > 0 && prevFingerprint !== nextFingerprint) {
        const fileResult = persistStageFile(app, cfg.key, stageOutputs);
        if (fileResult.error) appendStageLog(cfg.key, fileResult.error);
        const artifactResult = persistArtifact(knowledgeBaseStore, cfg, stageOutputs);
        if (artifactResult.error) appendStageLog(cfg.key, artifactResult.error);
        else if (artifactResult.wrote) appendStageLog(cfg.key, '阶段产物已回写本地知识库。');
      }
    }

    // 返工轮次与评分轨迹写入 consistency 产物指标，供前端指标面板读取。
    if (Number.isFinite(snapshot.rework_count)) {
      const consistency = pipelineStore.loadStage('consistency');
      if (consistency?.outputs && typeof consistency.outputs === 'object') {
        const rounds = Number(snapshot.rework_count);
        if (rounds > lastReworkCount) {
          const score = Number(consistency.outputs.score);
          const issues = Array.isArray(consistency.outputs.issues) ? consistency.outputs.issues : [];
          const highCount = issues.filter((issue) => issue && issue.severity === 'high').length;
          scoreHistory.push({
            round: rounds,
            score: Number.isFinite(score) ? score : null,
            highCount,
            at: new Date().toISOString(),
          });
          lastReworkCount = rounds;
        }
        const metrics = {
          ...(consistency.outputs._metrics && typeof consistency.outputs._metrics === 'object'
            ? consistency.outputs._metrics
            : {}),
          reworkRounds: rounds,
          history: scoreHistory,
        };
        pipelineStore.patchStage('consistency', {
          outputs: { ...consistency.outputs, _metrics: metrics },
        });
      }
    }

    const errorText = typeof snapshot.error === 'string' ? snapshot.error.trim() : '';
    if (errorText && errorText !== lastErrorText) {
      lastErrorText = errorText;
      appendStageLog(
        waitingKey || nextBase[0] || 'consistency',
        `LangGraph 执行异常：${errorText}；已停止本轮并转人工处置。`,
      );
      markInterruptedByError(`本轮流水线已中断：${errorText}`);
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollOnce() {
    if (!runId || polling) return;
    polling = true;
    try {
      const snapshot = await bridge.getState(runId);
      projectSnapshot(snapshot);
      broadcast();
      if (!snapshot?.active) stopPolling();
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (statusCode === 404) {
        appendStageLog(
          'parse',
          `运行 ${runId} 在 Python 服务中已不存在（可能服务重启）；本轮已中断，请重新启动流水线。`,
        );
        markInterruptedByError('Python 图服务重启导致本轮状态丢失，请重新启动流水线。');
        broadcast();
        stopPolling();
      }
    } finally {
      polling = false;
    }
  }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  async function syncFromPython() {
    if (!runId) return null;
    const snapshot = await bridge.getState(runId);
    projectSnapshot(snapshot);
    return snapshot;
  }

  function initializeStages(context) {
    pipelineStore.clearAll();
    for (const cfg of PIPELINE_STAGES) {
      pipelineStore.upsertStage({
        stage_key: cfg.key,
        agent_id: cfg.agentId,
        label: cfg.label,
        status: STAGE_STATUS.PENDING,
        inputs: context,
        outputs: null,
        approval: { decision: APPROVAL_DECISION.PENDING },
        logs: [],
      });
    }
  }

  async function start(payload) {
    if (active) return getState();
    const context = payload || {};
    runId = createRunId();
    mode = 'full';
    lastErrorText = '';
    scoreHistory = [];
    lastReworkCount = 0;
    initializeStages(context);
    broadcast();
    const snapshot = await bridge.start(runId, context);
    projectSnapshot(snapshot);
    ensurePolling();
    broadcast();
    return getState();
  }

  function initializeReviewStages(draft, context) {
    pipelineStore.clearAll();
    for (const cfg of PIPELINE_STAGES) {
      const skipped = REVIEW_SKIP_STAGE_KEYS.includes(cfg.key);
      pipelineStore.upsertStage({
        stage_key: cfg.key,
        agent_id: cfg.agentId,
        label: cfg.label,
        status: skipped ? STAGE_STATUS.SKIPPED : STAGE_STATUS.PENDING,
        inputs: context,
        outputs: skipped
          ? { skipped: true, note: '人工上传标书复审：跳过该阶段，直接进入一致性检查。' }
          : null,
        approval: skipped
          ? { decision: APPROVAL_DECISION.APPROVED, note: '复审跳过' }
          : { decision: APPROVAL_DECISION.PENDING },
        logs: skipped ? [{ at: new Date().toISOString(), message: '人工上传复审，跳过本阶段。' }] : [],
      });
    }
    // 上传成稿直接写进 generate，不经过模型，也不重跑解析。
    pipelineStore.upsertStage({
      ...pipelineStore.loadStage('generate'),
      status: STAGE_STATUS.SUCCESS,
      outputs: draft,
      started_at: new Date().toISOString(),
      logs: [{ at: new Date().toISOString(), message: `已接收人工上传标书：${draft.sections.length} 节 / ${draft.chars} 字。` }],
    });
  }

  /** 复审基准：复用上一轮已解析的招标要求（若有），供逐条比对使用。 */
  function collectReviewReference() {
    const reference = {};
    for (const key of ['parse', 'qualification', 'technical', 'legal']) {
      const stage = pipelineStore.loadStage(key);
      if (stage?.outputs && typeof stage.outputs === 'object' && Object.keys(stage.outputs).length > 0) {
        if (!stage.outputs.skipped) reference[key] = stage.outputs;
      }
    }
    return reference;
  }

  /**
   * 辅线：人工上传/手工修改的标书重新审查。
   * 直接把文本塞进 outputs["generate"]，跳过解析与生成，只触发一致性检查 + 终审闸门。
   */
  async function review(payload) {
    if (active) throw new Error('流水线仍在执行，请等当前运行结束或先处理待确认闸门');
    const draft = buildReviewDraft({
      text: payload?.text,
      fileName: payload?.fileName,
    });
    if (!draft.sections.length) {
      throw new Error('未检测到有效标书文本：请粘贴正文或选择 .docx / .pdf / .txt 文件');
    }
    const reference = collectReviewReference();
    const context = {
      projectOverview: String(payload?.projectOverview || '').trim(),
      companyProfile: String(payload?.companyProfile || '').trim(),
      manualReview: true,
      reviewFileName: draft.fileName,
      reviewChars: draft.chars,
      strictConsistency: payload?.strictConsistency !== false,
    };
    runId = createRunId();
    mode = 'review';
    lastErrorText = '';
    scoreHistory = [];
    lastReworkCount = 0;
    initializeReviewStages(draft, context);
    broadcast();
    const snapshot = await bridge.review(runId, { context, draft, reference });
    projectSnapshot(snapshot);
    ensurePolling();
    broadcast();
    return { ...getState(), reviewDraft: { sections: draft.sections.length, chars: draft.chars } };
  }

  async function getSchema() {
    const payload = await bridge.getSchema();
    return { success: true, source: 'langgraph', ...payload };
  }

  async function approve(stageKey, note) {
    if (!runId) throw new Error('当前没有可恢复的流水线运行，请先启动流水线');
    const snapshot = await bridge.approve(runId, stageKey, note || '');
    projectSnapshot(snapshot);
    ensurePolling();
    broadcast();
    return getState();
  }

  async function reject(stageKey, note) {
    if (!runId) throw new Error('当前没有可恢复的流水线运行，请先启动流水线');
    const snapshot = await bridge.reject(runId, stageKey, note || '');
    projectSnapshot(snapshot);
    ensurePolling();
    broadcast();
    return getState();
  }

  function dispose() {
    stopPolling();
  }

  return {
    start,
    review,
    getSchema,
    approve,
    reject,
    getState,
    syncFromPython,
    dispose,
  };
}

module.exports = { createLangGraphOrchestrator };
