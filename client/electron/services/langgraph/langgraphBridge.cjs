/**
 * LangGraph Python 服务桥接。
 *
 * 负责调用 Python 图服务端点（health/start/state/approve/reject），
 * 并把图状态快照原样交回编排适配器投影到 SQLite 黑板。
 * 快照原始结构：{ run_id, status, active, outputs, upstream, logs, rework_count, approval, next, interrupts, error }。
 *
 * 服务端已改为「启动即返回、后台执行」：单次 HTTP 调用只负责提交或查询，
 * 不再阻塞到某个阶段跑完，因此这里不再需要十几分钟的超时；
 * 仍然保留 60s 上限，避免 Python 卡死时 IPC 永久挂起。
 */

const SERVICE_URL = process.env.LANGGRAPH_SERVICE_URL || 'http://127.0.0.1:8765';
const QUERY_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 60000;

async function request(pathname, options = {}) {
  const response = await fetch(`${SERVICE_URL}${pathname}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`LangGraph 服务返回 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

async function health() {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function createLangGraphBridge() {
  return {
    health,
    start(runId, context = {}) {
      return request('/graph/start', {
        method: 'POST',
        body: { run_id: runId, context },
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    },
    review(runId, payload = {}) {
      return request('/graph/review', {
        method: 'POST',
        body: {
          run_id: runId,
          context: payload.context || {},
          draft: payload.draft || {},
          reference: payload.reference || {},
        },
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    },
    getSchema() {
      return request('/graph/schema');
    },
    getState(runId) {
      return request(`/graph/state?run_id=${encodeURIComponent(runId)}`);
    },
    approve(runId, stageKey, note = '') {
      return request('/graph/approve', {
        method: 'POST',
        body: { run_id: runId, stage_key: stageKey, note },
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    },
    reject(runId, stageKey, note = '') {
      return request('/graph/reject', {
        method: 'POST',
        body: { run_id: runId, stage_key: stageKey, note },
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    },
  };
}

module.exports = { createLangGraphBridge, SERVICE_URL };
