/**
 * 列选择构建器
 * 负责列的选择、重命名、隐藏
 */

import type { ColumnConfig, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';

export class ColumnBuilder {
  private hasSelectionBehavior(config?: ColumnConfig): config is ColumnConfig {
    if (!config) {
      return false;
    }

    return (
      (config.select?.length ?? 0) > 0 ||
      (config.hide?.length ?? 0) > 0 ||
      Object.keys(config.rename ?? {}).length > 0
    );
  }

  /**
   * 构建列选择SQL
   */
  build(context: SQLContext, config?: ColumnConfig): string {
    if (!this.hasSelectionBehavior(config)) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    const selectList = this.buildSelectList(context, config);
    return `SELECT ${selectList} FROM ${context.currentTable}`;
  }

  /**
   * 构建 SELECT 列表
   */
  buildSelectList(context: SQLContext, config?: ColumnConfig): string {
    if (!this.hasSelectionBehavior(config)) {
      return '*';
    }

    // 获取所有可用列
    const availableColumns = Array.from(context.availableColumns);

    // 1. 确定要选择的列
    let selectedColumns: string[];
    if (config.select && config.select.length > 0) {
      selectedColumns = config.select;
    } else {
      selectedColumns = availableColumns;
    }

    // 2. 移除隐藏的列
    if (config.hide && config.hide.length > 0) {
      const hideSet = new Set(config.hide);
      selectedColumns = selectedColumns.filter((col) => !hideSet.has(col));
    }

    // 3. 应用重命名
    const selectItems = selectedColumns.map((col) => {
      const escapedCol = SQLUtils.escapeIdentifier(col);

      // 检查是否需要重命名
      if (config.rename && config.rename[col]) {
        const newName = SQLUtils.escapeIdentifier(config.rename[col]);
        return `${escapedCol} AS ${newName}`;
      }

      return escapedCol;
    });

    if (selectItems.length === 0) {
      // 如果没有选择任何列，返回 1（占位符）
      return '1 AS _placeholder';
    }

    return selectItems.join(', ');
  }

  /**
   * 获取列选择后的列名列表（用于更新 context）
   */
  getResultColumns(context: SQLContext, config?: ColumnConfig): Set<string> {
    if (!this.hasSelectionBehavior(config)) {
      return context.availableColumns;
    }

    const availableColumns = Array.from(context.availableColumns);

    // 1. 确定选择的列
    let selectedColumns: string[];
    if (config.select && config.select.length > 0) {
      selectedColumns = config.select;
    } else {
      selectedColumns = availableColumns;
    }

    // 2. 移除隐藏的列
    if (config.hide && config.hide.length > 0) {
      const hideSet = new Set(config.hide);
      selectedColumns = selectedColumns.filter((col) => !hideSet.has(col));
    }

    // 3. 应用重命名
    const resultColumns = selectedColumns.map((col) => {
      if (config.rename && config.rename[col]) {
        return config.rename[col];
      }
      return col;
    });

    return new Set(resultColumns);
  }
}
