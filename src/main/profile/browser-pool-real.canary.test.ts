import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPoolManager } from '../../core/browser-pool/pool-manager';
import type {
  BrowserFactory,
  BrowserDestroyer,
} from '../../core/browser-pool/global-pool';
import { createMockProfileServiceGetter } from '../../core/browser-pool/__tests__/test-utils';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';
import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';
import { createExtensionBrowserFactory } from './browser-pool-integration-extension';
import { createRuyiBrowserFactory } from './browser-pool-integration-ruyi';
import { createBrowserBusinessCanaryServer } from './browser-pool-integration-business-shared';
import { waitForCondition } from './browser-pool-integration-smoke-shared';
import { resolveChromeExecutablePath } from './chrome-runtime-shared';
import { resolveFirefoxExecutablePath } from './ruyi-runtime-shared';
import type { BrowserProfile } from '../../types/profile';
import type { BrowserRuntimeId } from '../../types/browser-runtime';

const electronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  userDataDir: '',
  isPackaged: false,
}));

vi.mock('electron-webcontents', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    isPackaged: false,
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
}));

type RuntimeCanaryCase = {
  id: 'extension' | 'ruyi';
  envName: string;
  runtimeId: BrowserRuntimeId;
  title: string;
  assertRuntimeAvailable: () => void;
};

const runtimeCases: RuntimeCanaryCase[] = [
  {
    id: 'extension',
    envName: 'AIRPA_RUN_EXTENSION_CANARY',
    runtimeId: 'chromium-extension-relay',
    title: 'Extension Pool Canary',
    assertRuntimeAvailable: () => {
      if (process.platform !== 'win32') {
        throw new Error('Extension pool canary expects the bundled Windows chrome.exe runtime');
      }
      const chromePath = resolveChromeExecutablePath();
      if (!fs.existsSync(chromePath)) {
        throw new Error(`Bundled Chrome runtime not found: ${chromePath}`);
      }
    },
  },
  {
    id: 'ruyi',
    envName: 'AIRPA_RUN_RUYI_CANARY',
    runtimeId: 'firefox-bidi',
    title: 'Ruyi Pool Canary',
    assertRuntimeAvailable: () => {
      const firefoxPath = resolveFirefoxExecutablePath();
      if (path.isAbsolute(firefoxPath) && !fs.existsSync(firefoxPath)) {
        throw new Error(`Firefox runtime not found: ${firefoxPath}`);
      }
    },
  },
];

function shouldRunRuntimeCanary(envName: string): boolean {
  return process.env[envName] === '1' || process.env[envName] === 'true';
}

function createProfile(runtimeCase: RuntimeCanaryCase, tempRoot: string): BrowserProfile {
  const now = new Date();
  const fingerprint = getDefaultFingerprint(runtimeCase.runtimeId);
  return {
    id: `${runtimeCase.id}-pool-canary`,
    name: runtimeCase.title,
    runtimeId: runtimeCase.runtimeId,
    description: null,
    groupId: null,
    partition: `persist:${runtimeCase.id}-pool-canary-${Date.now()}`,
    proxy: null,
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
        filePath: path.join(tempRoot, `${runtimeCase.id}.runtime-profile.txt`),
      },
    },
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

function createRealBrowserFactory(runtimeCase: RuntimeCanaryCase): BrowserFactory {
  const factory =
    runtimeCase.id === 'extension' ? createExtensionBrowserFactory() : createRuyiBrowserFactory();

  return async (session) => factory(session);
}

const destroyer: BrowserDestroyer = async (browser) => {
  await browser.closeInternal();
};

describe('BrowserPoolManager real browser canary', () => {
  for (const runtimeCase of runtimeCases) {
    const runCanary = shouldRunRuntimeCanary(runtimeCase.envName) ? it : it.skip;

    runCanary(
      `acquires, renews, releases, and recreates a real ${runtimeCase.runtimeId} browser`,
      async () => {
        runtimeCase.assertRuntimeAvailable();

        const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `airpa-${runtimeCase.id}-pool-canary-`));
        const canaryServer = await createBrowserBusinessCanaryServer({
          title: runtimeCase.title,
        });
        const originalExtraLaunchArgs = [...AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs];
        electronState.userDataDir = path.join(tempRoot, 'user-data-root');

        if (runtimeCase.id === 'extension') {
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
            0,
            AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
            '--start-minimized'
          );
        }

        const profile = createProfile(runtimeCase, tempRoot);
        const mockServiceGetter = createMockProfileServiceGetter({ profiles: [profile] });
        const manager = new BrowserPoolManager(mockServiceGetter.getProfileService);

        try {
          await manager.initialize(createRealBrowserFactory(runtimeCase), destroyer, {
            maxBrowsers: 1,
            healthCheckInterval: 30_000,
          });

          const firstHandle = await manager.acquire(profile.id, {
            strategy: 'fresh',
            timeout: 120_000,
            lockTimeout: 60_000,
          });
          expect(firstHandle.sessionId).toBe(profile.id);
          expect(firstHandle.runtimeId).toBe(runtimeCase.runtimeId);

          await firstHandle.browser.goto(canaryServer.ordersUrl, {
            timeout: 30_000,
            waitUntil: 'load',
          });
          await firstHandle.browser.waitForSelector('#orders-title', {
            timeout: 30_000,
            state: 'visible',
          });
          expect(await firstHandle.browser.getText('#orders-title')).toBe(runtimeCase.title);
          expect(await firstHandle.renew(30_000)).toBe(true);

          const releaseResult = await firstHandle.release();
          expect(releaseResult).toMatchObject({
            sessionId: profile.id,
            remainingBrowserCount: 1,
            destroyed: false,
          });

          const secondHandle = await manager.acquire(profile.id, {
            strategy: 'reuse',
            timeout: 120_000,
            lockTimeout: 60_000,
          });
          expect(secondHandle.browserId).toBe(firstHandle.browserId);
          await secondHandle.browser.type('#keyword', 'gamma', { clear: true });
          await secondHandle.browser.click('#apply-filters');
          await waitForCondition(async () => {
            const summary = await secondHandle.browser.getText('#orders-summary');
            return summary.includes('1 result');
          }, 10_000, 'reused browser filtered order summary');

          const destroyedRelease = await secondHandle.release({ destroy: true });
          expect(destroyedRelease).toMatchObject({
            sessionId: profile.id,
            remainingBrowserCount: 0,
            destroyed: true,
          });

          const thirdHandle = await manager.acquire(profile.id, {
            strategy: 'fresh',
            timeout: 120_000,
            lockTimeout: 60_000,
          });
          expect(thirdHandle.browserId).not.toBe(firstHandle.browserId);
          await thirdHandle.release({ destroy: true });

          expect(await manager.destroyProfileBrowsers(profile.id)).toBe(0);
        } finally {
          await manager.stop().catch(() => undefined);
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
            0,
            AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
            ...originalExtraLaunchArgs
          );
          await canaryServer.close().catch(() => undefined);
          await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      180_000
    );
  }
});
