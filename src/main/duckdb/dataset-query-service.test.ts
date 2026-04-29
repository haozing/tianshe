import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatasetQueryService } from './dataset-query-service';

describe('DatasetQueryService', () => {
  let lastExecutedSql: string | null;

  beforeEach(() => {
    lastExecutedSql = null;
  });

  const createService = () => {
    const conn = {
      runAndReadAll: vi.fn(async (sql: string) => {
        lastExecutedSql = sql;
        return {
          columnNames: () => [],
          getRows: () => [],
        };
      }),
      prepare: vi.fn(async () => ({
        bind: vi.fn(),
        run: vi.fn(async () => undefined),
        destroySync: vi.fn(),
      })),
    } as any;

    const metadataService = {
      getDatasetInfo: vi.fn(async (id: string) => ({ id, filePath: 'C:\\tmp\\x.duckdb' })),
    } as any;

    const schemaService = {
      extractComputedColumns: vi.fn(() => []),
      wrapWithComputedColumns: vi.fn((sql: string) => sql),
    } as any;

    const storageService = {
      executeInQueue: vi.fn(async (_id: string, fn: () => Promise<any>) => fn()),
      executeInQueues: vi.fn(async (_ids: string[], fn: () => Promise<any>) => fn()),
      smartAttach: vi.fn(async () => undefined),
    } as any;

    const service = new DatasetQueryService(conn, metadataService, schemaService, storageService);
    return { service, storageService };
  };

  it('rejects mutating SQL passed through the query endpoint', async () => {
    const { service } = createService();

    await expect(
      service.queryDataset('plugin__doudian_combo__products', 'DELETE FROM data WHERE "task_id" = 1')
    ).rejects.toThrow(/read-only|DELETE/i);

    expect(lastExecutedSql).toBeNull();
  });

  it('rejects multi-statement SQL passed through the query endpoint', async () => {
    const { service } = createService();

    await expect(
      service.queryDataset(
        'plugin__doudian_combo__products',
        "SELECT * FROM data WHERE name = 'safe'; UPDATE data SET name = 'unsafe'"
      )
    ).rejects.toThrow(/single/i);

    expect(lastExecutedSql).toBeNull();
  });

  it('allows read-only SQL that mentions mutating keywords inside string literals', async () => {
    const { service } = createService();
    await service.queryDataset(
      'plugin__doudian_combo__products',
      "SELECT * FROM data WHERE note = 'please do not update this row'"
    );

    expect(lastExecutedSql).toBeTruthy();
    expect(lastExecutedSql).toContain('SELECT * FROM "ds_plugin__doudian_combo__products"."data"');
    expect(lastExecutedSql).toMatch(/\bLIMIT\b/i);
    expect(lastExecutedSql).toMatch(/\bOFFSET\b/i);
  });

  it('appends LIMIT/OFFSET to SELECT statements that lack LIMIT', async () => {
    const { service } = createService();
    await service.queryDataset('plugin__doudian_combo__products', 'SELECT * FROM data');

    expect(lastExecutedSql).toBeTruthy();
    expect(lastExecutedSql).toContain('SELECT * FROM "ds_plugin__doudian_combo__products"."data"');
    expect(lastExecutedSql).toMatch(/\bLIMIT\b/i);
    expect(lastExecutedSql).toMatch(/\bOFFSET\b/i);
  });

  it('uses _row_id ordering for direct dataset browsing queries', async () => {
    const { service } = createService();
    await service.queryDataset('plugin__doudian_combo__products');

    expect(lastExecutedSql).toBeTruthy();
    expect(lastExecutedSql).toContain('FROM "ds_plugin__doudian_combo__products"."data"');
    expect(lastExecutedSql).toMatch(/\bORDER BY\s+_row_id\s+ASC\b/i);
    expect(lastExecutedSql).toMatch(/\bLIMIT\b/i);
    expect(lastExecutedSql).toMatch(/\bOFFSET\b/i);
  });

  it('rejects invalid pagination values before SQL execution', async () => {
    const { service } = createService();

    await expect(
      service.queryDataset('plugin__doudian_combo__products', undefined, 0, 10001)
    ).rejects.toThrow(/limit/i);

    expect(lastExecutedSql).toBeNull();
  });

  it.each([
    [
      'previewFilterCount',
      (service: DatasetQueryService) => service.previewFilterCount('dataset-1', { conditions: [] }),
    ],
    [
      'previewAggregate',
      (service: DatasetQueryService) =>
        service.previewAggregate('dataset-1', { groupBy: ['status'], measures: [] }),
    ],
    [
      'previewSample',
      (service: DatasetQueryService) =>
        service.previewSample('dataset-1', { type: 'rows', value: 10 }),
    ],
    [
      'previewGroup',
      (service: DatasetQueryService) =>
        service.previewGroup('dataset-1', { field: 'status', order: 'asc' }),
    ],
  ])('auto-attaches dataset before %s', async (_name, invoke) => {
    const { service, storageService } = createService();
    service.setQueryEngine({
      previewFilterCount: vi.fn(async () => ({ matchedRows: 0 })),
      preview: {
        previewAggregate: vi.fn(async () => ({ stats: {} })),
        previewSample: vi.fn(async () => ({ stats: {} })),
        previewLookup: vi.fn(async () => ({ stats: {} })),
        previewGroup: vi.fn(async () => ({ stats: {} })),
      },
    } as any);

    await invoke(service);

    expect(storageService.smartAttach).toHaveBeenCalledWith('dataset-1', 'C:\\\\tmp\\\\x.duckdb');
  });

  it('previewLookup acquires all dataset queues in one stable pass and forwards lookup arrays', async () => {
    const { service, storageService } = createService();
    const previewLookup = vi.fn(async () => ({ stats: {} }));
    service.setQueryEngine({
      preview: {
        previewLookup,
      },
    } as any);

    await service.previewLookup(
      'dataset-main',
      [
        {
          type: 'join',
          joinKey: 'category',
          lookupKey: 'code',
          lookupDatasetId: 'dataset-lookup',
        },
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_label',
          codeMapping: { active: 'ACTIVE' },
        },
      ],
      { limit: 5 }
    );

    expect(storageService.executeInQueues).toHaveBeenCalledWith(
      ['dataset-main', 'dataset-lookup'],
      expect.any(Function)
    );
    expect(storageService.smartAttach).toHaveBeenCalledWith(
      'dataset-main',
      'C:\\\\tmp\\\\x.duckdb'
    );
    expect(storageService.smartAttach).toHaveBeenCalledWith(
      'dataset-lookup',
      'C:\\\\tmp\\\\x.duckdb'
    );
    expect(previewLookup).toHaveBeenCalledWith(
      'dataset-main',
      expect.arrayContaining([
        expect.objectContaining({ lookupDatasetId: 'dataset-lookup' }),
        expect.objectContaining({ lookupKey: 'status_label' }),
      ]),
      { limit: 5 }
    );
  });
});
