import { describe, expect, it } from 'vitest';
import { buildDeletedSchema, buildPatchedColumnSchema, buildRenamedSchema } from '../schemaPatch';

describe('schemaPatch helpers', () => {
  it('buildRenamedSchema should rename the target column and rewrite computed references', () => {
    const schema = [
      {
        name: 'price',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'physical',
      },
      {
        name: 'qty',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'physical',
      },
      {
        name: 'total',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
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
        name: 'summary',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'concat',
          params: {
            fields: ['price', 'qty'],
            separator: '/',
          },
        },
      },
      {
        name: 'rule_flag',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'custom',
          expression: `CASE WHEN "price" > 0 AND price < 100 AND note = 'price' THEN price ELSE 0 END`,
        },
      },
    ];

    const renamed = buildRenamedSchema(schema as any, 'price', 'unit_price');

    expect(renamed.map((column) => column.name)).toEqual([
      'unit_price',
      'qty',
      'total',
      'summary',
      'rule_flag',
    ]);
    expect(renamed[2].computeConfig).toEqual({
      type: 'amount',
      params: {
        priceField: 'unit_price',
        quantityField: 'qty',
      },
    });
    expect(renamed[3].computeConfig).toEqual({
      type: 'concat',
      params: {
        fields: ['unit_price', 'qty'],
        separator: '/',
      },
    });
    expect(renamed[4].computeConfig.expression).toContain('"unit_price" > 0');
    expect(renamed[4].computeConfig.expression).toContain('"unit_price" < 100');
    expect(renamed[4].computeConfig.expression).toContain(`note = 'price'`);
  });

  it('buildDeletedSchema should remove the target column and transitive computed dependencies when forced', () => {
    const schema = [
      {
        name: 'price',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'physical',
      },
      {
        name: 'name',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'physical',
      },
      {
        name: 'total',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'amount',
          params: {
            priceField: 'price',
            quantityField: 'price',
          },
        },
      },
      {
        name: 'total_bucket',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'bucket',
          params: {
            field: 'total',
            boundaries: [100],
            labels: ['Low', 'High'],
          },
        },
      },
      {
        name: 'name_label',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'concat',
          params: {
            fields: ['name'],
            separator: '-',
          },
        },
      },
    ];

    const deleted = buildDeletedSchema(schema as any, 'price', { force: true });

    expect(deleted.map((column) => column.name)).toEqual(['name', 'name_label']);
  });

  it('buildPatchedColumnSchema should replace the target column metadata without mutating siblings', () => {
    const schema = [
      {
        name: 'name',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        metadata: { label: 'Name' },
      },
      {
        name: 'status',
        duckdbType: 'VARCHAR',
        fieldType: 'single_select',
        nullable: true,
        metadata: { options: ['active'] },
      },
    ];

    const next = buildPatchedColumnSchema(schema as any, 'status', {
      metadata: { options: ['active', 'inactive'] },
    });

    expect(next).toEqual([
      {
        name: 'name',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        metadata: { label: 'Name' },
      },
      {
        name: 'status',
        duckdbType: 'VARCHAR',
        fieldType: 'single_select',
        nullable: true,
        metadata: { options: ['active', 'inactive'] },
      },
    ]);
    expect(schema[1].metadata).toEqual({ options: ['active'] });
  });
});
