import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProfileService } from './profile-service';
import { UNBOUND_PROFILE_ID } from '../../types/profile';

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

interface PreparedStatementMock {
  sql: string;
  bind: Mock;
  run: Mock;
  destroySync: Mock;
}

describe('ProfileService.deleteWithCascade', () => {
  let service: ProfileService;
  let conn: {
    run: Mock;
    prepare: Mock;
  };
  let preparedStatements: PreparedStatementMock[];

  beforeEach(() => {
    vi.clearAllMocks();
    preparedStatements = [];

    conn = {
      run: vi.fn().mockResolvedValue(undefined),
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

    service = new ProfileService(conn as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'profile-1',
      name: 'Test Profile',
      partition: 'persist:test-profile-1',
      status: 'idle',
      isSystem: false,
    } as never);
    vi.spyOn(service as never, 'purgePartitionData').mockResolvedValue(undefined);
    vi.spyOn(service as never, 'purgeExtensionProfileData').mockResolvedValue(undefined);
  });

  it('should mark accounts as unbound before deleting profile', async () => {
    await service.deleteWithCascade('profile-1');

    expect(conn.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
    expect(conn.run).toHaveBeenCalledWith('COMMIT');
    expect(conn.run).not.toHaveBeenCalledWith('ROLLBACK');

    const markAccountStmt = preparedStatements.find((stmt) => stmt.sql.includes('UPDATE accounts'));
    const deleteProfileStmt = preparedStatements.find((stmt) =>
      stmt.sql.includes('DELETE FROM browser_profiles')
    );

    expect(markAccountStmt).toBeDefined();
    expect(deleteProfileStmt).toBeDefined();

    expect(markAccountStmt?.bind).toHaveBeenCalledWith([UNBOUND_PROFILE_ID, 'profile-1']);
    expect(deleteProfileStmt?.bind).toHaveBeenCalledWith(['profile-1']);
  });

  it('should rollback transaction when deletion fails', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const shouldFail = sql.includes('UPDATE accounts');
      const stmt: PreparedStatementMock = {
        sql,
        bind: vi.fn(),
        run: shouldFail
          ? vi.fn().mockRejectedValue(new Error('forced failure on accounts update'))
          : vi.fn().mockResolvedValue(undefined),
        destroySync: vi.fn(),
      };
      preparedStatements.push(stmt);
      return stmt;
    });

    await expect(service.deleteWithCascade('profile-1')).rejects.toThrow('forced failure');

    expect(conn.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
    expect(conn.run).toHaveBeenCalledWith('ROLLBACK');
    expect(conn.run).not.toHaveBeenCalledWith('COMMIT');
    expect((service as never).purgePartitionData).not.toHaveBeenCalled();
    expect((service as never).purgeExtensionProfileData).not.toHaveBeenCalled();
  });
});
