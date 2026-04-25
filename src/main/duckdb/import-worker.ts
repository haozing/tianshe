/**
 * 统一导入Worker - 支持CSV、XLSX、XLS、JSON格式
 */

import { parentPort, workerData } from 'worker_threads';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import type { ImportTask } from './types';
import { detectFileType, cleanupTempFile, getTempFilePath, parseRows } from './utils';

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
  } catch (error: any) {
    console.error('Import worker error:', error);
    parentPort?.postMessage({
      type: 'error',
      error: error.message || 'Unknown error during import',
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

/**
 * 导入CSV
 */
async function importCSV(conn: DuckDBConnection, filePath: string): Promise<void> {
  // Encoding priority: common encodings first
  const encodingHint = await detectEncodingHint(filePath);
  const encodings = buildEncodingCandidates(encodingHint, [
    'utf-8',
    'gb18030',
    'gbk',
    'utf-16',
    'windows-1252',
    'latin-1',
  ]);

  const fileSizeBytes = await safeGetFileSize(filePath);
  const defaultIgnoreErrors = fileSizeBytes >= CSV_LARGE_FILE_BYTES;

  let success = false;
  let lastError: Error | null = null;
  let selectedEncoding = '';
  let transcodeTempPath: string | null = null;
  const delimiterHint = await detectDelimiterFromFile(filePath);
  const skipRows = await detectCsvSkipRows(filePath);

  const tryImportWithFallback = async (sourcePath: string, encoding: string) => {
    try {
      return await importCSVWithEncoding(
        conn,
        sourcePath,
        encoding,
        delimiterHint,
        defaultIgnoreErrors,
        skipRows
      );
    } catch (error) {
      if (defaultIgnoreErrors) {
        throw error;
      }
      if (!shouldRetryWithIgnoreErrors(error)) {
        throw error;
      }

      console.warn(`CSV parse failed with encoding ${encoding}, retrying with ignore_errors=true`);
      try {
        await conn.run('DROP TABLE IF EXISTS data');
      } catch {
        /* intentionally empty */
      }

      return await importCSVWithEncoding(conn, sourcePath, encoding, delimiterHint, true, skipRows);
    }
  };

  for (const encoding of encodings) {
    try {
      const attemptIndex = encodings.indexOf(encoding);
      parentPort?.postMessage({
        type: 'progress',
        progress: 20 + attemptIndex * 5,
        message: `Trying encoding: ${encoding}...`,
      });

      const stopHeartbeat = startProgressHeartbeat({
        progress: 25 + attemptIndex * 5,
        intervalMs: 5000,
        message: `Importing CSV (${encoding}${defaultIgnoreErrors ? ', ignore_errors=true' : ''})...`,
      });

      const importResult = await (async () => {
        try {
          return await tryImportWithFallback(filePath, encoding);
        } finally {
          stopHeartbeat();
        }
      })();
      if (importResult.hasGarbledText) {
        console.warn(`Encoding ${encoding} produced garbled text, trying next...`);
        parentPort?.postMessage({
          type: 'progress',
          progress: 20 + attemptIndex * 5,
          message: `Encoding ${encoding} not suitable, continuing...`,
        });
        continue;
      }

      selectedEncoding = encoding;
      success = true;
      break;
    } catch (err) {
      lastError = err as Error;
      console.warn(`Encoding ${encoding} import failed:`, (err as Error).message);
      try {
        await conn.run('DROP TABLE IF EXISTS data');
      } catch {
        /* intentionally empty */
      }
    }
  }

  if (!success) {
    try {
      parentPort?.postMessage({
        type: 'progress',
        progress: 45,
        message: 'Attempting UTF-8 transcoding...',
      });

      const transcodeResult = await transcodeCsvToUtf8(filePath);
      transcodeTempPath = transcodeResult.tempFilePath;

      const stopHeartbeat = startProgressHeartbeat({
        progress: 45,
        intervalMs: 5000,
        message: `Importing transcoded CSV (utf-8, from ${transcodeResult.sourceEncoding})...`,
      });

      const importResult = await (async () => {
        try {
          return await tryImportWithFallback(transcodeTempPath, 'utf-8');
        } finally {
          stopHeartbeat();
        }
      })();
      if (importResult.hasGarbledText) {
        lastError = new Error(
          `Transcoded UTF-8 still garbled (source: ${transcodeResult.sourceEncoding})`
        );
      } else {
        selectedEncoding = `utf-8 (transcoded from ${transcodeResult.sourceEncoding})`;
        success = true;
      }
    } catch (err) {
      lastError = err as Error;
      try {
        await conn.run('DROP TABLE IF EXISTS data');
      } catch {
        /* intentionally empty */
      }
    } finally {
      if (transcodeTempPath) {
        await cleanupTempFile(transcodeTempPath);
      }
    }
  }

  if (!success) {
    const errorMsg = lastError
      ? `Unable to import CSV after trying all encodings. Last error: ${lastError.message}`
      : 'Unable to import CSV after trying all encodings.';
    throw new Error(errorMsg);
  }

  parentPort?.postMessage({
    type: 'progress',
    progress: 50,
    message: `CSV read complete (encoding: ${selectedEncoding})`,
  });
}

async function importCSVWithEncoding(
  conn: DuckDBConnection,
  filePath: string,
  encoding: string,
  delimiterHint?: string | null,
  ignoreErrors = false,
  skipRows = 0
): Promise<{ hasGarbledText: boolean }> {
  const escapedPath = escapeSqlString(filePath);
  const delimiterValue = delimiterHint ? normalizeDelimiterForSql(delimiterHint) : null;
  const options = [
    'header=true',
    `skip=${skipRows}`,
    'sample_size=100000',
    'auto_detect=true',
    `encoding='${escapeSqlString(encoding)}'`,
    `ignore_errors=${ignoreErrors ? 'true' : 'false'}`,
    "quote='\"'",
    "escape='\"'",
    'strict_mode=false',
    'null_padding=true',
    'all_varchar=true',
    'parallel=false',
    'max_line_size=10000000',
  ];

  if (delimiterValue) {
    options.splice(3, 0, `delim='${escapeSqlString(delimiterValue)}'`);
  }

  await conn.run(`
    CREATE TABLE data AS
    SELECT
      *,
      ROW_NUMBER() OVER () AS _row_id,
      now() AS created_at,
      now() AS updated_at
    FROM read_csv_auto('${escapedPath}',
      ${options.join(',\n      ')}
    )
  `);

  // Validate data quality: check for garbled text
  const sampleResult = await conn.runAndReadAll('SELECT * FROM data LIMIT 10');
  const rows = parseRows(sampleResult);
  const columnNames = sampleResult.columnNames();
  const userColumns = columnNames.filter((name) => !SYSTEM_COLUMNS.has(name));

  if (
    rows.length === 0 &&
    userColumns.length > 0 &&
    userColumns.every((name) => /^column\d+$/i.test(name))
  ) {
    await conn.run('DROP TABLE IF EXISTS data');
    return { hasGarbledText: true };
  }

  let hasGarbledText = false;
  if (rows.length > 0) {
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') {
          // Detect replacement character or control characters
          // eslint-disable-next-line no-control-regex
          if (/[\uFFFD]/.test(value) || /[\x00-\x08\x0B-\x0C\x0E-\x1F]/.test(value)) {
            hasGarbledText = true;
            break;
          }
        }
      }
      if (hasGarbledText) break;
    }
  }

  if (hasGarbledText) {
    await conn.run('DROP TABLE IF EXISTS data');
    return { hasGarbledText: true };
  }

  // Create sequence and set _row_id PK
  const countResult = await conn.runAndReadAll('SELECT COUNT(*) as count FROM data');
  const rowCount = Number(parseRows(countResult)[0].count);

  if (rowCount === 0) {
    const hasDataLines = await hasMultipleNonEmptyLines(filePath);
    if (hasDataLines) {
      console.warn('Empty import; treating as encoding/dialect mismatch.');
      await conn.run('DROP TABLE IF EXISTS data');
      return { hasGarbledText: true };
    }
  }

  await conn.run(`CREATE SEQUENCE seq_data_row_id START ${rowCount + 1} INCREMENT 1`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET DEFAULT nextval('seq_data_row_id')`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET NOT NULL`);

  // NOTE: VIEW is created after type optimization

  return { hasGarbledText: false };
}

