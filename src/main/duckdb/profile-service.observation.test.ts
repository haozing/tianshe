import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProfileService } from './profile-service';
import { setObservationSink } from '../../core/observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../core/observability/types';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';

vi.mock('electron-webcontents', () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      storagePath: '',
    })),
  },
}));

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

interface PreparedStatementMock {
  sql: string;
  bind: Mock;
  run: Mock;
  runAndReadAll: Mock;
  destroySync: Mock;
}

describe('ProfileService observation hooks', () => {
  let service: ProfileService;
  let conn: {
    run: Mock;
    prepare: Mock;
  };

  beforeEach(() => {
    conn = {
      run: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockImplementation((sql: string) => {
        const stmt: PreparedStatementMock = {
          sql,
          bind: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          runAndReadAll: vi.fn().mockResolvedValue({}),
          destroySync: vi.fn(),
        };
        return stmt;
      }),
    };

    service = new ProfileService(conn as never);
  });

  afterEach(() => {
    setObservationSink(null);
    vi.clearAllMocks();
  });

  it('records profile.lifecycle.create events when creating a profile', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    vi.spyOn(service, 'get').mockImplementation(async (id: string) => ({
      id,
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
      groupId: null,
      partition: `persist:profile-${id}`,
      proxy: null,
      fingerprint: {} as never,
      notes: null,
      tags: [],
      color: null,
      status: 'idle',
      totalUses: 0,
      quota: 1,
      idleTimeoutMs: 0,
      lockTimeoutMs: 0,
      isSystem: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as never);

    const profile = await service.create({
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
    });

    expect(profile.name).toBe('Shop QA');
    expect(
      sink.events
        .filter((event) => event.event.startsWith('profile.lifecycle.create'))
        .map((event) => event.event)
    ).toEqual(['profile.lifecycle.create.started', 'profile.lifecycle.create.succeeded']);
    expect(
      sink.events.find((event) => event.event === 'profile.lifecycle.create.started')?.attrs
    ).toMatchObject({
      name: 'Shop QA',
      runtimeId: 'chromium-extension-relay',
    });
    expect(
      sink.events.find((event) => event.event === 'profile.lifecycle.create.succeeded')?.attrs
    ).toMatchObject({
      profileId: profile.id,
      runtimeId: 'chromium-extension-relay',
    });
  });

  it('records profile.lifecycle.update events when updating a profile', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const fingerprint = getDefaultFingerprint('electron-webcontents');

    vi.spyOn(service, 'get')
      .mockResolvedValueOnce({
        id: 'profile-1',
        name: 'Shop QA',
        runtimeId: 'electron-webcontents',
        groupId: null,
        partition: 'persist:profile-1',
        proxy: null,
        fingerprint,
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 0,
        lockTimeoutMs: 0,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .mockResolvedValueOnce({
        id: 'profile-1',
        name: 'Shop QA Updated',
        runtimeId: 'electron-webcontents',
        groupId: null,
        partition: 'persist:profile-1',
        proxy: null,
        fingerprint,
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 0,
        lockTimeoutMs: 0,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

    const profile = await service.update('profile-1', {
      name: 'Shop QA Updated',
    });

    expect(profile.name).toBe('Shop QA Updated');
    expect(
      sink.events
        .filter((event) => event.event.startsWith('profile.lifecycle.update'))
        .map((event) => event.event)
    ).toEqual(['profile.lifecycle.update.started', 'profile.lifecycle.update.succeeded']);
    expect(
      sink.events.find((event) => event.event === 'profile.lifecycle.update.succeeded')?.attrs
    ).toMatchObject({
      profileId: 'profile-1',
      changedFields: ['name'],
      runtimeResetExpected: false,
    });
  });

  it('increments login state revision and expires login health for runtime-affecting profile updates', async () => {
    const fingerprint = getDefaultFingerprint('electron-webcontents');
    vi.spyOn(service, 'get')
      .mockResolvedValueOnce({
        id: 'profile-1',
        name: 'Shop QA',
        runtimeId: 'electron-webcontents',
        groupId: null,
        partition: 'persist:profile-1',
        proxy: null,
        fingerprint,
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300000,
        lockTimeoutMs: 300000,
        loginStateRevision: 0,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .mockResolvedValueOnce({
        id: 'profile-1',
        name: 'Shop QA',
        runtimeId: 'electron-webcontents',
        groupId: null,
        partition: 'persist:profile-1',
        proxy: { type: 'http', host: 'proxy.test', port: 8080 },
        fingerprint,
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300000,
        lockTimeoutMs: 300000,
        loginStateRevision: 1,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

    await service.update('profile-1', {
      proxy: { type: 'http', host: 'proxy.test', port: 8080 },
    });

    const preparedSql = conn.prepare.mock.calls.map(([sql]: [string]) => sql).join('\n');
    expect(preparedSql).toContain('login_state_revision = COALESCE(login_state_revision, 0) + 1');
    expect(preparedSql).toContain('UPDATE profile_login_states');
    expect(preparedSql).toContain("SET status = 'expired'");
  });

  it('records profile.lifecycle.delete events when deleting a profile', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'profile-1',
      name: 'Shop QA',
      runtimeId: 'electron-webcontents',
      groupId: null,
      partition: 'persist:profile-1',
      proxy: null,
      fingerprint: {} as never,
      notes: null,
      tags: [],
      color: null,
      status: 'idle',
      totalUses: 0,
      quota: 1,
      idleTimeoutMs: 0,
      lockTimeoutMs: 0,
      isSystem: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.spyOn(service as never, 'purgePartitionData').mockResolvedValue(undefined);
    vi.spyOn(service as never, 'purgeExtensionProfileData').mockResolvedValue(undefined);
    vi.spyOn(service as never, 'purgeCloakProfileData').mockResolvedValue(undefined);

    await service.deleteWithCascade('profile-1');

    expect(
      sink.events
        .filter((event) => event.event.startsWith('profile.lifecycle.delete'))
        .map((event) => event.event)
    ).toEqual(['profile.lifecycle.delete.started', 'profile.lifecycle.delete.succeeded']);
    expect(
      sink.events.find((event) => event.event === 'profile.lifecycle.delete.succeeded')?.attrs
    ).toMatchObject({
      profileId: 'profile-1',
    });
  });
});
