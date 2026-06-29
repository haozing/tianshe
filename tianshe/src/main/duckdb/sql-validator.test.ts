import { describe, expect, it } from 'vitest';
import { SQLValidator } from './sql-validator';

describe('SQLValidator security preflight', () => {
  it.each([
    "query('select 1')",
    "read_csv('/tmp/data.csv')",
    "read_parquet('/tmp/data.parquet')",
    "glob('/tmp/*.db')",
  ])('rejects dynamic SQL and file-reading functions: %s', async (expression) => {
    const validator = new SQLValidator({} as any);

    await expect(validator.quickValidate(expression)).resolves.toMatchObject({
      valid: false,
      error: expect.stringContaining('动态SQL或文件读取函数'),
    });
  });
});
