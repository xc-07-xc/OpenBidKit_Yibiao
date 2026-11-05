const { APPROVAL_DECISION, PIPELINE_STAGES, STAGE_STATUS } = require('./pipelineAgentConfig.cjs');

const MAX_LOG_ENTRIES = 200;

function now() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function defaultApproval() {
  return { decision: APPROVAL_DECISION.PENDING };
}

function stageFromRow(row) {
  if (!row) return undefined;
  return {
    stage_key: row.stage_key,
    agent_id: Number(row.agent_id || 0),
    label: row.label || '',
    status: row.status || STAGE_STATUS.PENDING,
    inputs: safeJsonParse(row.inputs_json, null),
    outputs: safeJsonParse(row.outputs_json, null),
    approval: safeJsonParse(row.approval_json, defaultApproval()),
    logs: Array.isArray(safeJsonParse(row.logs_json, [])) ? safeJsonParse(row.logs_json, []) : [],
    started_at: row.started_at || undefined,
    updated_at: row.updated_at || undefined,
  };
}

function createPipelineStore({ db }) {
  const upsertStage = (stage) => {
    const timestamp = now();
    db.prepare(
      `INSERT INTO pipeline_stages (
        stage_key, agent_id, label, status, inputs_json, outputs_json,
        approval_json, logs_json, started_at, updated_at
      ) VALUES (
        @stage_key, @agent_id, @label, @status, @inputs_json, @outputs_json,
        @approval_json, @logs_json, @started_at, @updated_at
      )
      ON CONFLICT(stage_key) DO UPDATE SET
        agent_id = excluded.agent_id,
        label = excluded.label,
        status = excluded.status,
        inputs_json = excluded.inputs_json,
        outputs_json = excluded.outputs_json,
        approval_json = excluded.approval_json,
        logs_json = excluded.logs_json,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at`
    ).run({
      stage_key: stage.stage_key,
      agent_id: stage.agent_id,
      label: stage.label,
      status: stage.status,
      inputs_json: jsonOrNull(stage.inputs),
      outputs_json: jsonOrNull(stage.outputs),
      approval_json: jsonOrNull(stage.approval || defaultApproval()),
      logs_json: jsonOrNull(Array.isArray(stage.logs) ? stage.logs : []),
      started_at: stage.started_at || null,
      updated_at: timestamp,
    });
    return loadStage(stage.stage_key);
  };

  const loadStage = (stageKey) => {
    const row = db.prepare('SELECT * FROM pipeline_stages WHERE stage_key = ?').get(stageKey);
    return stageFromRow(row);
  };

  const loadAll = () => {
    const rows = db.prepare('SELECT * FROM pipeline_stages').all();
    const byKey = new Map(rows.map((row) => [row.stage_key, stageFromRow(row)]));
    return PIPELINE_STAGES.map((config) => {
      const existing = byKey.get(config.key);
      if (existing) return existing;
      return {
        stage_key: config.key,
        agent_id: config.agentId,
        label: config.label,
        status: STAGE_STATUS.PENDING,
        inputs: null,
        outputs: null,
        approval: defaultApproval(),
        logs: [],
        started_at: undefined,
        updated_at: undefined,
      };
    });
  };

  const patchStage = (stageKey, patch) => {
    const current = loadStage(stageKey);
    if (!current) return undefined;
    return upsertStage({ ...current, ...patch });
  };

  const saveApproval = (stageKey, approval) => {
    const current = loadStage(stageKey);
    if (!current) return undefined;
    return upsertStage({
      ...current,
      approval: { ...defaultApproval(), ...approval, decided_at: approval.decided_at || now() },
    });
  };

  const appendLog = (stageKey, message) => {
    const current = loadStage(stageKey);
    if (!current) return undefined;
    const logs = [...(Array.isArray(current.logs) ? current.logs : [])];
    logs.push({ at: now(), message: String(message || '') });
    while (logs.length > MAX_LOG_ENTRIES) logs.shift();
    return patchStage(stageKey, { logs });
  };

  const clearAll = () => {
    db.prepare('DELETE FROM pipeline_stages').run();
  };

  // 应用重启后，上一轮停在 running / waiting_approval 的阶段已无人推进（waiter 只存在于内存），
  // 统一标记为阻塞并留痕，避免界面显示「待人工确认」却点不动。
  const recoverInterrupted = () => {
    for (const config of PIPELINE_STAGES) {
      const stage = loadStage(config.key);
      if (!stage) continue;
      if (stage.status !== STAGE_STATUS.RUNNING && stage.status !== STAGE_STATUS.WAITING_APPROVAL) continue;
      const logs = [
        ...(Array.isArray(stage.logs) ? stage.logs : []),
        { at: now(), message: '应用重启，上一轮运行已中断；请重新启动流水线。' },
      ];
      upsertStage({ ...stage, status: STAGE_STATUS.BLOCKED, logs });
    }
  };

  return {
    upsertStage,
    loadStage,
    loadAll,
    patchStage,
    saveApproval,
    appendLog,
    clearAll,
    recoverInterrupted,
  };
}

module.exports = {
  createPipelineStore,
};
