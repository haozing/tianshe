/**
 * DatasetStorageService - 数据集存储服务
 *
 * 职责：
 * - 并发控制：队列机制确保同一数据集的操作串行化
 * - 数据库附加：智能 ATTACH/DETACH 操作
 * - 文件管理：数据集文件的删除和清理
 * - ID验证：防止 SQL 注入
 *
 * 🔑 核心基础设施层，被其他服务依赖
 */

import { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import { escapeSqlStringLiteral, parseRows, quoteIdentifier, quoteQualifiedName } from './utils';
import { fileStorage } from '../file-storage';
import type { Dataset } from './types';

/**
 * 验证并清理 dataset ID,防止SQL注入
 * ✅ 支持插件数据集ID格式：plugin__插件id__code
 * ⚠️ 只允许SQL安全字符，不需要转义
 */
export function sanitizeDatasetId(datasetId: string): string {
  // 只允许字母、数字、下划线、连字符（兼容 npm 风格插件 id）
  if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) {
    throw new Error(
      `Invalid dataset ID format: ${datasetId}. Only alphanumeric characters, underscores, and hyphens are allowed.`
    );
  }
  return datasetId;
}

export class DatasetStorageService {
  // 查询队列：确保同一数据集的查询串行执行，避免并发 ATTACH 导致文件锁定
  private queryQueues = new Map<string, Promise<any>>();
  private rowIdIntegrityChecked = new Set<string>();

  constructor(private conn: DuckDBConnection) {}

  private async ensureRowIdIntegrity(datasetId: string): Promise<boolean> {
    const attachKey = `ds_${datasetId}`;
    const tableName = `${quoteIdentifier(attachKey)}.${quoteIdentifier('data')}`;

    let describeRows: any[];
    try {
      const describeResult = await this.conn.runAndReadAll(`DESCRIBE ${tableName}`);
      describeRows = parseRows(describeResult);
    } catch {
      // Dataset may be attached but not have expected table yet; skip.
      return false;
    }

    const hasRowId = describeRows.some((row: any) => String(row.column_name) === '_row_id');
    if (!hasRowId) return true;

    const nullCountResult = await this.conn.runAndReadAll(
      `SELECT COUNT(*) AS null_count FROM ${tableName} WHERE _row_id IS NULL`
    );
    const nullCount = Number(parseRows(nullCountResult)[0]?.null_count ?? 0);
    if (!Number.isFinite(nullCount) || nullCount <= 0) return true;

    console.warn(
      `[Storage] ⚠️ Dataset ${attachKey} has ${nullCount} rows with NULL _row_id. Repairing...`
    );

    const maxIdResult = await this.conn.runAndReadAll(
      `SELECT COALESCE(MAX(_row_id), 0) AS max_id FROM ${tableName} WHERE _row_id IS NOT NULL`
    );
    const maxIdRaw = parseRows(maxIdResult)[0]?.max_id ?? 0;
    const maxId = typeof maxIdRaw === 'number' ? maxIdRaw : Number(maxIdRaw);
    const startValue = Number.isFinite(maxId) && maxId > 0 ? Math.floor(maxId) + 1 : 1;

    const sequenceName = 'row_id_seq';
    const sequenceRef = `${quoteIdentifier(attachKey)}.${quoteIdentifier(sequenceName)}`;
    const sequenceRefLiteral = escapeSqlStringLiteral(sequenceRef);

    // Create or restart sequence so new IDs won't collide with existing max(_row_id).
    // Use DROP+CREATE for compatibility across DuckDB versions.
    try {
      await this.conn.run(`DROP SEQUENCE IF EXISTS ${sequenceRef}`);
    } catch {
      // ignore
    }
    await this.conn.run(`CREATE SEQUENCE ${sequenceRef} START ${startValue} INCREMENT 1`);

    // Backfill NULL _row_id using the sequence.
    await this.conn.run(
      `UPDATE ${tableName} SET _row_id = nextval('${sequenceRefLiteral}') WHERE _row_id IS NULL`
    );

    // Ensure future inserts get a valid _row_id.
    try {
      await this.conn.run(
        `ALTER TABLE ${tableName} ALTER COLUMN _row_id SET DEFAULT nextval('${sequenceRefLiteral}')`
      );
    } catch (error: any) {
      console.warn(
        `[Storage] Failed to set default for ${attachKey}.data._row_id: ${error?.message || error}`
      );
    }

    try {
      await this.conn.run(`ALTER TABLE ${tableName} ALTER COLUMN _row_id SET NOT NULL`);
    } catch (error: any) {
      console.warn(
        `[Storage] Failed to set NOT NULL for ${attachKey}.data._row_id: ${error?.message || error}`
      );
    }

    console.warn(`[Storage] ✅ Repaired NULL _row_id for dataset ${attachKey}`);
    return true;
  }

