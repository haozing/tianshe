import { describe, expect, it, vi } from 'vitest';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
import { getStaticRuntimeDescriptor } from '../../core/browser-pool/runtime-capability-registry';
import { createDefaultBrowserRuntimeProviders } from './browser-runtime-providers';

const createBrowserFactory = (result: Awaited<ReturnType<BrowserFactory>>): BrowserFactory =>
  vi.fn().mockResolvedValue(result);

const createBrowser = () =>
  ({
    closeInternal: vi.fn(),
    describeRuntime: vi.fn(),
  }) as any;

describe('browser runtime providers', () => {
  it('requires factories to return runtimeDescriptor instead of falling back to static descriptors', async () => {
    const descriptor = getStaticRuntimeDescriptor('electron-webcontents');
    const extensionDescriptor = getStaticRuntimeDescriptor('chromium-extension-relay');
    const firefoxDescriptor = getStaticRuntimeDescriptor('firefox-bidi');
    const cloakDescriptor = getStaticRuntimeDescriptor('chromium-cloak-playwright');
    const providers = createDefaultBrowserRuntimeProviders({
      electronBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'electron-webcontents',
      }),
      extensionBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'chromium-extension-relay',
        runtimeDescriptor: extensionDescriptor,
      }),
      ruyiBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'firefox-bidi',
        runtimeDescriptor: firefoxDescriptor,
      }),
      cloakBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'chromium-cloak-playwright',
        runtimeDescriptor: cloakDescriptor,
      }),
    });

    const electron = providers.find((provider) => provider.id === 'electron-webcontents');
    await expect(
      electron?.create({
        id: 'profile-1',
        runtimeId: 'electron-webcontents',
        runtimeDescriptor: descriptor,
      } as any)
    ).rejects.toThrow(/must return runtimeDescriptor/);
  });

  it('returns the factory runtimeDescriptor without replacing dynamic descriptors', async () => {
    const descriptor = getStaticRuntimeDescriptor('electron-webcontents');
    descriptor.capabilities['network.responseBody'] = {
      supported: true,
      stability: 'experimental',
      source: 'runtime',
      notes: 'Dynamic runtime probe enabled response body capture for this session.',
    };

    const providers = createDefaultBrowserRuntimeProviders({
      electronBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'electron-webcontents',
        runtimeDescriptor: descriptor,
      }),
      extensionBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'chromium-extension-relay',
        runtimeDescriptor: getStaticRuntimeDescriptor('chromium-extension-relay'),
      }),
      ruyiBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'firefox-bidi',
        runtimeDescriptor: getStaticRuntimeDescriptor('firefox-bidi'),
      }),
      cloakBrowserFactory: createBrowserFactory({
        browser: createBrowser(),
        runtimeId: 'chromium-cloak-playwright',
        runtimeDescriptor: getStaticRuntimeDescriptor('chromium-cloak-playwright'),
      }),
    });

    const electron = providers.find((provider) => provider.id === 'electron-webcontents');
    const created = await electron?.create({
      id: 'profile-1',
      runtimeId: 'electron-webcontents',
      runtimeDescriptor: getStaticRuntimeDescriptor('electron-webcontents'),
    } as any);

    expect(created?.runtimeDescriptor.capabilities['network.responseBody']).toMatchObject({
      supported: true,
      source: 'runtime',
    });
  });
});
