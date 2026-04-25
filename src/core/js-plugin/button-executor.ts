/**
 * 按钮执行引擎
 *
 * 负责执行数据表按钮的完整流程：
 * 1. 参数解析与绑定
 * 2. 方法调用（带超时保护）
 * 3. 返回值处理与字段更新
 * 4. 触发链执行
 */

import type { DuckDBService } from '../../main/duckdb/service';
import type { JSPluginManager } from './manager';
import type {
  ColumnMetadata,
  ParameterBinding,
  ReturnBinding,
  TriggerChainConfig,
  TriggerCondition,
  ButtonExecuteResult,
  EnhancedColumnSchema,
} from '../../main/duckdb/types';
import { createLogger } from '../logger';
import { SQLUtils } from '../query-engine/utils/sql-utils';

const logger = createLogger('ButtonExecutor');

// ========== 常量定义 ==========

/** 默认执行超时时间（毫秒）- 2分钟 */
const DEFAULT_EXECUTION_TIMEOUT = 120000;

/** 触发链最大深度（默认值）*/
const DEFAULT_MAX_TRIGGER_DEPTH = 5;

/** 防重复点击清理延迟（毫秒）*/
const DEBOUNCE_CLEANUP_DELAY = 1000;

/**
 * 按钮执行上下文
 */
export interface ButtonExecuteContext {
  datasetId: string;
  rowId: number;
  rowData: Record<string, any>;
  buttonMetadata: ColumnMetadata;
  signal?: AbortSignal;
}

/**
 * 执行状态
 */
interface ExecutionState {
  startTime: number;
  status: 'running' | 'completed' | 'failed';
  depth: number;
}

/**
 * 按钮执行引擎
 */
export class ButtonExecutor {
  /** 执行状态追踪（防止重复执行） */
  private executingButtons = new Map<string, ExecutionState>();

  constructor(
    private pluginManager: JSPluginManager,
    private duckdb: DuckDBService
  ) {}

  /**
   * 执行按钮命令
   *
   * @param ctx - 执行上下文
   * @param depth - 当前触发链深度
   * @returns 执行结果
   */
  async execute(ctx: ButtonExecuteContext, depth: number = 0): Promise<ButtonExecuteResult> {
    const { datasetId, rowId, rowData, buttonMetadata, signal } = ctx;
    const pluginId = buttonMetadata.pluginId;
    const methodId = buttonMetadata.methodId;

    if (!pluginId || !methodId) {
      return { success: false, error: '按钮未配置插件或方法' };
    }

    const executionId = `${datasetId}:${rowId}:${methodId}`;

    // 1️⃣ 防止重复执行
    if (this.executingButtons.has(executionId)) {
      logger.debug('跳过重复执行: ' + executionId);
      return { success: false, error: '该按钮正在执行中', skipped: true };
    }

    // 2️⃣ 触发链深度检查
    const maxDepth = buttonMetadata.triggerChain?.maxDepth ?? DEFAULT_MAX_TRIGGER_DEPTH;
    if (depth >= maxDepth) {
      logger.warn('触发链深度超限 (' + depth + '/' + maxDepth + ')');
      return { success: false, error: '触发链深度超过限制', depthExceeded: true };
    }

    try {
      // 3️⃣ 注册执行状态
      this.executingButtons.set(executionId, {
        startTime: Date.now(),
        status: 'running',
        depth,
      });

      logger.debug('开始执行: ' + pluginId + ':' + methodId + ' (depth=' + depth + ')');

      // 4️⃣ 解析参数绑定
      const params = this.resolveParameters(
        buttonMetadata.parameterBindings || [],
        rowData,
        datasetId
      );

      // 5️⃣ 执行插件方法（带超时保护）
      const timeout = buttonMetadata.timeout || DEFAULT_EXECUTION_TIMEOUT;
      let result: any;

      try {
        result = await this.executeWithTimeout(pluginId, methodId, params, timeout, signal);
      } catch (error: any) {
        // 判断是否是取消错误
        if (signal?.aborted) {
          return { success: false, error: '执行被取消' };
        }
        result = { success: false, error: error.message };
      }

      // 6️⃣ 处理返回值绑定（回写数据表）
      const updatedFields: string[] = [];
      if (buttonMetadata.returnBindings && buttonMetadata.returnBindings.length > 0) {
        const updated = await this.processReturnBindings(
          datasetId,
          rowId,
          result,
          buttonMetadata.returnBindings
        );
        updatedFields.push(...updated);
      }

      // 7️⃣ 处理触发链
      let triggeredNext = false;
      if (buttonMetadata.triggerChain?.enabled && buttonMetadata.triggerChain.triggers.length > 0) {
        triggeredNext = await this.processTriggerChain(
          datasetId,
          rowId,
          result,
          buttonMetadata.triggerChain,
          depth
        );
      }

      // 更新执行状态
      const state = this.executingButtons.get(executionId);
      if (state) {
        state.status = result.success !== false ? 'completed' : 'failed';
      }

      return {
        success: result.success !== false,
        result,
        updatedFields,
        triggeredNext,
      };
    } catch (error: any) {
      logger.error('执行失败: ' + executionId, error);

      // 更新执行状态
      const state = this.executingButtons.get(executionId);
      if (state) {
        state.status = 'failed';
      }

      return { success: false, error: error.message };
    } finally {
      // 8️⃣ 清理执行状态（延迟清理，避免快速重复点击）
      setTimeout(() => {
        this.executingButtons.delete(executionId);
      }, DEBOUNCE_CLEANUP_DELAY);
    }
  }

