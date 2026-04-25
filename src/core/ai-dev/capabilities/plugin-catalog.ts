import fs from 'node:fs';
import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationDependencies,
  OrchestrationPluginInfo,
  OrchestrationPluginRuntimeStatus,
} from '../orchestration/types';
import type { CapabilityHandler } from './types';
import type { RegisteredCapability } from './browser-catalog';
import { createStructuredResult } from './result-utils';
import {
  buildCapabilityAnnotations,
  type CapabilityMetadata,
  createArrayItemsSchema,
  createStructuredEnvelopeSchema,
  toCapabilityTitle,
} from './catalog-utils';

const PLUGIN_CAPABILITY_VERSION = '1.0.0';

const PLUGIN_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 300,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['plugin.read'],
  requires: ['pluginGateway'],
};

const PLUGIN_WRITE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'low',
  estimatedLatencyMs: 800,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['plugin.write'],
  requires: ['pluginGateway'],
};

const PLUGIN_INSTALL_METADATA: CapabilityMetadata = {
  ...PLUGIN_WRITE_METADATA,
  sideEffectLevel: 'high',
  estimatedLatencyMs: 5000,
};

const PLUGIN_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'version', 'author', 'installedAt', 'path', 'enabled'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'string' },
    author: { type: 'string' },
    description: { type: 'string' },
    icon: { type: 'string' },
    category: { type: 'string' },
    installedAt: { type: 'number' },
    path: { type: 'string' },
    hasActivityBarView: { type: 'boolean' },
    activityBarViewOrder: { type: 'number' },
    activityBarViewIcon: { type: 'string' },
    enabled: { type: 'boolean' },
    devMode: { type: 'boolean' },
    sourcePath: { type: 'string' },
    isSymlink: { type: 'boolean' },
    hotReloadEnabled: { type: 'boolean' },
    sourceType: { type: 'string', enum: ['local_private', 'cloud_managed'] },
    installChannel: { type: 'string', enum: ['manual_import', 'cloud_download'] },
    cloudPluginCode: { type: 'string' },
    cloudReleaseVersion: { type: 'string' },
    managedByPolicy: { type: 'boolean' },
    policyVersion: { type: 'string' },
    lastPolicySyncAt: { type: 'number' },
  },
} as const;

const PLUGIN_RUNTIME_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'at'],
  properties: {
    message: { type: 'string' },
    at: { type: 'number' },
  },
} as const;

const PLUGIN_RUNTIME_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pluginId',
    'lifecyclePhase',
    'workState',
    'activeQueues',
    'runningTasks',
    'pendingTasks',
    'failedTasks',
    'cancelledTasks',
    'updatedAt',
  ],
  properties: {
    pluginId: { type: 'string' },
    pluginName: { type: 'string' },
    lifecyclePhase: {
      type: 'string',
      enum: ['disabled', 'inactive', 'starting', 'active', 'stopping', 'error'],
    },
    workState: { type: 'string', enum: ['idle', 'busy', 'error'] },
    activeQueues: { type: 'number' },
    runningTasks: { type: 'number' },
    pendingTasks: { type: 'number' },
    failedTasks: { type: 'number' },
    cancelledTasks: { type: 'number' },
    currentSummary: { type: 'string' },
    currentOperation: { type: 'string' },
    progressPercent: { type: 'number' },
    lastError: PLUGIN_RUNTIME_ERROR_SCHEMA,
    lastActivityAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
} as const;

const PLUGIN_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plugin', 'runtime'],
  properties: {
    plugin: PLUGIN_INFO_SCHEMA,
    runtime: PLUGIN_RUNTIME_STATUS_SCHEMA,
  },
} as const;

