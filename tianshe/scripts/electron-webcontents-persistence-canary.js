const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

app.on('window-all-closed', () => {
  // Keep the canary process alive while it recreates hidden windows for the same partition.
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

function destroyWindow(win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    win.once('closed', () => {
      clearTimeout(timer);
      resolve();
    });
    win.destroy();
  });
}

async function loadHiddenWindow(partition, url) {
  appendDebug(`creating hidden window for ${partition}`);
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(url);
  appendDebug(`loaded hidden window ${url}`);
  return win;
}

async function main() {
  appendDebug('main entered');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshe-electron-canary-'));
  app.setPath('userData', tempRoot);
  appendDebug(`userData=${tempRoot}`);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>electron persistence canary</title><h1>ready</h1>');
  });
  const address = await listen(server, '127.0.0.1');
  appendDebug(`server listening on ${address.port}`);
  const url = `http://127.0.0.1:${address.port}/`;
  const partition = `persist:electron-canary-${Date.now()}`;
  const storageKey = 'tianshe_electron_canary';
  const cookieName = 'tianshe_electron_canary';
  const value = `electron-${Date.now()}`;
  const ses = session.fromPartition(partition);
  let firstWindow = null;
  let secondWindow = null;

  try {
    firstWindow = await loadHiddenWindow(partition, url);
    appendDebug('first window ready');
    await firstWindow.webContents.executeJavaScript(
      `
        localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(value)});
        document.cookie = ${JSON.stringify(`${cookieName}=${value}; path=/`)};
        true;
      `,
      true
    );
    await ses.cookies.flushStore();
    appendDebug('first window storage written and cookies flushed');
    await destroyWindow(firstWindow);
    appendDebug('first window destroyed');
    firstWindow = null;

    secondWindow = await loadHiddenWindow(partition, url);
    appendDebug('second window ready');
    const storageValue = await secondWindow.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(storageKey)})`,
      true
    );
    const documentCookie = await secondWindow.webContents.executeJavaScript('document.cookie', true);
    const cookies = await ses.cookies.get({ url, name: cookieName });

    if (storageValue !== value) {
      throw new Error(`localStorage did not persist: expected ${value}, got ${storageValue}`);
    }
    if (!documentCookie.includes(`${cookieName}=${value}`)) {
      throw new Error(`document.cookie did not persist: ${documentCookie}`);
    }
    if (!cookies.some((cookie) => cookie.name === cookieName && cookie.value === value)) {
      throw new Error(`session cookie store did not persist ${cookieName}`);
    }
    appendDebug('persistence checks passed');

    const report = {
      ok: true,
      partition,
      url,
      storageKey,
      cookieName,
    };
    const reportPath = process.env.TIANSHE_ELECTRON_CANARY_REPORT_PATH;
    if (reportPath) {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await destroyWindow(firstWindow);
    await destroyWindow(secondWindow);
    await ses.clearStorageData().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
