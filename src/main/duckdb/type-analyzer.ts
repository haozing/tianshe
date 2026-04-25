/**
 * 高性能类型分析器
 * 采样1000行进行类型推断，避免全表扫描
 */

import { DuckDBConnection } from '@duckdb/node-api';
import type { EnhancedColumnSchema, ColumnStatistics, ColumnMetadata, FieldType } from './types';
import { parseRows } from './utils';

export class TypeAnalyzer {
  // ✅ 采样配置（平衡准确性和性能）
  private readonly MIN_SAMPLE_SIZE = 1000; // 最小采样量
  private readonly MAX_SAMPLE_SIZE = 50000; // 最大采样量
  private readonly DEFAULT_SAMPLE_SIZE = 10000; // 默认采样量
  private readonly VERSION = 'v2.1-dynamic-sampling'; // 版本标识

  /**
   * ✅ 动态计算采样大小
   * 对于小表：采样全部
   * 对于大表：采样 sqrt(totalRows)，但不超过最大值
   */
  private calculateSampleSize(totalRows: number): number {
    if (totalRows <= this.MIN_SAMPLE_SIZE) {
      return totalRows; // 小表采样全部
    }
    if (totalRows <= this.DEFAULT_SAMPLE_SIZE) {
      return totalRows; // 中等表采样全部
    }
    // 大表：动态采样，使用平方根策略
    const dynamicSize = Math.ceil(Math.sqrt(totalRows) * 10);
    return Math.min(Math.max(dynamicSize, this.DEFAULT_SAMPLE_SIZE), this.MAX_SAMPLE_SIZE);
  }

  /**
   * 分析表的所有列
   */
  async analyzeTable(
    conn: DuckDBConnection,
    tableName: string = 'data'
  ): Promise<EnhancedColumnSchema[]> {
    // 获取总行数以计算动态采样大小
    const countResult = await conn.runAndReadAll(`SELECT COUNT(*) as cnt FROM ${tableName}`);
    const totalRows = Number(parseRows(countResult)[0].cnt);
    const sampleSize = this.calculateSampleSize(totalRows);

    console.log(
      `[TypeAnalyzer] Version: ${this.VERSION}, Total rows: ${totalRows}, Sample size: ${sampleSize}`
    );
    const basicSchema = await this.getBasicSchema(conn, tableName);

    const enhancedSchema = await Promise.all(
      basicSchema.map((col) => this.analyzeColumn(conn, tableName, col.name, col.type, sampleSize))
    );

    return enhancedSchema;
  }

  /**
   * 分析单列
   */
  private async analyzeColumn(
    conn: DuckDBConnection,
    tableName: string,
    columnName: string,
    duckdbType: string,
    sampleSize: number
  ): Promise<EnhancedColumnSchema> {
    const stats = await this.getColumnStatistics(conn, tableName, columnName, sampleSize);

    let fieldType: FieldType = 'text';
    let metadata: ColumnMetadata = {};

    if (this.isDateType(duckdbType)) {
      fieldType = 'date';
      metadata.includeTime = duckdbType.includes('TIMESTAMP');
    } else if (this.isNumericType(duckdbType)) {
      fieldType = 'number';
      metadata.format = duckdbType.includes('INT') ? 'integer' : 'decimal';
    } else if (duckdbType === 'VARCHAR') {
      const analysis = this.analyzeTextColumn(stats);
      fieldType = analysis.fieldType;
      metadata = analysis.metadata;
    }

    return {
      name: columnName,
      duckdbType,
      fieldType,
      nullable: stats.nullCount > 0,
      metadata,
    };
  }

