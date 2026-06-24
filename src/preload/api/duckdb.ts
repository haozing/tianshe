import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  ExportOptions,
  ExportPathParams,
  ExportPathResult,
  ExportProgress,
  ExportResult,
} from '../../types/dataset-export';

export function createDuckDBAPI(ipcRenderer: IpcRenderer) {
  return {
    /**
     * 选择 CSV 文件
     */
    selectImportFile: (): Promise<{
      success: boolean;
      filePath?: string;
      canceled?: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:select-import-file');
    },

    /**
     * 导入 CSV
     */
    importDatasetFile: (
      filePath: string,
      name: string,
      options?: { folderId?: string | null }
    ): Promise<{ success: boolean; datasetId?: string; error?: string }> => {
      return ipcRenderer.invoke('duckdb:import-dataset-file', filePath, name, options);
    },

    /**
     * 取消导入
     */
    cancelImport: (datasetId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:cancel-import', datasetId);
    },

    /**
     * 获取数据集列表
     */
    listDatasets: (): Promise<{
      success: boolean;
      datasets?: Array<{
        id: string;
        name: string;
        rowCount: number;
        columnCount: number;
        sizeBytes: number;
        createdAt: number;
        lastQueriedAt?: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:list-datasets');
    },

    /**
     * 获取数据集信息
     */
    getDatasetInfo: (
      datasetId: string
    ): Promise<{
      success: boolean;
      dataset?: {
        id: string;
        name: string;
        rowCount: number;
        columnCount: number;
        sizeBytes: number;
        createdAt: number;
        lastQueriedAt?: number;
        schema?: Array<{
          name: string;
          duckdbType: string;
          fieldType?: string;
          nullable?: boolean;
          storageMode?: 'physical' | 'computed';
          computeConfig?: any;
          validationRules?: any[];
          displayConfig?: {
            width?: number;
            frozen?: boolean;
            order?: number;
            hidden?: boolean;
            pinned?: 'left' | 'right';
          };
          metadata?: any;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:get-dataset-info', datasetId);
    },

    /**
     * 查询数据集
     */
    queryDataset: (
      datasetId: string,
      sql?: string,
      offset?: number,
      limit?: number
    ): Promise<{
      success: boolean;
      result?: {
        columns: string[];
        rows: any[];
        rowCount: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:query-dataset', datasetId, sql, offset, limit);
    },

    /**
     * 删除数据集
     */
    deleteDataset: (datasetId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:delete-dataset', datasetId);
    },

    /**
     * 重命名数据集
     */
    renameDataset: (
      datasetId: string,
      newName: string
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:rename-dataset', datasetId, newName);
    },

    /**
     * 创建空数据集
     */
    createEmptyDataset: (
      datasetName: string,
      options?: { folderId?: string | null }
    ): Promise<{ success: boolean; datasetId?: string; error?: string }> => {
      return ipcRenderer.invoke('duckdb:create-empty-dataset', datasetName, options);
    },

    /**
     * 🆕 列出与当前数据表同组的内容区 Tab
     */
    listGroupTabs: (
      datasetId: string
    ): Promise<{
      success: boolean;
      tabs?: Array<{
        datasetId: string;
        tabGroupId: string;
        name: string;
        rowCount: number;
        columnCount: number;
        tabOrder: number;
        isGroupDefault: boolean;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:list-group-tabs', datasetId);
    },

    /**
     * 🆕 复制当前数据表为同组新 Tab
     */
    createGroupTabCopy: (
      sourceDatasetId: string,
      newName?: string
    ): Promise<{ success: boolean; datasetId?: string; tabGroupId?: string; error?: string }> => {
      return ipcRenderer.invoke('duckdb:create-group-tab-copy', sourceDatasetId, newName);
    },

    /**
     * 🆕 调整组内 Tab 顺序
     */
    reorderGroupTabs: (
      groupId: string,
      datasetIds: string[]
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:reorder-group-tabs', { groupId, datasetIds });
    },

    /**
     * 🆕 重命名组内 Tab（实际重命名 dataset）
     */
    renameGroupTab: (
      datasetId: string,
      newName: string
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:rename-group-tab', datasetId, newName);
    },

    /**
     * 插入记录
     */
    insertRecord: (
      datasetId: string,
      record: Record<string, any>
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:insert-record', datasetId, record);
    },

    /**
     * 批量插入记录
     */
    batchInsertRecords: (
      datasetId: string,
      records: Record<string, any>[]
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:batch-insert-records', datasetId, records);
    },

    /**
     * 从文件导入记录到现有数据集
     * 支持 CSV, XLSX, XLS, JSON, TXT 格式
     */
    importRecordsFromFile: (
      datasetId: string,
      filePath: string
    ): Promise<{ success: boolean; recordsInserted?: number; error?: string }> => {
      return ipcRenderer.invoke('duckdb:import-records-from-file', datasetId, filePath);
    },

    /**
     * 从 base64 导入记录到现有数据集
     * 支持 CSV, XLSX, XLS, TXT 格式
     */
    importRecordsFromBase64: (
      datasetId: string,
      base64: string,
      filename?: string
    ): Promise<{ success: boolean; recordsInserted?: number; error?: string }> => {
      return ipcRenderer.invoke('duckdb:import-records-from-base64', datasetId, base64, filename);
    },

    /**
     * 监听导入记录进度
     */
    onImportRecordsProgress: (
      callback: (progress: {
        datasetId: string;
        status: 'pending' | 'importing' | 'completed' | 'failed';
        progress: number;
        rowsProcessed?: number;
        error?: string;
        message?: string;
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, progress: any) => callback(progress);
      ipcRenderer.on('duckdb:import-records-progress', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('duckdb:import-records-progress', subscription);
      };
    },

    /**
     * 更新记录
     */
    updateRecord: (
      datasetId: string,
      rowId: number,
      updates: Record<string, any>
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:update-record', datasetId, rowId, updates);
    },

    /**
     * 批量更新记录
     */
    batchUpdateRecords: (
      datasetId: string,
      updates: Array<{ rowId: number; updates: Record<string, any> }>
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:batch-update-records', datasetId, updates);
    },

    /**
     * 获取数据行来源、运行时 trace 与观测证据
     */
    getRecordEvidence: (
      datasetId: string,
      rowId: number,
      limit?: number
    ): Promise<{
      success: boolean;
      evidence?: import('../../main/duckdb/types').DatasetRecordEvidenceBundle;
      error?: string;
      code?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:get-record-evidence', datasetId, rowId, limit);
    },

    /**
     * 监听导入进度
     */
    onImportProgress: (
      callback: (progress: {
        datasetId: string;
        status: 'pending' | 'importing' | 'completed' | 'failed';
        progress: number;
        rowsProcessed?: number;
        error?: string;
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, progress: any) => callback(progress);
      ipcRenderer.on('duckdb:import-progress', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('duckdb:import-progress', subscription);
      };
    },

    /**
     * 使用 QueryEngine 执行查询
     */
    executeQuery: (
      datasetId: string,
      config: any
    ): Promise<{
      success: boolean;
      result?: {
        success: boolean;
        columns?: string[];
        rows?: any[];
        rowCount?: number;
        executionTime?: number;
        generatedSQL?: string;
        error?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:execute-query', datasetId, config);
    },

    /**
     * ✨ 新增：只生成 SQL 而不执行查询（用于保存查询模板）
     */
    previewQuerySQL: (
      datasetId: string,
      config: any
    ): Promise<{
      success: boolean;
      sql?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-query-sql', datasetId, config);
    },

    /**
     * 预览数据清洗结果
     */
    previewClean: (
      datasetId: string,
      config: any,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-clean', datasetId, config, options);
    },

    materializeCleanToNewColumns: (
      datasetId: string,
      cleanConfig: any
    ): Promise<{
      success: boolean;
      result?: {
        createdColumns: string[];
        updatedColumns: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:materialize-clean-to-new-columns', {
        datasetId,
        cleanConfig,
      });
    },

    /**
     * ✨ 新增：预览去重效果
     */
    previewDedupe: (
      datasetId: string,
      config: any,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-dedupe', datasetId, config, options);
    },

    // ========== 🆕 操作预览 API ==========

    /**
     * 预览筛选结果（仅返回计数）
     */
    previewFilterCount: (
      datasetId: string,
      filterConfig: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-filter-count', { datasetId, filterConfig });
    },

    /**
     * 预览聚合结果
     */
    previewAggregate: (
      datasetId: string,
      aggregateConfig: any,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-aggregate', {
        datasetId,
        aggregateConfig,
        options,
      });
    },

    /**
     * 预览采样结果
     */
    previewSample: (
      datasetId: string,
      sampleConfig: any,
      queryConfig?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-sample', { datasetId, sampleConfig, queryConfig });
    },

    /**
     * 预览关联结果
     */
    previewLookup: (
      datasetId: string,
      lookupConfig: any,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-lookup', { datasetId, lookupConfig, options });
    },

    /**
     * 验证计算列表达式
     */
    validateComputeExpression: (
      datasetId: string,
      expression: string,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:validate-compute-expression', {
        datasetId,
        expression,
        options,
      });
    },

    /**
     * 预览分组结果
     */
    previewGroup: (
      datasetId: string,
      groupConfig: any,
      options?: any
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:preview-group', { datasetId, groupConfig, options });
    },

    /**
     * 更新列元数据
     */
    updateColumnMetadata: (
      datasetId: string,
      columnName: string,
      metadata: any
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:update-column-metadata', datasetId, columnName, metadata);
    },

    /**
     * ✨ 新增：更新列显示配置（列宽、排序等）
     */
    updateColumnDisplayConfig: (params: {
      datasetId: string;
      columnName: string;
      displayConfig: {
        width?: number;
        frozen?: boolean;
        order?: number;
        hidden?: boolean;
        pinned?: 'left' | 'right';
      };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:update-column-display-config', params);
    },

    /**
     * 添加列（增强版本）
     */
    addColumn: (params: {
      datasetId: string;
      columnName: string;
      fieldType: string;
      nullable: boolean;
      metadata?: any;
      storageMode?: 'physical' | 'computed'; // 🆕 存储模式
      computeConfig?: any; // 🆕 计算列配置
      validationRules?: any[]; // 🆕 验证规则
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:add-column', params);
    },

    /**
     * 更新列
     */
    updateColumn: (params: {
      datasetId: string;
      columnName: string;
      newName?: string;
      fieldType?: string;
      nullable?: boolean;
      metadata?: any;
      computeConfig?: any;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('duckdb:update-column', params);
    },

    /**
     * ✨ 新增：删除列
     */
    deleteColumn: (
      datasetIdOrParams:
        | string
        | {
            datasetId: string;
            columnName: string;
            force?: boolean;
          },
      columnName?: string,
      force?: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      const params =
        typeof datasetIdOrParams === 'string'
          ? {
              datasetId: datasetIdOrParams,
              columnName: columnName || '',
              force,
            }
          : datasetIdOrParams;
      return ipcRenderer.invoke('duckdb:delete-column', params);
    },

    /**
     * ✨ 新增：重新排序列
     */
    reorderColumns: (
      datasetIdOrParams:
        | string
        | {
            datasetId: string;
            columnNames: string[];
          },
      columnNames?: string[]
    ): Promise<{ success: boolean; error?: string }> => {
      const params =
        typeof datasetIdOrParams === 'string'
          ? {
              datasetId: datasetIdOrParams,
              columnNames: columnNames || [],
            }
          : datasetIdOrParams;
      return ipcRenderer.invoke('duckdb:reorder-columns', params);
    },

    /**
     * 🗑️ 物理删除数据行（不可恢复）
     */
    hardDeleteRows: (params: {
      datasetId: string;
      rowIds: number[];
    }): Promise<{ success: boolean; deletedCount?: number; error?: string }> => {
      return ipcRenderer.invoke('duckdb:hard-delete-rows', params);
    },

    /**
     * 🆕 去重面板：Aho-Corasick 词库过滤后删除（物理删除，不可恢复）
     */
    deleteRowsByAhoCorasickFilter: (params: {
      datasetId: string;
      targetField: string;
      dictDatasetId: string;
      dictField: string;
      filterType: 'contains_multi' | 'excludes_multi';
    }): Promise<{ success: boolean; deletedCount?: number; error?: string }> => {
      return ipcRenderer.invoke('duckdb:ac-filter-delete-rows', params);
    },

    /**
     * 验证列名
     */
    validateColumnName: (
      datasetId: string,
      columnName: string
    ): Promise<{
      success: boolean;
      valid?: boolean;
      message?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:validate-column-name', datasetId, columnName);
    },

    /**
     * 异步分析数据集字段类型（深度分析）
     */
    analyzeTypes: (
      datasetId: string
    ): Promise<{
      success: boolean;
      schema?: any[];
      sampleData?: any[];
      duration?: number;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:analyze-types', datasetId);
    },

    /**
     * 应用用户确认的 schema
     */
    applySchema: (
      datasetId: string,
      schema: any[]
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('duckdb:apply-schema', { datasetId, schema });
    },

    /**
     * 监听数据集schema更新
     */
    onSchemaUpdated: (callback: (datasetId: string) => void) => {
      const subscription = (_event: IpcRendererEvent, datasetId: string) => callback(datasetId);
      ipcRenderer.on('dataset:schema-updated', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('dataset:schema-updated', subscription);
      };
    },

    /**
     * 🆕 选择导出路径
     */
    selectExportPath: (params: ExportPathParams): Promise<ExportPathResult> => {
      return ipcRenderer.invoke('duckdb:select-export-path', params);
    },

    /**
     * 🆕 导出数据集
     */
    exportDataset: (options: ExportOptions): Promise<ExportResult> => {
      return ipcRenderer.invoke('duckdb:export-dataset', options);
    },

    /**
     * 🆕 监听导出进度
     */
    onExportProgress: (callback: (progress: ExportProgress) => void) => {
      const subscription = (_event: IpcRendererEvent, progress: ExportProgress) =>
        callback(progress);
      ipcRenderer.on('duckdb:export-progress', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('duckdb:export-progress', subscription);
      };
    },
  };
}
