#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');

const RENDERER_URL = process.env.AIRPA_RENDERER_DEV_URL || 'http://127.0.0.1:5273/';
const READY_TIMEOUT_MS = Number(process.env.AIRPA_DEV_READY_TIMEOUT_MS || 120000);

const children = new Set();
let shuttingDown = false;

function prefixStream(stream, name, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      process.stdout.write(`[${name}] ${line}\n`);
      onLine?.(line);
    }
  });
  stream.on('end', () => {
    if (buffer) {
      process.stdout.write(`[${name}] ${buffer}\n`);
      onLine?.(buffer);
      buffer = '';
    }
  });
}

function spawnPrefixed(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: options.shell || false,
  });

  children.add(child);
  prefixStream(child.stdout, name, options.onLine);
  prefixStream(child.stderr, name, options.onLine);
  child.on('exit', () => {
    children.delete(child);
  });
  child.on('error', (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`);
  });
  return child;
}

function terminateChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of Array.from(children)) {
    if (!child.killed) {
      child.kill();
    }
  }
}

function waitForChildExitBeforeReady(child, name) {
  return new Promise((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `${name} exited before dev startup was ready` +
            (signal ? ` (signal ${signal})` : ` (code ${code ?? 0})`)
        )
      );
    });
  });
}

function waitForMainReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for main TypeScript watch compilation'));
    }, READY_TIMEOUT_MS);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `main exited before first successful watch compilation` +
            (signal ? ` (signal ${signal})` : ` (code ${code ?? 0})`)
        )
      );
    });

    const onLine = (line) => {
      if (/Found\s+0\s+errors?\.\s+Watching for file changes\./i.test(line)) {
        clearTimeout(timeout);
        resolve();
      }
    };

    child.__airpaOnLine = onLine;
  });
}

function withLineFanout(handlerRef, extraHandler) {
  return (line) => {
    handlerRef.current?.(line);
    extraHandler?.(line);
  };
}

async function waitForRendererReady(child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(RENDERER_URL, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('renderer exited before Vite dev server became ready');
    }
  }

  throw new Error(`Timed out waiting for renderer dev server: ${RENDERER_URL}`);
}

async function main() {
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const renderer = spawnPrefixed('renderer', process.execPath, [viteBin]);

  const mainReadyLineHandler = { current: null };
  const mainProcess = spawnPrefixed(
    'main',
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '-p',
      'tsconfig.main.json',
      '--watch',
      '--preserveWatchOutput',
    ],
    {
      onLine: withLineFanout(mainReadyLineHandler),
    }
  );

  const mainReady = waitForMainReady(mainProcess);
  mainReadyLineHandler.current = mainProcess.__airpaOnLine;

  await Promise.race([
    Promise.all([waitForRendererReady(renderer), mainReady]),
    waitForChildExitBeforeReady(renderer, 'renderer'),
  ]);

  process.stdout.write('[electron] renderer and main build are ready; launching Electron\n');
  const { buildLaunchConfig } = require('./launch-electron');
  const launchConfig = buildLaunchConfig({
    args: ['--expose-gc', '.'],
    env: process.env,
  });
  const electron = spawnPrefixed('electron', require('electron'), launchConfig.args, {
    env: launchConfig.env,
  });

  const exitCode = await new Promise((resolve) => {
    electron.once('exit', (code) => resolve(code ?? 0));
  });
  terminateChildren();
  process.exit(Number(exitCode) || 0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    terminateChildren();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

main().catch((error) => {
  process.stderr.write(
    `[dev:base] ${error instanceof Error ? error.message : String(error)}\n`
  );
  terminateChildren();
  process.exit(1);
});