const PLUGIN_LIST_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['total', 'plugins', 'filter'],
  properties: {
    total: { type: 'number' },
    plugins: {
      type: 'array',
      items: PLUGIN_SUMMARY_SCHEMA,
    },
    filter: {
      type: 'object',
      additionalProperties: false,
      required: ['query', 'enabled', 'sourceType', 'limit'],
      properties: {
        query: { type: ['string', 'null'] },
        enabled: { type: ['boolean', 'null'] },
        sourceType: { type: ['string', 'null'], enum: ['local_private', 'cloud_managed', null] },
        limit: { type: ['number', 'null'] },
      },
    },
  },
});

const PLUGIN_RUNTIME_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['pluginId', 'plugin', 'status'],
  properties: {
    pluginId: { type: 'string' },
    plugin: PLUGIN_INFO_SCHEMA,
    status: PLUGIN_RUNTIME_STATUS_SCHEMA,
  },
});

const PLUGIN_RELOAD_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['pluginId', 'plugin', 'reloaded'],
  properties: {
    pluginId: { type: 'string' },
    plugin: PLUGIN_INFO_SCHEMA,
    reloaded: { type: 'boolean' },
  },
});

const PLUGIN_UNINSTALL_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['pluginId', 'pluginName', 'deleteTables', 'uninstalled'],
  properties: {
    pluginId: { type: 'string' },
    pluginName: { type: 'string' },
    deleteTables: { type: 'boolean' },
    uninstalled: { type: 'boolean' },
  },
});

const PLUGIN_INSTALL_OUTPUT_SCHEMA = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['pluginId', 'operation', 'sourceType'],
  properties: {
    pluginId: { type: 'string' },
    operation: { type: 'string', enum: ['installed', 'updated'] },
    sourceType: { type: 'string', enum: ['local_path', 'cloud_code'] },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
    plugin: PLUGIN_INFO_SCHEMA,
  },
});

const asText = (value: unknown): string => String(value == null ? '' : value).trim();

const readStringArg = (
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {}
): string | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be string`);
  }
  const value = raw.trim();
  if (!value && options.required) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} cannot be empty`);
  }
  return value || undefined;
};

const readOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string
): boolean | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be boolean`);
  }
  return raw;
};

const readOptionalLimitArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 500) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be an integer between 1 and 500`
    );
  }
  return raw;
};

const readRequiredConfirmationArg = (args: Record<string, unknown>, key: string): true => {
  const raw = args[key];
  if (raw !== true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be true for this high-risk plugin operation`,
      {
        suggestion: `Re-issue the call with ${key}: true only after you have verified the plugin source and intended side effects.`,
        context: {
          parameter: key,
          expected: true,
        },
      }
    );
  }
  return true;
};

const isAbsoluteLocalPath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

const readExistingLocalPathArg = (
  args: Record<string, unknown>,
  key: string,
  options: {
    allowDirectory?: boolean;
    allowArchive?: boolean;
    devMode?: boolean;
  } = {}
): string => {
  const value = readStringArg(args, key, { required: true }) || '';
  if (!isAbsoluteLocalPath(value)) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be an absolute local path`,
      {
        suggestion: 'Pass an absolute path on the current machine instead of a relative path.',
        context: { parameter: key, value },
      }
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(value);
  } catch {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Path not found: ${value}`, {
      suggestion: 'Verify the plugin source exists on the host running Airpa before retrying.',
      context: { parameter: key, value },
    });
  }

  if (stats.isDirectory()) {
    if (options.allowDirectory !== true) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `Parameter ${key} must point to a plugin archive for this operation`,
        {
          suggestion: 'Use a .zip/.tsai archive, or set devMode=true when intentionally installing from a plugin directory.',
          context: { parameter: key, value, kind: 'directory' },
        }
      );
    }
    if (options.devMode !== true) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `Directory plugin installs require devMode=true`,
        {
          suggestion: 'Set devMode=true only when you intentionally want a local development install from a plugin directory.',
          context: { parameter: key, value, kind: 'directory' },
        }
      );
    }
    return value;
  }

  if (!stats.isFile()) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must point to a file or directory`,
      {
        context: { parameter: key, value },
      }
    );
  }

  if (options.allowArchive !== true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must point to a plugin directory for this operation`,
      {
        context: { parameter: key, value, kind: 'file' },
      }
    );
  }

  if (options.devMode === true) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'devMode=true only supports directory-based local installs',
      {
        suggestion: 'Use a plugin directory with devMode=true, or remove devMode when installing from a .zip/.tsai archive.',
        context: { parameter: key, value, kind: 'file' },
      }
    );
  }

  const lower = value.toLowerCase();
  if (!lower.endsWith('.zip') && !lower.endsWith('.tsai')) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must point to a .zip or .tsai plugin archive`,
      {
        context: { parameter: key, value },
      }
    );
  }

  return value;
};

