import { describe, expect, it } from 'vitest';
import {
  getKnownEffectiveRuntimeDescriptor,
  type BrowserRuntimeStatus,
} from '../../browser-runtime';
import { createProfileCapabilityCatalog } from './profile-catalog';
import { createSystemCapabilityCatalog } from './system-catalog';

describe('runtime descriptor external surfaces', () => {
  it('system_bootstrap exposes effective browser runtime descriptors for pre-acquire planning', async () => {
    const catalog = createSystemCapabilityCatalog();
    const result = await catalog.system_bootstrap.handler(
      {},
      {
        systemGateway: {
          getHealth: async () => ({
            status: 'ok',
            name: 'airpa',
            version: '1.0.0',
            activeSessions: 0,
            mcpSessions: 0,
            orchestrationSessions: 0,
            authEnabled: false,
            mcpConfigured: true,
            mcpEnabled: true,
            mcpRequireAuth: false,
            mcpProtocolCompatibilityMode: 'unified',
            mcpProtocolVersion: '2025-03-26',
            mcpSupportedProtocolVersions: ['2025-03-26'],
            mcpSdkSupportedProtocolVersions: ['2025-03-26'],
            enforceOrchestrationScopes: false,
            orchestrationIdempotencyStore: 'memory',
            queueDepth: {},
            runtimeCounters: {},
            sessionLeakRisk: {},
            sessionCleanupPolicy: {},
            processStartTime: '2026-04-16T00:00:00.000Z',
            mainDistUpdatedAt: null,
            rendererDistUpdatedAt: null,
            mainBuildStamp: null,
            mcpRuntimeFreshness: {},
            buildFreshness: {},
            gitCommit: null,
            mcpSdk: {},
            runtimeAlerts: [],
          }),
          listPublicCapabilities: async () => ['system_bootstrap', 'profile_list', 'session_prepare'],
          listBrowserRuntimeStatuses: async (): Promise<BrowserRuntimeStatus[]> => [
            {
              runtimeId: 'chromium-extension-relay',
              descriptor: getKnownEffectiveRuntimeDescriptor('chromium-extension-relay'),
              source: { type: 'custom-path', executablePath: 'C:/Browsers/chrome.exe' },
              resolvedRuntime: null,
              installed: true,
              healthy: true,
              installState: 'custom-path',
              version: '120.0.0.0',
              executablePath: 'C:/Browsers/chrome.exe',
              errors: [],
              warnings: [],
            },
          ],
        },
      },
      { capability: 'system_bootstrap' }
    );

    expect(result.structuredContent).toMatchObject({
      data: {
        browserRuntimes: {
          total: 4,
          descriptors: {
            'chromium-extension-relay': {
              runtimeId: 'chromium-extension-relay',
              capabilities: {
                'network.responseBody': {
                  supported: true,
                  source: 'static-runtime',
                },
              },
            },
            'firefox-bidi': {
              runtimeId: 'firefox-bidi',
              capabilities: {
                'pdf.print': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
                'input.touch': {
                  supported: true,
                  source: 'static-runtime',
                },
                'events.runtime': {
                  supported: true,
                  source: 'static-runtime',
                },
                'storage.dom': {
                  supported: true,
                  source: 'static-runtime',
                },
                'intercept.observe': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
                'intercept.control': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-runtime',
                },
              },
            },
            'chromium-cloak-playwright': {
              runtimeId: 'chromium-cloak-playwright',
              capabilities: {
                'network.responseBody': {
                  supported: true,
                  stability: 'experimental',
                  source: 'runtime',
                },
                'download.manage': {
                  supported: true,
                  stability: 'experimental',
                  source: 'runtime',
                },
                'dialog.promptText': {
                  supported: true,
                  stability: 'experimental',
                  source: 'runtime',
                },
              },
            },
          },
          statuses: {
            'chromium-extension-relay': {
              runtimeId: 'chromium-extension-relay',
              installState: 'custom-path',
              installed: true,
              executablePath: 'C:/Browsers/chrome.exe',
            },
            'electron-webcontents': {
              runtimeId: 'electron-webcontents',
              installState: 'unknown',
            },
          },
        },
      },
      authoritativeFields: expect.arrayContaining([
        'structuredContent.data.browserRuntimes.descriptors',
      ]),
    });
  });

  it('profile surfaces backfill runtime descriptors from the effective runtime registry', async () => {
    const catalog = createProfileCapabilityCatalog();

    const listResult = await catalog.profile_list.handler(
      {},
      {
        profileGateway: {
          listProfiles: async () => [
            {
              id: 'profile-extension',
              name: 'Extension QA',
              runtimeId: 'chromium-extension-relay',
              status: 'idle',
              partition: 'persist:profile-extension',
              isSystem: false,
            },
            {
              id: 'profile-ruyi',
              name: 'Firefox QA',
              runtimeId: 'firefox-bidi',
              status: 'idle',
              partition: 'persist:profile-ruyi',
              isSystem: false,
            },
            {
              id: 'profile-cloak',
              name: 'Cloak QA',
              runtimeId: 'chromium-cloak-playwright',
              status: 'idle',
              partition: 'persist:profile-cloak',
              isSystem: false,
            },
          ],
          getProfile: async (profileId: string) =>
            profileId === 'profile-extension'
              ? {
                  id: 'profile-extension',
                  name: 'Extension QA',
                  runtimeId: 'chromium-extension-relay',
                  status: 'idle',
                  partition: 'persist:profile-extension',
                  isSystem: false,
                }
              : null,
          resolveProfile: async () => null,
          createProfile: async () => {
            throw new Error('not used');
          },
          updateProfile: async () => {
            throw new Error('not used');
          },
          deleteProfile: async () => {
            throw new Error('not used');
          },
        },
      },
      { capability: 'profile_list' }
    );

    const listedProfiles = ((listResult.structuredContent as any)?.data?.profiles ?? []) as Array<any>;
    expect(listedProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'profile-extension',
          runtimeDescriptor: expect.objectContaining({
            runtimeId: 'chromium-extension-relay',
            capabilities: expect.objectContaining({
              'network.responseBody': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: 'profile-ruyi',
          runtimeDescriptor: expect.objectContaining({
            runtimeId: 'firefox-bidi',
            capabilities: expect.objectContaining({
              'pdf.print': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
              }),
              'input.touch': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'events.runtime': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'storage.dom': expect.objectContaining({
                supported: true,
                source: 'static-runtime',
              }),
              'intercept.observe': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
              }),
              'intercept.control': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-runtime',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: 'profile-cloak',
          runtimeDescriptor: expect.objectContaining({
            runtimeId: 'chromium-cloak-playwright',
            capabilities: expect.objectContaining({
              'network.responseBody': expect.objectContaining({
                supported: true,
                source: 'runtime',
              }),
              'download.manage': expect.objectContaining({
                supported: true,
                source: 'runtime',
              }),
            }),
          }),
        }),
      ])
    );

    const getResult = await catalog.profile_get.handler(
      { profileId: 'profile-extension' },
      {
        profileGateway: {
          listProfiles: async () => [],
          getProfile: async () => ({
            id: 'profile-extension',
            name: 'Extension QA',
            runtimeId: 'chromium-extension-relay',
            status: 'idle',
            partition: 'persist:profile-extension',
            isSystem: false,
          }),
          resolveProfile: async () => null,
          createProfile: async () => {
            throw new Error('not used');
          },
          updateProfile: async () => {
            throw new Error('not used');
          },
          deleteProfile: async () => {
            throw new Error('not used');
          },
        },
      },
      { capability: 'profile_get' }
    );

    expect((getResult.structuredContent as any)?.data?.profile).toMatchObject({
      id: 'profile-extension',
      runtimeDescriptor: expect.objectContaining({
        runtimeId: 'chromium-extension-relay',
        capabilities: expect.objectContaining({
          'network.responseBody': expect.objectContaining({
            supported: true,
            source: 'static-runtime',
          }),
        }),
      }),
    });
  });
});
