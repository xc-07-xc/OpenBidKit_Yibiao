const {
  APPROVAL_DECISION,
  PIPELINE_STAGES,
  STAGE_STATUS,
  getStageByKey,
} = require('./pipelineAgentConfig.cjs');
const { persistStageFile: persistStageFileShared, persistArtifact: persistArtifactShared } = require('./pipelineArtifacts.cjs');

const MAX_STAGE_RETRY = 1;
const MAX_REWORK_ROUNDS = 2;
const PARALLEL_GROUPS = [['technical', 'legal']];

function derivePipelineStatus(stages) {
  if (stages.some((stage) => stage.status === STAGE_STATUS.ERROR)) return 'error';
  if (stages.some((stage) => stage.status === STAGE_STATUS.WAITING_APPROVAL)) return 'waiting_approval';
  if (stages.some((stage) => stage.status === STAGE_STATUS.RUNNING)) return 'running';
  if (stages.length > 0 && stages.every((stage) => stage.status === STAGE_STATUS.SUCCESS)) return 'success';
  if (stages.length > 0 && stages.every((stage) => stage.status === STAGE_STATUS.PENDING)) return 'idle';
  return 'running';
}

function buildSegments(stages) {
  const groups = new Map();
  const order = [];
  for (const stage of stages) {
    const group = PARALLEL_GROUPS.find((item) => item.includes(stage.key));
    const groupId = group ? group.join('+') : stage.key;
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
      order.push(groupId);
    }
    groups.get(groupId).push(stage.key);
  }
  return order.map((groupId) => groups.get(groupId));
}

const MISSING_MATERIAL_KEYWORDS = [
  '待补充', '待提供', '缺失', '空缺', '占位', '空壳', '未提供', '缺少',
  '报价', '价格', '预算金额', '资质', '业绩', '人员', '设备', '机械',
  '营业执照', '财务', '社保', '纳税', '证明材料', '材料缺口', '承诺函',
  '声明函', '公章', '复印件', '工程量清单', '附件材料',
];
const CONSISTENCY_KEYWORDS = [
  '不一致', '冲突', '矛盾', '口径', '偏离', '错误', '遗漏', '前后',
  '响应', '期限', '工期', '承诺', '变更', '修改',
];

// 质检问题分两类：missing=材料缺失/占位（需人工补料，不自动整改）；consistency=口径/一致性错误（可回退生成 Agent 自纠）。
function classifyIssue(issue) {
  const explicit = String(issue?.category || '').trim().toLowerCase();
  if (explicit === 'missing_material' || explicit === 'missing') return 'missing';
  if (explicit === 'consistency' || explicit === 'consistency_error') return 'consistency';
  const text = `${issue?.scope || ''} ${issue?.description || ''} ${issue?.suggestion || ''}`;
  if (MISSING_MATERIAL_KEYWORDS.some((kw) => text.includes(kw))) return 'missing';
  if (CONSISTENCY_KEYWORDS.some((kw) => text.includes(kw))) return 'consistency';
  return 'consistency';
}

function collectHighIssues(outputs) {
  const issues = Array.isArray(outputs?.issues) ? outputs.issues : [];
  const high = issues.filter((issue) => issue && issue.severity === 'high');
  return {
    consistency: high.filter((issue) => classifyIssue(issue) === 'consistency'),
    missing: high.filter((issue) => classifyIssue(issue) === 'missing'),
  };
}

function formatReworkFeedback(outputs) {
  const issues = Array.isArray(outputs?.issues) ? outputs.issues : [];
  const lines = issues.map((issue, index) => {
    const scope = String(issue?.scope || '').trim();
    const description = String(issue?.description || '').trim();
    const suggestion = String(issue?.suggestion || '').trim();
    return `${index + 1}. [${issue?.severity || 'low'}]${scope ? ` ${scope}` : ''}：${description}${suggestion ? `（建议：${suggestion}）` : ''}`;
  });
  const score = Number.isFinite(Number(outputs?.score)) ? Number(outputs.score) : 'N/A';
  const summary = String(outputs?.summary || '').trim();
  return [`一致性评分：${score}${summary ? `；${summary}` : ''}`, '需整改问题：', ...lines].filter(Boolean).join('\n');
}