  /**
   * 🔒 队列执行机制 - 内部方法
   * 确保同一数据集的操作串行化，避免并发问题
   *
   * ✅ 设计说明（Promise 链式队列模式）：
   *
   * 核心思路：使用 Promise 链实现串行执行
   * - 每个新操作都 .then() 到前一个操作的 Promise 上
   * - 这保证了同一数据集的操作按顺序执行
   *
   * 清理策略的正确性：
   * - 在 finally() 中检查 `queryQueues.get(key) === currentPromise`
   * - 如果相等：说明没有新操作入队，可以安全清理
   * - 如果不等：说明有新操作入队（队列中存的是新的 Promise），不清理
   *
   * 示例场景：
   * 1. 操作A入队 → queryQueues[key] = promiseA
   * 2. 操作B入队 → queryQueues[key] = promiseB（B 链在 A 后面）
   * 3. 操作A完成 → finally() 检查：promiseA !== promiseB，不清理 ✓
   * 4. 操作B完成 → finally() 检查：promiseB === promiseB，清理 ✓
   *
   * 这确保了：
   * - 无操作泄漏：最后一个操作完成后会清理队列
   * - 无竞态条件：中间操作完成时不会错误清理后续操作
   *
   * @param datasetId 数据集ID
   * @param operation 要执行的操作
   * @returns 操作结果
   */
  private async executeWithQueue<T>(datasetId: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = datasetId;

    // 等待该数据集的前一个操作完成
    const previousPromise = this.queryQueues.get(queueKey) || Promise.resolve();

    // 创建当前操作的 Promise 链
    const currentPromise = previousPromise
      .then(() => operation())
      .catch((err) => {
        // 确保错误被传播
        throw err;
      })
      .finally(() => {
        // 清理队列：只有当前 Promise 是队列中的最新 Promise 时才清理
        // 这是关键的并发安全检查 - 见上方设计说明
        if (this.queryQueues.get(queueKey) === currentPromise) {
          this.queryQueues.delete(queueKey);
        }
      });

    // 将当前操作加入队列
    this.queryQueues.set(queueKey, currentPromise);

    return currentPromise;
  }

  /**
   * 🆕 公开的队列执行方法
   * 允许外部服务在队列中执行操作
   *
   * @param datasetId 数据集ID
   * @param operation 要执行的操作
   * @returns 操作结果
   */
  async executeInQueue<T>(datasetId: string, operation: () => Promise<T>): Promise<T> {
    const sanitizedId = sanitizeDatasetId(datasetId);
    return this.executeWithQueue(sanitizedId, operation);
  }

  /**
   * 在多个数据集队列中按稳定顺序执行操作。
   * 用于跨数据集操作避免 A->B / B->A 交叉等待导致的死锁。
   */
  async executeInQueues<T>(datasetIds: string[], operation: () => Promise<T>): Promise<T> {
    const normalizedIds = Array.from(
      new Set(datasetIds.map((datasetId) => sanitizeDatasetId(datasetId)))
    ).sort();

    const runWithQueues = async (index: number): Promise<T> => {
      if (index >= normalizedIds.length) {
        return await operation();
      }

      return await this.executeWithQueue(normalizedIds[index], async () => {
        return await runWithQueues(index + 1);
      });
    };

    return await runWithQueues(0);
  }

  /**
   * 🗄️ 智能 ATTACH 数据库
   * 使用 DuckDB 的 IF NOT EXISTS 语法避免重复 ATTACH
   *
   * @param datasetId 数据集ID
   * @param escapedPath 转义后的数据库文件路径
   */
  async smartAttach(datasetId: string, escapedPath: string): Promise<void> {
    const attachKey = `ds_${datasetId}`;

    try {
      // ✅ 使用 DuckDB 原生的幂等性保护
      await this.conn.run(`ATTACH IF NOT EXISTS '${escapedPath}' AS ${quoteIdentifier(attachKey)}`);

      // Best-effort: ensure system row id exists and is not NULL.
      // Some legacy/plugin datasets may have NULL _row_id which breaks editing/selection.
      if (!this.rowIdIntegrityChecked.has(datasetId)) {
        try {
          const integrityChecked = await this.ensureRowIdIntegrity(datasetId);
          if (integrityChecked) {
            this.rowIdIntegrityChecked.add(datasetId);
          }
        } catch (error: any) {
          console.warn(
            `[Storage] _row_id integrity check failed for ${attachKey}: ${error?.message || error}`
          );
        }
      }
      console.log(`✅ Database attached: ${attachKey}`);
    } catch (error: any) {
      console.error(`❌ Failed to attach database ${attachKey}:`, error);
      throw error;
    }
  }

