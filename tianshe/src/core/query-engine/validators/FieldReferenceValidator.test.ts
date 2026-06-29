import { describe, expect, it } from 'vitest';
import { FieldReferenceValidator } from './FieldReferenceValidator';
import type { QueryConfig } from '../types';

describe('FieldReferenceValidator', () => {
  const availableColumns = new Set(['id', 'name', 'age', 'price', 'deleted_at']);

  it('collects field reference errors across query sections', () => {
    const config: QueryConfig = {
      filter: { conditions: [{ type: 'equal', field: 'missing_filter', value: 'x' }] },
      sort: { columns: [{ field: 'missing_sort', direction: 'ASC' }] },
      compute: [
        {
          name: 'amount',
          type: 'amount',
          params: { priceField: 'price', quantityField: 'missing_quantity' },
        },
      ],
      aggregate: {
        groupBy: ['name'],
        measures: [
          {
            name: 'first_age',
            function: 'FIRST',
            field: 'age',
            params: { orderBy: 'missing_order' },
          },
        ],
      },
    };

    const result = FieldReferenceValidator.validate(config, availableColumns);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Filter field 'missing_filter' does not exist in dataset",
        "Sort field 'missing_sort' does not exist in dataset",
        "Compute quantityField 'missing_quantity' does not exist in dataset",
        "Aggregate measure orderBy field 'missing_order' does not exist in dataset",
      ])
    );
    expect(result.warnings).toEqual([]);
  });

  it('treats optional display-only missing fields as warnings', () => {
    const config: QueryConfig = {
      softDelete: { field: 'deleted_on', show: 'active' },
      columns: {
        hide: ['missing_hidden'],
        show: ['missing_shown'],
      },
    };

    const result = FieldReferenceValidator.validate(config, availableColumns);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "SoftDelete field 'deleted_on' does not exist in dataset, will be ignored",
        "Column to hide 'missing_hidden' does not exist in dataset, will be ignored",
        "Column to show 'missing_shown' does not exist in dataset, will be ignored",
      ])
    );
  });
});
