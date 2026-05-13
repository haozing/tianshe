import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';
import type { SessionConfig } from '../../core/browser-pool/types';
import {
  buildCloakLaunchOptions,
  createCloakBrowserFactory,
  getCloakRuntimeDescriptor,
} from './browser-pool-integration-cloak';
import { createDefaultBrowserRuntimeProviders } from './browser-runtime-providers';

const electronState = vi.hoisted(() => ({
  userDataDir: '',
  appPath: process.cwd(),
}));

const cloakState = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  ensureBinary: vi.fn(async () => undefined),
  binaryInfo: vi.fn(() => ({
    binaryPath: '',
    installed: false,
    version: '146.0.0',
  })),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    isPackaged: false,
  },
}));

vi.mock('cloakbrowser', () => ({
  launchPersistentContext: cloakState.launchPersistentContext,
  ensureBinary: cloakState.ensureBinary,
  binaryInfo: cloakState.binaryInfo,
}));

type PageEvent = 'dialog' | 'download' | 'response';

function createSession(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id: 'cloak-test-session',
    partition: 'persist:cloak-test-session',
    runtimeId: 'chromium-cloak-playwright',
    runtimeSourceOverride: null,
    fingerprint: getDefaultFingerprint('chromium-cloak-playwright'),
    proxy: null,
    quota: 1,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}

function createMockPage() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const page = {
    goto: vi.fn(async () => undefined),
    title: vi.fn(async () => 'Cloak Test'),
    url: vi.fn(() => 'https://example.test'),
    evaluate: vi.fn(async () => []),
    screenshot: vi.fn(async () => Buffer.from('screenshot')),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    keyboard: {
      type: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
    },
    mouse: {
      click: vi.fn(async () => undefined),
      move: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined),
    },
    selectOption: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
    textContent: vi.fn(async () => null),
    getAttribute: vi.fn(async () => null),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    setViewportSize: vi.fn(async () => undefined),
    viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
    route: vi.fn(async (_pattern: string, handler: (...args: any[]) => void) => {
      listeners.set('route', [handler]);
    }),
    unroute: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isClosed: vi.fn(() => false),
    bringToFront: vi.fn(async () => undefined),
    context: vi.fn(() => context),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    }),
    emit(event: PageEvent, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    emitRoute(route: any, request: any) {
      for (const listener of listeners.get('route') ?? []) {
        listener(route, request);
      }
    },
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    cookies: vi.fn(async () => []),
    addCookies: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    setExtraHTTPHeaders: vi.fn(async () => undefined),
    setGeolocation: vi.fn(async () => undefined),
    on: vi.fn(),
  };
  return { page, context };
}

function createResponse(url: string, body = 'ok') {
  const request = {
    url: () => url,
    method: () => 'GET',
    headers: () => ({ accept: 'application/json' }),
    resourceType: () => 'xhr',
    postData: () => null,
  };
  return {
    url: () => url,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({ 'content-type': 'application/json' }),
    request: () => request,
    text: async () => body,
  };
}

