import { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import type { ExportOptions, ExportProgress } from '../../types/electron';
import { createLogger } from '../../core/logger';
import { escapeSqlStringLiteral, parseRows } from './utils';

const logger = createLogger('DatasetExportWriter');

export interface DatasetExportWriteParams {
  format: ExportOptions['format'];
  exportSQL: string;
  outputPath: string;
  options: ExportOptions;
  onProgress?: (progress: ExportProgress) => void;
}

export interface DatasetExportWriteResult {
  files: string[];
  totalRows: number;
}

export class DatasetExportWriter {
  constructor(private conn: DuckDBConnection) {}

  async exportByFormat(params: DatasetExportWriteParams): Promise<DatasetExportWriteResult> {
    const { format, exportSQL, outputPath, options, onProgress } = params;

    if (format === 'xlsx') {
      return await this.exportToExcel(
        exportSQL,
        outputPath,
        {
          maxRowsPerFile: 1_000_000,
        },
        onProgress
      );
    }

    if (format === 'csv') {
      await this.exportToCSV(exportSQL, outputPath, options);
      const totalRows = await this.getRowCount(exportSQL);
      onProgress?.({
        current: 1,
        total: 1,
        message: 'CSV 导出完成',
        percentage: 80,
      });
      return { files: [outputPath], totalRows };
    }

    if (format === 'txt') {
      await this.exportToTXT(exportSQL, outputPath, options);
      const totalRows = await this.getRowCount(exportSQL);
      onProgress?.({
        current: 1,
        total: 1,
        message: 'TXT 导出完成',
        percentage: 80,
      });
      return { files: [outputPath], totalRows };
    }

    if (format === 'parquet') {
      await this.exportToParquet(exportSQL, outputPath);
      const totalRows = await this.getRowCount(exportSQL);
      onProgress?.({
        current: 1,
        total: 1,
        message: 'Parquet 导出完成',
        percentage: 80,
      });
      return { files: [outputPath], totalRows };
    }

    if (format === 'json') {
      await this.exportToJSON(exportSQL, outputPath, options);
      const totalRows = await this.getRowCount(exportSQL);
      onProgress?.({
        current: 1,
        total: 1,
        message: 'JSON 导出完成',
        percentage: 80,
      });
      return { files: [outputPath], totalRows };
    }

    throw new Error('Unsupported export format: ' + format);
  }

private async exportToCSV(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));
    const delimiter = escapeSqlStringLiteral(options.delimiter || ',');
    const header = options.includeHeader !== false;

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT CSV, HEADER ${header}, DELIMITER '${delimiter}');
    `;

    logger.info('Exporting dataset to CSV', { outputPath });
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    logger.info('Dataset CSV export completed', { outputPath });
  }

private async exportToExcel(
    sql: string,
    outputPath: string,
    options: { maxRowsPerFile: number },
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ files: string[]; totalRows: number }> {
    const { maxRowsPerFile } = options;

    // 1. 获取总行数
    const totalRows = await this.getRowCount(sql);
    logger.info('Counted rows for dataset export', { totalRows });

    // 2. 判断是否需要拆分
    if (totalRows <= maxRowsPerFile) {
      // 无需拆分，直接导出
      logger.info('Exporting single Excel file', { outputPath, totalRows });
      onProgress?.({
        current: 0,
        total: 1,
        message: `正在导出 Excel 文件 (${totalRows.toLocaleString()} 行)...`,
        percentage: 30,
      });

      await this.exportSingleExcel(sql, outputPath);

      onProgress?.({
        current: 1,
        total: 1,
        message: 'Excel 导出完成',
        percentage: 80,
      });

      return { files: [outputPath], totalRows };
    }

    // 3. 需要拆分
    const filesCount = Math.ceil(totalRows / maxRowsPerFile);
    const { dir, name, ext } = path.parse(outputPath);
    const files: string[] = [];

    logger.info('Splitting dataset export into Excel parts', {
      outputPath,
      filesCount,
      totalRows,
      maxRowsPerFile,
    });

    for (let i = 0; i < filesCount; i++) {
      const offset = i * maxRowsPerFile;
      const limit = maxRowsPerFile;
      const filePath = path.join(dir, `${name}_part${i + 1}${ext}`);

      // 报告进度
      const currentPercentage = 30 + Math.floor((i / filesCount) * 50); // 30-80%
      onProgress?.({
        current: i + 1,
        total: filesCount,
        message: `正在导出第 ${i + 1}/${filesCount} 个文件...`,
        percentage: currentPercentage,
      });

      // 分页查询并导出
      const pagedSQL = `${sql} LIMIT ${limit} OFFSET ${offset}`;
      await this.exportSingleExcel(pagedSQL, filePath);

      files.push(filePath);
      logger.info('Dataset Excel export part completed', {
        outputPath: filePath,
        part: i + 1,
        totalParts: filesCount,
      });
    }

    // 所有文件导出完成
    onProgress?.({
      current: filesCount,
      total: filesCount,
      message: `Excel 导出完成 (${filesCount} 个文件)`,
      percentage: 80,
    });

    return { files, totalRows };
  }

private async exportSingleExcel(sql: string, outputPath: string): Promise<void> {
    // 动态导入 exceljs（避免不必要的依赖）
    let ExcelJS: any;
    try {
      ExcelJS = require('exceljs');
    } catch {
      throw new Error(
        'exceljs module not found. Please install it first:\n' +
          '  npm install exceljs\n\n' +
          'Excel export functionality requires the exceljs package.'
      );
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: outputPath,
      useSharedStrings: false,
      useStyles: true,
    });
    const worksheet = workbook.addWorksheet('Data');

    logger.info('Streaming data for Excel export', { outputPath });
    const result = await this.conn.stream(sql);
    const columns = result.columnNames();
    worksheet.columns = columns.map((col: string) => ({
      header: col,
      key: col,
      width: Math.min(Math.max(col.length + 2, 10), 50),
    }));

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    headerRow.commit();

    let streamedRows = 0;
    for await (const chunk of result.yieldRowObjectJs()) {
      for (const row of chunk) {
        worksheet.addRow(row).commit();
        streamedRows += 1;
      }
    }

    logger.info('Streamed rows into Excel export', {
      outputPath,
      rowCount: streamedRows,
    });

    logger.info('Writing Excel export file', { outputPath });
    try {
      worksheet.commit();
      await workbook.commit();
      logger.info('Excel export file written successfully', { outputPath });
    } catch (writeError) {
      logger.error('Failed to write Excel export file', {
        outputPath,
        errorMessage: writeError instanceof Error ? writeError.message : String(writeError),
      });
      throw new Error(
        `Failed to write Excel file: ${writeError instanceof Error ? writeError.message : String(writeError)}\n` +
          `Please check if the file path is valid and you have write permissions.`
      );
    }
  }

private async exportToTXT(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    // TXT 格式：无表头，无分隔符，无引号
    // 如果是多列，只导出第一列
    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT CSV, HEADER false, DELIMITER '', QUOTE '');
    `;

    logger.info('Exporting dataset to TXT', { outputPath });
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    logger.info('Dataset TXT export completed', { outputPath });
  }

