/**
 * 统一导入Worker - 支持CSV、XLSX、XLS、JSON格式
 */

import { parentPort, workerData } from 'worker_threads';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import type { ImportTask } from './types';
import { detectFileType, cleanupTempFile, parseRows } from './utils';
import { getUnknownErrorMessage } from '../ipc-utils';
import { importCSV } from './import-worker-csv';
import { importJSON, importXLSX } from './import-worker-structured-loaders';
import { analyzeColumnTypes, getBasicSchema, optimizeTableStructure } from './import-worker-schema-analysis';

export { finishWriteStream, writeWithBackpressure } from './import-worker-csv';

const task: ImportTask = workerData;

async function importFile() {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;
  let tempFilePath: string | null = null;

  try {
    // ✅ 清理可能残留的数据库文件（与插件表创建逻辑保持一致）
    if (await fs.pathExists(task.outputPath)) {
      await fs.remove(task.outputPath);
    }
    const walPath = `${task.outputPath}.wal`;
    if (await fs.pathExists(walPath)) {
      await fs.remove(walPath);
    }

    db = await DuckDBInstance.create(task.outputPath);
    conn = await DuckDBConnection.create(db);

    parentPort?.postMessage({
      type: 'progress',
      progress: 0,
      message: '初始化数据库...',
    });

    // 检测文件类型
    const fileType = detectFileType(task.filePath);
    let finalFilePath = task.filePath;
    let normalizedType = fileType;

    // XLS需要转换为CSV
    if (fileType === 'xls') {
      parentPort?.postMessage({
        type: 'progress',
        progress: 10,
        message: '转换XLS格式...',
      });

      const { XLSConverter } = await import('./xls-converter');
      const converter = new XLSConverter();
      tempFilePath = await converter.convertToCSV(finalFilePath);
      finalFilePath = tempFilePath;
      normalizedType = 'csv';
    }

    // 导入数据
    if (normalizedType === 'xlsx') {
      await importXLSX(conn, finalFilePath);
    } else if (normalizedType === 'json') {
      await importJSON(conn, finalFilePath);
    } else {
      // CSV 或转换后的 XLS
      await importCSV(conn, finalFilePath);
    }

    parentPort?.postMessage({
      type: 'progress',
      progress: 60,
      message: '数据导入完成，获取基础信息...',
    });

    // 获取行数
    const countResult = await conn.runAndReadAll('SELECT COUNT(*) as count FROM data');
    const rowCount = Number(parseRows(countResult)[0].count);

    // 获取基础 schema（DuckDB自动检测的类型）
    const basicSchema = await getBasicSchema(conn, 'data');

    parentPort?.postMessage({
      type: 'progress',
      progress: 70,
      message: '智能分析列类型...',
    });

    // 智能分析每列的实际数据，推断更准确的字段类型
    const analysisResult = await analyzeColumnTypes(conn, 'data', basicSchema, rowCount);

    // 如果有需要转换的列，使用CREATE TABLE AS SELECT优化表结构
    if (analysisResult.conversions.length > 0) {
      parentPort?.postMessage({
        type: 'progress',
        progress: 80,
        message: `优化 ${analysisResult.conversions.length} 列的数据类型...`,
      });

      await optimizeTableStructure(conn, 'data', analysisResult.conversions, basicSchema);

      parentPort?.postMessage({
        type: 'progress',
        progress: 85,
        message: '类型优化完成',
      });
    }

    // 默认查询模板快照由主进程 QueryTemplateService.getOrCreateDefaultQueryTemplate 创建
    // 这里不再创建 legacy v_default 视图
    parentPort?.postMessage({
      type: 'progress',
      progress: 87,
      message: '准备默认视图...',
    });

    parentPort?.postMessage({
      type: 'progress',
      progress: 90,
      message: '保存元数据...',
    });

    // 关闭数据库连接（必须在发送complete消息之前关闭，否则UI会因为文件锁定而无法打开）
    if (conn) {
      conn.closeSync();
      conn = null;
    }
    if (db) {
      db.closeSync();
      db = null;
    }

    parentPort?.postMessage({
      type: 'complete',
      rowCount,
      columnCount: analysisResult.finalSchema.length,
      schema: analysisResult.finalSchema,
    });
  } catch (error: unknown) {
    console.error('Import worker error:', error);
    parentPort?.postMessage({
      type: 'error',
      error: getUnknownErrorMessage(error, 'Unknown error during import'),
    });
  } finally {
    try {
      // 清理临时文件和确保连接已关闭
      if (conn) {
        conn.closeSync();
      }
      if (db) {
        db.closeSync();
      }
      if (tempFilePath) await cleanupTempFile(tempFilePath);
    } catch (closeError) {
      console.error('Error closing resources:', closeError);
    }
  }
}

if (workerData) {
  importFile().catch((error) => {
    console.error('Unhandled error in import worker:', error);
    parentPort?.postMessage({
      type: 'error',
      error: getUnknownErrorMessage(error, 'Unhandled error'),
    });
  });
}
