import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcRouteDefinition } from './ipc-route-registry';

// 工厂内使用 vi.fn() 直接创建 mock，避免 hoisting 导致的初始化顺序问题
const mockHandler = vi.fn();
const mockOn = vi.fn();
const mockRemoveHandler = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch, h) => mockHandler(ch, h)),
    on: vi.fn((ch, h) => mockOn(ch, h)),
    removeHandler: vi.fn((ch) => mockRemoveHandler(ch)),
    removeListener: vi.fn((ch, h) => mockRemoveListener(ch, h)),
  },
}));

// 动态导入被测模块，确保 mock 已生效
async function createRegistry() {
  const { IpcRouteRegistry } = await import('./ipc-route-registry');
  return new IpcRouteRegistry();
}

describe('IpcRouteRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a handle route', async () => {
    const registry = await createRegistry();
    const route: IpcRouteDefinition = {
      channel: 'test:hello',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => 'world',
    };

    registry.register(route);

    expect(registry.has('test:hello')).toBe(true);
    expect(registry.size).toBe(1);
    expect(mockHandler).toHaveBeenCalledWith('test:hello', route.handler);
  });

  it('registers an on route', async () => {
    const registry = await createRegistry();
    const route: IpcRouteDefinition = {
      channel: 'test:event',
      kind: 'on',
      permission: 'trusted-renderer',
      handler: () => {},
    };

    registry.register(route);

    expect(registry.has('test:event')).toBe(true);
    expect(mockOn).toHaveBeenCalledWith('test:event', route.handler);
  });

  it('throws on duplicate channel', async () => {
    const registry = await createRegistry();
    const route: IpcRouteDefinition = {
      channel: 'test:dup',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {},
    };

    registry.register(route);
    expect(() => registry.register(route)).toThrow(/Duplicate IPC channel/);
  });

  it('throws when permission metadata is missing', async () => {
    const registry = await createRegistry();
    const route = {
      channel: 'test:no-permission',
      kind: 'handle',
      handler: async () => {},
    } as unknown as IpcRouteDefinition;

    expect(() => registry.register(route)).toThrow(/Missing IPC permission declaration/);
    expect(registry.has('test:no-permission')).toBe(false);
  });

  it('registers multiple routes via registerAll', async () => {
    const registry = await createRegistry();
    const routes: IpcRouteDefinition[] = [
      {
        channel: 'test:a',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {},
      },
      {
        channel: 'test:b',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {},
      },
    ];

    registry.registerAll(routes);

    expect(registry.size).toBe(2);
    expect(registry.getChannels()).toEqual(['test:a', 'test:b']);
  });

  it('exports a route manifest without handler functions', async () => {
    const registry = await createRegistry();
    registry.register({
      channel: 'test:manifest',
      kind: 'handle',
      permission: 'privileged',
      schema: {
        description: 'Manifest contract route',
        args: ['id'],
        result: { success: true },
      },
      handler: async () => ({ success: true }),
    });

    expect(registry.getManifest()).toEqual([
      {
        channel: 'test:manifest',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Manifest contract route',
          args: ['id'],
          result: { success: true },
        },
      },
    ]);
  });

  it('unregisters a handle route', async () => {
    const registry = await createRegistry();
    registry.register({
      channel: 'test:rm',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {},
    });
    registry.unregister('test:rm');

    expect(registry.has('test:rm')).toBe(false);
    expect(mockRemoveHandler).toHaveBeenCalledWith('test:rm');
  });

  it('unregisters an on route', async () => {
    const registry = await createRegistry();
    const handler = () => {};
    registry.register({
      channel: 'test:rm-on',
      kind: 'on',
      permission: 'trusted-renderer',
      handler,
    });
    registry.unregister('test:rm-on');

    expect(registry.has('test:rm-on')).toBe(false);
    expect(mockRemoveListener).toHaveBeenCalledWith('test:rm-on', handler);
  });

  it('unregisters all routes', async () => {
    const registry = await createRegistry();
    registry.register({
      channel: 'test:a',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {},
    });
    registry.register({
      channel: 'test:b',
      kind: 'on',
      permission: 'trusted-renderer',
      handler: () => {},
    });
    registry.unregisterAll();

    expect(registry.size).toBe(0);
    expect(mockRemoveHandler).toHaveBeenCalledTimes(1);
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  });
});