  /**
   * 分析文本列
   */
  private analyzeTextColumn(stats: ColumnStatistics): {
    fieldType: FieldType;
    metadata: ColumnMetadata;
  } {
    // 1. 文件/链接检测（优先级最高）
    const fileAnalysis = this.analyzeFileOrLink(stats);
    if (fileAnalysis) {
      return fileAnalysis;
    }

    // 2. 多选检测
    const separator = this.detectSeparator(stats);
    if (separator) {
      return { fieldType: 'multi_select', metadata: { separator } };
    }

    // 3. 单选检测
    if (this.isSingleSelect(stats)) {
      const options = this.extractUniqueOptions(stats);
      console.log(
        `[TypeAnalyzer] Detected single_select with ${options.length} options:`,
        options.slice(0, 10)
      );
      return {
        fieldType: 'single_select',
        metadata: {
          options,
          colorMap: this.generateColorMap(options),
        },
      };
    }

    return { fieldType: 'text', metadata: {} };
  }

  /**
   * 获取列统计信息
   */
  private async getColumnStatistics(
    conn: DuckDBConnection,
    tableName: string,
    columnName: string,
    sampleSize: number
  ): Promise<ColumnStatistics> {
    const escapedCol = `"${columnName}"`;

    // 第一步：获取统计信息（使用动态采样大小）
    const statsSql = `
      WITH sampled AS (
        SELECT ${escapedCol}
        FROM ${tableName}
        LIMIT ${sampleSize}
      )
      SELECT
        COUNT(*) as total_rows,
        COUNT(*) - COUNT(${escapedCol}) as null_count,
        COUNT(DISTINCT ${escapedCol}) as unique_values
      FROM sampled
    `;

    const statsResult = await conn.runAndReadAll(statsSql);
    const statsRow = parseRows(statsResult)[0];

    // 第二步：直接查询前 100 个非 NULL 值
    const sampleSql = `
      SELECT ${escapedCol}
      FROM ${tableName}
      WHERE ${escapedCol} IS NOT NULL
      LIMIT 100
    `;

    const sampleResult = await conn.runAndReadAll(sampleSql);
    const sampleRows = parseRows(sampleResult);

    // 提取列值到数组
    const sampleValues = sampleRows.map((row) => row[columnName]);

    console.log(
      `[TypeAnalyzer] getColumnStatistics for "${columnName}": total_rows=${statsRow.total_rows}, sample_values=${sampleValues.length}`
    );

    return {
      totalRows: Number(statsRow.total_rows),
      nullCount: Number(statsRow.null_count),
      uniqueValues: Number(statsRow.unique_values),
      sampleValues,
    };
  }

  private isSingleSelect(stats: ColumnStatistics): boolean {
    const nonNullRows = stats.totalRows - stats.nullCount;
    return (
      stats.uniqueValues > 1 &&
      stats.uniqueValues <= 50 && // 提高阈值到50，支持更多分类字段
      nonNullRows > 0 &&
      nonNullRows / stats.totalRows > 0.5
    );
  }

  private detectSeparator(stats: ColumnStatistics): string | null {
    if (!stats.sampleValues || stats.sampleValues.length === 0) {
      return null;
    }

    const separators = [',', ';', '|', '、'];

    for (const sep of separators) {
      const matchCount = stats.sampleValues.filter(
        (v) => typeof v === 'string' && v.includes(sep)
      ).length;

      if (matchCount / stats.sampleValues.length > 0.3) {
        return sep;
      }
    }

    return null;
  }

  private extractUniqueOptions(stats: ColumnStatistics): string[] {
    if (!stats.sampleValues || stats.sampleValues.length === 0) {
      return [];
    }

    const uniqueSet = new Set(
      stats.sampleValues.filter((v) => v !== null && v !== undefined).map((v) => String(v).trim())
    );

    return Array.from(uniqueSet).sort();
  }

  private isDateType(duckdbType: string): boolean {
    const dateTypes = ['DATE', 'TIMESTAMP', 'TIME', 'DATETIME'];
    return dateTypes.some((dt) => duckdbType.toUpperCase().includes(dt));
  }

  private isNumericType(duckdbType: string): boolean {
    const numericTypes = [
      'INT',
      'FLOAT',
      'DOUBLE',
      'DECIMAL',
      'NUMERIC',
      'BIGINT',
      'SMALLINT',
      'TINYINT',
    ];
    return numericTypes.some((nt) => duckdbType.toUpperCase().includes(nt));
  }