const TRANSCODE_SAMPLE_BYTES = 64 * 1024;
const SYSTEM_COLUMNS = new Set(['_row_id', 'created_at', 'updated_at']);
const CSV_LARGE_FILE_BYTES = 10 * 1024 * 1024;
const DELIMITER_CANDIDATES: Array<{ delimiter: string; byte: number }> = [
  { delimiter: ',', byte: 0x2c },
  { delimiter: '\t', byte: 0x09 },
  { delimiter: ';', byte: 0x3b },
  { delimiter: '|', byte: 0x7c },
];

function startProgressHeartbeat(options: {
  progress: number;
  intervalMs: number;
  message: string;
}): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = formatDuration(Date.now() - start);
    parentPort?.postMessage({
      type: 'progress',
      progress: Math.min(49, options.progress),
      message: `${options.message} (${elapsed})`,
    });
  }, options.intervalMs);

  return () => clearInterval(timer);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m${seconds}s`;
}

async function safeGetFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function normalizeDelimiterForSql(delimiter: string): string {
  if (delimiter === '\t') return '\t';
  if (delimiter === '\r') return '\r';
  if (delimiter === '\n') return '\n';
  return delimiter;
}

function shouldRetryWithIgnoreErrors(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('CSV Error') ||
    message.includes('Invalid unicode') ||
    message.includes('not utf-8 encoded') ||
    message.includes('CSV parsing dialect')
  );
}

async function detectDelimiterFromFile(filePath: string): Promise<string | null> {
  try {
    const sample = await readFileSample(filePath, TRANSCODE_SAMPLE_BYTES);
    return guessDelimiterFromSample(sample);
  } catch (error) {
    console.warn('Failed to detect CSV delimiter:', error);
    return null;
  }
}

async function hasMultipleNonEmptyLines(filePath: string): Promise<boolean> {
  try {
    const sample = await readFileSample(filePath, TRANSCODE_SAMPLE_BYTES);
    const lines = getSampleLines(sample, 10);
    let nonEmpty = 0;
    for (const line of lines) {
      if (trimAscii(line).length > 0) {
        nonEmpty += 1;
        if (nonEmpty >= 2) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    console.warn('Failed to inspect CSV lines:', error);
    return false;
  }
}

async function detectEncodingHint(filePath: string): Promise<string | null> {
  try {
    const sample = await readFileSample(filePath, TRANSCODE_SAMPLE_BYTES);
    const encoding = detectEncodingFromSample(sample);
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
      return 'utf-16';
    }
    return encoding;
  } catch (error) {
    console.warn('Failed to detect CSV encoding hint:', error);
    return null;
  }
}

function buildEncodingCandidates(preferred: string | null, defaults: string[]): string[] {
  const candidates = preferred ? [preferred, ...defaults] : defaults;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

function guessDelimiterFromSample(sample: Buffer): string | null {
  const lines = getSampleLines(sample, 10);
  for (const line of lines) {
    const trimmed = trimAscii(line);
    if (!trimmed.length) continue;
    const sepDirective = parseSepDirective(trimmed);
    if (sepDirective) return sepDirective;
  }

  const counts = new Map<string, number>();
  for (const candidate of DELIMITER_CANDIDATES) {
    counts.set(candidate.delimiter, 0);
  }

  for (const line of lines) {
    const trimmed = trimAscii(line);
    if (!trimmed.length) continue;
    for (const candidate of DELIMITER_CANDIDATES) {
      const current = counts.get(candidate.delimiter) || 0;
      counts.set(candidate.delimiter, current + countByte(trimmed, candidate.byte));
    }
  }

  let bestDelimiter: string | null = null;
  let bestCount = 0;
  for (const [delimiter, count] of counts.entries()) {
    if (count > bestCount) {
      bestDelimiter = delimiter;
      bestCount = count;
    }
  }

  return bestCount > 0 ? bestDelimiter : null;
}

function getSampleLines(sample: Buffer, maxLines: number): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < sample.length && lines.length < maxLines; i += 1) {
    if (sample[i] === 0x0a) {
      let end = i;
      if (end > start && sample[end - 1] === 0x0d) {
        end -= 1;
      }
      lines.push(sample.subarray(start, end));
      start = i + 1;
    }
  }

  if (lines.length < maxLines && start < sample.length) {
    lines.push(sample.subarray(start));
  }

  return lines;
}

function trimAscii(buffer: Buffer): Buffer {
  let start = 0;
  let end = buffer.length;

  while (start < end && isAsciiWhitespace(buffer[start])) {
    start += 1;
  }
  while (end > start && isAsciiWhitespace(buffer[end - 1])) {
    end -= 1;
  }

  return buffer.subarray(start, end);
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function parseSepDirective(line: Buffer): string | null {
  let start = 0;
  if (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
    start = 3;
  }
  if (line.length - start < 5) return null;
  const prefix = line
    .subarray(start, start + 4)
    .toString('ascii')
    .toLowerCase();
  if (prefix !== 'sep=') return null;
  return String.fromCharCode(line[start + 4]);
}

function countByte(buffer: Buffer, byte: number): number {
  let count = 0;
  for (const value of buffer.values()) {
    if (value === byte) count += 1;
  }
  return count;
}

function escapeSqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

async function transcodeCsvToUtf8(
  filePath: string
): Promise<{ tempFilePath: string; sourceEncoding: string }> {
  const sample = await readFileSample(filePath, TRANSCODE_SAMPLE_BYTES);
  const sourceEncoding = detectEncodingFromSample(sample);
  const tempFilePath = getTempFilePath(filePath, '.utf8.csv');

  await fs.ensureDir(path.dirname(tempFilePath));

  const decoder = new TextDecoder(sourceEncoding);
  let isFirstChunk = true;

  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath);
    const writeStream = fs.createWriteStream(tempFilePath, { encoding: 'utf-8' });

    const handleError = (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      readStream.destroy(err);
      writeStream.destroy(err);
      reject(err);
    };

    readStream.on('data', (chunk) => {
      try {
        let text = decoder.decode(chunk as Buffer, { stream: true });
        if (isFirstChunk) {
          text = stripBom(text);
          isFirstChunk = false;
        }
        if (text.length > 0) {
          writeStream.write(text);
        }
      } catch (error) {
        handleError(error);
      }
    });

    readStream.on('end', () => {
      try {
        let text = decoder.decode();
        if (isFirstChunk) {
          text = stripBom(text);
          isFirstChunk = false;
        }
        if (text.length > 0) {
          writeStream.write(text);
        }
        writeStream.end();
      } catch (error) {
        handleError(error);
      }
    });

    readStream.on('error', handleError);
    writeStream.on('error', handleError);
    writeStream.on('finish', () => resolve());
  });

  return { tempFilePath, sourceEncoding };
}

async function readFileSample(filePath: string, maxBytes: number): Promise<Buffer> {
  const fd = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fs.read(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fs.close(fd);
  }
}

async function detectCsvSkipRows(filePath: string): Promise<number> {
  try {
    const sample = await readFileSample(filePath, TRANSCODE_SAMPLE_BYTES);
    const lines = getSampleLines(sample, 20);
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = trimAscii(lines[index]);
      if (!trimmed.length) continue;
      const sep = parseSepDirective(trimmed);
      if (sep) return index + 1;
      return 0;
    }
    return 0;
  } catch (error) {
    console.warn('Failed to detect CSV preamble lines:', error);
    return 0;
  }
}

function detectEncodingFromSample(sample: Buffer): string {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf-8';
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return 'utf-16le';
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return 'utf-16be';
  }

  const utf16ByNulls = detectUtf16ByNulls(sample);
  if (utf16ByNulls) {
    return utf16ByNulls;
  }

  if (isValidUtf8(sample)) {
    return 'utf-8';
  }

  return 'gb18030';
}

function detectUtf16ByNulls(sample: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (sample.length < 4) return null;

  const limit = Math.min(sample.length, 1024);
  let evenNulls = 0;
  let oddNulls = 0;
  const evenCount = Math.ceil(limit / 2);
  const oddCount = Math.floor(limit / 2);

  for (let i = 0; i < limit; i += 2) {
    if (sample[i] === 0x00) evenNulls += 1;
  }
  for (let i = 1; i < limit; i += 2) {
    if (sample[i] === 0x00) oddNulls += 1;
  }

  const evenRatio = evenCount > 0 ? evenNulls / evenCount : 0;
  const oddRatio = oddCount > 0 ? oddNulls / oddCount : 0;

  if (evenRatio > 0.3 || oddRatio > 0.3) {
    return evenRatio > oddRatio ? 'utf-16be' : 'utf-16le';
  }

  return null;
}

function isValidUtf8(sample: Buffer): boolean {
  let i = 0;
  while (i < sample.length) {
    const byte1 = sample[i];
    if (byte1 <= 0x7f) {
      i += 1;
      continue;
    }

    let bytesNeeded = 0;
    if (byte1 >= 0xc2 && byte1 <= 0xdf) {
      bytesNeeded = 1;
    } else if (byte1 >= 0xe0 && byte1 <= 0xef) {
      bytesNeeded = 2;
    } else if (byte1 >= 0xf0 && byte1 <= 0xf4) {
      bytesNeeded = 3;
    } else {
      return false;
    }

    if (i + bytesNeeded >= sample.length) {
      return true;
    }

    for (let j = 1; j <= bytesNeeded; j += 1) {
      const byte = sample[i + j];
      if ((byte & 0xc0) !== 0x80) {
        return false;
      }
    }

    i += bytesNeeded + 1;
  }

  return true;
}

function stripBom(text: string): string {
  if (!text) return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/**
 * 导入XLSX
 */

/**
 * 导入 JSON（支持 JSON 数组/NDJSON）
 */
async function importJSON(conn: DuckDBConnection, filePath: string): Promise<void> {
  const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

  parentPort?.postMessage({
    type: 'progress',
    progress: 20,
    message: '读取JSON文件...',
  });

  await conn.run(`
    CREATE TABLE data AS
    SELECT
      *,
      ROW_NUMBER() OVER () AS _row_id,
      now() AS created_at,
      now() AS updated_at
    FROM read_json_auto('${escapedPath}',
      format='auto'
    )
  `);

  // 创建序列和设置_row_id 主键
  const countResult = await conn.runAndReadAll('SELECT COUNT(*) as count FROM data');
  const rowCount = Number(parseRows(countResult)[0].count);

  await conn.run(`CREATE SEQUENCE seq_data_row_id START ${rowCount + 1} INCREMENT 1`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET DEFAULT nextval('seq_data_row_id')`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET NOT NULL`);

  parentPort?.postMessage({
    type: 'progress',
    progress: 50,
    message: 'JSON数据读取完成',
  });
}

async function importXLSX(conn: DuckDBConnection, filePath: string): Promise<void> {
  await conn.run('INSTALL excel');
  await conn.run('LOAD excel');

  parentPort?.postMessage({
    type: 'progress',
    progress: 20,
    message: '读取Excel文件...',
  });

  const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

  await conn.run(`
    CREATE TABLE data AS
    SELECT
      *,
      ROW_NUMBER() OVER () AS _row_id,
      now() AS created_at,
      now() AS updated_at
    FROM read_xlsx('${escapedPath}',
      header=true,
      ignore_errors=false
    )
  `);

  // 🆕 创建序列和设置 _row_id 主键
  const countResult = await conn.runAndReadAll('SELECT COUNT(*) as count FROM data');
  const rowCount = Number(parseRows(countResult)[0].count);

  await conn.run(`CREATE SEQUENCE seq_data_row_id START ${rowCount + 1} INCREMENT 1`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET DEFAULT nextval('seq_data_row_id')`);
  await conn.run(`ALTER TABLE data ALTER COLUMN _row_id SET NOT NULL`);

  // ⚠️ 不在这里创建 VIEW
  // VIEW 将在类型优化后创建，确保使用优化后的 schema

  parentPort?.postMessage({
    type: 'progress',
    progress: 50,
    message: 'Excel数据读取完成',
  });
}

