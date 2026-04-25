import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPoolManager } from '../pool-manager';
import {
  createMockBrowserDestroyer,
  createMockBrowserFactory,
  createMockProfile,
  createMockProfileServiceGetter,
} from './test-utils';

vi.mock('electron', () => ({
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
      createMockProfile({ id: 'extension-session', engine: 'extension' })
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
});
