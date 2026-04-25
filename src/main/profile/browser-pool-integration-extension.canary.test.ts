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
import { createBrowserBusinessCanaryServer } from './browser-pool-integration-business-shared';
import { waitForCondition } from './browser-pool-integration-smoke-shared';

const shouldRunCanary =
  process.env.AIRPA_RUN_EXTENSION_CANARY === '1' ||
  process.env.AIRPA_RUN_EXTENSION_CANARY === 'true';
const debugCanary =
  process.env.AIRPA_DEBUG_EXTENSION_CANARY === '1' ||
  process.env.AIRPA_DEBUG_EXTENSION_CANARY === 'true';

const runCanary = shouldRunCanary ? it : it.skip;

function logCanaryStep(step: string): void {
  if (debugCanary) {
    console.log(`[extension-canary] ${step}`);
  }
}

describe('createExtensionBrowserFactory business canary', () => {
  runCanary(
    'drives a business-shaped order center flow through the extension engine',
    async () => {
      if (process.platform !== 'win32') {
        throw new Error('Extension business canary expects the bundled Windows chrome.exe runtime');
      }

      const chromePath = resolveChromeExecutablePath();
      if (!fs.existsSync(chromePath)) {
        throw new Error(`Bundled Chrome runtime not found: ${chromePath}`);
      }

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-extension-canary-'));
      const canaryServer = await createBrowserBusinessCanaryServer({
        title: 'Extension Business Canary',
      });
      const originalExtraLaunchArgs = [...AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs];
      electronState.userDataDir = path.join(tempRoot, 'user-data-root');
      AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
        0,
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
        '--start-minimized'
      );

      const factory = createExtensionBrowserFactory();
      const sessionId = `extension-canary-${Date.now()}`;
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

        closeBrowser = () => created.browser.closeInternal();
        expect(created.browser.describeRuntime()).toMatchObject({
          engine: 'extension',
        });
        expect(created.browser.hasCapability('tabs.manage')).toBe(true);
        expect(created.browser.hasCapability('dialog.basic')).toBe(true);
        expect(created.browser.hasCapability('dialog.promptText')).toBe(false);
        expect(created.browser.hasCapability('download.manage')).toBe(false);

        created.browser.startConsoleCapture({ level: 'all' });
        await created.browser.startNetworkCapture({
          clearExisting: true,
          captureBody: true,
          maxEntries: 128,
          urlFilter: '/api/orders',
        });
        await created.browser.goto(canaryServer.ordersUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        logCanaryStep('navigated to orders');
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });
        logCanaryStep('orders title visible');

        await created.browser.type('#keyword', 'alpha', { clear: true });
        await created.browser.select('#status', 'open');
        await created.browser.click('#apply-filters');
        logCanaryStep('applied filters');

        const responseEntry = await created.browser.waitForResponse('/api/orders', 30_000);
        expect(responseEntry.url).toContain('/api/orders');
        expect(responseEntry.status).toBe(200);
        await waitForCondition(async () => {
          const summary = await created.browser.getText('#orders-summary');
          return summary.includes('1 result');
        }, 10_000, 'filtered order summary');
        expect(await created.browser.getText('#detail-link-1001')).toBe('View Details');
        logCanaryStep('filtered order list verified');

        await created.browser.click('#detail-link-1001');
        logCanaryStep('detail link clicked');
        await created.browser.waitForSelector('#detail-title', {
          timeout: 30_000,
          state: 'visible',
        });
        logCanaryStep('detail title visible');
        expect(await created.browser.getText('#detail-title')).toBe('Order 1001');
        await created.browser.type('#detail-note', 'extension canary follow up', { clear: true });
        await created.browser.click('#save-note');
        await waitForCondition(async () => {
          const value = await created.browser.getText('#detail-result');
          return value === 'extension canary follow up';
        }, 10_000, 'saved detail note');
        logCanaryStep('detail note saved');

        await created.browser.goto(canaryServer.ordersUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        logCanaryStep('returned to orders');
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });
        logCanaryStep('orders title visible again');

        const detailTab = await created.browser.createTab({
          url: canaryServer.detailUrl('1003'),
          active: true,
        });
        logCanaryStep(`created detail tab ${detailTab.id}`);
        await created.browser.waitForSelector('#detail-title', {
          timeout: 30_000,
          state: 'visible',
        });
        logCanaryStep('secondary detail title visible');
        expect(await created.browser.getText('#detail-title')).toBe('Order 1003');
        await created.browser.closeTab(detailTab.id);
        logCanaryStep('secondary detail tab closed');
        await created.browser.waitForSelector('#orders-title', {
          timeout: 30_000,
          state: 'visible',
        });
        logCanaryStep('orders title visible after tab close');

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
        if (closeBrowser) {
          await closeBrowser().catch(() => undefined);
        }
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
          0,
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
          ...originalExtraLaunchArgs
        );
        await canaryServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
