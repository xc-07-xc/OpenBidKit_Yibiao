const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SERVICE_PORT = Number(process.env.LANGGRAPH_SERVICE_PORT || 8765);
const NODE_INTERNAL_PORT = process.env.NODE_INTERNAL_PORT || '8788';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析 LangGraph 服务的启动方式，优先级：
 * 1. 安装包内的 sidecar 可执行文件（extraResources/langgraph-sidecar）；
 * 2. 开发态仓库中的 `.venv`；
 * 3. 都没有则视为不可用，由装配层回退内置编排器。
 *
 * 返回 { mode: 'sidecar' | 'venv' | 'missing', command, args, cwd, serviceDir }。
 */
function resolveLaunch(targetPort = SERVICE_PORT) {
  // __dirname 为 client/electron/services/langgraph
  const repoRoot = path.join(__dirname, '../../../../');
  const serviceDir = path.join(repoRoot, 'agent-langgraph');
  const exeName = process.platform === 'win32' ? 'yibiao-langgraph.exe' : 'yibiao-langgraph';
  const resourcesRoot = process.resourcesPath || '';
  const bundled = resourcesRoot ? path.join(resourcesRoot, 'langgraph-sidecar', exeName) : '';
  if (bundled && fs.existsSync(bundled)) {
    return {
      mode: 'sidecar',
      command: bundled,
      args: [],
      cwd: path.dirname(bundled),
      serviceDir,
    };
  }

  const winPython = path.join(serviceDir, '.venv', 'Scripts', 'python.exe');
  const unixPython = path.join(serviceDir, '.venv', 'bin', 'python');
  const python = fs.existsSync(winPython) ? winPython : fs.existsSync(unixPython) ? unixPython : null;
  if (python) {
    return {
      mode: 'venv',
      command: python,
      args: ['-m', 'uvicorn', 'app.server:app', '--host', '127.0.0.1', '--port', String(targetPort)],
      cwd: serviceDir,
      serviceDir,
    };
  }

  return { mode: 'missing', command: null, args: [], cwd: serviceDir, serviceDir };
}

function probeHealthy() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVICE_PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * LangGraph Python 服务进程管理。
 * - start: 优先拉起打包 sidecar，其次用虚拟环境解释器拉起 uvicorn 子进程
 * - waitHealthy: 轮询 /health 直到就绪或超时
 * - stop: 退出时回收子进程
 */
function createPythonService() {
  let child = null;
  let stopped = false;
  let lastMode = 'unknown';

  function start() {
    const launch = resolveLaunch(SERVICE_PORT);
    lastMode = launch.mode;
    if (!launch.command) {
      console.warn('[langgraph] 未找到 sidecar 或 Python 虚拟环境，跳过服务拉起');
      return { started: false, reason: 'runtime-missing', mode: launch.mode };
    }

    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        LANGGRAPH_SERVICE_PORT: String(SERVICE_PORT),
        NODE_INTERNAL_BASE_URL: `http://127.0.0.1:${NODE_INTERNAL_PORT}`,
        NODE_INTERNAL_PORT,
      },
      stdio: 'pipe',
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log('[langgraph]', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[langgraph]', text);
    });
    child.on('error', (error) => {
      console.warn('[langgraph] 子进程启动失败：', error?.message || String(error));
    });
    child.on('exit', (code) => {
      if (!stopped) console.warn('[langgraph] 子进程退出，code=', code);
    });

    return { started: true, mode: launch.mode };
  }

  async function waitHealthy(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stopped) return false;
      if (await probeHealthy()) return true;
      await sleep(300);
    }
    return false;
  }

  function stop() {
    stopped = true;
    if (child && !child.killed) {
      try {
        if (process.platform === 'win32' && child.pid) {
          // PyInstaller onefile 会派生实际服务子进程，child.kill() 只结束 bootloader，
          // 子进程仍占着 8765，下次启动会连到旧实例，所以按进程树结束。
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch (error) {
        console.warn('[langgraph] 停止子进程失败', error?.message || String(error));
      }
    }
    child = null;
  }

  function getMode() {
    return lastMode;
  }

  return { start, stop, waitHealthy, getMode };
}

module.exports = { createPythonService, resolveLaunch, SERVICE_PORT };
