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
import type { PooledBrowserController } from '../../core/browser-pool/types';
import { createMockProfileServiceGetter } from '../../core/browser-pool/__tests__/test-utils';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';
import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';
import { createExtensionBrowserFactory } from './browser-pool-integration-extension';
import { createRuyiBrowserFactory } from './browser-pool-integration-ruyi';
import {
  createCloakBrowserFactory,
  resolveCloakRuntimeInfo,
} from './browser-pool-integration-cloak';
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
  id: 'extension' | 'ruyi' | 'cloak';
  envName: string;
  runtimeId: BrowserRuntimeId;
  title: string;
  assertRuntimeAvailable: () => void | Promise<void>;
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
  {
    id: 'cloak',
    envName: 'AIRPA_RUN_CLOAK_CANARY',
    runtimeId: 'chromium-cloak-playwright',
    title: 'Cloak Pool Canary',
    assertRuntimeAvailable: async () => {
      const info = await resolveCloakRuntimeInfo(null);
      if (!info.installed || !info.executablePath) {
        throw new Error(info.error ?? 'CloakBrowser runtime is not installed');
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
    runtimeCase.id === 'extension'
      ? createExtensionBrowserFactory()
      : runtimeCase.id === 'ruyi'
        ? createRuyiBrowserFactory()
        : createCloakBrowserFactory();

  return async (session) => factory(session);
}

const destroyer: BrowserDestroyer = async (browser) => {
  await browser.closeInternal();
};

async function writeProfilePersistenceProbe(
  browser: PooledBrowserController,
  runtimeCase: RuntimeCanaryCase
): Promise<{ cookieName: string; value: string; storageKey: string; url: string }> {
  const cookieName = 'tianshe_profile_canary';
  const storageKey = 'tianshe_profile_canary';
  const value = `${runtimeCase.id}-${Date.now()}`;
  const url = await browser.getCurrentUrl();
  await browser.setCookie({
    name: cookieName,
    value,
    url,
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  });
  await browser.evaluateWithArgs(
    (key, nextValue) => {
      window.localStorage.setItem(String(key), String(nextValue));
      return true;
    },
    storageKey,
    value
  );
  await expectProfilePersistenceProbe(browser, { cookieName, value, storageKey });
  return { cookieName, value, storageKey, url };
}

async function expectProfilePersistenceProbe(
  browser: PooledBrowserController,
  probe: { cookieName: string; value: string; storageKey: string }
): Promise<void> {
  let cookies = await browser.getCookies({ name: probe.cookieName });
  let storageValue = await browser.evaluateWithArgs(
    (key) => window.localStorage.getItem(String(key)),
    probe.storageKey
  );
  let currentUrl = await browser.getCurrentUrl().catch(() => 'unavailable');
  try {
    await waitForCondition(async () => {
      currentUrl = await browser.getCurrentUrl().catch(() => currentUrl);
      cookies = await browser.getCookies({ name: probe.cookieName });
      storageValue = await browser.evaluateWithArgs(
        (key) => window.localStorage.getItem(String(key)),
        probe.storageKey
      );
      return (
        cookies.some(
          (cookie) => cookie.name === probe.cookieName && cookie.value === probe.value
        ) && storageValue === probe.value
      );
    }, 30_000, 'profile cookie/localStorage persistence probe');
  } catch (error) {
    throw new Error(
      `${
        error instanceof Error ? error.message : String(error)
      }: currentUrl=${JSON.stringify(currentUrl)} storageKey=${JSON.stringify(
        probe.storageKey
      )} expectedValue=${JSON.stringify(probe.value)} cookies=${JSON.stringify(
        cookies
      )} storageValue=${JSON.stringify(storageValue)}`
    );
  }
  expect({
    cookieMatched: cookies.some(
      (cookie) => cookie.name === probe.cookieName && cookie.value === probe.value
    ),
    cookies,
    storageValue,
  }).toMatchObject({
    cookieMatched: true,
    storageValue: probe.value,
  });
}

async function expectCloakFingerprintProjection(
  browser: PooledBrowserController,
  profile: BrowserProfile
): Promise<void> {
  const identity = await browser.evaluateWithArgs(() => ({
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory:
      typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
        ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
    },
    webgl: (() => {
      const canvas = document.createElement('canvas');
      const gl = (
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl')
      ) as WebGLRenderingContext | null;
      if (!gl) return null;
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    })(),
    canvasProbe: (() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#123456';
      ctx.fillText('tianshe-cloak-canary', 4, 4);
      return canvas.toDataURL().slice(0, 32);
    })(),
  }));
  const expectedUserAgent = profile.fingerprint.identity.hardware?.userAgent;
  const expectedLanguage = profile.fingerprint.identity.region?.primaryLanguage;
  const expectedPlatform = profile.fingerprint.identity.hardware?.platform;
  const expectedWidth = profile.fingerprint.identity.display?.width;
  const expectedHeight = profile.fingerprint.identity.display?.height;

  if (expectedUserAgent) {
    expect(identity.userAgent).toBe(expectedUserAgent);
  }
  if (expectedLanguage) {
    expect(identity.language.toLowerCase()).toContain(expectedLanguage.toLowerCase().slice(0, 2));
  }
  if (expectedPlatform?.toLowerCase().includes('win')) {
    expect(identity.platform.toLowerCase()).toContain('win');
  }
  expect(identity.hardwareConcurrency).toBeGreaterThan(0);
  if (identity.deviceMemory !== null) {
    expect(identity.deviceMemory).toBeGreaterThan(0);
  }
  expect(identity.timezone).toBe('Asia/Hong_Kong');
  if (expectedWidth && expectedHeight) {
    expect(identity.viewport).toMatchObject({
      width: expectedWidth,
      height: expectedHeight,
    });
  }
  expect(identity.screen.width).toBeGreaterThan(0);
  expect(identity.screen.height).toBeGreaterThan(0);
  expect(identity.screen.availWidth).toBeGreaterThan(0);
  expect(identity.screen.availHeight).toBeGreaterThan(0);
  expect(identity.screen.colorDepth).toBeGreaterThan(0);
  expect(identity.screen.pixelDepth).toBeGreaterThan(0);
  expect(identity.webgl).toMatchObject({
    vendor: expect.any(String),
    renderer: expect.any(String),
    version: expect.any(String),
  });
  expect(identity.canvasProbe).toMatch(/^data:image\/png/);
}

describe('BrowserPoolManager real browser canary', () => {
  for (const runtimeCase of runtimeCases) {
    const runCanary = shouldRunRuntimeCanary(runtimeCase.envName) ? it : it.skip;

    runCanary(
      `acquires, renews, releases, and recreates a real ${runtimeCase.runtimeId} browser`,
      async () => {
        await runtimeCase.assertRuntimeAvailable();

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
          if (runtimeCase.id === 'cloak') {
            await expectCloakFingerprintProjection(firstHandle.browser, profile);
          }
          expect(await firstHandle.renew(30_000)).toBe(true);
          const persistenceProbe = await writeProfilePersistenceProbe(
            firstHandle.browser,
            runtimeCase
          );

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
          await secondHandle.browser.goto(canaryServer.ordersUrl, {
            timeout: 30_000,
            waitUntil: 'load',
          });
          await expectProfilePersistenceProbe(secondHandle.browser, persistenceProbe);
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
          await thirdHandle.browser.goto(canaryServer.ordersUrl, {
            timeout: 30_000,
            waitUntil: 'load',
          });
          await expectProfilePersistenceProbe(thirdHandle.browser, persistenceProbe);
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