/**
 * 获取基础 schema（只包含列名和 DuckDB 物理类型）
 */
async function getBasicSchema(conn: DuckDBConnection, tableName: string) {
  const result = await conn.runAndReadAll(`DESCRIBE ${tableName}`);
  const rows = parseRows(result);

  return rows.map((row: any) => ({
    name: row.column_name,
    duckdbType: row.column_type,
    fieldType: mapDuckDBTypeToFieldType(row.column_type),
    nullable: true,
    metadata: {},
    storageMode: 'physical',
  }));
}

/**
 * DuckDB 类型到业务字段类型的简单映射
 */
function mapDuckDBTypeToFieldType(duckdbType: string): string {
  const upperType = duckdbType.toUpperCase();

  if (
    upperType.includes('INT') ||
    upperType.includes('DOUBLE') ||
    upperType.includes('FLOAT') ||
    upperType.includes('DECIMAL') ||
    upperType.includes('NUMERIC')
  ) {
    return 'number';
  }

  if (upperType.includes('DATE') || upperType.includes('TIMESTAMP') || upperType.includes('TIME')) {
    return 'date';
  }

  if (upperType === 'BOOLEAN') {
    return 'boolean';
  }

  return 'text';
}

/**
 * 智能分析列类型并生成转换方案
 */
