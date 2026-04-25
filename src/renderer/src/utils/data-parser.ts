/**
 * 数据解析器 - 解析粘贴的CSV/TSV/JSON数据
 *
 * 支持的格式：
 * - JSON数组：[{"列名": "值"}, ...]
 * - CSV：逗号分隔
 * - TSV：制表符分隔（Excel复制粘贴）
 * - 竖线分隔：|
 */

export interface ParseResult {
  success: boolean;
  data: Record<string, any>[];
  error?: string;
  format?: 'csv' | 'tsv' | 'json' | 'pipe' | 'unknown';
  rowCount?: number;
}

export class DataParser {
  /**
   * 自动检测格式并解析
   * @param text 粘贴的文本内容
   * @param expectedColumns 期望的列名数组（可选，用于验证）
   */
  static parse(text: string, expectedColumns?: string[]): ParseResult {
    if (!text || !text.trim()) {
      return {
        success: false,
        data: [],
        error: '没有输入数据',
      };
    }

    // 1. 尝试JSON格式
    const jsonResult = this.parseJSON(text);
    if (jsonResult.success) {
      return this.validateColumns(jsonResult, expectedColumns);
    }

    // 2. 检测分隔符（CSV/TSV/Pipe）
    const delimiter = this.detectDelimiter(text);
    const delimitedResult = this.parseDelimited(text, delimiter, expectedColumns);

    return this.validateColumns(delimitedResult, expectedColumns);
  }

  /**
   * 解析JSON格式
   */
  private static parseJSON(text: string): ParseResult {
    try {
      const trimmed = text.trim();
      const parsed = JSON.parse(trimmed);

      // 处理数组格式
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          return {
            success: false,
            data: [],
            error: 'JSON数组为空',
          };
        }

        // 验证数组元素都是对象
        if (!parsed.every((item) => typeof item === 'object' && item !== null)) {
          return {
            success: false,
            data: [],
            error: 'JSON数组中的元素必须是对象',
          };
        }

        return {
          success: true,
          data: parsed,
          format: 'json',
          rowCount: parsed.length,
        };
      }

