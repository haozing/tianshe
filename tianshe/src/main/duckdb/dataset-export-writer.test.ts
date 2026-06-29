import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetExportWriter } from './dataset-export-writer';

describe('DatasetExportWriter atomic output', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataset-export-writer-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  function createCountReader(count = 1) {
    return {
      columnNames: () => ['count'],
      getRows: () => [[count]],
    };
  }

  function getCopyTarget(sql: string): string {
    const match = sql.match(/\bTO\s+'([^']+)'/i);
    if (!match) {
      throw new Error(`COPY target not found in SQL: ${sql}`);
    }
    return match[1].replace(/''/g, "'");
  }

  it('commits CSV exports through a same-directory temp file', async () => {
    const outputPath = path.join(tempDir, 'contacts.csv');
    const conn = {
      run: vi.fn(async (sql: string) => {
        await fs.outputFile(getCopyTarget(sql), 'name\nAda\n');
      }),
      runAndReadAll: vi.fn(async () => createCountReader(1)),
    };
    const writer = new DatasetExportWriter(conn as any);

    const result = await writer.exportByFormat({
      format: 'csv',
      exportSQL: 'SELECT 1 AS name',
      outputPath,
      options: { format: 'csv', includeHeader: true } as any,
    });

    expect(result).toEqual({ files: [outputPath], totalRows: 1 });
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('name\nAda\n');

    const files = await fs.readdir(tempDir);
    expect(files).toEqual(['contacts.csv']);
    expect(conn.run).toHaveBeenCalledWith(expect.stringContaining('.contacts.csv.tmp-'));
  });

  it('keeps the previous output when COPY fails after writing a temp file', async () => {
    const outputPath = path.join(tempDir, 'contacts.csv');
    await fs.outputFile(outputPath, 'previous export\n');
    const conn = {
      run: vi.fn(async (sql: string) => {
        await fs.outputFile(getCopyTarget(sql), 'partial export\n');
        throw new Error('copy failed');
      }),
      runAndReadAll: vi.fn(async () => createCountReader(1)),
    };
    const writer = new DatasetExportWriter(conn as any);

    await expect(
      writer.exportByFormat({
        format: 'csv',
        exportSQL: 'SELECT 1 AS name',
        outputPath,
        options: { format: 'csv', includeHeader: true } as any,
      })
    ).rejects.toThrow('copy failed');

    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('previous export\n');
    const files = await fs.readdir(tempDir);
    expect(files).toEqual(['contacts.csv']);
  });
});
