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

function main() {
  const [, , edition, command, ...args] = process.argv;
  if (!EDITIONS.has(edition) || !command) {
    process.stderr.write(
      'Usage: node scripts/run-with-edition.js <open|cloud> <command> [...args]\n'
    );
    process.exit(2);
  }

  const env = {
    ...process.env,
    TIANSHE_EDITION: edition,
    AIRPA_EDITION: edition,
  };
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && resolved.command !== process.execPath,
  });

  if (result.error) throw result.error;
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();
