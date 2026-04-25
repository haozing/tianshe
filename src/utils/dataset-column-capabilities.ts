export const SYSTEM_FIELDS = ['_row_id', 'created_at', 'updated_at', 'deleted_at'] as const;

export type SystemField = (typeof SYSTEM_FIELDS)[number];

export interface DatasetColumnMetadataLike {
  isSystemColumn?: boolean;
  hidden?: boolean;
}

export interface DatasetColumnDisplayConfigLike {
  width?: number;
  hidden?: boolean;
  order?: number;
  frozen?: boolean;
  pinned?: 'left' | 'right' | string;
}

export interface DatasetColumnLike {
  name: string;
  fieldType?: string | null;
  storageMode?: string | null;
  metadata?: unknown;
  computeConfig?: unknown;
  locked?: boolean;
  displayConfig?: DatasetColumnDisplayConfigLike | null;
}

export interface PartitionedRecordFields<T extends Record<string, unknown>> {
  accepted: Partial<T>;
  unknownColumns: string[];
  nonWritableColumns: string[];
}

export function isSystemField(fieldName: string): fieldName is SystemField {
  return SYSTEM_FIELDS.includes(fieldName as SystemField);
}

export function isSystemColumn<T extends DatasetColumnLike>(
  column: T | null | undefined
): boolean {
  const metadata = column?.metadata as DatasetColumnMetadataLike | null | undefined;
  return !!column && (metadata?.isSystemColumn === true || isSystemField(column.name));
}

export function isComputedColumn<T extends DatasetColumnLike>(
  column: T | null | undefined
): boolean {
  return !!column && (column.storageMode === 'computed' || column.computeConfig != null);
}

export function isVirtualColumnFieldType(fieldType?: string | null): boolean {
  return fieldType === 'button' || fieldType === 'attachment';
}

export function isPhysicalStoredColumn<T extends DatasetColumnLike>(
  column: T | null | undefined
): boolean {
  if (!column || isSystemColumn(column) || isComputedColumn(column)) {
    return false;
  }

  return !isVirtualColumnFieldType(column.fieldType);
}

export function isWritableColumn<T extends DatasetColumnLike>(
  column: T | null | undefined
): boolean {
  return !!column && column.locked !== true && isPhysicalStoredColumn(column);
}

export function isDisplayHiddenColumn<T extends DatasetColumnLike>(
  column: T | null | undefined
): boolean {
  return !!column && !isSystemColumn(column) && column.displayConfig?.hidden === true;
}

export function filterSystemColumnsFromSchema<T extends DatasetColumnLike>(schema: readonly T[]): T[] {
  return schema.filter((column) => !isSystemColumn(column));
}

export function filterWritableColumnsFromSchema<T extends DatasetColumnLike>(
  schema: readonly T[]
): T[] {
  return schema.filter((column) => isWritableColumn(column));
}

export function getDisplayHiddenColumnNames<T extends DatasetColumnLike>(schema: readonly T[]): string[] {
  return schema.filter((column) => isDisplayHiddenColumn(column)).map((column) => column.name);
}

export function normalizeColumnNameList(columnNames?: readonly string[] | null): string[] {
  const normalized = new Set<string>();

  for (const columnName of columnNames ?? []) {
    if (typeof columnName === 'string' && columnName.length > 0 && !isSystemField(columnName)) {
      normalized.add(columnName);
    }
  }

  return Array.from(normalized);
}

export function getMergedHiddenColumnNames<T extends DatasetColumnLike>(
  schema: readonly T[],
  queryHiddenColumns?: readonly string[] | null,
  queryShownColumns?: readonly string[] | null,
  querySelectedColumns?: readonly string[] | null
): string[] {
  const merged = new Set(getDisplayHiddenColumnNames(schema));

  for (const columnName of normalizeColumnNameList(queryShownColumns)) {
    merged.delete(columnName);
  }

  for (const columnName of normalizeColumnNameList(querySelectedColumns)) {
    merged.delete(columnName);
  }

  for (const columnName of normalizeColumnNameList(queryHiddenColumns)) {
    merged.add(columnName);
  }

  return Array.from(merged);
}

export function stripSystemFields<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !isSystemField(key))
  ) as Partial<T>;
}

export function partitionRecordFieldsBySchema<T extends Record<string, unknown>, TColumn extends DatasetColumnLike>(
  record: T,
  schema: readonly TColumn[]
): PartitionedRecordFields<T> {
  const acceptedEntries: Array<[string, unknown]> = [];
  const unknownColumns: string[] = [];
  const nonWritableColumns: string[] = [];
  const schemaMap = new Map(schema.map((column) => [column.name, column] as const));

  for (const [key, value] of Object.entries(record)) {
    const column = schemaMap.get(key);

    if (!column) {
      unknownColumns.push(key);
      continue;
    }

    if (!isWritableColumn(column)) {
      nonWritableColumns.push(key);
      continue;
    }

    acceptedEntries.push([key, value]);
  }

  return {
    accepted: Object.fromEntries(acceptedEntries) as Partial<T>,
    unknownColumns,
    nonWritableColumns,
  };
}
