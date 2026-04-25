import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SavedSiteService } from './saved-site-service';

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

describe('SavedSiteService', () => {
  let conn: {
    prepare: Mock;
    runAndReadAll: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conn = {
      prepare: vi.fn().mockImplementation((sql: string) => createStatement(sql)),
      runAndReadAll: vi.fn(),
    };
  });

  it('should reject duplicated platform name on create', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM saved_sites') && sql.includes('WHERE name = ?')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['site-existing']]));
      }
      return stmt;
    });

    const service = new SavedSiteService(conn as never);

    await expect(
      service.create({
        name: '淘宝',
        url: 'https://login.taobao.com',
      })
    ).rejects.toThrow('已存在');

    const insertCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO saved_sites')
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('should reject duplicated platform name on update', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('FROM saved_sites') && sql.includes('id <> ?')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['id'], [['site-conflict']]));
      }
      return stmt;
    });

    const service = new SavedSiteService(conn as never);

    await expect(
      service.update('site-current', {
        name: '京东',
      })
    ).rejects.toThrow('已存在');

    const updateCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('UPDATE saved_sites SET')
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('should query getByName with deterministic ordering', async () => {
    const service = new SavedSiteService(conn as never);

    await service.getByName('抖音');

    const firstSql = conn.prepare.mock.calls[0]?.[0] as string;
    expect(firstSql).toContain('ORDER BY created_at ASC, id ASC');
  });

  it('should delete platform when no accounts reference it', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('COUNT(*) AS reference_count')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['reference_count'], [[0]]));
      }
      return stmt;
    });

    const service = new SavedSiteService(conn as never);

    await service.delete('site-free');

    const deleteCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('DELETE FROM saved_sites')
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('should reject delete when platform is still referenced by accounts', async () => {
    conn.prepare.mockImplementation((sql: string) => {
      const stmt = createStatement(sql);
      if (sql.includes('COUNT(*) AS reference_count')) {
        stmt.runAndReadAll.mockResolvedValue(buildReader(['reference_count'], [[3]]));
      }
      return stmt;
    });

    const service = new SavedSiteService(conn as never);

    await expect(service.delete('site-busy')).rejects.toThrow('平台仍被 3 个账号引用');

    const deleteCalls = conn.prepare.mock.calls.filter(([sql]: [string]) =>
      sql.includes('DELETE FROM saved_sites')
    );
    expect(deleteCalls).toHaveLength(0);
  });
});