describe('Cloak browser integration contract', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-cloak-test-'));
    electronState.userDataDir = tempRoot;
    electronState.appPath = tempRoot;
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('passes custom executable paths through cloakbrowser launchOptions', () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    const options = buildCloakLaunchOptions(createSession(), {
      source: { type: 'custom-path', executablePath },
      installed: true,
      executablePath,
      warnings: [],
    });

    expect(options).not.toHaveProperty('executablePath');
    expect(options).toHaveProperty('launchOptions.executablePath', executablePath);
    expect(options).toHaveProperty('launchOptions.acceptDownloads', true);
    expect(options).toHaveProperty('launchOptions.downloadsPath');
  });

  it('uses the same Cloak descriptor in providers and created browsers', async () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    fs.writeFileSync(executablePath, '');
    cloakState.binaryInfo.mockReturnValue({
      binaryPath: executablePath,
      installed: true,
      version: '146.0.0',
    });
    const { context } = createMockPage();
    cloakState.launchPersistentContext.mockResolvedValue(context);

    const providers = createDefaultBrowserRuntimeProviders({
      electronBrowserFactory: vi.fn(),
      extensionBrowserFactory: vi.fn(),
      ruyiBrowserFactory: vi.fn(),
      cloakBrowserFactory: createCloakBrowserFactory(),
    });
    const provider = providers.find((item) => item.id === 'chromium-cloak-playwright');
    expect(provider?.descriptor.capabilities['download.manage']?.supported).toBe(true);

    const created = await createCloakBrowserFactory()(createSession());

    expect(created.runtimeDescriptor).toEqual(getCloakRuntimeDescriptor());
    expect(created.browser.describeRuntime()).toEqual(provider?.descriptor);
    expect(created.browser.hasCapability('intercept.control')).toBe(true);
  });

  it('waits for future responses and stores matching network entries', async () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    fs.writeFileSync(executablePath, '');
    cloakState.binaryInfo.mockReturnValue({
      binaryPath: executablePath,
      installed: true,
      version: '146.0.0',
    });
    const { page, context } = createMockPage();
    cloakState.launchPersistentContext.mockResolvedValue(context);
    const created = await createCloakBrowserFactory()(createSession());

    const responseWait = created.browser.waitForResponse('/api/ping', 1000);
    page.emit('response', createResponse('https://example.test/api/ping', '{"pong":true}'));

    await expect(responseWait).resolves.toMatchObject({
      url: 'https://example.test/api/ping',
      status: 200,
      responseBody: '{"pong":true}',
    });
    expect(created.browser.getNetworkEntries()).toHaveLength(1);
  });

  it('returns an already-open dialog without waiting for another event', async () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    fs.writeFileSync(executablePath, '');
    cloakState.binaryInfo.mockReturnValue({
      binaryPath: executablePath,
      installed: true,
      version: '146.0.0',
    });
    const { page, context } = createMockPage();
    cloakState.launchPersistentContext.mockResolvedValue(context);
    const created = await createCloakBrowserFactory()(createSession());

    page.emit('dialog', {
      type: () => 'prompt',
      message: () => 'Name?',
      defaultValue: () => 'Ada',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    });

    await expect(created.browser.waitForDialog({ timeoutMs: 1 })).resolves.toEqual({
      type: 'prompt',
      message: 'Name?',
      defaultValue: 'Ada',
    });
  });

  it('releases paused routes when request interception is disabled', async () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    fs.writeFileSync(executablePath, '');
    cloakState.binaryInfo.mockReturnValue({
      binaryPath: executablePath,
      installed: true,
      version: '146.0.0',
    });
    const { page, context } = createMockPage();
    cloakState.launchPersistentContext.mockResolvedValue(context);
    const created = await createCloakBrowserFactory()(createSession());
    const route = {
      continue: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const request = {
      url: () => 'https://example.test/api/orders',
      method: () => 'GET',
      headers: () => ({}),
      resourceType: () => 'xhr',
      postData: () => null,
    };

    await created.browser.enableRequestInterception({
      patterns: [{ urlPattern: '/api/orders' }],
    });
    page.emitRoute(route, request);
    expect(created.browser.getInterceptedRequests()).toHaveLength(1);

    await created.browser.disableRequestInterception();

    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(created.browser.getInterceptedRequests()).toHaveLength(0);
  });

  it('saves downloads into the configured download path', async () => {
    const executablePath = path.join(tempRoot, 'cloak.exe');
    fs.writeFileSync(executablePath, '');
    cloakState.binaryInfo.mockReturnValue({
      binaryPath: executablePath,
      installed: true,
      version: '146.0.0',
    });
    const { page, context } = createMockPage();
    cloakState.launchPersistentContext.mockResolvedValue(context);
    const created = await createCloakBrowserFactory()(createSession());
    const downloadDir = path.join(tempRoot, 'downloads');
    const saveAs = vi.fn(async (targetPath: string) => {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.writeFile(targetPath, 'file');
    });

    await created.browser.setDownloadBehavior({ policy: 'allow', downloadPath: downloadDir });
    page.emit('download', {
      url: () => 'https://example.test/report.csv',
      suggestedFilename: () => 'report.csv',
      path: vi.fn(async () => path.join(tempRoot, 'tmp-download')),
      saveAs,
      failure: vi.fn(async () => null),
      cancel: vi.fn(async () => undefined),
    });

    const entry = await created.browser.waitForDownload({ timeoutMs: 1000 });

    expect(saveAs).toHaveBeenCalledWith(path.join(downloadDir, 'report.csv'));
    expect(entry).toMatchObject({
      state: 'completed',
      path: path.join(downloadDir, 'report.csv'),
    });
  });
});