  private async getBasicSchema(
    conn: DuckDBConnection,
    tableName: string
  ): Promise<Array<{ name: string; type: string }>> {
    const result = await conn.runAndReadAll(`DESCRIBE ${tableName}`);
    const rows = parseRows(result);

    return rows.map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
  }

  /**
   * 为选项生成颜色映射
   */
  private generateColorMap(options: string[]): Record<string, string> {
    const colors = [
      '#3B82F6', // blue
      '#10B981', // green
      '#F59E0B', // amber
      '#EF4444', // red
      '#8B5CF6', // purple
      '#EC4899', // pink
      '#14B8A6', // teal
      '#F97316', // orange
      '#6366F1', // indigo
      '#84CC16', // lime
    ];

    const colorMap: Record<string, string> = {};
    options.forEach((option, index) => {
      colorMap[option] = colors[index % colors.length];
    });

    return colorMap;
  }

  /**
   * 分析文件或链接类型（v2: 独立 attachment 类型）
   */
  private analyzeFileOrLink(stats: ColumnStatistics): {
    fieldType: FieldType;
    metadata: ColumnMetadata;
  } | null {
    console.log(
      '[TypeAnalyzer] analyzeFileOrLink called, sampleValues:',
      stats.sampleValues ? stats.sampleValues.length : 'null/undefined'
    );

    if (!stats.sampleValues || stats.sampleValues.length === 0) {
      console.log('[TypeAnalyzer] analyzeFileOrLink: No sample values, returning null');
      return null;
    }

    const validSamples = stats.sampleValues.filter(
      (v) => v !== null && v !== undefined && v !== ''
    );
    console.log('[TypeAnalyzer] analyzeFileOrLink: validSamples count:', validSamples.length);

    if (validSamples.length === 0) {
      console.log(
        '[TypeAnalyzer] analyzeFileOrLink: No valid samples after filtering, returning null'
      );
      return null;
    }

    let linkCount = 0;
    let fileCount = 0;
    const fileTypes: string[] = [];

    // 调试：记录前3个样本
    const firstSamples = validSamples.slice(0, 3).map((v) => String(v).trim());
    console.log(`[TypeAnalyzer] Analyzing ${validSamples.length} samples, first 3:`, firstSamples);

    // 分析每个样本（可能包含多个URL，用分隔符分开）
    for (const value of validSamples) {
      const str = String(value).trim();

      // 尝试分割（支持常见分隔符）
      const urls = this.splitUrls(str);

      for (const url of urls) {
        const analysis = this.analyzeUrlOrPath(url);

        if (analysis) {
          if (analysis.isLink) {
            linkCount++;
          }
          if (analysis.isFile) {
            fileCount++;
            if (analysis.fileType) {
              fileTypes.push(analysis.fileType);
            }
          }
        }
      }
    }

    const totalUrls = linkCount; // 使用 linkCount 作为总数
    const linkRatio = totalUrls > 0 ? linkCount / validSamples.length : 0;
    const fileRatio = linkCount > 0 ? fileCount / linkCount : 0;

    console.log(
      `[TypeAnalyzer] Link detection: ${linkCount}/${validSamples.length} (${(linkRatio * 100).toFixed(1)}%), File: ${fileCount}/${linkCount} (${(fileRatio * 100).toFixed(1)}%)`
    );
    if (fileTypes.length > 0) {
      console.log(`[TypeAnalyzer] File types detected:`, fileTypes.slice(0, 5));
    }

    // 判断：80% 以上是链接
    if (linkRatio >= 0.8) {
      // 检测分隔符
      const separator = this.detectUrlSeparator(validSamples);

      // 关键判断：80% 以上是文件URL → attachment（独立类型）
      if (fileRatio >= 0.8) {
        const primaryFileType = this.getMostCommonType(fileTypes);

        console.log(`[TypeAnalyzer] Detected ATTACHMENT field (fileType: ${primaryFileType})`);

        return {
          fieldType: 'attachment', // 👈 独立的附件类型
          metadata: {
            fileType: primaryFileType, // 'image' | 'document' | 'video' | 'audio' | 'archive'
            isImage: primaryFileType === 'image',
            isDocument: primaryFileType === 'document',
            isVideo: primaryFileType === 'video',
            isAudio: primaryFileType === 'audio',
            isArchive: primaryFileType === 'archive',
            separator,
          },
        };
      }
      // 普通链接 → hyperlink
      else {
        console.log(`[TypeAnalyzer] Detected HYPERLINK field`);

        return {
          fieldType: 'hyperlink', // 👈 纯链接类型
          metadata: {
            separator,
          },
        };
      }
    }

    return null;
  }

