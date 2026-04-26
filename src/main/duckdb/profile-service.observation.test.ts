import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProfileService } from './profile-service';
import { setObservationSink } from '../../core/observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../core/observability/types';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';

vi.mock('electron', () => ({
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
      engine: 'extension',
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
      engine: 'extension',
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
      engine: 'extension',
    });
    expect(
      sink.events.find((event) => event.event === 'profile.lifecycle.create.succeeded')?.attrs
    ).toMatchObject({
      profileId: profile.id,
      engine: 'extension',
    });
  });

  it('records profile.lifecycle.update events when updating a profile', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const fingerprint = getDefaultFingerprint('electron');

    vi.spyOn(service, 'get')
      .mockResolvedValueOnce({
        id: 'profile-1',
        name: 'Shop QA',
        engine: 'electron',
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
        engine: 'electron',
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

  it('records profile.lifecycle.delete events when deleting a profile', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'profile-1',
      name: 'Shop QA',
      engine: 'electron',
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
