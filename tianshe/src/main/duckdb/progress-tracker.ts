/**
 * 进度追踪器
 * 用于在长时间运行的操作中向前端发送进度更新
 */

import type { IpcMainInvokeEvent } from 'electron';

export interface ProgressUpdate {
  operationId: string;
  operation: string;
  stage: string;
  current?: number;
  total?: number;
  percentage: number;
  message?: string;
  data?: any;
}

export class ProgressTracker {
  private event: IpcMainInvokeEvent;
  private operationId: string;
  private operation: string;

  constructor(event: IpcMainInvokeEvent, operationId: string, operation: string) {
    this.event = event;
    this.operationId = operationId;
    this.operation = operation;
  }

  /**
   * 发送进度更新到前端
   */
  update(update: Partial<ProgressUpdate>): void {
    const fullUpdate: ProgressUpdate = {
      operationId: this.operationId,
      operation: this.operation,
      stage: update.stage || 'processing',
      percentage: update.percentage || 0,
      current: update.current,
      total: update.total,
      message: update.message,
      data: update.data,
    };

    this.event.sender.send('operation:progress', fullUpdate);
  }

  /**
   * 标记操作完成
   */
  complete(message?: string, data?: any): void {
    this.event.sender.send('operation:complete', {
      operationId: this.operationId,
      operation: this.operation,
      message: message || '操作完成',
      data,
    });
  }

  /**
   * 标记操作失败
   */
  fail(error: string, details?: any): void {
    this.event.sender.send('operation:failed', {
      operationId: this.operationId,
      operation: this.operation,
      error,
      details,
    });
  }

  /**
   * 快捷方法：更新百分比和消息
   */
  progress(percentage: number, message: string, stage?: string): void {
    this.update({
      percentage,
      message,
      stage: stage || 'processing',
    });
  }

  /**
   * 快捷方法：更新当前/总数进度
   */
  count(current: number, total: number, message?: string): void {
    const percentage = Math.round((current / total) * 100);
    this.update({
      current,
      total,
      percentage,
      message: message || `处理中 ${current}/${total}`,
    });
  }

  /**
   * 创建子阶段追踪器
   */
  createSubTracker(stage: string, weight: number, basePercentage: number): SubProgressTracker {
    return new SubProgressTracker(this, stage, weight, basePercentage);
  }

  /**
   * 生成唯一的操作ID
   */
  static generateId(prefix: string = 'op'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * 子进度追踪器
 * 用于在主操作的某个阶段内追踪子进度
 */
export class SubProgressTracker {
  private parent: ProgressTracker;
  private stage: string;
  private weight: number; // 该阶段占总进度的比重（0-1）
  private basePercentage: number; // 该阶段开始时的总进度百分比

  constructor(parent: ProgressTracker, stage: string, weight: number, basePercentage: number) {
    this.parent = parent;
    this.stage = stage;
    this.weight = weight;
    this.basePercentage = basePercentage;
  }

  /**
   * 更新子阶段进度
   * @param subPercentage 子阶段内的进度（0-100）
   * @param message 消息
   */
  update(subPercentage: number, message?: string): void {
    const totalPercentage = this.basePercentage + subPercentage * this.weight;
    this.parent.update({
      stage: this.stage,
      percentage: Math.round(totalPercentage),
      message,
    });
  }

  /**
   * 标记子阶段完成
   */
  complete(message?: string): void {
    const totalPercentage = this.basePercentage + 100 * this.weight;
    this.parent.update({
      stage: this.stage,
      percentage: Math.round(totalPercentage),
      message,
    });
  }
}
