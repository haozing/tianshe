import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ExtensionPackagesService } from './extension-packages-service';
import { parseRows } from './utils';

interface PreparedStatementMock {
  bind: Mock;
  run: Mock;
  runAndReadAll: Mock;
  destroySync: Mock;
}

function createStatement(overrides?: Partial<PreparedStatementMock>): PreparedStatementMock {
  return {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
    runAndReadAll: vi.fn(),
    destroySync: vi.fn(),
    ...overrides,
  };
}

function createTransactionalConn(statements: PreparedStatementMock[]) {
  const transactionCommands: string[] = [];
  return {
    transactionCommands,
    conn: {
      run: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN TRANSACTION' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          transactionCommands.push(sql);
        }
      }),
      prepare: vi.fn().mockImplementation(async () => {
        const next = statements.shift();
        if (!next) {
          throw new Error('No prepared statement mock available');
        }
        return next;
      }),
    },
  };
}

function createReader(rows: Array<Record<string, unknown>>) {
  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    columnNames: () => columnNames,
    getRows: () => rows.map((row) => columnNames.map((name) => row[name])),
  };
}

describe('ExtensionPackagesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ensures extension repository tables before serving requests', async () => {
    const conn = {
      run: vi.fn().mockResolvedValue(undefined),
      runAndReadAll: vi.fn().mockResolvedValue(createReader([])),
    };
    const service = new ExtensionPackagesService(conn as never);

    await service.listPackages();

    expect(conn.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS extension_packages')
    );
    expect(conn.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS profile_extensions')
    );
    expect(conn.runAndReadAll).toHaveBeenCalledWith(
      expect.stringContaining('FROM extension_packages')
    );
  });

  it('rejects missing versioned packages before writing dangling bindings', async () => {
    const { conn, transactionCommands } = createTransactionalConn([]);
    const service = new ExtensionPackagesService(conn as never);
    vi.spyOn(service, 'getPackageByExtensionVersion').mockResolvedValue(null);

    await expect(
      service.bindPackagesToProfiles(
        ['profile-1'],
        [
          {
            extensionId: 'ext.demo',
            version: '1.0.0',
          },
        ]
      )
    ).rejects.toThrow('Extension package not found or disabled: ext.demo@1.0.0');

    expect(conn.prepare).not.toHaveBeenCalled();
    expect(transactionCommands).toEqual(['BEGIN TRANSACTION', 'ROLLBACK']);
  });

  it('wraps batch bind writes in a transaction and rolls back on insert failure', async () => {
    const insertStmt = createStatement({
      run: vi.fn().mockRejectedValue(new Error('insert failed')),
    });
    const { conn, transactionCommands } = createTransactionalConn([insertStmt]);
    const service = new ExtensionPackagesService(conn as never);
    vi.spyOn(service, 'getLatestEnabledPackageByExtensionId').mockResolvedValue({
      id: 'pkg-1',
      extensionId: 'ext.demo',
      name: 'Demo',
      version: '2.0.0',
      sourceType: 'local',
      extractDir: 'C:\\tmp\\ext.demo\\2.0.0',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.bindPackagesToProfiles(
        ['profile-1'],
        [
          {
            extensionId: 'ext.demo',
          },
        ]
      )
    ).rejects.toThrow('insert failed');

    expect(transactionCommands).toEqual(['BEGIN TRANSACTION', 'ROLLBACK']);
  });

  it('wraps setProfileBindings in a transaction and rolls back when replace write fails', async () => {
    const deleteStmt = createStatement();
    const insertStmt = createStatement({
      run: vi.fn().mockRejectedValue(new Error('replace failed')),
    });
    const { conn, transactionCommands } = createTransactionalConn([deleteStmt, insertStmt]);
    const service = new ExtensionPackagesService(conn as never);
    vi.spyOn(service, 'getLatestEnabledPackageByExtensionId').mockResolvedValue({
      id: 'pkg-1',
      extensionId: 'ext.demo',
      name: 'Demo',
      version: '2.0.0',
      sourceType: 'local',
      extractDir: 'C:\\tmp\\ext.demo\\2.0.0',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.setProfileBindings('profile-1', [
        {
          extensionId: 'ext.demo',
        },
      ])
    ).rejects.toThrow('replace failed');

    expect(transactionCommands).toEqual(['BEGIN TRANSACTION', 'ROLLBACK']);
  });

  it('wraps batch unbind in a transaction and commits on success', async () => {
    const countStmt = createStatement({
      runAndReadAll: vi.fn().mockResolvedValue(createReader([{ total: 2 }])),
    });
    const deleteStmt = createStatement();
    const { conn, transactionCommands } = createTransactionalConn([countStmt, deleteStmt]);
    const service = new ExtensionPackagesService(conn as never);

    const removed = await service.unbindExtensionsFromProfiles(['profile-1'], ['ext.demo']);

    expect(removed).toBe(2);
    expect(transactionCommands).toEqual(['BEGIN TRANSACTION', 'COMMIT']);
  });

  it('returns removed package records before deleting packages', async () => {
    const listStmt = createStatement({
      runAndReadAll: vi.fn().mockResolvedValue(
        createReader([
          {
            id: 'pkg-1',
            extension_id: 'ext.demo',
            name: 'Demo',
            version: '1.0.0',
            source_type: 'cloud',
            source_url: 'https://example.test/ext.zip',
            archive_sha256: 'sha256',
            manifest_json: null,
            extract_dir: 'C:\\tmp\\ext.demo\\1.0.0',
            enabled: true,
            created_at: new Date('2026-03-20T00:00:00.000Z'),
            updated_at: new Date('2026-03-21T00:00:00.000Z'),
          },
        ])
      ),
    });
    const deleteStmt = createStatement();
    const { conn } = createTransactionalConn([listStmt, deleteStmt]);
    const service = new ExtensionPackagesService(conn as never);

    const removed = await service.removePackagesByExtensionIds(['ext.demo']);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      id: 'pkg-1',
      extensionId: 'ext.demo',
      version: '1.0.0',
      sourceType: 'cloud',
    });
  });

  it('repairs a legacy extension_packages table to the latest schema without migrations', async () => {
    const db = await DuckDBInstance.create(':memory:');
    const conn = await DuckDBConnection.create(db);
    try {
      await conn.run(`
        CREATE TABLE extension_packages (
          id              VARCHAR PRIMARY KEY,
          extension_id    VARCHAR NOT NULL,
          name            VARCHAR NOT NULL,
          version         VARCHAR NOT NULL,
          source_url      TEXT,
          archive_sha256  VARCHAR,
          manifest_json   JSON,
          extract_dir     VARCHAR NOT NULL,
          enabled         BOOLEAN DEFAULT TRUE,
          created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await conn.run(`
        INSERT INTO extension_packages (
          id, extension_id, name, version, source_url, archive_sha256,
          manifest_json, extract_dir, enabled
        ) VALUES (
          'pkg-legacy', 'ext.demo', 'Demo Legacy', '1.0.0',
          'https://example.test/ext.zip', 'sha256', NULL, 'C:\\temp\\ext.demo\\1.0.0', TRUE
        )
      `);

      const service = new ExtensionPackagesService(conn as never);
      const packages = await service.listPackages();

      expect(packages).toHaveLength(1);
      expect(packages[0]).toMatchObject({
        extensionId: 'ext.demo',
        version: '1.0.0',
        sourceType: 'local',
      });

      const tableInfo = parseRows(
        await conn.runAndReadAll(`PRAGMA table_info('extension_packages')`)
      );
      expect(tableInfo.some((row) => String(row.name) === 'source_type')).toBe(true);
    } finally {
      conn.closeSync();
      db.closeSync();
    }
  });
});
