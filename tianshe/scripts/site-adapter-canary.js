#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE_ADAPTER_CANARY_EVIDENCE_PATH = path.join(
  ROOT,
  'docs',
  'evidence',
  'site-adapter-canary',
  'latest.json'
);
const SITE_ADAPTER_CANARY_SUITES = [
  {
    id: 'runner',
    file: 'src/core/site-adapter-runtime/runner.test.ts',
    coverage: [
      'SiteAdapterRunner fixture/browser-snapshot/browser-evaluate/procedure dispatch',
      'supported runner policy',
    ],
  },
  {
    id: 'official-adapters',
    file: 'src/site-adapters/official-readonly-adapters.test.ts',
    coverage: [
      'official adapter registry coverage',
      'required quality fields for extractor outputs',
      'npm package summary extraction fixture',
    ],
  },
  {
    id: 'books-pack',
    file: 'src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
    coverage: [
      'Books adapter fixture regression',
      'browser-snapshot canary path',
      'low-risk Procedure execution',
    ],
  },
  {
    id: 'open-library-pack',
    file: 'src/site-adapters/open-library/open-library.test.ts',
    coverage: [
      'Open Library adapter low-risk Procedure execution',
      'Open Library paginated result preview Procedure evidence',
      'Open Library Procedure repair surface',
    ],
  },
  {
    id: 'github-pack',
    file: 'src/site-adapters/github-profile/github-profile.test.ts',
    coverage: [
      'GitHub logged-in profile fixture regression',
      'low-risk profile settings Procedure execution',
      'low-risk issue draft Procedure execution without submit',
      'high-risk issue creation Procedure confirmation gate',
    ],
  },
  {
    id: 'procedure',
    file: 'src/core/site-adapter-runtime/procedure.test.ts',
    coverage: [
      'Procedure state transitions and action trace',
      'Procedure pagination step evidence and stop reasons',
      'low/high side-effect gates',
      'replay/resume from failed state',
      'repair publish gate requirements',
    ],
  },
  {
    id: 'persistent-resume',
    file: 'src/core/site-adapter-runtime/procedure-resume-store.test.ts',
    coverage: [
      'cross-process Procedure resume state persistence',
      'resume state redaction',
      'consumed resume record guard',
    ],
  },
  {
    id: 'repair-workflow',
    file: 'src/core/site-adapter-repair-studio/read-only-repair.test.ts',
    coverage: [
      'failure bundle to repair task workflow',
      'path gate, fixture regression, target smoke, human review, publish record',
    ],
  },
  {
    id: 'repair-model-gateway',
    file: 'src/core/site-adapter-repair-studio/model-gateway.test.ts',
    coverage: [
      'read-only repair model provider call boundary',
      'Procedure repair model provider call boundary',
      'model diff path allowlist validation before review/apply',
    ],
  },
  {
    id: 'repair-studio-ipc',
    file: 'src/main/site-adapter-repair-studio/routes-or-ipc.test.ts',
    coverage: [
      'Repair Studio trusted renderer IPC model diff endpoint',
      'Repair Studio trusted renderer review/apply/publish endpoint',
      'configured provider and environment gap responses',
      'built-in provider credential save/clear summaries',
      'approved review/apply/publish can write scoped adapter changes',
    ],
  },
  {
    id: 'repair-studio-ui',
    file: 'src/renderer/src/components/SettingsPage/__tests__/SiteAdapterRepairStudioPanel.test.tsx',
    coverage: [
      'Repair Studio renderer model diff panel',
      'provider environment gap and generated diff preview states',
      'provider template and credential status panel',
      'provider credential save/rotation UI without key echo',
      'review gate checklist and publish readiness state',
      'one-click review preview and real apply/publish action',
    ],
  },
  {
    id: 'lab-repair-handoff-ui',
    file: 'src/renderer/src/components/SettingsPage/__tests__/SiteAdapterLabPanel.repairStudio.test.tsx',
    coverage: [
      'Site Adapter Lab repair bundle to Repair Studio handoff',
      'scoped model diff preview from Lab evidence',
    ],
  },
  {
    id: 'dataset-evidence-ui',
    file: 'src/renderer/src/components/SettingsPage/__tests__/DatasetRecordEvidencePanel.test.tsx',
    coverage: [
      'Dataset record evidence renderer query panel',
      'provenance source and observation trace visualization',
    ],
  },
  {
    id: 'repair-model-provider-config',
    file: 'src/main/site-adapter-repair-studio/model-provider-config.test.ts',
    coverage: [
      'Repair Studio OpenAI-compatible model provider config',
      'provider templates and credential-safe config summary',
      'built-in provider credential storage and rotation',
      'provider request parsing and credential-safe error handling',
    ],
  },
  {
    id: 'procedure-repair',
    file: 'src/core/site-adapter-runtime/repair/procedure-repair-evidence.test.ts',
    coverage: [
      'failed Procedure repair evidence',
      'Procedure repair scope',
      'target canary and destructive confirmation risk gate',
    ],
  },
  {
    id: 'repair-scope',
    file: 'src/core/site-adapter-runtime/repair/repair-scope.test.ts',
    coverage: [
      'all official adapter repair scope allow/deny matrix',
      'framework/core/secrets path denial',
    ],
  },
  {
    id: 'site-capabilities',
    file: 'src/core/ai-dev/capabilities/site-capability-catalog.test.ts',
    coverage: [
      'site capability execution through SiteAdapterRunner',
      'login handoff/resume',
      'dataset staged write policy',
      'failure artifact refs',
    ],
  },
  {
    id: 'login-health',
    file: 'src/core/site-adapter-runtime/login-health.test.ts',
    coverage: [
      'site login health verifier missing/expired/stale/runtime mismatch states',
      'login evidence redaction',
    ],
  },
  {
    id: 'login-lease',
    file: 'src/core/browser-pool/__tests__/profile-live-session-lease.test.ts',
    coverage: [
      'human/agent profile live session lease wait semantics',
      'explicit takeover semantics',
    ],
  },
  {
    id: 'mcp-session-binding',
    file: 'src/main/mcp-server-http.browser-binding.test.ts',
    coverage: [
      'MCP browser binding lock rejects conflicting rebind',
      'prepared profile/runtime handoff binding evidence',
    ],
  },
];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    suite: env.TIANSHE_SITE_ADAPTER_CANARY_SUITE || 'all',
    timeoutMs: Number.parseInt(env.TIANSHE_SITE_ADAPTER_CANARY_TIMEOUT_MS || '300000', 10),
    dryRun: false,
    passThroughArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--suite') {
      options.suite = argv[++index];
    } else if (arg.startsWith('--suite=')) {
      options.suite = arg.slice('--suite='.length);
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

function selectSuites(suite, suites = SITE_ADAPTER_CANARY_SUITES) {
  const normalized = String(suite || 'all')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const requested = normalized.length > 0 ? normalized : ['all'];

  if (requested.includes('all')) {
    return suites;
  }

  const selected = suites.filter((item) => requested.includes(item.id));
  const known = new Set(suites.map((item) => item.id));
  const unknown = requested.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown site adapter canary suite(s): ${unknown.join(', ')}. Known: ${Array.from(
        known
      ).join(', ')}, all`
    );
  }
  return selected;
}

function buildVitestInvocation(options, suites = SITE_ADAPTER_CANARY_SUITES) {
  const selectedSuites = selectSuites(options.suite, suites);
  const files = Array.from(new Set(selectedSuites.map((suite) => suite.file)));

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vitest', 'run', '--no-file-parallelism', ...files, ...options.passThroughArgs],
    env: { ...process.env },
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
            finish(new Error(`Site adapter canary timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;

    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(null, code ?? 1));
  });
}

async function runSiteAdapterCanary(options) {
  const invocation = buildVitestInvocation(options);
  if (invocation.suites.length === 0) {
    throw new Error('No site adapter canary suites selected');
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
  const result = {
    code,
    status: code === 0 ? 'passed' : 'failed',
    suite: options.suite,
    command: invocation.command,
    args: invocation.args,
    suites: invocation.suites.map((suite) => suite.id),
    coverage: invocation.suites.flatMap((suite) => suite.coverage),
  };
  writeSiteAdapterCanaryEvidence(result);
  return result;
}

function writeSiteAdapterCanaryEvidence(result) {
  fs.mkdirSync(path.dirname(SITE_ADAPTER_CANARY_EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(
    SITE_ADAPTER_CANARY_EVIDENCE_PATH,
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
  const result = await runSiteAdapterCanary(options);
  if (options.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  process.exitCode = result.code;
}

module.exports = {
  SITE_ADAPTER_CANARY_EVIDENCE_PATH,
  SITE_ADAPTER_CANARY_SUITES,
  buildVitestInvocation,
  parseArgs,
  runSiteAdapterCanary,
  selectSuites,
  writeSiteAdapterCanaryEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
