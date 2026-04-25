/**
 * QueryTemplateIPCHandler - 查询模板 IPC 处理器
 * 处理前端查询模板相关的 IPC 请求
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import type { DuckDBService } from '../duckdb/service';
import { quoteQualifiedName } from '../duckdb/utils';
import { handleIPCError } from '../ipc-utils';
import {
  normalizeRuntimeSQL,
  shouldUseLiveQueryTemplate,
} from '../../utils/query-runtime';

export class QueryTemplateIPCHandler {
  constructor(private duckdb: DuckDBService) {
  }

  private buildPagedLiveQuerySQL(sql: string, offset: number, limit: number): string {
    return `SELECT * FROM (${sql}) AS __airpa_live_query_page LIMIT ${limit} OFFSET ${offset}`;
  }

  /**
   * 注册所有查询模板相关 IPC 处理器
   */
  register(): void {
    this.registerCreateQueryTemplate();
    this.registerListQueryTemplates();
    this.registerGetQueryTemplate();
    this.registerUpdateQueryTemplate();
    this.registerRefreshQueryTemplateSnapshot();
    this.registerDeleteQueryTemplate();
    this.registerReorderQueryTemplates();
    this.registerQueryTemplateData();
    this.registerGetOrCreateDefaultQueryTemplate();
  }

  /**
   * 创建查询模板
   */
  private registerCreateQueryTemplate(): void {
    ipcMain.handle('query-template:create', async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        name: string;
        description?: string;
        icon?: string;
        queryConfig: any;
        generatedSQL: string;
      }
    ) => {
      try {
        console.log(`[IPC] Creating query template: ${params.name}`);

        const templateId = await this.duckdb.createQueryTemplate(params);

        return { success: true, templateId };
      } catch (error: unknown) {
        console.error('[IPC] query-template:create error:', error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 列出数据集查询模板
   */
  private registerListQueryTemplates(): void {
    ipcMain.handle('query-template:list', async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        console.log(`[IPC] Listing query templates for dataset: ${datasetId}`);

        const templates = await this.duckdb.listQueryTemplates(datasetId);

        return { success: true, templates };
      } catch (error: unknown) {
        console.error('[IPC] query-template:list error:', error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取单个查询模板
   */
  private registerGetQueryTemplate(): void {
    ipcMain.handle('query-template:get', async (_event: IpcMainInvokeEvent, templateId: string) => {
      try {
        console.log(`[IPC] Getting query template: ${templateId}`);

        const template = await this.duckdb.getQueryTemplate(templateId);

        if (!template) {
          return { success: false, error: `Template not found: ${templateId}` };
        }

        return { success: true, template };
      } catch (error: unknown) {
        console.error('[IPC] query-template:get error:', error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 更新查询模板
   */
  private registerUpdateQueryTemplate(): void {
    ipcMain.handle('query-template:update', async (
      _event: IpcMainInvokeEvent,
      params: {
        templateId: string;
        name?: string;
        description?: string;
        icon?: string;
        queryConfig?: any;
        generatedSQL?: string;
      }
    ) => {
      try {
        if (!params.templateId) {
          return { success: false, error: 'templateId is required' };
        }

        console.log(`[IPC] Updating query template: ${params.templateId}`);

        await this.duckdb.updateQueryTemplate(params.templateId, {
          name: params.name,
          description: params.description,
          icon: params.icon,
          queryConfig: params.queryConfig,
          generatedSQL: params.generatedSQL,
        });

        return { success: true };
      } catch (error: unknown) {
        console.error('[IPC] query-template:update error:', error);
        return handleIPCError(error);
      }
    });
  }

  private registerRefreshQueryTemplateSnapshot(): void {
    ipcMain.handle(
      'query-template:refresh',
      async (_event: IpcMainInvokeEvent, params: { templateId: string }) => {
        try {
          if (!params?.templateId) {
            return { success: false, error: 'templateId is required' };
          }

          await this.duckdb.refreshQueryTemplateSnapshot(params.templateId);
          return { success: true };
        } catch (error: unknown) {
          console.error('[IPC] query-template:refresh error:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 删除查询模板
   */
  private registerDeleteQueryTemplate(): void {
    ipcMain.handle('query-template:delete', async (_event: IpcMainInvokeEvent, templateId: string) => {
      try {
        console.log(`[IPC] Deleting query template: ${templateId}`);

        await this.duckdb.deleteQueryTemplate(templateId);

        return { success: true };
      } catch (error: unknown) {
        console.error('[IPC] query-template:delete error:', error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 调整查询模板顺序
   */
  private registerReorderQueryTemplates(): void {
    ipcMain.handle('query-template:reorder', async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        templateIds: string[];
      }
    ) => {
      try {
        if (!params.templateIds) {
          return { success: false, error: 'templateIds is required' };
        }

        console.log(`[IPC] Reordering query templates for dataset: ${params.datasetId}`);

        await this.duckdb.reorderQueryTemplates(params.datasetId, params.templateIds);

        return { success: true };
      } catch (error: unknown) {
        console.error('[IPC] query-template:reorder error:', error);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 查询模板快照数据
   */
  private registerQueryTemplateData(): void {
    ipcMain.handle('query-template:query', async (
      _event: IpcMainInvokeEvent,
      params: {
        templateId: string;
        offset?: number;
        limit?: number;
      }
    ) => {
      try {
        if (!params.templateId) {
          return { success: false, error: 'templateId is required' };
        }

        console.log(`[IPC] ========== QUERY TEMPLATE ==========`);
        console.log(`[IPC] Querying query template: ${params.templateId}`);

        // 1. 获取模板配置
        const template = await this.duckdb.getQueryTemplate(params.templateId);
        if (!template) {
          return { success: false, error: 'Template not found' };
        }

        const offset = params.offset || 0;
        const limit = params.limit || 50;

        await this.duckdb.ensureDatasetAttached(template.datasetId);

        let filteredTotalCount = 0;
        let pagedResult: Awaited<ReturnType<DuckDBService['queryDataset']>>;

        if (shouldUseLiveQueryTemplate(template)) {
          const sqlPreview = await this.duckdb.previewQuerySQL(
            template.datasetId,
            template.queryConfig || {}
          );
          if (!sqlPreview.success || !sqlPreview.sql) {
            return { success: false, error: sqlPreview.error || 'Failed to generate live query SQL' };
          }

          const runtimeSQL = normalizeRuntimeSQL(sqlPreview.sql, template.queryConfig || {});
          const countRows = await this.duckdb.executeSQLWithParams(
            `SELECT COUNT(*) as total FROM (${runtimeSQL}) AS __airpa_live_query_count`,
            []
          );
          filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

          pagedResult = await this.duckdb.queryDataset(
            template.datasetId,
            this.buildPagedLiveQuerySQL(runtimeSQL, offset, limit)
          );
        } else {
          if (!template.snapshotTableName) {
            return { success: false, error: 'Template snapshot not found' };
          }
          const fromTableRef = quoteQualifiedName(
            `ds_${template.datasetId}`,
            template.snapshotTableName
          );
          console.log(`[IPC] Querying snapshot table: ${fromTableRef}`);

          const countRows = await this.duckdb.executeSQLWithParams(
            `SELECT COUNT(*) as total FROM ${fromTableRef}`,
            []
          );
          filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

          pagedResult = await this.duckdb.queryDataset(
            template.datasetId,
            `SELECT * FROM ${fromTableRef} ORDER BY rowid`,
            offset,
            limit
          );
        }

        console.log(
          `[IPC] ✅ Query succeeded: ${pagedResult.rows?.length || 0} rows (total=${filteredTotalCount})`
        );
        console.log(`[IPC] ======================================`);

        return {
          success: true,
          result: {
            columns: pagedResult.columns || [],
            rows: pagedResult.rows || [],
            rowCount: pagedResult.rowCount || 0,
            filteredTotalCount,
          },
        };
      } catch (error: unknown) {
        console.error('[IPC] ❌ query-template:query error:', error);
        console.log(`[IPC] ======================================`);
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取或创建默认查询模板
   */
  private registerGetOrCreateDefaultQueryTemplate(): void {
    ipcMain.handle('query-template:get-or-create-default', async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        console.log(`[IPC] Getting or creating default query template for dataset: ${datasetId}`);

        const template = await this.duckdb.getOrCreateDefaultQueryTemplate(datasetId);

        return { success: true, template };
      } catch (error: unknown) {
        console.error('[IPC] query-template:get-or-create-default error:', error);
        return handleIPCError(error);
      }
    });
  }

}

