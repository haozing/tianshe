import { describe, expect, it } from 'vitest';
import {
  extractDependenciesFromComputeConfig,
  getDependentComputedColumns,
  replaceIdentifierInExpression,
  rewriteColumnReferenceInComputeConfig,
} from './computed-schema-helpers';

describe('computed schema helpers', () => {
  it('rewrites identifiers in custom expressions without touching string literals', () => {
    const rewritten = replaceIdentifierInExpression(
      `CASE WHEN "price" > 0 AND price < 100 AND note = 'price' THEN price ELSE 0 END`,
      'price',
      'unit_price'
    );

    expect(rewritten).toContain('"unit_price" > 0');
    expect(rewritten).toContain('"unit_price" < 100');
    expect(rewritten).toContain(`note = 'price'`);
  });

  it('rewrites structured compute configs consistently', () => {
    expect(
      rewriteColumnReferenceInComputeConfig(
        {
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'qty',
          },
        },
        'price',
        'unit_price'
      )
    ).toEqual({
      type: 'amount',
      params: {
        priceField: 'unit_price',
        quantityField: 'qty',
      },
    });
  });

  it('extracts dependencies from custom expressions and resolves transitive computed dependents', () => {
    expect(
      extractDependenciesFromComputeConfig({
        type: 'custom',
        expression: `CASE WHEN "price" > 0 THEN qty ELSE 0 END`,
      })
    ).toEqual(['price', 'qty']);

    const schema = [
      { name: 'price', storageMode: 'physical' },
      { name: 'qty', storageMode: 'physical' },
      {
        name: 'total',
        storageMode: 'computed',
        computeConfig: {
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'qty',
          },
        },
      },
      {
        name: 'bucket',
        storageMode: 'computed',
        computeConfig: {
          type: 'bucket',
          params: {
            field: 'total',
          },
        },
      },
    ];

    expect(getDependentComputedColumns(schema as any, 'price')).toEqual(['total', 'bucket']);
  });
});
