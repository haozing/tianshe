/**
 * Preload 安全桥接
 * 负责：
 * - 使用 contextBridge 暴露安全的 API
 * - 连接主进程和渲染进程
 * - 类型安全的 IPC 通信
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { TiansheEditionName, TiansheEditionPublicInfo } from '../edition/types';
import type { LogEntry } from '../main/log-storage-service';
import type { DownloadInfo } from '../main/download';
import type {
  BrowserProfile,
  ProfileGroup,
  CreateProfileParams,
  UpdateProfileParams,
  ProfileListParams,
  CreateGroupParams,
  UpdateGroupParams,
  AutomationEngine,
  Account,
  CreateAccountParams,
  CreateAccountWithAutoProfileParams,
  UpdateAccountParams,
  SavedSite,
  CreateSavedSiteParams,
  UpdateSavedSiteParams,
  Tag,
  CreateTagParams,
  UpdateTagParams,
  ExtensionPackage,
  ProfileExtensionBinding,
} from '../types/profile';
import type { InternalBrowserDevToolsConfig } from '../types/internal-browser';
import type {
  ExportOptions,
  ExportPathParams,
  ExportPathResult,
  ExportProgress,
  ExportResult,
} from '../types/dataset-export';
import type {
  FailureBundle,
  RecentFailureSummary,
  TraceSummary,
  TraceTimeline,
} from '../core/observability/types';
import type { PluginNotificationPayload } from '../core/js-plugin/events';
import type { AppShellConfig } from '../shared/app-shell-config';

const resolveTiansheEditionPublicInfo = (): TiansheEditionPublicInfo => {
  const value = String(process.env.TIANSHE_EDITION || process.env.AIRPA_EDITION || '')
    .trim()
    .toLowerCase();
  const name: TiansheEditionName = value === 'cloud' ? 'cloud' : 'open';
  const cloudEnabled = name === 'cloud';

  return {
    name,
    capabilities: {
      cloudAuth: cloudEnabled,
      cloudSnapshot: cloudEnabled,
      cloudCatalog: cloudEnabled,
    },
  };
};

const tiansheEdition = resolveTiansheEditionPublicInfo();

/**
 * 暴露给渲染进程的 API
 */
