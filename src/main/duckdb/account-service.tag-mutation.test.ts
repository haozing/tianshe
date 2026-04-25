import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from './account-service';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

function buildReader(columns: string[], rows: unknown[][]) {
  return {
    columnNames: () => columns,
    getRows: () => rows,
  };
}

type AccountRecord = {
  id: string;
  tags: string[];
};

function createTransactionalConn(
  initialAccounts: AccountRecord[],
  options?: { failOnUpdateId?: string }
) {
  let accounts = initialAccounts.map((account) => ({
    ...account,
    tags: [...account.tags],
  }));
  let snapshot: AccountRecord[] | null = null;
  const transactionCommands: string[] = [];

  const conn = {
    run: vi.fn(async (sql: string) => {
      transactionCommands.push(sql);
      if (sql === 'BEGIN TRANSACTION') {
        snapshot = accounts.map((account) => ({
          ...account,
          tags: [...account.tags],
        }));
        return;
      }
      if (sql === 'COMMIT') {
        snapshot = null;
        return;
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          accounts = snapshot.map((account) => ({
            ...account,
            tags: [...account.tags],
          }));
        }
        snapshot = null;
      }
    }),
    runAndReadAll: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, tags') && sql.includes('FROM accounts')) {
        return buildReader(
          ['id', 'tags'],
          accounts.map((account) => [account.id, JSON.stringify(account.tags)])
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    prepare: vi.fn(async (sql: string) => {
      let bindings: unknown[] = [];
      return {
        bind: vi.fn((values: unknown[]) => {
          bindings = values;
        }),
        run: vi.fn(async () => {
          if (!sql.includes('UPDATE accounts')) {
            throw new Error(`Unexpected statement SQL: ${sql}`);
          }

          const [tagsJson, id] = bindings as [string, string];
          if (options?.failOnUpdateId && id === options.failOnUpdateId) {
            throw new Error(`update failed for ${id}`);
          }

          const account = accounts.find((item) => item.id === id);
          if (!account) {
            throw new Error(`Account not found: ${id}`);
          }
          account.tags = JSON.parse(tagsJson);
        }),
        destroySync: vi.fn(),
      };
    }),
  };

  return {
    conn,
    transactionCommands,
    getAccounts: () =>
      accounts.map((account) => ({
        ...account,
        tags: [...account.tags],
      })),
  };
}

describe('AccountService tag mutation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames tags across accounts while preserving order and de-duplicating the target tag', async () => {
    const state = createTransactionalConn([
      { id: 'acc-1', tags: ['旧标签', '保留'] },
      { id: 'acc-2', tags: ['保留', '旧标签', '新标签', '旧标签'] },
      { id: 'acc-3', tags: ['无关'] },
    ]);
    const service = new AccountService(state.conn as never);

    const affected = await service.renameTagAcrossAccounts('旧标签', '新标签');

    expect(affected).toBe(2);
    expect(state.transactionCommands).toEqual(['BEGIN TRANSACTION', 'COMMIT']);
    expect(state.getAccounts()).toEqual([
      { id: 'acc-1', tags: ['新标签', '保留'] },
      { id: 'acc-2', tags: ['保留', '新标签'] },
      { id: 'acc-3', tags: ['无关'] },
    ]);
  });

  it('removes tags from all affected accounts', async () => {
    const state = createTransactionalConn([
      { id: 'acc-1', tags: ['主号', '待登录'] },
      { id: 'acc-2', tags: ['待登录', '备用'] },
    ]);
    const service = new AccountService(state.conn as never);

    const affected = await service.removeTagFromAccounts('待登录');

    expect(affected).toBe(2);
    expect(state.transactionCommands).toEqual(['BEGIN TRANSACTION', 'COMMIT']);
    expect(state.getAccounts()).toEqual([
      { id: 'acc-1', tags: ['主号'] },
      { id: 'acc-2', tags: ['备用'] },
    ]);
  });

  it('rolls back account tag mutations when an update fails mid-transaction', async () => {
    const state = createTransactionalConn(
      [
        { id: 'acc-1', tags: ['旧标签', '保留'] },
        { id: 'acc-2', tags: ['旧标签', '待处理'] },
      ],
      { failOnUpdateId: 'acc-2' }
    );
    const service = new AccountService(state.conn as never);

    await expect(service.renameTagAcrossAccounts('旧标签', '新标签')).rejects.toThrow(
      'update failed for acc-2'
    );

    expect(state.transactionCommands).toEqual(['BEGIN TRANSACTION', 'ROLLBACK']);
    expect(state.getAccounts()).toEqual([
      { id: 'acc-1', tags: ['旧标签', '保留'] },
      { id: 'acc-2', tags: ['旧标签', '待处理'] },
    ]);
  });
});
