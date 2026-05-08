import type { DuckDBConnection } from '@duckdb/node-api';
import { parentPort } from 'worker_threads';
import { parseRows } from './utils';

export async function importJSON(conn: DuckDBConnection, filePath: string): Promise<void> {
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

export async function importXLSX(conn: DuckDBConnection, filePath: string): Promise<void> {
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
