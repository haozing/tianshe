import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPoolManager } from '../pool-manager';
import {
  createMockBrowser,
  createMockBrowserDestroyer,
  createMockBrowserFactory,
  createMockProfile,
  createMockProfileServiceGetter,
} from './test-utils';

vi.mock('electron-webcontents', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

describe('BrowserPoolManager closed persistent browser reuse', () => {
  let manager: BrowserPoolManager;
  let profiles: Map<string, any>;
  let createdBrowsers: ReturnType<typeof createMockBrowserFactory>['createdBrowsers'];
  let destroyer: ReturnType<typeof createMockBrowserDestroyer>['destroyer'];

  beforeEach(async () => {
    vi.useFakeTimers();

    const mockServiceGetter = createMockProfileServiceGetter();
    profiles = mockServiceGetter.profiles;
    manager = new BrowserPoolManager(mockServiceGetter.getProfileService);

    const factorySetup = createMockBrowserFactory();
    createdBrowsers = factorySetup.createdBrowsers;
    const destroyerSetup = createMockBrowserDestroyer();
    destroyer = destroyerSetup.destroyer;

    await manager.initialize(factorySetup.factory, destroyer);
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
  });

  it('destroys a closed extension browser before handing it out again', async () => {
    profiles.set(
      'extension-session',
      createMockProfile({ id: 'extension-session', runtimeId: 'chromium-extension-relay' })
    );

    const firstHandle = await manager.acquire('extension-session', { strategy: 'reuse' });
    await firstHandle.release();

    expect(createdBrowsers).toHaveLength(1);
    createdBrowsers[0]?._setClosed(true);

    const secondHandle = await manager.acquire('extension-session', { strategy: 'reuse' });

    expect(secondHandle.browserId).not.toBe(firstHandle.browserId);
    expect(createdBrowsers).toHaveLength(2);
    expect(destroyer).toHaveBeenCalledTimes(1);

    await secondHandle.release();
  });

  it('preserves electron-webcontents partition state across destroy and fresh acquire', async () => {
    const mockServiceGetter = createMockProfileServiceGetter();
    mockServiceGetter.profiles.set(
      'electron-session',
      createMockProfile({ id: 'electron-session', runtimeId: 'electron-webcontents' })
    );
    const electronManager = new BrowserPoolManager(mockServiceGetter.getProfileService);
    const partitionStores = new Map<
      string,
      {
        cookies: Map<string, { name: string; value: string }>;
        storage: Map<string, string>;
      }
    >();
    let createCount = 0;
    const factory = vi.fn(async (session) => {
      createCount += 1;
      const store =
        partitionStores.get(session.partition) ??
        {
          cookies: new Map<string, { name: string; value: string }>(),
          storage: new Map<string, string>(),
        };
      partitionStores.set(session.partition, store);
      const browser = createMockBrowser({ viewId: `electron-view-${createCount}` });
      browser.setCookie = vi.fn(async (cookie: { name: string; value: string }) => {
        store.cookies.set(cookie.name, { name: cookie.name, value: cookie.value });
      });
      browser.getCookies = vi.fn(async (filter?: { name?: string }) => {
        const cookies = [...store.cookies.values()];
        return filter?.name ? cookies.filter((cookie) => cookie.name === filter.name) : cookies;
      });
      browser.evaluateWithArgs = vi.fn(async (operation: string, key: string, value?: string) => {
        if (operation === 'set') {
          store.storage.set(key, String(value));
          return true;
        }
        if (operation === 'get') {
          return store.storage.get(key) ?? null;
        }
        return null;
      });
      return {
        browser,
        viewId: browser.viewId,
        runtimeId: 'electron-webcontents',
      };
    });
    const electronDestroyer = createMockBrowserDestroyer().destroyer;

    await electronManager.initialize(factory, electronDestroyer);

    try {
      const firstHandle = await electronManager.acquire('electron-session', { strategy: 'fresh' });
      await firstHandle.browser.setCookie({ name: 'login', value: 'ok' } as never);
      await firstHandle.browser.evaluateWithArgs('set', 'token', 'persisted');
      await firstHandle.release({ destroy: true });

      const secondHandle = await electronManager.acquire('electron-session', { strategy: 'fresh' });
      expect(secondHandle.browserId).not.toBe(firstHandle.browserId);
      await expect(secondHandle.browser.getCookies({ name: 'login' })).resolves.toEqual([
        { name: 'login', value: 'ok' },
      ]);
      await expect(secondHandle.browser.evaluateWithArgs('get', 'token')).resolves.toBe(
        'persisted'
      );
      await secondHandle.release({ destroy: true });
    } finally {
      await electronManager.stop();
    }
  });
});
