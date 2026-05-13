import fs from 'fs';
import type { Application, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { RestApiConfig, RestApiDependencies } from '../types/http-api';
import type { BrowserPoolManager } from '../core/browser-pool';
import {
  listCanonicalPublicCapabilityNames,
  listOrchestrationCapabilities,
} from '../core/ai-dev/orchestration';
import { acquireBrowserFromPool } from './http-browser-pool-adapter';
import { registerTokenAuthMiddleware } from './http-auth-middleware';
import { registerTraceContextMiddleware } from './http-trace-middleware';
import { registerHttpRoutes } from './http-route-registry';
import type { RuntimeMetricsSnapshot } from './http-session-manager';
import type { HttpRuntimeState } from './http-runtime-state';
import type { HttpSessionBridge } from './http-session-bridge';
import type { StructuredError } from '../types/error-codes';
import { firstString, parseRequestedRuntimeId, parseScopesHeader } from './http-request-utils';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { buildHealthPayload } from './http-system-routes';
import { getHttpApiAuthToken } from './http-api-config-guard';
import type { JSPluginInfo, JSPluginRuntimeStatus } from '../types/js-plugin';
import type { CreateProfileParams, UpdateProfileParams } from '../types/profile';
import { ErrorCode, createStructuredError } from '../types/error-codes';
import { createDuckDbOrchestrationIdempotencyPersistence } from './orchestration-idempotency-duckdb-store';
import type { JSPluginManager } from '../core/js-plugin/manager';
import type { DuckDBService } from './duckdb/service';
import type { WebContentsViewManager } from './webcontentsview-manager';
import type { WindowManager } from './window-manager';
import type { FingerprintManager } from '../core/stealth/fingerprint-manager';
import type { PluginRegistry } from '../core/js-plugin/registry';
import type { CloudRuntimePluginProvider } from '../edition/types';
import type { BrowserRuntimeManager } from '../core/browser-runtime';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface CreateHttpServerCompositionOptions {
  serverName: string;
  serverVersion: string;
  dependencies?: RestApiDependencies;
  restApiConfig?: RestApiConfig;
  runtimeState: HttpRuntimeState;
  runtimeMetrics: RuntimeMetricsSnapshot;
  sessionBridge: HttpSessionBridge;
  getBrowserPoolManager?: () => BrowserPoolManager;
  normalizeStructuredError: (error: unknown) => StructuredError;
  mapErrorStatus: (code: string, fallback?: number) => number;
  mapStructuredErrorStatus: (error: StructuredError, fallback?: number) => number;
  asyncHandler: (
    handler: (req: Request, res: Response) => Promise<void>
  ) => (req: Request, res: Response) => Promise<void>;
  logger: LoggerLike;
}

/**
 * 组装 HTTP 服务器应用（express + middleware + routes）。
 */
export const createHttpServerComposition = (
  options: CreateHttpServerCompositionOptions
): Application => {
  const app = createMcpExpressApp({
    host: HTTP_SERVER_DEFAULTS.BIND_ADDRESS,
  });
  const mcpConfigured = options.restApiConfig?.enableMcp ?? false;
  const mcpEndpointEnabled = mcpConfigured;
  const systemGateway = options.dependencies?.systemGateway ?? {
    getHealth: async () =>
      buildHealthPayload({
        serverName: options.serverName,
        serverVersion: options.serverVersion,
        restApiConfig: options.restApiConfig,
        mcpConfigured,
        mcpEndpointEnabled,
        getSessionCounts: () => ({
          activeSessions:
            options.runtimeState.transports.size +
            options.runtimeState.orchestrationSessions.size,
          mcpSessions: options.runtimeState.transports.size,
          orchestrationSessions: options.runtimeState.orchestrationSessions.size,
        }),
        getRuntimeMetrics: () => options.sessionBridge.buildRuntimeMetricsPayload(),
      }),
    listPublicCapabilities: async () =>
      listCanonicalPublicCapabilityNames(listOrchestrationCapabilities()),
  };
  const effectiveDependencies: RestApiDependencies = {
    ...(options.dependencies || {}),
    systemGateway: {
      ...systemGateway,
      ...(systemGateway.listBrowserRuntimeStatuses
        ? {}
        : options.dependencies?.browserRuntimeManager
          ? {
              listBrowserRuntimeStatuses: async () =>
                options.dependencies?.browserRuntimeManager?.listRuntimeStatuses() ?? [],
            }
          : {}),
    },
  };
  registerTraceContextMiddleware(app);

  const authToken = options.restApiConfig ? getHttpApiAuthToken(options.restApiConfig) : undefined;
  if (authToken) {
    registerTokenAuthMiddleware({
      app,
      expectedToken: authToken,
      restApiConfig: options.restApiConfig,
      logger: options.logger,
    });
  }

  registerHttpRoutes({
    server: {
      app,
      serverName: options.serverName,
      serverVersion: options.serverVersion,
      restApiConfig: options.restApiConfig,
      dependencies: effectiveDependencies,
      logger: options.logger,
    },
    sessions: {
      transports: options.runtimeState.transports,
      orchestrationSessions: options.runtimeState.orchestrationSessions,
      buildRuntimeMetricsPayload: () => options.sessionBridge.buildRuntimeMetricsPayload(),
      getSessionCounts: () => ({
        activeSessions:
          options.runtimeState.transports.size + options.runtimeState.orchestrationSessions.size,
        mcpSessions: options.runtimeState.transports.size,
        orchestrationSessions: options.runtimeState.orchestrationSessions.size,
      }),
    },
    auth: {
      parseScopesHeader,
      firstString,
    },
    browser: {
      browserPoolAvailable: Boolean(options.getBrowserPoolManager),
      parseRequestedRuntimeId,
      acquireBrowserFromPool: (profileId, runtimeId, source = 'mcp') =>
        acquireBrowserFromPool({
          getBrowserPoolManager: options.getBrowserPoolManager,
          runtimeMetrics: options.runtimeMetrics,
          logger: options.logger,
          profileId,
          runtimeId,
          source,
        }),
      getBrowserPoolManager: options.getBrowserPoolManager,
    },
    invoke: {
      enqueueInvokeTask: (sessionLabel, session, task, invokeOptions) =>
        options.sessionBridge.enqueueInvokeTask(sessionLabel, session, task, invokeOptions),
      cleanupSession: (sessionId, session) =>
        options.sessionBridge.cleanupMcpSession(sessionId, session),
      enqueueOrchestrationInvoke: (sessionId, session, task) =>
        options.sessionBridge.enqueueOrchestrationInvoke(sessionId, session, task),
      cleanupOrchestrationSession: (sessionId, session) =>
        options.sessionBridge.cleanupOrchestrationSession(sessionId, session),
    },
    errors: {
      normalizeStructuredError: options.normalizeStructuredError,
      mapErrorStatus: options.mapErrorStatus,
      mapStructuredErrorStatus: options.mapStructuredErrorStatus,
      asyncHandler: options.asyncHandler,
    },
  });

  return app;
};

export interface BuildRestApiDependenciesRuntime {
  duckdbService: DuckDBService;
  jsPluginManager: JSPluginManager;
  viewManager: WebContentsViewManager;
  windowManager: WindowManager;
  fingerprintManager: FingerprintManager;
  browserRuntimeManager?: BrowserRuntimeManager;
  getBrowserPoolManager: () => BrowserPoolManager;
  getPluginRegistry: () => PluginRegistry;
  cloudRuntimePluginProvider?: CloudRuntimePluginProvider;
}

export interface BuildRestApiDependenciesOptions {
  runtime: BuildRestApiDependenciesRuntime;
  httpApiConfig: { orchestrationIdempotencyStore?: 'memory' | 'duckdb' };
}

export function buildRestApiDependencies(
  options: BuildRestApiDependenciesOptions
): RestApiDependencies {
  const { runtime, httpApiConfig } = options;
  const { duckdbService, jsPluginManager, viewManager, windowManager } = runtime;

  const toOrchestrationProfile = (profile: {
    id?: unknown;
    name?: unknown;
    runtimeId?: unknown;
    status?: unknown;
    partition?: unknown;
    isSystem?: unknown;
    totalUses?: unknown;
    lastActiveAt?: Date | null;
    updatedAt?: Date | null;
  }) => ({
    id: String(profile.id || ''),
    name: String(profile.name || ''),
    runtimeId: String(profile.runtimeId || ''),
    status: String(profile.status || ''),
    partition: String(profile.partition || ''),
    isSystem: profile.isSystem === true,
    totalUses: Number.isFinite(profile.totalUses) ? Number(profile.totalUses) : 0,
    lastActiveAt: profile.lastActiveAt ? profile.lastActiveAt.toISOString() : '',
    updatedAt: profile.updatedAt ? profile.updatedAt.toISOString() : '',
  });

  const toOrchestrationPluginInfo = (plugin: JSPluginInfo) => ({
    id: String(plugin.id || ''),
    name: String(plugin.name || ''),
    version: String(plugin.version || ''),
    author: String(plugin.author || ''),
    ...(typeof plugin.description === 'string' && plugin.description.trim()
      ? { description: plugin.description.trim() }
      : {}),
    ...(typeof plugin.icon === 'string' && plugin.icon.trim() ? { icon: plugin.icon.trim() } : {}),
    ...(typeof plugin.category === 'string' && plugin.category.trim()
      ? { category: plugin.category.trim() }
      : {}),
    installedAt:
      typeof plugin.installedAt === 'number' && Number.isFinite(plugin.installedAt)
        ? plugin.installedAt
        : 0,
    path: String(plugin.path || ''),
    enabled: plugin.enabled !== false,
    ...(typeof plugin.hasActivityBarView === 'boolean'
      ? { hasActivityBarView: plugin.hasActivityBarView }
      : {}),
    ...(typeof plugin.activityBarViewOrder === 'number' &&
    Number.isFinite(plugin.activityBarViewOrder)
      ? { activityBarViewOrder: plugin.activityBarViewOrder }
      : {}),
    ...(typeof plugin.activityBarViewIcon === 'string' && plugin.activityBarViewIcon.trim()
      ? { activityBarViewIcon: plugin.activityBarViewIcon.trim() }
      : {}),
    ...(typeof plugin.devMode === 'boolean' ? { devMode: plugin.devMode } : {}),
    ...(typeof plugin.sourcePath === 'string' && plugin.sourcePath.trim()
      ? { sourcePath: plugin.sourcePath.trim() }
      : {}),
    ...(typeof plugin.isSymlink === 'boolean' ? { isSymlink: plugin.isSymlink } : {}),
    ...(typeof plugin.hotReloadEnabled === 'boolean'
      ? { hotReloadEnabled: plugin.hotReloadEnabled }
      : {}),
    ...(plugin.sourceType ? { sourceType: plugin.sourceType } : {}),
    ...(plugin.installChannel ? { installChannel: plugin.installChannel } : {}),
    ...(typeof plugin.cloudPluginCode === 'string' && plugin.cloudPluginCode.trim()
      ? { cloudPluginCode: plugin.cloudPluginCode.trim() }
      : {}),
    ...(typeof plugin.cloudReleaseVersion === 'string' && plugin.cloudReleaseVersion.trim()
      ? { cloudReleaseVersion: plugin.cloudReleaseVersion.trim() }
      : {}),
    ...(typeof plugin.managedByPolicy === 'boolean'
      ? { managedByPolicy: plugin.managedByPolicy }
      : {}),
    ...(typeof plugin.policyVersion === 'string' && plugin.policyVersion.trim()
      ? { policyVersion: plugin.policyVersion.trim() }
      : {}),
    ...(typeof plugin.lastPolicySyncAt === 'number' && Number.isFinite(plugin.lastPolicySyncAt)
      ? { lastPolicySyncAt: plugin.lastPolicySyncAt }
      : {}),
  });

  const toOrchestrationPluginRuntimeStatus = (status: JSPluginRuntimeStatus) => ({
    pluginId: String(status.pluginId || ''),
    ...(typeof status.pluginName === 'string' && status.pluginName.trim()
      ? { pluginName: status.pluginName.trim() }
      : {}),
    lifecyclePhase: status.lifecyclePhase,
    workState: status.workState,
    activeQueues:
      typeof status.activeQueues === 'number' && Number.isFinite(status.activeQueues)
        ? status.activeQueues
        : 0,
    runningTasks:
      typeof status.runningTasks === 'number' && Number.isFinite(status.runningTasks)
        ? status.runningTasks
        : 0,
    pendingTasks:
      typeof status.pendingTasks === 'number' && Number.isFinite(status.pendingTasks)
        ? status.pendingTasks
        : 0,
    failedTasks:
      typeof status.failedTasks === 'number' && Number.isFinite(status.failedTasks)
        ? status.failedTasks
        : 0,
    cancelledTasks:
      typeof status.cancelledTasks === 'number' && Number.isFinite(status.cancelledTasks)
        ? status.cancelledTasks
        : 0,
    ...(typeof status.currentSummary === 'string' && status.currentSummary.trim()
      ? { currentSummary: status.currentSummary.trim() }
      : {}),
    ...(typeof status.currentOperation === 'string' && status.currentOperation.trim()
      ? { currentOperation: status.currentOperation.trim() }
      : {}),
    ...(typeof status.progressPercent === 'number' && Number.isFinite(status.progressPercent)
      ? { progressPercent: status.progressPercent }
      : {}),
    ...(status.lastError &&
    typeof status.lastError.message === 'string' &&
    Number.isFinite(status.lastError.at)
      ? {
          lastError: {
            message: status.lastError.message,
            at: status.lastError.at,
          },
        }
      : {}),
    ...(typeof status.lastActivityAt === 'number' && Number.isFinite(status.lastActivityAt)
      ? { lastActivityAt: status.lastActivityAt }
      : {}),
    updatedAt:
      typeof status.updatedAt === 'number' && Number.isFinite(status.updatedAt)
        ? status.updatedAt
        : Date.now(),
  });

  const profileService = duckdbService.getProfileService();
  const hasProfileRuntimeMutation = (params: UpdateProfileParams) =>
    params.fingerprint !== undefined ||
    params.runtimeId !== undefined ||
    params.runtimeSourceOverride !== undefined ||
    params.proxy !== undefined ||
    params.quota !== undefined ||
    params.idleTimeoutMs !== undefined ||
    params.lockTimeoutMs !== undefined;

  const dependencies: RestApiDependencies = {
    viewManager,
    windowManager,
    datasetGateway: {
      listDatasets: () => duckdbService.listDatasets(),
      getDatasetInfo: (datasetId) => duckdbService.getDatasetInfo(datasetId),
      queryDataset: (datasetId, sql, offset, limit) =>
        duckdbService.queryDataset(datasetId, sql, offset, limit),
      createEmptyDataset: (datasetName, options) =>
        duckdbService.createEmptyDataset(datasetName, options),
      importDatasetFile: (filePath, datasetName, options) =>
        duckdbService.importDatasetFile(filePath, datasetName, options),
      renameDataset: (datasetId, newName) => duckdbService.renameDataset(datasetId, newName),
      deleteDataset: (datasetId) => duckdbService.deleteDataset(datasetId),
    },
    crossPluginGateway: {
      listCallableApis: () => runtime.getPluginRegistry().listMCPCallableAPIs(),
      callApi: (pluginId, apiName, params = []) =>
        runtime.getPluginRegistry().callPluginAPIFromMCP(pluginId, apiName, params),
    },
    ...(runtime.browserRuntimeManager
      ? { browserRuntimeManager: runtime.browserRuntimeManager }
      : {}),
    pluginGateway: {
      listPlugins: async () => {
        const plugins = await jsPluginManager.listPlugins();
        return plugins.map((plugin) => toOrchestrationPluginInfo(plugin));
      },
      getPlugin: async (pluginId: string) => {
        const plugin = await jsPluginManager.getPluginInfo(String(pluginId || '').trim());
        return plugin ? toOrchestrationPluginInfo(plugin) : null;
      },
      listRuntimeStatuses: async () => {
        const statuses = await jsPluginManager.listRuntimeStatuses();
        return statuses.map((status) => toOrchestrationPluginRuntimeStatus(status));
      },
      getRuntimeStatus: async (pluginId: string) => {
        const status = await jsPluginManager.getRuntimeStatus(String(pluginId || '').trim());
        return status ? toOrchestrationPluginRuntimeStatus(status) : null;
      },
      installPlugin: async (request) => {
        if (request.sourceType === 'cloud_code') {
          const runtimePluginProvider = runtime.cloudRuntimePluginProvider;
          if (!runtimePluginProvider) {
            throw createStructuredError(
              ErrorCode.INVALID_PARAMETER,
              'cloud plugin install is not available in this edition'
            );
          }

          const cloudPluginCode = String(request.cloudPluginCode || '').trim();
          if (!cloudPluginCode) {
            throw createStructuredError(
              ErrorCode.INVALID_PARAMETER,
              'cloudPluginCode is required for cloud plugin install'
            );
          }

          const pkg = await runtimePluginProvider.fetchInstallPackage({
            pluginCode: cloudPluginCode,
          });
          try {
            const result = await jsPluginManager.installOrUpdateCloudPlugin(pkg.tempZipPath, {
              devMode: false,
              sourceType: 'cloud_managed',
              installChannel: 'cloud_download',
              trustedFirstParty: true,
              cloudPluginCode: pkg.pluginCode,
              cloudReleaseVersion: pkg.releaseVersion,
              managedByPolicy: true,
              policyVersion: pkg.policyVersion,
              lastPolicySyncAt: Date.now(),
            });
            if (!result.success || !result.pluginId) {
              throw new Error(result.error || 'Failed to install cloud plugin');
            }
            return {
              pluginId: result.pluginId,
              operation: result.operation || 'installed',
              sourceType: 'cloud_code' as const,
              ...(result.warnings?.length ? { warnings: result.warnings } : {}),
            };
          } finally {
            if (pkg.tempZipPath) {
              await fs.promises.rm(pkg.tempZipPath, { force: true }).catch(() => undefined);
            }
          }
        }

        const sourcePath = String(request.sourcePath || '').trim();
        if (!sourcePath) {
          throw createStructuredError(
            ErrorCode.INVALID_PARAMETER,
            'sourcePath is required for local plugin install'
          );
        }
        const result = await jsPluginManager.import(sourcePath, {
          devMode: request.devMode === true,
          trustedFirstParty: true,
        });
        if (!result.success || !result.pluginId) {
          throw new Error(result.error || 'Failed to install local plugin');
        }
        return {
          pluginId: result.pluginId,
          operation: result.operation || 'installed',
          sourceType: 'local_path' as const,
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        };
      },
      reloadPlugin: async (pluginId: string) => {
        await jsPluginManager.reload(String(pluginId || '').trim());
      },
      uninstallPlugin: async (pluginId: string, options?: { deleteTables?: boolean }) => {
        await jsPluginManager.uninstall(
          String(pluginId || '').trim(),
          options?.deleteTables === true
        );
      },
    },
    profileGateway: {
      listProfiles: async () => {
        const profiles = await profileService.list();
        return profiles.map((p) => toOrchestrationProfile(p));
      },
      getProfile: async (profileId: string) => {
        const profile = await profileService.get(String(profileId || '').trim());
        if (!profile) return null;
        return toOrchestrationProfile(profile);
      },
      resolveProfile: async (query: string) => {
        const q = String(query || '').trim();
        if (!q) return null;

        const byId = await profileService.get(q);
        if (byId) {
          return {
            query: q,
            matchedBy: 'id' as const,
            profile: toOrchestrationProfile(byId),
          };
        }

        const profiles = await profileService.list();
        const byName = profiles.filter((p) => String(p.name || '').trim() === q);
        if (!byName.length) return null;
        if (byName.length > 1) {
          throw createStructuredError(
            ErrorCode.INVALID_PARAMETER,
            `Profile query "${q}" matches multiple profiles`,
            {
              suggestion:
                'Use profile_resolve with an exact profile id, or disambiguate by listing profiles first',
              context: {
                query: q,
                candidateCount: byName.length,
                candidates: byName.map((item) => toOrchestrationProfile(item)),
              },
            }
          );
        }
        return {
          query: q,
          matchedBy: 'name' as const,
          profile: toOrchestrationProfile(byName[0]),
        };
      },
      createProfile: async (params: CreateProfileParams) => {
        const profile = await profileService.create(params);
        return toOrchestrationProfile(profile);
      },
      updateProfile: async (id: string, params: UpdateProfileParams) => {
        const updated = await profileService.update(id, params);

        if (hasProfileRuntimeMutation(params)) {
          try {
            runtime.fingerprintManager.clearCache(updated.id);
          } catch {
            // ignore
          }

          try {
            runtime.fingerprintManager.clearCache(updated.partition);
          } catch {
            // ignore
          }

          try {
            const poolManager = runtime.getBrowserPoolManager();
            await poolManager.destroyProfileBrowsers(id);
          } catch {
            // ignore
          }
        }

        return toOrchestrationProfile(updated);
      },
      deleteProfile: async (id: string) => {
        try {
          const poolManager = runtime.getBrowserPoolManager();
          await poolManager.destroyProfileBrowsers(id);
        } catch {
          // ignore
        }

        await profileService.deleteWithCascade(id);
      },
    },
    observationGateway: {
      getTraceSummary: (traceId: string) => duckdbService.getTraceSummary(traceId),
      getFailureBundle: (traceId: string) => duckdbService.getFailureBundle(traceId),
      getTraceTimeline: (traceId: string, limit?: number) =>
        duckdbService.getTraceTimeline(traceId, limit),
      searchRecentFailures: (limit?: number) => duckdbService.searchRecentFailures(limit),
    },
    ...(httpApiConfig.orchestrationIdempotencyStore === 'duckdb'
      ? {
          idempotencyPersistence: createDuckDbOrchestrationIdempotencyPersistence(duckdbService),
        }
      : {}),
  };

  return dependencies;
}
