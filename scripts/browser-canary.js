#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CANARY_EVIDENCE_PATH = path.join(ROOT, 'docs', 'evidence', 'browser-canary', 'latest.json');
const CANARY_SUITES = [
  {
    id: 'pool',
    env: 'AIRPA_RUN_BROWSER_POOL_CANARY',
    file: 'src/main/profile/browser-pool-real.canary.test.ts',
  },
  {
    id: 'electron',
    env: 'AIRPA_RUN_ELECTRON_CANARY',
    file: 'scripts/electron-webcontents-persistence-canary.test.js',
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
  {
    id: 'cloak',
    env: 'AIRPA_RUN_CLOAK_CANARY',
    file: 'src/main/profile/browser-pool-real.canary.test.ts',
  },
];

function vitestCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

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
    env.AIRPA_RUN_CLOAK_CANARY = '1';
  }
  const files = Array.from(new Set(selectedSuites.map((suite) => suite.file)));

  return {
    command: vitestCommand(),
    args: ['vitest', 'run', '--no-file-parallelism', ...files, ...options.passThroughArgs],
    env,
    suites: selectedSuites,
  };
}

function suiteTasksFor(suite) {
  if (suite.id === 'pool') {
    return [
      {
        id: 'pool:extension',
        suiteIds: ['pool'],
        file: suite.file,
        env: {
          [suite.env]: '1',
          AIRPA_RUN_EXTENSION_CANARY: '1',
        },
      },
      {
        id: 'pool:ruyi',
        suiteIds: ['pool'],
        file: suite.file,
        env: {
          [suite.env]: '1',
          AIRPA_RUN_RUYI_CANARY: '1',
        },
      },
      {
        id: 'pool:cloak',
        suiteIds: ['pool'],
        file: suite.file,
        env: {
          [suite.env]: '1',
          AIRPA_RUN_CLOAK_CANARY: '1',
        },
      },
    ];
  }

  if (suite.id === 'cloak') {
    return [
      {
        id: 'pool:cloak',
        suiteIds: ['cloak'],
        file: suite.file,
        env: {
          [suite.env]: '1',
        },
      },
    ];
  }

  return [
    {
      id: suite.id,
      suiteIds: [suite.id],
      file: suite.file,
      env: {
        [suite.env]: '1',
      },
    },
  ];
}

function buildVitestPlan(options, suites = CANARY_SUITES) {
  const selectedSuites = selectSuites(options.runtime, suites);
  const tasksById = new Map();

  for (const suite of selectedSuites) {
    for (const task of suiteTasksFor(suite)) {
      const existing = tasksById.get(task.id);
      if (existing) {
        existing.suiteIds = Array.from(new Set([...existing.suiteIds, ...task.suiteIds]));
        existing.env = { ...existing.env, ...task.env };
      } else {
        tasksById.set(task.id, {
          ...task,
          suiteIds: [...task.suiteIds],
          env: { ...task.env },
        });
      }
    }
  }

  const invocations = Array.from(tasksById.values()).map((task) => ({
    id: task.id,
    suiteIds: task.suiteIds,
    command: vitestCommand(),
    args: ['vitest', 'run', '--no-file-parallelism', task.file, ...options.passThroughArgs],
    env: { ...process.env, ...task.env },
    file: task.file,
  }));

  return {
    invocations,
    suites: selectedSuites,
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
      shell: process.platform === 'win32',
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
  const plan = buildVitestPlan(options);
  if (plan.suites.length === 0) {
    throw new Error('No browser canary suites selected');
  }

  if (options.dryRun) {
    return {
      code: 0,
      command: process.execPath,
      args: [
        path.relative(ROOT, __filename),
        '--runtime',
        options.runtime,
        '--timeout-ms',
        String(options.timeoutMs),
        ...(options.passThroughArgs.length > 0 ? ['--', ...options.passThroughArgs] : []),
      ],
      invocations: plan.invocations.map((invocation) => ({
        id: invocation.id,
        suiteIds: invocation.suiteIds,
        command: invocation.command,
        args: invocation.args,
      })),
      suites: plan.suites.map((suite) => suite.id),
    };
  }

  const results = [];
  let code = 0;
  for (const invocation of plan.invocations) {
    const startedAt = new Date().toISOString();
    let invocationCode = 0;
    let errorMessage = null;
    try {
      invocationCode = await runProcess(invocation.command, invocation.args, {
        cwd: ROOT,
        env: invocation.env,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      invocationCode = 1;
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const completedAt = new Date().toISOString();
    results.push({
      id: invocation.id,
      suiteIds: invocation.suiteIds,
      command: invocation.command,
      args: invocation.args,
      code: invocationCode,
      status: invocationCode === 0 ? 'passed' : 'failed',
      error: errorMessage,
      startedAt,
      completedAt,
    });
    if (invocationCode !== 0) {
      code = invocationCode;
      break;
    }
  }
  const result = {
    code,
    status: code === 0 ? 'passed' : 'failed',
    runtime: options.runtime,
    command: process.execPath,
    args: [
      path.relative(ROOT, __filename),
      '--runtime',
      options.runtime,
      '--timeout-ms',
      String(options.timeoutMs),
      ...(options.passThroughArgs.length > 0 ? ['--', ...options.passThroughArgs] : []),
    ],
    invocations: results,
    suites: plan.suites.map((suite) => suite.id),
  };
  writeCanaryEvidence(result);
  return result;
}

function writeCanaryEvidence(result) {
  fs.mkdirSync(path.dirname(CANARY_EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(
    CANARY_EVIDENCE_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        ...result,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
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
  CANARY_EVIDENCE_PATH,
  buildVitestInvocation,
  buildVitestPlan,
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
