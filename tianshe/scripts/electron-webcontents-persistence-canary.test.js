const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function shouldRunElectronCanary() {
  return (
    process.env.AIRPA_RUN_ELECTRON_CANARY === '1' ||
    process.env.AIRPA_RUN_ELECTRON_CANARY === 'true'
  );
}

function resolveElectronExecutable() {
  const electron = require('electron');
  if (typeof electron === 'string') {
    return electron;
  }
  if (typeof electron === 'function' && typeof electron.toString === 'function') {
    return electron.toString();
  }
  throw new Error('Unable to resolve Electron executable path');
}

function waitForReport(reportPath, debugPath, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(reportPath)) {
        resolve(fs.readFileSync(reportPath, 'utf8'));
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const debug = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf8') : '';
        reject(new Error(`Timed out waiting for Electron canary report: ${reportPath}\n${debug}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function runElectronCanary(scriptName) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.TIANSHE_REPO_ROOT = path.resolve(__dirname, '..');
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshe-electron-canary-app-'));
    const reportPath = path.join(appDir, 'report.json');
    const debugPath = path.join(appDir, 'debug.log');
    env.TIANSHE_ELECTRON_CANARY_REPORT_PATH = reportPath;
    env.TIANSHE_ELECTRON_CANARY_DEBUG_PATH = debugPath;
    fs.copyFileSync(
      path.join(__dirname, scriptName),
      path.join(appDir, 'main.js')
    );
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'tianshe-electron-canary', main: 'main.js' }),
      'utf8'
    );
    const child = spawn(
      resolveElectronExecutable(),
      [appDir],
      {
        cwd: path.resolve(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    const cleanup = () => {
      fs.rmSync(appDir, { recursive: true, force: true });
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`Electron persistence canary exited with ${code}: ${stderr || stdout}`));
        return;
      }
      waitForReport(reportPath, debugPath)
        .then((report) => {
          cleanup();
          resolve(report);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  });
}

describe('electron-webcontents persistence canary', () => {
  const runCanary = shouldRunElectronCanary() ? it : it.skip;

  runCanary(
    'persists localStorage and cookies across hidden windows sharing a persist partition',
    async () => {
      const stdout = await runElectronCanary('electron-webcontents-persistence-canary.js');
      const report = JSON.parse(stdout);

      expect(report).toMatchObject({
        ok: true,
        partition: expect.stringMatching(/^persist:electron-canary-/),
        storageKey: 'tianshe_electron_canary',
        cookieName: 'tianshe_electron_canary',
      });
    },
    120000
  );

  runCanary(
    'persists cookies and localStorage through BrowserPool reuse and fresh recreate',
    async () => {
      const stdout = await runElectronCanary('electron-webcontents-browserpool-canary.js');
      const report = JSON.parse(stdout);

      expect(report).toMatchObject({
        ok: true,
        partition: expect.stringMatching(/^persist:electron-pool-canary-/),
        storageKey: 'tianshe_electron_pool_canary',
        cookieName: 'tianshe_electron_pool_canary',
      });
    },
    120000
  );
});
