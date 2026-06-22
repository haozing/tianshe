import { describe, expect, it, vi, type Mock } from 'vitest';
import { ProfileService } from './profile-service';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      storagePath: '',
      flushStorageData: vi.fn(),
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
      },
    })),
  },
}));

interface PreparedStatementMock {
  sql: string;
  bind: Mock;
  run: Mock;
  destroySync: Mock;
}

describe('ProfileService persistent partitions', () => {
  it('creates profile-backed browser storage with persist:profile-* partitions', async () => {
    const preparedStatements: PreparedStatementMock[] = [];
    const conn = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const stmt: PreparedStatementMock = {
          sql,
          bind: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          destroySync: vi.fn(),
        };
        preparedStatements.push(stmt);
        return stmt;
      }),
    };
    const service = new ProfileService(conn as never);
    vi.spyOn(service, 'get').mockImplementation(async (id: string) => ({
      id,
      name: 'Persistent Login Profile',
      runtimeId: 'electron-webcontents',
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

    await service.create({
      name: 'Persistent Login Profile',
      runtimeId: 'electron-webcontents',
    });

    const insertStatement = preparedStatements.find((stmt) =>
      stmt.sql.includes('INSERT INTO browser_profiles')
    );
    expect(insertStatement).toBeDefined();
    const bindArgs = insertStatement?.bind.mock.calls[0]?.[0] as unknown[];
    const profileId = bindArgs[0];
    const partition = bindArgs[5];
    expect(profileId).toEqual(expect.any(String));
    expect(partition).toBe(`persist:profile-${profileId}`);
  });
});
