import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import { registerJSPluginUIExtensionRoutes } from './ui-extension-routes';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

function getIpcHandler(channel: string) {
  const call = (ipcMain.handle as any).mock.calls.find((entry: any[]) => entry[0] === channel);
  if (!call) {
    throw new Error(`IPC handler not registered: ${channel}`);
  }
  return call[1] as (...args: any[]) => Promise<any>;
}

function registerRoutes(overrides?: {
  pluginManager?: Record<string, any>;
  ensurePluginLoaded?: (pluginId: string) => Promise<void>;
  viewManager?: Record<string, any>;
}) {
  const pluginManager = {
    executeCommand: vi.fn(),
    getCustomPages: vi.fn(),
    renderCustomPage: vi.fn(),
    handlePageMessage: vi.fn(),
    callPluginAPI: vi.fn(),
    ...overrides?.pluginManager,
  };
  const duckdb = {
    executeSQLWithParams: vi.fn(),
    queryDataset: vi.fn(),
    getDatasetInfo: vi.fn(),
  };
  const buttonExecutor = {
    execute: vi.fn(),
  };
  const ensurePluginLoaded = overrides?.ensurePluginLoaded ?? vi.fn().mockResolvedValue(undefined);
  const viewManager = {
    getPluginPageCallerByWebContentsId: vi.fn(),
    ...overrides?.viewManager,
  };

  registerJSPluginUIExtensionRoutes({
    pluginManager: pluginManager as any,
    duckdb: duckdb as any,
    buttonExecutor: buttonExecutor as any,
    ensurePluginLoaded,
    viewManager: viewManager as any,
  });

  return { pluginManager, duckdb, buttonExecutor, ensurePluginLoaded, viewManager };
}

describe('JS plugin UI extension IPC routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcRouteRegistry.unregisterAll();
  });

  it('binds plugin page API calls to the plugin owning the WebContentsView sender', async () => {
    const pluginManager = {
      callPluginAPI: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { ensurePluginLoaded, viewManager } = registerRoutes({
      pluginManager,
      viewManager: {
        getPluginPageCallerByWebContentsId: vi.fn(() => ({
          pluginId: 'plugin-a',
          viewId: 'plugin-page:plugin-a:dashboard',
        })),
      },
    });

    const handler = getIpcHandler('js-plugin:call-api-bound');
    const response = await handler({ sender: { id: 42 } }, 'readState', ['arg']);

    expect(viewManager.getPluginPageCallerByWebContentsId).toHaveBeenCalledWith(42);
    expect(ensurePluginLoaded).toHaveBeenCalledWith('plugin-a');
    expect(pluginManager.callPluginAPI).toHaveBeenCalledWith('plugin-a', 'readState', ['arg']);
    expect(response).toEqual({ success: true, result: { ok: true } });
  });

  it('rejects bound plugin API calls from senders that are not plugin page views', async () => {
    const pluginManager = {
      callPluginAPI: vi.fn(),
    };
    registerRoutes({
      pluginManager,
      viewManager: {
        getPluginPageCallerByWebContentsId: vi.fn(() => null),
      },
    });

    const handler = getIpcHandler('js-plugin:call-api-bound');
    const response = await handler({ sender: { id: 43 } }, 'readState', []);

    expect(pluginManager.callPluginAPI).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.error).toContain('bound plugin page view');
  });
});
