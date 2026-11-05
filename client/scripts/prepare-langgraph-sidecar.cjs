/**
 * 构建 LangGraph sidecar（PyInstaller onefile），供安装包携带。
 *
 * 用法：
 *   node scripts/prepare-langgraph-sidecar.cjs            # 有 PyInstaller 就构建；没有则告警跳过
 *   node scripts/prepare-langgraph-sidecar.cjs --require  # 没有 PyInstaller 直接失败（发版用）
 *   node scripts/prepare-langgraph-sidecar.cjs --check    # 只检查环境，不构建
 *
 * 产物：client/vendor/langgraph-sidecar/<platform>-<arch>/yibiao-langgraph[.exe]
 * 打包配置通过 extraResources 把它放到 resources/langgraph-sidecar，
 * 运行时由 services/langgraph/pythonService.cjs 优先探测。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLIENT_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(CLIENT_DIR, '..');
const SERVICE_DIR = path.join(REPO_ROOT, 'agent-langgraph');
const VENDOR_DIR = path.join(CLIENT_DIR, 'vendor', 'langgraph-sidecar');
const BUILD_DIR = path.join(SERVICE_DIR, 'build');
const ENTRY = path.join(SERVICE_DIR, 'launcher.py');

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const REQUIRE = argv.has('--require');

function fail(message) {
  console.error(`[langgraph-sidecar] ${message}`);
  process.exit(1);
}

function platformTag() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${platform}-${process.arch}`;
}

function resolvePython() {
  const winPython = path.join(SERVICE_DIR, '.venv', 'Scripts', 'python.exe');
  const unixPython = path.join(SERVICE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(winPython)) return winPython;
  if (fs.existsSync(unixPython)) return unixPython;
  return null;
}

function hasPyInstaller(python) {
  const result = spawnSync(python, ['-c', 'import PyInstaller; print(PyInstaller.__version__)'], {
    cwd: SERVICE_DIR,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function main() {
  if (!fs.existsSync(ENTRY)) fail(`找不到入口文件：${ENTRY}`);

  const python = resolvePython();
  if (!python) {
    const message = '未找到 agent-langgraph/.venv，无法构建 sidecar；安装包将回退内置编排器。';
    if (REQUIRE) fail(message);
    console.warn(`[langgraph-sidecar] ${message}`);
    return;
  }

  const version = hasPyInstaller(python);
  if (!version) {
    const message = `当前 Python 环境没有 PyInstaller（${python}）。\n  安装：${python} -m pip install pyinstaller\n  然后重跑本脚本；未构建时安装包会回退内置编排器。`;
    if (REQUIRE || CHECK_ONLY) fail(message);
    console.warn(`[langgraph-sidecar] ${message}`);
    return;
  }

  const outDir = path.join(VENDOR_DIR, platformTag());
  console.log(`[langgraph-sidecar] PyInstaller ${version} / Python ${python}`);
  console.log(`[langgraph-sidecar] 输出目录：${outDir}`);
  if (CHECK_ONLY) {
    console.log('[langgraph-sidecar] 环境检查通过（--check，不构建）。');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onefile',
    '--name',
    'yibiao-langgraph',
    '--distpath',
    outDir,
    '--workpath',
    path.join(BUILD_DIR, 'work'),
    '--specpath',
    BUILD_DIR,
    '--paths',
    SERVICE_DIR,
    '--collect-all',
    'langgraph',
    '--collect-all',
    'fastapi',
    '--collect-all',
    'uvicorn',
    '--collect-all',
    'pydantic',
    '--collect-submodules',
    'app',
    ENTRY,
  ];

  console.log('[langgraph-sidecar] 开始构建（首次可能数分钟）...');
  const result = spawnSync(python, args, { cwd: SERVICE_DIR, stdio: 'inherit' });
  if (result.status !== 0) fail(`PyInstaller 构建失败，退出码 ${result.status}`);

  const exeName = process.platform === 'win32' ? 'yibiao-langgraph.exe' : 'yibiao-langgraph';
  const artifact = path.join(outDir, exeName);
  if (!fs.existsSync(artifact)) fail(`构建完成但未找到产物：${artifact}`);
  console.log(`[langgraph-sidecar] 完成：${artifact}`);
}

main();