const ensurePluginGateway = (deps: OrchestrationDependencies) => {
  if (!deps.pluginGateway) {
    throw createStructuredError(ErrorCode.OPERATION_FAILED, 'Plugin gateway is not configured', {
      suggestion: 'Please inject pluginGateway into orchestration dependencies',
    });
  }
  return deps.pluginGateway;
};

const normalizePluginInfo = (plugin: OrchestrationPluginInfo): OrchestrationPluginInfo => ({
  id: asText(plugin.id),
  name: asText(plugin.name),
  version: asText(plugin.version),
  author: asText(plugin.author),
  ...(asText(plugin.description) ? { description: asText(plugin.description) } : {}),
  ...(asText(plugin.icon) ? { icon: asText(plugin.icon) } : {}),
  ...(asText(plugin.category) ? { category: asText(plugin.category) } : {}),
  installedAt:
    typeof plugin.installedAt === 'number' && Number.isFinite(plugin.installedAt)
      ? plugin.installedAt
      : 0,
  path: asText(plugin.path),
  ...(typeof plugin.hasActivityBarView === 'boolean'
    ? { hasActivityBarView: plugin.hasActivityBarView }
    : {}),
  ...(typeof plugin.activityBarViewOrder === 'number' &&
  Number.isFinite(plugin.activityBarViewOrder)
    ? { activityBarViewOrder: plugin.activityBarViewOrder }
    : {}),
  ...(asText(plugin.activityBarViewIcon) ? { activityBarViewIcon: asText(plugin.activityBarViewIcon) } : {}),
  enabled: plugin.enabled !== false,
  ...(typeof plugin.devMode === 'boolean' ? { devMode: plugin.devMode } : {}),
  ...(asText(plugin.sourcePath) ? { sourcePath: asText(plugin.sourcePath) } : {}),
  ...(typeof plugin.isSymlink === 'boolean' ? { isSymlink: plugin.isSymlink } : {}),
  ...(typeof plugin.hotReloadEnabled === 'boolean'
    ? { hotReloadEnabled: plugin.hotReloadEnabled }
    : {}),
  ...(plugin.sourceType ? { sourceType: plugin.sourceType } : {}),
  ...(plugin.installChannel ? { installChannel: plugin.installChannel } : {}),
  ...(asText(plugin.cloudPluginCode) ? { cloudPluginCode: asText(plugin.cloudPluginCode) } : {}),
  ...(asText(plugin.cloudReleaseVersion)
    ? { cloudReleaseVersion: asText(plugin.cloudReleaseVersion) }
    : {}),
  ...(typeof plugin.managedByPolicy === 'boolean' ? { managedByPolicy: plugin.managedByPolicy } : {}),
  ...(asText(plugin.policyVersion) ? { policyVersion: asText(plugin.policyVersion) } : {}),
  ...(typeof plugin.lastPolicySyncAt === 'number' && Number.isFinite(plugin.lastPolicySyncAt)
    ? { lastPolicySyncAt: plugin.lastPolicySyncAt }
    : {}),
});