  /**
   * 解析参数绑定
   */
  private resolveParameters(
    bindings: ParameterBinding[],
    rowData: Record<string, any>,
    datasetId: string
  ): Record<string, any> {
    const params: Record<string, any> = {};

    for (const binding of bindings) {
      switch (binding.bindingType) {
        case 'field':
          if (binding.fieldName) {
            params[binding.parameterName] = rowData[binding.fieldName];
          }
          break;
        case 'fixed':
          params[binding.parameterName] = binding.fixedValue;
          break;
        case 'rowid':
          params[binding.parameterName] = rowData._row_id;
          break;
        case 'datasetId':
          params[binding.parameterName] = datasetId;
          break;
      }
    }

    // 始终传递上下文信息
    params.__context = {
      rowData,
      datasetId,
      rowId: rowData._row_id,
    };

    return params;
  }

  /**
   * 带超时保护的执行
   */
  private async executeWithTimeout(
    pluginId: string,
    methodId: string,
    params: any,
    timeout: number,
    signal?: AbortSignal
  ): Promise<any> {
    return Promise.race([
      this.pluginManager.executeCommand(pluginId, methodId, params),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`执行超时 (${timeout}ms)`));
        }, timeout);

        // 如果有取消信号，监听它
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('执行被取消'));
          });
        }
      }),
    ]);
  }

  /**
   * 处理返回值绑定
   */
  private async processReturnBindings(
    datasetId: string,
    rowId: number,
    result: any,
    bindings: ReturnBinding[]
  ): Promise<string[]> {
    const updates: Record<string, any> = {};
    const updatedFields: string[] = [];

    for (const binding of bindings) {
      const condition = binding.updateCondition || 'on_success';

      // 检查是否应该更新
      let shouldUpdate = false;
      switch (condition) {
        case 'always':
          shouldUpdate = true;
          break;
        case 'on_success':
          shouldUpdate = result.success !== false;
          break;
        case 'on_change':
          shouldUpdate = result[binding.returnField] !== undefined;
          break;
      }

      if (shouldUpdate && result[binding.returnField] !== undefined) {
        updates[binding.targetColumn] = result[binding.returnField];
        updatedFields.push(binding.targetColumn);
      }
    }

    // 执行更新
    if (Object.keys(updates).length > 0) {
      try {
        // 构建 UPDATE SQL
        const setClauses: string[] = [];
        const values: any[] = [];

        for (const [column, value] of Object.entries(updates)) {
          setClauses.push(`"${column}" = ?`);
          values.push(value);
        }

        const tableName = `${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}.${SQLUtils.escapeIdentifier('data')}`;
        const sql = `
          UPDATE ${tableName}
          SET ${setClauses.join(', ')}
          WHERE _row_id = ?
        `;
        values.push(rowId);

        await this.duckdb.executeWithParams(sql, values);
        logger.debug('已更新字段: ' + updatedFields.join(', '));
      } catch (error) {
        logger.error('更新字段失败', error);
      }
    }

    return updatedFields;
  }

  /**
   * 处理触发链
   */
  private async processTriggerChain(
    datasetId: string,
    rowId: number,
    result: any,
    triggerChain: TriggerChainConfig,
    currentDepth: number
  ): Promise<boolean> {
    let triggered = false;
    const errorStrategy = triggerChain.errorStrategy || {
      onCurrentFail: 'stop',
      onChildFail: 'ignore',
    };

    for (const trigger of triggerChain.triggers) {
      // 评估触发条件
      const shouldTrigger = this.evaluateTriggerCondition(trigger.condition, result);

      if (!shouldTrigger) {
        continue;
      }

      const nextButtonColumn = trigger.nextButton.columnName;
      const delay = trigger.nextButton.delay || 0;

      try {
        // 获取下一个按钮的配置
        const schema = await this.getDatasetSchema(datasetId);
        const nextColumn = schema.find((col) => col.name === nextButtonColumn);

        if (!nextColumn || nextColumn.fieldType !== 'button' || !nextColumn.metadata) {
          logger.warn('找不到按钮列: ' + nextButtonColumn);
          continue;
        }

        // 延迟执行
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // 获取最新的行数据
        const latestRowData = await this.getRowData(datasetId, rowId);
        if (!latestRowData) {
          logger.warn('找不到行数据: ' + rowId);
          continue;
        }

        // 递归执行下一个按钮
        logger.debug('触发链: 执行 ' + nextButtonColumn + ' (depth=' + (currentDepth + 1) + ')');

        const nextResult = await this.execute(
          {
            datasetId,
            rowId,
            rowData: latestRowData,
            buttonMetadata: nextColumn.metadata,
          },
          currentDepth + 1
        );

        triggered = true;

        // 检查子链条执行结果
        if (!nextResult.success && errorStrategy.onChildFail === 'stop') {
          logger.debug('子链条失败，停止执行');
          break;
        }
      } catch (error: any) {
        logger.error('触发链执行失败: ' + nextButtonColumn, error);

        const triggerErrorStrategy = trigger.errorStrategy || errorStrategy.onCurrentFail;
        if (triggerErrorStrategy === 'stop') {
          break;
        }
        // 'continue' 则继续执行
      }
    }

    return triggered;
  }

  /**
   * 评估触发条件
   */
  private evaluateTriggerCondition(condition: TriggerCondition, result: any): boolean {
    switch (condition.type) {
      case 'always':
        return true;

      case 'on_success':
        return result.success !== false;

      case 'on_failure':
        return result.success === false;

      case 'on_return_value': {
        if (!condition.returnField) return false;

        const value = result[condition.returnField];
        const expectedValue = condition.value;
        const operator = condition.operator || 'eq';

        switch (operator) {
          case 'eq':
            return value === expectedValue;
          case 'ne':
            return value !== expectedValue;
          case 'gt':
            return Number(value) > Number(expectedValue);
          case 'lt':
            return Number(value) < Number(expectedValue);
          case 'contains':
            return String(value).includes(String(expectedValue));
          case 'exists':
            return value !== undefined && value !== null;
          default:
            return false;
        }
      }

      default:
        return false;
    }
  }

  /**
   * 获取数据集 schema
   */
  private async getDatasetSchema(datasetId: string): Promise<EnhancedColumnSchema[]> {
    const datasetInfo = await this.duckdb.getDatasetInfo(datasetId);
    return datasetInfo?.schema || [];
  }

  /**
   * 获取行数据
   */
  private async getRowData(datasetId: string, rowId: number): Promise<Record<string, any> | null> {
    try {
      // 验证 rowId 是有效的整数（防止注入）
      const safeRowId = Number(rowId);
      if (!Number.isInteger(safeRowId) || safeRowId < 0) {
        logger.error('无效的 rowId: ' + rowId);
        return null;
      }

      // 使用 queryDataset 查询数据集（会自动 ATTACH 数据集文件）
      const result = await this.duckdb.queryDataset(
        datasetId,
        `SELECT * FROM data WHERE _row_id = ${safeRowId}`
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('获取行数据失败', error);
      return null;
    }
  }

  /**
   * 检查按钮是否正在执行
   */
  isExecuting(datasetId: string, rowId: number, methodId: string): boolean {
    const executionId = `${datasetId}:${rowId}:${methodId}`;
    return this.executingButtons.has(executionId);
  }

  /**
   * 获取执行状态
   */
  getExecutionState(
    datasetId: string,
    rowId: number,
    methodId: string
  ): ExecutionState | undefined {
    const executionId = `${datasetId}:${rowId}:${methodId}`;
    return this.executingButtons.get(executionId);
  }
}
