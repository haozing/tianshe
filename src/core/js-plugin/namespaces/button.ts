/**
 * 按钮命名空间
 *
 * 提供便捷的按钮创建和管理功能
 * 允许插件通过代码动态添加、更新、删除按钮列
 *
 * @example
 * // 添加简单按钮
 * await helpers.button.addToTable('products', {
 *   columnName: '发布',
 *   method: 'publishProduct',
 *   label: '发布',
 *   icon: '🚀'
 * });
 *
 * @example
 * // 添加带参数绑定的按钮
 * await helpers.button.addToTable('products', {
 *   columnName: '采集详情',
 *   method: 'collectDetails',
 *   label: '采集',
 *   params: {
 *     productUrl: '商品链接',     // 字段绑定
 *     storeId: { fixed: 'store_001' }  // 固定值
 *   },
 *   returns: {
 *     imageUrl: '商品图片',
 *     price: '价格'
 *   },
 *   then: {
 *     onSuccess: '发布按钮',
 *     delay: 1000
 *   }
 * });
 */

import type { DuckDBService } from '../../../main/duckdb/service';
import type {
  ColumnMetadata,
  ParameterBinding,
  ReturnBinding,
  TriggerChainConfig,
  TriggerRule,
  EnhancedColumnSchema,
} from '../../../main/duckdb/types';
import type { PluginContext } from '../context';

/**
 * 按钮配置
 */
export interface ButtonConfig {
  /** 列名 */
  columnName: string;
  /** 方法ID（当前插件中的命令） */
  method: string;
  /** 按钮文字 */
  label?: string;
  /** 按钮图标 */
  icon?: string;
  /** 按钮样式 */
  variant?: 'default' | 'primary' | 'success' | 'danger';
  /** 确认消息 */
  confirm?: string;
  /** 显示执行结果 */
  showResult?: boolean;
  /** 执行模式 */
  executionMode?: 'sync' | 'async' | 'background';
  /** 超时时间（毫秒） */
  timeout?: number;

  /**
   * 参数绑定（简化语法）
   * - 字符串值：绑定到数据表字段
   * - { fixed: value }：固定值
   *
   * @example
   * params: {
   *   productUrl: '商品链接',           // 字段绑定
   *   storeId: { fixed: 'store_001' }   // 固定值
   * }
   */
  params?: Record<string, string | { fixed: any }>;

  /**
   * 返回值绑定（简化语法）
   * 键为返回值字段名，值为目标数据表列名
   *
   * @example
   * returns: {
   *   imageUrl: '商品图片',
   *   price: '价格'
   * }
   */
  returns?: Record<string, string>;

  /**
   * 触发链配置（简化语法）
   *
   * @example
   * then: {
   *   onSuccess: '发布按钮',
   *   onFailure: '错误日志按钮',
   *   delay: 1000
   * }
   */
  then?: {
    onSuccess?: string;
    onFailure?: string;
    delay?: number;
  };
}

/**
 * 添加按钮结果
 */
export interface AddButtonResult {
  success: boolean;
  columnName: string;
  error?: string;
}

/**
 * 按钮命名空间
 */
export class ButtonNamespace {
  constructor(
    private duckdb: DuckDBService,
    private pluginId: string,
    private getContext: () => PluginContext | null
  ) {}

  /**
   * 为数据表添加按钮列
   *
   * @param tableCode - 数据表代码（在 manifest.json 中定义）
   * @param config - 按钮配置
   * @returns 添加结果
   *
   * @example
   * await helpers.button.addToTable('products', {
   *   columnName: '发布',
   *   method: 'publishProduct',
   *   label: '发布',
   *   icon: '🚀',
   *   variant: 'success'
   * });
   */
  async addToTable(tableCode: string, config: ButtonConfig): Promise<AddButtonResult> {
    try {
      // 获取数据表 ID
      const datasetId = this.getDataTableId(tableCode);
      if (!datasetId) {
        return {
          success: false,
          columnName: config.columnName,
          error: `数据表 "${tableCode}" 不存在`,
        };
      }

      // 检查列是否已存在
      const existingSchema = await this.duckdb.getDatasetInfo(datasetId);
      if (existingSchema?.schema?.some((col) => col.name === config.columnName)) {
        console.log(`[ButtonNamespace] 按钮列 "${config.columnName}" 已存在，跳过创建`);
        return { success: true, columnName: config.columnName };
      }

      // 构建列 schema
      const columnSchema: EnhancedColumnSchema = {
        name: config.columnName,
        duckdbType: 'VARCHAR',
        fieldType: 'button',
        nullable: true,
        metadata: this.buildButtonMetadata(config),
      };

      // 添加列到数据表
      await this.duckdb.addColumn({
        datasetId,
        columnName: columnSchema.name,
        fieldType: 'button',
        nullable: true,
        metadata: columnSchema.metadata,
      });

      console.log(`[ButtonNamespace] 已添加按钮列 "${config.columnName}" 到表 "${tableCode}"`);

      return { success: true, columnName: config.columnName };
    } catch (error: any) {
      console.error(`[ButtonNamespace] 添加按钮失败:`, error);
      return {
        success: false,
        columnName: config.columnName,
        error: error.message,
      };
    }
  }

