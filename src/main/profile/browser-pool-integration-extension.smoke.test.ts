import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';

const electronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    isPackaged: false,
  },
}));

import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';
import { createExtensionBrowserFactory } from './browser-pool-integration-extension';
import { resolveChromeExecutablePath } from './chrome-runtime-shared';
import {
  createBrowserEngineSmokeServer,
  sleep,
  waitForCondition,
} from './browser-pool-integration-smoke-shared';

const shouldRunSmoke =
  process.env.AIRPA_RUN_EXTENSION_SMOKE === '1' ||
  process.env.AIRPA_RUN_EXTENSION_SMOKE === 'true';

const runSmoke = shouldRunSmoke ? it : it.skip;

describe('createExtensionBrowserFactory smoke', () => {
  runSmoke(
    'launches bundled Chrome and drives a basic page flow through the extension engine',
    async () => {
      if (process.platform !== 'win32') {
        throw new Error('Extension smoke test currently expects the bundled Windows chrome.exe runtime');
      }

      const chromePath = resolveChromeExecutablePath();
      if (!fs.existsSync(chromePath)) {
        throw new Error(`Bundled Chrome runtime not found: ${chromePath}`);
      }

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-extension-smoke-'));
      const smokeServer = await createBrowserEngineSmokeServer({
        title: 'Extension Smoke',
        pingMessage: 'pong from extension engine',
      });
      const originalExtraLaunchArgs = [...AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs];
      electronState.userDataDir = path.join(tempRoot, 'user-data-root');
      AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
        0,
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
        '--start-minimized'
      );

      const factory = createExtensionBrowserFactory();
      const sessionId = `extension-smoke-${Date.now()}`;
      const fingerprint = getDefaultFingerprint();
      let closeBrowser: (() => Promise<void>) | null = null;

      try {
        const created = await factory({
          id: sessionId,
          partition: `persist:${sessionId}`,
          engine: 'extension',
          fingerprint: {
            ...fingerprint,
            identity: {
              ...fingerprint.identity,
              region: {
                ...fingerprint.identity.region,
                timezone: 'Asia/Hong_Kong',
              },
            },
            source: {
              mode: 'generated',
              fileFormat: 'txt',
            },
          },
          proxy: null,
          quota: 1,
          idleTimeoutMs: 60_000,
          lockTimeoutMs: 60_000,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        });

        expect(created.engine).toBe('extension');
        closeBrowser = () => created.browser.closeInternal();
        expect(created.browser.describeRuntime()).toMatchObject({
          engine: 'extension',
        });
        expect(created.browser.hasCapability('cookies.filter')).toBe(true);
        expect(created.browser.hasCapability('network.capture')).toBe(true);
        expect(created.browser.hasCapability('network.responseBody')).toBe(true);
        expect(created.browser.hasCapability('window.showHide')).toBe(true);
        expect(created.browser.hasCapability('input.native')).toBe(true);
        expect(created.browser.hasCapability('text.ocr')).toBe(true);
        expect(created.browser.hasCapability('screenshot.detailed')).toBe(true);
        expect(created.browser.hasCapability('dialog.basic')).toBe(true);
        expect(created.browser.hasCapability('dialog.promptText')).toBe(false);
        expect(created.browser.hasCapability('intercept.observe')).toBe(true);
        expect(created.browser.hasCapability('intercept.control')).toBe(true);

        created.browser.startConsoleCapture({ level: 'all' });
        const networkIdleStartedAt = Date.now();
        await created.browser.goto(smokeServer.networkIdleUrl, {
          timeout: 30_000,
          waitUntil: 'networkidle0',
        });
        expect(Date.now() - networkIdleStartedAt).toBeGreaterThanOrEqual(900);
        expect(await created.browser.getText('#network-idle-result')).toContain('slow response');

        await created.browser.startNetworkCapture({
          clearExisting: true,
          captureBody: true,
          maxEntries: 128,
          urlFilter: '/api/ping',
        });

        await created.browser.goto(smokeServer.baseUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await created.browser.waitForSelector('#title', {
          timeout: 30_000,
          state: 'visible',
        });

        expect(await created.browser.title()).toBe('Extension Smoke');
        expect(await created.browser.getText('#title')).toBe('Extension Smoke');

        await created.browser.type('#name', '', { clear: true });
        await created.browser.click('#name');
        const nativeTypeStartedAt = Date.now();
        await created.browser.native.type('extension engine smoke', { delay: 60 });
        expect(Date.now() - nativeTypeStartedAt).toBeGreaterThanOrEqual(900);
        await waitForCondition(async () => {
          const value = await created.browser.evaluate<string>(
            "document.querySelector('#name').value"
          );
          return value === 'extension engine smoke';
        }, 10_000, 'typed input value');

        await created.browser.select('#choice', 'beta');
        expect(
          await created.browser.evaluate<string>("document.querySelector('#choice').value")
        ).toBe('beta');

        await created.browser.click('#fetch');

        const responseEntry = await created.browser.waitForResponse('/api/ping', 30_000);
        expect(responseEntry.url).toContain('/api/ping');
        expect(responseEntry.status).toBe(200);
        expect(responseEntry.responseBody).toContain('pong from extension engine');
        expect(created.browser.getNetworkEntries().every((entry) => entry.url.includes('/api/ping'))).toBe(
          true
        );
        expect(
          created.browser
            .getNetworkEntries()
            .every((entry) => typeof entry.responseBody === 'string' && entry.responseBody.includes('pong from extension engine'))
        ).toBe(true);

        await waitForCondition(async () => {
          const text = await created.browser.getText('#result');
          return text.includes('pong from extension engine');
        }, 10_000, 'fetch result text');

        const alertWait = created.browser.waitForDialog({ timeoutMs: 30_000 });
        const alertClick = created.browser.click('#alert');
        const alertDialog = await alertWait;
        expect(alertDialog).toEqual(
          expect.objectContaining({
            type: 'alert',
            message: 'Alert smoke value',
          })
        );
        await created.browser.handleDialog({
          accept: true,
        });
        await alertClick;
        await waitForCondition(async () => {
          const text = await created.browser.getText('#prompt-result');
          return text === 'alert closed';
        }, 10_000, 'alert close result text');

        await waitForCondition(
          async () =>
            created.browser
              .getConsoleMessages()
              .some((message) => message.message.includes('smoke-button-clicked')),
          10_000,
          'console capture event'
        );

        const screenshot = await created.browser.screenshotDetailed({
          captureMode: 'viewport',
          format: 'png',
        });
        expect(screenshot.mimeType).toBe('image/png');
        expect(screenshot.data.length).toBeGreaterThan(500);

        const snapshot = await created.browser.snapshot({
          includeSummary: true,
          includeConsole: true,
          includeNetwork: 'smart',
        });
        expect(snapshot.url).toContain(smokeServer.baseUrl);
        expect(snapshot.elements.length).toBeGreaterThan(0);
        expect(snapshot.networkSummary?.total).toBeGreaterThan(0);
        expect(snapshot.console?.some((message) => message.message.includes('smoke-button-clicked'))).toBe(
          true
        );

        expect(smokeServer.apiHits.length).toBeGreaterThan(0);

        const dataPageHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Extension Data Smoke</title>
  </head>
  <body>
    <h1 id="data-title">Extension Data Smoke</h1>
    <input id="data-input" value="" />
    <button id="data-go" onclick="document.getElementById('data-result').textContent = document.getElementById('data-input').value || 'empty'">Apply</button>
    <div id="data-result">idle</div>
    <button id="text-go" onclick="document.getElementById('text-result').textContent = 'text click works'">Apply Text Target</button>
    <div id="text-result">idle</div>
    <div id="press-result">idle</div>
    <script>
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          document.getElementById('press-result').textContent = 'enter works';
        }
      });
    </script>
  </body>
</html>`;
        const dataUrl = `data:text/html,${encodeURIComponent(dataPageHtml)}`;
        await created.browser.goto(dataUrl, {
          timeout: 30_000,
          waitUntil: 'domcontentloaded',
        });
        const dataCurrentUrl = await created.browser.getCurrentUrl();
        expect(dataCurrentUrl.startsWith('data:text/html,')).toBe(true);
        expect(await created.browser.title()).toBe('Extension Data Smoke');
        await created.browser.waitForSelector('#data-title', {
          timeout: 30_000,
          state: 'visible',
        });
        expect(await created.browser.getText('#data-title')).toBe('Extension Data Smoke');
        await created.browser.type('#data-input', 'data page works', { clear: true });
        await created.browser.click('#data-go');
        await waitForCondition(async () => {
          const text = await created.browser.getText('#data-result');
          return text === 'data page works';
        }, 10_000, 'data url result text');
        const clickTextResult = await created.browser.clickText('Apply Text Target', {
          strategy: 'dom',
          timeoutMs: 5_000,
        });
        expect(clickTextResult.matchSource).toBe('dom');
        expect(['dom-click', 'dom-anchor-assign', 'native-click']).toContain(clickTextResult.clickMethod);
        await waitForCondition(async () => {
          const text = await created.browser.getText('#text-result');
          return text === 'text click works';
        }, 10_000, 'clickText result text');
        await created.browser.native.keyPress('Enter');
        await waitForCondition(async () => {
          const text = await created.browser.getText('#press-result');
          return text === 'enter works';
        }, 10_000, 'native keyPress result text');
        const dataSnapshot = await created.browser.snapshot({
          includeSummary: true,
        });
        expect(dataSnapshot.url.startsWith('data:text/html,')).toBe(true);
        expect(dataSnapshot.elements.length).toBeGreaterThan(0);
        expect(
          dataSnapshot.elements.some(
            (element) =>
              element.preferredSelector === '#data-input' ||
              element.attributes?.id === 'data-input'
          )
        ).toBe(true);

        await created.browser.hide();
        await sleep(300);
        expect(typeof created.browser.textExists).toBe('function');
        const hiddenOcrExists = await created.browser.textExists!('Extension Data Smoke', {
          strategy: 'ocr',
          timeoutMs: 15_000,
        });
        expect(hiddenOcrExists).toBe(true);
        await created.browser.show();
      } finally {
        if (closeBrowser) {
          await closeBrowser().catch(() => undefined);
        }
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
          0,
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
          ...originalExtraLaunchArgs
        );
        await smokeServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
