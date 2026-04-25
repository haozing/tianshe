import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcMainHandle } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
}));

vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })),
}));

import { QueryTemplateIPCHandler } from './query-template-handler';
import type { DuckDBService } from '../duckdb/service';

describe('QueryTemplateIPCHandler', () => {
  let handlers: Map<string, Function>;
  let duckdb: DuckDBService;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    mockIpcMainHandle.mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    duckdb = {
      createQueryTemplate: vi.fn(),
      listQueryTemplates: vi.fn(),
      getQueryTemplate: vi.fn(),
      updateQueryTemplate: vi.fn(),
      refreshQueryTemplateSnapshot: vi.fn(),
      deleteQueryTemplate: vi.fn(),
      reorderQueryTemplates: vi.fn(),
      ensureDatasetAttached: vi.fn(),
      executeSQLWithParams: vi.fn(),
      queryDataset: vi.fn(),
      previewQuerySQL: vi.fn(),
      getOrCreateDefaultQueryTemplate: vi.fn(),
    } as unknown as DuckDBService;

    const handler = new QueryTemplateIPCHandler(duckdb);
    handler.register();
  });

  it('register should expose query-template channels only', () => {
    const expectedChannels = [
      'query-template:create',
      'query-template:list',
      'query-template:get',
      'query-template:update',
      'query-template:refresh',
      'query-template:delete',
      'query-template:reorder',
      'query-template:query',
      'query-template:get-or-create-default',
    ];

    expectedChannels.forEach((channel) => {
      expect(handlers.has(channel)).toBe(true);
    });
  });

  it('query-template:create should return templateId', async () => {
    (duckdb.createQueryTemplate as any).mockResolvedValue('tpl_1');
    const handler = handlers.get('query-template:create')!;

    const result = await handler({} as any, {
      datasetId: 'ds1',
      name: 'Template 1',
      queryConfig: {},
      generatedSQL: 'SELECT 1',
    });

    expect(duckdb.createQueryTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: 'ds1',
        name: 'Template 1',
      })
    );
    expect(result).toEqual({
      success: true,
      templateId: 'tpl_1',
    });
  });

  it('query-template:list should return templates', async () => {
    (duckdb.listQueryTemplates as any).mockResolvedValue([{ id: 'tpl_1' }]);
    const handler = handlers.get('query-template:list')!;

    const result = await handler({} as any, 'ds1');

    expect(duckdb.listQueryTemplates).toHaveBeenCalledWith('ds1');
    expect(result).toEqual({
      success: true,
      templates: [{ id: 'tpl_1' }],
    });
  });

  it('query-template:get should return template', async () => {
    (duckdb.getQueryTemplate as any).mockResolvedValue({
      id: 'tpl_1',
      datasetId: 'ds1',
      queryConfig: {},
    });
    const handler = handlers.get('query-template:get')!;

    const result = await handler({} as any, 'tpl_1');

    expect(duckdb.getQueryTemplate).toHaveBeenCalledWith('tpl_1');
    expect(result).toEqual({
      success: true,
      template: {
        id: 'tpl_1',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });
  });

  it('query-template:update should require templateId', async () => {
    const handler = handlers.get('query-template:update')!;
    const result = await handler({} as any, {
      queryConfig: {},
    });

    expect(result).toEqual({
      success: false,
      error: 'templateId is required',
    });
    expect(duckdb.updateQueryTemplate).not.toHaveBeenCalled();
  });

  it('query-template:update should forward templateId to updateQueryTemplate', async () => {
    (duckdb.updateQueryTemplate as any).mockResolvedValue(undefined);
    const handler = handlers.get('query-template:update')!;

    const result = await handler({} as any, {
      templateId: 'tpl_1',
      queryConfig: { filter: { conditions: [] } },
      generatedSQL: 'SELECT * FROM t',
    });

    expect(duckdb.updateQueryTemplate).toHaveBeenCalledWith('tpl_1', {
      name: undefined,
      description: undefined,
      icon: undefined,
      queryConfig: { filter: { conditions: [] } },
      generatedSQL: 'SELECT * FROM t',
    });
    expect(result).toEqual({ success: true });
  });

  it('query-template:refresh should require templateId', async () => {
    const handler = handlers.get('query-template:refresh')!;
    const result = await handler({} as any, {});

    expect(result).toEqual({
      success: false,
      error: 'templateId is required',
    });
    expect(duckdb.refreshQueryTemplateSnapshot).not.toHaveBeenCalled();
  });

  it('query-template:refresh should forward templateId to refreshQueryTemplateSnapshot', async () => {
    (duckdb.refreshQueryTemplateSnapshot as any).mockResolvedValue(undefined);
    const handler = handlers.get('query-template:refresh')!;

    const result = await handler({} as any, { templateId: 'tpl_1' });

    expect(duckdb.refreshQueryTemplateSnapshot).toHaveBeenCalledWith('tpl_1');
    expect(result).toEqual({ success: true });
  });

  it('query-template:reorder should require templateIds', async () => {
    const handler = handlers.get('query-template:reorder')!;
    const result = await handler({} as any, {
      datasetId: 'ds1',
    });

    expect(result).toEqual({
      success: false,
      error: 'templateIds is required',
    });
    expect(duckdb.reorderQueryTemplates).not.toHaveBeenCalled();
  });

  it('query-template:reorder should forward templateIds to reorderQueryTemplates', async () => {
    (duckdb.reorderQueryTemplates as any).mockResolvedValue(undefined);
    const handler = handlers.get('query-template:reorder')!;

    const result = await handler({} as any, {
      datasetId: 'ds1',
      templateIds: ['tpl_1', 'tpl_2'],
    });

    expect(duckdb.reorderQueryTemplates).toHaveBeenCalledWith('ds1', ['tpl_1', 'tpl_2']);
    expect(result).toEqual({ success: true });
  });

  it('query-template:query should require templateId', async () => {
    const handler = handlers.get('query-template:query')!;
    const result = await handler({} as any, {});

    expect(result).toEqual({
      success: false,
      error: 'templateId is required',
    });
  });

  it('query-template:query should return paged result', async () => {
    (duckdb.getQueryTemplate as any).mockResolvedValue({
      id: 'tpl_1',
      datasetId: 'ds1',
      snapshotTableName: 'snapshot_1',
    });
    (duckdb.executeSQLWithParams as any).mockResolvedValue([{ total: 7 }]);
    (duckdb.queryDataset as any).mockResolvedValue({
      columns: ['id'],
      rows: [{ id: 1 }],
      rowCount: 1,
    });

    const handler = handlers.get('query-template:query')!;
    const result = await handler({} as any, {
      templateId: 'tpl_1',
      offset: 2,
      limit: 3,
    });

    expect(duckdb.getQueryTemplate).toHaveBeenCalledWith('tpl_1');
    expect(duckdb.ensureDatasetAttached).toHaveBeenCalledWith('ds1');
    expect(duckdb.queryDataset).toHaveBeenCalledWith(
      'ds1',
      expect.stringContaining('SELECT * FROM "ds_ds1"."snapshot_1" ORDER BY rowid'),
      2,
      3
    );
    expect(result).toEqual({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
        filteredTotalCount: 7,
      },
    });
  });

  it('query-template:query should execute the default template as a live query', async () => {
    (duckdb.getQueryTemplate as any).mockResolvedValue({
      id: 'default_tpl',
      datasetId: 'ds1',
      isDefault: true,
      queryConfig: {
        filter: {
          conditions: [{ type: 'equal', field: 'status', value: 'active' }],
        },
      },
    });
    (duckdb.previewQuerySQL as any).mockResolvedValue({
      success: true,
      sql: 'SELECT * FROM "ds_ds1"."data" WHERE "status" = \'active\' LIMIT 1000000',
    });
    (duckdb.executeSQLWithParams as any).mockResolvedValue([{ total: 4 }]);
    (duckdb.queryDataset as any).mockResolvedValue({
      columns: ['id'],
      rows: [{ id: 2 }],
      rowCount: 1,
    });

    const handler = handlers.get('query-template:query')!;
    const result = await handler({} as any, {
      templateId: 'default_tpl',
      offset: 1,
      limit: 2,
    });

    expect(duckdb.previewQuerySQL).toHaveBeenCalledWith('ds1', {
      filter: {
        conditions: [{ type: 'equal', field: 'status', value: 'active' }],
      },
    });
    expect(duckdb.executeSQLWithParams).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*) as total FROM (SELECT * FROM "ds_ds1"."data"'),
      []
    );
    expect(duckdb.queryDataset).toHaveBeenCalledWith(
      'ds1',
      expect.stringContaining('LIMIT 2 OFFSET 1')
    );
    expect(result).toEqual({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 2 }],
        rowCount: 1,
        filteredTotalCount: 4,
      },
    });
  });

  it('query-template:query should use the snapshot path for default templates with sampling', async () => {
    (duckdb.getQueryTemplate as any).mockResolvedValue({
      id: 'default_sample_tpl',
      datasetId: 'ds1',
      isDefault: true,
      queryConfig: {
        sample: {
          type: 'rows',
          value: 10,
        },
      },
      snapshotTableName: 'snapshot_sample_1',
    });
    (duckdb.executeSQLWithParams as any).mockResolvedValue([{ total: 10 }]);
    (duckdb.queryDataset as any).mockResolvedValue({
      columns: ['id'],
      rows: [{ id: 3 }],
      rowCount: 1,
    });

    const handler = handlers.get('query-template:query')!;
    const result = await handler({} as any, {
      templateId: 'default_sample_tpl',
      offset: 0,
      limit: 5,
    });

    expect(duckdb.previewQuerySQL).not.toHaveBeenCalled();
    expect(duckdb.queryDataset).toHaveBeenCalledWith(
      'ds1',
      expect.stringContaining('SELECT * FROM "ds_ds1"."snapshot_sample_1" ORDER BY rowid'),
      0,
      5
    );
    expect(result).toEqual({
      success: true,
      result: {
        columns: ['id'],
        rows: [{ id: 3 }],
        rowCount: 1,
        filteredTotalCount: 10,
      },
    });
  });

  it('query-template:get-or-create-default should return template', async () => {
    (duckdb.getOrCreateDefaultQueryTemplate as any).mockResolvedValue({
      id: 'default_tpl',
      datasetId: 'ds1',
      queryConfig: {},
    });

    const handler = handlers.get('query-template:get-or-create-default')!;
    const result = await handler({} as any, 'ds1');

    expect(duckdb.getOrCreateDefaultQueryTemplate).toHaveBeenCalledWith('ds1');
    expect(result).toEqual({
      success: true,
      template: {
        id: 'default_tpl',
        datasetId: 'ds1',
        queryConfig: {},
      },
    });
  });
});




