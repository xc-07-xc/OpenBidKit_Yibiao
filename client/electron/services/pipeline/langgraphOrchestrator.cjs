const {
  APPROVAL_DECISION,
  PIPELINE_STAGES,
  STAGE_STATUS,
} = require('./pipelineAgentConfig.cjs');
const { persistStageFile, persistArtifact } = require('./pipelineArtifacts.cjs');

// Python 侧已改为「提交即返回、后台执行」，Electron 侧用轮询把图状态投影回黑板。
const POLL_INTERVAL_MS = 2000;

function derivePipelineStatus(stages) {
  if (stages.some((stage) => stage.status === STAGE_STATUS.ERROR)) return 'error';
  if (stages.some((stage) => stage.status === STAGE_STATUS.WAITING_APPROVAL)) return 'waiting_approval';
  if (stages.some((stage) => stage.status === STAGE_STATUS.RUNNING)) return 'running';
  if (stages.length > 0 && stages.every((stage) => stage.status === STAGE_STATUS.SUCCESS)) return 'success';
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

  function getState() {
    const stages = pipelineStore.loadAll();
    return {
      status: derivePipelineStatus(stages),
      active,
      runId,
      orchestrator: 'langgraph',
      stages,
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

  function projectSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const outputs = snapshot.outputs || {};
    const logs = snapshot.logs || [];
    const interrupts = Array.isArray(snapshot.interrupts) ? snapshot.interrupts : [];
    const waitingKey = interrupts.length ? interrupts[0].stage_key : null;
    const next = Array.isArray(snapshot.next) ? snapshot.next : [];
    const nextBase = next.map((node) => String(node).split('_')[0]);
    const approval = snapshot.approval || {};

    active = Boolean(snapshot.active);

    for (const cfg of PIPELINE_STAGES) {
      const existing = pipelineStore.loadStage(cfg.key);
      const hasOutputs = Object.prototype.hasOwnProperty.call(outputs, cfg.key);
      const stageOutputs = hasOutputs ? outputs[cfg.key] : existing?.outputs ?? null;

      let status = existing?.status || STAGE_STATUS.PENDING;
      if (stageOutputs && Object.keys(stageOutputs).length > 0) status = STAGE_STATUS.SUCCESS;
      if (waitingKey === cfg.key) status = STAGE_STATUS.WAITING_APPROVAL;
      else if (nextBase.includes(cfg.key)) status = STAGE_STATUS.RUNNING;

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

    // 返工轮次写入 consistency 产物指标，供前端指标面板读取。
    if (Number.isFinite(snapshot.rework_count)) {
      const consistency = pipelineStore.loadStage('consistency');
      if (consistency?.outputs && typeof consistency.outputs === 'object') {
        const metrics = {
          ...(consistency.outputs._metrics && typeof consistency.outputs._metrics === 'object'
            ? consistency.outputs._metrics
            : {}),
          reworkRounds: snapshot.rework_count,
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
    lastErrorText = '';
    initializeStages(context);
    broadcast();
    const snapshot = await bridge.start(runId, context);
    projectSnapshot(snapshot);
    ensurePolling();
    broadcast();
    return getState();
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
    approve,
    reject,
    getState,
    syncFromPython,
    dispose,
  };
}

module.exports = { createLangGraphOrchestrator };
