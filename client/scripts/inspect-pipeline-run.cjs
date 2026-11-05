/**
 * 流水线运行检查：读取本地 SQLite 黑板，核对「4 个闸门 / 一次打回 / 自动返工」。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/inspect-pipeline-run.cjs
 *   node --disable-warning=ExperimentalWarning scripts/inspect-pipeline-run.cjs --db "D:\path\yibiao.sqlite"
 *   node --disable-warning=ExperimentalWarning scripts/inspect-pipeline-run.cjs --json
 *
 * 默认数据库：%APPDATA%\yibiao-client\workspace\yibiao.sqlite
 * 退出码：0 全部通过；1 有未通过项；2 数据库或表不存在。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const GATE_STAGES = ['parse', 'qualification', 'legal', 'generate'];
const STAGE_LABELS = {
  parse: '文档解析',
  qualification: '资格审查',
  technical: '技术分析',
  legal: '法规检索',
  generate: '文档生成',
  consistency: '一致性检查',
};
const STATUS_LABELS = {
  pending: '待执行',
  running: '执行中',
  waiting_approval: '待确认',
  success: '已通过',
  error: '失败',
  blocked: '阻塞',
};

function defaultDbPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'yibiao-client', 'workspace', 'yibiao.sqlite');
}

function parseArgs(argv) {
  const args = { db: defaultDbPath(), json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) {
      args.db = argv[++i];
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  return args;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function durationSeconds(stage) {
  if (!stage.started_at || !stage.updated_at) return null;
  const start = new Date(stage.started_at).getTime();
  const end = new Date(stage.updated_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(seconds) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = code >= 0x1100 && (
      code <= 0x115f
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

// 中文按两列宽补齐，避免控制台表格错位。
function pad(text, target) {
  const value = String(text);
  const width = displayWidth(value);
  return width >= target ? value : `${value}${' '.repeat(target - width)}`;
}

function loadStages(dbPath) {
  if (!fs.existsSync(dbPath)) return { error: `数据库不存在：${dbPath}` };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_stages'").get();
    if (!table) return { error: '数据库中没有 pipeline_stages 表：还没有跑过流水线，或数据库版本过旧。' };
    const rows = db.prepare('SELECT * FROM pipeline_stages ORDER BY rowid ASC').all();
    return {
      stages: rows.map((row) => ({
        stage_key: row.stage_key,
        agent_id: row.agent_id,
        label: row.label,
        status: row.status,
        outputs: safeJson(row.outputs_json, null),
        approval: safeJson(row.approval_json, { decision: 'pending' }),
        logs: safeJson(row.logs_json, []),
        started_at: row.started_at,
        updated_at: row.updated_at,
      })),
    };
  } finally {
    db.close();
  }
}

function analyze(stages) {
  const byKey = new Map(stages.map((stage) => [stage.stage_key, stage]));
  const allLogs = stages.flatMap((stage) => (Array.isArray(stage.logs) ? stage.logs.map((log) => ({ stage: stage.stage_key, ...log })) : []));

  const gates = GATE_STAGES.map((key) => {
    const stage = byKey.get(key);
    return {
      stageKey: key,
      status: stage?.status || 'missing',
      decision: stage?.approval?.decision || 'pending',
      note: stage?.approval?.note || '',
    };
  });

  const consistency = byKey.get('consistency');
  const metrics = consistency?.outputs?._metrics;
  const metricRounds = Number(metrics?.reworkRounds);
  const logRounds = allLogs.filter((log) => /返工|自动回退|回退生成/.test(String(log.message || ''))).length;
  const reworkRounds = Number.isFinite(metricRounds) ? metricRounds : logRounds;

  const rejected = gates.some((gate) => gate.decision === 'rejected')
    || allLogs.some((log) => /人工打回|打回重跑/.test(String(log.message || '')));

  const checks = [
    {
      id: 'stages',
      label: '6 个阶段全部执行完成（success）',
      pass: stages.length === 6 && stages.every((stage) => stage.status === 'success'),
      detail: stages.map((stage) => `${stage.stage_key}=${stage.status}`).join(' '),
    },
    {
      id: 'gates',
      label: '4 个闸门都有审批记录',
      pass: gates.every((gate) => gate.decision === 'approved'),
      detail: gates.map((gate) => `${gate.stageKey}=${gate.decision}`).join(' '),
    },
    {
      id: 'reject',
      label: '至少一次人工打回',
      pass: rejected,
      detail: rejected ? '已检测到打回记录' : '没有打回记录',
    },
    {
      id: 'rework',
      label: '至少一轮自动返工',
      pass: reworkRounds >= 1,
      detail: `返工轮次=${reworkRounds}`,
    },
  ];

  return { gates, stages, reworkRounds, rejected, checks };
}

function render(dbPath, stages, result) {
  const lines = [];
  lines.push('易标流水线运行检查');
  lines.push(`数据库：${dbPath}`);
  lines.push('');
  lines.push(`${pad('阶段', 26)}${pad('Agent', 8)}${pad('状态', 10)}${pad('耗时', 8)}${pad('闸门', 12)}最近日志`);
  lines.push('-'.repeat(104));
  for (const stage of stages) {
    const label = `${stage.stage_key}(${STAGE_LABELS[stage.stage_key] || stage.label || ''})`;
    const status = STATUS_LABELS[stage.status] || stage.status;
    const duration = formatDuration(durationSeconds(stage));
    const decision = stage.approval?.decision || '—';
    const lastLog = stage.logs?.length ? String(stage.logs[stage.logs.length - 1].message || '').slice(0, 40) : '';
    lines.push(
      `${pad(label, 26)}${pad(stage.agent_id || '', 8)}${pad(status, 10)}${pad(duration, 8)}${pad(decision, 12)}${lastLog}`,
    );
  }
  lines.push('');
  lines.push('闸门明细：');
  for (const gate of result.gates) {
    const note = gate.note ? `（意见：${gate.note}）` : '';
    lines.push(`  - ${pad(gate.stageKey, 16)}${gate.decision}${note}`);
  }
  lines.push('');
  lines.push(`自动返工轮次：${result.reworkRounds}`);
  lines.push('');
  lines.push('检查项：');
  for (const check of result.checks) {
    lines.push(`  ${check.pass ? '[通过]' : '[未通过]'} ${check.label}    ${check.detail}`);
  }
  lines.push('');
  const failed = result.checks.filter((check) => !check.pass);
  if (failed.length) {
    lines.push(`结论：${failed.length} 项未通过。${failed.map((check) => check.label).join('；')}`);
  } else {
    lines.push('结论：全部通过，这一轮可以用于演示。');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const loaded = loadStages(args.db);
  if (loaded.error) {
    console.error(loaded.error);
    process.exit(2);
  }
  const { stages } = loaded;
  if (!stages.length) {
    console.error('pipeline_stages 为空：还没有启动过流水线。');
    process.exit(2);
  }

  const result = analyze(stages);
  if (args.json) {
    console.log(JSON.stringify({
      db: args.db,
      reworkRounds: result.reworkRounds,
      checks: result.checks,
      gates: result.gates,
      stages: stages.map((stage) => ({ stage_key: stage.stage_key, status: stage.status, approval: stage.approval })),
    }, null, 2));
  } else {
    console.log(render(args.db, stages, result));
  }
  process.exit(result.checks.every((check) => check.pass) ? 0 : 1);
}

main();