const electronAPI = {
  edition: tiansheEdition,

  // ========== 日志相关 ==========

  /**
   * 获取任务日志
   */
  getTaskLogs: (taskId: string, level?: string): Promise<LogEntry[]> => {
    return ipcRenderer.invoke('get-task-logs', taskId, level);
  },

  /**
   * 获取最近日志
   */
  getRecentLogs: (limit?: number, level?: string): Promise<LogEntry[]> => {
    return ipcRenderer.invoke('get-recent-logs', limit, level);
  },

  /**
   * 获取日志统计
   */
  getLogStats: (
    taskId?: string
  ): Promise<{ total: number; byLevel: { [key: string]: number } }> => {
    return ipcRenderer.invoke('get-log-stats', taskId);
  },

  /**
   * 清理日志
   */
  cleanupLogs: (daysToKeep?: number): Promise<{ deleted: number }> => {
    return ipcRenderer.invoke('cleanup-logs', daysToKeep);
  },

  // ========== Observation 读面 ==========

  observation: {
    getTraceSummary: (
      traceId: string
    ): Promise<{
      success: boolean;
      data?: TraceSummary;
      error?: string;
    }> => {
      return ipcRenderer.invoke('observation:get-trace-summary', traceId);
    },

    getFailureBundle: (
      traceId: string
    ): Promise<{
      success: boolean;
      data?: FailureBundle;
      error?: string;
    }> => {
      return ipcRenderer.invoke('observation:get-failure-bundle', traceId);
    },

    getTraceTimeline: (
      traceId: string,
      limit?: number
    ): Promise<{
      success: boolean;
      data?: TraceTimeline;
      error?: string;
    }> => {
      return ipcRenderer.invoke('observation:get-trace-timeline', { traceId, limit });
    },

    searchRecentFailures: (
      limit?: number
    ): Promise<{
      success: boolean;
      data?: RecentFailureSummary[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('observation:search-recent-failures', limit);
    },
  },

  // ========== 下载相关 ==========

  /**
   * 下载图片并转换为 Base64
   * 使用 Node.js 环境，绕过浏览器的 CORS 限制
   */
  downloadImage: (
    url: string
  ): Promise<{
    success: boolean;
    data?: string;
    size?: number;
    mimeType?: string;
    error?: string;
  }> => {
    return ipcRenderer.invoke('download-image', url);
  },

  /**
   * 获取下载信息
   */
  getDownload: (id: string): Promise<DownloadInfo | undefined> => {
    return ipcRenderer.invoke('get-download', id);
  },

  /**
   * 获取 Partition 的下载
   */
  getPartitionDownloads: (partition: string): Promise<DownloadInfo[]> => {
    return ipcRenderer.invoke('get-partition-downloads', partition);
  },

  /**
   * 获取所有下载
   */
  getAllDownloads: (): Promise<DownloadInfo[]> => {
    return ipcRenderer.invoke('get-all-downloads');
  },

  /**
   * 删除下载文件
   */
  deleteDownloadFile: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('delete-download-file', id);
  },

  /**
   * 获取下载统计
   */
  getDownloadStats: (
    partition?: string
  ): Promise<{
    total: number;
    completed: number;
    progressing: number;
    cancelled: number;
    interrupted: number;
  }> => {
    return ipcRenderer.invoke('get-download-stats', partition);
  },

  // ========== 系统相关 ==========

  /**
   * 获取应用信息
   */
  getAppInfo: (): Promise<{
    success: boolean;
    info?: {
      version: string;
      platform: string;
      arch: string;
      nodeVersion: string;
      isPackaged?: boolean;
      isDevelopment?: boolean;
      isFromAsar?: boolean;
      shouldShowDevOptions?: boolean;
      appShell?: AppShellConfig;
    };
    error?: string;
  }> => {
    return ipcRenderer.invoke('get-app-info');
  },

  /**
   * 获取设备指纹
   */
  getDeviceFingerprint: (): Promise<{
    success: boolean;
    fingerprint?: string;
    error?: string;
    source?: 'native' | 'fallback';
    warning?: string;
  }> => {
    return ipcRenderer.invoke('get-device-fingerprint');
  },

  // ========== DuckDB 相关 ==========

  duckdb: {
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
  },

  // ========== 查询模板相关 ==========
  queryTemplate: {
    create: (params: {
      datasetId: string;
      name: string;
      description?: string;
      icon?: string;
      queryConfig: any;
      generatedSQL: string;
    }): Promise<{ success: boolean; templateId?: string; error?: string }> => {
      return ipcRenderer.invoke('query-template:create', params);
    },
    list: (datasetId: string): Promise<{ success: boolean; templates?: any[]; error?: string }> => {
      return ipcRenderer.invoke('query-template:list', datasetId);
    },
    get: (
      templateId: string
    ): Promise<{
      success: boolean;
      template?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:get', templateId);
    },
    update: (params: {
      templateId: string;
      name?: string;
      description?: string;
      icon?: string;
      queryConfig?: any;
      generatedSQL?: string;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('query-template:update', params);
    },
    refresh: (
      templateId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:refresh', { templateId });
    },
    delete: (
      templateId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:delete', templateId);
    },
    reorder: (
      datasetId: string,
      templateIds: string[]
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('query-template:reorder', { datasetId, templateIds });
    },
    query: (
      templateId: string,
      offset?: number,
      limit?: number
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:query', { templateId, offset, limit });
    },
    getOrCreateDefault: (
      datasetId: string
    ): Promise<{
      success: boolean;
      template?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:get-or-create-default', datasetId);
    },
  },

  // ========== 文件相关 ==========

  file: {
    /**
     * 上传文件
     */
    upload: (
      datasetId: string,
      fileData: { buffer: number[]; filename: string }
    ): Promise<{
      success: boolean;
      metadata?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:upload', datasetId, fileData);
    },

    /**
     * 删除文件
     */
    delete: (
      relativePath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:delete', relativePath);
    },

    /**
     * 打开文件
     */
    open: (
      relativePath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:open', relativePath);
    },

    /**
     * 获取文件URL
     */
    getUrl: (
      relativePath: string
    ): Promise<{
      success: boolean;
      url?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:getUrl', relativePath);
    },

    /**
     * 获取图片数据（Base64）
     */
    getImageData: (
      relativePath: string
    ): Promise<{
      success: boolean;
      data?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:getImageData', relativePath);
    },

    /**
     * 删除数据集的所有文件
     */
    deleteDatasetFiles: (
      datasetId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:deleteDatasetFiles', datasetId);
    },
  },

  // ========== 文件夹相关 ==========

  folder: {
    /**
     * 创建文件夹
     */
    create: (
      name: string,
      parentId?: string,
      pluginId?: string,
      options?: { icon?: string; description?: string }
    ): Promise<{
      success: boolean;
      folderId?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:create', name, parentId, pluginId, options);
    },

    /**
     * 获取文件夹树
     */
    getTree: (): Promise<{
      success: boolean;
      tree?: any[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:get-tree');
    },

    /**
     * 移动数据集到文件夹
     */
    moveDataset: (
      datasetId: string,
      folderId: string | null
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:move-dataset', datasetId, folderId);
    },

    /**
     * 删除文件夹
     */
    delete: (
      folderId: string,
      deleteContents: boolean
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:delete', folderId, deleteContents);
    },

    /**
     * 更新文件夹
     */
    update: (
      folderId: string,
      updates: { name?: string; description?: string; icon?: string }
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:update', folderId, updates);
    },

    /**
     * 调整表顺序
     */
    reorderTables: (
      folderId: string,
      tableIds: string[]
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:reorder-tables', folderId, tableIds);
    },

    /**
     * 调整文件夹顺序
     */
    reorderFolders: (
      folderIds: string[]
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:reorder-folders', folderIds);
    },

    /**
     * 为现有插件创建文件夹
     */
    createForExistingPlugins: (): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:create-for-existing-plugins');
    },
  },

  // ========== WebContentsView 相关 ==========

  view: {
    /**
     * 注册 WebContentsView（不立即创建）
     */
    create: (options: {
      viewId: string;
      partition: string;
      url?: string;
      metadata?: {
        label?: string;
        displayMode?: 'fullscreen' | 'offscreen' | 'popup' | 'docked-right';
        source?: 'plugin' | 'mcp' | 'pool' | 'account';
      };
    }): Promise<{ success: boolean; viewId?: string; error?: string }> => {
      return ipcRenderer.invoke('view:create', options);
    },

    /**
     * 激活 WebContentsView（按需创建）
     */
    activate: (viewId: string): Promise<{ success: boolean; viewId?: string; error?: string }> => {
      return ipcRenderer.invoke('view:activate', viewId);
    },

    /**
     * 导航 WebContentsView 到指定 URL
     */
    navigate: (options: {
      viewId: string;
      url: string;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:navigate', options);
    },

    /**
     * 切换 WebContentsView
     */
    switch: (options: {
      viewId: string;
      windowId?: 'main' | 'background';
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:switch', options);
    },

    /**
     * 附加 WebContentsView 到窗口
     */
    attach: (options: {
      viewId: string;
      windowId?: 'main' | 'background';
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:attach', options);
    },

    /**
     * 更新 WebContentsView 边界
     */
    updateBounds: (options: {
      viewId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:update-bounds', options);
    },

    /**
     * 分离单个 WebContentsView
     */
    detach: (viewId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach', viewId);
    },

    /**
     * 将当前框架保存的 GoAdmin 登录态同步到指定视图 Cookie
     */
    syncCloudAuth: (options: {
      viewId: string;
      url: string;
      cookieName?: string;
    }): Promise<{
      success: boolean;
      reason?: string;
      cookieName?: string;
      targetOrigin?: string;
      expectedOrigin?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:sync-cloud-auth', options);
    },

    /**
     * 分离所有 WebContentsView
     * @param options.windowId 可选的窗口 ID，如 'main'。不传则分离所有窗口的 View
     */
    detachAll: (options?: {
      windowId?: string;
      preserveDockedRight?: boolean;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach-all', options);
    },

    /**
     * 按作用域分离 WebContentsView
     * @param options.scope 默认 automation（仅清理自动化视图）
     */
    detachScoped: (options?: {
      windowId?: string;
      scope?: 'all' | 'automation' | 'plugin';
      preserveDockedRight?: boolean;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach-scoped', options);
    },

    /**
     * 🆕 同步 Activity Bar 折叠状态（用于正确计算 WebContentsView 的布局边界）
     */
    setActivityBarCollapsed: (
      isCollapsed: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:set-activity-bar-collapsed', isCollapsed);
    },

    /**
     * 🆕 同步 Activity Bar 实际宽度（px）
     *
     * 由 renderer 侧通过 ResizeObserver 上报，主进程据此更新 WebContentsView 布局。
     */
    setActivityBarWidth: (widthPx: number): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:set-activity-bar-width', widthPx);
    },

    /**
     * 关闭 WebContentsView
     */
    close: (viewId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:close', viewId);
    },

    /**
     * 列出所有已注册的 WebContentsView（包括未激活的）
     */
    list: (): Promise<{
      success: boolean;
      views?: Array<{
        id: string;
        partition: string;
        metadata?: {
          label?: string;
          icon?: string;
          order?: number;
          color?: string;
        };
        isActive: boolean;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:list');
    },

    /**
     * 获取 WebContentsView 池状态
     */
    getPoolStatus: (): Promise<{
      success: boolean;
      status?: {
        size: number;
        maxSize: number;
        views: Array<{
          id: string;
          partition: string;
          createdAt: number;
          lastAccessedAt: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:pool-status');
    },

    /**
     * 批量关闭多个 WebContentsView
     */
    closeMultiple: (
      viewIds: string[]
    ): Promise<{
      success: boolean;
      result?: {
        closed: string[];
        failed: Array<{ id: string; error: string }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:close-multiple', viewIds);
    },

    /**
     * 关闭最旧的 N 个 WebContentsView
     */
    closeOldest: (
      count: number
    ): Promise<{
      success: boolean;
      closed?: string[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:close-oldest', count);
    },

    /**
     * 获取内存使用估算
     */
    getMemoryUsage: (): Promise<{
      success: boolean;
      usage?: {
        estimatedMB: number;
        perViewMB: number;
        activeViews: number;
        maxViews: number;
        utilizationPercent: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:memory-usage');
    },

    /**
     * 获取详细的池状态
     */
    getDetailedPoolStatus: (): Promise<{
      success: boolean;
      status?: {
        size: number;
        maxSize: number;
        available: number;
        isFull: boolean;
        utilizationPercent: number;
        views: Array<{
          id: string;
          partition: string;
          attachedTo?: string;
          createdAt: number;
          lastAccessedAt: number;
          ageSeconds: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:detailed-pool-status');
    },
  },

  // ========== 窗口相关 ==========

  window: {
    /**
     * 获取窗口边界
     */
    getBounds: (): Promise<{ width: number; height: number; x: number; y: number }> => {
      return ipcRenderer.invoke('window:get-bounds');
    },
  },

  // ========== JS 插件系统 ==========

  jsPlugin: {
    /**
     * 导入插件
     * @param sourcePath - 插件源路径（可选，不提供则打开文件对话框）
     * @param options - 导入选项（开发模式等）
     */
    import: (
      sourcePath?: string,
      options?: { devMode?: boolean }
    ): Promise<{
      success: boolean;
      pluginId?: string;
      error?: string;
      warnings?: string[];
      operation?: 'installed' | 'updated';
    }> => {
      return ipcRenderer.invoke('js-plugin:import', sourcePath, options);
    },

    /**
     * 列出所有已安装的插件
     */
    list: (): Promise<{ success: boolean; plugins?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:list');
    },

    /**
     * 获取所有插件运行态
     */
    listRuntimeStatuses: (): Promise<{ success: boolean; statuses?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:list-runtime-statuses');
    },

    /**
     * 获取插件详情
     */
    get: (pluginId: string): Promise<{ success: boolean; plugin?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get', pluginId);
    },

    /**
     * 获取单个插件运行态
     */
    getRuntimeStatus: (
      pluginId: string
    ): Promise<{ success: boolean; status?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-runtime-status', pluginId);
    },

    /**
     * 卸载插件
     * @param pluginId - 插件ID
     * @param deleteTables - 是否同时删除插件创建的数据表（默认：false）
     */
    uninstall: (
      pluginId: string,
      deleteTables?: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:uninstall', pluginId, deleteTables ?? false);
    },

    /**
     * 取消插件的所有运行中/排队任务
     */
    cancelPluginTasks: (
      pluginId: string
    ): Promise<{ success: boolean; cancelled?: number; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:cancel-plugin-tasks', pluginId);
    },

    /**
     * 🆕 获取插件创建的数据表列表
     * @param pluginId - 插件ID
     */
    getTables: (
      pluginId: string
    ): Promise<{
      success: boolean;
      tables?: Array<{
        id: string;
        name: string;
        rowCount: number;
        columnCount: number;
        sizeBytes: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-tables', pluginId);
    },

    /**
     * 执行插件
     */
    execute: (
      pluginId: string,
      config: any
    ): Promise<{ success: boolean; result?: any; error?: string; duration?: number }> => {
      return ipcRenderer.invoke('js-plugin:execute', pluginId, config);
    },

    /**
     * 从按钮执行插件
     */
    executeFromButton: (
      pluginId: string,
      config: any,
      rowData: any
    ): Promise<{ success: boolean; result?: any; error?: string; duration?: number }> => {
      return ipcRenderer.invoke('js-plugin:execute-from-button', pluginId, config, rowData);
    },

    /**
     * 重新加载插件
     */
    reload: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:reload', pluginId);
    },

    /**
     * 🆕 修复插件（重新创建符号链接）
     */
    repairPlugin: (
      pluginId: string
    ): Promise<{ success: boolean; result: { success: boolean; message: string } }> => {
      return ipcRenderer.invoke('js-plugin:repair', pluginId);
    },

    /**
     * 获取插件配置
     */
    getConfig: (pluginId: string, key: string): Promise<any> => {
      return ipcRenderer.invoke('js-plugin:get-config', pluginId, key);
    },

    /**
     * 设置插件配置
     */
    setConfig: (
      pluginId: string,
      key: string,
      value: any
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:set-config', pluginId, key, value);
    },

    /**
     * 🆕 启用插件
     */
    enable: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:enable', pluginId);
    },

    /**
     * 🆕 禁用插件
     */
    disable: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:disable', pluginId);
    },

    // ========== 🆕 UI 扩展相关 ==========

    /**
     * 执行命令
     */
    executeCommand: (
      pluginId: string,
      commandId: string,
      params: any
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:execute-command', pluginId, commandId, params);
    },

    /**
     * 获取数据集的工具栏按钮
     */
    getToolbarButtons: (
      datasetId: string
    ): Promise<{ success: boolean; toolbarButtons?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-toolbar-buttons', datasetId);
    },

    /**
     * 执行按钮字段命令（从数据表的 button 字段触发）
     */
    executeActionColumn: (
      pluginId: string,
      commandId: string,
      rowid: number,
      datasetId: string
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke(
        'js-plugin:execute-action-column',
        pluginId,
        commandId,
        rowid,
        datasetId
      );
    },

    /**
     * 执行工具栏按钮命令
     */
    executeToolbarButton: (
      pluginId: string,
      commandId: string,
      selectedRows: any[]
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke(
        'js-plugin:execute-toolbar-button',
        pluginId,
        commandId,
        selectedRows
      );
    },

    /**
     * 🆕 监听插件状态变化
     */
    onPluginStateChanged: (
      callback: (data: {
        pluginId: string;
        state: 'installed' | 'uninstalled' | 'repaired' | 'enabled' | 'disabled';
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:state-changed', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('js-plugin:state-changed', subscription);
      };
    },

    // ========== 🆕 自定义页面相关 ==========

    /**
     * 🆕 获取插件的自定义页面列表
     */
    getCustomPages: (
      pluginId: string,
      datasetId?: string
    ): Promise<{ success: boolean; pages?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-custom-pages', pluginId, datasetId);
    },

    /**
     * 🆕 渲染自定义页面内容
     */
    renderCustomPage: (
      pluginId: string,
      pageId: string,
      datasetId?: string
    ): Promise<{ success: boolean; html?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:render-custom-page', pluginId, pageId, datasetId);
    },

    /**
     * 🆕 发送页面消息到插件
     */
    sendPageMessage: (
      message: any
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:page-message', message);
    },

    // ========== ✅ Activity Bar 视图和 API 调用 ==========

    /**
     * ✅ 调用插件暴露的 API
     */
    callPluginAPI: (
      pluginId: string,
      apiName: string,
      ...args: any[]
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:call-api', pluginId, apiName, args);
    },

    /**
     * ✅ 显示插件视图
     */
    showPluginView: (
      pluginId: string,
      bounds?: { x: number; y: number; width: number; height: number }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:show-view', pluginId, bounds);
    },

    /**
     * ✅ 隐藏插件视图
     */
    hidePluginView: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:hide-view', pluginId);
    },

    /**
     * ✅ 获取插件视图信息
     */
    getPluginViewInfo: (
      pluginId: string
    ): Promise<{
      success: boolean;
      viewInfo?: {
        hasPageView: boolean;
        pageViewId: string | null;
        tempViewCount: number;
        tempViewIds: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-view-info', pluginId);
    },

    /**
     * ✨ 设置插件视图边界（动态调整位置和大小）
     */
    setViewBounds: (
      pluginId: string,
      bounds: { x?: number; y?: number; width?: number; height?: number }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:set-view-bounds', pluginId, bounds);
    },

    /**
     * ✨ 获取布局信息（Activity Bar 宽度、可用空间等）
     */
    getLayoutInfo: (
      pluginId: string
    ): Promise<{
      success: boolean;
      layoutInfo?: {
        activityBarWidth: number;
        availableWidth: number;
        availableHeight: number;
        windowWidth: number;
        windowHeight: number;
        contentTopInset: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-layout-info', pluginId);
    },

    // ========== 🆕 热重载相关 ==========

    /**
     * 启用插件的热重载（文件监听）
     */
    enableHotReload: (
      pluginId: string
    ): Promise<{ success: boolean; message?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:enable-hot-reload', pluginId);
    },

    /**
     * 禁用插件的热重载（文件监听）
     */
    disableHotReload: (
      pluginId: string
    ): Promise<{ success: boolean; message?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:disable-hot-reload', pluginId);
    },

    /**
     * 获取插件的热重载状态
     */
    getHotReloadStatus: (
      pluginId: string
    ): Promise<{ success: boolean; enabled?: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-hot-reload-status', pluginId);
    },

    /**
     * 监听插件热重载完成事件
     */
    onPluginReloaded: (
      callback: (data: { pluginId: string; success: boolean; error?: string }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:reloaded', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:reloaded', subscription);
      };
    },

    /**
     * 监听插件运行态变化事件
     */
    onPluginRuntimeStatusChanged: (
      callback: (data: { pluginId: string; status: any | null; removed?: boolean }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:runtime-status-changed', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:runtime-status-changed', subscription);
      };
    },

    /**
     * 监听插件通知事件
     */
    onPluginNotification: (callback: (data: PluginNotificationPayload) => void) => {
      const subscription = (_event: IpcRendererEvent, data: PluginNotificationPayload) =>
        callback(data);
      ipcRenderer.on('js-plugin:notification', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:notification', subscription);
      };
    },
  },

  // ========== 执行控制相关 ==========

  execution: {
    /**
     * 停止持久化执行
     */
    stop: (executionId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('execution:stop', executionId);
    },

    /**
     * 获取所有活跃执行
     */
    getActive: (): Promise<{
      success: boolean;
      executions?: Array<{
        id: string;
        workflow: string;
        workflowId: string;
        concurrency: number;
        status: string;
        startedAt: number;
        stats: any;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('execution:get-active');
    },

    /**
     * 恢复暂停的任务
     */
    resume: (taskId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('execution:resume', taskId);
    },

    /**
     * 获取所有暂停的任务
     */
    getPausedTasks: (): Promise<{
      success: boolean;
      tasks?: Array<{
        taskId: string;
        reason: string;
        pausedAt: number;
        timeout?: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('execution:get-paused-tasks');
    },
  },

  // ========== 插件 View 相关 ==========

  /**
   * 监听插件创建的 View
   */
  onPluginViewCreated: (
    callback: (view: {
      id: string;
      partition: string;
      metadata?: {
        label?: string;
        icon?: string;
        order?: number;
        color?: string;
      };
    }) => void
  ) => {
    const subscription = (_event: IpcRendererEvent, view: any) => callback(view);
    ipcRenderer.on('plugin:view-created', subscription);
    return () => ipcRenderer.removeListener('plugin:view-created', subscription);
  },

  /**
   * 监听插件 View 关闭
   */
  onPluginViewClosed: (callback: (data: { viewId: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('plugin:view-closed', subscription);
    return () => ipcRenderer.removeListener('plugin:view-closed', subscription);
  },

  /**
   * 通知 View 按钮点击
   */
  notifyViewButtonClick: (viewId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('view:button-click', viewId);
  },

  // ========== 事件监听 ==========

  /**
   * 监听下载事件
   */
  onDownloadEvent: (
    channel:
      | 'download:started'
      | 'download:progress'
      | 'download:completed'
      | 'download:cancelled'
      | 'download:interrupted',
    callback: (info: DownloadInfo) => void
  ) => {
    const subscription = (_event: IpcRendererEvent, info: DownloadInfo) => callback(info);
    ipcRenderer.on(channel, subscription);

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  /**
   * 通用事件监听
   */
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: IpcRendererEvent, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, subscription);

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  /**
   * 移除事件监听
   */
  removeListener: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },

  /**
   * 移除所有监听器
   */
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // ========== 系统 Shell API ==========

  /**
   * Shell 操作
   */
  shell: {
    /**
     * 在文件管理器中打开指定路径
     * @param path 要打开的文件或目录路径
     * @returns 空字符串表示成功，否则返回错误信息
     */
    openPath: (path: string): Promise<string> => {
      return ipcRenderer.invoke('shell:openPath', path);
    },
  },

  internalBrowser: {
    getDevToolsConfig: (): Promise<{
      success: boolean;
      config?: InternalBrowserDevToolsConfig;
      error?: string;
    }> => {
      return ipcRenderer.invoke('internal-browser:get-devtools-config');
    },

    setDevToolsConfig: (
      config: InternalBrowserDevToolsConfig
    ): Promise<{
      success: boolean;
      config?: InternalBrowserDevToolsConfig;
      error?: string;
    }> => {
      return ipcRenderer.invoke('internal-browser:set-devtools-config', config);
    },
  },

  // ========== 软件更新 API ==========

  /**
   * 更新管理器
   */
  updater: {
    // 检查更新
    checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),

    // 下载更新（通常自动下载，此方法用于重试）
    downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),

    // 安装更新并重启
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),

    // 获取当前版本
    getVersion: () => ipcRenderer.invoke('updater:get-version'),

    // 监听：正在检查更新
    onChecking: (callback: () => void) => {
      const subscription = () => callback();
      ipcRenderer.on('updater:checking', subscription);
      return () => ipcRenderer.removeListener('updater:checking', subscription);
    },

    // 监听：发现新版本
    onUpdateAvailable: (
      callback: (info: {
        version: string;
        releaseDate: string;
        releaseNotes: string;
        isForceUpdate: boolean;
      }) => void
    ) => {
      const subscription = (_: IpcRendererEvent, info: any) => callback(info);
      ipcRenderer.on('updater:available', subscription);
      return () => ipcRenderer.removeListener('updater:available', subscription);
    },

    // 监听：已是最新版本
    onUpdateNotAvailable: (callback: (info: { version: string }) => void) => {
      const subscription = (_: IpcRendererEvent, info: any) => callback(info);
      ipcRenderer.on('updater:not-available', subscription);
      return () => ipcRenderer.removeListener('updater:not-available', subscription);
    },

    // 监听：下载进度
    onDownloadProgress: (
      callback: (progress: {
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }) => void
    ) => {
      const subscription = (_: IpcRendererEvent, progress: any) => callback(progress);
      ipcRenderer.on('updater:download-progress', subscription);
      return () => ipcRenderer.removeListener('updater:download-progress', subscription);
    },

    // 监听：下载完成
    onUpdateDownloaded: (callback: (info: { version: string; isForceUpdate: boolean }) => void) => {
      const subscription = (_: IpcRendererEvent, info: any) => callback(info);
      ipcRenderer.on('updater:downloaded', subscription);
      return () => ipcRenderer.removeListener('updater:downloaded', subscription);
    },

    // 监听：更新错误
    onError: (callback: (error: { message: string; isForceUpdate: boolean }) => void) => {
      const subscription = (_: IpcRendererEvent, error: any) => callback(error);
      ipcRenderer.on('updater:error', subscription);
      return () => ipcRenderer.removeListener('updater:error', subscription);
    },
  },

  // ========== HTTP API 配置 ==========

  httpApi: {
    /**
     * 获取 HTTP API 配置
     */
    getConfig: (): Promise<{
      success: boolean;
      storedConfig?: any;
      effectiveConfig?: any;
      runtimeOverrides?: {
        enabled: boolean;
        enableMcp: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('http-api:get-config');
    },

    /**
     * 设置 HTTP API 配置
     */
    setConfig: (
      config: any
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('http-api:set-config', config);
    },

    /**
     * 获取 HTTP API 运行时状态（健康信息 + 告警 + 指标）
     */
    getRuntimeStatus: (): Promise<{
      success: boolean;
      running?: boolean;
      reachable?: boolean;
      port?: number;
      health?: any;
      metrics?: any;
      runtimeAlerts?: Array<{
        code: string;
        severity: 'warning' | 'critical';
        value: number;
        threshold: number;
        message: string;
      }>;
      diagnosis?: {
        code:
          | 'healthy_self'
          | 'healthy_other_airpa'
          | 'no_listener'
          | 'unresponsive_listener'
          | 'unexpected_health_response';
        severity: 'info' | 'warning' | 'critical';
        owner: 'self' | 'other_airpa' | 'unknown';
        summary: string;
        detail?: string;
        suggestedAction?: string;
        httpStatus?: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('http-api:get-runtime-status');
    },

    repairRuntime: (): Promise<{
      success: boolean;
      repaired?: boolean;
      action?: 'started_self' | 'restarted_self' | 'blocked' | 'noop' | 'failed';
      message?: string;
      running?: boolean;
      reachable?: boolean;
      port?: number;
      health?: any;
      metrics?: any;
      runtimeAlerts?: Array<{
        code: string;
        severity: 'warning' | 'critical';
        value: number;
        threshold: number;
        message: string;
      }>;
      diagnosis?: {
        code:
          | 'healthy_self'
          | 'healthy_other_airpa'
          | 'no_listener'
          | 'unresponsive_listener'
          | 'unexpected_health_response';
        severity: 'info' | 'warning' | 'critical';
        owner: 'self' | 'other_airpa' | 'unknown';
        summary: string;
        detail?: string;
        suggestedAction?: string;
        httpStatus?: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('http-api:repair-runtime');
    },
  },

  // ========== 云端登录（private admin） ==========

  cloudAuth: {
    /**
     * 获取当前登录会话
     */
    getSession: (): Promise<{
      success: boolean;
      data?: {
        loggedIn: boolean;
        authRevision: number;
        expire?: string;
        user?: {
          userId: number;
          userName: string;
          name?: string;
          deptId?: number;
          avatar?: string;
          roles?: string[];
        };
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:get-session');
    },

    /**
     * 监听云端会话变化
     */
    onSessionChanged: (
      callback: (event: {
        session: {
          loggedIn: boolean;
          authRevision: number;
          expire?: string;
          user?: {
            userId: number;
            userName: string;
            name?: string;
            deptId?: number;
            avatar?: string;
            roles?: string[];
          };
        };
        reason: 'login' | 'logout' | 'expired' | 'remote_unauthorized' | 'workbench_sync_failed';
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, payload: any) => callback(payload);
      ipcRenderer.on('cloud-auth:session-changed', subscription);
      return () => {
        ipcRenderer.removeListener('cloud-auth:session-changed', subscription);
      };
    },

    /**
     * 拉取验证码
     */
    getCaptcha: (): Promise<{
      success: boolean;
      data?: {
        uuid: string;
        imageBase64: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:get-captcha');
    },

    /**
     * 登录云端
     */
    login: (params: {
      username: string;
      password: string;
      captchaCode?: string;
      captchaUuid?: string;
    }): Promise<{
      success: boolean;
      data?: {
        loggedIn: boolean;
        authRevision: number;
        expire?: string;
        user?: {
          userId: number;
          userName: string;
          name?: string;
          deptId?: number;
          avatar?: string;
          roles?: string[];
        };
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:login', params);
    },

    /**
     * 退出登录
     */
    logout: (): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:logout');
    },
  },

  // ========== 云端快照（Profile 配置 + Cookie） ==========

  cloudSnapshot: {
    /**
     * 获取当前会话的云端快照能力（view/cache/edit/delete）
     */
    getCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        profile: {
          view: boolean;
          cache: boolean;
          edit: boolean;
          delete: boolean;
        };
        account: {
          view: boolean;
          cache: boolean;
          edit: boolean;
          delete: boolean;
        };
        scopes?: Array<{
          scopeType?: string;
          scopeId?: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-capabilities', options);
    },

    /**
     * 获取公共云配置列表（需登录）
     */
    getActiveScope: (options?: {
      forceRefreshCapabilities?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        activeScope: {
          scopeType: string;
          scopeId: number;
        };
        availableScopes: Array<{
          scopeType: string;
          scopeId: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-active-scope', options);
    },

    setActiveScope: (
      input?: {
        scopeType?: string;
        scopeId?: number;
      } | null
    ): Promise<{
      success: boolean;
      data?: {
        capabilities: {
          profile: {
            view: boolean;
            cache: boolean;
            edit: boolean;
            delete: boolean;
          };
          account: {
            view: boolean;
            cache: boolean;
            edit: boolean;
            delete: boolean;
          };
          scopes?: Array<{
            scopeType?: string;
            scopeId?: number;
          }>;
        };
        activeScope: {
          scopeType: string;
          scopeId: number;
        };
        availableScopes: Array<{
          scopeType: string;
          scopeId: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:set-active-scope', input);
    },

    listPublic: (params?: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          profileUid?: string;
          cloudUid: string;
          name: string;
          engine: 'electron' | 'extension' | 'ruyi';
          ownerUserId: number;
          ownerUserName?: string;
          visibility: 'public' | 'private';
          version: number;
          updatedAt: string;
          lastSyncedAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:list-public', params);
    },

    /**
     * 获取我的云配置列表（需登录）
     */
    listMine: (params?: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          profileUid?: string;
          cloudUid: string;
          name: string;
          engine: 'electron' | 'extension' | 'ruyi';
          ownerUserId: number;
          ownerUserName?: string;
          visibility: 'public' | 'private';
          version: number;
          updatedAt: string;
          lastSyncedAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:list-mine', params);
    },

    /**
     * 拉取账号共享快照并应用到本地（账号/平台/标签）
     */
    pullAccountBundle: (): Promise<{
      success: boolean;
      data?: {
        snapshotUid?: string;
        schemaVersion: number;
        version: number;
        contentHash?: string;
        accountCount: number;
        siteCount: number;
        tagCount: number;
        unresolvedProfileRefs: Array<{
          profileUid?: string;
          cloudUid?: string;
        }>;
        applied: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:pull-account-bundle');
    },

    /**
     * 将云端 Profile 拉取到本地
     */
    pullProfile: (
      cloudUid: string,
      options?: { forceCreate?: boolean; targetLocalProfileId?: string }
    ): Promise<{
      success: boolean;
      data?: {
        profileUid?: string;
        cloudUid: string;
        localProfileId: string;
        version: number;
        createdLocal: boolean;
        importedCookies: number;
        downloadedExtensions?: number;
        boundExtensions?: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:pull-profile', cloudUid, options);
    },

    /**
     * 获取本地云同步映射
     */
    pushProfile: (
      localProfileId: string,
      options?: { deviceFingerprint?: string; onConflict?: 'error' | 'overwrite' }
    ): Promise<{
      success: boolean;
      data?: {
        profileId: string;
        profileUid?: string;
        cloudUid: string;
        version: number;
        contentHash?: string;
        created: boolean;
        cookieCount: number;
        extensionCount: number;
        conflictResolved?: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:push-profile', localProfileId, options);
    },

    pushAccountBundle: (options?: {
      deviceFingerprint?: string;
      onConflict?: 'error' | 'overwrite';
    }): Promise<{
      success: boolean;
      data?: {
        snapshotUid?: string;
        schemaVersion: number;
        version: number;
        contentHash?: string;
        created: boolean;
        accountCount: number;
        siteCount: number;
        tagCount: number;
        conflictResolved?: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:push-account-bundle', options);
    },

    deleteCloudProfile: (
      localProfileId: string
    ): Promise<{
      success: boolean;
      data?: {
        localProfileId: string;
        cloudUid?: string;
        remoteDeleted: boolean;
        mappingRemoved: boolean;
        skipped?: 'mapping_not_found';
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:delete-cloud-profile', localProfileId);
    },

    getMappings: (): Promise<{
      success: boolean;
      data?: Array<{
        localProfileId: string;
        profileUid?: string;
        cloudUid: string;
        version: number;
        contentHash?: string;
        updatedAt: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-mappings');
    },
  },

  // ========== 插件市场（公司目录） ==========

  cloudPlugin: {
    /**
     * 获取云端插件目录（全量视图）
     */
    listCatalog: (params: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          pluginCode: string;
          name: string;
          description?: string;
          artifactKind?: 'runtime_plugin';
          currentVersion?: string;
          minClientVersion?: string;
          clientVersion?: string;
          canInstall?: boolean;
          installReason?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:list', params);
    },

    /**
     * 获取云端插件目录（兼容旧命名）
     */
    /**
     * 获取单个运行时插件详情（按 pluginCode + profileUid）
     */
    getRuntimeDetail: (params: {
      pluginCode: string;
      profileUid: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginCode: string;
        name: string;
        description?: string;
        artifactKind?: 'runtime_plugin';
        currentVersion?: string;
        minClientVersion?: string;
        clientVersion?: string;
        allowed?: boolean;
        reason?: string;
        canInstall?: boolean;
        installReason?: string;
        canUse?: boolean;
        useReason?: string;
        canCache?: boolean;
        cacheReason?: string;
        endpoints?: Array<{
          endpointCode: string;
          name: string;
          type: 'FORWARD' | 'JS_FILE';
          allowCacheJs?: boolean;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-runtime-detail', params);
    },

    /**
     * 获取当前用户可见的运行时调用日志
     */
    listRuntimeLogs: (params?: {
      pageIndex?: number;
      pageSize?: number;
      pluginCode?: string;
      endpointCode?: string;
      endpointType?: string;
      action?: string;
      profileUid?: string;
      allowed?: boolean;
      responseCode?: number;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          id: number;
          pluginCode: string;
          endpointCode: string;
          endpointType: string;
          action: string;
          userId: number;
          profileUid?: string;
          allowed: boolean;
          reason?: string;
          responseCode: number;
          durationMs: number;
          targetUrl?: string;
          clientIp?: string;
          errorMessage?: string;
          createdAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:list-runtime-logs', params);
    },

    /**
     * 获取目录能力（view/install/use/cache + policyVersion）
     */
    getCatalogCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        actions: {
          view: boolean;
          install: boolean;
          use: boolean;
          cache: boolean;
        };
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-capabilities', options);
    },

    /**
     * 获取运行时能力（兼容旧命名）
     */
    /**
     * 插件授权检查
     */
    authorize: (params: {
      pluginCode: string;
      profileUid: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginCode: string;
        profileUid: string;
        allowed: boolean;
        reason: string;
        clientVersion?: string;
        minClientVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:authorize', params);
    },

    /**
     * 插件安装授权检查
     */
    authorizeInstall: (params: {
      pluginCode: string;
    }): Promise<{
      success: boolean;
      data?: {
        allowed: boolean;
        reason: string;
        pluginCode: string;
        releaseVersion?: string;
        downloadToken?: string;
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:authorize-install', params);
    },

    /**
     * 安装云端托管插件（安装鉴权 -> 下载 -> 本地导入）
     */
    install: (params: {
      pluginCode: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginId: string;
        pluginCode: string;
        releaseVersion?: string;
        policyVersion?: string;
        operation?: 'installed' | 'updated';
        warnings?: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:install', params);
    },

    /**
     * 获取 JS_FILE 文件内容
     */
    getJSFile: (params: {
      pluginCode: string;
      endpointCode: string;
      profileUid: string;
      ifNoneMatch?: string;
      allowCacheJs?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        statusCode: number;
        notModified: boolean;
        etag?: string;
        contentType?: string;
        content?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-js-file', params);
    },

    /**
     * 调用 FORWARD 转发接口
     */
    forward: (params: {
      pluginCode: string;
      endpointCode: string;
      profileUid: string;
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    }): Promise<{
      success: boolean;
      data?: {
        statusCode: number;
        headers?: Record<string, string>;
        body?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:forward', params);
    },
  },

  // ========== 浏览器扩展云端目录 ==========

  cloudBrowserExtension: {
    listCatalog: (params: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          extensionId: string;
          name: string;
          description?: string;
          currentVersion?: string;
          minClientVersion?: string;
          clientVersion?: string;
          canInstall?: boolean;
          installReason?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:list', params);
    },

    getCatalogCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        actions: {
          view: boolean;
          install: boolean;
        };
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:get-capabilities', options);
    },

    authorizeInstall: (params: {
      extensionId: string;
    }): Promise<{
      success: boolean;
      data?: {
        allowed: boolean;
        reason: string;
        extensionId: string;
        releaseVersion?: string;
        downloadToken?: string;
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:authorize-install', params);
    },
  },

  // ========== OCR Pool 配置 ==========

  ocrPool: {
    /**
     * 获取 OCR Pool 配置
     */
    getConfig: (): Promise<{
      success: boolean;
      config?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('ocr-pool:get-config');
    },

    /**
     * 设置 OCR Pool 配置
     */
    setConfig: (
      config: any
    ): Promise<{
      success: boolean;
      config?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('ocr-pool:set-config', config);
    },
  },

  // ========== 定时任务调度 API ==========

  scheduler: {
    /**
     * 获取所有定时任务
     */
    getAllTasks: (): Promise<{
      success: boolean;
      tasks?: any[];
      total?: number;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-all-tasks');
    },

    /**
     * 获取插件的任务
     */
    getTasksByPlugin: (
      pluginId: string
    ): Promise<{
      success: boolean;
      tasks?: any[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-tasks-by-plugin', pluginId);
    },

    /**
     * 获取单个任务
     */
    getTask: (
      taskId: string
    ): Promise<{
      success: boolean;
      task?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-task', taskId);
    },

    /**
     * 获取任务执行历史
     */
    getTaskHistory: (
      taskId: string,
      limit?: number
    ): Promise<{
      success: boolean;
      executions?: any[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-task-history', taskId, limit);
    },

    /**
     * 暂停任务
     */
    pauseTask: (
      taskId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:pause-task', taskId);
    },

    /**
     * 恢复任务
     */
    resumeTask: (
      taskId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:resume-task', taskId);
    },

    /**
     * 手动触发任务
     */
    triggerTask: (
      taskId: string
    ): Promise<{
      success: boolean;
      execution?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:trigger-task', taskId);
    },

    /**
     * 取消任务
     */
    cancelTask: (
      taskId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:cancel-task', taskId);
    },

    /**
     * 获取统计信息
     */
    getStats: (): Promise<{
      success: boolean;
      stats?: {
        total: number;
        active: number;
        paused: number;
        disabled: number;
        todayExecutions: number;
        todayFailed: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-stats');
    },

    /**
     * 获取最近执行记录
     */
    getRecentExecutions: (
      limit?: number
    ): Promise<{
      success: boolean;
      executions?: any[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('scheduler:get-recent-executions', limit);
    },
  },

  // ========== 🆕 v2 浏览器配置管理 API ==========

  profile: {
    // === Profile CRUD ===

    /**
     * 创建浏览器配置
     */
    create: (
      params: CreateProfileParams
    ): Promise<{
      success: boolean;
      data?: BrowserProfile;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:create', params);
    },

    /**
     * 获取单个浏览器配置
     */
    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: BrowserProfile;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:get', id);
    },

    /**
     * 列出浏览器配置
     */
    list: (
      params?: ProfileListParams
    ): Promise<{
      success: boolean;
      data?: BrowserProfile[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:list', params);
    },

    /**
     * 更新浏览器配置
     */
    update: (
      id: string,
      params: UpdateProfileParams
    ): Promise<{
      success: boolean;
      data?: BrowserProfile;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:update', id, params);
    },

    /**
     * 删除浏览器配置
     */
    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:delete', id);
    },

    // === Profile 状态管理 ===

    /**
     * 更新配置状态
     */
    updateStatus: (
      id: string,
      status: 'idle' | 'active' | 'error',
      error?: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:update-status', id, status, error);
    },

    /**
     * 检查配置是否可用
     */
    isAvailable: (
      id: string
    ): Promise<{
      success: boolean;
      data?: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:is-available', id);
    },

    // === Profile 统计 ===

    /**
     * 获取配置统计信息
     */
    getStats: (): Promise<{
      success: boolean;
      data?: {
        total: number;
        idle: number;
        active: number;
        error: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:get-stats');
    },

    // === 浏览器关闭 ===

    /**
     * 关闭浏览器
     */
    close: (
      id: string,
      viewId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:close', id, viewId);
    },

    // === 浏览器池操作 (v2) ===

    /**
     * 通过浏览器池获取浏览器（支持一个 Profile 多浏览器）
     */
    poolLaunch: (
      profileId: string,
      options?: {
        pluginId?: string;
        timeout?: number;
        strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
        browserId?: string;
        engine?: AutomationEngine;
      }
    ): Promise<{
      success: boolean;
      data?: {
        browserId: string;
        sessionId: string;
        profileId: string;
        engine?: AutomationEngine;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-launch', profileId, options);
    },

    /**
     * 释放浏览器回池
     */
    poolRelease: (
      browserId: string,
      options?: {
        destroy?: boolean;
        navigateTo?: string;
        clearStorage?: boolean;
      }
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-release', browserId, options);
    },

    /**
     * 获取浏览器池统计信息
     */
    poolStats: (): Promise<{
      success: boolean;
      data?: {
        totalBrowsers: number;
        idleBrowsers: number;
        lockedBrowsers: number;
        sessionsCount: number;
        waitingRequests: number;
        browsersBySession: Record<string, { total: number; idle: number; locked: number }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-stats');
    },

    /**
     * 列出当前浏览器池中的所有浏览器实例（用于 UI 查看）
     */
    poolListBrowsers: (): Promise<{
      success: boolean;
      data?: import('../types/profile').PoolBrowserInfo[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-list-browsers');
    },

    /**
     * 在弹窗中打开（显示）运行中的浏览器实例
     */
    poolShowBrowser: (
      browserId: string,
      options?: { title?: string; width?: number; height?: number }
    ): Promise<{
      success: boolean;
      data?: {
        popupId?: string;
        viewId?: string;
        popupWindowId?: string;
        engine?: AutomationEngine;
        activated?: boolean;
        browserId?: string;
        relaunched?: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-show-browser', browserId, options);
    },

    /**
     * 获取指定 Profile 的浏览器统计
     */
    poolProfileStats: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: {
        sessionId: string;
        quota: number;
        browserCount: number;
        idleCount: number;
        lockedCount: number;
        waitingCount: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-profile-stats', profileId);
    },

    /**
     * 销毁指定 Profile 的所有浏览器（用于显式“重启”以应用代理/性能设置）
     */
    poolDestroyProfileBrowsers: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: { destroyed: number };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-destroy-profile-browsers', profileId);
    },

    /**
     * 释放插件持有的所有浏览器
     */
    poolReleaseByPlugin: (
      pluginId: string
    ): Promise<{
      success: boolean;
      data?: {
        browsers: number;
        requests: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile:pool-release-by-plugin', pluginId);
    },
  },

  // ========== 🆕 v2 浏览器配置分组 API ==========

  profileGroup: {
    /**
     * 创建分组
     */
    create: (
      params: CreateGroupParams
    ): Promise<{
      success: boolean;
      data?: ProfileGroup;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:create', params);
    },

    /**
     * 获取单个分组
     */
    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: ProfileGroup;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:get', id);
    },

    /**
     * 列出所有分组（扁平列表）
     */
    list: (): Promise<{
      success: boolean;
      data?: ProfileGroup[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:list');
    },

    /**
     * 列出分组树
     */
    listTree: (): Promise<{
      success: boolean;
      data?: ProfileGroup[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:list-tree');
    },

    /**
     * 更新分组
     */
    update: (
      id: string,
      params: UpdateGroupParams
    ): Promise<{
      success: boolean;
      data?: ProfileGroup;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:update', id, params);
    },

    /**
     * 删除分组
     */
    delete: (
      id: string,
      recursive?: boolean
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('profile-group:delete', id, recursive);
    },
  },

  // =====================================================
  // 浏览器池配置 API (v2)
  // =====================================================
  browserPool: {
    /**
     * 获取当前浏览器池配置
     */
    getConfig: (): Promise<{
      success: boolean;
      data?: {
        mode: 'light' | 'standard' | 'performance' | 'custom';
        maxTotalBrowsers: number;
        maxConcurrentCreation: number;
        defaultIdleTimeoutMs: number;
        defaultLockTimeoutMs: number;
        healthCheckIntervalMs: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-pool:get-config');
    },

    /**
     * 更新浏览器池配置
     */
    setConfig: (
      config: Partial<{
        mode: 'light' | 'standard' | 'performance' | 'custom';
        maxTotalBrowsers: number;
        maxConcurrentCreation: number;
        defaultIdleTimeoutMs: number;
        defaultLockTimeoutMs: number;
        healthCheckIntervalMs: number;
      }>
    ): Promise<{
      success: boolean;
      data?: {
        mode: 'light' | 'standard' | 'performance' | 'custom';
        maxTotalBrowsers: number;
        maxConcurrentCreation: number;
        defaultIdleTimeoutMs: number;
        defaultLockTimeoutMs: number;
        healthCheckIntervalMs: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-pool:set-config', config);
    },

    /**
     * 应用预设配置
     */
    applyPreset: (
      preset: 'light' | 'standard' | 'performance'
    ): Promise<{
      success: boolean;
      data?: {
        mode: 'light' | 'standard' | 'performance' | 'custom';
        maxTotalBrowsers: number;
        maxConcurrentCreation: number;
        defaultIdleTimeoutMs: number;
        defaultLockTimeoutMs: number;
        healthCheckIntervalMs: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-pool:apply-preset', preset);
    },

    /**
     * 获取预设列表和限制
     */
    getPresets: (): Promise<{
      success: boolean;
      data?: {
        presets: Record<
          'light' | 'standard' | 'performance',
          {
            maxTotalBrowsers: number;
            maxConcurrentCreation: number;
            defaultIdleTimeoutMs: number;
            defaultLockTimeoutMs: number;
            healthCheckIntervalMs: number;
          }
        >;
        limits: Record<
          string,
          {
            min: number;
            max: number;
          }
        >;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-pool:get-presets');
    },

    /**
     * 重置为默认配置
     */
    resetConfig: (): Promise<{
      success: boolean;
      data?: {
        mode: 'light' | 'standard' | 'performance' | 'custom';
        maxTotalBrowsers: number;
        maxConcurrentCreation: number;
        defaultIdleTimeoutMs: number;
        defaultLockTimeoutMs: number;
        healthCheckIntervalMs: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-pool:reset-config');
    },
  },

  // =====================================================
  // Extension packages 管理 API
  // =====================================================

  extensionPackages: {
    selectLocalDirectories: (): Promise<{
      success: boolean;
      data?: {
        canceled: boolean;
        paths: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:select-local-directories');
    },

    selectLocalArchives: (): Promise<{
      success: boolean;
      data?: {
        canceled: boolean;
        paths: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:select-local-archives');
    },

    listPackages: (): Promise<{
      success: boolean;
      data?: ExtensionPackage[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:list-packages');
    },

    importLocalPackages: (
      inputs: Array<{ path: string; extensionIdHint?: string }>
    ): Promise<{
      success: boolean;
      data?: {
        succeeded: ExtensionPackage[];
        failed: Array<{
          path: string;
          extensionIdHint?: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:import-local-packages', inputs);
    },

    downloadCloudCatalogPackages: (
      inputs: Array<{
        extensionId: string;
        name?: string;
      }>
    ): Promise<{
      success: boolean;
      data?: {
        succeeded: ExtensionPackage[];
        failed: Array<{
          extensionId: string;
          name?: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:download-cloud-catalog-packages', inputs);
    },

    listProfileBindings: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: ProfileExtensionBinding[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:list-profile-bindings', profileId);
    },

    batchBind: (input: {
      profileIds: string[];
      packages: Array<{
        extensionId: string;
        version?: string | null;
        installMode?: 'required' | 'optional';
        sortOrder?: number;
        enabled?: boolean;
      }>;
    }): Promise<{
      success: boolean;
      data?: {
        success: boolean;
        affectedProfiles: string[];
        destroyedBrowsers: number;
        restartFailures: Array<{
          profileId: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:batch-bind', input);
    },

    batchUnbind: (input: {
      profileIds: string[];
      extensionIds: string[];
      removePackageWhenUnused?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        removedBindings: number;
        removedPackages: string[];
        affectedProfiles: string[];
        destroyedBrowsers: number;
        restartFailures: Array<{
          profileId: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:batch-unbind', input);
    },
  },

  // =====================================================
  // 账号管理 API (v2)
  // =====================================================
  account: {
    /**
     * 创建账号
     */
    create: (
      params: CreateAccountParams
    ): Promise<{
      success: boolean;
      data?: Account;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:create', params);
    },

    createWithAutoProfile: (
      params: CreateAccountWithAutoProfileParams
    ): Promise<{
      success: boolean;
      data?: { profile: BrowserProfile; account: Account };
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:create-with-auto-profile', params);
    },

    /**
     * 获取单个账号
     */
    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: Account | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:get', id);
    },

    /**
     * 列出某个 Profile 的所有账号
     */
    listByProfile: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-by-profile', profileId);
    },

    /**
     * 按平台列出账号
     */
    listByPlatform: (
      platformId: string
    ): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-by-platform', platformId);
    },

    /**
     * 列出所有账号
     */
    listAll: (): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-all');
    },

    revealSecret: (
      id: string
    ): Promise<{
      success: boolean;
      data?: string | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:reveal-secret', id);
    },

    /**
     * 更新账号
     */
    update: (
      id: string,
      params: UpdateAccountParams
    ): Promise<{
      success: boolean;
      data?: Account;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:update', id, params);
    },

    /**
     * 删除账号
     */
    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:delete', id);
    },

    /**
     * 启动浏览器并登录账号
     * @param accountId - 账号 ID
     * @param options - 登录选项（弹窗显示等）
     */
    login: (
      accountId: string,
      options?: {
        /** 是否在弹窗中显示浏览器，默认 true */
        showPopup?: boolean;
        /** 弹窗宽度 */
        popupWidth?: number;
        /** 弹窗高度 */
        popupHeight?: number;
      }
    ): Promise<{
      success: boolean;
      data?: {
        viewId: string;
        browserId: string;
        sessionId: string;
        accountId: string;
        accountName: string;
        profileId: string;
        profileName: string;
        loginUrl: string;
        platformId?: string | null;
        platformName?: string | null;
        /** 弹窗 ID（用于手动关闭弹窗） */
        popupId: string | null;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:login', accountId, options);
    },

    /**
     * 关闭弹窗窗口
     * @param popupId - 弹窗 ID（从 login 返回）
     */
    closePopup: (
      popupId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('popup:close', popupId);
    },
  },

  // =====================================================
  // 常用网站 API (v2)
  // =====================================================
  savedSite: {
    /**
     * 创建常用网站
     */
    create: (
      params: CreateSavedSiteParams
    ): Promise<{
      success: boolean;
      data?: SavedSite;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:create', params);
    },

    /**
     * 获取单个常用网站
     */
    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: SavedSite | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:get', id);
    },

    /**
     * 按名称获取常用网站
     */
    getByName: (
      name: string
    ): Promise<{
      success: boolean;
      data?: SavedSite | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:get-by-name', name);
    },

    /**
     * 列出所有常用网站
     */
    list: (): Promise<{
      success: boolean;
      data?: SavedSite[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:list');
    },

    /**
     * 更新常用网站
     */
    update: (
      id: string,
      params: UpdateSavedSiteParams
    ): Promise<{
      success: boolean;
      data?: SavedSite;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:update', id, params);
    },

    /**
     * 删除常用网站
     */
    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:delete', id);
    },

    /**
     * 增加使用次数
     */
    incrementUsage: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:increment-usage', id);
    },
  },

  // =====================================================
  // 标签管理 API (v2)
  // =====================================================
  tag: {
    /**
     * 创建标签
     */
    create: (
      params: CreateTagParams
    ): Promise<{
      success: boolean;
      data?: Tag;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:create', params);
    },

    /**
     * 获取单个标签
     */
    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: Tag | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:get', id);
    },

    /**
     * 通过名称获取标签
     */
    getByName: (
      name: string
    ): Promise<{
      success: boolean;
      data?: Tag | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:get-by-name', name);
    },

    /**
     * 列出所有标签
     */
    list: (): Promise<{
      success: boolean;
      data?: Tag[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:list');
    },

    /**
     * 更新标签
     */
    update: (
      id: string,
      params: UpdateTagParams
    ): Promise<{
      success: boolean;
      data?: Tag;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:update', id, params);
    },

    /**
     * 删除标签
     */
    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:delete', id);
    },

    /**
     * 检查标签名是否存在
     */
    exists: (
      name: string
    ): Promise<{
      success: boolean;
      data?: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:exists', name);
    },
  },
};

type PreloadElectronAPI = typeof electronAPI;

function buildExposedElectronAPI(): PreloadElectronAPI {
  const exposed = electronAPI as unknown as Omit<
    PreloadElectronAPI,
    'cloudAuth' | 'cloudSnapshot' | 'cloudPlugin' | 'cloudBrowserExtension'
  > & {
    cloudAuth?: unknown;
    cloudSnapshot?: unknown;
    cloudPlugin?: unknown;
    cloudBrowserExtension?: unknown;
    extensionPackages: Omit<
      PreloadElectronAPI['extensionPackages'],
      'downloadCloudCatalogPackages'
    > & {
      downloadCloudCatalogPackages?: unknown;
    };
  };

  if (tiansheEdition.name === 'open') {
    delete exposed.cloudAuth;
    delete exposed.cloudSnapshot;
    delete exposed.cloudPlugin;
    delete exposed.cloudBrowserExtension;
    const extensionPackages = exposed.extensionPackages as {
      downloadCloudCatalogPackages?: unknown;
    };
    delete extensionPackages.downloadCloudCatalogPackages;
  }

  return exposed as PreloadElectronAPI;
}

// 暴露 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', buildExposedElectronAPI());

// 类型声明（供 TypeScript 使用）
export type ElectronAPI = PreloadElectronAPI;

// 注意：Window.electronAPI 的类型声明在 src/types/electron.d.ts 中
// 这里不需要重复声明，避免类型冲突

console.log('✅ Preload script loaded');
