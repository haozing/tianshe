/**
 * 插件 Webhook API
 * 允许插件触发自定义回调事件
 */

import { HookBus } from '../../hookbus';
import type { WebhookSender } from '../../../main/webhook/sender';
import { createLogger } from '../../logger';

const logger = createLogger('WebhookNamespace');

/**
 * Webhook 命名空间
 *
 * 提供插件自定义回调事件功能
 *
 * @example
 * // 注册事件
 * context.webhook.register('order_created', { name: '订单创建' });
 *
 * // 触发回调
 * context.webhook.emit('order_created', {
 *   orderId: '123',
 *   amount: 100
 * });
 */
export class WebhookNamespace {
  /** 已注册的事件 ID 列表（用于 dispose 时清理） */
  private registeredEventIds: string[] = [];

  constructor(
    private pluginId: string,
    private hookBus: HookBus,
    private webhookSender: WebhookSender
  ) {}

  /**
   * 注册自定义事件
   *
   * @param eventId - 事件ID（自动添加插件前缀）
   * @param metadata - 事件元数据（可选，用于日志）
   *
   * @example
   * context.webhook.register('order_created', { name: '订单创建' });
   */
  register(eventId: string, metadata?: { name?: string }): void {
    // 防重检查
    if (this.registeredEventIds.includes(eventId)) {
      logger.debug(`Plugin ${this.pluginId} event already registered: ${eventId}`);
      return;
    }

    // 通知 WebhookSender 注册这个插件事件
    this.webhookSender.registerPluginEvent(this.pluginId, eventId);
    this.registeredEventIds.push(eventId);

    logger.debug(
      `Plugin ${this.pluginId} registered event: ${eventId}${metadata?.name ? ` (${metadata.name})` : ''}`
    );
  }

  /**
   * 触发回调事件
   *
   * @param eventId - 事件ID
   * @param data - 回调数据
   *
   * @example
   * context.webhook.emit('order_created', {
   *   orderId: '123',
   *   amount: 100,
   *   userId: 'user_456'
   * });
   */
  emit(eventId: string, data: any): void {
    // 发射到 HookBus（自动添加 webhook:plugin.{pluginId}. 前缀）
    const fullEventId = `webhook:plugin.${this.pluginId}.${eventId}`;
    this.hookBus.emit(fullEventId, data);

    logger.debug(`Plugin ${this.pluginId} emitted: ${eventId}`);
  }

  /**
   * 清理所有已注册的事件监听器
   * 在插件卸载/热重载时自动调用
   *
   * @internal
   */
  dispose(): void {
    if (this.registeredEventIds.length === 0) {
      return;
    }

    // 批量注销该插件的所有事件
    this.webhookSender.unregisterAllPluginEvents(this.pluginId);
    const count = this.registeredEventIds.length;
    this.registeredEventIds = [];

    logger.debug(`Plugin ${this.pluginId} disposed ${count} event(s)`);
  }
}
