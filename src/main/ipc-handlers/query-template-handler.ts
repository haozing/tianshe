/**
 * QueryTemplateIPCHandler - 查询模板 IPC 处理器
 * 处理前端查询模板相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import type { DuckDBService } from '../duckdb/service';
import { quoteQualifiedName } from '../duckdb/utils';
import { handleIPCError } from '../ipc-utils';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';
import { normalizeRuntimeSQL, shouldUseLiveQueryTemplate } from '../../utils/query-runtime';

function buildPagedLiveQuerySQL(sql: string, offset: number, limit: number): string {
  return `SELECT * FROM (${sql}) AS __airpa_live_query_page LIMIT ${limit} OFFSET ${offset}`;
}

export function createQueryTemplateRoutes(duckdb: DuckDBService): IpcRouteDefinition[] {
  return [
    {
      channel: 'query-template:create',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
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

          const templateId = await duckdb.createQueryTemplate(params);

          return { success: true, templateId };
        } catch (error: unknown) {
          console.error('[IPC] query-template:create error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:list',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          console.log(`[IPC] Listing query templates for dataset: ${datasetId}`);

          const templates = await duckdb.listQueryTemplates(datasetId);

          return { success: true, templates };
        } catch (error: unknown) {
          console.error('[IPC] query-template:list error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:get',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, templateId: string) => {
        try {
          console.log(`[IPC] Getting query template: ${templateId}`);

          const template = await duckdb.getQueryTemplate(templateId);

          if (!template) {
            return { success: false, error: `Template not found: ${templateId}` };
          }

          return { success: true, template };
        } catch (error: unknown) {
          console.error('[IPC] query-template:get error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:update',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
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

          await duckdb.updateQueryTemplate(params.templateId, {
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
      },
    },
    {
      channel: 'query-template:refresh',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, params: { templateId: string }) => {
        try {
          if (!params?.templateId) {
            return { success: false, error: 'templateId is required' };
          }

          await duckdb.refreshQueryTemplateSnapshot(params.templateId);
          return { success: true };
        } catch (error: unknown) {
          console.error('[IPC] query-template:refresh error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:delete',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, templateId: string) => {
        try {
          console.log(`[IPC] Deleting query template: ${templateId}`);

          await duckdb.deleteQueryTemplate(templateId);

          return { success: true };
        } catch (error: unknown) {
          console.error('[IPC] query-template:delete error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:reorder',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
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

          await duckdb.reorderQueryTemplates(params.datasetId, params.templateIds);

          return { success: true };
        } catch (error: unknown) {
          console.error('[IPC] query-template:reorder error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:query',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
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
          const template = await duckdb.getQueryTemplate(params.templateId);
          if (!template) {
            return { success: false, error: 'Template not found' };
          }

          const offset = params.offset || 0;
          const limit = params.limit || 50;

          await duckdb.ensureDatasetAttached(template.datasetId);

          let filteredTotalCount = 0;
          let pagedResult: Awaited<ReturnType<DuckDBService['queryDataset']>>;

          if (shouldUseLiveQueryTemplate(template)) {
            const sqlPreview = await duckdb.previewQuerySQL(
              template.datasetId,
              template.queryConfig || {}
            );
            if (!sqlPreview.success || !sqlPreview.sql) {
              return {
                success: false,
                error: sqlPreview.error || 'Failed to generate live query SQL',
              };
            }

            const runtimeSQL = normalizeRuntimeSQL(sqlPreview.sql, template.queryConfig || {});
            const countRows = await duckdb.executeSQLWithParams(
              `SELECT COUNT(*) as total FROM (${runtimeSQL}) AS __airpa_live_query_count`,
              []
            );
            filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

            pagedResult = await duckdb.queryDataset(
              template.datasetId,
              buildPagedLiveQuerySQL(runtimeSQL, offset, limit)
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

            const countRows = await duckdb.executeSQLWithParams(
              `SELECT COUNT(*) as total FROM ${fromTableRef}`,
              []
            );
            filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

            pagedResult = await duckdb.queryDataset(
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
      },
    },
    {
      channel: 'query-template:get-or-create-default',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          console.log(`[IPC] Getting or creating default query template for dataset: ${datasetId}`);

          const template = await duckdb.getOrCreateDefaultQueryTemplate(datasetId);

          return { success: true, template };
        } catch (error: unknown) {
          console.error('[IPC] query-template:get-or-create-default error:', error);
          return handleIPCError(error);
        }
      },
    },
  ];
}

/** @deprecated 使用 createQueryTemplateRoutes + ipcRouteRegistry.registerAll */
export class QueryTemplateIPCHandler {
  constructor(private duckdb: DuckDBService) {}

  register(): void {
    ipcRouteRegistry.registerAll(createQueryTemplateRoutes(this.duckdb));
  }
}