const normalizeRuntimeStatus = (
  status: OrchestrationPluginRuntimeStatus
): OrchestrationPluginRuntimeStatus => ({
  pluginId: asText(status.pluginId),
  ...(asText(status.pluginName) ? { pluginName: asText(status.pluginName) } : {}),
  lifecyclePhase: status.lifecyclePhase,
  workState: status.workState,
  activeQueues: Number(status.activeQueues || 0),
  runningTasks: Number(status.runningTasks || 0),
  pendingTasks: Number(status.pendingTasks || 0),
  failedTasks: Number(status.failedTasks || 0),
  cancelledTasks: Number(status.cancelledTasks || 0),
  ...(asText(status.currentSummary) ? { currentSummary: asText(status.currentSummary) } : {}),
  ...(asText(status.currentOperation) ? { currentOperation: asText(status.currentOperation) } : {}),
  ...(typeof status.progressPercent === 'number' && Number.isFinite(status.progressPercent)
    ? { progressPercent: status.progressPercent }
    : {}),
  ...(status.lastError?.message
    ? {
        lastError: {
          message: asText(status.lastError.message),
          at: Number(status.lastError.at || 0),
        },
      }
    : {}),
  ...(typeof status.lastActivityAt === 'number' && Number.isFinite(status.lastActivityAt)
    ? { lastActivityAt: status.lastActivityAt }
    : {}),
  updatedAt: Number(status.updatedAt || 0),
});

const formatPluginLine = (
  plugin: OrchestrationPluginInfo,
  runtime: OrchestrationPluginRuntimeStatus
): string => {
  const pieces = [
    plugin.id,
    plugin.name,
    `v${plugin.version}`,
    plugin.enabled ? 'enabled' : 'disabled',
    runtime.lifecyclePhase,
    runtime.workState,
  ];
  if (runtime.currentSummary) {
    pieces.push(runtime.currentSummary);
  }
  return `- ${pieces.join(' | ')}`;
};

const pluginListHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensurePluginGateway(deps);
  const query = asText(readStringArg(args, 'query')).toLowerCase();
  const enabled = readOptionalBooleanArg(args, 'enabled');
  const sourceType = readStringArg(args, 'sourceType');
  if (sourceType && sourceType !== 'local_private' && sourceType !== 'cloud_managed') {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter sourceType must be "local_private" or "cloud_managed"'
    );
  }
  const limit = readOptionalLimitArg(args, 'limit');

  const plugins = (await gateway.listPlugins()).map(normalizePluginInfo);
  const runtimeMap = new Map(
    (await gateway.listRuntimeStatuses()).map((status) => [
      status.pluginId,
      normalizeRuntimeStatus(status),
    ])
  );

  const combined = plugins
    .map((plugin) => ({
      plugin,
      runtime:
        runtimeMap.get(plugin.id) ||
        normalizeRuntimeStatus({
          pluginId: plugin.id,
          pluginName: plugin.name,
          lifecyclePhase: plugin.enabled ? 'inactive' : 'disabled',
          workState: 'idle',
          activeQueues: 0,
          runningTasks: 0,
          pendingTasks: 0,
          failedTasks: 0,
          cancelledTasks: 0,
          updatedAt: plugin.installedAt,
        }),
    }))
    .filter(({ plugin, runtime }) => {
      if (typeof enabled === 'boolean' && plugin.enabled !== enabled) {
        return false;
      }
      if (sourceType && plugin.sourceType !== sourceType) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        plugin.id,
        plugin.name,
        plugin.version,
        plugin.author,
        plugin.category || '',
        plugin.cloudPluginCode || '',
        runtime.lifecyclePhase,
        runtime.workState,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

  const filtered = typeof limit === 'number' ? combined.slice(0, limit) : combined;
  const truncated = typeof limit === 'number' && filtered.length < combined.length;

  return createStructuredResult({
    summary: [
      `Found ${combined.length} plugin(s) matching the current filter.`,
      truncated ? `Returned the first ${filtered.length} result(s) because limit=${limit}.` : '',
      ...filtered.slice(0, 5).map(({ plugin, runtime }) => formatPluginLine(plugin, runtime)),
    ]
      .filter(Boolean)
      .join('\n'),
    data: {
      total: combined.length,
      plugins: filtered,
      filter: {
        query: query || null,
        enabled: enabled ?? null,
        sourceType: sourceType || null,
        limit: limit ?? null,
      },
    },
    truncated,
    nextActionHints: [
      'Use plugin_get_runtime_status when one plugin needs a focused runtime snapshot.',
      'Use cross_plugin_list_apis when you need the MCP-callable APIs exposed by installed plugins.',
    ],
    recommendedNextTools: ['plugin_get_runtime_status', 'cross_plugin_list_apis'],
    authoritativeFields: [
      'structuredContent.data.plugins[*].plugin.id',
      'structuredContent.data.plugins[*].runtime.lifecyclePhase',
    ],
  });
};

const pluginGetRuntimeStatusHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensurePluginGateway(deps);
  const pluginId = readStringArg(args, 'pluginId', { required: true }) || '';
  const plugin = await gateway.getPlugin(pluginId);
  if (!plugin) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Plugin not found: ${pluginId}`, {
      context: { pluginId },
    });
  }

  const status = await gateway.getRuntimeStatus(pluginId);
  const normalizedPlugin = normalizePluginInfo(plugin);
  const normalizedStatus =
    status &&
    normalizeRuntimeStatus(status);

  if (!normalizedStatus) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      `Runtime status is not available for plugin ${pluginId}`,
      {
        context: { pluginId },
      }
    );
  }

  return createStructuredResult({
    summary: [
      `Runtime status loaded for plugin ${normalizedPlugin.id}.`,
      formatPluginLine(normalizedPlugin, normalizedStatus),
    ].join('\n'),
    data: {
      pluginId: normalizedPlugin.id,
      plugin: normalizedPlugin,
      status: normalizedStatus,
    },
    nextActionHints: [
      'Use observation_get_trace_summary after a plugin-related failure when you already have the traceId.',
      'Use plugin_list to compare this plugin against the rest of the installed set.',
    ],
    recommendedNextTools: ['plugin_list', 'observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.plugin.id',
      'structuredContent.data.status.lifecyclePhase',
      'structuredContent.data.status.workState',
    ],
  });
};

const pluginInstallHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensurePluginGateway(deps);
  readRequiredConfirmationArg(args, 'confirmRisk');

  const sourceType = readStringArg(args, 'sourceType', { required: true }) || '';
  if (sourceType !== 'local_path' && sourceType !== 'cloud_code') {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      'Parameter sourceType must be "local_path" or "cloud_code"'
    );
  }

  const devMode = readOptionalBooleanArg(args, 'devMode');

  let installResult;
  if (sourceType === 'local_path') {
    const sourcePath = readExistingLocalPathArg(args, 'sourcePath', {
      allowDirectory: true,
      allowArchive: true,
      devMode,
    });
    installResult = await gateway.installPlugin({
      sourceType,
      sourcePath,
      devMode: devMode === true,
    });
  } else {
    if (devMode !== undefined) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        'Parameter devMode is only valid when sourceType is "local_path"',
        {
          context: { sourceType, devMode },
        }
      );
    }
    if (args.sourcePath !== undefined) {
      throw createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        'Parameter sourcePath is only valid when sourceType is "local_path"',
        {
          context: { sourceType },
        }
      );
    }
    const cloudPluginCode = readStringArg(args, 'cloudPluginCode', { required: true }) || '';
    installResult = await gateway.installPlugin({
      sourceType,
      cloudPluginCode,
    });
  }

  const plugin = await gateway.getPlugin(installResult.pluginId);
  const normalizedPlugin = plugin ? normalizePluginInfo(plugin) : undefined;

  return createStructuredResult({
    summary: `${installResult.operation === 'updated' ? 'Updated' : 'Installed'} plugin ${installResult.pluginId} from ${installResult.sourceType}.`,
    data: {
      pluginId: installResult.pluginId,
      operation: installResult.operation,
      sourceType: installResult.sourceType,
      ...(installResult.warnings?.length ? { warnings: installResult.warnings } : {}),
      ...(normalizedPlugin ? { plugin: normalizedPlugin } : {}),
    },
    nextActionHints: [
      'Use plugin_get_runtime_status to verify the plugin reaches a healthy runtime phase.',
      'Use system_bootstrap when you want a refreshed framework-level resource summary after the install.',
    ],
    recommendedNextTools: ['plugin_get_runtime_status', 'system_bootstrap'],
    authoritativeFields: [
      'structuredContent.data.pluginId',
      'structuredContent.data.operation',
      'structuredContent.data.sourceType',
    ],
  });
};

const pluginReloadHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensurePluginGateway(deps);
  const pluginId = readStringArg(args, 'pluginId', { required: true }) || '';
  const plugin = await gateway.getPlugin(pluginId);
  if (!plugin) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Plugin not found: ${pluginId}`, {
      context: { pluginId },
    });
  }

  await gateway.reloadPlugin(pluginId);
  const reloadedPlugin = normalizePluginInfo((await gateway.getPlugin(pluginId)) || plugin);

  return createStructuredResult({
    summary: `Reloaded plugin ${reloadedPlugin.id}.`,
    data: {
      pluginId: reloadedPlugin.id,
      plugin: reloadedPlugin,
      reloaded: true,
    },
    nextActionHints: [
      'Use plugin_get_runtime_status to confirm the plugin returned to a healthy lifecycle phase.',
      'Use observation_get_trace_summary if the reload failed and you already have the traceId.',
    ],
    recommendedNextTools: ['plugin_get_runtime_status', 'observation_get_trace_summary'],
    authoritativeFields: [
      'structuredContent.data.pluginId',
      'structuredContent.data.plugin.enabled',
      'structuredContent.data.reloaded',
    ],
  });
};

const pluginUninstallHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensurePluginGateway(deps);
  const pluginId = readStringArg(args, 'pluginId', { required: true }) || '';
  const deleteTables = readOptionalBooleanArg(args, 'deleteTables') ?? false;
  const plugin = await gateway.getPlugin(pluginId);
  if (!plugin) {
    throw createStructuredError(ErrorCode.NOT_FOUND, `Plugin not found: ${pluginId}`, {
      context: { pluginId },
    });
  }

  const normalizedPlugin = normalizePluginInfo(plugin);
  await gateway.uninstallPlugin(pluginId, { deleteTables });

  return createStructuredResult({
    summary: `Uninstalled plugin ${normalizedPlugin.id}.`,
    data: {
      pluginId: normalizedPlugin.id,
      pluginName: normalizedPlugin.name,
      deleteTables,
      uninstalled: true,
    },
    nextActionHints: [
      'Use plugin_list to verify the plugin no longer appears in the installed set.',
      'Use system_bootstrap when you want a fresh framework-level resource summary after uninstalling a plugin.',
    ],
    recommendedNextTools: ['plugin_list', 'system_bootstrap'],
    authoritativeFields: [
      'structuredContent.data.pluginId',
      'structuredContent.data.deleteTables',
      'structuredContent.data.uninstalled',
    ],
  });
};