  /**
   * 📎 在队列中执行带 ATTACH 的操作
   * 自动处理数据库 ATTACH 和队列保护
   *
   * @param datasetId 数据集ID
   * @param filePath 数据集文件路径
   * @param operation 要执行的操作（在 ATTACH 后执行）
   * @returns 操作结果
   */
  async withDatasetAttached<T>(
    datasetId: string,
    filePath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const sanitizedId = sanitizeDatasetId(datasetId);
    return this.executeWithQueue(sanitizedId, async () => {
      const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      await this.smartAttach(sanitizedId, escapedPath);
      return await operation();
    });
  }

  /**
   * 🗑️ 删除数据集
   *
   * 执行8步完整清理流程：
   * 1. 删除关联查询模板快照表
   * 2. FORCE CHECKPOINT（同步 WAL）
   * 3. DETACH 数据库
   * 4. Windows 等待文件锁释放
   * 5. 删除 .wal 文件
   * 6. 删除主 .db 文件（3次重试）
   * 7. 删除附件文件
   * 8. 删除元数据记录（由调用者执行）
   *
   * @param dataset 数据集对象（由调用者提供，避免循环依赖）
   * @param onProgress 进度回调
   * @param deleteMetadata 删除元数据的回调函数（由调用者提供）
   */
  async deleteDataset(
    dataset: Dataset,
    onProgress?: (message: string, percentage: number) => void,
    deleteMetadata?: () => Promise<void>
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(dataset.id);

    // 🔒 使用队列机制确保之前的所有操作（查询、预览等）都已完成
    return this.executeWithQueue(safeDatasetId, async () => {
      // 检测是否为插件创建的表
      const isPluginTable = dataset.id.startsWith('plugin__');

      if (isPluginTable) {
        // 插件表使用独立文件，需要先 DETACH 再删除文件
        onProgress?.('正在删除插件数据文件...', 60);
        console.log(`🗑️  [Delete] Deleting plugin table file: ${dataset.filePath}`);

        const attachKey = `ds_${safeDatasetId}`;

        try {
          // 1. 先尝试 DETACH（如果数据库已被 ATTACH）
          try {
            const attachedDbs = await this.conn.runAndReadAll(`
              SELECT database_name
              FROM duckdb_databases()
              WHERE database_name = '${attachKey}'
            `);
            const databases = parseRows(attachedDbs);

            if (databases.length > 0) {
              await this.conn.run(`DETACH ${quoteIdentifier(attachKey)}`);
              console.log(`🔓 [Delete] DETACH completed for ${attachKey}`);
            } else {
              console.log(`ℹ️  [Delete] Database ${attachKey} not attached, skip DETACH`);
            }
          } catch (detachError: any) {
            console.warn(`⚠️  [Delete] DETACH failed (non-critical):`, detachError.message);
          }

          // 2. Windows 等待文件锁释放
          if (process.platform === 'win32') {
            console.log('⏱️  [Windows] Waiting for file lock release...');
            await new Promise((resolve) => setTimeout(resolve, 500));
          }

          // 3. 删除主数据库文件
          if (await fs.pathExists(dataset.filePath)) {
            await fs.remove(dataset.filePath);
            console.log(`✅ [Delete] Deleted database file: ${dataset.filePath}`);
          } else {
            console.log(`ℹ️  [Delete] Database file not found: ${dataset.filePath}`);
          }

          // 4. 删除 WAL 文件
          const walPath = `${dataset.filePath}.wal`;
          if (await fs.pathExists(walPath)) {
            await fs.remove(walPath);
            console.log(`✅ [Delete] Deleted WAL file: ${walPath}`);
          }

          console.log(`✅ [Delete] Plugin table files deleted successfully`);
        } catch (error: any) {
          console.error(`❌ [Delete] Failed to delete plugin files:`, error.message);
          // 记录详细错误信息
          console.error(`   File path: ${dataset.filePath}`);
          console.error(`   Error details:`, error);
          // 不抛出错误，继续删除元数据
        }
      } else {
        // 步骤1: 删除该数据集的所有快照表
        try {
          const queryTemplatesResult = await this.conn.runAndReadAll(
            `
            SELECT snapshot_table_name
            FROM dataset_query_templates
            WHERE dataset_id = ?
          `,
            [safeDatasetId]
          );

          const templates = parseRows(queryTemplatesResult);
          for (const template of templates) {
            try {
              const snapshotTableName = String(template.snapshot_table_name ?? '').trim();
              if (!snapshotTableName) {
                continue;
              }

              const qualifiedName = quoteQualifiedName(`ds_${safeDatasetId}`, snapshotTableName);
              await this.conn.run(`DROP TABLE IF EXISTS ${qualifiedName}`);
              console.log(`🗑️  Dropped snapshot table: ${template.snapshot_table_name}`);
            } catch (viewError: any) {
              console.warn(
                `⚠️  Failed to drop snapshot table ${template.snapshot_table_name}:`,
                viewError.message
              );
              // 继续删除其他快照
            }
          }
        } catch (error: any) {
          console.warn(
            `⚠️  Failed to query snapshot tables for dataset ${safeDatasetId}:`,
            error.message
          );
          // 即使查询失败也继续删除流程
        }

        const attachKey = `ds_${safeDatasetId}`;

        // 步骤2: 执行 FORCE CHECKPOINT（修复语法 - DuckDB 官方正确语法）
        // 作用：对所有数据库强制同步 WAL，中止活动事务，释放 WAL 锁
        onProgress?.('正在同步数据库...', 10);
        console.log(`🔄 [Delete] Starting FORCE CHECKPOINT for all databases...`);
        try {
          await this.conn.run(`FORCE CHECKPOINT`);
          console.log(`✅ [Delete] FORCE CHECKPOINT completed successfully`);
        } catch (checkpointError: any) {
          console.error(`❌ [Delete] FORCE CHECKPOINT failed:`, checkpointError);
          console.log(`⚠️  [Delete] Continuing deletion despite CHECKPOINT failure...`);
          // 即使失败也继续，可能是因为没有活动事务或数据库未 ATTACH
        }

        // 步骤3: 执行 DETACH（显式释放文件句柄）
        onProgress?.('正在释放文件句柄...', 20);
        try {
          // 先检查数据库是否已 attached（DuckDB 不支持 DETACH IF EXISTS）
          const attachedDbs = await this.conn.runAndReadAll(`
            SELECT database_name
            FROM duckdb_databases()
            WHERE database_name = '${attachKey}'
          `);
          const databases = parseRows(attachedDbs);

          if (databases.length > 0) {
            // 数据库已 attached，执行 DETACH
            await this.conn.run(`DETACH ${quoteIdentifier(attachKey)}`);
            console.log(`🔓 [Delete] DETACH completed for ${attachKey}`);
          } else {
            console.log(`ℹ️  [Delete] Database ${attachKey} not attached, skip DETACH`);
          }
        } catch (detachError: any) {
          console.warn(`⚠️  [Delete] DETACH failed:`, detachError.message);
        }

        // 🆕 步骤3.5: 验证 DETACH 是否成功
        try {
          const attachedDbs = await this.conn.runAndReadAll(`
            SELECT database_name
            FROM duckdb_databases()
            WHERE database_name = '${attachKey}'
          `);
          const databases = parseRows(attachedDbs);

          if (databases.length > 0) {
            console.error(`❌ [Delete] Database still attached after DETACH: ${attachKey}`);
            console.warn(`⚠️  [Delete] Attempting forced DETACH...`);
            // 再次尝试 DETACH（不使用 IF EXISTS，强制执行）
            try {
              await this.conn.run(`DETACH ${quoteIdentifier(attachKey)}`);
              console.log(`✅ [Delete] Forced DETACH completed`);
            } catch {
              console.error(`❌ [Delete] Forced DETACH also failed`);
            }
          } else {
            console.log(`✅ [Delete] Verified: Database successfully detached`);
          }
        } catch (verifyError: any) {
          console.warn(`⚠️  [Delete] Could not verify DETACH status:`, verifyError.message);
          // 继续删除流程
        }

        // 步骤4: Windows 等待（延长至 3000ms，分段报告进度）
        if (process.platform === 'win32') {
          console.log('⏱️  [Windows] Waiting 3000ms for file system to release lock...');
          onProgress?.('等待文件系统释放锁...', 30);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          onProgress?.('等待文件系统释放锁...', 40);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          onProgress?.('等待文件系统释放锁...', 50);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // 步骤5: 删除 .wal 文件（DuckDB 官方最佳实践）
        // Windows 上 WAL 文件的锁不会自动释放，需要手动删除
        onProgress?.('正在删除 WAL 文件...', 60);
        const walPath = `${dataset.filePath}.wal`;
        try {
          if (await fs.pathExists(walPath)) {
            await fs.remove(walPath);
            console.log(`✅ [Delete] Deleted WAL file: ${walPath}`);
          } else {
            console.log(`ℹ️  [Delete] No WAL file found: ${walPath}`);
          }
        } catch (walError: any) {
          console.warn(`⚠️  [Delete] Failed to delete WAL file:`, walError.message);
          // WAL 文件删除失败不应阻止主文件删除
        }

        // 步骤6: 删除主 .db 文件（最多 3 次重试，间隔 1000ms）
        let retryCount = 0;
        const maxRetries = 3;
        const retryInterval = 1000;
        let lastError: any = null;

        while (retryCount <= maxRetries) {
          const attemptNumber = retryCount + 1;
          const progressPercent = 60 + (attemptNumber - 1) * 10; // 60, 70, 80, 90
          onProgress?.(
            `正在删除数据库文件 (尝试 ${attemptNumber}/${maxRetries + 1})...`,
            progressPercent
          );

          try {
            await fs.remove(dataset.filePath);
            console.log(
              `✅ [Delete] Deleted dataset file: ${dataset.filePath}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`
            );
            lastError = null;
            break; // 删除成功，跳出循环
          } catch (error: any) {
            lastError = error;

            if (retryCount < maxRetries) {
              retryCount++;
              console.warn(
                `⚠️  [Delete] Attempt ${attemptNumber} failed: ${error.message}. Retrying in ${retryInterval}ms...`
              );
              await new Promise((resolve) => setTimeout(resolve, retryInterval));
            } else {
              // 已达到最大重试次数
              console.error(
                `❌ [Delete] Failed to delete file after ${maxRetries + 1} attempts:`,
                error
              );
              break;
            }
          }
        }

        // 如果最终仍然失败，抛出详细错误
        if (lastError) {
          throw new Error(
            `无法删除文件（已执行完整清理流程 + ${maxRetries} 次重试）：${lastError.message}\n\n` +
              `已执行的清理步骤（基于 DuckDB 官方最佳实践）：\n` +
              `✅ 1. 删除所有关联 VIEW\n` +
              `✅ 2. 执行 FORCE CHECKPOINT（同步 WAL 文件）\n` +
              `✅ 3. 执行 DETACH + 验证（释放文件句柄）\n` +
              `✅ 4. Windows 等待 3000ms（文件锁释放）\n` +
              `✅ 5. 删除 .wal 文件\n` +
              `❌ 6. 删除主文件失败（${maxRetries + 1} 次尝试，间隔 ${retryInterval}ms）\n\n` +
              `可能原因：\n` +
              `- 文件被其他进程或程序占用\n` +
              `- 系统防病毒软件正在扫描文件\n` +
              `- Windows 文件系统未完全释放锁（极罕见）\n\n` +
              `建议：\n` +
              `1. 关闭所有使用该数据集的窗口和面板\n` +
              `2. 暂时禁用防病毒软件后重试\n` +
              `3. 等待 10-20 秒后重试\n` +
              `4. 如仍失败，请重启应用程序\n` +
              `5. 最后手段：手动删除文件 ${dataset.filePath}`
          );
        }
      }

      // 步骤7: 删除附件文件
      onProgress?.('正在删除附件文件...', 95);
      try {
        await fileStorage.deleteDatasetFiles(safeDatasetId);
        console.log(`✅ [Delete] Deleted attachments for dataset: ${safeDatasetId}`);
      } catch (error: any) {
        // 附件删除失败不应该阻止数据集删除
        console.warn(
          `⚠️  [Delete] Failed to delete attachments for dataset ${safeDatasetId}:`,
          error.message
        );
      }

      // 步骤8: 删除元数据记录（由调用者提供的回调执行）
      if (deleteMetadata) {
        onProgress?.('正在更新元数据...', 98);
        await deleteMetadata();
      }

      onProgress?.('删除完成', 100);
      console.log(`✅ [Delete] Dataset deleted successfully: ${safeDatasetId}`);
    });
  }
}