async function analyzeColumnTypes(
  conn: DuckDBConnection,
  tableName: string,
  basicSchema: any[],
  rowCount: number
): Promise<{
  finalSchema: any[];
  conversions: Array<{
    columnName: string;
    fromType: string;
    toType: string;
    reason: string;
  }>;
}> {
  const finalSchema = [];
  const conversions = [];

  for (const column of basicSchema) {
    const columnName = column.name;
    const duckdbType = column.duckdbType;

    // 采样数据进行分析（最多1000行）
    const sampleSize = Math.min(rowCount, 1000);
    const escapedColumnName = `"${columnName.replace(/"/g, '""')}"`;

    try {
      const sampleResult = await conn.runAndReadAll(
        `SELECT ${escapedColumnName} FROM ${tableName}
         WHERE ${escapedColumnName} IS NOT NULL
         LIMIT ${sampleSize}`
      );
      const rows = parseRows(sampleResult);
      const values = rows.map((row) => row[columnName]);

      // 智能推断字段类型
      const analysis = inferFieldType(columnName, duckdbType, values);

      // 检查是否需要类型转换
      if (analysis.suggestedDuckDBType && analysis.suggestedDuckDBType !== duckdbType) {
        conversions.push({
          columnName: columnName,
          fromType: duckdbType,
          toType: analysis.suggestedDuckDBType,
          reason: analysis.metadata.inferredReason || '智能类型优化',
        });

        finalSchema.push({
          name: columnName,
          duckdbType: analysis.suggestedDuckDBType,
          fieldType: analysis.fieldType,
          nullable: column.nullable,
          metadata: analysis.metadata,
          storageMode: 'physical',
        });
      } else {
        finalSchema.push({
          ...column,
          fieldType: analysis.fieldType,
          metadata: {
            ...column.metadata,
            ...analysis.metadata,
          },
        });
      }
    } catch (error) {
      // 如果采样失败，保持原类型
      console.warn(`Failed to analyze column "${columnName}":`, error);
      finalSchema.push(column);
    }
  }

  return { finalSchema, conversions };
}