private async exportToParquet(sql: string, outputPath: string): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT PARQUET, COMPRESSION 'SNAPPY');
    `;

    logger.info('Exporting dataset to Parquet', { outputPath });
    await this.conn.run(copySQL);
    logger.info('Dataset Parquet export completed', { outputPath });
  }

private async exportToJSON(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT JSON, ARRAY true);
    `;

    logger.info('Exporting dataset to JSON', { outputPath });
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    logger.info('Dataset JSON export completed', { outputPath });
  }

private async rewriteTextFileEncoding(
    outputPath: string,
    encoding?: ExportOptions['encoding']
  ): Promise<void> {
    if (!encoding || encoding === 'utf8') {
      return;
    }

    let iconv: typeof import('iconv-lite');
    try {
      iconv = require('iconv-lite');
    } catch {
      throw new Error(
        'iconv-lite module not found. Please install it first:\n' +
          '  npm install iconv-lite\n\n' +
          'Non-UTF8 export functionality requires the iconv-lite package.'
      );
    }

    const text = await fs.readFile(outputPath, 'utf8');
    await fs.writeFile(outputPath, iconv.encode(text, encoding));
  }

private async getRowCount(sql: string): Promise<number> {
    const result = await this.conn.runAndReadAll(`SELECT COUNT(*) as count FROM (${sql})`);
    const rows = parseRows<{ count: number }>(result);
    return Number(rows[0].count);
  }

private async getColumns(sql: string): Promise<string[]> {
    // 检查 SQL 是否已经包含 LIMIT（避免重复添加）
    const hasLimit = /\bLIMIT\s+\d+/i.test(sql);

    // 执行 LIMIT 0 查询以获取列名
    const querySql = hasLimit ? sql : `${sql} LIMIT 0`;
    const result = await this.conn.runAndReadAll(querySql);
    const columnNames = result.columnNames();

    if (columnNames.length === 0) {
      // 如果没有结果，使用 DESCRIBE
      const descResult = await this.conn.runAndReadAll(`DESCRIBE (${sql})`);
      const rows = parseRows(descResult);
      return rows.map((row: any) => row.column_name);
    }

    return columnNames;
  }
}
