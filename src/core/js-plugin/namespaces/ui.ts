/**
 * UI Namespace
 *
 * 提供用户界面操作的命名空间接口
 * 包括通知、对话框、当前数据集上下文等
 */

import { pluginEventBus, PluginEvents, type PluginNotificationType } from '../events';

/**
 * UI 命名空间
 *
 * 提供 UI 相关操作，如显示通知、获取当前数据集等
 *
 * @example
 * // 显示成功通知
 * await helpers.ui.notify('操作成功！', 'success');
 *
 * @example
 * // 获取当前数据集
 * const datasetId = helpers.ui.getCurrentDataset();
 */
export class UINamespace {
  /** 当前操作的数据集ID（用于 UI 扩展） */
  private currentDataset: string | null = null;

  constructor(private pluginId: string) {}

  /**
   * 显示通知消息
   *
   * @param message - 通知消息
   * @param type - 通知类型
   *
   * @example
   * await helpers.ui.notify('产品发布成功！', 'success');
   * await helpers.ui.notify('发布失败，请重试', 'error');
   */
  async notify(
    message: string,
    type: PluginNotificationType = 'info'
  ): Promise<void> {
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      return;
    }

    await pluginEventBus.emit(PluginEvents.NOTIFICATION, {
      pluginId: this.pluginId,
      type,
      message: normalizedMessage,
      createdAt: Date.now(),
    });
  }

  /**
   * 显示信息通知
   *
   * @param message - 通知消息
   *
   * @example
   * await helpers.ui.info('这是一条信息');
   */
  async info(message: string): Promise<void> {
    await this.notify(message, 'info');
  }

  /**
   * 显示成功通知
   *
   * @param message - 通知消息
   *
   * @example
   * await helpers.ui.success('操作成功！');
   */
  async success(message: string): Promise<void> {
    await this.notify(message, 'success');
  }

  /**
   * 显示警告通知
   *
   * @param message - 通知消息
   *
   * @example
   * await helpers.ui.warning('请注意检查数据');
   */
  async warning(message: string): Promise<void> {
    await this.notify(message, 'warning');
  }

  /**
   * 显示错误通知
   *
   * @param message - 通知消息
   *
   * @example
   * await helpers.ui.error('操作失败！');
   */
  async error(message: string): Promise<void> {
    await this.notify(message, 'error');
  }

  /**
   * 获取当前操作的数据集ID
   *
   * @returns 当前数据集ID（如果在 UI 扩展上下文中）
   *
   * @example
   * const currentDataset = helpers.ui.getCurrentDataset();
   * if (currentDataset) {
   *   const rows = await helpers.database.query(currentDataset);
   * }
   */
  getCurrentDataset(): string | null {
    return this.currentDataset;
  }

  /**
   * 设置当前操作的数据集ID（内部方法）
   * @internal
   */
  setCurrentDataset(datasetId: string | null): void {
    this.currentDataset = datasetId;
  }
}
