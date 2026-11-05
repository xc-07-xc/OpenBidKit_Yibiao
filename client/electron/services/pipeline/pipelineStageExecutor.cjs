const http = require('node:http');
const { getStageByKey } = require('./pipelineAgentConfig.cjs');

const INTERNAL_PORT = Number(process.env.NODE_INTERNAL_PORT || 8788);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 单阶段本地执行器：供 LangGraph Python 服务回调，复用现有 Runner。
 *
 * 入参 body: { stage_key, context, upstream }
 * 出参: { outputs, logs: [{ stage, message }] }
 *
 * 该执行器只负责执行单阶段并回传产物；黑板写入、产物落盘、知识库回写
 * 仍由编排桥接层按现有规则处理，避免与编排器双写。
 */
function createStageHttpServer({ runners }) {
  async function runStageLocally({ stageKey, context, upstream }) {
    const runner = runners?.[stageKey];
    const logs = [];
    const ctx = {
      stage: getStageByKey(stageKey),
      context: context || {},
      upstream: upstream || {},
      signal: null,
      appendLog: (message) => logs.push({ stage: stageKey, message: String(message) }),
    };
    const result = runner
      ? await runner(ctx)
      : { outputs: { placeholder: true, note: `未配置该阶段 runner：${stageKey}` } };
    return { outputs: result?.outputs || null, logs };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/internal/run-stage') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(raw || '{}');
            const result = await runStageLocally({
              stageKey: payload.stage_key,
              context: payload.context,
              upstream: payload.upstream,
            });
            return sendJson(res, 200, result);
          } catch (error) {
            return sendJson(res, 500, { error: { message: error?.message || String(error) } });
          }
        });
        return;
      }

      return sendJson(res, 404, { error: { message: 'not found' } });
    } catch (error) {
      return sendJson(res, 500, { error: { message: error?.message || String(error) } });
    }
  });

  return {
    start: () => server.listen(INTERNAL_PORT, '127.0.0.1'),
    close: () => server.close(),
  };
}

module.exports = { createStageHttpServer, INTERNAL_PORT };