/**
 * 使用CREATE TABLE AS SELECT优化表结构
 * 一次性转换所有需要修改的列
 */
async function optimizeTableStructure(
  conn: DuckDBConnection,
  tableName: string,
  conversions: Array<{ columnName: string; fromType: string; toType: string; reason: string }>,
  allColumns: any[]
): Promise<void> {
  try {
    // 保持原始列顺序（用户列在前，系统字段在后）
    const selectColumns = allColumns
      .map((col) => {
        const conversion = conversions.find((c) => c.columnName === col.name);
        const escapedName = `"${col.name.replace(/"/g, '""')}"`;

        if (conversion) {
          // 需要转换的列：使用CAST语法，并添加错误处理
          return `TRY_CAST(${escapedName} AS ${conversion.toType}) AS ${escapedName}`;
        } else {
          // 不需要转换的列：直接保留
          return escapedName;
        }
      })
      .join(',\n  ');

    // 创建优化后的新表
    await conn.run(`
      CREATE TABLE data_optimized AS
      SELECT
        ${selectColumns}
      FROM ${tableName}
    `);

    // 删除原表
    await conn.run(`DROP TABLE ${tableName}`);

    // 重命名新表
    await conn.run(`ALTER TABLE data_optimized RENAME TO ${tableName}`);
  } catch (error) {
    console.error('❌ Failed to optimize table structure:', error);

    // 清理可能创建的临时表
    try {
      await conn.run('DROP TABLE IF EXISTS data_optimized');
    } catch {
      /* intentionally empty */
    }

    // 抛出错误，让调用者处理
    throw new Error(`类型优化失败: ${(error as Error).message}`);
  }
}

