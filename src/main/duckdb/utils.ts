/**
 * DuckDB 工具函数
 */

import path from 'path';
import fs from 'fs-extra';
import type { DuckDBResultReader } from '@duckdb/node-api';
import * as crypto from 'crypto';
import { resolveUserDataDir } from '../../constants/runtime-config';

/**
 * SQL 字符串字面量转义（单引号）
 * 用于拼接到 '...' 场景（例如 COPY TO、ATTACH 路径等）。
 */
export function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * SQL 标识符引用（双引号）
 * 用于表名/列名/视图名/约束名等标识符位置。
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * 引用 schema.table 形式的名称（不解析用户输入，仅用于内部拼接）。
 */
export function quoteQualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function getUserDataDir(): string {
  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } };
    const userData = resolveUserDataDir(String(electron.app?.getPath?.('userData') || ''));
    if (userData && String(userData).trim()) return userData;
  } catch {
    // ignore: worker_threads 环境下可能没有 electron 模块
  }

  const fallback = resolveUserDataDir('');
  if (fallback.trim()) return fallback;

  throw new Error('Unable to resolve userData directory from runtime config.');
}

/**
 * 获取 DuckDB 数据目录
 */
export function getDuckDBDataDir(): string {
  return path.join(getUserDataDir(), 'duckdb');
}

/**
 * 获取主数据库路径
 */
export function getMainDBPath(): string {
  return path.join(getDuckDBDataDir(), 'main.db');
}

/**
 * 获取导入数据库目录
 */
export function getImportsDir(): string {
  return path.join(getDuckDBDataDir(), 'imports');
}

/**
 * 获取临时文件目录
 */
export function getTempDir(): string {
  return path.join(getDuckDBDataDir(), 'temp');
}

/**
 * 确保所有必需的目录存在
 */
export async function ensureDirectories(): Promise<void> {
  await fs.ensureDir(getDuckDBDataDir());
  await fs.ensureDir(getImportsDir());
  await fs.ensureDir(getTempDir());
}

/**
 * 将 datasetId 转换为安全的文件名
 * 注意：现在插件数据集ID已经使用双下划线格式（plugin__id__code），所以这个函数是幂等的
 *
 * @param datasetId - 数据集ID，使用双下划线分隔（如: plugin__doudian-publisher__doudian_products）
 * @returns 安全的文件名（如: plugin__doudian-publisher__doudian_products）
 */
export function sanitizeDatasetId(datasetId: string): string {
  // 将冒号替换为双下划线，保证在所有操作系统上都是合法的文件名
  // 注意：新的插件数据集ID格式已经不包含冒号，所以这个操作是幂等的
  return datasetId.replace(/:/g, '__');
}

/**
 * 将安全的文件名转换回 datasetId
 * 注意：现在插件数据集ID已经使用双下划线格式，所以这个函数也是幂等的
 *
 * @param safeFilename - 安全的文件名
 * @returns 原始的 datasetId
 */
export function desanitizeDatasetId(safeFilename: string): string {
  // 将双下划线转换回冒号
  // 注意：新的插件数据集ID格式已经使用双下划线，这个操作在插件数据集上是幂等的
  return safeFilename.replace(/__/g, ':');
}

/**
 * 获取数据集文件路径
 *
 * @param datasetId - 数据集ID（可能包含特殊字符）
 * @returns 安全的文件路径
 */
export function getDatasetPath(datasetId: string): string {
  const safeId = sanitizeDatasetId(datasetId);
  return path.join(getImportsDir(), `${safeId}.db`);
}

/**
 * 获取文件大小（字节）
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

/**
 * 格式化文件大小
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * 清理临时文件（保留最近 N 天）
 */
export async function cleanupTempFiles(daysToKeep: number = 1): Promise<number> {
  const tempDir = getTempDir();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = await fs.readdir(tempDir);

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);

      if (stats.mtimeMs < cutoff) {
        await fs.remove(filePath);
        deletedCount++;
      }
    }
  } catch (error) {
    console.error('Failed to cleanup temp files:', error);
  }

  return deletedCount;
}

