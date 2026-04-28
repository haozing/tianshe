/**
 * Webhook 回调发送器（简化版）
 * 监听 HookBus 事件，发送 HTTP 回调
 */

import { BroadcastHandler, HookBus } from '../../core/hookbus';
import { redactSensitiveText, redactSensitiveUrl } from '../../utils/redaction';

/**
 * 内置埋点列表（写死，无需配置）
 */
const BUILTIN_EVENTS = [
  'webhook:dataset.created',
  'webhook:dataset.updated',
  'webhook:dataset.deleted',
  'webhook:record.created',
  'webhook:record.updated',
  'webhook:record.deleted',
] as const;

export class WebhookSender {
  private hookBus: HookBus;
  private callbackUrl?: string;
  /** 插件事件 handler 引用（用于卸载时移除监听器） */
  private pluginEventHandlers = new Map<string, BroadcastHandler<unknown>>();

  constructor(hookBus: HookBus) {
    this.hookBus = hookBus;
    this.setupListeners();
  }

  /**
   * 设置回调地址
   */
  setCallbackUrl(url?: string): void {
    this.callbackUrl = url;
    console.log(
      `[WebhookSender] Callback URL updated: ${url ? redactSensitiveUrl(url) : '(disabled)'}`
    );
  }

  /**
   * 获取回调地址
   */
  getCallbackUrl(): string | undefined {
    return this.callbackUrl;
  }

  /**
   * 设置监听器（监听所有内置埋点）
   */
  private setupListeners(): void {
    BUILTIN_EVENTS.forEach((event) => {
      this.hookBus.on(event, async (data: unknown) => {
        await this.handleEvent(event, data);
      });
    });

    console.log(`[WebhookSender] Registered ${BUILTIN_EVENTS.length} event listeners`);
  }

  /**
   * 处理事件（检查后发送回调）
   */
  private async handleEvent(eventId: string, data: unknown): Promise<void> {
    // 检查回调地址
    if (!this.callbackUrl) {
      return;
    }

    // 移除 'webhook:' 前缀
    const cleanEventId = eventId.replace('webhook:', '');

    await this.sendCallback(cleanEventId, data);
  }

  /**
   * 发送回调
   */
  private async sendCallback(eventId: string, data: unknown): Promise<void> {
    if (!this.callbackUrl) {
      return;
    }

    const payload = {
      event: eventId,
      data,
      timestamp: Date.now(),
    };

    try {
      const response = await fetch(this.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Airpa-Webhook/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000), // 5秒超时
      });

      if (!response.ok) {
        console.error(`[WebhookSender] Failed to send ${eventId}: HTTP ${response.status}`);
      } else {
        console.log(`[WebhookSender] Sent: ${eventId}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[WebhookSender] Error sending ${eventId}:`, redactSensitiveText(errorMessage));
      // 失败就失败，不重试（按用户要求）
    }
  }

  /**
   * 注册插件事件（动态）
   * 支持防重检查，同一事件不会重复注册
   */
  registerPluginEvent(pluginId: string, eventId: string): void {
    const fullEventId = `webhook:plugin.${pluginId}.${eventId}`;

    // 防重检查：已注册则跳过
    if (this.pluginEventHandlers.has(fullEventId)) {
      console.log(`[WebhookSender] Plugin event already registered: ${fullEventId}`);
      return;
    }

    // 创建 handler 并保存引用（用于后续移除）
    const handler = async (data: unknown) => {
      await this.handleEvent(fullEventId, data);
    };

    this.pluginEventHandlers.set(fullEventId, handler);
    this.hookBus.on(fullEventId, handler);

    console.log(`[WebhookSender] Plugin event registered: ${fullEventId}`);
  }

  /**
   * 注销插件事件
   * 用于插件卸载时清理监听器
   */
  unregisterPluginEvent(pluginId: string, eventId: string): void {
    const fullEventId = `webhook:plugin.${pluginId}.${eventId}`;

    const handler = this.pluginEventHandlers.get(fullEventId);
    if (handler) {
      this.hookBus.off(fullEventId, handler);
      this.pluginEventHandlers.delete(fullEventId);
      console.log(`[WebhookSender] Plugin event unregistered: ${fullEventId}`);
    }
  }

  /**
   * 注销指定插件的所有事件
   * 用于插件卸载时批量清理
   */
  unregisterAllPluginEvents(pluginId: string): void {
    const prefix = `webhook:plugin.${pluginId}.`;
    const toRemove: string[] = [];

    for (const fullEventId of this.pluginEventHandlers.keys()) {
      if (fullEventId.startsWith(prefix)) {
        toRemove.push(fullEventId);
      }
    }

    for (const fullEventId of toRemove) {
      const handler = this.pluginEventHandlers.get(fullEventId);
      if (handler) {
        this.hookBus.off(fullEventId, handler);
        this.pluginEventHandlers.delete(fullEventId);
      }
    }

    if (toRemove.length > 0) {
      console.log(`[WebhookSender] Unregistered ${toRemove.length} events for plugin: ${pluginId}`);
    }
  }
}