  /**
   * 分割URL字符串（支持多种分隔符）
   */
  private splitUrls(value: string): string[] {
    // 尝试常见分隔符
    const separators = [',', ';', '|', '\n'];

    for (const sep of separators) {
      if (value.includes(sep)) {
        return value
          .split(sep)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
    }

    // 没有分隔符，返回单个URL
    return [value];
  }

  /**
   * 检测URL分隔符
   */
  private detectUrlSeparator(samples: string[]): string {
    const separators = [',', ';', '|', '\n'];
    const separatorCounts: Record<string, number> = {};

    for (const sample of samples.slice(0, 10)) {
      // 只检查前10个样本
      const str = String(sample);
      for (const sep of separators) {
        if (str.includes(sep)) {
          separatorCounts[sep] = (separatorCounts[sep] || 0) + 1;
        }
      }
    }

    // 返回最常见的分隔符，默认逗号
    if (Object.keys(separatorCounts).length === 0) {
      return ',';
    }

    const mostCommon = Object.entries(separatorCounts).sort((a, b) => b[1] - a[1])[0];

    return mostCommon[0];
  }

  /**
   * 分析单个 URL 或路径
   */
  private analyzeUrlOrPath(value: string): {
    isLink: boolean;
    isFile: boolean;
    isRemote: boolean;
    fileType?: string;
    extension?: string;
  } | null {
    if (!value || value.length === 0) return null;

    const isRemoteUrl = /^https?:\/\//i.test(value);
    const isLocalPath = this.isLocalPath(value);

    if (!isRemoteUrl && !isLocalPath) {
      return null;
    }

    // 提取文件扩展名
    const extMatch = value.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/i);
    const extension = extMatch ? extMatch[1].toLowerCase() : undefined;

    let fileType: string | undefined;
    let isFile = false;

    if (extension) {
      fileType = this.getFileTypeFromExtension(extension) || undefined;
      isFile = !!fileType;
    }

    return {
      isLink: isRemoteUrl || isLocalPath,
      isFile,
      isRemote: isRemoteUrl,
      fileType,
      extension,
    };
  }

  /**
   * 判断是否是本地路径
   */
  private isLocalPath(value: string): boolean {
    // Windows 路径: C:\, D:\, \\network\
    if (/^[A-Za-z]:\\/.test(value) || /^\\\\/.test(value)) {
      return true;
    }

    // Unix/Linux/Mac 绝对路径: /home, /usr, /var 等
    if (/^\/[a-zA-Z]/.test(value)) {
      return true;
    }

    // 相对路径（包含 ./ 或 ../）
    if (/^\.\.?\//.test(value)) {
      return true;
    }

    return false;
  }

  /**
   * 根据扩展名获取文件类型
   */
  private getFileTypeFromExtension(ext: string): string | null {
    const fileTypeMap: Record<string, string[]> = {
      image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif'],
      document: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
      video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v'],
      audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
    };

    for (const [type, extensions] of Object.entries(fileTypeMap)) {
      if (extensions.includes(ext)) {
        return type;
      }
    }

    return null;
  }

  /**
   * 获取最常见的文件类型
   */
  private getMostCommonType(types: string[]): string {
    if (types.length === 0) return 'document';

    const counts: Record<string, number> = {};
    for (const type of types) {
      counts[type] = (counts[type] || 0) + 1;
    }

    let maxType = 'document';
    let maxCount = 0;
    for (const [type, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        maxType = type;
      }
    }

    return maxType;
  }
}
