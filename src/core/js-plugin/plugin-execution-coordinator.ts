/**
 * JS plugin command/API execution coordinator.
 */

import type { JSPluginInfo } from '../../types/js-plugin';
import { PluginContext } from './context';
import type { PluginHelpers } from './helpers';
import type { PluginLifecycleManager } from './plugin-lifecycle';
import type { UIExtensionManager } from './ui-extension-manager';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import { attachErrorContextArtifact } from '../observability/error-context-artifact';

export interface CommandExecutionGuardContext {
  pluginId: string;
  commandId: string;
  params: any;
}

export type CommandExecutionGuard = (context: CommandExecutionGuardContext) => Promise<void> | void;

const DEFAULT_COMMAND_DRAIN_TIMEOUT_MS = 30_000;

export interface PluginExecutionCoordinatorDeps {
  lifecycle: PluginLifecycleManager;
  uiExtManager: UIExtensionManager;
  getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>;
  getRuntimeStatus: (pluginId: string) => Promise<unknown>;
}

export class PluginExecutionCoordinator {
  private commandExecutionGuards: CommandExecutionGuard[] = [];
  private runningCommandCounts = new Map<string, number>();
  private runningCommandWaiters = new Map<string, Set<() => void>>();

  constructor(private deps: PluginExecutionCoordinatorDeps) {}

  private get lifecycle(): PluginLifecycleManager {
    return this.deps.lifecycle;
  }

  private get uiExtManager(): UIExtensionManager {
    return this.deps.uiExtManager;
  }

  private getPluginInfo(pluginId: string): Promise<JSPluginInfo | null> {
    return this.deps.getPluginInfo(pluginId);
  }

  private getRuntimeStatus(pluginId: string): Promise<unknown> {
    return this.deps.getRuntimeStatus(pluginId);
  }

  getRunningCommandCount(pluginId: string): number {
    return this.runningCommandCounts.get(pluginId) ?? 0;
  }

  assertNoRunningCommands(pluginId: string, operation: string): void {
    const running = this.getRunningCommandCount(pluginId);
    if (running > 0) {
      throw new Error(
        `Cannot ${operation} plugin ${pluginId}: ${running} command(s) still running`
      );
    }
  }

