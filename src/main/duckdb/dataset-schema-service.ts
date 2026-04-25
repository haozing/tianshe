/**
 * DatasetSchemaService - 数据集 Schema 服务
 *
 * 职责：
 * - 列的增删改操作
 * - 计算列的管理和表达式构建
 * - 列依赖关系检查
 * - 类型推断和映射
 * - 字段特殊处理（自增、UUID、JSON等）
 * - 默认值填充
 *
 * 🧮 最复杂的服务，涉及类型推断、表达式验证、依赖管理
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { sanitizeDatasetId, DatasetStorageService } from './dataset-storage-service';
import { DatasetMetadataService } from './dataset-metadata-service';
import { SQLValidator } from './sql-validator';
import { DependencyManager } from './dependency-manager';
import { ValidationEngine } from './validation-engine';
import type { Dataset, ValidationRule } from './types';
import { escapeSqlStringLiteral, quoteIdentifier, quoteQualifiedName } from './utils';
import {
  doesComputeColumnDependOn,
  extractDependenciesFromComputeConfig,
  getDependentComputedColumns,
  rewriteColumnReferencesInSchema,
} from '../../utils/computed-schema-helpers';

export class DatasetSchemaService {
  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService,
    private storageService: DatasetStorageService,
    private sqlValidator: SQLValidator,
    private dependencyManager: DependencyManager,
    private validationEngine: ValidationEngine
  ) {}

  // ==================== 主列操作方法 ====================

  /**
   * ➕ 添加列到数据集
   *
   * 完整的7步流程：
   * 1. 验证列名唯一性
   * 2. 验证计算列的SQL表达式和依赖关系
   * 3. 确定 DuckDB 类型
   * 4. 创建物理列（如需要）
   * 5. 更新 schema 元数据
   * 6. 处理默认值
   * 7. 复制数据（如指定）
   */
  async addColumn(params: {
    datasetId: string;
    columnName: string;
    fieldType: string;
    nullable: boolean;
    duckdbTypeOverride?: string;
    metadata?: any;
    storageMode?: 'physical' | 'computed';
    computeConfig?: any;
    validationRules?: ValidationRule[];
    copyDataFrom?: string;
  }): Promise<void> {
    const {
      datasetId,
      columnName,
      fieldType,
      nullable,
      duckdbTypeOverride,
      metadata = {},
      storageMode = 'physical',
      computeConfig,
      validationRules = [],
      copyDataFrom,
    } = params;

    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 🔄 使用队列机制执行添加列操作，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${safeDatasetId}`);
      }
      this.dependencyManager.rebuildFromSchema(dataset.schema || []);

      // ========== 第1步：验证列名唯一性 ==========
      if (dataset.schema) {
        const exists = dataset.schema.some((col) => col.name === columnName);
        if (exists) {
          throw new Error(`列"${columnName}"已存在`);
        }
      }

      // ========== 第2步：验证计算列的SQL表达式和依赖关系 ==========
      if (storageMode === 'computed') {
        // 确保数据集已 ATTACH（验证表达式需要引用 ds_<id>.data）
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(safeDatasetId, escapedPath);
        await this.validateComputeConfig(safeDatasetId, computeConfig);
        const normalizedComputeConfig = computeConfig!;

        // 2.1 提取依赖的列
        const schemaColumnNames = new Set((dataset.schema || []).map((col) => col.name));
        const rawDependsOn = extractDependenciesFromComputeConfig(normalizedComputeConfig);
        if (normalizedComputeConfig.type !== 'custom') {
          const missingDependencies = rawDependsOn.filter((dep) => !schemaColumnNames.has(dep));
          if (missingDependencies.length > 0) {
            throw new Error(`依赖列不存在: ${missingDependencies.join(', ')}`);
          }
        }
        const dependsOn = rawDependsOn.filter((dep) => schemaColumnNames.has(dep));

        // 2.2 检查循环依赖
        const cycleCheck = this.dependencyManager.checkCyclicDependency(columnName, dependsOn);
        if (cycleCheck.hasCycle) {
          throw new Error(`检测到循环依赖: ${cycleCheck.cycle?.join(' → ')}`);
        }

        console.log(`✓ 依赖关系检查通过，依赖列: [${dependsOn.join(', ')}]`);
      }

      // ========== 第3步：确定 DuckDB 类型 ==========
      let duckdbType: string;
      if (storageMode === 'computed') {
        // 计算列：根据计算类型推断 DuckDB 类型
        duckdbType = this.inferComputeColumnType(computeConfig!);
      } else if (duckdbTypeOverride) {
        duckdbType = duckdbTypeOverride;
      } else {
        // 数据列：根据字段类型映射
        duckdbType = this.mapFieldTypeToDuckDB(fieldType, metadata);
      }

      // ========== 第4步：判断是否需要创建物理列 ==========
      const needsPhysicalColumn =
        storageMode === 'physical' && !['button', 'attachment'].includes(fieldType);

      if (needsPhysicalColumn) {
        // 4.1 创建物理列
        await this.createPhysicalColumn({
          datasetId: safeDatasetId,
          filePath: dataset.filePath,
          columnName,
          duckdbType,
          nullable,
        });

        // 4.2 应用验证规则（转换为数据库约束）
        if (validationRules.length > 0) {
          try {
            await this.validationEngine.applyValidationRules({
              datasetId: safeDatasetId,
              filePath: dataset.filePath,
              columnName,
              rules: validationRules,
            });
            console.log(`✓ 已应用 ${validationRules.length} 条验证规则`);
          } catch (error: any) {
            console.error(`⚠ 验证规则应用失败:`, error.message);
            // 不中断流程，只是警告
          }
        }

        // 4.3 处理特殊字段类型
        await this.handleSpecialFieldTypes(
          safeDatasetId,
          dataset.filePath,
          columnName,
          fieldType,
          metadata
        );
      }

      // ========== 第5步：更新 schema 元数据 ==========
      const newColumn: any = {
        name: columnName,
        duckdbType,
        fieldType,
        nullable,
        storageMode,
        validationRules,
      };

      // 根据存储模式设置不同的配置
      if (storageMode === 'computed') {
        newColumn.computeConfig = computeConfig!;

        // 🆕 添加到依赖管理器
        const schemaColumnNames = new Set((dataset.schema || []).map((col) => col.name));
        const dependsOn = extractDependenciesFromComputeConfig(computeConfig!).filter((dep) =>
          schemaColumnNames.has(dep)
        );
        this.dependencyManager.addDependency({
          columnName,
          dependsOn,
          computeType: computeConfig!.type,
          expression: computeConfig!.expression,
        });
      } else {
        newColumn.metadata = metadata;
      }

      const updatedSchema = [...(dataset.schema || []), newColumn];
      await this.metadataService.updateDatasetSchema(safeDatasetId, updatedSchema);
      this.dependencyManager.rebuildFromSchema(updatedSchema);

      // ========== 第6步：处理默认值（仅数据列） ==========
      if (
        storageMode === 'physical' &&
        metadata.defaultValue !== undefined &&
        metadata.defaultValue !== null &&
        metadata.defaultValue !== ''
      ) {
        await this.fillDefaultValue(
          safeDatasetId,
          dataset.filePath,
          columnName,
          metadata.defaultValue
        );
      }

      // ========== 第7步：复制数据（如果指定了源列） ==========
      if (storageMode === 'physical' && copyDataFrom && needsPhysicalColumn) {
        // 验证源列是否存在
        const sourceColumn = dataset.schema?.find((col) => col.name === copyDataFrom);
        if (!sourceColumn) {
          throw new Error(`源列 "${copyDataFrom}" 不存在`);
        }

        // 执行数据复制
        try {
          const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
          await this.storageService.smartAttach(safeDatasetId, escapedPath);
          const tableRef = quoteQualifiedName(`ds_${safeDatasetId}`, 'data');

          const quotedTarget = quoteIdentifier(columnName);
          const quotedSource = quoteIdentifier(copyDataFrom);
          await this.conn.run(`
            UPDATE ${tableRef}
            SET ${quotedTarget} = ${quotedSource}
          `);

          console.log(`✓ 已从 "${copyDataFrom}" 复制数据到 "${columnName}"`);
        } catch (error: any) {
          console.error(`⚠ 数据复制失败:`, error.message);
          // 不中断流程，新列已创建
        } finally {
          // ✅ ATTACH 保持有效，供 VIEW 使用
          // DuckDB 会在连接关闭时自动清理
        }
      }

      const columnType = storageMode === 'computed' ? '计算列' : '数据列';
      console.log(
        `✅ 成功添加${columnType}: ${columnName} (${fieldType}) 到数据集: ${safeDatasetId}`
      );
    });
  }

  /**
   * ✏️ 更新列属性
   */
  async updateColumn(params: {
    datasetId: string;
    columnName: string;
    newName?: string;
    fieldType?: string;
    nullable?: boolean;
    metadata?: any;
    computeConfig?: any;
  }): Promise<void> {
    const { datasetId, columnName, newName, fieldType, nullable, metadata, computeConfig } = params;
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset || !dataset.schema) {
        throw new Error(`Dataset not found or has no schema: ${safeDatasetId}`);
      }

      this.dependencyManager.rebuildFromSchema(dataset.schema);

      const columnIndex = dataset.schema.findIndex((col) => col.name === columnName);
      if (columnIndex === -1) {
        throw new Error(`列"${columnName}"不存在`);
      }

      const column = dataset.schema[columnIndex];
      const targetName = newName?.trim() || columnName;
      const isRenaming = targetName !== columnName;

      if (isRenaming) {
        const exists = dataset.schema.some((col) => col.name === targetName);
        if (exists) {
          throw new Error(`列"${targetName}"已存在`);
        }
      }

      const updatedColumn: any = {
        ...column,
        name: targetName,
      };

      if (fieldType !== undefined) updatedColumn.fieldType = fieldType;
      if (nullable !== undefined) updatedColumn.nullable = nullable;

      if (column.storageMode === 'computed') {
        if (computeConfig !== undefined) {
          if (!computeConfig || !computeConfig.type) {
            throw new Error('计算列缺少 computeConfig.type');
          }
          updatedColumn.computeConfig = computeConfig;
          updatedColumn.duckdbType = this.inferComputeColumnType(computeConfig);
        }
      } else {
        if (metadata !== undefined) {
          updatedColumn.metadata = { ...column.metadata, ...metadata };
        }
        if (fieldType !== undefined) {
          updatedColumn.duckdbType = this.mapFieldTypeToDuckDB(
            updatedColumn.fieldType,
            updatedColumn.metadata
          );
        }
      }

      const isPhysicalColumn = this.isPhysicalStoredColumn(column);
      if (isPhysicalColumn) {
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(safeDatasetId, escapedPath);

        const tableRef = quoteQualifiedName(`ds_${safeDatasetId}`, 'data');

        if (isRenaming) {
          await this.conn.run(
            `ALTER TABLE ${tableRef} RENAME COLUMN ${quoteIdentifier(columnName)} TO ${quoteIdentifier(targetName)}`
          );
        }

        const typeChanged = updatedColumn.duckdbType !== column.duckdbType;
        if (typeChanged) {
          await this.conn.run(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(targetName)} SET DATA TYPE ${updatedColumn.duckdbType}`
          );
        }

        if (nullable !== undefined && nullable !== column.nullable) {
          if (nullable) {
            await this.conn.run(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(targetName)} DROP NOT NULL`
            );
          } else {
            await this.conn.run(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(targetName)} SET NOT NULL`
            );
          }
        }

        if (fieldType !== undefined && fieldType !== column.fieldType) {
          await this.handleSpecialFieldTypes(
            safeDatasetId,
            dataset.filePath,
            targetName,
            updatedColumn.fieldType,
            updatedColumn.metadata || {}
          );
        }
      }

      let updatedSchema = [...dataset.schema];
      updatedSchema[columnIndex] = updatedColumn;

      if (isRenaming) {
        updatedSchema = rewriteColumnReferencesInSchema(updatedSchema, columnName, targetName);
      }

      const updatedTargetColumn =
        updatedSchema.find((col) => col.name === targetName) || updatedColumn;
      if (updatedTargetColumn.storageMode === 'computed' && updatedTargetColumn.computeConfig) {
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(safeDatasetId, escapedPath);
        await this.validateComputeConfig(safeDatasetId, updatedTargetColumn.computeConfig);

        const schemaColumnNames = new Set(updatedSchema.map((col) => col.name));
        const rawDependsOn = extractDependenciesFromComputeConfig(updatedTargetColumn.computeConfig);
        if (updatedTargetColumn.computeConfig.type !== 'custom') {
          const missingDependencies = rawDependsOn.filter((dep) => !schemaColumnNames.has(dep));
          if (missingDependencies.length > 0) {
            throw new Error(`依赖列不存在: ${missingDependencies.join(', ')}`);
          }
        }
        const dependsOn = rawDependsOn.filter((dep) => schemaColumnNames.has(dep));
        const schemaWithoutSelf = updatedSchema.filter((col) => col.name !== updatedTargetColumn.name);
        this.dependencyManager.rebuildFromSchema(schemaWithoutSelf as any);
        const cycleCheck = this.dependencyManager.checkCyclicDependency(
          updatedTargetColumn.name,
          dependsOn
        );
        if (cycleCheck.hasCycle) {
          throw new Error(`检测到循环依赖: ${cycleCheck.cycle?.join(' → ')}`);
        }
      }

      if (isRenaming) {
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(safeDatasetId, escapedPath);
        for (const schemaColumn of updatedSchema) {
          if (schemaColumn.storageMode !== 'computed' || !schemaColumn.computeConfig) {
            continue;
          }
          await this.validateComputeConfig(safeDatasetId, schemaColumn.computeConfig);
        }
      }

      await this.metadataService.updateDatasetSchema(safeDatasetId, updatedSchema);
      this.dependencyManager.rebuildFromSchema(updatedSchema);

      console.log(`✅ 成功更新列: ${columnName} → ${targetName}`);
    });
  }

  /**
   * ➖ 删除列
   *
   * 包含依赖检查，如果有计算列依赖此列，需要 force=true 才能删除
   */
  async deleteColumn(datasetId: string, columnName: string, force: boolean = false): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 🔄 使用队列机制执行删除，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset || !dataset.schema) {
        throw new Error(`Dataset not found: ${safeDatasetId}`);
      }
      this.dependencyManager.rebuildFromSchema(dataset.schema);

      // 查找要删除的列
      const column = dataset.schema.find((col) => col.name === columnName);
      if (!column) {
        throw new Error(`列"${columnName}"不存在`);
      }

      // 检查依赖关系
      const dependencies = getDependentComputedColumns(dataset.schema!, columnName);
      if (dependencies.length > 0 && !force) {
        throw new Error(
          `无法删除列"${columnName}"，因为以下计算列依赖它：${dependencies.join(', ')}。\n` +
            `如需强制删除（同时删除依赖的计算列），请使用 force 参数。`
        );
      }

      // 如果是物理列，需要删除数据库中的列
      const isPhysicalColumn =
        column.storageMode !== 'computed' && !['button', 'attachment'].includes(column.fieldType);

      if (isPhysicalColumn) {
        // 数据集表统一使用独立文件 + ds_<id>.data（包括 plugin__ 数据集）
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await this.storageService.smartAttach(safeDatasetId, escapedPath);

        const quotedColumn = quoteIdentifier(columnName);
        await this.conn.run(
          `ALTER TABLE ${quoteQualifiedName(`ds_${safeDatasetId}`, 'data')} DROP COLUMN ${quotedColumn}`
        );
        console.log(`✅ Dropped column from dataset table: ${safeDatasetId}.data.${columnName}`);
      }

      // 更新 schema 元数据
      const updatedSchema = dataset.schema!.filter((col) => {
        // 移除目标列
        if (col.name === columnName) return false;
        // 如果 force=true，移除依赖的计算列
        if (force && dependencies.includes(col.name)) return false;
        return true;
      });

      await this.metadataService.updateDatasetSchema(safeDatasetId, updatedSchema);
      this.dependencyManager.rebuildFromSchema(updatedSchema);

      const deletedColumns =
        force && dependencies.length > 0
          ? `${columnName} 及其依赖的计算列: ${dependencies.join(', ')}`
          : columnName;
      console.log(`✅ 成功删除列: ${deletedColumns} 从数据集: ${safeDatasetId}`);
    });
  }

  // ==================== 计算列相关方法 ====================

  /**
   * 🧬 提取数据集中的所有计算列
   */
  extractComputedColumns(dataset: Dataset): Array<{ name: string; config: any }> {
    if (!dataset.schema) return [];

    return dataset.schema
      .filter((col) => col.storageMode === 'computed' && col.computeConfig)
      .map((col) => ({
        name: col.name,
        config: col.computeConfig!,
      }));
  }

  /**
   * 🔧 包装SQL为包含计算列的CTE
   *
   * 生成格式：
   * WITH base_data AS (原始SQL)
   * SELECT *, 计算列1, 计算列2, ... FROM base_data
   */
  wrapWithComputedColumns(
    originalSql: string,
    computedColumns: Array<{ name: string; config: any }>
  ): string {
    // 生成计算列表达式
    const computedExpressions = computedColumns.map(({ name, config }) => {
      const expr = this.buildComputeExpression(config);
      return `${expr} AS "${name}"`;
    });

    // 构建 CTE：先查询原始数据，再添加计算列
    const cte = `
WITH base_data AS (
  ${originalSql}
)
SELECT
  *,
  ${computedExpressions.join(',\n  ')}
FROM base_data
    `.trim();

    return cte;
  }

  /**
   * 🔧 构建计算表达式
   *
   * 根据计算类型生成相应的SQL表达式
   */
  buildComputeExpression(config: any): string {
    const params = config.params || {};

    switch (config.type) {
      case 'amount':
        if (!params.priceField || !params.quantityField) {
          throw new Error('amount compute requires priceField and quantityField');
        }
        return `(${quoteIdentifier(params.priceField)}::DOUBLE * ${quoteIdentifier(params.quantityField)}::DOUBLE)`;

      case 'discount': {
        if (!params.originalPriceField || !params.discountedPriceField) {
          throw new Error('discount compute requires originalPriceField and discountedPriceField');
        }
        const originalPrice = quoteIdentifier(params.originalPriceField);
        const discountedPrice = quoteIdentifier(params.discountedPriceField);

        if (params.discountType === 'percentage') {
          return `
            CASE
              WHEN ${originalPrice}::DOUBLE = 0 THEN 0
              ELSE ((${originalPrice}::DOUBLE - ${discountedPrice}::DOUBLE) / ${originalPrice}::DOUBLE * 100)
            END
          `.trim();
        } else {
          return `(${originalPrice}::DOUBLE - ${discountedPrice}::DOUBLE)`;
        }
      }

      case 'bucket':
        if (!params.field || !params.boundaries) {
          throw new Error('bucket compute requires field and boundaries');
        }
        return this.buildBucketExpression(params);

      case 'concat': {
        if (!params.fields || params.fields.length === 0) {
          throw new Error('concat compute requires fields');
        }
        const fields = params.fields.map((f: string) => `COALESCE(CAST(${quoteIdentifier(f)} AS VARCHAR), '')`);
        const separator = params.separator || '';
        return `CONCAT_WS('${escapeSqlStringLiteral(String(separator))}', ${fields.join(', ')})`;
      }

      case 'custom': {
        if (!config.expression) {
          throw new Error('custom compute requires expression');
        }
        // 简单的安全检查：禁止 DROP, DELETE, UPDATE, INSERT
        const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER'];
        const expression = String(config.expression);
        const expressionForKeywordCheck = expression.replace(/'([^']|'')*'/g, ' ');
        for (const keyword of dangerousKeywords) {
          const regex = new RegExp(`\\b${keyword}\\b`, 'i');
          if (regex.test(expressionForKeywordCheck)) {
            throw new Error(`Dangerous keyword '${keyword}' not allowed in custom expression`);
          }
        }
        return expression.trim();
      }

      default:
        throw new Error(`Unsupported compute type: ${config.type}`);
    }
  }

  /**
   * 📦 构建分桶表达式
   *
   * 生成 CASE WHEN 语句进行数值分组
   */
  buildBucketExpression(params: any): string {
    const field = quoteIdentifier(String(params.field));
    const boundaries: number[] = Array.isArray(params.boundaries)
      ? params.boundaries.map((value: any) => Number(value))
      : [];
    const labels = Array.isArray(params.labels) ? params.labels : [];

    if (boundaries.length === 0 || boundaries.some((boundary) => !Number.isFinite(boundary))) {
      throw new Error('bucket compute boundaries must be finite numbers');
    }

    let caseExpression = 'CASE';

    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      const labelValue = labels[i] ? String(labels[i]) : `Bucket ${i}`;
      const label = `'${escapeSqlStringLiteral(labelValue)}'`;

      if (i === 0) {
        caseExpression += `\n  WHEN ${field}::DOUBLE < ${boundary} THEN ${label}`;
      } else {
        const prevBoundary = boundaries[i - 1];
        caseExpression += `\n  WHEN ${field}::DOUBLE >= ${prevBoundary} AND ${field}::DOUBLE < ${boundary} THEN ${label}`;
      }
    }

    // 最后一个桶
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastLabelValue = labels[boundaries.length]
      ? String(labels[boundaries.length])
      : `Bucket ${boundaries.length}`;
    const lastLabel = `'${escapeSqlStringLiteral(lastLabelValue)}'`;
    caseExpression += `\n  WHEN ${field}::DOUBLE >= ${lastBoundary} THEN ${lastLabel}`;
    caseExpression += `\n  ELSE 'Unknown'\nEND`;

    return caseExpression;
  }

  // ==================== 依赖管理和类型推断 ====================

  /**
   * 🔍 检查列依赖关系
   *
   * 返回所有依赖指定列的计算列列表
   */
  checkColumnDependencies(dataset: Dataset, columnName: string): string[] {
    if (!dataset.schema) return [];

    const schemaColumnNames = new Set(dataset.schema.map((col) => col.name));
    return dataset.schema
      .filter((col) => doesComputeColumnDependOn(col, columnName, schemaColumnNames))
      .map((col) => col.name);
  }

  /**
   * 🔗 从计算配置中提取依赖列
   */
  private isPhysicalStoredColumn(column: any): boolean {
    return column.storageMode !== 'computed' && !['button', 'attachment'].includes(column.fieldType);
  }

  private async validateComputeConfig(datasetId: string, computeConfig: any): Promise<void> {
    if (!computeConfig || !computeConfig.type) {
      throw new Error('计算列缺少 computeConfig.type');
    }

    // 先做结构校验（参数完整性、危险关键字等）
    this.buildComputeExpression(computeConfig);

    if (computeConfig.type === 'custom' && computeConfig.expression) {
      const validationResult = await this.sqlValidator.validateExpression({
        datasetId,
        expression: computeConfig.expression,
        tableName: `ds_${datasetId}.data`,
        tableSchema: `ds_${datasetId}`,
        baseTableName: 'data',
      });

      if (!validationResult.valid) {
        throw new Error(`SQL表达式验证失败: ${validationResult.error}`);
      }
    }
  }

  /**
   * 🎯 推断计算列的 DuckDB 类型
   */
  private inferComputeColumnType(computeConfig: any): string {
    if (!computeConfig || !computeConfig.type) {
      return 'VARCHAR';
    }

    switch (computeConfig.type) {
      case 'amount':
      case 'discount':
        return 'DOUBLE'; // 金额和折扣都是浮点数

      case 'bucket':
        return 'VARCHAR'; // 分组标签是文本

      case 'concat':
        return 'VARCHAR'; // 拼接结果是文本

      case 'custom':
        // 自定义表达式的类型无法准确推断，默认 VARCHAR
        // 用户可以在表达式中使用 CAST 来指定类型
        return 'VARCHAR';

      default:
        return 'VARCHAR';
    }
  }

  /**
   * 🗺️ 映射字段类型到 DuckDB 类型
   */
  private mapFieldTypeToDuckDB(fieldType: string, metadata: any): string {
    switch (fieldType) {
      // 基础文本类型
      case 'text':
      case 'single_select':
      case 'multi_select':
      case 'hyperlink':
      case 'button':
      case 'attachment':
        return 'VARCHAR';

      // 语义类型（底层是VARCHAR，通过验证规则区分）
      case 'email':
      case 'url':
      case 'phone':
        return 'VARCHAR';

      // 数字类型
      case 'number':
        // 根据格式判断
        if (metadata?.format === 'integer') {
          return 'BIGINT';
        }
        return 'DOUBLE';

      case 'auto_increment':
        return 'BIGINT'; // 自增ID使用BIGINT

      // 布尔类型
      case 'boolean':
        return 'BOOLEAN';

      // 日期时间类型
      case 'date':
        // 根据是否包含时间判断
        if (metadata?.includeTime) {
          return 'TIMESTAMP';
        }
        return 'DATE';

      // UUID类型
      case 'uuid':
        return 'UUID';

      // IP地址类型
      case 'ip_address':
        return 'VARCHAR'; // DuckDB 0.9+支持INET类型，这里先用VARCHAR

      // 高级类型
      case 'json':
        return 'JSON';

      case 'array': {
        // 数组类型需要指定元素类型，这里使用VARCHAR数组作为默认
        const elementType = metadata?.elementType || 'VARCHAR';
        return `${elementType}[]`;
      }

      default:
        console.warn(`Unknown field type: ${fieldType}, defaulting to VARCHAR`);
        return 'VARCHAR';
    }
  }

  // ==================== 字段处理方法 ====================

  /**
   * 🏗️ 创建物理列
   */
  private async createPhysicalColumn(params: {
    datasetId: string;
    filePath: string;
    columnName: string;
    duckdbType: string;
    nullable: boolean;
  }): Promise<void> {
    const { datasetId, filePath, columnName, duckdbType, nullable } = params;
    const nullableClause = nullable ? '' : ' NOT NULL';
    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 数据集表统一使用独立文件 + ds_<id>.data（包括 plugin__ 数据集）
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(safeDatasetId, escapedPath);

    const quotedColumn = quoteIdentifier(columnName);
    await this.conn.run(
      `ALTER TABLE ${quoteQualifiedName(`ds_${safeDatasetId}`, 'data')} ADD COLUMN ${quotedColumn} ${duckdbType}${nullableClause}`
    );
    console.log(`✅ Added column to dataset table: ${safeDatasetId}.data.${columnName}`);
  }

  /**
   * 📅 处理特殊字段类型
   *
   * 为特殊类型字段设置默认值和约束
   */
  private async handleSpecialFieldTypes(
    datasetId: string,
    filePath: string,
    columnName: string,
    fieldType: string,
    metadata: any
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(safeDatasetId, escapedPath);

    const schemaName = `ds_${safeDatasetId}`;
    const tableName = quoteQualifiedName(schemaName, 'data');
    const quotedColumn = quoteIdentifier(columnName);

    switch (fieldType) {
      case 'auto_increment': {
        // 创建序列并设置默认值
        const safeCol = columnName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'col';
        const sequenceName = `seq_${safeDatasetId}_${safeCol}`;
        try {
          await this.conn.run(
            `CREATE SEQUENCE IF NOT EXISTS ${quoteQualifiedName(schemaName, sequenceName)} START 1 INCREMENT 1`
          );
          await this.conn.run(
            `ALTER TABLE ${tableName} ALTER COLUMN ${quotedColumn} SET DEFAULT nextval('${escapeSqlStringLiteral(`${quoteIdentifier(schemaName)}.${quoteIdentifier(sequenceName)}`)}')`
          );
          console.log(`✓ 创建自增序列: ${sequenceName}`);
        } catch {
          console.warn(`⚠ 序列可能已存在: ${sequenceName}`);
        }
        break;
      }

      case 'uuid':
        // 设置UUID默认值
        if (!metadata.defaultValue) {
          await this.conn.run(
            `ALTER TABLE ${tableName} ALTER COLUMN ${quotedColumn} SET DEFAULT gen_random_uuid()`
          );
          console.log(`✓ 设置UUID默认值`);
        }
        break;

      case 'json':
        // JSON类型可以设置默认值
        if (!metadata.defaultValue) {
          await this.conn.run(
            `ALTER TABLE ${tableName} ALTER COLUMN ${quotedColumn} SET DEFAULT '{}'::JSON`
          );
          console.log(`✓ 设置JSON默认值`);
        }
        break;

      default:
        // 其他类型不需要特殊处理
        break;
    }
  }

  /**
   * 🔢 填充默认值
   *
   * 为所有现有行填充默认值
   */
  private async fillDefaultValue(
    datasetId: string,
    filePath: string,
    columnName: string,
    defaultValue: any
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 处理日期的特殊情况
    let value = defaultValue;
    if (defaultValue === '__CREATE_TIME__') {
      value = new Date().toISOString();
    }

    // 数据集表统一使用独立文件 + ds_<id>.data（包括 plugin__ 数据集）
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(safeDatasetId, escapedPath);

    const quotedColumn = quoteIdentifier(columnName);
    const stmt = await this.conn.prepare(
      `UPDATE ${quoteQualifiedName(`ds_${safeDatasetId}`, 'data')} SET ${quotedColumn} = ?`
    );
    stmt.bind([value]);
    await stmt.run();
    stmt.destroySync();
    console.log(`✅ Filled default value for dataset table: ${safeDatasetId}.data.${columnName}`);
  }
}
