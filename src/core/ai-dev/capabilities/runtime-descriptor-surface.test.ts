import { describe, expect, it } from 'vitest';
import { createProfileCapabilityCatalog } from './profile-catalog';
import { createSystemCapabilityCatalog } from './system-catalog';

describe('runtime descriptor external surfaces', () => {
  it('system_bootstrap exposes static browser engine descriptors for pre-acquire planning', async () => {
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
        },
      },
      { capability: 'system_bootstrap' }
    );

    expect(result.structuredContent).toMatchObject({
      data: {
        browserEngines: {
          total: 3,
          descriptors: {
            extension: {
              engine: 'extension',
              capabilities: {
                'network.responseBody': {
                  supported: true,
                  source: 'static-engine',
                },
              },
            },
            ruyi: {
              engine: 'ruyi',
              capabilities: {
                'pdf.print': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
                'input.touch': {
                  supported: true,
                  source: 'static-engine',
                },
                'events.runtime': {
                  supported: true,
                  source: 'static-engine',
                },
                'storage.dom': {
                  supported: true,
                  source: 'static-engine',
                },
                'intercept.observe': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
                'intercept.control': {
                  supported: true,
                  stability: 'experimental',
                  source: 'static-engine',
                },
              },
            },
          },
        },
      },
      authoritativeFields: expect.arrayContaining([
        'structuredContent.data.browserEngines.descriptors',
      ]),
    });
  });

  it('profile surfaces backfill engine runtime descriptors from the static engine registry', async () => {
    const catalog = createProfileCapabilityCatalog();

    const listResult = await catalog.profile_list.handler(
      {},
      {
        profileGateway: {
          listProfiles: async () => [
            {
              id: 'profile-extension',
              name: 'Extension QA',
              engine: 'extension',
              status: 'idle',
              partition: 'persist:profile-extension',
              isSystem: false,
            },
            {
              id: 'profile-ruyi',
              name: 'Firefox QA',
              engine: 'ruyi',
              status: 'idle',
              partition: 'persist:profile-ruyi',
              isSystem: false,
            },
          ],
          getProfile: async (profileId: string) =>
            profileId === 'profile-extension'
              ? {
                  id: 'profile-extension',
                  name: 'Extension QA',
                  engine: 'extension',
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
          engineRuntimeDescriptor: expect.objectContaining({
            engine: 'extension',
            capabilities: expect.objectContaining({
              'network.responseBody': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: 'profile-ruyi',
          engineRuntimeDescriptor: expect.objectContaining({
            engine: 'ruyi',
            capabilities: expect.objectContaining({
              'pdf.print': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
              }),
              'input.touch': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'events.runtime': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'storage.dom': expect.objectContaining({
                supported: true,
                source: 'static-engine',
              }),
              'intercept.observe': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
              }),
              'intercept.control': expect.objectContaining({
                supported: true,
                stability: 'experimental',
                source: 'static-engine',
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
            engine: 'extension',
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
      engineRuntimeDescriptor: expect.objectContaining({
        engine: 'extension',
        capabilities: expect.objectContaining({
          'network.responseBody': expect.objectContaining({
            supported: true,
            source: 'static-engine',
          }),
        }),
      }),
    });
  });
});