  async waitForRunningCommands(
    pluginId: string,
    timeoutMs: number = DEFAULT_COMMAND_DRAIN_TIMEOUT_MS
  ): Promise<void> {
    if (this.getRunningCommandCount(pluginId) === 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiters = this.runningCommandWaiters.get(pluginId) ?? new Set<() => void>();
      let timeout: NodeJS.Timeout | undefined;
      const done = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      this.runningCommandWaiters.set(pluginId, waiters);
      timeout = setTimeout(() => {
        waiters.delete(done);
        reject(
          new Error(
            `Timed out waiting for ${this.getRunningCommandCount(pluginId)} command(s) to finish in plugin ${pluginId}`
          )
        );
      }, timeoutMs);
    });
  }

  private beginCommandExecution(pluginId: string): void {
    this.runningCommandCounts.set(pluginId, this.getRunningCommandCount(pluginId) + 1);
  }

  private endCommandExecution(pluginId: string): void {
    const nextCount = Math.max(0, this.getRunningCommandCount(pluginId) - 1);
    if (nextCount > 0) {
      this.runningCommandCounts.set(pluginId, nextCount);
      return;
    }

    this.runningCommandCounts.delete(pluginId);
    const waiters = this.runningCommandWaiters.get(pluginId);
    if (!waiters) {
      return;
    }

    this.runningCommandWaiters.delete(pluginId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * 执行命令
   */
  async executeCommand(pluginId: string, commandId: string, params: any): Promise<any> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        commandId,
      },
    });

    this.beginCommandExecution(pluginId);
    try {
      return await withTraceContext(traceContext, async () => {
        const span = await observationService.startSpan({
          context: traceContext,
          component: 'plugin-manager',
          event: 'plugin.invoke',
          attrs: {
            pluginId,
            apiName: commandId,
            invocationType: 'command',
            source: 'command',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            params: summarizeForObservation(params, 2),
          },
        });

        for (const guard of this.commandExecutionGuards) {
          await guard({ pluginId, commandId, params });
        }

        const info = await this.getPluginInfo(pluginId);
        if (!info) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }
        if (info.enabled === false) {
          throw new Error(`Plugin ${pluginId} is disabled`);
        }

        const context = this.lifecycle.getContext(pluginId);
        if (!context) {
          throw new Error(`Plugin ${pluginId} is not activated`);
        }

        const handler = context.getCommand(commandId);
        if (!handler) {
          throw new Error(`Command ${commandId} not found in plugin ${pluginId}`);
        }

        const pluginLogger = this.lifecycle.getLogger(pluginId);
        const endTimer = pluginLogger?.timer(`Command: ${commandId}`);

        pluginLogger?.command(commandId, 'start', { params });

        try {
          const helpers = this.lifecycle.getHelpers(pluginId);
          if (!helpers) {
            throw new Error(`Helpers not found for plugin ${pluginId}`);
          }

          const result = await handler(params, helpers);

          endTimer?.();
          pluginLogger?.command(commandId, 'success', { result });
          await span.succeed({
            attrs: {
              pluginId,
              apiName: commandId,
              invocationType: 'command',
              source: 'command',
              callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
              result: summarizeForObservation(result, 2),
            },
          });

          return result;
        } catch (error: unknown) {
          endTimer?.();
          pluginLogger?.command(commandId, 'error', error);
          const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
          const artifact = await attachErrorContextArtifact({
            span,
            component: 'plugin-manager',
            label: 'plugin command failure context',
            data: {
              pluginId,
              apiName: commandId,
              invocationType: 'command',
              runtimeStatus: summarizeForObservation(runtimeStatus, 2),
            },
          });
          await span.fail(error, {
            artifactRefs: [artifact.artifactId],
            attrs: {
              pluginId,
              apiName: commandId,
              invocationType: 'command',
              source: 'command',
              callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            },
          });
          throw error;
        }
      });
    } finally {
      this.endCommandExecution(pluginId);
    }
  }

  registerCommandExecutionGuard(guard: CommandExecutionGuard): () => void {
    this.commandExecutionGuards.push(guard);
    return () => {
      const index = this.commandExecutionGuards.indexOf(guard);
      if (index >= 0) {
        this.commandExecutionGuards.splice(index, 1);
      }
    };
  }

  /**
   * 获取插件的 Context
   */
  getContext(pluginId: string): PluginContext | null {
    return this.lifecycle.getContext(pluginId) || null;
  }

  /**
   * 调用插件暴露的 API
   */
  async callPluginAPI(pluginId: string, apiName: string, args: any[]): Promise<any> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      pluginId,
      source: currentTraceContext?.source ?? 'plugin-manager',
      attributes: {
        apiName,
      },
    });

    this.beginCommandExecution(pluginId);
    try {
      return await withTraceContext(traceContext, async () => {
        const span = await observationService.startSpan({
          context: traceContext,
          component: 'plugin-manager',
          event: 'plugin.invoke',
          attrs: {
            pluginId,
            apiName,
            invocationType: 'api',
            source: 'api',
            callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            args: summarizeForObservation(args, 2),
          },
        });

        try {
          const context = this.lifecycle.getContext(pluginId);
          if (!context) {
            throw new Error(`Plugin ${pluginId} is not activated`);
          }

          const result = await context.callExposedAPI(apiName, args);
          await span.succeed({
            attrs: {
              pluginId,
              apiName,
              invocationType: 'api',
              source: 'api',
              callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
              result: summarizeForObservation(result, 2),
            },
          });
          return result;
        } catch (error) {
          const runtimeStatus = await this.getRuntimeStatus(pluginId).catch(() => null);
          const artifact = await attachErrorContextArtifact({
            span,
            component: 'plugin-manager',
            label: 'plugin api failure context',
            data: {
              pluginId,
              apiName,
              invocationType: 'api',
              runtimeStatus: summarizeForObservation(runtimeStatus, 2),
            },
          });
          await span.fail(error, {
            artifactRefs: [artifact.artifactId],
            attrs: {
              pluginId,
              apiName,
              invocationType: 'api',
              source: 'api',
              callerId: currentTraceContext?.pluginId ?? currentTraceContext?.source ?? 'internal',
            },
          });
          throw error;
        }
      });
    } finally {
      this.endCommandExecution(pluginId);
    }
  }

  /**
   * 获取插件暴露的 API 列表
   */
  getExposedAPIs(pluginId: string): string[] {
    const context = this.lifecycle.getContext(pluginId);
    if (!context) {
      throw new Error(`Plugin context not found: ${pluginId}`);
    }
    return Array.from((context as any).exposedAPIs.keys());
  }

  // ========== 自定义页面相关 ==========

  /**
   * 获取插件的自定义页面列表
   */
  async getCustomPages(pluginId: string, datasetId?: string): Promise<any[]> {
    return this.uiExtManager.getCustomPages(pluginId, datasetId);
  }

  /**
   * 渲染自定义页面内容
   */
  async renderCustomPage(pluginId: string, pageId: string, datasetId?: string): Promise<string> {
    const pluginInfo = await this.getPluginInfo(pluginId);
    if (!pluginInfo) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    return this.uiExtManager.renderCustomPage(pluginId, pageId, pluginInfo.path, datasetId);
  }

  /**
   * 处理页面消息
   */
  async handlePageMessage(message: any): Promise<any> {
    // 获取所有 contexts 和 helpers 的映射
    const contexts = new Map<string, PluginContext>();
    const helpers = new Map<string, PluginHelpers>();

    // 从 lifecycle 获取当前插件的 context 和 helpers
    const pluginId = message.pluginId;
    const context = this.lifecycle.getContext(pluginId);
    const helper = this.lifecycle.getHelpers(pluginId);

    if (context) {
      contexts.set(pluginId, context);
    }
    if (helper) {
      helpers.set(pluginId, helper);
    }

    return this.uiExtManager.handlePageMessage(
      message,
      contexts,
      helpers,
      (pid, commandId, params) => this.executeCommand(pid, commandId, params),
      (pid, apiName, args) => this.callPluginAPI(pid, apiName, args)
    );
  }
}