/**
 * 检测文件类型
 */
export function detectFileType(filePath: string): 'csv' | 'xlsx' | 'xls' | 'json' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.csv':
      return 'csv';
    case '.json':
      return 'json';
    case '.xlsx':
      return 'xlsx';
    case '.xls':
      return 'xls';
    default:
      return 'unknown';
  }
}

/**
 * 生成临时文件路径
 */
export function getTempFilePath(originalFileName: string, extension: string): string {
  const tempDir = getTempDir();
  const randomId = crypto.randomBytes(8).toString('hex');
  const baseName = path.basename(originalFileName, path.extname(originalFileName));
  return path.join(tempDir, `${baseName}_${randomId}${extension}`);
}

/**
 * 清理临时文件
 */
export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
    }
  } catch (error) {
    console.warn(`Failed to cleanup temp file: ${filePath}`, error);
  }
}

/**
 * 转换DuckDB特殊类型值为JavaScript原生类型
 *
 * @param value - DuckDB返回的值
 * @returns JavaScript原生类型值
 *
 * @description
 * DuckDB可能返回特殊的类型对象，如：
 * - BigInt (BIGINT类型) -> number (如果超过安全整数范围则转为string)
 * - DuckDBListValue / DuckDBArrayValue -> Array
 * - DuckDBDateValue / DuckDBTimestampValue -> Date
 * - DuckDBDecimalValue -> number
 * - DuckDBBlobValue -> Buffer
 *
 * 此函数将这些特殊类型转换为前端可以直接使用的JavaScript类型
 * 特别注意：BigInt 无法通过 JSON 序列化，必须转换为 number 或 string
 */
function convertDuckDBValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  // 已经是原生类型，直接返回
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return value;
  }

  // 🔢 BigInt 转换
  // BigInt 无法直接通过 JSON 序列化，需要转换
  // ✅ 修复：超出安全范围时返回字符串，避免精度丢失
  if (valueType === 'bigint') {
    try {
      // 检查是否超过安全整数范围
      const bigintValue = value as bigint;
      if (
        bigintValue > BigInt(Number.MAX_SAFE_INTEGER) ||
        bigintValue < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        // 超出安全范围，返回字符串保持精度
        console.debug(`BigInt value ${value} exceeds safe integer range, returning as string`);
        return value.toString();
      }
      // 安全范围内，转换为 Number
      return Number(value);
    } catch (error) {
      console.warn('Failed to convert BigInt:', error);
      // 降级方案：转换为字符串
      return value.toString();
    }
  }

  // Date对象直接返回
  if (value instanceof Date) {
    return value;
  }

  // Buffer直接返回
  if (Buffer.isBuffer(value)) {
    return value;
  }

  // 处理DuckDB特殊类型对象
  if (valueType === 'object') {
    // DuckDB LIST/ARRAY类型转换
    // 特征：有 toArray 方法或可迭代
    if ('toArray' in value && typeof value.toArray === 'function') {
      try {
        return value.toArray();
      } catch (error) {
        console.warn('Failed to convert DuckDB LIST using toArray:', error);
      }
    }

    // 尝试作为可迭代对象转换
    if (Symbol.iterator in value) {
      try {
        return Array.from(value);
      } catch (error) {
        console.warn('Failed to convert DuckDB value using Array.from:', error);
      }
    }

    // DuckDB Timestamp/Date 类型转换
    // DuckDBTimestampValue: {micros: bigint} - 微秒时间戳
    // DuckDBDateValue: {days: number} - 自 1970-01-01 起的天数
    if ('micros' in value) {
      try {
        // micros 是微秒，需要除以 1000 转换为毫秒
        const milliseconds = Number(value.micros) / 1000;
        const date = new Date(milliseconds);

        // 🌍 使用 UTC 方法读取，避免时区转换问题
        // DuckDB 的 TIMESTAMP 类型将字符串解释为 UTC 时间
        // 我们也用 UTC 方法读取，保持一致
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');

        // 如果有时间部分（不是00:00:00），包含时间
        if (hours !== '00' || minutes !== '00' || seconds !== '00') {
          return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        }

        return `${year}-${month}-${day}`;
      } catch (error) {
        console.warn('Failed to convert DuckDBTimestampValue:', error);
      }
    }

    if ('days' in value) {
      try {
        // days 是自 1970-01-01 起的天数
        const milliseconds = Number(value.days) * 24 * 60 * 60 * 1000;
        const date = new Date(milliseconds);

        // 🌍 使用 UTC 方法读取，避免时区转换问题
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');

        return `${year}-${month}-${day}`;
      } catch (error) {
        console.warn('Failed to convert DuckDBDateValue:', error);
      }
    }

    // DuckDB Date 对象格式：{year, month, day, hour?, minute?, second?}
    // 必须在 valueOf 之前检查，因为这种对象可能没有有效的 valueOf
    // 转换为 ISO 字符串格式，而不是 Date 对象，因为 Date 对象在 Electron IPC 传输中会丢失
    if ('year' in value && 'month' in value && 'day' in value) {
      try {
        const year = value.year;
        const month = String(value.month).padStart(2, '0');
        const day = String(value.day).padStart(2, '0');

        if (value.hour !== undefined) {
          const hours = String(value.hour).padStart(2, '0');
          const minutes = String(value.minute || 0).padStart(2, '0');
          const seconds = String(value.second || 0).padStart(2, '0');
          return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        }

        return `${year}-${month}-${day}`;
      } catch (error) {
        console.warn('Failed to convert DuckDB Date object:', error);
      }
    }

    // DuckDB Date/Timestamp类型转换（使用 valueOf）
    // 特征：有 valueOf 方法返回时间戳
    // 转换为 ISO 字符串格式，而不是 Date 对象
    if ('valueOf' in value && typeof value.valueOf === 'function') {
      try {
        const timestamp = value.valueOf();
        if (typeof timestamp === 'number' && !isNaN(timestamp)) {
          const date = new Date(timestamp);
          // 🌍 使用 UTC 方法读取，避免时区转换问题
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const day = String(date.getUTCDate()).padStart(2, '0');
          const hours = String(date.getUTCHours()).padStart(2, '0');
          const minutes = String(date.getUTCMinutes()).padStart(2, '0');
          const seconds = String(date.getUTCSeconds()).padStart(2, '0');

          // 如果有时间部分（不是00:00:00），包含时间
          if (hours !== '00' || minutes !== '00' || seconds !== '00') {
            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
          }
          return `${year}-${month}-${day}`;
        }
      } catch (error) {
        console.warn('Failed to convert DuckDB Date/Timestamp:', error);
      }
    }

    // DuckDB Decimal类型转换
    // 特征：有 toString 方法返回数字字符串
    if ('toString' in value && typeof value.toString === 'function') {
      try {
        const str = value.toString();
        // 检查是否是数字字符串
        if (/^-?\d+(\.\d+)?$/.test(str)) {
          const num = parseFloat(str);
          if (!isNaN(num)) {
            return num;
          }
        }
      } catch (error) {
        console.warn('Failed to convert DuckDB Decimal:', error);
      }
    }
  }

  // 无法转换，返回原值
  return value;
}

/**
 * 将 DuckDB 结果转换为对象数组（类型安全版本）
 *
 * @template T - 行数据的类型，默认为 Record<string, unknown>
 * @param reader - DuckDB 结果读取器
 * @returns 类型化的对象数组
 *
 * @example
 * ```typescript
 * interface User {
 *   id: number;
 *   name: string;
 *   email: string;
 * }
 *
 * const users = parseRows<User>(result);
 * // users 类型为 User[]
 * ```
 *
 * @description
 * 此函数会自动将DuckDB的特殊类型转换为JavaScript原生类型：
 * - LIST -> Array
 * - DATE/TIMESTAMP -> Date
 * - DECIMAL -> number
 * - BLOB -> Buffer
 */
