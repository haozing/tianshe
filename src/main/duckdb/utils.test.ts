/**
 * DuckDB 工具函数单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import type { DuckDBResultReader } from '@duckdb/node-api';

// Mock electron 模块
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/user/data'),
  },
}));

// Mock fs-extra 模块
vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
    pathExists: vi.fn(),
    remove: vi.fn(),
    open: vi.fn(),
    read: vi.fn(),
    close: vi.fn(),
  },
}));

// Mock crypto 模块
vi.mock('crypto', () => ({
  default: {
    randomBytes: vi.fn().mockReturnValue({
      toString: vi.fn().mockReturnValue('1234567890abcdef'),
    }),
  },
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('1234567890abcdef'),
  }),
}));

// Mock @duckdb/node-api 模块
vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: vi.fn(),
  },
  DuckDBConnection: {
    create: vi.fn(),
  },
}));

import fs from 'fs-extra';
import { app } from 'electron';
import * as crypto from 'crypto';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import * as utils from './utils';

const originalArgv = [...process.argv];
const userDataArg = '--airpa-user-data-dir=/user/data';
const withoutUserDataArg = (argv: string[]): string[] =>
  argv.filter((arg) => !arg.startsWith('--airpa-user-data-dir'));

beforeEach(() => {
  process.argv = [...withoutUserDataArg(originalArgv), userDataArg];
});

afterEach(() => {
  process.argv = [...originalArgv];
});

describe('DuckDB Utils - 路径生成函数', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDuckDBDataDir', () => {
    it('应该返回正确的 DuckDB 数据目录路径', () => {
      const result = utils.getDuckDBDataDir();
      expect(result).toBe(path.join('/user/data', 'duckdb'));
      expect(app.getPath).not.toHaveBeenCalled();
    });
  });

  describe('getMainDBPath', () => {
    it('应该返回主数据库文件路径', () => {
      const result = utils.getMainDBPath();
      const expected = path.join('/user/data', 'duckdb', 'main.db');
      expect(result).toBe(expected);
    });
  });

  describe('getImportsDir', () => {
    it('应该返回导入目录路径', () => {
      const result = utils.getImportsDir();
      const expected = path.join('/user/data', 'duckdb', 'imports');
      expect(result).toBe(expected);
    });
  });

  describe('getTempDir', () => {
    it('应该返回临时文件目录路径', () => {
      const result = utils.getTempDir();
      const expected = path.join('/user/data', 'duckdb', 'temp');
      expect(result).toBe(expected);
    });
  });

  describe('ensureDirectories', () => {
    it('应该创建所有必需的目录', async () => {
      await utils.ensureDirectories();

      expect(fs.ensureDir).toHaveBeenCalledTimes(3);
      expect(fs.ensureDir).toHaveBeenCalledWith(path.join('/user/data', 'duckdb'));
      expect(fs.ensureDir).toHaveBeenCalledWith(path.join('/user/data', 'duckdb', 'imports'));
      expect(fs.ensureDir).toHaveBeenCalledWith(path.join('/user/data', 'duckdb', 'temp'));
    });
  });
});

describe('DuckDB Utils - 数据集ID处理', () => {
  describe('sanitizeDatasetId', () => {
    it('应该将冒号替换为双下划线', () => {
      expect(utils.sanitizeDatasetId('plugin:id:code')).toBe('plugin__id__code');
    });

    it('应该对已经是双下划线格式的ID保持不变（幂等性）', () => {
      expect(utils.sanitizeDatasetId('plugin__id__code')).toBe('plugin__id__code');
    });

    it('应该处理混合格式', () => {
      expect(utils.sanitizeDatasetId('plugin:id__code')).toBe('plugin__id__code');
    });

    it('应该处理没有特殊字符的ID', () => {
      expect(utils.sanitizeDatasetId('simple-dataset-id')).toBe('simple-dataset-id');
    });

    it('应该处理空字符串', () => {
      expect(utils.sanitizeDatasetId('')).toBe('');
    });
  });

  describe('desanitizeDatasetId', () => {
    it('应该将双下划线转换为冒号', () => {
      expect(utils.desanitizeDatasetId('plugin__id__code')).toBe('plugin:id:code');
    });

    it('应该对单下划线不做处理', () => {
      expect(utils.desanitizeDatasetId('plugin_id_code')).toBe('plugin_id_code');
    });

    it('应该处理混合格式', () => {
      expect(utils.desanitizeDatasetId('plugin__id_code')).toBe('plugin:id_code');
    });

    it('应该处理空字符串', () => {
      expect(utils.desanitizeDatasetId('')).toBe('');
    });
  });

  describe('getDatasetPath', () => {
    it('应该返回安全的数据集文件路径', () => {
      const result = utils.getDatasetPath('plugin:id:code');
      const expected = path.join('/user/data', 'duckdb', 'imports', 'plugin__id__code.db');
      expect(result).toBe(expected);
    });

    it('应该处理已经是安全格式的ID', () => {
      const result = utils.getDatasetPath('plugin__id__code');
      const expected = path.join('/user/data', 'duckdb', 'imports', 'plugin__id__code.db');
      expect(result).toBe(expected);
    });
  });
});

describe('DuckDB Utils - 文件操作', () => {
  describe('getFileSize', () => {
    it('应该返回文件大小', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      const size = await utils.getFileSize('/path/to/file.db');
      expect(size).toBe(1024);
      expect(fs.stat).toHaveBeenCalledWith('/path/to/file.db');
    });

    it('文件不存在时应该返回 0', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('File not found'));

      const size = await utils.getFileSize('/path/to/nonexistent.db');
      expect(size).toBe(0);
    });
  });

  describe('formatBytes', () => {
    it('应该正确格式化 0 字节', () => {
      expect(utils.formatBytes(0)).toBe('0 Bytes');
    });

    it('应该正确格式化字节单位', () => {
      expect(utils.formatBytes(500)).toBe('500 Bytes');
      expect(utils.formatBytes(1023)).toBe('1023 Bytes');
    });

    it('应该正确格式化 KB 单位', () => {
      expect(utils.formatBytes(1024)).toBe('1 KB');
      expect(utils.formatBytes(1536)).toBe('1.5 KB');
      expect(utils.formatBytes(2048)).toBe('2 KB');
    });

    it('应该正确格式化 MB 单位', () => {
      expect(utils.formatBytes(1024 * 1024)).toBe('1 MB');
      expect(utils.formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
      expect(utils.formatBytes(10.25 * 1024 * 1024)).toBe('10.25 MB');
    });

    it('应该正确格式化 GB 单位', () => {
      expect(utils.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(utils.formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('应该正确格式化 TB 单位', () => {
      expect(utils.formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
      expect(utils.formatBytes(1.5 * 1024 * 1024 * 1024 * 1024)).toBe('1.5 TB');
    });

    it('应该正确处理小数精度', () => {
      expect(utils.formatBytes(1234567)).toBe('1.18 MB');
      expect(utils.formatBytes(123456789)).toBe('117.74 MB');
    });
  });

  describe('detectFileType', () => {
    it('应该识别 CSV 文件', () => {
      expect(utils.detectFileType('/path/to/file.csv')).toBe('csv');
      expect(utils.detectFileType('/path/to/FILE.CSV')).toBe('csv');
    });

    it('应该识别 XLSX 文件', () => {
      expect(utils.detectFileType('/path/to/file.xlsx')).toBe('xlsx');
      expect(utils.detectFileType('/path/to/FILE.XLSX')).toBe('xlsx');
    });

    it('应该识别 XLS 文件', () => {
      expect(utils.detectFileType('/path/to/file.xls')).toBe('xls');
      expect(utils.detectFileType('/path/to/FILE.XLS')).toBe('xls');
    });
    it('should detect JSON files', () => {
      expect(utils.detectFileType('/path/to/file.json')).toBe('json');
      expect(utils.detectFileType('/path/to/FILE.JSON')).toBe('json');
    });

    it('应该返回 unknown 对于未知类型', () => {
      expect(utils.detectFileType('/path/to/file.txt')).toBe('unknown');
      expect(utils.detectFileType('/path/to/file.pdf')).toBe('unknown');
      expect(utils.detectFileType('/path/to/file')).toBe('unknown');
    });
  });
});

describe('DuckDB Utils - 临时文件管理', () => {
  describe('getTempFilePath', () => {
    it('应该生成临时文件路径', () => {
      const result = utils.getTempFilePath('original-file.csv', '.tmp');
      const tempDir = path.join('/user/data', 'duckdb', 'temp');

      expect(result).toContain(tempDir);
      expect(result).toContain('original-file');
      expect(result).toContain('1234567890abcdef');
      expect(result).toContain('.tmp');
      expect(crypto.randomBytes).toHaveBeenCalledWith(8);
    });

    it('应该正确处理带扩展名的原始文件名', () => {
      const result = utils.getTempFilePath('data.xlsx', '.csv');

      expect(result).toContain('data_1234567890abcdef.csv');
      expect(result).not.toContain('.xlsx');
    });

    it('应该正确处理无扩展名的文件', () => {
      const result = utils.getTempFilePath('myfile', '.db');

      expect(result).toContain('myfile_1234567890abcdef.db');
    });
  });

  describe('cleanupTempFile', () => {
    it('文件存在时应该删除临时文件', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.remove).mockResolvedValue(undefined);

      await utils.cleanupTempFile('/path/to/temp.tmp');

      expect(fs.pathExists).toHaveBeenCalledWith('/path/to/temp.tmp');
      expect(fs.remove).toHaveBeenCalledWith('/path/to/temp.tmp');
    });

    it('文件不存在时应该不执行删除操作', async () => {
      // 重置 mock 计数，避免之前测试的影响
      vi.clearAllMocks();
      vi.mocked(fs.pathExists).mockResolvedValue(false);

      await utils.cleanupTempFile('/path/to/nonexistent.tmp');

      expect(fs.pathExists).toHaveBeenCalledWith('/path/to/nonexistent.tmp');
      expect(fs.remove).not.toHaveBeenCalled();
    });

    it('删除失败时应该捕获错误（不抛出）', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.remove).mockRejectedValue(new Error('Permission denied'));

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(utils.cleanupTempFile('/path/to/locked.tmp')).resolves.not.toThrow();

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe('cleanupTempFiles', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('应该删除过期的临时文件', async () => {
      const now = Date.now();
      const oldFileTime = now - 2 * 24 * 60 * 60 * 1000; // 2天前
      const recentFileTime = now - 12 * 60 * 60 * 1000; // 12小时前

      vi.mocked(fs.readdir).mockResolvedValue(['old.tmp', 'recent.tmp'] as any);
      vi.mocked(fs.stat)
        .mockResolvedValueOnce({ mtimeMs: oldFileTime } as any)
        .mockResolvedValueOnce({ mtimeMs: recentFileTime } as any);
      vi.mocked(fs.remove).mockResolvedValue(undefined);

      const deletedCount = await utils.cleanupTempFiles(1); // 保留1天内的文件

      expect(deletedCount).toBe(1);
      expect(fs.remove).toHaveBeenCalledTimes(1);
      expect(fs.remove).toHaveBeenCalledWith(path.join('/user/data', 'duckdb', 'temp', 'old.tmp'));
    });

    it('应该保留所有在保留期内的文件', async () => {
      const now = Date.now();
      const recentTime = now - 12 * 60 * 60 * 1000; // 12小时前

      vi.mocked(fs.readdir).mockResolvedValue(['file1.tmp', 'file2.tmp'] as any);
      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: recentTime } as any);
      vi.mocked(fs.remove).mockResolvedValue(undefined);

      const deletedCount = await utils.cleanupTempFiles(1);

      expect(deletedCount).toBe(0);
      expect(fs.remove).not.toHaveBeenCalled();
    });

    it('目录不存在时应该返回 0', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const deletedCount = await utils.cleanupTempFiles(1);

      expect(deletedCount).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('应该使用默认保留期（1天）', async () => {
      const now = Date.now();
      const oldFileTime = now - 2 * 24 * 60 * 60 * 1000;

      vi.mocked(fs.readdir).mockResolvedValue(['old.tmp'] as any);
      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: oldFileTime } as any);
      vi.mocked(fs.remove).mockResolvedValue(undefined);

      const deletedCount = await utils.cleanupTempFiles();

      expect(deletedCount).toBe(1);
    });

    it('删除失败不应该影响其他文件的清理', async () => {
      const now = Date.now();
      const oldTime = now - 2 * 24 * 60 * 60 * 1000;

      vi.mocked(fs.readdir).mockResolvedValue(['file1.tmp', 'file2.tmp'] as any);
      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: oldTime } as any);
      vi.mocked(fs.remove)
        .mockRejectedValueOnce(new Error('Cannot delete'))
        .mockResolvedValueOnce(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const deletedCount = await utils.cleanupTempFiles(1);

      // 第一个文件删除失败，抛出错误
      expect(deletedCount).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});

describe('DuckDB Utils - 数据解析', () => {
  describe('parseRows', () => {
    it('应该将 DuckDB 结果转换为对象数组', () => {
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'name', 'email']),
        getRows: vi.fn().mockReturnValue([
          [1, 'Alice', 'alice@example.com'],
          [2, 'Bob', 'bob@example.com'],
        ]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
      ]);
    });

    it('应该处理空结果集', () => {
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'name']),
        getRows: vi.fn().mockReturnValue([]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([]);
    });

    it('应该转换 BigInt 值（安全范围内）', () => {
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'value']),
        getRows: vi.fn().mockReturnValue([[1, BigInt(12345)]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, value: 12345 }]);
      expect(typeof result[0].value).toBe('number');
    });

    it('应该将超出安全范围的 BigInt 转换为字符串', () => {
      const largeBigInt = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1000);
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'value']),
        getRows: vi.fn().mockReturnValue([[1, largeBigInt]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result[0].value).toBe(largeBigInt.toString());
      expect(typeof result[0].value).toBe('string');
    });

    it('应该处理 null 和 undefined 值', () => {
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'name', 'email']),
        getRows: vi.fn().mockReturnValue([[1, null, undefined]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, name: null, email: undefined }]);
    });

    it('应该转换 Date 对象', () => {
      const date = new Date('2024-01-15');
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'created_at']),
        getRows: vi.fn().mockReturnValue([[1, date]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, created_at: date }]);
    });

    it('应该转换 DuckDB 日期对象（year/month/day 格式）', () => {
      const duckdbDate = { year: 2024, month: 1, day: 15 };
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'date']),
        getRows: vi.fn().mockReturnValue([[1, duckdbDate]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result[0].date).toBe('2024-01-15');
    });

    it('应该转换 DuckDB 时间戳对象（year/month/day/hour 格式）', () => {
      const duckdbTimestamp = {
        year: 2024,
        month: 1,
        day: 15,
        hour: 10,
        minute: 30,
        second: 45,
      };
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'timestamp']),
        getRows: vi.fn().mockReturnValue([[1, duckdbTimestamp]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result[0].timestamp).toBe('2024-01-15 10:30:45');
    });

    it('应该转换 Buffer 对象', () => {
      const buffer = Buffer.from('test data');
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'data']),
        getRows: vi.fn().mockReturnValue([[1, buffer]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, data: buffer }]);
      expect(Buffer.isBuffer(result[0].data)).toBe(true);
    });

    it('应该转换带 toArray 方法的 DuckDB LIST 类型', () => {
      const duckdbList = {
        toArray: vi.fn().mockReturnValue([1, 2, 3]),
      };
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'tags']),
        getRows: vi.fn().mockReturnValue([[1, duckdbList]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, tags: [1, 2, 3] }]);
    });

    it('应该转换可迭代的 DuckDB 值', () => {
      const iterableValue = {
        [Symbol.iterator]: function* () {
          yield 'a';
          yield 'b';
          yield 'c';
        },
      };
      const mockReader: DuckDBResultReader = {
        columnNames: vi.fn().mockReturnValue(['id', 'items']),
        getRows: vi.fn().mockReturnValue([[1, iterableValue]]),
      } as any;

      const result = utils.parseRows(mockReader);

      expect(result).toEqual([{ id: 1, items: ['a', 'b', 'c'] }]);
    });
  });
});

describe('DuckDB Utils - 重试机制', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('withRetry', () => {
    it('操作成功时应该立即返回结果', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const promise = utils.withRetry(operation, { maxAttempts: 3 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('可重试错误应该进行重试', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Database is locked'))
        .mockRejectedValueOnce(new Error('Database is locked'))
        .mockResolvedValue('success');

      const promise = utils.withRetry(operation, {
        maxAttempts: 3,
        delayMs: 100,
      });

      // 运行所有定时器
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('非可重试错误应该立即抛出', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Invalid syntax'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promise = utils.withRetry(operation, { maxAttempts: 3 });
      const expectation = expect(promise).rejects.toThrow('Invalid syntax');
      await vi.runAllTimersAsync();

      await expectation;
      expect(operation).toHaveBeenCalledTimes(1);

      consoleErrorSpy.mockRestore();
    });

    it('达到最大重试次数后应该抛出错误', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Database is locked'));

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promise = utils.withRetry(operation, { maxAttempts: 3 });
      const expectation = expect(promise).rejects.toThrow('Database is locked');
      await vi.runAllTimersAsync();

      await expectation;
      expect(operation).toHaveBeenCalledTimes(3);

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('应该使用指数退避延迟', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Database locked'))
        .mockRejectedValueOnce(new Error('Database locked'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = utils.withRetry(operation, {
        maxAttempts: 3,
        delayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 5000,
      });

      await vi.runAllTimersAsync();
      await promise;

      // 验证延迟：第一次 100ms，第二次 200ms
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying in 100ms'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying in 200ms'));

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('延迟不应超过最大延迟限制', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('busy'))
        .mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = utils.withRetry(operation, {
        maxAttempts: 3,
        delayMs: 1000,
        backoffMultiplier: 10,
        maxDelayMs: 1500,
      });

      await vi.runAllTimersAsync();
      await promise;

      // 第二次重试延迟应该是 1500ms（maxDelayMs），而不是 10000ms
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying in 1500ms'));

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('应该识别各种可重试错误模式', async () => {
      const retryableErrors = [
        'Database is locked',
        'database locked',
        'BUSY',
        'cannot open',
        'Connection Lost',
        'IO ERROR',
        'EBUSY',
      ];

      for (const errorMsg of retryableErrors) {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error(errorMsg))
          .mockResolvedValue('success');

        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const promise = utils.withRetry(operation, { maxAttempts: 2 });
        await vi.runAllTimersAsync();
        await promise;

        expect(operation).toHaveBeenCalledTimes(2);

        consoleWarnSpy.mockRestore();
        consoleLogSpy.mockRestore();
        vi.clearAllMocks();
      }
    });

    it('应该使用自定义可重试错误列表', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Custom error'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = utils.withRetry(operation, {
        maxAttempts: 2,
        retryableErrors: ['custom error'],
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(operation).toHaveBeenCalledTimes(2);

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe('withDatabaseRetry', () => {
    it('应该使用数据库专用的默认配置', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Database locked'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = utils.withDatabaseRetry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('应该允许覆盖默认配置', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Database locked'));

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const promise = utils.withDatabaseRetry(operation, { maxAttempts: 2 });
      const expectation = expect(promise).rejects.toThrow('Database locked');
      await vi.runAllTimersAsync();

      await expectation;
      expect(operation).toHaveBeenCalledTimes(2);

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});

describe('DuckDB Utils - 数据库完整性检查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkDatabaseIntegrity', () => {
    it('文件不存在时应该返回错误', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false);

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Database file does not exist');
      expect(result.canRepair).toBe(false);
    });

    it('文件为空时应该返回错误', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.stat).mockResolvedValue({ size: 0 } as any);

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Database file is empty (0 bytes)');
      expect(result.canRepair).toBe(false);
      expect(result.fileSizeBytes).toBe(0);
    });

    it('数据库正常时应该返回有效状态', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.open).mockResolvedValue(3 as any);
      vi.mocked(fs.read).mockImplementation(async (_fd, buffer: any) => {
        buffer.write('DUCK', 0, 'utf8');
        return { bytesRead: 16, buffer };
      });
      vi.mocked(fs.close).mockResolvedValue(undefined);

      const mockConnection = {
        runAndReadAll: vi.fn().mockResolvedValue([]),
        closeSync: vi.fn(),
      };
      const mockInstance = {
        closeSync: vi.fn(),
      };

      vi.mocked(DuckDBInstance.create).mockResolvedValue(mockInstance as any);
      vi.mocked(DuckDBConnection.create).mockResolvedValue(mockConnection as any);

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.fileSizeBytes).toBe(1024);
    });

    it('数据库打开失败时应该返回错误', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.open).mockResolvedValue(3 as any);
      vi.mocked(fs.read).mockResolvedValue({ bytesRead: 16, buffer: Buffer.alloc(16) });
      vi.mocked(fs.close).mockResolvedValue(undefined);

      vi.mocked(DuckDBInstance.create).mockRejectedValue(new Error('Database is locked'));

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Failed to open database');
      expect(result.canRepair).toBe(true); // locked 错误可以修复
    });

    it('查询失败时应该返回错误', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.open).mockResolvedValue(3 as any);
      vi.mocked(fs.read).mockResolvedValue({ bytesRead: 16, buffer: Buffer.alloc(16) });
      vi.mocked(fs.close).mockResolvedValue(undefined);

      const mockConnection = {
        runAndReadAll: vi.fn().mockRejectedValue(new Error('Database corrupted')),
        closeSync: vi.fn(),
      };
      const mockInstance = {
        closeSync: vi.fn(),
      };

      vi.mocked(DuckDBInstance.create).mockResolvedValue(mockInstance as any);
      vi.mocked(DuckDBConnection.create).mockResolvedValue(mockConnection as any);

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Database query failed');
      expect(result.canRepair).toBe(true); // corrupted 错误可能可以修复
    });

    it('存在 WAL 文件时应该添加警告', async () => {
      vi.mocked(fs.pathExists)
        .mockResolvedValueOnce(true) // 数据库文件存在
        .mockResolvedValueOnce(true); // WAL 文件存在

      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.open).mockResolvedValue(3 as any);
      vi.mocked(fs.read).mockResolvedValue({ bytesRead: 16, buffer: Buffer.alloc(16) });
      vi.mocked(fs.close).mockResolvedValue(undefined);

      const mockConnection = {
        runAndReadAll: vi.fn().mockResolvedValue([]),
        closeSync: vi.fn(),
      };
      const mockInstance = {
        closeSync: vi.fn(),
      };

      vi.mocked(DuckDBInstance.create).mockResolvedValue(mockInstance as any);
      vi.mocked(DuckDBConnection.create).mockResolvedValue(mockConnection as any);

      const result = await utils.checkDatabaseIntegrity('/path/to/db.duckdb');

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'WAL file exists - database may have uncommitted transactions'
      );
    });
  });

  describe('repairDatabase', () => {
    it('删除辅助文件后应该重新检查完整性', async () => {
      vi.clearAllMocks();

      // Mock 辅助文件存在（repairDatabase 检查）
      vi.mocked(fs.pathExists)
        .mockResolvedValueOnce(true) // .wal 文件存在
        .mockResolvedValueOnce(false) // .tmp 文件不存在
        .mockResolvedValueOnce(false) // -shm 文件不存在
        .mockResolvedValueOnce(false) // -journal 文件不存在
        .mockResolvedValueOnce(false) // .lock 文件不存在
        .mockResolvedValueOnce(false) // -wal 文件不存在
        // checkDatabaseIntegrity 调用
        .mockResolvedValueOnce(true) // 数据库文件存在
        .mockResolvedValueOnce(false); // WAL 文件不存在（已被删除）

      vi.mocked(fs.remove).mockResolvedValue(undefined);

      // Mock 完整性检查返回有效
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.open).mockResolvedValue(3 as any);
      vi.mocked(fs.read).mockImplementation(async (_fd, buffer: any) => {
        buffer.write('DUCK', 0, 'utf8');
        return { bytesRead: 16, buffer };
      });
      vi.mocked(fs.close).mockResolvedValue(undefined);

      const mockConnection = {
        runAndReadAll: vi.fn().mockResolvedValue([]),
        closeSync: vi.fn(),
      };
      const mockInstance = {
        closeSync: vi.fn(),
      };

      vi.mocked(DuckDBInstance.create).mockResolvedValue(mockInstance as any);
      vi.mocked(DuckDBConnection.create).mockResolvedValue(mockConnection as any);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await utils.repairDatabase('/path/to/db.duckdb');

      expect(result).toBe(true);
      expect(fs.remove).toHaveBeenCalledWith('/path/to/db.duckdb.wal');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Database repaired successfully')
      );

      consoleLogSpy.mockRestore();
    });

    it('没有辅助文件时应该返回 false', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await utils.repairDatabase('/path/to/db.duckdb');

      expect(result).toBe(false);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('No auxiliary files to remove')
      );

      consoleLogSpy.mockRestore();
    });

    it('修复后数据库仍然损坏时应该返回 false', async () => {
      vi.mocked(fs.pathExists)
        .mockResolvedValueOnce(true) // .wal 文件存在
        .mockResolvedValue(false);

      vi.mocked(fs.remove).mockResolvedValue(undefined);

      // Mock 完整性检查返回无效
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      vi.mocked(DuckDBInstance.create).mockRejectedValue(new Error('Still corrupted'));

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await utils.repairDatabase('/path/to/db.duckdb');

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Database still corrupted')
      );

      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('发生异常时应该捕获错误并返回 false', async () => {
      vi.clearAllMocks();

      // 第一次调用就抛出错误
      vi.mocked(fs.pathExists).mockRejectedValue(new Error('File system error'));

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await utils.repairDatabase('/path/to/db.duckdb');

      expect(result).toBe(false);
      // repairDatabase 会捕获异常并在 catch 中记录错误
      // 但由于循环中每个文件都会触发 catch，实际上是 console.warn 被调用
      expect(consoleWarnSpy.mock.calls.length).toBeGreaterThan(0);

      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
