/**
 * DatasetImportService - 数据集导入服务
 *
 * 职责：
 * - CSV文件导入（使用 Worker threads）
 * - Worker 线程管理和监控
 * - 导入进度跟踪
 * - 导入取消和清理
 *
 * 📥 使用 Worker threads 实现后台导入，不阻塞主线程
 */

import { DuckDBConnection } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs-extra';
import { Worker } from 'worker_threads';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetStorageService } from './dataset-storage-service';
import {
  getDatasetPath,
  getImportsDir,
  getFileSize,
  parseRows,
  quoteIdentifier,
  quoteQualifiedName,
} from './utils';
import { sanitizeDatasetId } from './dataset-storage-service';
import { generateId } from '../../utils/id-generator';
import type { DatasetPlacementOptions, ImportTask, ImportProgress } from './types';
import { createLogger } from '../../core/logger';

const logger = createLogger('DatasetImportService');
const MAX_IMPORT_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const IMPORT_DB_FILE_PATTERN = /^(dataset|temp_import)_[a-zA-Z0-9_-]+\.db$/;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DatasetImportService {
  // Worker 管理
  private importWorkers = new Map<string, Worker>();
  private importProgressCallbacks = new Map<string, (progress: ImportProgress) => void>();
  private importTempArtifacts = new Map<string, { datasetId: string; outputPath: string }>();

  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService,
    private storageService?: DatasetStorageService
  ) {}

  private clearImportTracking(datasetId: string): void {
    this.importWorkers.delete(datasetId);
    this.importProgressCallbacks.delete(datasetId);
    this.importTempArtifacts.delete(datasetId);
  }

  private async cleanupImportArtifacts(datasetId: string, outputPath: string): Promise<void> {
    const filesToClean = [
      outputPath,
      `${outputPath}.wal`,
      `${outputPath}.tmp`,
      `${outputPath}-shm`,
      `${outputPath}-journal`,
      `${outputPath}.lock`,
      `${outputPath}-wal`,
    ];

    for (const filePath of filesToClean) {
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
        }
      } catch (error) {
        logger.warn('Failed to cleanup import artifact file', {
          datasetId,
          filePath,
          errorMessage: getErrorMessage(error),
        });
      }
    }

    try {
      await this.metadataService.deleteMetadata(datasetId);
    } catch (error) {
      logger.warn('Failed to cleanup import metadata', {
        datasetId,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  private async assertImportFileWithinLimit(filePath: string, failureSuggestion: string): Promise<void> {
    let fileStats: { size: number };
    try {
      fileStats = await fs.stat(filePath);
    } catch (error) {
      throw new Error(
        `无法读取导入文件: ${filePath}\n原因: ${getErrorMessage(error)}\n\n${failureSuggestion}`
      );
    }

    if (fileStats.size > MAX_IMPORT_FILE_SIZE) {
      const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
      throw new Error(
        `文件过大！\n当前大小: ${fileSizeMB}MB\n限制大小: 500MB\n\n${failureSuggestion}`
      );
    }
  }

  async reconcileImportArtifacts(): Promise<{
    metadataChecked: number;
    orphanMetadataDeleted: number;
    orphanFilesDeleted: number;
    failed: number;
  }> {
    const summary = {
      metadataChecked: 0,
      orphanMetadataDeleted: 0,
      orphanFilesDeleted: 0,
      failed: 0,
    };
    const importsDir = getImportsDir();
    const importsDirResolved = path.resolve(importsDir);

    let datasets: Array<{ id: string; filePath: string }> = [];
    try {
      datasets = await this.metadataService.listDatasets();
    } catch (error) {
      logger.warn('Failed to list dataset metadata during import artifact reconciliation', {
        errorMessage: getErrorMessage(error),
      });
      summary.failed += 1;
      return summary;
    }

    const metadataFilePaths = new Set<string>();
    for (const dataset of datasets) {
      summary.metadataChecked += 1;
      const filePath = path.resolve(dataset.filePath);
      metadataFilePaths.add(filePath);

      if (!isPathInsideDirectory(filePath, importsDirResolved)) {
        continue;
      }

      try {
        if (!(await fs.pathExists(filePath))) {
          await this.metadataService.deleteMetadata(dataset.id);
          summary.orphanMetadataDeleted += 1;
          logger.warn('Deleted dataset metadata for missing import artifact', {
            datasetId: dataset.id,
            filePath,
          });
        }
      } catch (error) {
        summary.failed += 1;
        logger.warn('Failed to reconcile dataset metadata artifact', {
          datasetId: dataset.id,
          filePath,
          errorMessage: getErrorMessage(error),
        });
      }
    }

    let importFiles: string[] = [];
    try {
      importFiles = await fs.readdir(importsDir);
    } catch (error) {
      logger.warn('Failed to scan imports directory during artifact reconciliation', {
        importsDir,
        errorMessage: getErrorMessage(error),
      });
      summary.failed += 1;
      return summary;
    }

    for (const fileName of importFiles) {
      if (!IMPORT_DB_FILE_PATTERN.test(fileName)) {
        continue;
      }

      const filePath = path.resolve(importsDir, fileName);
      if (metadataFilePaths.has(filePath)) {
        continue;
      }

      const datasetId = path.basename(fileName, '.db');
      try {
        await this.cleanupImportArtifacts(datasetId, filePath);
        summary.orphanFilesDeleted += 1;
        logger.warn('Deleted orphan import artifact without dataset metadata', {
          datasetId,
          filePath,
        });
      } catch (error) {
        summary.failed += 1;
        logger.warn('Failed to delete orphan import artifact', {
          datasetId,
          filePath,
          errorMessage: getErrorMessage(error),
        });
      }
    }

    return summary;
  }

  private async cleanupTempImportFiles(
    trackingDatasetId: string,
    tempDatasetId: string,
    tempOutputPath: string
  ): Promise<void> {
    try {
      await this.cleanupImportArtifacts(tempDatasetId, tempOutputPath);
    } catch (error) {
      logger.error('Failed to cleanup import-records temp files', {
        targetDatasetId: trackingDatasetId,
        tempOutputPath,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  private resolveImportWorkerPath(): string {
    const devPath = path.join(__dirname, 'import-worker.js');
    const candidates: string[] = [];

    // Packaged app: worker_threads 入口脚本在 app.asar 内部可能无法被正确加载，
    // 优先使用 app.asar.unpacked 中的脚本。
    if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
      candidates.push(
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'dist',
          'main',
          'duckdb',
          'import-worker.js'
        ),
        path.join(process.resourcesPath, 'app.asar', 'dist', 'main', 'duckdb', 'import-worker.js')
      );
    }

    candidates.push(devPath);

    const existingPath = candidates.find((candidate) => fs.pathExistsSync(candidate));
    if (existingPath) {
      return existingPath;
    }

    logger.warn('Import worker was not found in expected locations, falling back to dev path', {
      fallbackPath: devPath,
      candidates,
    });
    return devPath;
  }

  /**
   * 📂 导入 CSV 文件
   *
   * 使用 Worker 线程异步导入，支持进度回调
   *
   * @param filePath CSV 文件路径
   * @param datasetName 数据集名称
   * @param onProgress 进度回调函数
   * @returns 数据集 ID
   */
  async importDatasetFile(
    filePath: string,
    datasetName: string,
    options?: DatasetPlacementOptions,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<string> {
    await this.assertImportFileWithinLimit(
      filePath,
      '建议：请确认文件存在且当前应用有读取权限；大文件请使用数据库工具或命令行工具导入。'
    );

    const datasetId = generateId('dataset');
    const outputPath = getDatasetPath(datasetId);

    const task: ImportTask = {
      filePath,
      datasetId,
      datasetName,
      outputPath,
    };

    return new Promise((resolve, reject) => {
      const workerPath = this.resolveImportWorkerPath();
      let worker: Worker;
      let settled = false;

      const rejectWithCleanup = async (error: Error, progressError = error.message) => {
        if (settled) {
          return;
        }
        settled = true;
        onProgress?.({
          datasetId,
          status: 'failed',
          progress: 0,
          error: progressError,
        });
        this.clearImportTracking(datasetId);
        await this.cleanupImportArtifacts(datasetId, outputPath);
        reject(error);
      };

      try {
        worker = new Worker(workerPath, { workerData: task });
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        logger.error('Failed to start import worker', {
          datasetId,
          workerPath,
          errorMessage: errorMsg,
        });
        onProgress?.({
          datasetId,
          status: 'failed',
          progress: 0,
          error: errorMsg,
        });
        reject(new Error(errorMsg));
        return;
      }

      this.importWorkers.set(datasetId, worker);
      if (onProgress) this.importProgressCallbacks.set(datasetId, onProgress);

      worker.on('message', async (message) => {
        if (message.type === 'progress') {
          onProgress?.({
            datasetId,
            status: 'importing',
            progress: message.progress,
            rowsProcessed: message.rowsProcessed,
            message: message.message,
          });
        } else if (message.type === 'complete') {
          try {
            await this.metadataService.saveMetadata({
              id: datasetId,
              name: datasetName,
              filePath: outputPath,
              rowCount: message.rowCount,
              columnCount: message.columnCount,
              sizeBytes: await getFileSize(outputPath),
              createdAt: Date.now(),
              schema: message.schema,
              folderId: options?.folderId ?? null,
            });

            onProgress?.({
              datasetId,
              status: 'completed',
              progress: 100,
              rowsProcessed: message.rowCount,
              message: '导入完成',
            });

            settled = true;
            this.clearImportTracking(datasetId);
            resolve(datasetId);
          } catch (error: unknown) {
            await rejectWithCleanup(error instanceof Error ? error : new Error(String(error)));
          }
        } else if (message.type === 'error') {
          await rejectWithCleanup(new Error(message.error), message.error);
        }
      });

      worker.on('error', (error) => {
        void rejectWithCleanup(error, error.message);
      });

      // ✅ 修复：处理 Worker 意外退出的情况
      worker.on('exit', (code) => {
        // 只有非零退出码且 Worker 仍在 Map 中时才处理
        // （正常完成/错误时已经清理了 Map）
        if (code !== 0 && this.importWorkers.has(datasetId)) {
          const errorMsg = `Worker exited unexpectedly with code ${code}`;
          logger.error('Import worker exited unexpectedly', {
            datasetId,
            exitCode: code,
          });
          void rejectWithCleanup(new Error(errorMsg), errorMsg);
        }
      });
    });
  }

  /**
   * ❌ 取消导入
   *
   * 终止 Worker 线程并清理所有相关文件
   *
   * @param datasetId 数据集 ID
   */
  async cancelImport(datasetId: string): Promise<void> {
    const worker = this.importWorkers.get(datasetId);
    const tempArtifact = this.importTempArtifacts.get(datasetId);
    if (worker) {
      try {
        const terminatePromise = worker.terminate();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 5000));
        await Promise.race([terminatePromise, timeoutPromise]);
      } catch (error) {
        logger.error('Failed to terminate import worker', {
          datasetId,
          errorMessage: getErrorMessage(error),
        });
      } finally {
        this.clearImportTracking(datasetId);
      }
    }

    if (tempArtifact) {
      await this.cleanupTempImportFiles(datasetId, tempArtifact.datasetId, tempArtifact.outputPath);
    } else {
      const outputPath = getDatasetPath(datasetId);
      await this.cleanupImportArtifacts(datasetId, outputPath);
    }
  }

  /**
   * 📥 从文件导入记录到现有数据集
   *
   * 流程：
   * 1. 使用 Worker 创建临时数据库并解析文件
   * 2. ATTACH 临时库和目标库
   * 3. 跨库 INSERT 数据（零序列化，高性能）
   * 4. 清理临时文件
   *
   * @param targetDatasetId 目标数据集ID
   * @param filePath 要导入的文件路径（支持 CSV/XLSX/XLS/TXT）
   * @param onProgress 进度回调函数
   * @returns 插入的记录数
   */
  async importRecordsFromFile(
    targetDatasetId: string,
    filePath: string,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<{ recordsInserted: number }> {
    await this.assertImportFileWithinLimit(
      filePath,
      '建议：请确认文件存在且当前应用有读取权限；大文件请分割文件或使用数据库工具导入。'
    );

    // Step 2: 生成临时数据库ID和路径
    const tempDatasetId = generateId('temp_import');
    const tempOutputPath = getDatasetPath(tempDatasetId);
    this.importTempArtifacts.set(targetDatasetId, {
      datasetId: tempDatasetId,
      outputPath: tempOutputPath,
    });

    // Step 3: 创建导入任务（使用 Worker 解析文件）
    const task: ImportTask = {
      filePath,
      datasetId: tempDatasetId,
      datasetName: 'temp_import',
      outputPath: tempOutputPath,
    };

    try {
      // 3.1 启动 Worker 处理文件（进度范围：0-60%）
      await this.runWorkerImport(task, targetDatasetId, onProgress);

      onProgress?.({
        datasetId: targetDatasetId,
        status: 'importing',
        progress: 70,
        message: '正在插入数据到目标数据集...',
      });

      // Step 4: 跨库插入数据（进度范围：70-90%）
      const stopInsertHeartbeat = this.startProgressHeartbeat(targetDatasetId, onProgress, {
        progress: 70,
        intervalMs: 5000,
        message: '正在插入数据到目标数据集...',
      });

      const insertRecords = async () => {
        try {
          const recordsInserted = await this.crossDatabaseInsert(
            tempDatasetId,
            tempOutputPath,
            targetDatasetId
          );
          try {
            await this.metadataService.incrementRowCount(targetDatasetId, recordsInserted);
          } catch (countError) {
            await this.reconcileRowCountAfterImportDeltaFailure(
              targetDatasetId,
              recordsInserted,
              countError
            );
          }
          return recordsInserted;
        } finally {
          stopInsertHeartbeat();
        }
      };

      const recordsInserted = this.storageService
        ? await this.storageService.executeInQueue(targetDatasetId, insertRecords)
        : await insertRecords();

      onProgress?.({
        datasetId: targetDatasetId,
        status: 'completed',
        progress: 100,
        rowsProcessed: recordsInserted,
        message: `成功导入 ${recordsInserted} 条记录`,
      });

      return { recordsInserted };
    } finally {
      // Step 5: 清理临时文件
      await this.cleanupTempImportFiles(targetDatasetId, tempDatasetId, tempOutputPath);
      this.clearImportTracking(targetDatasetId);
    }
  }

  private startProgressHeartbeat(
    datasetId: string,
    onProgress: ((progress: ImportProgress) => void) | undefined,
    options: { progress: number; intervalMs: number; message: string }
  ): () => void {
    if (!onProgress) return () => {};

    const start = Date.now();
    const timer = setInterval(() => {
      onProgress({
        datasetId,
        status: 'importing',
        progress: options.progress,
        message: `${options.message} (${formatDuration(Date.now() - start)})`,
      });
    }, options.intervalMs);

    return () => clearInterval(timer);
  }

  /**
   * 🔧 私有方法：运行 Worker 导入（复用现有 Worker 逻辑）
   */
  private async runWorkerImport(
    task: ImportTask,
    targetDatasetId: string,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = this.resolveImportWorkerPath();
      let worker: Worker;

      try {
        worker = new Worker(workerPath, { workerData: task });
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        logger.error('Failed to start import-records worker', {
          targetDatasetId,
          workerPath,
          errorMessage: errorMsg,
        });
        reject(new Error(errorMsg));
        return;
      }

      this.importWorkers.set(targetDatasetId, worker);
      if (onProgress) this.importProgressCallbacks.set(targetDatasetId, onProgress);

      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.importWorkers.delete(targetDatasetId);
        this.importProgressCallbacks.delete(targetDatasetId);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.importWorkers.delete(targetDatasetId);
        this.importProgressCallbacks.delete(targetDatasetId);
        reject(error);
      };

      worker.on('message', (message) => {
        if (message.type === 'progress') {
          // 调整进度范围：原始 0-100% → 映射到 0-60%
          const adjustedProgress = Math.floor(message.progress * 0.6);
          onProgress?.({
            datasetId: targetDatasetId,
            status: 'importing',
            progress: adjustedProgress,
            message: message.message || '正在处理文件...',
          });
        } else if (message.type === 'complete') {
          settleResolve();
        } else if (message.type === 'error') {
          logger.error('Import-records worker returned an error', {
            targetDatasetId,
            errorMessage: String(message.error),
          });
          settleReject(new Error(message.error));
        }
      });

      worker.on('error', (error) => {
        logger.error('Import-records worker thread error', {
          targetDatasetId,
          errorMessage: getErrorMessage(error),
        });
        settleReject(error);
      });

      // ✅ 修复：正确处理 Worker 意外退出
      worker.on('exit', (code) => {
        if (code !== 0 && !settled) {
          const errorMsg = `Worker stopped unexpectedly with exit code ${code}`;
          logger.error('Import-records worker exited unexpectedly', {
            targetDatasetId,
            exitCode: code,
          });
          settleReject(new Error(errorMsg));
        }
      });
    });
  }

  private async reconcileRowCountAfterImportDeltaFailure(
    targetDatasetId: string,
    recordsInserted: number,
    error: unknown
  ): Promise<void> {
    try {
      const safeTargetId = sanitizeDatasetId(targetDatasetId);
      const dataset = await this.metadataService.getDatasetInfo(safeTargetId);
      if (!dataset) {
        throw new Error(`Target dataset not found while reconciling row_count: ${targetDatasetId}`);
      }
      const actualRowCount = await this.metadataService.reconcileRowCountInCurrentQueue(dataset);
      logger.warn('Reconciled dataset row_count after import delta update failed', {
        targetDatasetId: safeTargetId,
        recordsInserted,
        actualRowCount,
        errorMessage: getErrorMessage(error),
      });
    } catch (reconcileError) {
      logger.error('Failed to reconcile dataset row_count after import delta update failed', {
        targetDatasetId,
        recordsInserted,
        originalErrorMessage: getErrorMessage(error),
        reconcileErrorMessage: getErrorMessage(reconcileError),
      });
    }
  }

  /**
   * 🔧 私有方法：跨库插入数据（使用 DuckDB 原生跨库查询）
   */
  private async crossDatabaseInsert(
    tempDatasetId: string,
    tempDbPath: string,
    targetDatasetId: string
  ): Promise<number> {
    const safeTargetId = sanitizeDatasetId(targetDatasetId);
    const safeTempId = sanitizeDatasetId(tempDatasetId);

    // 获取目标数据集信息
    const targetDataset = await this.metadataService.getDatasetInfo(safeTargetId);
    if (!targetDataset) {
      throw new Error(`目标数据集不存在: ${targetDatasetId}`);
    }

    // 转义路径
    const escapedTempPath = tempDbPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const escapedTargetPath = targetDataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    const tempAlias = `tmp_${safeTempId}`;
    const targetAlias = `ds_${safeTargetId}`;
    const tempTable = quoteQualifiedName(tempAlias, 'data');
    const targetTable = quoteQualifiedName(targetAlias, 'data');

    // ATTACH 两个数据库
    await this.conn.run(
      `ATTACH IF NOT EXISTS '${escapedTempPath}' AS ${quoteIdentifier(tempAlias)}`
    );
    await this.conn.run(
      `ATTACH IF NOT EXISTS '${escapedTargetPath}' AS ${quoteIdentifier(targetAlias)}`
    );

    try {
      // 获取临时表的列名（排除 _row_id）- 使用 DESCRIBE 命令
      const columnsResult = await this.conn.runAndReadAll(`
        DESCRIBE ${tempTable}
      `);
      const columnRows = parseRows(columnsResult);
      // DESCRIBE 返回：column_name, column_type, null, key, default, extra
      const columns = columnRows
        .filter((row: any) => row.column_name !== '_row_id')
        .map((row: any) => quoteIdentifier(String(row.column_name)))
        .join(', ');

      if (!columns) {
        throw new Error('临时表没有可插入的列（除了 _row_id）');
      }

      // 跨库插入（只插入数据列，排除 _row_id，让目标表的序列自动生成新的 ID）
      const insertSQL = `
        INSERT INTO ${targetTable} (${columns})
        SELECT ${columns}
        FROM ${tempTable}
      `;

      await this.conn.run(insertSQL);

      // 获取插入的记录数
      const countResult = await this.conn.runAndReadAll(`
        SELECT COUNT(*) as count FROM ${tempTable}
      `);
      const rows = parseRows(countResult);
      const recordsInserted = Number(rows[0].count);

      return recordsInserted;
    } catch (error) {
      logger.error('Cross-database import-records insert failed', {
        targetDatasetId: safeTargetId,
        tempDatasetId: safeTempId,
        errorMessage: getErrorMessage(error),
      });
      throw error;
    } finally {
      // DETACH 临时数据库
      try {
        await this.conn.run(`DETACH ${quoteIdentifier(tempAlias)}`);
      } catch (error) {
        logger.warn('Failed to detach import-records temp database', {
          targetDatasetId: safeTargetId,
          tempDatasetId: safeTempId,
          errorMessage: getErrorMessage(error),
        });
      }

      try {
        await this.conn.run(`DETACH ${quoteIdentifier(targetAlias)}`);
      } catch (error) {
        logger.warn('Failed to detach import-records target database', {
          targetDatasetId: safeTargetId,
          tempDatasetId: safeTempId,
          errorMessage: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * 🧹 清理所有 Worker
   *
   * 在服务关闭时调用，终止所有活动的 Worker 线程
   */
  async cleanup(): Promise<void> {
    for (const worker of this.importWorkers.values()) {
      await worker.terminate();
    }
    this.importWorkers.clear();
    this.importProgressCallbacks.clear();
    this.importTempArtifacts.clear();
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m${seconds}s`;
}

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const normalizedTarget =
    process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const normalizedDirectory =
    process.platform === 'win32' ? directoryPath.toLowerCase() : directoryPath;
  return (
    normalizedTarget === normalizedDirectory ||
    normalizedTarget.startsWith(normalizedDirectory + path.sep)
  );
}
