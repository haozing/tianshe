import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AccountService } from './account-service';
import { UNBOUND_PROFILE_ID } from '../../types/profile';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

interface StatementMock {
  sql: string;
  bind: Mock;
  run: Mock;
  runAndReadAll: Mock;
  destroySync: Mock;
}

function buildReader(columns: string[], rows: unknown[][]) {
  return {
    columnNames: () => columns,
    getRows: () => rows,
  };
}

function createStatement(sql: string): StatementMock {
  return {
    sql,
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
    runAndReadAll: vi.fn().mockResolvedValue(buildReader([], [])),
    destroySync: vi.fn(),
  };
}

describe('AccountService reference validation', () => {
  let conn: {
    prepare: Mock;
    run: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conn = {
      prepare: vi.fn().mockImplementation((sql: string) => createStatement(sql)),
      run: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('rejects account creation when the bound profile does not exist', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM browser_profiles')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], []));
      }
      return stmt;
    });

    const service = new AccountService(conn as never);

    await expect(
      service.create({
        profileId: 'missing-profile',
        name: 'demo-account',
        loginUrl: 'https://account.example/login',
      })
    ).rejects.toThrow('绑定的浏览器环境不存在');

    const insertCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO accounts')
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects account creation when the bound platform does not exist', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM browser_profiles')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['profile-1']]));
      }
      if (sql.includes('FROM saved_sites')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], []));
      }
      return stmt;
    });

    const service = new AccountService(conn as never);

    await expect(
      service.create({
        profileId: 'profile-1',
        platformId: 'missing-platform',
        name: 'demo-account',
        loginUrl: 'https://account.example/login',
      })
    ).rejects.toThrow('绑定的平台不存在');

    const insertCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO accounts')
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects account creation when the selected profile already binds the same platform', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM browser_profiles')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['profile-1']]));
      }
      if (sql.includes('FROM saved_sites')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['site-1']]));
      }
      if (sql.includes('FROM accounts')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['existing-account']]));
      }
      return stmt;
    });

    const service = new AccountService(conn as never);

    await expect(
      service.create({
        profileId: 'profile-1',
        platformId: 'site-1',
        name: 'demo-account',
        loginUrl: 'https://account.example/login',
      })
    ).rejects.toThrow('所选浏览器环境已绑定该平台账号');

    const insertCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO accounts')
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects account updates when the target platform does not exist', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM saved_sites')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], []));
      }
      return stmt;
    });

    const service = new AccountService(conn as never);
    vi.spyOn(service as never, 'assertMutableAccount' as never).mockResolvedValue({
      id: 'acc-1',
      profileId: UNBOUND_PROFILE_ID,
      name: 'demo-account',
      loginUrl: 'https://account.example/login',
      tags: [],
      createdAt: new Date('2026-02-17T00:00:00.000Z'),
      updatedAt: new Date('2026-02-17T00:00:00.000Z'),
    } as never);

    await expect(
      service.update('acc-1', {
        platformId: 'missing-platform',
      })
    ).rejects.toThrow('绑定的平台不存在');

    const updateCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('UPDATE accounts SET')
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('rejects account updates when the target profile already binds the same platform', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM saved_sites')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['site-1']]));
      }
      if (sql.includes('FROM accounts')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['existing-account']]));
      }
      return stmt;
    });

    const service = new AccountService(conn as never);
    vi.spyOn(service as never, 'assertMutableAccount' as never).mockResolvedValue({
      id: 'acc-1',
      profileId: 'profile-1',
      platformId: 'site-2',
      name: 'demo-account',
      loginUrl: 'https://account.example/login',
      tags: [],
      createdAt: new Date('2026-02-17T00:00:00.000Z'),
      updatedAt: new Date('2026-02-17T00:00:00.000Z'),
    } as never);

    await expect(
      service.update('acc-1', {
        platformId: 'site-1',
      })
    ).rejects.toThrow('所选浏览器环境已绑定该平台账号');

    const updateCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('UPDATE accounts SET')
    );
    expect(updateCalls).toHaveLength(0);
  });
});
