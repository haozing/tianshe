/**
 * dataset-handler.test.ts - 数据集处理器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 使用 vi.hoisted 解决 mock 提升问题
const { mockIpcMainHandle, mockShowOpenDialog, mockShowSaveDialog } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
  mockShowOpenDialog: vi.fn(),
  mockShowSaveDialog: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  dialog: {
    showOpenDialog: mockShowOpenDialog,
    showSaveDialog: mockShowSaveDialog,
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{ id: 1 }]),
  },
}));

// Mock ipc-utils
vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })),
}));

import { DatasetIPCHandler } from './dataset-handler';
import type { DuckDBService } from '../duckdb/service';

describe('DatasetIPCHandler', () => {
  let handler: DatasetIPCHandler;
  let mockDuckDB: DuckDBService;
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // 捕获注册的处理器
    mockIpcMainHandle.mockImplementation((channel: string, h: Function) => {
      handlers.set(channel, h);
    });

    // 创建 mock DuckDBService
    mockDuckDB = {
      importDatasetFile: vi.fn(),
      cancelImport: vi.fn(),
      listDatasets: vi.fn(),
      getDatasetInfo: vi.fn(),
      queryDataset: vi.fn(),
      deleteDataset: vi.fn(),
      renameDataset: vi.fn(),
      createEmptyDataset: vi.fn(),
      listGroupTabs: vi.fn(),
      createGroupTabCopy: vi.fn(),
      reorderGroupTabs: vi.fn(),
      renameGroupTab: vi.fn(),
      insertRecord: vi.fn(),
      batchInsertRecords: vi.fn(),
      updateRecord: vi.fn(),
      batchUpdateRecords: vi.fn(),
      queryWithEngine: vi.fn(),
      previewQuerySQL: vi.fn(),
      previewClean: vi.fn(),
      previewDedupe: vi.fn(),
      updateColumnMetadata: vi.fn(),
      updateColumnDisplayConfig: vi.fn(),
      addColumn: vi.fn(),
      updateColumn: vi.fn(),
      deleteColumn: vi.fn(),
      reorderColumns: vi.fn(),
      hardDeleteRows: vi.fn(),
      analyzeDatasetTypes: vi.fn(),
      updateDatasetSchema: vi.fn(),
      previewFilterCount: vi.fn(),
      previewAggregate: vi.fn(),
      previewSample: vi.fn(),
      previewLookup: vi.fn(),
      validateComputeExpression: vi.fn(),
      previewGroup: vi.fn(),
      exportDataset: vi.fn(),
      importRecordsFromFile: vi.fn(),
    } as unknown as DuckDBService;

    // 创建处理器实例并注册
    handler = new DatasetIPCHandler(mockDuckDB);
    handler.register();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 创建 mock event
  const createMockEvent = () => ({
    sender: {
      send: vi.fn(),
    },
  });

  describe('处理器注册', () => {
    it('应该注册所有数据集相关处理器', () => {
      const expectedHandlers = [
        'duckdb:select-import-file',
        'duckdb:import-dataset-file',
        'duckdb:cancel-import',
        'duckdb:list-datasets',
        'duckdb:get-dataset-info',
        'duckdb:query-dataset',
        'duckdb:delete-dataset',
        'duckdb:rename-dataset',
        'duckdb:create-empty-dataset',
        'duckdb:list-group-tabs',
        'duckdb:create-group-tab-copy',
        'duckdb:reorder-group-tabs',
        'duckdb:rename-group-tab',
        'duckdb:insert-record',
        'duckdb:batch-insert-records',
        'duckdb:update-record',
        'duckdb:batch-update-records',
        'duckdb:execute-query',
        'duckdb:preview-query-sql',
        'duckdb:preview-clean',
        'duckdb:materialize-clean-to-new-columns',
        'duckdb:preview-dedupe',
        'duckdb:update-column-metadata',
        'duckdb:update-column-display-config',
        'duckdb:add-column',
        'duckdb:update-column',
        'duckdb:delete-column',
        'duckdb:reorder-columns',
        'duckdb:hard-delete-rows',
        'duckdb:validate-column-name',
        'duckdb:analyze-types',
        'duckdb:apply-schema',
        'duckdb:preview-filter-count',
        'duckdb:preview-aggregate',
        'duckdb:preview-sample',
        'duckdb:preview-lookup',
        'duckdb:validate-compute-expression',
        'duckdb:preview-group',
        'duckdb:select-export-path',
        'duckdb:export-dataset',
        'duckdb:import-records-from-file',
      ];

      for (const h of expectedHandlers) {
        expect(handlers.has(h)).toBe(true);
      }
    });
  });

  // ========== 文件选择测试 ==========

  describe('duckdb:select-import-file', () => {
    it('应该返回选中的文件路径', async () => {
      const h = handlers.get('duckdb:select-import-file')!;
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/path/to/file.csv'],
      });

      const result = await h();

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/path/to/file.csv');
    });

    it('应该处理取消选择', async () => {
      const h = handlers.get('duckdb:select-import-file')!;
      mockShowOpenDialog.mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await h();

      expect(result.success).toBe(false);
      expect(result.error).toBe('No file selected');
    });

    it('应该处理对话框错误', async () => {
      const h = handlers.get('duckdb:select-import-file')!;
      mockShowOpenDialog.mockRejectedValue(new Error('Dialog error'));

      const result = await h();

      expect(result.success).toBe(false);
    });
  });

  // ========== CSV 导入测试 ==========

  describe('duckdb:import-dataset-file', () => {
    it('应该成功导入 CSV', async () => {
      const h = handlers.get('duckdb:import-dataset-file')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.importDatasetFile as any).mockResolvedValue('dataset-123');

      const result = await h(mockEvent, '/path/to/file.csv', 'my-dataset', {
        folderId: 'folder-1',
      });

      expect(result.success).toBe(true);
      expect(result.datasetId).toBe('dataset-123');
      expect(mockEvent.sender.send).not.toHaveBeenCalled();
      expect(mockDuckDB.importDatasetFile).toHaveBeenCalledWith(
        '/path/to/file.csv',
        'my-dataset',
        { folderId: 'folder-1' },
        expect.any(Function)
      );
    });

    it('应该处理导入失败', async () => {
      const h = handlers.get('duckdb:import-dataset-file')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.importDatasetFile as any).mockRejectedValue(new Error('Import failed'));

      const result = await h(mockEvent, '/path/to/file.csv', 'my-dataset');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Import failed');
    });
  });

  describe('duckdb:cancel-import', () => {
    it('应该取消导入', async () => {
      const h = handlers.get('duckdb:cancel-import')!;
      const mockEvent = createMockEvent();

      const result = await h(mockEvent, 'dataset-123');

      expect(result.success).toBe(true);
      expect(mockDuckDB.cancelImport).toHaveBeenCalledWith('dataset-123');
    });
  });

  // ========== 数据集列表测试 ==========

  describe('duckdb:list-datasets', () => {
    it('应该返回数据集列表', async () => {
      const h = handlers.get('duckdb:list-datasets')!;
      const mockDatasets = [{ id: 'ds1', name: 'Dataset 1' }];
      (mockDuckDB.listDatasets as any).mockResolvedValue(mockDatasets);

      const result = await h();

      expect(result.success).toBe(true);
      expect(result.datasets).toEqual(mockDatasets);
    });
  });

  // ========== 数据集信息测试 ==========

  describe('duckdb:get-dataset-info', () => {
    it('应该返回数据集信息', async () => {
      const h = handlers.get('duckdb:get-dataset-info')!;
      const mockEvent = createMockEvent();
      const mockDataset = {
        id: 'ds1',
        name: 'Dataset 1',
        schema: [{ name: 'col1', duckdbType: 'VARCHAR', fieldType: 'text' }],
      };
      (mockDuckDB.getDatasetInfo as any).mockResolvedValue(mockDataset);

      const result = await h(mockEvent, 'ds1');

      expect(result.success).toBe(true);
      expect(result.dataset).toEqual(mockDataset);
    });

    it('应该处理数据集不存在', async () => {
      const h = handlers.get('duckdb:get-dataset-info')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.getDatasetInfo as any).mockResolvedValue(null);

      const result = await h(mockEvent, 'non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ========== 数据集查询测试 ==========

  describe('duckdb:query-dataset', () => {
    it('应该执行查询', async () => {
      const h = handlers.get('duckdb:query-dataset')!;
      const mockEvent = createMockEvent();
      const mockResult = { rows: [{ id: 1 }], total: 1 };
      (mockDuckDB.queryDataset as any).mockResolvedValue(mockResult);

      const result = await h(mockEvent, 'ds1', 'SELECT * FROM data', 0, 100);

      expect(result.success).toBe(true);
      expect(result.result).toEqual(mockResult);
      expect(mockDuckDB.queryDataset).toHaveBeenCalledWith('ds1', 'SELECT * FROM data', 0, 100);
    });
  });

  // ========== 数据集 CRUD 测试 ==========

  describe('duckdb:delete-dataset', () => {
    it('应该删除数据集', async () => {
      const h = handlers.get('duckdb:delete-dataset')!;
      const mockEvent = createMockEvent();

      const result = await h(mockEvent, 'ds1');

      expect(result.success).toBe(true);
      expect(mockDuckDB.deleteDataset).toHaveBeenCalledWith('ds1');
    });
  });

  describe('duckdb:rename-dataset', () => {
    it('应该重命名数据集', async () => {
      const h = handlers.get('duckdb:rename-dataset')!;
      const mockEvent = createMockEvent();

      const result = await h(mockEvent, 'ds1', 'New Name');

      expect(result.success).toBe(true);
      expect(mockDuckDB.renameDataset).toHaveBeenCalledWith('ds1', 'New Name');
    });
  });

  describe('duckdb:create-empty-dataset', () => {
    it('应该创建空数据集', async () => {
      const h = handlers.get('duckdb:create-empty-dataset')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.createEmptyDataset as any).mockResolvedValue('new-ds-123');

      const result = await h(mockEvent, 'New Dataset', { folderId: 'folder-1' });

      expect(result.success).toBe(true);
      expect(result.datasetId).toBe('new-ds-123');
      expect(mockDuckDB.createEmptyDataset).toHaveBeenCalledWith('New Dataset', {
        folderId: 'folder-1',
      });
    });
  });

  describe('duckdb:list-group-tabs', () => {
    it('应该返回组内 Tab 列表', async () => {
      const h = handlers.get('duckdb:list-group-tabs')!;
      const mockEvent = createMockEvent();
      const tabs = [
        {
          datasetId: 'ds1',
          tabGroupId: 'grp1',
          name: '主表',
          rowCount: 10,
          columnCount: 3,
          tabOrder: 0,
          isGroupDefault: true,
        },
      ];
      (mockDuckDB.listGroupTabs as any).mockResolvedValue(tabs);

      const result = await h(mockEvent, 'ds1');

      expect(result.success).toBe(true);
      expect(result.tabs).toEqual(tabs);
      expect(mockDuckDB.listGroupTabs).toHaveBeenCalledWith('ds1');
    });
  });

  describe('duckdb:create-group-tab-copy', () => {
    it('应该创建组内副本 Tab', async () => {
      const h = handlers.get('duckdb:create-group-tab-copy')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.createGroupTabCopy as any).mockResolvedValue({
        datasetId: 'ds-copy',
        tabGroupId: 'grp1',
      });

      const result = await h(mockEvent, 'ds1', 'ds1 副本');

      expect(result.success).toBe(true);
      expect(result.datasetId).toBe('ds-copy');
      expect(result.tabGroupId).toBe('grp1');
      expect(mockDuckDB.createGroupTabCopy).toHaveBeenCalledWith('ds1', 'ds1 副本');
    });

    it('应该处理组内副本创建失败', async () => {
      const h = handlers.get('duckdb:create-group-tab-copy')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.createGroupTabCopy as any).mockRejectedValue(new Error('copy failed'));

      const result = await h(mockEvent, 'ds1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('copy failed');
    });
  });

  describe('duckdb:reorder-group-tabs', () => {
    it('应该调整组内 Tab 顺序', async () => {
      const h = handlers.get('duckdb:reorder-group-tabs')!;
      const mockEvent = createMockEvent();
      const payload = {
        groupId: 'grp1',
        datasetIds: ['ds1', 'ds2', 'ds3'],
      };

      const result = await h(mockEvent, payload);

      expect(result.success).toBe(true);
      expect(mockDuckDB.reorderGroupTabs).toHaveBeenCalledWith('grp1', ['ds1', 'ds2', 'ds3']);
    });

    it('应该处理组内 Tab 重排失败', async () => {
      const h = handlers.get('duckdb:reorder-group-tabs')!;
      const mockEvent = createMockEvent();
      const payload = {
        groupId: 'grp1',
        datasetIds: ['ds1', 'ds2'],
      };
      (mockDuckDB.reorderGroupTabs as any).mockRejectedValue(new Error('reorder failed'));

      const result = await h(mockEvent, payload);

      expect(result.success).toBe(false);
      expect(result.error).toBe('reorder failed');
    });
  });

  describe('duckdb:rename-group-tab', () => {
    it('应该重命名组内 Tab', async () => {
      const h = handlers.get('duckdb:rename-group-tab')!;
      const mockEvent = createMockEvent();

      const result = await h(mockEvent, 'ds2', '副本-重命名');

      expect(result.success).toBe(true);
      expect(mockDuckDB.renameGroupTab).toHaveBeenCalledWith('ds2', '副本-重命名');
    });

    it('应该处理组内 Tab 重命名失败', async () => {
      const h = handlers.get('duckdb:rename-group-tab')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.renameGroupTab as any).mockRejectedValue(new Error('rename failed'));

      const result = await h(mockEvent, 'ds2', 'bad');

      expect(result.success).toBe(false);
      expect(result.error).toBe('rename failed');
    });
  });

  // ========== 记录操作测试 ==========

  describe('duckdb:insert-record', () => {
    it('应该插入记录', async () => {
      const h = handlers.get('duckdb:insert-record')!;
      const mockEvent = createMockEvent();
      const record = { name: 'test', value: 123 };

      const result = await h(mockEvent, 'ds1', record);

      expect(result.success).toBe(true);
      expect(mockDuckDB.insertRecord).toHaveBeenCalledWith('ds1', record);
    });
  });

  describe('duckdb:batch-insert-records', () => {
    it('应该批量插入记录', async () => {
      const h = handlers.get('duckdb:batch-insert-records')!;
      const mockEvent = createMockEvent();
      const records = [{ name: 'test1' }, { name: 'test2' }];

      const result = await h(mockEvent, 'ds1', records);

      expect(result.success).toBe(true);
      expect(mockDuckDB.batchInsertRecords).toHaveBeenCalledWith('ds1', records);
    });
  });

  describe('duckdb:update-record', () => {
    it('应该更新记录', async () => {
      const h = handlers.get('duckdb:update-record')!;
      const mockEvent = createMockEvent();
      const updates = { name: 'updated' };

      const result = await h(mockEvent, 'ds1', 1, updates);

      expect(result.success).toBe(true);
      expect(mockDuckDB.updateRecord).toHaveBeenCalledWith('ds1', 1, updates);
    });
  });

  describe('duckdb:batch-update-records', () => {
    it('应该批量更新记录', async () => {
      const h = handlers.get('duckdb:batch-update-records')!;
      const mockEvent = createMockEvent();
      const updates = [
        { rowId: 1, updates: { name: 'a' } },
        { rowId: 2, updates: { name: 'b' } },
      ];

      const result = await h(mockEvent, 'ds1', updates);

      expect(result.success).toBe(true);
      expect(mockDuckDB.batchUpdateRecords).toHaveBeenCalledWith('ds1', updates);
    });
  });

  // ========== 查询引擎测试 ==========

  describe('duckdb:execute-query', () => {
    it('应该执行查询引擎查询', async () => {
      const h = handlers.get('duckdb:execute-query')!;
      const mockEvent = createMockEvent();
      const config = { filter: { column: 'name', op: 'eq', value: 'test' } };
      const mockResult = { rows: [], total: 0 };
      (mockDuckDB.queryWithEngine as any).mockResolvedValue(mockResult);

      const result = await h(mockEvent, 'ds1', config);

      expect(result.success).toBe(true);
      expect(mockDuckDB.queryWithEngine).toHaveBeenCalledWith('ds1', config);
    });
  });

  describe('duckdb:preview-query-sql', () => {
    it('应该预览查询 SQL', async () => {
      const h = handlers.get('duckdb:preview-query-sql')!;
      const mockEvent = createMockEvent();
      const config = { select: ['col1'] };
      (mockDuckDB.previewQuerySQL as any).mockResolvedValue({ sql: 'SELECT col1 FROM data' });

      const result = await h(mockEvent, 'ds1', config);

      expect(result).toEqual({ sql: 'SELECT col1 FROM data' });
    });
  });

  // ========== 列操作测试 ==========

  describe('duckdb:add-column', () => {
    it('应该添加列', async () => {
      const h = handlers.get('duckdb:add-column')!;
      const mockEvent = createMockEvent();
      const params = {
        datasetId: 'ds1',
        columnName: 'new_col',
        fieldType: 'text',
        nullable: true,
      };

      const result = await h(mockEvent, params);

      expect(result.success).toBe(true);
      expect(mockDuckDB.addColumn).toHaveBeenCalledWith(params);
      expect(mockEvent.sender.send).toHaveBeenCalledWith('dataset:schema-updated', 'ds1');
    });
  });

  describe('duckdb:update-column', () => {
    it('应该更新列', async () => {
      const h = handlers.get('duckdb:update-column')!;
      const mockEvent = createMockEvent();
      const params = {
        datasetId: 'ds1',
        columnName: 'col1',
        newName: 'col1_renamed',
      };

      const result = await h(mockEvent, params);

      expect(result.success).toBe(true);
      expect(mockDuckDB.updateColumn).toHaveBeenCalledWith(params);
    });
  });

  describe('duckdb:delete-column', () => {
    it('应该删除列', async () => {
      const h = handlers.get('duckdb:delete-column')!;
      const mockEvent = createMockEvent();
      const params = { datasetId: 'ds1', columnName: 'col1', force: false };

      const result = await h(mockEvent, params);

      expect(result.success).toBe(true);
      expect(mockDuckDB.deleteColumn).toHaveBeenCalledWith('ds1', 'col1', false);
    });
  });

  describe('duckdb:reorder-columns', () => {
    it('应该重排列顺序', async () => {
      const h = handlers.get('duckdb:reorder-columns')!;
      const mockEvent = createMockEvent();
      const params = { datasetId: 'ds1', columnNames: ['col2', 'col1', 'col3'] };

      const result = await h(mockEvent, params);

      expect(result.success).toBe(true);
      expect(mockDuckDB.reorderColumns).toHaveBeenCalledWith('ds1', ['col2', 'col1', 'col3']);
    });
  });

  // ========== 物理删除测试 ==========

  describe('duckdb:hard-delete-rows', () => {
    it('应该物理删除行', async () => {
      const h = handlers.get('duckdb:hard-delete-rows')!;
      (mockDuckDB.hardDeleteRows as any).mockResolvedValue(3);

      const result = await h({} as any, {
        datasetId: 'ds1',
        rowIds: [1, 2, 3],
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(3);
      expect(mockDuckDB.hardDeleteRows).toHaveBeenCalledWith('ds1', [1, 2, 3]);
    });

    it('应该处理物理删除失败', async () => {
      const h = handlers.get('duckdb:hard-delete-rows')!;
      (mockDuckDB.hardDeleteRows as any).mockRejectedValue(new Error('Delete failed'));

      const result = await h({} as any, {
        datasetId: 'ds1',
        rowIds: [1],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });
  });

  // ========== 列名验证测试 ==========

  describe('duckdb:validate-column-name', () => {
    it('应该验证列名可用', async () => {
      const h = handlers.get('duckdb:validate-column-name')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.getDatasetInfo as any).mockResolvedValue({
        id: 'ds1',
        schema: [{ name: 'existing_col' }],
      });

      const result = await h(mockEvent, 'ds1', 'new_col');

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('列名可用');
    });

    it('应该检测列名已存在', async () => {
      const h = handlers.get('duckdb:validate-column-name')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.getDatasetInfo as any).mockResolvedValue({
        id: 'ds1',
        schema: [{ name: 'existing_col' }],
      });

      const result = await h(mockEvent, 'ds1', 'existing_col');

      expect(result.success).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('列名已存在');
    });

    it('应该处理数据集不存在', async () => {
      const h = handlers.get('duckdb:validate-column-name')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.getDatasetInfo as any).mockResolvedValue(null);

      const result = await h(mockEvent, 'ds1', 'col');

      expect(result.success).toBe(false);
      expect(result.error).toBe('数据集不存在');
    });
  });

  // ========== 类型分析测试 ==========

  describe('duckdb:analyze-types', () => {
    it('应该分析数据类型', async () => {
      const h = handlers.get('duckdb:analyze-types')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.analyzeDatasetTypes as any).mockResolvedValue({
        schema: [{ name: 'col1', type: 'text' }],
        sampleData: [],
      });

      const result = await h(mockEvent, 'ds1');

      expect(result.success).toBe(true);
      expect(result.schema).toBeDefined();
      expect(result.duration).toBeDefined();
    });
  });

  describe('duckdb:apply-schema', () => {
    it('应该应用 schema', async () => {
      const h = handlers.get('duckdb:apply-schema')!;
      const mockEvent = createMockEvent();
      const schema = [{ name: 'col1', fieldType: 'text' }];

      const result = await h(mockEvent, { datasetId: 'ds1', schema });

      expect(result.success).toBe(true);
      expect(mockDuckDB.updateDatasetSchema).toHaveBeenCalledWith('ds1', schema);
      expect(mockEvent.sender.send).toHaveBeenCalledWith('dataset:schema-updated', 'ds1');
    });
  });

  // ========== 预览操作测试 ==========

  describe('duckdb:preview-filter-count', () => {
    it('应该预览筛选计数', async () => {
      const h = handlers.get('duckdb:preview-filter-count')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.previewFilterCount as any).mockResolvedValue({ count: 100 });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        filterConfig: { column: 'name', op: 'eq', value: 'test' },
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ count: 100 });
    });
  });

  describe('duckdb:preview-aggregate', () => {
    it('应该预览聚合结果', async () => {
      const h = handlers.get('duckdb:preview-aggregate')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.previewAggregate as any).mockResolvedValue({ sum: 1000 });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        aggregateConfig: { func: 'sum', column: 'value' },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('duckdb:preview-sample', () => {
    it('应该预览采样结果', async () => {
      const h = handlers.get('duckdb:preview-sample')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.previewSample as any).mockResolvedValue({ rows: [] });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        sampleConfig: { size: 100 },
        queryConfig: null,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('duckdb:preview-lookup', () => {
    it('应该预览关联结果', async () => {
      const h = handlers.get('duckdb:preview-lookup')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.previewLookup as any).mockResolvedValue({ rows: [] });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        lookupConfig: { targetDataset: 'ds2' },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('duckdb:validate-compute-expression', () => {
    it('应该验证计算表达式', async () => {
      const h = handlers.get('duckdb:validate-compute-expression')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.validateComputeExpression as any).mockResolvedValue({ valid: true });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        expression: 'col1 + col2',
      });

      expect(result.success).toBe(true);
      expect(result.result.valid).toBe(true);
    });
  });

  describe('duckdb:preview-group', () => {
    it('应该预览分组结果', async () => {
      const h = handlers.get('duckdb:preview-group')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.previewGroup as any).mockResolvedValue({ groups: [] });

      const result = await h(mockEvent, {
        datasetId: 'ds1',
        groupConfig: { groupBy: ['category'] },
      });

      expect(result.success).toBe(true);
    });
  });

  // ========== 导出测试 ==========

  describe('duckdb:select-export-path', () => {
    it('应该选择 CSV 导出路径', async () => {
      const h = handlers.get('duckdb:select-export-path')!;
      const mockEvent = createMockEvent();
      mockShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/path/to/export.csv',
      });

      const result = await h(mockEvent, { defaultFileName: 'data.csv', format: 'csv' });

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/path/to/export.csv');
    });

    it('应该处理取消导出', async () => {
      const h = handlers.get('duckdb:select-export-path')!;
      const mockEvent = createMockEvent();
      mockShowSaveDialog.mockResolvedValue({ canceled: true });

      const result = await h(mockEvent, { defaultFileName: 'data.csv', format: 'csv' });

      expect(result.success).toBe(true);
      expect(result.canceled).toBe(true);
    });

    it('应该支持多种格式', async () => {
      const h = handlers.get('duckdb:select-export-path')!;
      const mockEvent = createMockEvent();
      mockShowSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/path/to/export.xlsx',
      });

      const result = await h(mockEvent, { defaultFileName: 'data.xlsx', format: 'xlsx' });

      expect(result.success).toBe(true);
    });
  });

  describe('duckdb:export-dataset', () => {
    it('应该导出数据集', async () => {
      const h = handlers.get('duckdb:export-dataset')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.exportDataset as any).mockResolvedValue({
        success: true,
        files: ['/path/to/export.csv'],
        totalRows: 100,
      });

      const result = await h(mockEvent, { datasetId: 'ds1', format: 'csv' });

      expect(result.success).toBe(true);
      expect(result.totalRows).toBe(100);
    });

    it('应该处理导出失败', async () => {
      const h = handlers.get('duckdb:export-dataset')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.exportDataset as any).mockRejectedValue(new Error('Export failed'));

      const result = await h(mockEvent, { datasetId: 'ds1', format: 'csv' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Export failed');
    });
  });

  // ========== 文件导入记录测试 ==========

  describe('duckdb:import-records-from-file', () => {
    it('应该从文件导入记录', async () => {
      const h = handlers.get('duckdb:import-records-from-file')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.importRecordsFromFile as any).mockResolvedValue({
        recordsInserted: 50,
      });

      const result = await h(mockEvent, 'ds1', '/path/to/records.csv');

      expect(result.success).toBe(true);
      expect(result.recordsInserted).toBe(50);
    });

    it('应该处理导入失败', async () => {
      const h = handlers.get('duckdb:import-records-from-file')!;
      const mockEvent = createMockEvent();
      (mockDuckDB.importRecordsFromFile as any).mockRejectedValue(new Error('Import error'));

      const result = await h(mockEvent, 'ds1', '/path/to/records.csv');

      expect(result.success).toBe(false);
    });
  });
});
