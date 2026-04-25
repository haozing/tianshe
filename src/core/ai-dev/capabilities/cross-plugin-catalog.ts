import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type { OrchestrationCapabilityDefinition, OrchestrationDependencies } from '../orchestration/types';
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

const CROSS_PLUGIN_CAPABILITY_VERSION = '1.0.0';

const CROSS_PLUGIN_READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 400,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['plugin.read'],
  requires: ['crossPluginGateway'],
};

const CROSS_PLUGIN_EXECUTE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'high',
  estimatedLatencyMs: 1500,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['plugin.execute'],
  requires: ['crossPluginGateway'],
};

const CROSS_PLUGIN_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  cross_plugin_list_apis: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'apis'],
    properties: {
      total: { type: 'number' },
      apis: createArrayItemsSchema(),
    },
  }),
  cross_plugin_call_api: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['pluginId', 'apiName', 'result'],
    properties: {
      pluginId: { type: 'string' },
      apiName: { type: 'string' },
      result: {
        type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
      },
    },
  }),
};

const readStringArg = (
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = { required: true }
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

const readArrayArg = (args: Record<string, unknown>, key: string): unknown[] => {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Parameter ${key} must be array`);
  }
  return raw;
};

const ensureCrossPluginGateway = (deps: OrchestrationDependencies) => {
  if (!deps.crossPluginGateway) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Cross-plugin gateway is not configured',
      {
        suggestion: '请在 orchestration 依赖中注入 crossPluginGateway',
      }
    );
  }
  return deps.crossPluginGateway;
};

const crossPluginListApisHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps
) => {
  const gateway = ensureCrossPluginGateway(deps);
  const pluginIdFilter = readStringArg(args, 'pluginId', { required: false });
  const apis = gateway
    .listCallableApis()
    .filter((item) => !pluginIdFilter || item.pluginId === pluginIdFilter);

  return createStructuredResult(
    {
      summary: `Found ${apis.length} callable cross-plugin API(s).`,
      data: {
        total: apis.length,
        apis,
      },
      nextActionHints: [
        'Use cross_plugin_call_api with pluginId/apiName to execute one API.',
        'Filter by pluginId when you want a smaller result set.',
      ],
    },
    { includeJsonInText: true }
  );
};

const crossPluginCallApiHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) => {
  const gateway = ensureCrossPluginGateway(deps);
  const pluginId = readStringArg(args, 'pluginId');
  const apiName = readStringArg(args, 'apiName');
  const params = readArrayArg(args, 'params');

  const result = await gateway.callApi(pluginId || '', apiName || '', params);
  if (!result.success) {
    const errorCode = result.error?.code || ErrorCode.OPERATION_FAILED;
    throw createStructuredError(errorCode, result.error?.message || 'Cross-plugin API call failed', {
      ...(result.error?.details ? { details: result.error.details } : {}),
      context: {
        pluginId,
        apiName,
      },
    });
  }

  return createStructuredResult(
    {
      summary: `Cross-plugin API ${apiName} executed successfully on ${pluginId}.`,
      data: {
        pluginId,
        apiName,
        result: result.data ?? null,
      },
      nextActionHints: ['Inspect plugin-specific result fields before issuing a follow-up call.'],
    },
    { includeJsonInText: true }
  );
};

const CROSS_PLUGIN_CAPABILITIES: Array<{
  key: string;
  metadata: CapabilityMetadata;
  definition: Omit<OrchestrationCapabilityDefinition, keyof CapabilityMetadata | 'version'>;
  handler: CapabilityHandler<OrchestrationDependencies>;
}> = [
  {
    key: 'cross_plugin_list_apis',
    metadata: CROSS_PLUGIN_READ_METADATA,
    definition: {
      name: 'cross_plugin_list_apis',
      description: 'List MCP-callable plugin APIs exposed by installed plugins.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pluginId: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: CROSS_PLUGIN_OUTPUT_SCHEMAS.cross_plugin_list_apis,
    },
    handler: crossPluginListApisHandler,
  },
  {
    key: 'cross_plugin_call_api',
    metadata: CROSS_PLUGIN_EXECUTE_METADATA,
    definition: {
      name: 'cross_plugin_call_api',
      description: 'Call an exposed plugin API as orchestration/mcp caller.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pluginId', 'apiName'],
        properties: {
          pluginId: { type: 'string', minLength: 1 },
          apiName: { type: 'string', minLength: 1 },
          params: {
            type: 'array',
            items: {},
          },
        },
      },
      outputSchema: CROSS_PLUGIN_OUTPUT_SCHEMAS.cross_plugin_call_api,
    },
    handler: crossPluginCallApiHandler,
  },
];

export function createCrossPluginCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    CROSS_PLUGIN_CAPABILITIES.map((capability) => [
      capability.key,
      {
        definition: {
          ...capability.definition,
          title: toCapabilityTitle(capability.definition.name),
          annotations: buildCapabilityAnnotations(capability.metadata, {
            destructiveHint: capability.key === 'cross_plugin_call_api',
          }),
          version: CROSS_PLUGIN_CAPABILITY_VERSION,
          ...capability.metadata,
        },
        handler: capability.handler,
      },
    ])
  );
}
