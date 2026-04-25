#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EDITIONS = new Set(['open', 'cloud']);

function resolveCommand(command, args) {
  if (command === 'npm' && process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command, args };
}

function run(command, args, env) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && resolved.command !== process.execPath,
  });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function main() {
  const edition = process.argv[2];
  if (!EDITIONS.has(edition)) {
    process.stderr.write('Usage: node scripts/build-edition.js <open|cloud>\n');
    process.exit(2);
  }

  const env = {
    ...process.env,
    TIANSHE_EDITION: edition,
    AIRPA_EDITION: edition,
  };

  run('npm', ['run', 'build'], env);
  if (edition === 'open') {
    run(process.execPath, ['scripts/open-source-boundary.js'], env);
  }
}

main();