/**
 * 智能推断字段类型（包含DuckDB物理类型转换建议）
 */
function inferFieldType(
  columnName: string,
  duckdbType: string,
  values: any[]
): {
  fieldType: string;
  metadata: any;
  suggestedDuckDBType?: string;
} {
  if (values.length === 0) {
    return {
      fieldType: mapDuckDBTypeToFieldType(duckdbType),
      metadata: {},
    };
  }

  const upperType = duckdbType.toUpperCase();
  const lowerColumnName = columnName.toLowerCase();

  // 1. 如果DuckDB已经识别为数值类型，检查是否应该是文本
  if (upperType.includes('INT') || upperType.includes('BIGINT')) {
    // 检查是否是ID类型（前导0、特定命名）
    if (looksLikeId(lowerColumnName, values)) {
      return {
        fieldType: 'text',
        suggestedDuckDBType: 'VARCHAR',
        metadata: {
          inferredReason: 'ID字段（有前导0或特定命名模式）',
          originalDuckDBType: duckdbType,
        },
      };
    }

    // 检查是否是电话号码
    if (looksLikePhoneNumber(lowerColumnName, values)) {
      return {
        fieldType: 'text',
        suggestedDuckDBType: 'VARCHAR',
        metadata: {
          inferredReason: '电话号码',
          originalDuckDBType: duckdbType,
        },
      };
    }
  }

  // 2. 如果DuckDB识别为VARCHAR，检查是否应该是数值
  if (upperType.includes('VARCHAR') || upperType.includes('TEXT')) {
    // 检查是否所有值都是数字字符串
    const numericCheck = analyzeNumericStrings(values);

    // 放宽条件：只要95%以上是数字就转换（允许少量异常值）
    if (numericCheck.percentage > 0.95) {
      if (numericCheck.hasDecimals) {
        return {
          fieldType: 'number',
          suggestedDuckDBType: 'DOUBLE',
          metadata: {
            inferredReason: `${(numericCheck.percentage * 100).toFixed(1)}%的值是数字（含小数）`,
            originalDuckDBType: duckdbType,
          },
        };
      } else {
        return {
          fieldType: 'number',
          suggestedDuckDBType: 'BIGINT',
          metadata: {
            inferredReason: `${(numericCheck.percentage * 100).toFixed(1)}%的值是整数`,
            originalDuckDBType: duckdbType,
          },
        };
      }
    }

    // 检查是否是日期字符串
    if (looksLikeDate(values)) {
      return {
        fieldType: 'date',
        suggestedDuckDBType: 'TIMESTAMP',
        metadata: {
          inferredReason: '日期格式字符串',
          originalDuckDBType: duckdbType,
        },
      };
    }

    // URL和Email保持为VARCHAR（不需要转换）
    if (looksLikeUrl(lowerColumnName, values)) {
      return {
        fieldType: 'url',
        metadata: {
          inferredReason: 'URL链接',
          originalDuckDBType: duckdbType,
        },
      };
    }

    if (looksLikeEmail(lowerColumnName, values)) {
      return {
        fieldType: 'email',
        metadata: {
          inferredReason: '邮箱地址',
          originalDuckDBType: duckdbType,
        },
      };
    }
  }

  // 3. 默认使用DuckDB的类型映射（不转换）
  return {
    fieldType: mapDuckDBTypeToFieldType(duckdbType),
    metadata: {},
  };
}

