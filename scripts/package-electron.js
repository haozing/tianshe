#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');

function readPackageJsonText() {
  return fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
}

function resolveElectronBuilderCommand() {
  const localCommand = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
  if (fs.existsSync(localCommand)) {
    return localCommand;
  }
  return process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
}

function runElectronBuilder(args) {
  const command = resolveElectronBuilderCommand();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

function main() {
  const args = process.argv.slice(2);
  const before = readPackageJsonText();
  let status = 1;
  try {
    status = runElectronBuilder(args);
  } finally {
    const after = readPackageJsonText();
    if (after !== before) {
      fs.writeFileSync(PACKAGE_JSON_PATH, before, 'utf8');
      process.stderr.write('[package-electron] restored package.json after electron-builder\n');
    }
  }
  process.exit(status);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[package-electron] ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
