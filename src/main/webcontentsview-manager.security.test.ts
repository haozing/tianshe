import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WebContentsViewManager } from './webcontentsview-manager';

const { webContentsViewCtor, webContentsInstances } = vi.hoisted(() => ({
  webContentsViewCtor: vi.fn(),
  webContentsInstances: [] as any[],
}));

function createMockWebContents() {
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  const webContents = {
    session,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue('object'),
    isDestroyed: vi.fn(() => false),
  };
  webContentsInstances.push(webContents);
  return webContents;
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\tianshe-test'),
    getAppPath: vi.fn(() => 'C:\\tianshe-app'),
  },
  WebContentsView: vi.fn().mockImplementation((options: any) => {
    webContentsViewCtor(options);
    return {
      webContents: createMockWebContents(),
      on: vi.fn(),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })),
    };
  }),
}));

vi.mock('../core/browser-core/web-request-hub', () => ({
  getSessionWebRequestHub: vi.fn(() => ({
    subscribeBeforeSendHeaders: vi.fn(),
    subscribeHeadersReceived: vi.fn(),
  })),
}));

vi.mock('./internal-browser-devtools', () => ({
  maybeOpenInternalBrowserDevTools: vi.fn(() => false),
}));

vi.mock('../core/stealth', () => ({
  fingerprintManager: {
    getOrCreateFingerprint: vi.fn(),
  },
  generateFullStealthScript: vi.fn(() => ''),
  generateCDPCommands: vi.fn(() => []),
  generateDebuggerHidingCommands: vi.fn(() => []),
  buildLowEntropyClientHintsHeaders: vi.fn(() => ({})),
  buildHighEntropyClientHintsHeaders: vi.fn(() => ({})),
  buildAcceptLanguageHeaderValue: vi.fn(() => 'en-US,en;q=0.9'),
}));

function createManager() {
  return new WebContentsViewManager(
    {
      getMainWindowV3: vi.fn(() => null),
    } as never,
    5
  );
}

describe('WebContentsViewManager security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webContentsInstances.length = 0;
  });

  it('does not inject the full app preload into automation target views', async () => {
    const manager = createManager();
    manager.registerView({
      id: 'pool-view',
      partition: 'persist:pool-view',
      metadata: { source: 'pool', stealth: { enabled: false } },
    });

    await manager.activateView('pool-view');

    const options = webContentsViewCtor.mock.calls[0][0];
    expect(options.webPreferences.preload).toBeUndefined();
    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.sandbox).toBe(true);
  });

  it('injects only the narrow plugin preload into plugin views', async () => {
    const manager = createManager();
    manager.registerView({
      id: 'plugin-view',
      partition: 'persist:plugin-view',
      metadata: { source: 'plugin', stealth: { enabled: false } },
    });

    await manager.activateView('plugin-view');

    const options = webContentsViewCtor.mock.calls[0][0];
    expect(options.webPreferences.preload).toBe(
      'C:\\tianshe-app\\dist\\preload\\webcontents-view.js'
    );
    expect(options.webPreferences.webSecurity).toBe(true);
    expect(options.webPreferences.allowRunningInsecureContent).toBe(false);
  });

  it('denies permissions by default and allows only declared permissions', async () => {
    const manager = createManager();
    manager.registerView({
      id: 'permission-view',
      partition: 'persist:permission-view',
      metadata: {
        source: 'pool',
        stealth: { enabled: false },
        security: { allowedPermissions: ['clipboard-read'] },
      },
    });

    await manager.activateView('permission-view');

    const permissionHandler = webContentsInstances[0].session.setPermissionRequestHandler.mock
      .calls[0][0];
    const denied = vi.fn();
    const allowed = vi.fn();

    permissionHandler({}, 'geolocation', denied);
    permissionHandler({}, 'clipboard-read', allowed);

    expect(denied).toHaveBeenCalledWith(false);
    expect(allowed).toHaveBeenCalledWith(true);

    const checkHandler = webContentsInstances[0].session.setPermissionCheckHandler.mock
      .calls[0][0];
    expect(checkHandler({}, 'geolocation')).toBe(false);
    expect(checkHandler({}, 'clipboard-read')).toBe(true);
  });
});