/**
 * 检查是否看起来像ID字段
 */
function looksLikeId(columnName: string, values: any[]): boolean {
  // 列名包含id
  const hasIdInName = /\bid\b|编号|序号|code|num/.test(columnName);

  // 检查是否有前导0
  const hasLeadingZeros = values.some((v) => {
    const str = String(v);
    return str.length > 1 && str.startsWith('0');
  });

  return hasIdInName || hasLeadingZeros;
}

/**
 * 检查是否看起来像电话号码
 */
function looksLikePhoneNumber(columnName: string, values: any[]): boolean {
  // 列名包含电话相关关键字
  const hasPhoneInName = /phone|tel|手机|电话|mobile/.test(columnName);

  // 检查数值长度（中国手机号11位，固话7-8位）
  const lengthPattern = values.every((v) => {
    const str = String(v);
    return str.length >= 7 && str.length <= 15;
  });

  return hasPhoneInName && lengthPattern;
}

/**
 * 分析是否都是数字字符串
 */
function analyzeNumericStrings(values: any[]): {
  isNumeric: boolean;
  percentage: number;
  hasDecimals: boolean;
} {
  let numericCount = 0;
  let decimalCount = 0;

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;

    const str = String(value).trim();

    // 检查是否是数字（包括负数和小数）
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      numericCount++;
      if (str.includes('.')) {
        decimalCount++;
      }
    }
  }

  const total = values.filter((v) => v !== null && v !== undefined && v !== '').length;
  const percentage = total > 0 ? numericCount / total : 0;

  return {
    isNumeric: numericCount === total,
    percentage,
    hasDecimals: decimalCount > 0,
  };
}

