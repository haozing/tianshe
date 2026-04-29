const READ_ONLY_SQL_PREFIX = /^(SELECT|WITH|EXPLAIN|DESCRIBE|SHOW)\b/i;
const MUTATING_SQL_KEYWORDS =
  /\b(ALTER|ATTACH|CALL|CHECKPOINT|COPY|CREATE|DELETE|DETACH|DROP|EXPORT|IMPORT|INSERT|INSTALL|LOAD|MERGE|PRAGMA|REPLACE|SET|TRUNCATE|UPDATE|VACUUM)\b/i;

export function stripSQLCommentsAndLiterals(sql: string): string {
  let result = '';
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      result += ' ';
      continue;
    }

    if (current === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      result += ' ';
      continue;
    }

    if (current === "'" || current === '"' || current === '`') {
      const quote = current;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      result += ' ';
      continue;
    }

    result += current;
    index += 1;
  }

  return result;
}

export function assertReadOnlySQL(sql: string): void {
  const sanitized = stripSQLCommentsAndLiterals(sql).trim();

  if (!sanitized) {
    throw new Error('SQL must not be empty');
  }

  if (!READ_ONLY_SQL_PREFIX.test(sanitized)) {
    throw new Error('Only read-only SQL is allowed in this query endpoint');
  }

  if (sanitized.includes(';')) {
    throw new Error('Only a single read-only SQL statement is allowed');
  }

  const unsafeKeyword = sanitized.match(MUTATING_SQL_KEYWORDS)?.[1];
  if (unsafeKeyword) {
    throw new Error(`Read-only SQL must not contain ${unsafeKeyword.toUpperCase()}`);
  }
}

export function isSelectLikeSQL(sql: string): boolean {
  const sanitized = stripSQLCommentsAndLiterals(sql).trimStart();
  return /^(SELECT|WITH)\b/i.test(sanitized);
}
