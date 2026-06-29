import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcRouteRegistry } from '../ipc-route-registry';
import type { BrowserRuntimeStatus } from '../../core/browser-runtime';
import { registerBrowserRuntimeHandlers } from './browser-runtime-ipc-handler';

const { mockIpcMainHandle, loggerError, mockOpenExternal } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
  loggerError: vi.fn(),
  mockOpenExternal: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\Browsers\\cloak.exe'],
    }),
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: {
    openExternal: mockOpenExternal,
  },
}));

vi.mock('../../core/logger', () => ({
  createLogger: () => ({
    error: loggerError,
  }),
}));

const runtimeStatus: BrowserRuntimeStatus = {
  runtimeId: 'electron-webcontents',
  descriptor: {
    runtimeId: 'electron-webcontents',
    browserFamily: 'electron',
    controlProtocol: 'webcontents',
    profileMode: 'ephemeral',
    visibilityMode: 'embedded-view',
    fingerprintBackend: 'electron-stealth',
    source: { type: 'bundled' },
    capabilities: {} as BrowserRuntimeStatus['descriptor']['capabilities'],
  },
  source: { type: 'bundled' },
  resolvedRuntime: {
    runtimeId: 'electron-webcontents',
    source: { type: 'bundled' },
  },
  installed: true,
  healthy: true,
  installState: 'bundled',
  version: '35.0.0',
  executablePath: 'electron',
  errors: [],
  warnings: [],
  capabilities: {
    'snapshot.page': true,
  },
};

describe('registerBrowserRuntimeHandlers', () => {
  let handlers: Map<string, Function>;
  let manager: {
    listRuntimeStatuses: ReturnType<typeof vi.fn>;
    getRuntimeStatus: ReturnType<typeof vi.fn>;
    setSourceOverride: ReturnType<typeof vi.fn>;
    clearSourceOverride: ReturnType<typeof vi.fn>;
    installRuntime: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ipcRouteRegistry.unregisterAll();
    handlers = new Map();
    mockIpcMainHandle.mockImplementation((channel: string, fn: Function) => {
      handlers.set(channel, fn);
    });
    manager = {
      listRuntimeStatuses: vi.fn().mockResolvedValue([runtimeStatus]),
      getRuntimeStatus: vi.fn().mockResolvedValue(runtimeStatus),
      setSourceOverride: vi.fn(),
      clearSourceOverride: vi.fn(),
      installRuntime: vi.fn().mockResolvedValue(runtimeStatus),
    };
  });

  it('registers list and detail routes', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    expect(handlers.has('browser-runtime:list-statuses')).toBe(true);
    expect(handlers.has('browser-runtime:get-status')).toBe(true);

    const listResult = await handlers.get('browser-runtime:list-statuses')?.({} as never);
    const detailResult = await handlers
      .get('browser-runtime:get-status')
      ?.({} as never, 'electron-webcontents');

    expect(listResult).toEqual({
      success: true,
      data: [runtimeStatus],
    });
    expect(detailResult).toEqual({
      success: true,
      data: runtimeStatus,
    });
    expect(manager.getRuntimeStatus).toHaveBeenCalledWith('electron-webcontents');
  });

  it('rejects unsupported runtime ids before calling the manager', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    const result = await handlers
      .get('browser-runtime:get-status')
      ?.({} as never, 'legacy-engine');

    expect(result).toMatchObject({
      success: false,
      code: 'INVALID_INPUT',
    });
    expect(manager.getRuntimeStatus).not.toHaveBeenCalled();
  });

  it('uses the sender guard for runtime status routes', async () => {
    const senderGuard = vi.fn(() => {
      throw new Error('Unauthorized sender');
    });
    registerBrowserRuntimeHandlers(() => manager as never, { senderGuard });

    const event = { sender: { id: 2 } };
    const result = await handlers.get('browser-runtime:list-statuses')?.(event as never);

    expect(senderGuard).toHaveBeenCalledWith(event, 'browser-runtime:list-statuses');
    expect(result).toMatchObject({
      success: false,
      error: 'Unauthorized sender',
    });
    expect(manager.listRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('sets and clears custom runtime source overrides', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    const setResult = await handlers
      .get('browser-runtime:set-custom-path')
      ?.({} as never, 'chromium-cloak-playwright', 'C:\\Browsers\\cloak.exe');
    const clearResult = await handlers
      .get('browser-runtime:set-default-source')
      ?.({} as never, 'chromium-cloak-playwright');

    expect(setResult.success).toBe(true);
    expect(clearResult.success).toBe(true);
    expect(manager.setSourceOverride).toHaveBeenCalledWith('chromium-cloak-playwright', {
      type: 'custom-path',
      executablePath: 'C:\\Browsers\\cloak.exe',
    });
    expect(manager.clearSourceOverride).toHaveBeenCalledWith('chromium-cloak-playwright');
  });

  it('does not persist unhealthy custom runtime paths', async () => {
    const unhealthyStatus: BrowserRuntimeStatus = {
      ...runtimeStatus,
      runtimeId: 'chromium-cloak-playwright',
      source: { type: 'custom-path', executablePath: 'C:\\missing\\cloak.exe' },
      configuredSourceOverride: { type: 'custom-path', executablePath: 'C:\\missing\\cloak.exe' },
      installed: false,
      healthy: false,
      installState: 'missing',
      errors: ['Runtime executable path does not exist or is not a file.'],
    };
    manager.getRuntimeStatus.mockResolvedValueOnce(unhealthyStatus);
    registerBrowserRuntimeHandlers(() => manager as never);

    const result = await handlers
      .get('browser-runtime:set-custom-path')
      ?.({} as never, 'chromium-cloak-playwright', 'C:\\missing\\cloak.exe');

    expect(result).toEqual({
      success: true,
      data: unhealthyStatus,
    });
    expect(manager.getRuntimeStatus).toHaveBeenCalledWith('chromium-cloak-playwright', {
      type: 'custom-path',
      executablePath: 'C:\\missing\\cloak.exe',
    });
    expect(manager.setSourceOverride).not.toHaveBeenCalled();
  });

  it('rejects custom path for electron runtime', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    const result = await handlers
      .get('browser-runtime:set-custom-path')
      ?.({} as never, 'electron-webcontents', 'C:\\Browsers\\chrome.exe');

    expect(result).toMatchObject({
      success: false,
      code: 'INVALID_INPUT',
    });
    expect(manager.setSourceOverride).not.toHaveBeenCalled();
  });

  it('installs managed Cloak runtime and blocks unsupported runtimes', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    const installed = await handlers
      .get('browser-runtime:install-managed')
      ?.({} as never, 'chromium-cloak-playwright');
    const unsupported = await handlers
      .get('browser-runtime:install-managed')
      ?.({} as never, 'firefox-bidi');

    expect(installed.success).toBe(true);
    expect(manager.installRuntime).toHaveBeenCalledWith('chromium-cloak-playwright');
    expect(unsupported).toMatchObject({
      success: false,
      code: 'INVALID_INPUT',
    });
  });

  it('opens runtime download pages', async () => {
    registerBrowserRuntimeHandlers(() => manager as never);

    const result = await handlers
      .get('browser-runtime:open-download-page')
      ?.({} as never, 'firefox-bidi');

    expect(result.success).toBe(true);
    expect(result.data.url).toContain('mozilla.org');
    expect(mockOpenExternal).toHaveBeenCalledWith(expect.stringContaining('mozilla.org'));
  });
});