/**
 * 检查是否看起来像日期
 */
function looksLikeDate(values: any[]): boolean {
  if (values.length === 0) return false;

  // 常见日期格式正则
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/, // 2024-01-01
    /^\d{4}\/\d{2}\/\d{2}$/, // 2024/01/01
    /^\d{2}\/\d{2}\/\d{4}$/, // 01/01/2024
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/, // 2024-01-01 12:00:00
  ];

  let matchCount = 0;
  for (const value of values.slice(0, 100)) {
    // 只检查前100个
    if (value === null || value === undefined) continue;
    const str = String(value).trim();

    if (datePatterns.some((pattern) => pattern.test(str))) {
      matchCount++;
    }
  }

  const sampleSize = Math.min(values.length, 100);
  return matchCount / sampleSize > 0.8; // 80%以上匹配
}

/**
 * 检查是否看起来像URL
 */
function looksLikeUrl(columnName: string, values: any[]): boolean {
  const hasUrlInName = /url|link|链接|网址/.test(columnName);

  const urlPattern = /^https?:\/\//i;
  const matchCount = values.filter((v) => {
    if (v === null || v === undefined) return false;
    return urlPattern.test(String(v));
  }).length;

  return hasUrlInName && matchCount / values.length > 0.8;
}

/**
 * 检查是否看起来像邮箱
 */
function looksLikeEmail(columnName: string, values: any[]): boolean {
  const hasEmailInName = /email|mail|邮箱/.test(columnName);

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const matchCount = values.filter((v) => {
    if (v === null || v === undefined) return false;
    return emailPattern.test(String(v));
  }).length;

  return hasEmailInName && matchCount / values.length > 0.8;
}

importFile().catch((error) => {
  console.error('Unhandled error in import worker:', error);
  parentPort?.postMessage({
    type: 'error',
    error: error.message || 'Unhandled error',
  });
});
