export type ComputedSchemaColumnLike = {
  name: string;
  storageMode?: string;
  computeConfig?: any;
};

const SQL_IDENTIFIER_KEYWORDS = new Set([
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COALESCE',
  'CONCAT_WS',
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',
  'DATE',
  'DAY',
  'DECIMAL',
  'DESC',
  'DISTINCT',
  'DOUBLE',
  'ELSE',
  'END',
  'FALSE',
  'FLOAT',
  'FROM',
  'GROUP',
  'IN',
  'INTEGER',
  'INTERVAL',
  'IS',
  'JOIN',
  'LIKE',
  'LIMIT',
  'MONTH',
  'NOT',
  'NULL',
  'NUMERIC',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'SELECT',
  'THEN',
  'TIMESTAMP',
  'TRUE',
  'VARCHAR',
  'WHEN',
  'WHERE',
  'WITH',
  'YEAR',
]);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function replaceIdentifierInExpression(
  expression: string,
  oldName: string,
  newName: string
) {
  const escapedOldName = escapeRegExp(oldName);
  const quotedOld = new RegExp(`"${escapedOldName}"`, 'g');
  const unquotedOld = new RegExp(`\\b${escapedOldName}\\b`, 'g');
  const quotedNew = quoteIdentifier(newName);

  return expression
    .split(/('(?:''|[^'])*')/g)
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(quotedOld, quotedNew).replace(unquotedOld, quotedNew)
    )
    .join('');
}

export function rewriteColumnReferenceInComputeConfig(config: any, oldName: string, newName: string) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const next = clone(config);
  const params = next.params || {};

  switch (next.type) {
    case 'amount':
      if (params.priceField === oldName) params.priceField = newName;
      if (params.quantityField === oldName) params.quantityField = newName;
      break;
    case 'discount':
      if (params.originalPriceField === oldName) params.originalPriceField = newName;
      if (params.discountedPriceField === oldName) params.discountedPriceField = newName;
      break;
    case 'bucket':
      if (params.field === oldName) params.field = newName;
      break;
    case 'concat':
      if (Array.isArray(params.fields)) {
        params.fields = params.fields.map((field: string) => (field === oldName ? newName : field));
      }
      break;
    case 'custom':
      if (typeof next.expression === 'string') {
        next.expression = replaceIdentifierInExpression(next.expression, oldName, newName);
      }
      break;
    default:
      break;
  }

  next.params = params;
  return next;
}

export function rewriteColumnReferencesInSchema<T extends { storageMode?: string; computeConfig?: any }>(
  schema: T[],
  oldName: string,
  newName: string
) {
  return schema.map((column) => {
    if (column.storageMode !== 'computed' || !column.computeConfig) {
      return { ...column };
    }

    return {
      ...column,
      computeConfig: rewriteColumnReferenceInComputeConfig(column.computeConfig, oldName, newName),
    };
  });
}

export function extractDependenciesFromComputeConfig(computeConfig: any): string[] {
  if (!computeConfig || !computeConfig.type) {
    return [];
  }

  switch (computeConfig.type) {
    case 'amount':
      return [computeConfig.params?.priceField, computeConfig.params?.quantityField].filter(Boolean);
    case 'discount':
      return [
        computeConfig.params?.originalPriceField,
        computeConfig.params?.discountedPriceField,
      ].filter(Boolean);
    case 'bucket':
      return [computeConfig.params?.field].filter(Boolean);
    case 'concat':
      return computeConfig.params?.fields || [];
    case 'custom':
      return extractColumnsFromExpression(String(computeConfig.expression || ''));
    default:
      return [];
  }
}

function extractColumnsFromExpression(expression: string): string[] {
  if (!expression) return [];

  const expressionWithoutLiterals = expression.replace(/'([^']|'')*'/g, ' ');
  const identifierPattern = /\b([a-zA-Z_]\w*)\b|"([^"]+)"/g;
  const matches = [...expressionWithoutLiterals.matchAll(identifierPattern)];
  const columns = new Set<string>();

  for (const match of matches) {
    const identifier = match[1] || match[2];
    if (!identifier) continue;
    if (SQL_IDENTIFIER_KEYWORDS.has(identifier.toUpperCase())) continue;
    columns.add(identifier);
  }

  return Array.from(columns);
}

export function doesComputeColumnDependOn<T extends { storageMode?: string; computeConfig?: any }>(
  column: T,
  targetColumnName: string,
  schemaColumnNames?: Set<string>
) {
  if (column.storageMode !== 'computed' || !column.computeConfig) {
    return false;
  }

  const dependencies = extractDependenciesFromComputeConfig(column.computeConfig);
  const normalizedDependencies = schemaColumnNames
    ? dependencies.filter((dep) => schemaColumnNames.has(dep))
    : dependencies;
  return normalizedDependencies.includes(targetColumnName);
}

export function getDependentComputedColumns<
  T extends { name: string; storageMode?: string; computeConfig?: any }
>(schema: T[], columnName: string) {
  const schemaColumnNames = new Set(schema.map((column) => column.name));
  const result = new Set<string>();
  const queue: string[] = [columnName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const column of schema) {
      if (result.has(column.name)) continue;
      if (!doesComputeColumnDependOn(column, current, schemaColumnNames)) continue;
      result.add(column.name);
      queue.push(column.name);
    }
  }

  return Array.from(result);
}
