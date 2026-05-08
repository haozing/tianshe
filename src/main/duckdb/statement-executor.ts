import {
  DuckDBConnection,
  DuckDBPreparedStatement,
  DuckDBResultReader,
} from '@duckdb/node-api';

export async function withPrepared<T>(
  conn: DuckDBConnection,
  sql: string,
  params: any[],
  work: (stmt: DuckDBPreparedStatement) => Promise<T> | T
): Promise<T> {
  const stmt = await conn.prepare(sql);
  try {
    stmt.bind(params);
    return await work(stmt);
  } finally {
    stmt.destroySync();
  }
}

/**
 * 执行参数化 SQL（INSERT/UPDATE/DELETE），不返回结果。
 * 内部自动 try/finally 销毁 statement，防止 statement 泄漏。
 */
export async function runPrepared(
  conn: DuckDBConnection,
  sql: string,
  params: any[]
): Promise<void> {
  await withPrepared(conn, sql, params, async (stmt) => {
    await stmt.run();
  });
}

/**
 * 执行参数化 SQL（SELECT），返回所有行。
 * 内部自动 try/finally 销毁 statement，防止 statement 泄漏。
 */
export async function allPrepared(
  conn: DuckDBConnection,
  sql: string,
  params: any[]
): Promise<DuckDBResultReader> {
  return withPrepared(conn, sql, params, (stmt) => stmt.runAndReadAll());
}

/**
 * 执行参数化 SQL（SELECT），返回第一行或 null。
 * 内部自动 try/finally 销毁 statement，防止 statement 泄漏。
 */
export async function getPrepared<T>(
  conn: DuckDBConnection,
  sql: string,
  params: any[]
): Promise<T | null> {
  const result = await allPrepared(conn, sql, params);
  const rows = result.getRows();
  return rows.length > 0 ? (rows[0] as T) : null;
}
