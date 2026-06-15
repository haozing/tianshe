#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_APP_DIR = path.join(ROOT, 'release-build', 'win-unpacked');
const DEFAULT_EXE_NAME = process.platform === 'win32' ? 'tiansheai-open.exe' : 'tiansheai-open';
const STARTUP_TIMEOUT_MS = 30000;

const REQUIRED_APP_ASAR_FILES = [
  'package.json',
  'index.js',
  'dist/main/index.js',
  'dist/constants/http-api.js',
  'dist/core/ffi/isolated-worker.js',
  'dist/core/system-automation/ocr/ocr-worker.js',
  'dist/core/system-automation/cv/opencvjs-worker.js',
];

const REQUIRED_UNPACKED_PATHS = [
  'node_modules/onnxruntime-node',
  'node_modules/koffi',
  'node_modules/hnswlib-node',
  'node_modules/@gutenye',
  'node_modules/@duckdb',
  'dist/core/ffi/isolated-worker.js',
  'dist/core/system-automation/cv/opencvjs-worker.js',
  'dist/main/duckdb/import-worker.js',
];

const NATIVE_PROBE_PATHS = [
  'node_modules/onnxruntime-node',
  'node_modules/koffi',
  'node_modules/hnswlib-node',
  'node_modules/@duckdb',
];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    appDir: env.TIANSHE_PACKAGE_SMOKE_APP_DIR || DEFAULT_APP_DIR,
    exeName: env.TIANSHE_PACKAGE_SMOKE_EXE || DEFAULT_EXE_NAME,
    launch: env.TIANSHE_PACKAGE_SMOKE_LAUNCH === '1',
    timeoutMs: STARTUP_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app-dir') {
      options.appDir = argv[++index];
    } else if (arg.startsWith('--app-dir=')) {
      options.appDir = arg.slice('--app-dir='.length);
    } else if (arg === '--exe-name') {
      options.exeName = argv[++index];
    } else if (arg.startsWith('--exe-name=')) {
      options.exeName = arg.slice('--exe-name='.length);
    } else if (arg === '--launch') {
      options.launch = true;
    } else if (arg === '--no-launch') {
      options.launch = false;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[++index], 10);
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    options.timeoutMs = STARTUP_TIMEOUT_MS;
  }

  return options;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function assertDirectory(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Missing ${label}: ${dirPath}`);
  }
}

function readAsarText(asarPath, entryPath, asarApi = asar) {
  const normalized = entryPath.replace(/\\/g, '/');
  return asarApi.extractFile(asarPath, normalized).toString('utf8');
}

function assertAsarFiles(asarPath, asarApi = asar) {
  for (const entryPath of REQUIRED_APP_ASAR_FILES) {
    try {
      asarApi.extractFile(asarPath, entryPath);
    } catch (error) {
      throw new Error(`Missing app.asar entry ${entryPath}: ${error.message}`);
    }
  }
}

function assertHttpDefaultDisabled(asarPath, asarApi = asar) {
  const httpApiText = readAsarText(asarPath, 'dist/constants/http-api.js', asarApi);
  if (!/enabled:\s*false/.test(httpApiText)) {
    throw new Error('Packaged DEFAULT_HTTP_API_CONFIG must keep enabled: false');
  }
}

function findNativeArtifact(root) {
  if (!fs.existsSync(root)) {
    return null;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.(node|dll)$/i.test(entry.name)) {
        return fullPath;
      }
    }
  }

  return null;
}

function assertUnpackedResources(unpackedRoot) {
  for (const relativePath of REQUIRED_UNPACKED_PATHS) {
    const fullPath = path.join(unpackedRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing app.asar.unpacked resource: ${relativePath}`);
    }
  }

  for (const relativePath of NATIVE_PROBE_PATHS) {
    const fullPath = path.join(unpackedRoot, relativePath);
    const artifact = findNativeArtifact(fullPath);
    if (!artifact) {
      throw new Error(`No native .node/.dll artifact found under ${relativePath}`);
    }
  }
}

function verifyPackageLayout(options) {
  const appDir = path.resolve(options.appDir);
  const asarApi = options.asarApi || asar;
  const exePath = path.join(appDir, options.exeName);
  const resourcesDir = path.join(appDir, 'resources');
  const appAsarPath = path.join(resourcesDir, 'app.asar');
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');

  assertDirectory(appDir, 'packaged app directory');
  assertFile(exePath, 'packaged executable');
  assertDirectory(resourcesDir, 'resources directory');
  assertFile(appAsarPath, 'app.asar');
  assertDirectory(unpackedRoot, 'app.asar.unpacked');
  assertAsarFiles(appAsarPath, asarApi);
  assertHttpDefaultDisabled(appAsarPath, asarApi);
  assertUnpackedResources(unpackedRoot);

  return {
    appDir,
    exePath,
    resourcesDir,
    appAsarPath,
    unpackedRoot,
  };
}

function runLaunchSmoke(exePath, options = {}) {
  const timeoutMs = options.timeoutMs || STARTUP_TIMEOUT_MS;
  const userDataDir = path.join(os.tmpdir(), `tianshe-package-smoke-${Date.now()}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve, reject) => {
    const child = spawn(exePath, [`--airpa-user-data-dir=${userDataDir}`], {
      cwd: path.dirname(exePath),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const output = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) {
        child.kill();
      }
      fs.rmSync(userDataDir, { recursive: true, force: true });
      if (error) {
        reject(error);
      } else {
        resolve({ userDataDir, output: output.join('').slice(-2000) });
      }
    };

    const timer = setTimeout(() => finish(), timeoutMs);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.on('error', finish);
    child.on('exit', (code) => {
      if (settled) return;
      finish(new Error(`Packaged app exited before smoke timeout with code ${code}`));
    });
  });
}

async function runPackageSmoke(options) {
  const layout = verifyPackageLayout(options);
  let launchResult = null;
  if (options.launch) {
    launchResult = await runLaunchSmoke(layout.exePath, { timeoutMs: options.timeoutMs });
  }
  return { ...layout, launchResult };
}

async function main() {
  const options = parseArgs();
  const result = await runPackageSmoke(options);
  console.log(
    JSON.stringify(
      {
        appDir: result.appDir,
        exePath: result.exePath,
        checked: {
          appAsar: result.appAsarPath,
          unpackedRoot: result.unpackedRoot,
          launch: Boolean(result.launchResult),
        },
      },
      null,
      2
    )
  );
}

module.exports = {
  DEFAULT_APP_DIR,
  DEFAULT_EXE_NAME,
  REQUIRED_APP_ASAR_FILES,
  REQUIRED_UNPACKED_PATHS,
  NATIVE_PROBE_PATHS,
  parseArgs,
  readAsarText,
  verifyPackageLayout,
  runLaunchSmoke,
  runPackageSmoke,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
