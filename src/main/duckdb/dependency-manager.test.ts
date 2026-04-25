import { describe, expect, it } from 'vitest';
import { DependencyManager } from './dependency-manager';

describe('DependencyManager', () => {
  it('rebuilds dependency graph from computed schema using shared extraction rules', () => {
    const manager = new DependencyManager();

    manager.rebuildFromSchema([
      {
        name: 'price',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: false,
        storageMode: 'physical',
      },
      {
        name: 'qty',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: false,
        storageMode: 'physical',
      },
      {
        name: 'total',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'custom',
          expression: `CASE WHEN "price" > 0 THEN qty ELSE 0 END`,
        },
      },
      {
        name: 'bucket',
        duckdbType: 'VARCHAR',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'bucket',
          params: {
            field: 'total',
          },
        },
      },
    ] as any);

    expect(manager.getDependency('total')).toEqual({
      columnName: 'total',
      dependsOn: ['price', 'qty'],
      computeType: 'custom',
      expression: `CASE WHEN "price" > 0 THEN qty ELSE 0 END`,
    });
    expect(manager.getAllDependents('price')).toEqual(['total', 'bucket']);
  });
});
