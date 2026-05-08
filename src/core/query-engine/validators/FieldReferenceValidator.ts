import type { QueryConfig } from '../types';

export interface FieldReferenceValidationResult {
  errors: string[];
  warnings: string[];
}

function hasColumn(availableColumns: Set<string>, field: string | undefined): field is string {
  return Boolean(field && availableColumns.has(field));
}

function pushMissing(
  errors: string[],
  availableColumns: Set<string>,
  label: string,
  field: string | undefined
): void {
  if (field && !hasColumn(availableColumns, field)) {
    errors.push(`${label} '${field}' does not exist in dataset`);
  }
}

function pushMissingWarning(
  warnings: string[],
  availableColumns: Set<string>,
  label: string,
  field: string | undefined,
  suffix: string = 'will be ignored'
): void {
  if (field && !hasColumn(availableColumns, field)) {
    warnings.push(`${label} '${field}' does not exist in dataset, ${suffix}`);
  }
}

export class FieldReferenceValidator {
  static validate(
    config: QueryConfig,
    availableColumns: Set<string>
  ): FieldReferenceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    this.validateFilter(config, availableColumns, errors);
    this.validateColumns(config, availableColumns, errors, warnings);
    this.validateSort(config, availableColumns, errors);
    this.validateClean(config, availableColumns, errors);
    this.validateDedupe(config, availableColumns, errors);
    this.validateCompute(config, availableColumns, errors);
    this.validateValidation(config, availableColumns, errors);
    this.validateExplode(config, availableColumns, errors);
    this.validateLookup(config, availableColumns, errors);
    this.validateSample(config, availableColumns, errors);
    this.validateGroup(config, availableColumns, errors);
    this.validateAggregate(config, availableColumns, errors);
    this.validateSoftDelete(config, availableColumns, warnings);

    return { errors, warnings };
  }

  private static validateFilter(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const condition of config.filter?.conditions ?? []) {
      pushMissing(errors, availableColumns, 'Filter field', condition.field);
    }
  }

  private static validateColumns(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[],
    warnings: string[]
  ): void {
    for (const col of config.columns?.select ?? []) {
      pushMissing(errors, availableColumns, 'Column', col);
    }

    for (const oldName of Object.keys(config.columns?.rename ?? {})) {
      pushMissing(errors, availableColumns, 'Column rename source', oldName);
    }

    for (const col of config.columns?.hide ?? []) {
      pushMissingWarning(warnings, availableColumns, 'Column to hide', col);
    }

    for (const col of config.columns?.show ?? []) {
      pushMissingWarning(warnings, availableColumns, 'Column to show', col);
    }
  }

  private static validateSort(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const sortCol of config.sort?.columns ?? []) {
      pushMissing(errors, availableColumns, 'Sort field', sortCol.field);
    }
  }

  private static validateClean(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const cleanField of config.clean ?? []) {
      pushMissing(errors, availableColumns, 'Clean field', cleanField.field);
    }
  }

  private static validateDedupe(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    if (!config.dedupe) return;

    for (const field of config.dedupe.partitionBy) {
      pushMissing(errors, availableColumns, 'Dedupe partitionBy field', field);
    }

    for (const orderCol of config.dedupe.orderBy ?? []) {
      pushMissing(errors, availableColumns, 'Dedupe orderBy field', orderCol.field);
    }

    pushMissing(errors, availableColumns, 'Dedupe tieBreaker field', config.dedupe.tieBreaker);
  }

  private static validateCompute(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const compute of config.compute ?? []) {
      if (compute.type === 'bucket') {
        pushMissing(errors, availableColumns, 'Compute bucket field', compute.params?.field);
      }

      if (compute.type === 'amount') {
        pushMissing(errors, availableColumns, 'Compute priceField', compute.params?.priceField);
        pushMissing(
          errors,
          availableColumns,
          'Compute quantityField',
          compute.params?.quantityField
        );
      }

      if (compute.type === 'discount') {
        pushMissing(
          errors,
          availableColumns,
          'Compute originalPriceField',
          compute.params?.originalPriceField
        );
        pushMissing(
          errors,
          availableColumns,
          'Compute discountedPriceField',
          compute.params?.discountedPriceField
        );
      }

      if (compute.type === 'concat') {
        for (const field of compute.params?.fields ?? []) {
          pushMissing(errors, availableColumns, 'Compute concat field', field);
        }
      }
    }
  }

  private static validateValidation(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const validField of config.validation ?? []) {
      pushMissing(errors, availableColumns, 'Validation field', validField.field);

      for (const rule of validField.rules) {
        if (rule.type === 'cross_field') {
          pushMissing(
            errors,
            availableColumns,
            'Validation cross_field compareField',
            rule.params?.compareField
          );
        }
      }
    }
  }

  private static validateExplode(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const explode of config.explode ?? []) {
      pushMissing(errors, availableColumns, 'Explode field', explode.field);
    }
  }

  private static validateLookup(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const lookup of config.lookup ?? []) {
      pushMissing(errors, availableColumns, 'Lookup joinKey field', lookup.joinKey);
    }
  }

  private static validateSample(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    for (const field of config.sample?.stratifyBy ?? []) {
      pushMissing(errors, availableColumns, 'Sample stratifyBy field', field);
    }
  }

  private static validateGroup(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    if (!config.group) return;

    pushMissing(errors, availableColumns, 'Group field', config.group.field);
    for (const field of config.group.statsFields ?? []) {
      pushMissing(errors, availableColumns, 'Group statsField', field);
    }
  }

  private static validateAggregate(
    config: QueryConfig,
    availableColumns: Set<string>,
    errors: string[]
  ): void {
    if (!config.aggregate) return;

    for (const field of config.aggregate.groupBy) {
      pushMissing(errors, availableColumns, 'Aggregate groupBy field', field);
    }

    for (const measure of config.aggregate.measures) {
      pushMissing(errors, availableColumns, 'Aggregate measure field', measure.field);
      pushMissing(errors, availableColumns, 'Aggregate measure argField', measure.params?.argField);
      pushMissing(
        errors,
        availableColumns,
        'Aggregate measure orderBy field',
        measure.params?.orderBy
      );
    }
  }

  private static validateSoftDelete(
    config: QueryConfig,
    availableColumns: Set<string>,
    warnings: string[]
  ): void {
    pushMissingWarning(warnings, availableColumns, 'SoftDelete field', config.softDelete?.field);
  }
}