function createPipelineOrchestrator({ pipelineStore, runners, emit, knowledgeBaseStore, app }) {
  const waiters = new Map();
  let active = false;
  let abortController = null;
  let currentContext = {};
  // 返工评分轨迹：每轮返工记录当时的质检分与 high 问题数。
  const reworkHistory = [];

  function broadcast() {
    const state = getState();
    if (typeof emit === 'function') emit(state);
  }

  function getState() {
    const stages = pipelineStore.loadAll();
    return {
      status: derivePipelineStatus(stages),
      active,
      runId: null,
      orchestrator: 'builtin',
      stages,
    };
  }

  function recordReworkMetrics(stageKey, reworkCount, history) {
    const stage = pipelineStore.loadStage(stageKey);
    if (!stage) return;
    const outputs = stage.outputs && typeof stage.outputs === 'object' ? stage.outputs : {};
    const metrics = {
      ...(outputs._metrics && typeof outputs._metrics === 'object' ? outputs._metrics : {}),
      reworkRounds: reworkCount,
      history: Array.isArray(history) ? history : [],
    };
    pipelineStore.patchStage(stageKey, { outputs: { ...outputs, _metrics: metrics } });
  }

  function persistStageFile(stageKey, outputs) {
    const result = persistStageFileShared(app, stageKey, outputs);
    if (result.error) pipelineStore.appendLog(stageKey, result.error);
  }

  function persistArtifact(config, outputs) {
    const result = persistArtifactShared(knowledgeBaseStore, config, outputs);
    if (result.error) pipelineStore.appendLog(config.key, result.error);
    else if (result.wrote) pipelineStore.appendLog(config.key, '阶段产物已回写本地知识库。');
  }

  function collectUpstream(currentKey) {
    const upstream = {};
    for (const stage of pipelineStore.loadAll()) {
      if (stage.stage_key === currentKey) break;
      upstream[stage.stage_key] = stage.outputs;
    }
    return upstream;
  }

  function initializeStages(context) {
    pipelineStore.clearAll();
    for (const config of PIPELINE_STAGES) {
      pipelineStore.upsertStage({
        stage_key: config.key,
        agent_id: config.agentId,
        label: config.label,
        status: STAGE_STATUS.PENDING,
        inputs: context,
        outputs: null,
        approval: { decision: APPROVAL_DECISION.PENDING },
        logs: [],
      });
    }
  }

  function waitApproval(config) {
    return new Promise((resolve) => {
      const current = pipelineStore.loadStage(config.key);
      pipelineStore.upsertStage({ ...current, status: STAGE_STATUS.WAITING_APPROVAL });
      broadcast();
      waiters.set(config.key, { resolve });
    });
  }

  async function runStage(config, context, retryCounts) {
    const runner = runners?.[config.key];
    const current = pipelineStore.loadStage(config.key);
    pipelineStore.upsertStage({
      ...current,
      status: STAGE_STATUS.RUNNING,
      started_at: new Date().toISOString(),
    });
    pipelineStore.appendLog(config.key, `开始执行：${config.label}`);
    broadcast();

    let attempt = 0;
    for (;;) {
      try {
        const upstream = collectUpstream(config.key);
        const ctx = {
          stage: config,
          context,
          upstream,
          signal: abortController?.signal,
          appendLog: (message) => pipelineStore.appendLog(config.key, message),
        };
        const result = runner
          ? await runner(ctx)
          : { outputs: { placeholder: true, note: '未配置该阶段 runner。' } };
        const updated = pipelineStore.loadStage(config.key);
        pipelineStore.upsertStage({
          ...updated,
          status: STAGE_STATUS.SUCCESS,
          outputs: result?.outputs || null,
        });
        pipelineStore.appendLog(config.key, `${config.label} 执行完成。`);
        persistArtifact(config, result?.outputs);
        persistStageFile(config.key, result?.outputs);
        broadcast();

        if (!config.gate) return 'next';

        const decision = await waitApproval(config);
        if (decision.approved) return 'next';
        pipelineStore.appendLog(config.key, `人工打回：${decision.note || '未填写说明'}，将重新执行本阶段。`);
        return 'retry';
      } catch (error) {
        const used = retryCounts.get(config.key) || 0;
        if (used < MAX_STAGE_RETRY) {
          retryCounts.set(config.key, used + 1);
          pipelineStore.appendLog(config.key, `执行失败：${error?.message || String(error)}；自动重试一次。`);
          const failed = pipelineStore.loadStage(config.key);
          pipelineStore.upsertStage({ ...failed, status: STAGE_STATUS.RUNNING });
          broadcast();
          attempt += 1;
          continue;
        }
        const failed = pipelineStore.loadStage(config.key);
        pipelineStore.upsertStage({ ...failed, status: STAGE_STATUS.ERROR });
        pipelineStore.appendLog(config.key, `执行失败：${error?.message || String(error)}；已达重试上限，转人工处置。`);
        broadcast();
        return 'error';
      }
    }
  }

  async function runPipeline(startSegment, context) {
    const segments = buildSegments(PIPELINE_STAGES);
    const retryCounts = new Map();
    let segmentIndex = startSegment;
    let reworkCount = 0;

    while (segmentIndex < segments.length) {
      const keys = segments[segmentIndex];
      const outcomes = await Promise.all(
        keys.map((key) => {
          const config = getStageByKey(key);
          return config ? runStage(config, context, retryCounts) : Promise.resolve('error');
        }),
      );

      if (outcomes.includes('error')) {
        active = false;
        broadcast();
        return;
      }
      // 人工打回：原地重跑当前段。
      if (outcomes.includes('retry')) continue;

      // 一致性检查段：按问题分类决定处置方式。
      if (keys.includes('consistency')) {
        const consistencyStage = pipelineStore.loadStage('consistency');
        const { consistency: highConsistency, missing: highMissing } = collectHighIssues(consistencyStage?.outputs);

        if (highConsistency.length) {
          if (reworkCount < MAX_REWORK_ROUNDS) {
            reworkCount += 1;
            context.feedbackNotes = formatReworkFeedback(consistencyStage.outputs);
            // 回传上一轮成稿，生成阶段只重写受影响章节；清空黑板成稿仍由生成 Runner 覆盖写入。
            const generateStage = pipelineStore.loadStage('generate');
            if (generateStage?.outputs && typeof generateStage.outputs === 'object') {
              context.previousDraft = generateStage.outputs;
            }
            const score = Number(consistencyStage.outputs?.score);
            reworkHistory.push({
              round: reworkCount,
              score: Number.isFinite(score) ? score : null,
              highCount: highConsistency.length,
              at: new Date().toISOString(),
            });
            pipelineStore.appendLog(
              'consistency',
              `质检未通过，第 ${reworkCount}/${MAX_REWORK_ROUNDS} 轮自动回退生成阶段整改（${highConsistency.length} 项一致性问题）。`,
            );
            const generateSegment = segments.findIndex((group) => group.includes('generate'));
            segmentIndex = generateSegment >= 0 ? generateSegment : segmentIndex - 1;
            broadcast();
            continue;
          }
          pipelineStore.appendLog(
            'consistency',
            `已达自动整改上限 ${MAX_REWORK_ROUNDS} 轮，仍存在 high 级一致性问题，转人工处置。`,
          );
          broadcast();
        } else if (highMissing.length) {
          // 材料缺失/占位类问题无法靠生成 Agent 自纠，直接标记需人工补料，不占用整改轮次、不重复回退。
          pipelineStore.appendLog(
            'consistency',
            `存在 ${highMissing.length} 项材料缺失类问题（如占位、缺报价/资质/业绩等），需人工补充材料后再复核；不自动整改。`,
          );
          broadcast();
        }
        recordReworkMetrics('consistency', reworkCount, reworkHistory);
      }

      segmentIndex += 1;
    }
    active = false;
    broadcast();
  }

  function start(payload) {
    if (active) return getState();
    currentContext = payload || {};
    reworkHistory.length = 0;
    abortController = new AbortController();
    active = true;
    initializeStages(currentContext);
    broadcast();
    void runPipeline(0, currentContext);
    return getState();
  }

  function resolveWaiter(stageKey, decision, note) {
    const waiter = waiters.get(stageKey);
    waiters.delete(stageKey);
    if (waiter) waiter.resolve({ approved: decision === APPROVAL_DECISION.APPROVED, note });
  }

  // 闸门决议必须命中一次真实挂起；应用重启后黑板里残留的 waiting_approval 不能再被"通过"。
  function assertApprovalResumable(stageKey) {
    if (waiters.has(stageKey)) return;
    throw new Error('该流水线运行已中断（应用重启或编排器切换），请重新启动流水线后再确认');
  }

  function approve(stageKey, note) {
    if (!getStageByKey(stageKey)) return getState();
    assertApprovalResumable(stageKey);
    pipelineStore.saveApproval(stageKey, { decision: APPROVAL_DECISION.APPROVED, note });
    pipelineStore.patchStage(stageKey, { status: STAGE_STATUS.SUCCESS });
    resolveWaiter(stageKey, APPROVAL_DECISION.APPROVED, note);
    broadcast();
    return getState();
  }

  function reject(stageKey, note) {
    if (!getStageByKey(stageKey)) return getState();
    assertApprovalResumable(stageKey);
    pipelineStore.saveApproval(stageKey, { decision: APPROVAL_DECISION.REJECTED, note });
    pipelineStore.patchStage(stageKey, { status: STAGE_STATUS.PENDING });
    resolveWaiter(stageKey, APPROVAL_DECISION.REJECTED, note);
    broadcast();
    return getState();
  }

  return {
    start,
    approve,
    reject,
    getState,
  };
}

module.exports = {
  createPipelineOrchestrator,
};