  /**
   * 更新已有按钮的配置
   *
   * @param tableCode - 数据表代码
   * @param columnName - 按钮列名
   * @param config - 新的按钮配置（部分更新）
   */
  async updateButton(
    tableCode: string,
    columnName: string,
    config: Partial<ButtonConfig>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const datasetId = this.getDataTableId(tableCode);
      if (!datasetId) {
        return { success: false, error: `数据表 "${tableCode}" 不存在` };
      }

      // 获取现有配置
      const datasetInfo = await this.duckdb.getDatasetInfo(datasetId);
      const column = datasetInfo?.schema?.find((c) => c.name === columnName);

      if (!column || column.fieldType !== 'button') {
        return { success: false, error: `按钮列 "${columnName}" 不存在` };
      }

      // 合并配置
      const existingMetadata = column.metadata || {};
      const newMetadata = {
        ...existingMetadata,
        ...this.buildButtonMetadata(config as ButtonConfig),
      };

      // 更新列元数据
      await this.duckdb.updateColumnMetadata(datasetId, columnName, newMetadata);

      console.log(`[ButtonNamespace] 已更新按钮 "${columnName}"`);

      return { success: true };
    } catch (error: any) {
      console.error(`[ButtonNamespace] 更新按钮失败:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除按钮列
   *
   * @param tableCode - 数据表代码
   * @param columnName - 按钮列名
   */
  async removeButton(
    tableCode: string,
    columnName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const datasetId = this.getDataTableId(tableCode);
      if (!datasetId) {
        return { success: false, error: `数据表 "${tableCode}" 不存在` };
      }

      await this.duckdb.deleteColumn(datasetId, columnName);

      console.log(`[ButtonNamespace] 已删除按钮列 "${columnName}"`);

      return { success: true };
    } catch (error: any) {
      console.error(`[ButtonNamespace] 删除按钮失败:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 批量添加按钮
   *
   * @param tableCode - 数据表代码
   * @param buttons - 按钮配置数组
   * @returns 添加结果
   */
  async addMultiple(
    tableCode: string,
    buttons: ButtonConfig[]
  ): Promise<{ success: boolean; columns: string[]; errors: string[] }> {
    const columns: string[] = [];
    const errors: string[] = [];

    for (const config of buttons) {
      const result = await this.addToTable(tableCode, config);
      if (result.success) {
        columns.push(result.columnName);
      } else {
        errors.push(`${result.columnName}: ${result.error}`);
      }
    }

    return {
      success: errors.length === 0,
      columns,
      errors,
    };
  }

  /**
   * 获取数据表的所有按钮列
   *
   * @param tableCode - 数据表代码
   * @returns 按钮列列表
   */
  async getButtons(tableCode: string): Promise<EnhancedColumnSchema[]> {
    const datasetId = this.getDataTableId(tableCode);
    if (!datasetId) {
      return [];
    }

    const datasetInfo = await this.duckdb.getDatasetInfo(datasetId);
    return (datasetInfo?.schema || []).filter((col) => col.fieldType === 'button');
  }

  /**
   * 根据表代码获取数据表ID
   */
  private getDataTableId(tableCode: string): string | null {
    const context = this.getContext();
    if (!context) {
      console.warn('[ButtonNamespace] PluginContext 未设置');
      return null;
    }

    const table = context.getDataTable(tableCode);
    return table?.id || null;
  }

  /**
   * 构建按钮元数据
   */
  private buildButtonMetadata(config: ButtonConfig): ColumnMetadata {
    return {
      pluginId: this.pluginId,
      pluginType: 'js',
      methodId: config.method,
      buttonLabel: config.label || '执行',
      buttonIcon: config.icon || '▶️',
      buttonVariant: config.variant || 'primary',
      confirmMessage: config.confirm,
      showResult: config.showResult ?? true,
      executionMode: config.executionMode || 'async',
      timeout: config.timeout,

      // 参数绑定
      parameterBindings: this.buildParameterBindings(config.params),

      // 返回值绑定
      returnBindings: this.buildReturnBindings(config.returns),

      // 触发链
      triggerChain: this.buildTriggerChain(config.then),
    };
  }

  /**
   * 构建参数绑定
   */
  private buildParameterBindings(
    params?: Record<string, string | { fixed: any }>
  ): ParameterBinding[] {
    if (!params) return [];

    return Object.entries(params).map(([paramName, binding]) => {
      if (typeof binding === 'string') {
        // 字段绑定
        return {
          parameterName: paramName,
          bindingType: 'field' as const,
          fieldName: binding,
        };
      } else {
        // 固定值
        return {
          parameterName: paramName,
          bindingType: 'fixed' as const,
          fixedValue: binding.fixed,
        };
      }
    });
  }

  /**
   * 构建返回值绑定
   */
  private buildReturnBindings(returns?: Record<string, string>): ReturnBinding[] {
    if (!returns) return [];

    return Object.entries(returns).map(([returnField, targetColumn]) => ({
      returnField,
      targetColumn,
      updateCondition: 'on_success' as const,
    }));
  }

  /**
   * 构建触发链配置
   */
  private buildTriggerChain(then?: {
    onSuccess?: string;
    onFailure?: string;
    delay?: number;
  }): TriggerChainConfig | undefined {
    if (!then) return undefined;

    const triggers: TriggerRule[] = [];

    if (then.onSuccess) {
      triggers.push({
        condition: { type: 'on_success' },
        nextButton: { columnName: then.onSuccess, delay: then.delay },
      });
    }

    if (then.onFailure) {
      triggers.push({
        condition: { type: 'on_failure' },
        nextButton: { columnName: then.onFailure },
      });
    }

    if (triggers.length === 0) return undefined;

    return {
      enabled: true,
      maxDepth: 5,
      triggers,
      errorStrategy: {
        onCurrentFail: 'stop',
        onChildFail: 'ignore',
      },
    };
  }
}
