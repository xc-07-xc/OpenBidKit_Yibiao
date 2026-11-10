const test = require('node:test');
const assert = require('node:assert/strict');

const { createLangGraphOrchestrator } = require('./langgraphOrchestrator.cjs');
const { PIPELINE_STAGES } = require('./pipelineAgentConfig.cjs');

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

    // 阶段清单以配置为准（含新增的终审签发闸门），避免每次加分阶段都要改断言。
    assert.equal(state.stages.length, PIPELINE_STAGES.length);
    const byKey = new Map(state.stages.map((stage) => [stage.stage_key, stage]));
    assert.equal(byKey.get('parse').status, 'waiting_approval');
    assert.deepEqual(byKey.get('parse').outputs, { summary: '解析完成' });
    assert.equal(byKey.get('qualification').status, 'pending');
    assert.equal(byKey.get('final_approval').status, 'pending');
    assert.equal(state.exportReady, false);
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

test('返工轮次写入评分轨迹，供前端展示返工前后分数', async () => {
  const store = createFakeStore();
  const snapshot = {
    run_id: 'run-rework',
    status: 'running',
    active: true,
    outputs: {
      generate: { sections: [{ heading: '技术方案', content: '旧稿' }] },
      consistency: {
        score: 64,
        passed: false,
        issues: [
          { scope: '技术方案', severity: 'high', category: 'consistency', description: '工期口径不一致' },
          { scope: '报价', severity: 'low', category: 'consistency', description: '措辞可优化' },
        ],
      },
    },
    upstream: {},
    logs: [{ stage: 'generate', message: '进入第 1 轮返工' }],
    rework_count: 1,
    approval: {},
    next: ['generate_run'],
    interrupts: [],
    error: null,
  };
  const bridge = createFakeBridge({
    async start() {
      return snapshot;
    },
    async getState() {
      return snapshot;
    },
  });
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  await orchestrator.start({});
  try {
    const consistency = orchestrator.getState().stages.find((stage) => stage.stage_key === 'consistency');
    assert.equal(consistency.outputs._metrics.reworkRounds, 1);
    assert.equal(consistency.outputs._metrics.history.length, 1);
    assert.equal(consistency.outputs._metrics.history[0].score, 64);
    assert.equal(consistency.outputs._metrics.history[0].highCount, 1);
  } finally {
    orchestrator.dispose();
  }
});

test('人工复审：跳过解析等阶段，只跑一致性并停在终审闸门', async () => {
  const store = createFakeStore();
  const reviewSnapshot = {
    run_id: 'run-review',
    status: 'waiting_approval',
    active: true,
    mode: 'review',
    outputs: {
      generate: { sections: [{ heading: '第一章 工程概况', content: '工期 30 日历天。' }], source: 'manual' },
      consistency: { issues: [], score: 88, passed: true, summary: '比对完成', comparison: [] },
    },
    upstream: {},
    logs: [],
    rework_count: 0,
    approval: {},
    next: ['final_approval_gate'],
    interrupts: [{ stage_key: 'final_approval', kind: 'final_approval' }],
    final_approval: { decision: 'pending' },
    error: null,
  };
  const bridge = createFakeBridge({
    async review(runId, payload) {
      bridge.calls.review.push({ runId, payload });
      return reviewSnapshot;
    },
  });
  bridge.calls.review = [];
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  const state = await orchestrator.review({ text: '第一章 工程概况\n工期 30 日历天。', fileName: '既有标书.docx' });
  try {
    assert.equal(state.mode, 'review');
    assert.equal(bridge.calls.review.length, 1);
    assert.equal(bridge.calls.review[0].payload.draft.source, 'manual');
    assert.equal(bridge.calls.review[0].payload.draft.fileName, '既有标书.docx');
    const byKey = new Map(state.stages.map((stage) => [stage.stage_key, stage]));
    for (const key of ['parse', 'qualification', 'technical', 'legal']) {
      assert.equal(byKey.get(key).status, 'skipped', `${key} 应为 skipped`);
    }
    assert.equal(byKey.get('consistency').status, 'success');
    assert.equal(byKey.get('final_approval').status, 'waiting_approval');
    assert.ok(byKey.get('final_approval').logs.some((log) => log.message.includes('人工终审')));
    assert.equal(state.status, 'waiting_approval');
    // 终审未签发前不允许导出。
    assert.equal(state.exportReady, false);
  } finally {
    orchestrator.dispose();
  }
});

test('终审签发后 exportReady 为真，导出才放行', async () => {
  const store = createFakeStore();
  const bridge = createFakeBridge({
    async approve(runId, stageKey, note) {
      return {
        run_id: 'run-final',
        status: 'success',
        active: false,
        mode: 'full',
        outputs: { generate: { sections: [{ heading: '第一章', content: '正文' }] } },
        upstream: {},
        logs: [],
        rework_count: 0,
        approval: { stage_key: stageKey, decision: 'approved', note },
        final_approval: { decision: 'approved', note },
        next: [],
        interrupts: [],
        error: null,
      };
    },
  });
  const orchestrator = createLangGraphOrchestrator({ pipelineStore: store, knowledgeBaseStore: null, app: null, emit: null, bridge });

  await orchestrator.start({});
  try {
    assert.equal(orchestrator.getState().exportReady, false);
    const state = await orchestrator.approve('final_approval', '可以提交');
    assert.equal(state.exportReady, true);
    assert.equal(state.stages.find((stage) => stage.stage_key === 'final_approval').status, 'success');
  } finally {
    orchestrator.dispose();
  }
});
