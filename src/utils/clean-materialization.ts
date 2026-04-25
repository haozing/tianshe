import type { CleanConfig, CleanFieldConfig, CleanOperation, DataType } from '../core/query-engine/types';

export interface CleanMaterializationSourceColumn {
  name: string;
  duckdbType: string;
  fieldType?: string;
}

export interface CleanMaterializedColumnSpec {
  name: string;
  duckdbType: string;
  fieldType: string;
  nullable: boolean;
}

const TEXT_OUTPUT_OPERATIONS = new Set<CleanOperation['type']>([
  'trim',
  'trim_start',
  'trim_end',
  'upper',
  'lower',
  'title',
  'to_halfwidth',
  'to_fullwidth',
  'replace',
  'regex_replace',
  'normalize_space',
  'remove_special_chars',
  'truncate',
  'normalize_email',
  'split_part',
  'concat_fields',
  'extract_numbers',
  'format_date',
]);

const NUMERIC_OUTPUT_OPERATIONS = new Set<CleanOperation['type']>([
  'unit_convert',
  'round',
  'floor',
  'ceil',
  'abs',
]);

const NUMERIC_TYPES = new Set([
  'INTEGER',
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'DOUBLE',
  'FLOAT',
  'DECIMAL',
  'NUMERIC',
  'HUGEINT',
  'UBIGINT',
  'UINTEGER',
  'USMALLINT',
  'UTINYINT',
]);

const DATE_TYPES = new Set(['DATE', 'TIMESTAMP', 'TIME']);
const BOOLEAN_TYPES = new Set(['BOOLEAN', 'BOOL']);

function normalizeDuckDBType(type?: string): string {
  const normalized = String(type || 'VARCHAR').trim().toUpperCase();

  switch (normalized) {
    case 'TEXT':
    case 'STRING':
      return 'VARCHAR';
    case 'INT':
      return 'INTEGER';
    case 'FLOAT':
      return 'DOUBLE';
    case 'BOOL':
      return 'BOOLEAN';
    default:
      return normalized || 'VARCHAR';
  }
}

function normalizeFieldType(fieldType: string | undefined, fallbackDuckDBType: string): string {
  switch (fieldType) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'single_select':
    case 'multi_select':
    case 'email':
    case 'url':
    case 'phone':
    case 'uuid':
    case 'ip_address':
    case 'hyperlink':
    case 'json':
    case 'array':
      return fieldType;
    case 'auto_increment':
      return 'number';
    case 'attachment':
    case 'button':
      return 'text';
    default:
      return mapDuckDBTypeToFieldType(fallbackDuckDBType);
  }
}

function mapDuckDBTypeToFieldType(duckdbType: string): string {
  const normalized = normalizeDuckDBType(duckdbType);

  if (NUMERIC_TYPES.has(normalized)) {
    return 'number';
  }
  if (BOOLEAN_TYPES.has(normalized)) {
    return 'boolean';
  }
  if (DATE_TYPES.has(normalized)) {
    return 'date';
  }
  if (normalized === 'JSON') {
    return 'json';
  }
  if (normalized.endsWith('[]')) {
    return 'array';
  }

  return 'text';
}

function inferCastResult(targetType?: DataType): { duckdbType: string; fieldType: string } {
  const duckdbType = normalizeDuckDBType(targetType || 'VARCHAR');
  return {
    duckdbType,
    fieldType: mapDuckDBTypeToFieldType(duckdbType),
  };
}

export function inferCleanFieldResultType(
  sourceColumn: CleanMaterializationSourceColumn | undefined,
  fieldConfig: Pick<CleanFieldConfig, 'field' | 'operations'>
): { duckdbType: string; fieldType: string } {
  let duckdbType = normalizeDuckDBType(sourceColumn?.duckdbType);
  let fieldType = normalizeFieldType(sourceColumn?.fieldType, duckdbType);

  for (const operation of fieldConfig.operations) {
    if (TEXT_OUTPUT_OPERATIONS.has(operation.type)) {
      duckdbType = 'VARCHAR';
      fieldType = 'text';
      continue;
    }

    if (NUMERIC_OUTPUT_OPERATIONS.has(operation.type)) {
      duckdbType = 'DOUBLE';
      fieldType = 'number';
      continue;
    }

    switch (operation.type) {
      case 'cast':
      case 'try_cast': {
        const castResult = inferCastResult(operation.params?.targetType);
        duckdbType = castResult.duckdbType;
        fieldType = castResult.fieldType;
        break;
      }
      case 'parse_date':
        duckdbType = 'TIMESTAMP';
        fieldType = 'date';
        break;
      case 'fill_null':
      case 'coalesce':
      case 'nullif':
      default:
        break;
    }
  }

  return { duckdbType, fieldType };
}

export function buildMaterializedCleanColumnSpecs(
  cleanConfig: CleanConfig,
  schema: CleanMaterializationSourceColumn[]
): CleanMaterializedColumnSpec[] {
  const schemaMap = new Map(schema.map((column) => [column.name, column]));

  return cleanConfig
    .map((fieldConfig) => {
      const outputField = fieldConfig.outputField?.trim();
      if (!outputField) {
        return null;
      }

      const inferred = inferCleanFieldResultType(schemaMap.get(fieldConfig.field), fieldConfig);
      return {
        name: outputField,
        duckdbType: inferred.duckdbType,
        fieldType: inferred.fieldType,
        nullable: true,
      };
    })
    .filter((column): column is CleanMaterializedColumnSpec => column !== null);
}
