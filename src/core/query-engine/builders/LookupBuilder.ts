/**
 * Lookup构建器
 * 负责维表关联（JOIN）和码值映射
 */

import type { LookupConfig, SQLContext } from '../types';
import type { IDatasetResolver } from '../interfaces/IDatasetResolver';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class LookupBuilder {
  constructor(private datasetResolver: IDatasetResolver) {}

  private static readonly SYSTEM_COLUMNS = new Set([
    '_row_id',
    'deleted_at',
    'created_at',
    'updated_at',
  ]);

  /**
   * 构建 Lookup SQL
   */
  async build(context: SQLContext, configs: LookupConfig[]): Promise<string> {
    if (!configs || configs.length === 0) return '';

    let currentTable = context.currentTable;

    // 用于避免跨多次 lookup 产生重复列名（JS 结果对象会被覆盖）
    const availableColumns = new Set(context.availableColumns);

    const ctes: string[] = [];
    let lastCteName = '';

    for (let index = 0; index < configs.length; index += 1) {
      const config = configs[index];
      const cteName = `_lookup_${index}`;

      let stepSQL: string;
      if (config.type === 'join') {
        stepSQL = await this.buildJoinLookup(currentTable, config, availableColumns);
      } else if (config.type === 'map') {
        stepSQL = this.buildMapLookup(currentTable, config, availableColumns);
        availableColumns.add(config.lookupKey);
      } else {
        throw QueryErrorFactory.unsupportedOperation((config as any).type, 'lookup');
      }

      ctes.push(`${cteName} AS (${stepSQL})`);
      currentTable = cteName;
      lastCteName = cteName;
    }

    return `WITH ${ctes.join(', ')} SELECT * FROM ${lastCteName}`.trim();
  }

  /**
   * 构建 JOIN 类型的 Lookup
   */
  private async buildJoinLookup(
    currentTable: string,
    config: LookupConfig,
    usedColumnNames: Set<string>
  ): Promise<string> {
    this.ensureFieldExists(config.joinKey, usedColumnNames);

    // 获取维表名称
    let lookupTableName: string;

    if (config.lookupTable) {
      const tableRef = config.lookupTable.trim();
      if (!SQLUtils.isValidTableReference(tableRef)) {
        throw QueryErrorFactory.invalidParam(
          'lookup.lookupTable',
          config.lookupTable,
          'Invalid table reference. Expected identifier or schema.table'
        );
      }
      lookupTableName = tableRef;
    } else if (config.lookupDatasetId) {
      // 🆕 使用IDatasetResolver接口获取表名
      lookupTableName = await this.datasetResolver.getDatasetTableName(config.lookupDatasetId);
    } else {
      throw QueryErrorFactory.missingParam('lookupTable or lookupDatasetId', 'lookup join');
    }

    const joinType = config.leftJoin ? 'LEFT JOIN' : 'INNER JOIN';
    const joinKey = SQLUtils.escapeIdentifier(config.joinKey);
    const lookupKey = SQLUtils.escapeIdentifier(config.lookupKey);
    const lookupDatasetColumns = await this.getLookupDatasetColumns(config.lookupDatasetId);

    if (lookupDatasetColumns && !lookupDatasetColumns.has(config.lookupKey)) {
      throw QueryErrorFactory.fieldNotFound(config.lookupKey, [...lookupDatasetColumns]);
    }

    const mainAlias = 'main_table';
    const selectItems: string[] = [`${mainAlias}.*`];

    // 选择要从维表带回的列（必要时自动改名，避免列名冲突）
    const lookupSelectItems = await this.buildJoinSelectItems(
      config,
      usedColumnNames,
      'lookup_table'
    );
    selectItems.push(...lookupSelectItems);

    return `
      SELECT ${selectItems.join(', ')}
      FROM ${currentTable} AS ${mainAlias}
      ${joinType} ${lookupTableName} AS lookup_table
        ON ${mainAlias}.${joinKey} = lookup_table.${lookupKey}
    `.trim();
  }

  private buildLookupSelectItem(
    sourceColumnName: string,
    usedColumnNames: Set<string>,
    tableAlias: string = 'lookup_table'
  ): { outputName: string; sql: string } {
    const sourceRef = `${tableAlias}.${SQLUtils.escapeIdentifier(sourceColumnName)}`;

    let outputName = sourceColumnName;
    if (usedColumnNames.has(outputName)) {
      outputName = this.makeUniqueColumnName(`lookup_${sourceColumnName}`, usedColumnNames);
    }

    usedColumnNames.add(outputName);

    if (outputName === sourceColumnName) {
      return { outputName, sql: sourceRef };
    }

    return {
      outputName,
      sql: `${sourceRef} AS ${SQLUtils.escapeIdentifier(outputName)}`,
    };
  }

  private makeUniqueColumnName(base: string, usedColumnNames: Set<string>): string {
    if (!usedColumnNames.has(base)) return base;

    let suffix = 2;
    while (usedColumnNames.has(`${base}_${suffix}`)) {
      suffix += 1;
    }

    return `${base}_${suffix}`;
  }

  private ensureFieldExists(fieldName: string, availableColumns: Set<string>): void {
    if (!availableColumns.has(fieldName)) {
      throw QueryErrorFactory.fieldNotFound(fieldName, [...availableColumns]);
    }
  }

  private async getLookupDatasetColumns(lookupDatasetId?: string): Promise<Set<string> | null> {
    if (!lookupDatasetId) return null;

    const dataset = await this.datasetResolver.getDatasetInfo(lookupDatasetId);
    if (!dataset?.schema || !Array.isArray(dataset.schema)) return null;

    return new Set(
      dataset.schema
        .map((col) => String(col.name))
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    );
  }

  private ensureMapOutputColumnAvailable(outputName: string, usedColumnNames: Set<string>): void {
    if (!outputName.trim()) {
      throw QueryErrorFactory.invalidParam(
        'lookup.lookupKey',
        outputName,
        'Output column is empty'
      );
    }

    if (LookupBuilder.SYSTEM_COLUMNS.has(outputName) || usedColumnNames.has(outputName)) {
      throw QueryErrorFactory.invalidParam(
        'lookup.lookupKey',
        outputName,
        `Output column '${outputName}' conflicts with an existing column`
      );
    }
  }

  async resolveJoinSelectColumns(config: LookupConfig): Promise<string[]> {
    if (Array.isArray(config.selectColumns)) {
      const columns = config.selectColumns.map((col) => col.trim()).filter((col) => col.length > 0);
      const lookupDatasetColumns = await this.getLookupDatasetColumns(config.lookupDatasetId);

      if (lookupDatasetColumns) {
        const missingColumns = columns.filter((col) => !lookupDatasetColumns.has(col));
        if (missingColumns.length > 0) {
          throw QueryErrorFactory.invalidParam(
            'lookup.selectColumns',
            config.selectColumns,
            `Columns not found in lookup dataset: ${missingColumns.join(', ')}`
          );
        }
      }

      return columns;
    }

    if (!config.lookupDatasetId) return [];

    const dataset = await this.datasetResolver.getDatasetInfo(config.lookupDatasetId);
    if (!dataset?.schema || !Array.isArray(dataset.schema)) return [];

    return dataset.schema
      .map((col) => String(col.name))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .filter((name) => !LookupBuilder.SYSTEM_COLUMNS.has(name));
  }

  /**
   * 构建 JOIN 需要从维表带回的 SELECT 项（含冲突自动改名）
   */
  async buildJoinSelectItems(
    config: LookupConfig,
    usedColumnNames: Set<string>,
    tableAlias: string = 'lookup_table'
  ): Promise<string[]> {
    const selectColumns = await this.resolveJoinSelectColumns(config);
    const items: string[] = [];
    for (const col of selectColumns) {
      const { sql } = this.buildLookupSelectItem(col, usedColumnNames, tableAlias);
      items.push(sql);
    }
    return items;
  }

  /**
   * 构建 MAP 类型的 Lookup（码值映射）
   */
  private buildMapLookup(
    currentTable: string,
    config: LookupConfig,
    currentColumns: Set<string>
  ): string {
    if (!config.codeMapping) {
      throw QueryErrorFactory.missingParam('codeMapping', 'lookup map');
    }

    this.ensureFieldExists(config.joinKey, currentColumns);
    this.ensureMapOutputColumnAvailable(config.lookupKey, currentColumns);

    const field = SQLUtils.escapeIdentifier(config.joinKey);
    const outputField = SQLUtils.escapeIdentifier(config.lookupKey);

    // 构建 CASE WHEN 语句
    let caseExpression = 'CASE';

    for (const [code, value] of Object.entries(config.codeMapping)) {
      const quotedCode = SQLUtils.quoteValue(code);
      const quotedValue = SQLUtils.quoteValue(value);
      caseExpression += `\n  WHEN ${field} = ${quotedCode} THEN ${quotedValue}`;
    }

    caseExpression += `\n  ELSE ${field}\nEND`;

    return `
      SELECT *,
        ${caseExpression} AS ${outputField}
      FROM ${currentTable}
    `.trim();
  }

  /**
   * 获取 Lookup 后的列名列表（用于更新 context）
   */
  async getResultColumns(context: SQLContext, configs: LookupConfig[]): Promise<Set<string>> {
    const resultColumns = new Set(context.availableColumns);

    for (const config of configs) {
      if (config.type === 'join') {
        const selectColumns = await this.resolveJoinSelectColumns(config);
        // 添加从维表选择的列（必要时自动改名，避免列名冲突）
        for (const col of selectColumns) {
          const outputName = resultColumns.has(col)
            ? this.makeUniqueColumnName(`lookup_${col}`, resultColumns)
            : col;
          resultColumns.add(outputName);
        }
      } else if (config.type === 'map') {
        // 添加映射输出列
        this.ensureFieldExists(config.joinKey, resultColumns);
        this.ensureMapOutputColumnAvailable(config.lookupKey, resultColumns);
        resultColumns.add(config.lookupKey);
      }
    }

    return resultColumns;
  }
}
