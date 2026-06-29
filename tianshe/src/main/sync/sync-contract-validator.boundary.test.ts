import { describe, expect, it } from 'vitest';
import { validateSyncContractDefinition } from './sync-contract-validator';

const baseEnvelope = {
  protocolVersion: '1.0' as const,
  traceId: 'trace-1',
  client: {
    clientId: 'client-1',
    deviceFingerprint: 'device-1',
    appVersion: '1.0.0-test',
  },
  scope: {
    scopeType: 'workspace',
    scopeId: 'workspace-1',
  },
};

const baseCapabilities = {
  account: { view: true, cache: true, edit: true, delete: true },
  profile: { view: true, cache: true, edit: true, delete: true },
  extension: { view: true, cache: true, edit: true, delete: true, install: true },
};

describe('sync contract dataset boundary', () => {
  it('rejects extra dataset domains in the handshake domain version map', () => {
    const payload = {
      protocolVersion: '1.0',
      traceId: 'trace-handshake-1',
      serverTime: new Date().toISOString(),
      capabilities: baseCapabilities,
      limits: {
        maxPushOps: 500,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxArtifactBytes: 100 * 1024 * 1024,
      },
      domainVersions: {
        account: 0,
        profile: 0,
        extension: 0,
        dataset: 0,
      },
    };

    const result = validateSyncContractDefinition('HandshakeResponse', payload);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('/domainVersions'))).toBe(true);
  });

  it('rejects dataset domains in push requests', () => {
    const payload = {
      ...baseEnvelope,
      idempotencyKey: 'push-1',
      operations: [
        {
          domain: 'dataset',
          opType: 'upsert',
          eventSource: 'crud',
          entities: [
            {
              entityType: 'profile',
              localId: 'local-1',
            },
          ],
        },
      ],
    };

    const result = validateSyncContractDefinition('PushRequest', payload);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('/operations/0/domain'))).toBe(true);
  });

  it('rejects table entities in push payloads and pull responses', () => {
    const pushPayload = {
      ...baseEnvelope,
      idempotencyKey: 'push-2',
      operations: [
        {
          domain: 'profile',
          opType: 'upsert',
          eventSource: 'crud',
          entities: [
            {
              entityType: 'table',
              localId: 'table-1',
            },
          ],
        },
      ],
    };

    const pullPayload = {
      protocolVersion: '1.0',
      traceId: 'trace-pull-1',
      hasMore: false,
      domains: [
        {
          domain: 'dataset',
          newDomainVersion: 1,
          changes: [],
        },
      ],
    };

    const pushResult = validateSyncContractDefinition('PushRequest', pushPayload);
    const pullResult = validateSyncContractDefinition('PullResponse', pullPayload);

    expect(pushResult.valid).toBe(false);
    expect(pushResult.errors.some((error) => error.includes('/operations/0/entities/0/entityType'))).toBe(
      true
    );
    expect(pullResult.valid).toBe(false);
    expect(pullResult.errors.some((error) => error.includes('/domains/0/domain'))).toBe(true);
  });
});
