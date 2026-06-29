import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { SYNC_PROTOCOL_VERSION, type SyncPullRequest, type SyncPushRequest } from '../../types/sync-contract';
import { SyncGatewayMock } from './sync-gateway-mock';

function createClient() {
  return {
    clientId: 'test-client',
    deviceFingerprint: 'test-device',
    appVersion: '0.0.0-test',
  };
}

function createScope(scopeId = 'mock-test') {
  return {
    scopeType: 'company',
    scopeId,
  };
}

function createPushRequest(partial: Partial<SyncPushRequest> = {}): SyncPushRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    traceId: uuidv4(),
    client: createClient(),
    scope: createScope(),
    idempotencyKey: uuidv4(),
    operations: [],
    ...partial,
  };
}

function createPullRequest(partial: Partial<SyncPullRequest> = {}): SyncPullRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    traceId: uuidv4(),
    client: createClient(),
    scope: createScope(),
    since: {
      account: 0,
      profile: 0,
      extension: 0,
    },
    page: { size: 100 },
    includeDeleted: true,
    ...partial,
  };
}

describe('SyncGatewayMock', () => {
  it('supports push upsert and pull incremental changes', async () => {
    const gateway = new SyncGatewayMock({ baseUrl: 'mock://sync-test' });
    const scope = createScope('mock-test-1');

    const pushResp = await gateway.push(
      createPushRequest({
        scope,
        operations: [
          {
            domain: 'profile',
            opType: 'upsert',
            eventSource: 'crud',
            entities: [
              {
                entityType: 'profile',
                localId: 'profile-local-1',
                payload: {
                  name: 'Profile A',
                },
              },
            ],
          },
        ],
      })
    );

    expect(pushResp.result).toBe('success');
    expect(pushResp.domainResults).toHaveLength(1);
    const pushEntity = pushResp.domainResults[0]?.entityResults[0];
    expect(pushEntity?.status).toBe('ok');
    expect(pushEntity?.globalUid).toBeTruthy();

    const pullResp = await gateway.pull(
      createPullRequest({
        scope,
        since: {
          account: 0,
          profile: 0,
          extension: 0,
        },
      })
    );

    expect(pullResp.hasMore).toBe(false);
    expect(pullResp.domains.some((item) => item.domain === 'profile')).toBe(true);
    const profileDomain = pullResp.domains.find((item) => item.domain === 'profile');
    expect(profileDomain?.changes.length).toBeGreaterThan(0);
    expect(profileDomain?.changes[0]?.entityType).toBe('profile');
  });

  it('returns conflict when baseVersion mismatches', async () => {
    const gateway = new SyncGatewayMock({ baseUrl: 'mock://sync-test-conflict' });
    const scope = createScope('mock-test-2');

    const firstPush = await gateway.push(
      createPushRequest({
        scope,
        operations: [
          {
            domain: 'account',
            opType: 'upsert',
            eventSource: 'crud',
            entities: [
              {
                entityType: 'tag',
                localId: 'tag-local-1',
                payload: { name: 'Tag1' },
              },
            ],
          },
        ],
      })
    );
    const globalUid = firstPush.domainResults[0]?.entityResults[0]?.globalUid;
    expect(globalUid).toBeTruthy();

    const conflictPush = await gateway.push(
      createPushRequest({
        scope,
        operations: [
          {
            domain: 'account',
            opType: 'upsert',
            eventSource: 'crud',
            entities: [
              {
                entityType: 'tag',
                localId: 'tag-local-1',
                globalUid,
                baseVersion: 0,
                payload: { name: 'Tag1-updated' },
              },
            ],
          },
        ],
      })
    );

    expect(conflictPush.result).toBe('failed');
    const result = conflictPush.domainResults[0]?.entityResults[0];
    expect(result?.status).toBe('conflict');
    expect(result?.errorCode).toBe('SYNC_ENTITY_CONFLICT');
  });

  it('deduplicates same idempotencyKey in one scope', async () => {
    const gateway = new SyncGatewayMock({ baseUrl: 'mock://sync-test-idempotency' });
    const scope = createScope('mock-test-3');
    const idempotencyKey = uuidv4();

    const payload = createPushRequest({
      scope,
      idempotencyKey,
      operations: [
        {
          domain: 'extension',
          opType: 'upsert',
          eventSource: 'crud',
          entities: [
            {
              entityType: 'extensionPackage',
              localId: 'ext-local-1',
              payload: {
                extensionId: 'abcdefghijklmnopqrstuvwxzyabcdef',
                version: '1.0.0',
              },
            },
          ],
        },
      ],
    });

    const first = await gateway.push(payload);
    const second = await gateway.push(payload);

    expect(second).toEqual(first);

    const pull = await gateway.pull(
      createPullRequest({
        scope,
        since: {
          account: 0,
          profile: 0,
          extension: 0,
        },
      })
    );
    const extDomain = pull.domains.find((item) => item.domain === 'extension');
    expect(extDomain?.changes.length).toBe(1);
  });

  it('returns reference conflict for account when referenced profile is missing', async () => {
    const gateway = new SyncGatewayMock({ baseUrl: 'mock://sync-test-reference-conflict' });
    const scope = createScope('mock-test-4');

    const pushResp = await gateway.push(
      createPushRequest({
        scope,
        operations: [
          {
            domain: 'account',
            opType: 'upsert',
            eventSource: 'crud',
            entities: [
              {
                entityType: 'account',
                localId: 'acc-local-1',
                payload: {
                  name: 'A1',
                  profileGlobalUid: 'profile-global-not-exists',
                },
              },
            ],
          },
        ],
      })
    );

    expect(pushResp.result).toBe('failed');
    expect(pushResp.domainResults[0]?.failureCount).toBe(1);
    expect(pushResp.domainResults[0]?.newDomainVersion).toBe(0);
    const entityResult = pushResp.domainResults[0]?.entityResults[0];
    expect(entityResult?.status).toBe('failed');
    expect(entityResult?.errorCode).toBe('SYNC_REFERENCE_CONFLICT');
  });

  it('supports artifact upload and download flow', async () => {
    const gateway = new SyncGatewayMock({ baseUrl: 'mock://sync-test-artifact' });
    const scope = createScope('mock-test-5');
    const bytes = new Uint8Array([10, 20, 30, 40]);

    const uploadPlan = await gateway.artifactUploadUrl({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      traceId: uuidv4(),
      client: createClient(),
      scope,
      artifactType: 'extension-package',
      sha256: '5f53c0ff07ba5d9a330e68c95dabb1a9bc49e29f9ed53f6fa7c6d99abb000050',
      sizeBytes: bytes.length,
      fileName: 'ext.zip',
    });
    await gateway.uploadArtifactFile(uploadPlan.uploadUrl, 'ext.zip', bytes);

    const downloadPlan = await gateway.artifactDownloadUrl({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      traceId: uuidv4(),
      client: createClient(),
      scope,
      artifactRef: uploadPlan.artifactRef,
    });
    const downloaded = await gateway.downloadArtifactFile(downloadPlan.downloadUrl);

    expect(Array.from(downloaded)).toEqual(Array.from(bytes));
  });
});
