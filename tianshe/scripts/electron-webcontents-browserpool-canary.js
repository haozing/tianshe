const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.on('window-all-closed', () => {
  // The canary recreates hidden WebContentsView instances in one Electron process.
});

function appendDebug(message) {
  const debugPath = process.env.TIANSHE_ELECTRON_CANARY_DEBUG_PATH;
  if (!debugPath) return;
  fs.appendFileSync(debugPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function requireFromRepo(repoRoot, relativePath) {
  return require(path.join(repoRoot, relativePath));
}

function createProfile(profileId, partition, fingerprint) {
  const now = new Date();
  return {
    id: profileId,
    name: 'Electron WebContents BrowserPool Canary',
    runtimeId: 'electron-webcontents',
    description: null,
    groupId: null,
    partition,
    proxy: null,
    fingerprint,
    notes: null,
    color: null,
    status: 'idle',
    lastError: null,
    quota: 1,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    proxyId: null,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: null,
    isSystem: false,
    sortOrder: 0,
    tags: [],
    totalUses: 0,
    metadata: {},
  };
}

function createProfileService(profile) {
  return {
    get: async (id) => (id === profile.id ? profile : null),
    list: async () => [profile],
    updateStatus: async (id, status) => {
      if (id === profile.id) {
        profile.status = status;
      }
      return profile;
    },
    getStats: async () => ({ total: 1 }),
  };
}

async function writePersistenceProbe(browser, url) {
  const cookieName = 'tianshe_electron_pool_canary';
  const storageKey = 'tianshe_electron_pool_canary';
  const value = `electron-pool-${Date.now()}`;
  await browser.setCookie({
    name: cookieName,
    value,
    url,
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  });
  await browser.evaluateWithArgs(
    (key, nextValue) => {
      globalThis.localStorage.setItem(String(key), String(nextValue));
      return true;
    },
    storageKey,
    value
  );
  return { cookieName, storageKey, value };
}

async function expectPersistenceProbe(browser, probe) {
  const cookies = await browser.getCookies({ name: probe.cookieName });
  if (!cookies.some((cookie) => cookie.name === probe.cookieName && cookie.value === probe.value)) {
    throw new Error(`cookie did not persist: ${JSON.stringify(cookies)}`);
  }
  const storageValue = await browser.evaluateWithArgs(
    (key) => globalThis.localStorage.getItem(String(key)),
    probe.storageKey
  );
  if (storageValue !== probe.value) {
    throw new Error(`localStorage did not persist: expected ${probe.value}, got ${storageValue}`);
  }
}

async function main() {
  appendDebug('browserpool main entered');
  const repoRoot = process.env.TIANSHE_REPO_ROOT;
  if (!repoRoot) {
    throw new Error('TIANSHE_REPO_ROOT is required');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshe-electron-pool-canary-'));
  app.setPath('userData', tempRoot);
  appendDebug(`userData=${tempRoot}`);

  const {
    BrowserPoolManager,
  } = requireFromRepo(repoRoot, 'dist/core/browser-pool/pool-manager.js');
  const {
    createBrowserFactory,
    createBrowserDestroyer,
  } = requireFromRepo(repoRoot, 'dist/main/profile/browser-pool-integration.js');
  const {
    WebContentsViewManager,
  } = requireFromRepo(repoRoot, 'dist/main/webcontentsview-manager.js');
  const {
    getDefaultFingerprint,
  } = requireFromRepo(repoRoot, 'dist/main/profile/presets/index.js');

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>electron pool canary</title><h1 id="ready">ready</h1>');
  });
  const address = await listen(server, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}/`;
  appendDebug(`server listening on ${address.port}`);

  const windowManager = {
    getMainWindowV3: () => null,
  };
  const viewManager = new WebContentsViewManager(windowManager);
  const profileId = `electron-pool-canary-${Date.now()}`;
  const profile = createProfile(
    profileId,
    `persist:${profileId}`,
    getDefaultFingerprint('electron-webcontents')
  );
  const profileService = createProfileService(profile);
  const manager = new BrowserPoolManager(() => profileService);

  try {
    await manager.initialize(
      createBrowserFactory(viewManager, windowManager),
      createBrowserDestroyer(viewManager),
      {
        maxBrowsers: 1,
        healthCheckInterval: 30_000,
      }
    );
    appendDebug('manager initialized');

    const firstHandle = await manager.acquire(profile.id, {
      strategy: 'fresh',
      timeout: 60_000,
      lockTimeout: 60_000,
    });
    appendDebug(`first acquired ${firstHandle.browserId}`);
    await firstHandle.browser.goto(url, { timeout: 30_000, waitUntil: 'load' });
    await firstHandle.browser.waitForSelector('#ready', { timeout: 30_000, state: 'attached' });
    const probe = await writePersistenceProbe(firstHandle.browser, url);
    await firstHandle.release();
    appendDebug('first acquire/release complete');

    const secondHandle = await manager.acquire(profile.id, {
      strategy: 'reuse',
      timeout: 60_000,
      lockTimeout: 60_000,
    });
    appendDebug(`second acquired ${secondHandle.browserId}`);
    await secondHandle.browser.goto(url, { timeout: 30_000, waitUntil: 'load' });
    await expectPersistenceProbe(secondHandle.browser, probe);
    await secondHandle.release({ destroy: true });
    appendDebug('reuse verified and destroyed');

    const thirdHandle = await manager.acquire(profile.id, {
      strategy: 'fresh',
      timeout: 60_000,
      lockTimeout: 60_000,
    });
    appendDebug(`third acquired ${thirdHandle.browserId}`);
    await thirdHandle.browser.goto(url, { timeout: 30_000, waitUntil: 'load' });
    await expectPersistenceProbe(thirdHandle.browser, probe);
    await thirdHandle.release({ destroy: true });
    appendDebug('fresh recreate verified');

    const report = {
      ok: true,
      profileId,
      partition: profile.partition,
      url,
      storageKey: probe.storageKey,
      cookieName: probe.cookieName,
    };
    const reportPath = process.env.TIANSHE_ELECTRON_CANARY_REPORT_PATH;
    if (reportPath) {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await manager.stop().catch(() => undefined);
    await viewManager.cleanup().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      appendDebug(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    appendDebug(`error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    console.error(error);
    app.quit();
    process.exitCode = 1;
  });
