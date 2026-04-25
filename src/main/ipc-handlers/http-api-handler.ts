/**
 * HttpApiIPCHandler - HTTP API 设置处理器
 * 负责：HTTP API 配置的读取和设置
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { handleIPCError } from '../ipc-utils';
import type Store from 'electron-store';
import type { WebhookSender } from '../webhook/sender';
import {
  DEFAULT_HTTP_API_CONFIG,
  HTTP_SERVER_DEFAULTS,
  getHttpApiRuntimeOverrideFlags,
  normalizeHttpApiConfig,
  resolveEffectiveHttpApiConfig,
  type HttpApiConfig,
} from '../../constants/http-api';
import { probeLocalHttpRuntime } from '../http-runtime-diagnostics';

const sameStringArray = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export class HttpApiIPCHandler {
  constructor(
    private store: Store,
    private webhookSender: WebhookSender,
    private startHttpServer: () => Promise<void>,
    private stopHttpServer: () => Promise<void>
  ) {}

  /**
   * 注册所有 HTTP API 相关的 IPC 处理器
   */
  register(): void {
    this.registerGetConfig();
    this.registerSetConfig();
    this.registerGetRuntimeStatus();
    this.registerRepairRuntime();

    console.log('  ✓ HttpApiIPCHandler registered');
  }

  private getStoredConfig(): HttpApiConfig {
    return normalizeHttpApiConfig(
      this.store.get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as Partial<HttpApiConfig>
    );
  }

  private getEffectiveConfig(): HttpApiConfig {
    return resolveEffectiveHttpApiConfig(this.getStoredConfig());
  }

  private getRuntimeOverrides(): { enabled: boolean; enableMcp: boolean } {
    return getHttpApiRuntimeOverrideFlags();
  }

  private createMetricsHeaders(config: HttpApiConfig): Record<string, string> {
    const metricsHeaders: Record<string, string> = {};
    if (config.enableAuth && config.token) {
      metricsHeaders.authorization = `Bearer ${config.token}`;
    }
    return metricsHeaders;
  }

  private async probeRuntime(config: HttpApiConfig) {
    return probeLocalHttpRuntime({
      port: HTTP_SERVER_DEFAULTS.PORT,
      metricsHeaders: this.createMetricsHeaders(config),
    });
  }

  /**
   * 获取 HTTP API 配置
   */
  private registerGetConfig(): void {
    ipcMain.handle('http-api:get-config', async (_event: IpcMainInvokeEvent) => {
      try {
        const storedConfig = this.getStoredConfig();
        const effectiveConfig = resolveEffectiveHttpApiConfig(storedConfig);
        this.store.set('httpApiConfig', storedConfig);

        return {
          success: true,
          storedConfig,
          effectiveConfig,
          runtimeOverrides: this.getRuntimeOverrides(),
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 设置 HTTP API 配置
   */
  private registerSetConfig(): void {
    ipcMain.handle(
      'http-api:set-config',
      async (_event: IpcMainInvokeEvent, config: Partial<HttpApiConfig>) => {
        try {
          const oldStoredConfig = this.getStoredConfig();
          const oldEffectiveConfig = resolveEffectiveHttpApiConfig(oldStoredConfig);
          const nextStoredConfig = normalizeHttpApiConfig({
            ...oldStoredConfig,
            ...config,
          });
          const nextEffectiveConfig = resolveEffectiveHttpApiConfig(nextStoredConfig);

          this.store.set('httpApiConfig', nextStoredConfig);

          if (nextStoredConfig.callbackUrl) {
            this.webhookSender.setCallbackUrl(nextStoredConfig.callbackUrl);
          } else {
            this.webhookSender.setCallbackUrl(undefined);
          }

          if (nextEffectiveConfig.enabled && !oldEffectiveConfig.enabled) {
            await this.startHttpServer();
          } else if (!nextEffectiveConfig.enabled && oldEffectiveConfig.enabled) {
            await this.stopHttpServer();
          } else if (nextEffectiveConfig.enabled) {
            const needsRestart =
              nextEffectiveConfig.enableMcp !== oldEffectiveConfig.enableMcp ||
              nextEffectiveConfig.enableAuth !== oldEffectiveConfig.enableAuth ||
              nextEffectiveConfig.token !== oldEffectiveConfig.token ||
              nextEffectiveConfig.mcpRequireAuth !== oldEffectiveConfig.mcpRequireAuth ||
              !sameStringArray(
                nextEffectiveConfig.mcpAllowedOrigins,
                oldEffectiveConfig.mcpAllowedOrigins
              ) ||
              nextEffectiveConfig.enforceOrchestrationScopes !==
                oldEffectiveConfig.enforceOrchestrationScopes ||
              nextEffectiveConfig.orchestrationIdempotencyStore !==
                oldEffectiveConfig.orchestrationIdempotencyStore;

            if (needsRestart) {
              console.log('[HTTP] Configuration changed, restarting server...');
              await this.stopHttpServer();
              await this.startHttpServer();
            }
          }

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 获取 HTTP API 运行时状态（健康信息 + 编排指标）
   */
  private registerGetRuntimeStatus(): void {
    ipcMain.handle('http-api:get-runtime-status', async (_event: IpcMainInvokeEvent) => {
      try {
        const config = this.getEffectiveConfig();
        const port = HTTP_SERVER_DEFAULTS.PORT;
        const runtime = await this.probeRuntime(config);

        return {
          success: true,
          running: runtime.running,
          reachable: runtime.reachable,
          port,
          health: runtime.health,
          metrics: runtime.metrics,
          runtimeAlerts: runtime.runtimeAlerts,
          diagnosis: runtime.diagnosis,
          error: runtime.running ? undefined : runtime.diagnosis.summary,
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 尝试修复 HTTP API 运行态问题。
   */
  private registerRepairRuntime(): void {
    ipcMain.handle('http-api:repair-runtime', async (_event: IpcMainInvokeEvent) => {
      try {
        const config = this.getEffectiveConfig();
        if (!config.enabled) {
          return {
            success: true,
            repaired: false,
            action: 'noop',
            port: HTTP_SERVER_DEFAULTS.PORT,
            running: false,
            reachable: false,
            health: null,
            metrics: null,
            runtimeAlerts: [],
            diagnosis: {
              code: 'no_listener',
              severity: 'warning',
              owner: 'unknown',
              summary: 'HTTP 服务器当前未启用或被运行时参数覆盖为禁用',
              suggestedAction: '先检查设置页中的生效配置与运行时覆盖提示，再执行修复。',
            },
            error: 'HTTP 服务器当前未启用或被运行时参数覆盖为禁用',
            message: 'HTTP 服务器当前未启用或被运行时参数覆盖为禁用，未执行修复。',
          };
        }

        const before = await this.probeRuntime(config);
        let action: 'started_self' | 'restarted_self' | 'blocked' | 'noop' | 'failed' = 'noop';
        let repaired = false;
        let message = 'HTTP 服务当前状态无需修复。';

        try {
          switch (before.diagnosis.code) {
            case 'healthy_self':
              await this.stopHttpServer();
              await this.startHttpServer();
              action = 'restarted_self';
              repaired = true;
              message = '已重启当前进程内的 HTTP 服务。';
              break;
            case 'no_listener':
              await this.startHttpServer();
              action = 'started_self';
              repaired = true;
              message = '已尝试启动当前进程内的 HTTP 服务。';
              break;
            case 'healthy_other_airpa':
            case 'unresponsive_listener':
            case 'unexpected_health_response':
              action = 'blocked';
              message =
                before.diagnosis.suggestedAction ||
                '当前端口已被其他进程占用，当前进程无法自动接管。';
              break;
          }
        } catch (repairError: unknown) {
          const errorMessage = repairError instanceof Error ? repairError.message : String(repairError);
          action = 'failed';
          repaired = false;
          message = `修复失败: ${errorMessage}`;
        }

        const after = await this.probeRuntime(config);

        return {
          success: true,
          repaired,
          action,
          message,
          running: after.running,
          reachable: after.reachable,
          port: after.port,
          health: after.health,
          metrics: after.metrics,
          runtimeAlerts: after.runtimeAlerts,
          diagnosis: after.diagnosis,
          error: after.running ? undefined : after.diagnosis.summary,
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }
}
