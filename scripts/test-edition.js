#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EDITIONS = new Set(['open', 'cloud']);

const OPEN_TEST_FILES = [
  'src/edition/edition-boundary.test.ts',
  'src/core/js-plugin/namespaces/ui.test.ts',
  'src/preload/electron-api.contract.ts',
  'src/renderer/src/lib/edition.test.tsx',
  'src/renderer/src/components/SettingsPage/__tests__/SettingsPage.test.tsx',
  'src/renderer/src/components/AccountCenter/__tests__/AccountCenterPage.tab-smoke.test.tsx',
  'src/renderer/src/components/PluginMarket/__tests__/PluginMarket.test.tsx',
  'src/main/ipc-handlers/extension-packages-ipc-handler.test.ts',
];

const VITEST_BIN = require.resolve('vitest/vitest.mjs');

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command !== process.execPath,
  });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function main() {
  const edition = process.argv[2];
  const full = process.argv.includes('--full');
  const vitestArgs = process.argv.slice(3).filter((arg) => arg !== '--full');
  if (!EDITIONS.has(edition)) {
    process.stderr.write('Usage: node scripts/test-edition.js <open|cloud> [--full]\n');
    process.exit(2);
  }

  const env = {
    ...process.env,
    TIANSHE_EDITION: edition,
    AIRPA_EDITION: edition,
  };

  if (edition === 'open') {
    run(process.execPath, ['scripts/open-source-boundary.js'], env);
    if (full) {
      run(process.execPath, [VITEST_BIN, 'run', '--no-file-parallelism', ...vitestArgs], env);
      return;
    }
    run(process.execPath, [VITEST_BIN, 'run', ...OPEN_TEST_FILES, ...vitestArgs], env);
    return;
  }

  run(process.execPath, [VITEST_BIN, 'run', ...vitestArgs], env);
}

main();