const PLUGIN_CAPABILITIES: Array<{
  key: string;
  metadata: CapabilityMetadata;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version'>;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'plugin_list',
    metadata: PLUGIN_READ_METADATA,
    definition: {
      name: 'plugin_list',
      description: 'List installed plugins plus a compact runtime summary for each plugin.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1 },
          enabled: { type: 'boolean' },
          sourceType: { type: 'string', enum: ['local_private', 'cloud_managed'] },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
      outputSchema: PLUGIN_LIST_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use before plugin-specific work so the model can see which plugins are installed, enabled, and roughly healthy.',
        preferredTargetKind: 'plugin',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['plugin_get_runtime_status', 'cross_plugin_list_apis'],
        examples: [{ title: 'List installed plugins', arguments: {} }],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: pluginListHandler,
  },
  {
    key: 'plugin_get_runtime_status',
    metadata: PLUGIN_READ_METADATA,
    definition: {
      name: 'plugin_get_runtime_status',
      description: 'Get one plugin runtime snapshot by pluginId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pluginId'],
        properties: {
          pluginId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: PLUGIN_RUNTIME_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'data',
        whenToUse:
          'Use when one plugin needs focused runtime inspection before reload, uninstall, or debugging follow-up work.',
        preferredTargetKind: 'plugin',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['plugin_list', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Inspect one plugin runtime status',
            arguments: { pluginId: 'example_plugin' },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: pluginGetRuntimeStatusHandler,
  },
  {
    key: 'plugin_install',
    metadata: PLUGIN_INSTALL_METADATA,
    definition: {
      name: 'plugin_install',
      description:
        'Install or update one plugin from an absolute local path or a cloud plugin code. This is high-risk and requires explicit confirmation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceType', 'confirmRisk'],
        properties: {
          sourceType: { type: 'string', enum: ['local_path', 'cloud_code'] },
          sourcePath: { type: 'string', minLength: 1 },
          devMode: { type: 'boolean' },
          cloudPluginCode: { type: 'string', minLength: 1 },
          confirmRisk: { type: 'boolean' },
        },
      },
      outputSchema: PLUGIN_INSTALL_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'setup',
        whenToUse:
          'Use only when the model intentionally needs to install or update a plugin and has already verified the absolute local path or cloud plugin code.',
        preferredTargetKind: 'plugin',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['plugin_get_runtime_status', 'system_bootstrap'],
        examples: [
          {
            title: 'Install a local development plugin directory',
            arguments: {
              sourceType: 'local_path',
              sourcePath: 'D:\\plugins\\example-plugin',
              devMode: true,
              confirmRisk: true,
            },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: pluginInstallHandler,
  },
  {
    key: 'plugin_reload',
    metadata: PLUGIN_WRITE_METADATA,
    definition: {
      name: 'plugin_reload',
      description: 'Reload one installed plugin by pluginId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pluginId'],
        properties: {
          pluginId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: PLUGIN_RELOAD_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'teardown',
        whenToUse:
          'Use after a plugin code/config change or runtime anomaly when a low-risk restart of that plugin is appropriate.',
        preferredTargetKind: 'plugin',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['plugin_get_runtime_status', 'observation_get_trace_summary'],
        examples: [
          {
            title: 'Reload one plugin',
            arguments: { pluginId: 'example_plugin' },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: pluginReloadHandler,
  },
  {
    key: 'plugin_uninstall',
    metadata: PLUGIN_WRITE_METADATA,
    definition: {
      name: 'plugin_uninstall',
      description: 'Uninstall one plugin by pluginId with an optional deleteTables flag.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pluginId'],
        properties: {
          pluginId: { type: 'string', minLength: 1 },
          deleteTables: { type: 'boolean' },
        },
      },
      outputSchema: PLUGIN_UNINSTALL_OUTPUT_SCHEMA,
      assistantGuidance: {
        workflowStage: 'teardown',
        whenToUse:
          'Use for low-risk plugin cleanup when the model explicitly intends to remove one installed plugin.',
        preferredTargetKind: 'plugin',
        requiresBoundProfile: false,
        transportEffect: 'none',
        recommendedToolProfile: 'compact',
        preferredNextTools: ['plugin_list', 'system_bootstrap'],
        examples: [
          {
            title: 'Uninstall one plugin but keep orphaned tables',
            arguments: { pluginId: 'example_plugin', deleteTables: false },
          },
        ],
      },
      assistantSurface: {
        publicMcp: true,
        surfaceTier: 'advanced',
      },
    },
    handler: pluginUninstallHandler,
  },
];

export function createPluginCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    PLUGIN_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          annotations: buildCapabilityAnnotations(capability.metadata, {
            destructiveHint: capability.key === 'plugin_uninstall',
          }),
          version: PLUGIN_CAPABILITY_VERSION,
          ...capability.metadata,
        },
        handler: capability.handler,
      },
    ])
  );
}
