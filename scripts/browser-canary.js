#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CANARY_SUITES = [
  {
    id: 'pool',
    env: 'AIRPA_RUN_BROWSER_POOL_CANARY',
    file: 'src/main/profile/browser-pool-real.canary.test.ts',
  },
  {
    id: 'extension',
    env: 'AIRPA_RUN_EXTENSION_CANARY',
    file: 'src/main/profile/browser-pool-integration-extension.canary.test.ts',
  },
  {
    id: 'ruyi',
    env: 'AIRPA_RUN_RUYI_CANARY',
    file: 'src/main/profile/browser-pool-integration-ruyi.canary.test.ts',
  },
];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    runtime: env.TIANSHE_BROWSER_CANARY_RUNTIME || 'all',
    timeoutMs: Number.parseInt(env.TIANSHE_BROWSER_CANARY_TIMEOUT_MS || '300000', 10),
    dryRun: false,
    passThroughArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime') {
      options.runtime = argv[++index];
    } else if (arg.startsWith('--runtime=')) {
      options.runtime = arg.slice('--runtime='.length);
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[++index], 10);
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--') {
      options.passThroughArgs.push(...argv.slice(index + 1));
      break;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    options.timeoutMs = 300000;
  }

  return options;
}

function selectSuites(runtime, suites = CANARY_SUITES) {
  const normalized = String(runtime || 'all')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const requested = normalized.length > 0 ? normalized : ['all'];

  if (requested.includes('all')) {
    return suites;
  }

  const selected = suites.filter((suite) => requested.includes(suite.id));
  const known = new Set(suites.map((suite) => suite.id));
  const unknown = requested.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown browser canary runtime(s): ${unknown.join(', ')}. Known: ${Array.from(known).join(
        ', '
      )}, all`
    );
  }
  return selected;
}

function buildVitestInvocation(options, suites = CANARY_SUITES) {
  const selectedSuites = selectSuites(options.runtime, suites);
  const env = { ...process.env };
  for (const suite of selectedSuites) {
    env[suite.env] = '1';
  }
  if (selectedSuites.some((suite) => suite.id === 'pool')) {
    env.AIRPA_RUN_EXTENSION_CANARY = '1';
    env.AIRPA_RUN_RUYI_CANARY = '1';
  }

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vitest', 'run', ...selectedSuites.map((suite) => suite.file), ...options.passThroughArgs],
    env,
    suites: selectedSuites,
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
      windowsHide: true,
    });

    let settled = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(code);
      }
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (!child.killed) {
              child.kill();
            }
            finish(new Error(`Browser canary timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;

    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(null, code ?? 1));
  });
}

async function runBrowserCanary(options) {
  const invocation = buildVitestInvocation(options);
  if (invocation.suites.length === 0) {
    throw new Error('No browser canary suites selected');
  }

  if (options.dryRun) {
    return {
      code: 0,
      command: invocation.command,
      args: invocation.args,
      suites: invocation.suites.map((suite) => suite.id),
    };
  }

  const code = await runProcess(invocation.command, invocation.args, {
    cwd: ROOT,
    env: invocation.env,
    timeoutMs: options.timeoutMs,
  });
  return {
    code,
    command: invocation.command,
    args: invocation.args,
    suites: invocation.suites.map((suite) => suite.id),
  };
}

async function main() {
  const options = parseArgs();
  const result = await runBrowserCanary(options);
  if (options.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  process.exitCode = result.code;
}

module.exports = {
  CANARY_SUITES,
  buildVitestInvocation,
  parseArgs,
  runBrowserCanary,
  selectSuites,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
