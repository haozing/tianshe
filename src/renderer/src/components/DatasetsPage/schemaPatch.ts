import {
  extractDependenciesFromComputeConfig,
  getDependentComputedColumns,
  replaceIdentifierInExpression,
  rewriteColumnReferenceInComputeConfig,
  rewriteColumnReferencesInSchema,
} from '../../../../utils/computed-schema-helpers';

type DatasetSchemaColumn = {
  name: string;
  duckdbType: string;
  fieldType?: string;
  nullable?: boolean;
  metadata?: any;
  storageMode?: string;
  computeConfig?: any;
  validationRules?: any[];
  displayConfig?: any;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export {
  extractDependenciesFromComputeConfig,
  getDependentComputedColumns,
  replaceIdentifierInExpression,
  rewriteColumnReferenceInComputeConfig,
  rewriteColumnReferencesInSchema,
};

export function buildRenamedSchema(
  schema: DatasetSchemaColumn[],
  columnName: string,
  newName: string
) {
  const renamedSchema = schema.map((column) =>
    column.name === columnName ? { ...column, name: newName } : { ...column }
  );
  return rewriteColumnReferencesInSchema(renamedSchema, columnName, newName);
}

export function buildDeletedSchema(
  schema: DatasetSchemaColumn[],
  columnName: string,
  options?: { force?: boolean }
) {
  const dependentColumns =
    options?.force ? getDependentComputedColumns(schema, columnName) : [];
  const removedColumns = new Set([columnName, ...dependentColumns]);
  return schema.filter((column) => !removedColumns.has(column.name)).map((column) => ({ ...column }));
}

export function buildPatchedColumnSchema(
  schema: DatasetSchemaColumn[],
  columnName: string,
  patch: Partial<Omit<DatasetSchemaColumn, 'name'>>
) {
  const nextPatch = clone(patch);

  return schema.map((column) =>
    column.name === columnName ? { ...column, ...nextPatch } : { ...column }
  );
}
