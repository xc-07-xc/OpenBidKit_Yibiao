const test = require('node:test');
const assert = require('node:assert/strict');

const { createLangGraphOrchestrator } = require('./langgraphOrchestrator.cjs');

function createFakeStore() {
  const stages = new Map();
  return {
    stages,
    clearAll() {
      stages.clear();
    },
    upsertStage(stage) {
      const next = { ...stage, logs: Array.isArray(stage.logs) ? [...stage.logs] : [] };
      stages.set(stage.stage_key, next);
      return next;
    },
    loadStage(key) {
      return stages.get(key);
    },
    loadAll() {
      return [...stages.values()];
    },
    patchStage(key, patch) {
      const current = stages.get(key);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      stages.set(key, next);
      return next;
    },
    saveApproval(key, approval) {
      const current = stages.get(key);
      if (!current) return undefined;
      return this.upsertStage({ ...current, approval });
    },
    appendLog(key, message) {
      const current = stages.get(key);
      if (!current) return undefined;
      current.logs.push({ at: new Date().toISOString(), message });
      return current;
    },
  };
}

function createFakeBridge(overrides = {}) {
  const calls = { start: [], approve: [], reject: [], getState: [] };
  const baseSnapshot = {
    run_id: 'run-test',
    status: 'waiting_approval',
    active: true,
    outputs: { parse: { summary: '解析完成' } },
    upstream: {},
    logs: [{ stage: 'parse', message: '阶段执行完成。' }],
    rework_count: 0,
    approval: {},
    next: ['parse_gate'],
    interrupts: [{ stage_key: 'parse', kind: 'approval' }],
    error: null,
  };
  return {
    calls,
    async start(runId, context) {
      calls.start.push({ runId, context });
      return { ...baseSnapshot };
    },
    async getState(runId) {
      calls.getState.push(runId);
      return { ...baseSnapshot };
    },
    async approve(runId, stageKey, note) {
      calls.approve.push({ runId, stageKey, note });
      return { ...baseSnapshot, active: false, next: [], interrupts: [], approval: { stage_key: stageKey, decision: 'approved' } };
    },
    async reject(runId, stageKey, note) {
      calls.reject.push({ runId, stageKey, note });
      return { ...baseSnapshot, active: false, next: [], interrupts: [] };
    },
    ...overrides,
  };
}

test('start 初始化黑板并投影 Python 快照', async () => {
  const store = createFakeStore();
  const bridge = createFakeBridge();
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  const state = await orchestrator.start({ projectOverview: '测试项目' });
  try {
    assert.equal(state.orchestrator, 'langgraph');
    assert.match(state.runId, /^run-/);
    assert.equal(bridge.calls.start.length, 1);
    assert.equal(bridge.calls.start[0].runId, state.runId);
    assert.deepEqual(bridge.calls.start[0].context, { projectOverview: '测试项目' });

    assert.equal(state.stages.length, 6);
    const byKey = new Map(state.stages.map((stage) => [stage.stage_key, stage]));
    assert.equal(byKey.get('parse').status, 'waiting_approval');
    assert.deepEqual(byKey.get('parse').outputs, { summary: '解析完成' });
    assert.equal(byKey.get('qualification').status, 'pending');
    assert.equal(state.status, 'waiting_approval');
  } finally {
    orchestrator.dispose();
  }
});

test('approve 携带 run_id 与阶段信息，并把结果投影回黑板', async () => {
  const store = createFakeStore();
  const bridge = createFakeBridge();
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  const started = await orchestrator.start({ projectOverview: '测试' });
  try {
    const state = await orchestrator.approve('parse', '同意');
    assert.equal(bridge.calls.approve.length, 1);
    assert.deepEqual(bridge.calls.approve[0], { runId: started.runId, stageKey: 'parse', note: '同意' });
    assert.equal(state.stages.find((stage) => stage.stage_key === 'parse').approval.decision, 'approved');
  } finally {
    orchestrator.dispose();
  }
});

test('后台执行异常写入快照时，阶段标记为失败而不是一直运行', async () => {
  const store = createFakeStore();
  const snapshot = {
    run_id: 'run-err',
    status: 'error',
    active: false,
    outputs: {},
    upstream: {},
    logs: [],
    rework_count: 0,
    approval: {},
    next: ['parse_run'],
    interrupts: [],
    error: 'RuntimeError: 节点执行失败',
  };
  const bridge = createFakeBridge({ async start() { return snapshot; } });
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  await orchestrator.start({});
  try {
    const state = orchestrator.getState();
    const parse = state.stages.find((stage) => stage.stage_key === 'parse');
    assert.equal(parse.status, 'error');
    assert.ok(parse.logs.some((log) => log.message.includes('节点执行失败')));
    assert.equal(state.active, false);
  } finally {
    orchestrator.dispose();
  }
});

test('未启动时调用 approve 给出明确错误', async () => {
  const orchestrator = createLangGraphOrchestrator({
    pipelineStore: createFakeStore(),
    knowledgeBaseStore: null,
    app: null,
    emit: null,
    bridge: createFakeBridge(),
  });
  await assert.rejects(() => orchestrator.approve('parse', ''), /请先启动流水线/);
  orchestrator.dispose();
});
