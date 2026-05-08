/**
 * DatasetExportService - 数据集导出服务
 *
 * 职责：
 * - 多格式数据导出（CSV, Excel, JSON, Parquet, TXT）
 * - 导出 SQL 构建（支持查询模板筛选、隐藏列）
 * - Excel 大文件拆分（>1M 行）
 * - 导出后操作（可选物理删除）
 * - 导出进度跟踪
 *
 * 📤 支持5种主流格式，智能处理大数据集
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetStorageService, sanitizeDatasetId } from './dataset-storage-service';
import { quoteQualifiedName } from './utils';
import type { ExportOptions, ExportProgress, ExportResult } from '../../types/electron';
import {
  DatasetExportPlanBuilder,
  type ExportQuerySQLBuilder,
} from './dataset-export-plan-builder';
import { DatasetExportWriter } from './dataset-export-writer';

export type { ExportQuerySQLBuilder } from './dataset-export-plan-builder';

export class DatasetExportService {
  private exportPlanBuilder: DatasetExportPlanBuilder;
  private exportWriter: DatasetExportWriter;

  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService,
    private storageService: DatasetStorageService,
    exportQuerySQLBuilder?: ExportQuerySQLBuilder
  ) {
    this.exportPlanBuilder = new DatasetExportPlanBuilder(exportQuerySQLBuilder ?? null);
    this.exportWriter = new DatasetExportWriter(conn);
  }

  /**
   * 📤 主导出方法
   *
   * 支持多种格式：CSV, Excel, JSON, Parquet, TXT
   * 自动处理大文件拆分、查询模板筛选、隐藏列等
   *
   * @param options 导出选项
   * @param onProgress 进度回调
   * @returns 导出结果
   */
  async exportDataset(
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<ExportResult> {
    const { datasetId } = options;
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(sanitizedId, async () => {
      const startTime = Date.now();
      const {
        outputPath,
        format,
        mode = 'data',
        respectHiddenColumns = true,
        applyFilters = true,
        applySort = true,
        applySample = false,
        postExportAction = 'keep',
        activeQueryTemplate,
        batchSize,
      } = options;
      const normalizedPostExportAction: 'keep' | 'delete' =
        postExportAction === 'delete' ? 'delete' : 'keep';

      console.log('[ExportService] Starting export:', { datasetId, format, mode, outputPath });

      // 发送初始进度
      onProgress?.({
        current: 0,
        total: 1,
        message: '正在准备导出...',
        percentage: 0,
      });

      // 1. 验证数据集存在
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${datasetId}`);
      }

      // 2. 确保数据库已 attached
      const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      await this.storageService.smartAttach(sanitizedId, escapedPath);

      try {
        // 3. 构建导出 SQL
        onProgress?.({
          current: 0,
          total: 1,
          message: '正在构建查询...',
          percentage: 10,
        });

        const exportPlan = await this.exportPlanBuilder.buildExportPlan({
          datasetId: sanitizedId,
          mode,
          respectHiddenColumns,
          applyFilters,
          applySort,
          applySample,
          shouldDeleteRows: normalizedPostExportAction === 'delete' && mode === 'data',
          columns: options.columns,
          selectedRowIds: options.selectedRowIds,
          queryTemplate: activeQueryTemplate,
          schema: dataset.schema ?? [],
        });
        const { exportSQL } = exportPlan;

        console.log('[ExportService] Export SQL:', exportSQL);

        // 4. 执行导出（根据格式）
        onProgress?.({
          current: 0,
          total: 1,
          message: '正在导出数据...',
          percentage: 20,
        });

        const { files, totalRows } = await this.exportWriter.exportByFormat({
          format,
          exportSQL,
          outputPath,
          options,
          onProgress,
        });

        let deletedRows = 0;

        // 5. 执行导出后操作
        if (normalizedPostExportAction !== 'keep' && mode === 'data') {
          onProgress?.({
            current: 1,
            total: 1,
            message: '正在执行导出后操作...',
            percentage: 90,
          });

          deletedRows = await this.handlePostExportAction({
            datasetId: sanitizedId,
            rowIdSQL: exportPlan.rowIdSQL,
            action: normalizedPostExportAction,
            batchSize,
          });
        }

        // 6. 完成
        onProgress?.({
          current: 1,
          total: 1,
          message: '导出完成',
          percentage: 100,
        });

        const executionTime = Date.now() - startTime;
        console.log('[ExportService] Export completed:', { files, totalRows, executionTime });

        return {
          success: true,
          files,
          totalRows,
          deletedRows,
          filesCount: files.length,
          executionTime,
          message: `成功导出 ${totalRows.toLocaleString()} 行数据`,
        };
      } catch (error) {
        console.error('[ExportService] Export failed:', error);
        return {
          success: false,
          files: [],
          totalRows: 0,
          filesCount: 0,
          executionTime: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // ✅ ATTACH 保持有效，供后续查询模板快照访问
        // DuckDB 会在连接关闭时自动清理
      }
    });
  }

  // ==================== 后处理方法 ====================

  /**
   * 🧹 处理导出后操作
   *
   * 仅支持物理删除
   */
  private async handlePostExportAction(params: {
    datasetId: string;
    rowIdSQL?: string;
    action: 'delete';
    batchSize?: number;
  }): Promise<number> {
    const { datasetId, rowIdSQL, action, batchSize } = params;
    const tableName = quoteQualifiedName(`ds_${datasetId}`, 'data');

    console.log('[ExportService] Handling post-export action:', action);
    if (!rowIdSQL) {
      throw new Error('Row-id SQL is required when postExportAction is delete');
    }

    // 物理删除（危险操作）
    let deleteSQL: string;
    if (batchSize) {
      deleteSQL = `
        DELETE FROM ${tableName}
        WHERE _row_id IN (
          SELECT _row_id FROM (${rowIdSQL})
          LIMIT ${batchSize}
        );
      `;
    } else {
      deleteSQL = `
        DELETE FROM ${tableName}
        WHERE _row_id IN (
          SELECT _row_id FROM (${rowIdSQL})
        );
      `;
    }

    const result = await this.conn.run(deleteSQL);
    console.warn(`[ExportService] PERMANENTLY DELETED rows from ${tableName}`);
    return result.rowsChanged;
  }
  }
