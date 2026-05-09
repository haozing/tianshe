#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'docs', 'assets', 'screenshots');

const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function waitForJson(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForPage(cdpPort, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, 5000).catch(() => []);
    const page = latest.find(
      (item) =>
        item.type === 'page' &&
        item.webSocketDebuggerUrl &&
        typeof item.url === 'string' &&
        item.url.includes('index.html')
    );
    if (page) {
      return page;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for renderer page: ${JSON.stringify(latest)}`);
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out')), 15000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      },
      { once: true }
    );
  });
  return ws;
}

async function cdpCall(ws, method, params = {}, timeoutMs = 60000) {
  const id = ++cdpCall.nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP call timed out: ${method}`));
    }, timeoutMs);

    function onMessage(event) {
      const message = JSON.parse(event.data.toString());
      if (message.id !== id) {
        return;
      }
      cleanup();
      if (message.error) {
        reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
    }

    ws.addEventListener('message', onMessage);
  });
}
cdpCall.nextId = 0;

async function waitForText(ws, text, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdpCall(
      ws,
      'Runtime.evaluate',
      {
        expression: `document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
        returnByValue: true,
      },
      5000
    );
    if (result.result.value) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function clickText(ws, text, expectedText) {
  const result = await cdpCall(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const text = ${JSON.stringify(text)};
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'));
      const element = candidates.find((el) => (el.innerText || el.textContent || '').trim().includes(text));
      if (!element) {
        return {
          clicked: false,
          text,
          candidates: candidates
            .slice(0, 80)
            .map((el) => (el.innerText || el.textContent || '').trim())
            .filter(Boolean)
        };
      }
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (element.innerText || element.textContent || '').trim() };
    })()`,
    returnByValue: true,
  });

  if (!result.result.value.clicked) {
    throw new Error(`Could not click ${text}: ${JSON.stringify(result.result.value)}`);
  }
  await waitForText(ws, expectedText || text);
  await sleep(1000);
}

async function capture(ws, name) {
  await cdpCall(ws, 'Page.bringToFront').catch(() => undefined);
  await cdpCall(ws, 'Runtime.evaluate', {
    expression:
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    awaitPromise: true,
    returnByValue: true,
  });

  const state = await cdpCall(ws, 'Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      readyState: document.readyState,
      bodyLength: document.body?.innerText?.length || 0,
      bodySample: document.body?.innerText?.slice(0, 800) || '',
      hasError: document.body?.innerText?.includes('应用出现错误') || false
    }))()`,
    returnByValue: true,
  });
  if (state.result.value.hasError) {
    throw new Error(`ErrorBoundary visible before screenshot ${name}`);
  }

  const screenshot = await cdpCall(
    ws,
    'Page.captureScreenshot',
    {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    },
    60000
  );
  const output = path.join(outDir, `${name}.png`);
  fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  return { output, state: state.result.value };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const exe = path.join(repoRoot, 'release-build', 'win-unpacked', 'tiansheai-open.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`Missing packaged exe: ${exe}. Run npm run package:open:dir first.`);
  }

  const cdpPort = await getPort();
  const userData = path.join(
    process.env.TEMP || path.join(repoRoot, 'tmp'),
    `tianshe-marketing-screens-${Date.now()}`
  );
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(exe, [`--airpa-user-data-dir=${userData}`, `--airpa-e2e-cdp-port=${cdpPort}`], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let ws;
  try {
    const page = await waitForPage(cdpPort);
    ws = await openWebSocket(page.webSocketDebuggerUrl);
    await cdpCall(ws, 'Runtime.enable');
    await cdpCall(ws, 'Page.enable');
    await cdpCall(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => undefined);

    await waitForText(ws, 'TiansheAI');
    await sleep(1500);

    const outputs = [];
    outputs.push(await capture(ws, 'account-center'));
    await clickText(ws, '数据表', '请选择一个数据表');
    outputs.push(await capture(ws, 'datasets'));
    await clickText(ws, '插件市场', '插件市场');
    outputs.push(await capture(ws, 'plugin-market'));
    await clickText(ws, '设置', '系统设置');
    outputs.push(await capture(ws, 'settings'));

    console.log(
      JSON.stringify(
        {
          cdpPort,
          userData,
          outputs: outputs.map((item) => item.output),
          states: outputs.map((item) => item.state),
          logs: logs.join('').slice(-1200),
        },
        null,
        2
      )
    );
  } finally {
    if (ws) {
      ws.close();
    }
    child.kill('SIGTERM');
    await sleep(1500);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
