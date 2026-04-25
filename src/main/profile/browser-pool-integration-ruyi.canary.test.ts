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
import { createBrowserBusinessCanaryServer } from './browser-pool-integration-business-shared';
import { waitForCondition } from './browser-pool-integration-smoke-shared';
import { resolveFirefoxExecutablePath } from './ruyi-runtime-shared';

const shouldRunCanary =
  process.env.AIRPA_RUN_RUYI_CANARY === '1' || process.env.AIRPA_RUN_RUYI_CANARY === 'true';

const runCanary = shouldRunCanary ? it : it.skip;

function assertFirefoxRuntimeAvailable(): string {
  const firefoxPath = resolveFirefoxExecutablePath();
  if (path.isAbsolute(firefoxPath) && !fs.existsSync(firefoxPath)) {
    throw new Error(
      `Firefox runtime not found: ${firefoxPath}. Install Firefox or pass --airpa-firefox-path=/path/to/firefox.`
    );
  }
  return firefoxPath;
}

describe('createRuyiBrowserFactory business canary', () => {
  runCanary(
    'drives a business-shaped order center flow through the ruyi engine',
    async () => {
      const firefoxPath = assertFirefoxRuntimeAvailable();
      expect(firefoxPath.length).toBeGreaterThan(0);

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-canary-'));
      const canaryServer = await createBrowserBusinessCanaryServer({
        title: 'Ruyi Business Canary',
      });

      electronState.userDataDir = path.join(tempRoot, 'user-data-root');

      const factory = createRuyiBrowserFactory();
      const sessionId = `ruyi-canary-${Date.now()}`;
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

        closeBrowser = () => created.browser.closeInternal();
        expect(created.browser.describeRuntime()).toMatchObject({
          engine: 'ruyi',
        });
        expect(created.browser.hasCapability('tabs.manage')).toBe(true);
        expect(created.browser.hasCapability('dialog.basic')).toBe(true);
        expect(created.browser.hasCapability('dialog.promptText')).toBe(true);
        expect(created.browser.hasCapability('download.manage')).toBe(true);

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
          downloadPath: path.join(tempRoot, 'downloads'),
        });

        await created.browser.goto(canaryServer.ordersUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });

        await created.browser.type('#keyword', 'alpha', { clear: true });
        await created.browser.select('#status', 'open');
        await created.browser.click('#apply-filters');

        const responseEntry = await created.browser.waitForResponse('/api/orders', 30_000);
        expect(responseEntry.url).toContain('/api/orders');
        expect(responseEntry.status).toBe(200);
        await waitForCondition(async () => {
          const summary = await created.browser.getText('#orders-summary');
          return summary.includes('1 result');
        }, 10_000, 'filtered order summary');
        expect(await created.browser.getText('#detail-link-1001')).toBe('View Details');

        const dialogWait = created.browser.waitForDialog({ timeoutMs: 30_000 });
        const promptClick = created.browser.click('#prompt-action');
        const dialog = await dialogWait;
        expect(dialog).toEqual(
          expect.objectContaining({
            type: 'prompt',
            message: 'Enter follow-up note',
          })
        );
        await created.browser.handleDialog({
          accept: true,
          promptText: 'ruyi priority',
        });
        await promptClick;
        await waitForCondition(async () => {
          const value = await created.browser.getText('#prompt-result');
          return value === 'ruyi priority';
        }, 10_000, 'prompt result');

        await created.browser.click('#detail-link-1001');
        await created.browser.waitForSelector('#detail-title', {
          timeout: 30_000,
          state: 'visible',
        });
        expect(await created.browser.getText('#detail-title')).toBe('Order 1001');
        await created.browser.type('#detail-note', 'ruyi canary follow up', { clear: true });
        await created.browser.click('#save-note');
        await waitForCondition(async () => {
          const value = await created.browser.getText('#detail-result');
          return value === 'ruyi canary follow up';
        }, 10_000, 'saved detail note');

        await created.browser.goto(canaryServer.ordersUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });

        const detailTab = await created.browser.createTab({
          url: canaryServer.detailUrl('1003'),
          active: true,
        });
        await created.browser.waitForSelector('#detail-title', {
          timeout: 30_000,
          state: 'visible',
        });
        expect(await created.browser.getText('#detail-title')).toBe('Order 1003');
        await created.browser.closeTab(detailTab.id);
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });

        const downloadWait = created.browser.waitForDownload({ timeoutMs: 30_000 });
        await created.browser.click('#export-orders');
        const download = await downloadWait;
        expect(download).toEqual(
          expect.objectContaining({
            suggestedFilename: 'orders.csv',
            state: 'completed',
          })
        );
        expect(download.path).toBeTruthy();
        await expect(fsp.readFile(download.path!, 'utf8')).resolves.toContain('Alpha Lamp');
        await waitForCondition(
          async () =>
            runtimeEvents.some(
              (event) =>
                event.type === 'download.completed' &&
                event.payload.suggestedFilename === 'orders.csv'
            ),
          10_000,
          'download runtime event'
        );

        await waitForCondition(
          async () =>
            created.browser
              .getConsoleMessages()
              .some((message) => message.message.includes('canary-apply-clicked')),
          10_000,
          'console capture event'
        );

        const snapshot = await created.browser.snapshot({
          includeSummary: true,
          includeConsole: true,
          includeNetwork: 'smart',
        });
        expect(snapshot.url).toContain('/orders');
        expect(snapshot.elements.length).toBeGreaterThan(0);
        expect(canaryServer.apiHits.length).toBeGreaterThan(0);
      } finally {
        try {
          closeBrowser && (await closeBrowser());
        } finally {
          unsubscribeRuntimeEvents?.();
        }
        await canaryServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