export function parseRows<T = Record<string, unknown>>(reader: DuckDBResultReader): T[] {
  const columnNames = reader.columnNames();
  const rows = reader.getRows();

  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columnNames.forEach((name, idx) => {
      // 转换DuckDB特殊类型为JavaScript原生类型
      obj[name] = convertDuckDBValue(row[idx]);
    });
    return obj as T;
  });
}

/**
 * 重试配置
 */
export interface RetryOptions {
  maxAttempts?: number; // 最大重试次数（默认3次）
  delayMs?: number; // 初始延迟时间（默认100ms）
  backoffMultiplier?: number; // 延迟倍增系数（默认2）
  maxDelayMs?: number; // 最大延迟时间（默认5000ms）
  retryableErrors?: string[]; // 可重试的错误关键字
}

/**
 * 检查错误是否可重试
 */
function isRetryableError(error: Error, retryableErrors: string[]): boolean {
  const errorMessage = error.message.toLowerCase();

  // 默认可重试的错误模式
  const defaultRetryablePatterns = [
    'database is locked',
    'database locked',
    'busy',
    'cannot open',
    'connection lost',
    'io error',
    'ebusy',
  ];

  const patterns = retryableErrors.length > 0 ? retryableErrors : defaultRetryablePatterns;

  return patterns.some((pattern) => errorMessage.includes(pattern.toLowerCase()));
}

/**
 * 带重试机制的异步操作包装器
 *
 * @template T - 返回值类型
 * @param operation - 要执行的异步操作
 * @param options - 重试配置
 * @returns 操作结果
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => await conn.run('INSERT INTO data VALUES (?)'),
 *   { maxAttempts: 5, delayMs: 200 }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 100,
    backoffMultiplier = 2,
    maxDelayMs = 5000,
    retryableErrors = [],
  } = options;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // 检查是否可重试
      if (!isRetryableError(lastError, retryableErrors)) {
        console.error(`❌ Non-retryable error encountered:`, lastError.message);
        throw lastError;
      }

      // 最后一次尝试失败，不再重试
      if (attempt === maxAttempts) {
        console.error(`❌ Max retry attempts (${maxAttempts}) reached`);
        break;
      }

      // 等待后重试
      console.warn(`⚠️  Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
      console.log(`🔄 Retrying in ${currentDelay}ms...`);

      await new Promise((resolve) => setTimeout(resolve, currentDelay));

      // 指数退避
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError || new Error('Operation failed after retries');
}

/**
 * 数据库操作专用重试包装器（预配置了数据库相关的错误）
 */
export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  customOptions: RetryOptions = {}
): Promise<T> {
  return withRetry(operation, {
    maxAttempts: 5,
    delayMs: 200,
    backoffMultiplier: 2,
    maxDelayMs: 3000,
    ...customOptions,
  });
}

/**
 * 数据库完整性检查结果
 */
export interface DatabaseIntegrityResult {
  isValid: boolean; // 数据库是否完整
  errors: string[]; // 发现的错误列表
  warnings: string[]; // 警告列表
  canRepair: boolean; // 是否可以尝试修复
  fileSizeBytes?: number; // 文件大小
}

/**
 * 检查数据库文件完整性
 *
 * @param dbPath - 数据库文件路径
 * @returns 完整性检查结果
 *
 * @example
 * ```typescript
 * const result = await checkDatabaseIntegrity('/path/to/db.duckdb');
 * if (!result.isValid) {
 *   console.error('Database corrupted:', result.errors);
 *   if (result.canRepair) {
 *     // 尝试修复
 *   }
 * }
 * ```
 */
