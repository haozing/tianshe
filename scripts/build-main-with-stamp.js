#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { writeMainBuildStamp } = require('./main-build-stamp');

const ROOT = path.resolve(__dirname, '..');

function run() {
  const tscBin = require.resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.main.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.error) {
    throw result.error;
  }

  const stamp = writeMainBuildStamp(ROOT);
  process.stdout.write(
    `[build:main] wrote build stamp at ${stamp.builtAt} for ${stamp.entryPoint}\n`
  );
}

try {
  run();
} catch (error) {
  process.stderr.write(
    `[build:main] ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
