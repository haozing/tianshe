#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const esbuild = require('esbuild');
const { writeMainBuildStamp } = require('./main-build-stamp');

const ROOT = path.resolve(__dirname, '..');

function bundlePreloadEntries() {
  const entries = [
    ['src/preload/index.ts', 'dist/preload/index.js'],
    ['src/preload/webcontents-view.ts', 'dist/preload/webcontents-view.js'],
  ];

  for (const [entryPoint, outfile] of entries) {
    esbuild.buildSync({
      absWorkingDir: ROOT,
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      logLevel: 'silent',
    });
    process.stdout.write(`[build:main] bundled ${entryPoint} -> ${outfile}\n`);
  }
}

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

  bundlePreloadEntries();

  const stamp = writeMainBuildStamp(ROOT);
  process.stdout.write(
    `[build:main] wrote build stamp at ${stamp.builtAt} for ${stamp.entryPoint}\n`
  );
}

module.exports = {
  bundlePreloadEntries,
  run,
};

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `[build:main] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