      // 处理单个对象
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          success: true,
          data: [parsed],
          format: 'json',
          rowCount: 1,
        };
      }

      return {
        success: false,
        data: [],
        error: 'JSON格式无效，必须是对象或对象数组',
      };
    } catch (_error: any) {
      // 不是JSON格式，返回失败（但不报错，继续尝试其他格式）
      return {
        success: false,
        data: [],
        error: 'Not a valid JSON',
      };
    }
  }

  /**
   * 检测分隔符
   */
  private static detectDelimiter(text: string): string {
    const firstLine = text.split('\n')[0];

    // 检测制表符（TSV）- Excel粘贴通常是TSV
    const tabCount = (firstLine.match(/\t/g) || []).length;
    if (tabCount > 0) {
      return '\t';
    }

    // 检测逗号（CSV）
    const commaCount = (firstLine.match(/,/g) || []).length;
    if (commaCount > 0) {
      return ',';
    }

    // 检测竖线
    const pipeCount = (firstLine.match(/\|/g) || []).length;
    if (pipeCount > 0) {
      return '|';
    }

    // 默认制表符
    return '\t';
  }

  /**
   * 解析分隔符分隔的数据
   */
  private static parseDelimited(
    text: string,
    delimiter: string,
    expectedColumns?: string[]
  ): ParseResult {
    try {
      const rows = this.parseDelimitedRows(text, delimiter);
      if (rows.length === 0) {
        return {
          success: false,
          data: [],
          error: '没有有效的数据行',
        };
      }

      const normalizedRows = rows.map((row, rowIndex) =>
        row.map((value, colIndex) => {
          let cleaned = value.trim();
          if (rowIndex === 0 && colIndex === 0) {
            cleaned = cleaned.replace(/^\ufeff/, '');
          }
          return cleaned;
        })
      );

      // 第一行作为列名（或使用期望的列名）
      const firstLineParts = normalizedRows[0];

      // 判断第一行是否为表头
      const hasHeader = this.looksLikeHeader(
        firstLineParts,
        normalizedRows.slice(1),
        expectedColumns
      );

      let headers: string[];
      let dataStartIndex: number;

      if (hasHeader) {
        headers = firstLineParts;
        dataStartIndex = 1;
      } else if (expectedColumns && expectedColumns.length > 0) {
        // 没有表头但提供了期望的列名
        headers = expectedColumns;
        dataStartIndex = 0;
      } else {
        // 没有表头也没有期望的列名，使用第一行数据的列数生成列名
        headers = firstLineParts.map((_, i) => `列${i + 1}`);
        dataStartIndex = 0;
      }

      // 解析数据行
      const data: Record<string, any>[] = [];

      for (let i = dataStartIndex; i < normalizedRows.length; i++) {
        const values = normalizedRows[i] || [];
        const row: Record<string, any> = {};

        headers.forEach((col, index) => {
          const value = values[index] ?? '';

          // 智能类型转换
          row[col] = this.smartConvertValue(value);
        });

        data.push(row);
      }

      if (data.length === 0) {
        return {
          success: false,
          data: [],
          error: '没有数据行（只有表头）',
        };
      }

      const formatName = delimiter === '\t' ? 'tsv' : delimiter === ',' ? 'csv' : 'pipe';

      return {
        success: true,
        data,
        format: formatName as 'csv' | 'tsv' | 'pipe',
        rowCount: data.length,
      };
    } catch (error: any) {
      return {
        success: false,
        data: [],
        error: `解析失败: ${error.message}`,
      };
    }
  }

  /**
   * 判断第一行是否看起来像表头
   */
  private static looksLikeHeader(
    firstLineParts: string[],
    dataRows: string[][],
    expectedColumns?: string[]
  ): boolean {
    if (expectedColumns && expectedColumns.length > 0) {
      const normalize = (value: string) => value.trim().replace(/^\ufeff/, '').toLowerCase();
      const normalizedFirst = firstLineParts.map(normalize);
      const normalizedExpected = expectedColumns.map(normalize);

      // 列数明显不足时，优先按“有表头但缺列”处理，让后续缺列校验给出明确错误
      if (normalizedFirst.length < normalizedExpected.length) {
        return true;
      }

      const exactMatch =
        normalizedFirst.length === normalizedExpected.length &&
        normalizedFirst.every((value, index) => value === normalizedExpected[index]);
      if (exactMatch) return true;

      const containsAllExpected = normalizedExpected.every((column) =>
        normalizedFirst.includes(column)
      );
      if (containsAllExpected) return true;

      // 提供了期望列但首行不匹配时，按“无表头”处理，避免误丢第一行数据
      return false;
    }

    if (dataRows.length === 0) return true;

    // 检查第一行是否包含数字（表头通常不全是数字）
    const firstLineHasNumbers = firstLineParts.some(
      (part) => !isNaN(Number(part)) && part.trim() !== ''
    );

    // 检查第二行
    const secondLineParts = dataRows[0] || [];
    const secondLineHasNumbers = secondLineParts.some(
      (part) => !isNaN(Number(part)) && part.trim() !== ''
    );

    // 如果第一行全是文字，第二行有数字，很可能第一行是表头
    if (!firstLineHasNumbers && secondLineHasNumbers) {
      return true;
    }

    // 如果列数不同，第一行可能是表头
    if (firstLineParts.length !== secondLineParts.length) {
      return true;
    }

    // 默认认为有表头
    return true;
  }

  /**
   * 解析分隔符文本，支持引号包裹字段与逗号。
   */
  private static parseDelimitedRows(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let rowHasDelimiter = false;
    let rowHasNonWhitespace = false;

    const pushRow = () => {
      const shouldPush = rowHasDelimiter || rowHasNonWhitespace || field.trim() !== '';
      if (shouldPush) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      rowHasDelimiter = false;
      rowHasNonWhitespace = false;
    };

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
          rowHasNonWhitespace = true;
          continue;
        }

        field += char;
        rowHasNonWhitespace = true;
        continue;
      }

      if (char === '"') {
        if (field.trim() === '') {
          field = '';
          inQuotes = true;
          rowHasNonWhitespace = true;
          continue;
        }
        field += char;
        rowHasNonWhitespace = true;
        continue;
      }

      if (char === delimiter) {
        row.push(field);
        field = '';
        rowHasDelimiter = true;
        continue;
      }

      if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') {
          i += 1;
        }
        pushRow();
        continue;
      }

      field += char;
      if (char.trim() !== '') {
        rowHasNonWhitespace = true;
      }
    }

    if (inQuotes) {
      // Unclosed quote: treat remaining content as part of the field.
      rowHasNonWhitespace = true;
    }
    const shouldPush = rowHasDelimiter || rowHasNonWhitespace || field.trim() !== '';
    if (shouldPush) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  /**
   * 智能类型转换
   */
  private static smartConvertValue(value: string): any {
    if (value === '' || value === null || value === undefined) {
      return '';
    }

    // 尝试转换为数字
    if (!isNaN(Number(value)) && value.trim() !== '') {
      // 排除前导零的情况（如电话号码、ID）
      if (value.startsWith('0') && value.length > 1 && !value.includes('.')) {
        return value; // 保持字符串
      }
      return Number(value);
    }

    // 尝试转换为布尔值
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'false') {
      return lower === 'true';
    }

    // 日期格式检测（简单版本）
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value; // 保持字符串，由后端处理
    }

    // 返回原始字符串
    return value;
  }

  /**
   * 验证列名是否匹配
   */
  private static validateColumns(result: ParseResult, expectedColumns?: string[]): ParseResult {
    if (!result.success || !expectedColumns || expectedColumns.length === 0) {
      return result;
    }

    // 检查解析出的数据是否包含期望的列
    if (result.data.length > 0) {
      const actualColumns = Object.keys(result.data[0]);
      const missingColumns = expectedColumns.filter((col) => !actualColumns.includes(col));

      if (missingColumns.length > 0) {
        return {
          ...result,
          success: false,
          error: `缺少以下列: ${missingColumns.join(', ')}\n\n提示：请确保粘贴的数据包含正确的列名，或包含所有必需的列。`,
        };
      }
    }

    return result;
  }

  /**
   * 格式化解析结果为友好的消息
   */
  static formatResultMessage(result: ParseResult): string {
    if (!result.success) {
      return result.error || '解析失败';
    }

    const formatNames = {
      json: 'JSON',
      csv: 'CSV（逗号分隔）',
      tsv: 'TSV（制表符分隔）',
      pipe: '竖线分隔',
      unknown: '未知格式',
    };

    const formatName = formatNames[result.format || 'unknown'];
    return `成功解析 ${formatName} 格式，共 ${result.rowCount} 条记录`;
  }
}