export async function checkDatabaseIntegrity(dbPath: string): Promise<DatabaseIntegrityResult> {
  const result: DatabaseIntegrityResult = {
    isValid: true,
    errors: [],
    warnings: [],
    canRepair: false,
  };

  try {
    // 1. 检查文件是否存在
    const exists = await fs.pathExists(dbPath);
    if (!exists) {
      result.isValid = false;
      result.errors.push('Database file does not exist');
      result.canRepair = false;
      return result;
    }

    // 2. 检查文件大小
    const stats = await fs.stat(dbPath);
    result.fileSizeBytes = stats.size;

    if (stats.size === 0) {
      result.isValid = false;
      result.errors.push('Database file is empty (0 bytes)');
      result.canRepair = false;
      return result;
    }

    // 3. 检查文件头（DuckDB 文件应该以特定的魔数开头）
    try {
      const buffer = Buffer.allocUnsafe(16);
      const fd = await fs.open(dbPath, 'r');
      await fs.read(fd, buffer, 0, 16, 0);
      await fs.close(fd);

      // DuckDB 文件魔数检查（简化版）
      // 注意：实际的魔数可能需要根据 DuckDB 版本调整
      const header = buffer.toString('utf8', 0, 4);
      if (!header.includes('DUCK') && stats.size > 100) {
        // 如果文件较大但没有正确的头，可能损坏
        result.warnings.push('Database file header may be corrupted');
      }
    } catch {
      result.warnings.push('Could not read database file header');
    }

    // 4. 尝试打开数据库并执行完整性检查
    const { DuckDBInstance, DuckDBConnection } = await import('@duckdb/node-api');

    let db: any = null;
    let conn: any = null;

    try {
      db = await DuckDBInstance.create(dbPath);
      conn = await DuckDBConnection.create(db);

      // 执行 PRAGMA integrity_check（如果 DuckDB 支持）
      try {
        await conn.runAndReadAll('SELECT 1');
        // 如果能成功执行查询，数据库基本可用
      } catch (queryError: any) {
        result.isValid = false;
        result.errors.push(`Database query failed: ${queryError.message}`);
        result.canRepair =
          queryError.message.includes('corrupted') || queryError.message.includes('damaged');
      }

      // 检查是否有未完成的事务或 WAL 文件
      const walPath = `${dbPath}.wal`;
      if (await fs.pathExists(walPath)) {
        result.warnings.push('WAL file exists - database may have uncommitted transactions');
      }
    } catch (openError: any) {
      result.isValid = false;
      result.errors.push(`Failed to open database: ${openError.message}`);

      // 某些错误可能可以通过删除 WAL 等辅助文件修复
      result.canRepair =
        openError.message.includes('locked') ||
        openError.message.includes('busy') ||
        openError.message.includes('wal');
    } finally {
      try {
        if (conn) conn.closeSync();
        if (db) db.closeSync();
      } catch (closeError) {
        console.warn('Failed to close database during integrity check:', closeError);
      }
    }
  } catch (error: any) {
    result.isValid = false;
    result.errors.push(`Integrity check failed: ${error.message}`);
    result.canRepair = false;
  }

  return result;
}

/**
 * 尝试修复损坏的数据库
 *
 * @param dbPath - 数据库文件路径
 * @returns 是否修复成功
 */
export async function repairDatabase(dbPath: string): Promise<boolean> {
  try {
    console.log(`🔧 Attempting to repair database: ${dbPath}`);

    // 1. 删除 WAL 和其他辅助文件
    const auxiliaryFiles = [
      `${dbPath}.wal`,
      `${dbPath}.tmp`,
      `${dbPath}-shm`,
      `${dbPath}-journal`,
      `${dbPath}.lock`,
      `${dbPath}-wal`,
    ];

    let removedCount = 0;
    for (const filePath of auxiliaryFiles) {
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
          removedCount++;
          console.log(`🗑️  Removed auxiliary file: ${path.basename(filePath)}`);
        }
      } catch (removeError) {
        console.warn(`Failed to remove ${filePath}:`, removeError);
      }
    }

    if (removedCount > 0) {
      console.log(`✅ Removed ${removedCount} auxiliary file(s)`);

      // 2. 重新检查完整性
      const checkResult = await checkDatabaseIntegrity(dbPath);

      if (checkResult.isValid) {
        console.log(`✅ Database repaired successfully`);
        return true;
      } else {
        console.error(`❌ Database still corrupted after repair attempt`);
        return false;
      }
    } else {
      console.log(`ℹ️  No auxiliary files to remove`);
      return false;
    }
  } catch (error) {
    console.error(`Failed to repair database:`, error);
    return false;
  }
}
