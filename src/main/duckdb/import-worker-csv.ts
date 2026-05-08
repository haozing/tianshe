import type { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import { parentPort } from 'worker_threads';
import { cleanupTempFile, getTempFilePath, parseRows } from './utils';
import { getUnknownErrorMessage } from '../ipc-utils';

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



/**
 * 导入CSV
 */
export async function importCSV(conn: DuckDBConnection, filePath: string): Promise<void> {
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
  const message = getUnknownErrorMessage(error);
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



export async function writeWithBackpressure(
  writeStream: fs.WriteStream,
  text: string
): Promise<void> {
  const canWrite = writeStream.write(text);
  if (!canWrite) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        writeStream.off('drain', onDrain);
        writeStream.off('error', onError);
      };
      writeStream.once('drain', onDrain);
      writeStream.once('error', onError);
    });
  }
}



export async function finishWriteStream(writeStream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      writeStream.off('finish', onFinish);
      writeStream.off('error', onError);
    };
    writeStream.once('finish', onFinish);
    writeStream.once('error', onError);
    writeStream.end();
  });
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
  const readStream = fs.createReadStream(filePath);
  const writeStream = fs.createWriteStream(tempFilePath, { encoding: 'utf-8' });
  let writeError: Error | null = null;
  const recordWriteError = (error: Error) => {
    writeError = error;
  };
  const throwIfWriteFailed = () => {
    if (writeError) {
      throw writeError;
    }
  };

  writeStream.on('error', recordWriteError);

  try {
    for await (const chunk of readStream) {
      throwIfWriteFailed();
      let text = decoder.decode(chunk as Buffer, { stream: true });
      if (isFirstChunk) {
        text = stripBom(text);
        isFirstChunk = false;
      }
      if (text.length > 0) {
        await writeWithBackpressure(writeStream, text);
        throwIfWriteFailed();
      }
    }

    throwIfWriteFailed();
    let text = decoder.decode();
    if (isFirstChunk) {
      text = stripBom(text);
      isFirstChunk = false;
    }
    if (text.length > 0) {
      await writeWithBackpressure(writeStream, text);
      throwIfWriteFailed();
    }

    await finishWriteStream(writeStream);
  } catch (error) {
    readStream.destroy();
    writeStream.destroy();
    try {
      await fs.remove(tempFilePath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  } finally {
    writeStream.off('error', recordWriteError);
  }

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
