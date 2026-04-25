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

import { createRuyiBrowserFactory } from './browser-pool-integration-ruyi';
import {
  createBrowserEngineSmokeServer,
  sleep,
  waitForCondition,
} from './browser-pool-integration-smoke-shared';
import { resolveFirefoxExecutablePath } from './ruyi-runtime-shared';

const shouldRunSmoke =
  process.env.AIRPA_RUN_RUYI_SMOKE === '1' || process.env.AIRPA_RUN_RUYI_SMOKE === 'true';

const runSmoke = shouldRunSmoke ? it : it.skip;

function assertFirefoxRuntimeAvailable(): string {
  const firefoxPath = resolveFirefoxExecutablePath();
  if (path.isAbsolute(firefoxPath) && !fs.existsSync(firefoxPath)) {
    throw new Error(
      `Firefox runtime not found: ${firefoxPath}. Install Firefox or pass --airpa-firefox-path=/path/to/firefox.`
    );
  }
  return firefoxPath;
}

describe('createRuyiBrowserFactory smoke', () => {
  runSmoke(
    'launches Firefox and drives dialog, tabs, and interception through the ruyi engine',
    async () => {
      const firefoxPath = assertFirefoxRuntimeAvailable();
      expect(firefoxPath.length).toBeGreaterThan(0);

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-smoke-'));
      const smokeServer = await createBrowserEngineSmokeServer({
        title: 'Ruyi Smoke',
        pingMessage: 'pong from ruyi engine',
      });

      electronState.userDataDir = path.join(tempRoot, 'user-data-root');

      const factory = createRuyiBrowserFactory();
      const sessionId = `ruyi-smoke-${Date.now()}`;
      const fingerprint = getDefaultFingerprint('ruyi');
      let closeBrowser: (() => Promise<void>) | null = null;
      let unsubscribeRuntimeEvents: (() => void) | null = null;

      try {
        const created = await factory({
          id: sessionId,
          partition: `persist:${sessionId}`,
          engine: 'ruyi',
          fingerprint: {
            ...fingerprint,
            identity: {
              ...fingerprint.identity,
              region: {
                ...fingerprint.identity.region,
                timezone: 'Asia/Hong_Kong',
              },
              hardware: {
                ...fingerprint.identity.hardware,
                browserFamily: 'firefox',
                browserVersion: '136.0',
                userAgent:
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
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

        expect(created.engine).toBe('ruyi');
        closeBrowser = () => created.browser.closeInternal();
        expect(created.browser.describeRuntime()).toMatchObject({
          engine: 'ruyi',
        });
        expect(created.browser.hasCapability('network.capture')).toBe(true);
        expect(created.browser.hasCapability('network.responseBody')).toBe(false);
        expect(created.browser.hasCapability('console.capture')).toBe(true);
        expect(created.browser.hasCapability('dialog.basic')).toBe(true);
        expect(created.browser.hasCapability('dialog.promptText')).toBe(true);
        expect(created.browser.hasCapability('tabs.manage')).toBe(true);
        expect(created.browser.hasCapability('intercept.observe')).toBe(true);
        expect(created.browser.hasCapability('intercept.control')).toBe(true);
        expect(created.browser.hasCapability('input.touch')).toBe(true);
        expect(created.browser.hasCapability('events.runtime')).toBe(true);
        expect(created.browser.hasCapability('download.manage')).toBe(true);
        expect(created.browser.hasCapability('storage.dom')).toBe(true);
        expect(created.browser.hasCapability('pdf.print')).toBe(true);
        expect(created.browser.hasCapability('screenshot.detailed')).toBe(true);

        await created.browser.show();
        await sleep(800);
        const runtimeEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
        unsubscribeRuntimeEvents = created.browser.onRuntimeEvent((event) => {
          runtimeEvents.push({
            type: event.type,
            payload: event.payload as Record<string, unknown>,
          });
        });
        created.browser.startConsoleCapture({ level: 'all' });
        await created.browser.startNetworkCapture({
          clearExisting: true,
          maxEntries: 128,
        });
        await created.browser.setDownloadBehavior({
          policy: 'allow',
          downloadPath: path.join(tempRoot, 'collected-downloads'),
        });

        await created.browser.goto(smokeServer.baseUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await created.browser.waitForSelector('#title', {
          timeout: 30_000,
          state: 'visible',
        });

        expect(await created.browser.title()).toBe('Ruyi Smoke');
        expect(await created.browser.getText('#title')).toBe('Ruyi Smoke');
        const pdf = await created.browser.savePdf({
          printBackground: true,
        });
        expect(pdf.data.length).toBeGreaterThan(0);
        expect(Buffer.from(pdf.data, 'base64').subarray(0, 4).toString('utf8')).toBe('%PDF');
        const downloadWait = created.browser.waitForDownload({ timeoutMs: 30_000 });
        await created.browser.click('#download');
        const download = await downloadWait;
        expect(download).toEqual(
          expect.objectContaining({
            suggestedFilename: 'report.csv',
            state: 'completed',
          })
        );
        expect(download.path).toBeTruthy();
        await expect(fsp.readFile(download.path!, 'utf8')).resolves.toContain('airpa');
        await waitForCondition(
          async () =>
            runtimeEvents.some(
              (event) =>
                event.type === 'download.started' &&
                event.payload.suggestedFilename === 'report.csv' &&
                (event.payload.source === 'native' || event.payload.source === 'filesystem')
            ) &&
            runtimeEvents.some(
              (event) =>
                event.type === 'download.completed' &&
                event.payload.state === 'completed' &&
                (event.payload.source === 'native' || event.payload.source === 'filesystem')
            ),
          10_000,
          'download runtime events'
        );
        await created.browser.setStorageItem('local', 'smoke-key', 'smoke-value');
        expect(await created.browser.getStorageItem('local', 'smoke-key')).toBe('smoke-value');
        await created.browser.removeStorageItem('local', 'smoke-key');
        expect(await created.browser.getStorageItem('local', 'smoke-key')).toBeNull();

        await created.browser.type('#name', '', { clear: true });
        await created.browser.click('#name');
        await sleep(300);
        await created.browser.native.type('ruyi engine smoke', { delay: 40 });
        await waitForCondition(async () => {
          const value = await created.browser.evaluate<string>(
            "document.querySelector('#name').value"
          );
          return value === 'ruyi engine smoke';
        }, 10_000, 'typed input value');

        await created.browser.select('#choice', 'beta');
        expect(
          await created.browser.evaluate<string>("document.querySelector('#choice').value")
        ).toBe('beta');

        await created.browser.enableRequestInterception({
          patterns: [
            {
              urlPattern: '/api/ping',
              methods: ['GET'],
            },
          ],
        });
        await created.browser.click('#fetch');
        const intercepted = await created.browser.waitForInterceptedRequest({
          timeoutMs: 30_000,
          urlPattern: '/api/ping',
          method: 'GET',
        });
        expect(intercepted.url).toContain('/api/ping');
        expect(intercepted.isBlocked).toBe(true);
        await created.browser.continueRequest(intercepted.id);

        const responseEntry = await created.browser.waitForResponse('/api/ping', 30_000);
        expect(responseEntry.url).toContain('/api/ping');
        expect(responseEntry.status).toBe(200);
        expect(created.browser.getNetworkEntries({ urlPattern: '/api/ping' }).length).toBeGreaterThan(0);
        await created.browser.disableRequestInterception();

        await waitForCondition(async () => {
          const text = await created.browser.getText('#result');
          return text.includes('pong from ruyi engine');
        }, 10_000, 'fetch result text');

        await waitForCondition(
          async () =>
            created.browser
              .getConsoleMessages()
              .some((message) => message.message.includes('smoke-button-clicked')),
          10_000,
          'console capture event'
        );

        const dialogWait = created.browser.waitForDialog({ timeoutMs: 30_000 });
        const promptClick = created.browser.click('#prompt');
        const dialog = await dialogWait;
        expect(dialog).toEqual(
          expect.objectContaining({
            type: 'prompt',
            message: 'Enter smoke value',
          })
        );
        await created.browser.handleDialog({
          accept: true,
          promptText: 'ruyi prompt works',
        });
        await promptClick;
        await waitForCondition(async () => {
          const text = await created.browser.getText('#prompt-result');
          return text === 'ruyi prompt works';
        }, 10_000, 'prompt result text');

        const initialTabs = await created.browser.listTabs();
        expect(initialTabs.length).toBeGreaterThan(0);

        const dataPageHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Ruyi Data Smoke</title>
  </head>
  <body>
    <h1 id="data-title">Ruyi Data Smoke</h1>
    <input id="data-input" value="" />
    <button id="data-go" onclick="document.getElementById('data-result').textContent = document.getElementById('data-input').value || 'empty'">Apply</button>
    <div id="data-result">idle</div>
  </body>
</html>`;
        const dataUrl = `data:text/html,${encodeURIComponent(dataPageHtml)}`;
        const createdTab = await created.browser.createTab({
          url: dataUrl,
          active: true,
        });
        expect(createdTab.url.startsWith('data:text/html,')).toBe(true);
        await created.browser.waitForSelector('#data-title', {
          timeout: 30_000,
          state: 'visible',
        });
        expect(await created.browser.title()).toBe('Ruyi Data Smoke');
        await created.browser.type('#data-input', 'tab works', { clear: true });
        await created.browser.click('#data-go');
        await waitForCondition(async () => {
          const text = await created.browser.getText('#data-result');
          return text === 'tab works';
        }, 10_000, 'tab result text');
        expect((await created.browser.listTabs()).some((tab) => tab.id === createdTab.id)).toBe(true);
        await created.browser.closeTab(createdTab.id);
        await waitForCondition(
          async () => !(await created.browser.listTabs()).some((tab) => tab.id === createdTab.id),
          10_000,
          'closed tab disappearance'
        );
        await created.browser.waitForSelector('#title', {
          timeout: 30_000,
          state: 'visible',
        });

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
      } finally {
        try {
          closeBrowser && (await closeBrowser());
        } finally {
          unsubscribeRuntimeEvents?.();
          unsubscribeRuntimeEvents = null;
        }
        closeBrowser = null;
        await smokeServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
