import type {
  CapabilityCatalog,
  CapabilityProvider,
  CapabilityProviderError,
  RegisteredCapability,
} from '../ai-dev/capabilities';
import type {
  OrchestrationCapabilityDefinition,
} from '../ai-dev/orchestration/types';
import { createStructuredEnvelopeSchema } from '../ai-dev/capabilities/catalog-utils';
import { createStructuredError, ErrorCode } from '../../types/error-codes';
import type { CapabilityCallResult } from '../ai-dev/capabilities/types';
import { createStructuredResult } from '../ai-dev/capabilities/result-utils';
import type {
  PluginCapabilityContribution,
  JSPluginManifest,
} from '../../types/js-plugin';
import type { PluginRegistry, PluginRegistration } from './registry';

type PluginCapabilityHandlerBinding = PluginCapabilityContribution['handler'];

const DEFAULT_PLUGIN_CAPABILITY_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

const normalizeCapabilityNamePart = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');

const toPluginCapabilityKey = (
  pluginId: string,
  capabilityName: string
): string => `plugin:${pluginId}:${capabilityName}`;

const toPluginCapabilityName = (pluginId: string, capabilityName: string): string => {
  const normalizedName = normalizeCapabilityNamePart(capabilityName);
  if (!normalizedName) {
    return '';
  }
  return normalizedName.includes('.')
    ? normalizedName
    : `plugin.${normalizeCapabilityNamePart(pluginId)}.${normalizedName}`;
};

const createEnvelope = (data: unknown): CapabilityCallResult =>
  createStructuredResult(
    {
      summary: 'Plugin capability completed successfully.',
      data: data as Record<string, unknown>,
      authoritativeFields: ['structuredContent.data'],
    },
    {
      includeJsonInText: true,
    }
  );

const createPluginCapabilityDefinition = (
  manifest: JSPluginManifest,
  contribution: PluginCapabilityContribution
): OrchestrationCapabilityDefinition => {
  const capabilityName = toPluginCapabilityName(manifest.id, contribution.name);
  return {
    name: capabilityName,
    title: contribution.title,
    version: contribution.version,
    description: contribution.description,
    inputSchema:
      contribution.inputSchema || {
        type: 'object',
        additionalProperties: true,
      },
    outputSchema: createStructuredEnvelopeSchema(
      contribution.outputSchema || DEFAULT_PLUGIN_CAPABILITY_DATA_SCHEMA
    ),
    requires: contribution.requires || [],
    annotations: contribution.annotations,
    sideEffectLevel: contribution.sideEffectLevel || 'none',
    estimatedLatencyMs: contribution.estimatedLatencyMs,
    idempotent: contribution.idempotent ?? false,
    retryPolicy: contribution.retryPolicy || { retryable: false, maxAttempts: 1 },
    requiredScopes: contribution.requiredScopes,
    assistantSurface: {
      ...(contribution.assistantSurface || {}),
      publicMcp: false,
    },
    confirmationPolicy: contribution.confirmationPolicy,
  };
};

const createMissingHandlerError = (
  pluginId: string,
  capabilityName: string,
  binding: PluginCapabilityHandlerBinding
) =>
  createStructuredError(
    ErrorCode.VALIDATION_ERROR,
    `Plugin capability ${capabilityName} has no activated ${binding.kind} handler: ${binding.name}`,
    {
      reasonCode: 'plugin_capability_handler_missing',
      context: {
        pluginId,
        capabilityName,
        handlerKind: binding.kind,
        handlerName: binding.name,
      },
    }
  );

const createCapabilityFromContribution = (
  registration: PluginRegistration,
  contribution: PluginCapabilityContribution
): RegisteredCapability => {
  const definition = createPluginCapabilityDefinition(registration.manifest, contribution);
  const binding = contribution.handler;

  if (binding.kind === 'api') {
    const api = registration.apis.get(binding.name);
    if (!api) {
      throw createMissingHandlerError(registration.id, definition.name, binding);
    }
    return {
      definition,
      handler: async (args: Record<string, unknown>) =>
        createEnvelope(await api.handler(args)),
    };
  }

  const command = registration.commands.get(binding.name);
  if (!command) {
    throw createMissingHandlerError(registration.id, definition.name, binding);
  }
  return {
    definition,
    handler: async (args: Record<string, unknown>) => {
      if (!registration.helpers) {
        throw createStructuredError(
          ErrorCode.OPERATION_FAILED,
          `Plugin capability ${definition.name} cannot run before plugin helpers are available`,
          {
            reasonCode: 'plugin_capability_helpers_missing',
            context: {
              pluginId: registration.id,
              capability: definition.name,
              commandName: binding.name,
            },
          }
        );
      }
      return createEnvelope(await command.handler(args, registration.helpers));
    },
  };
};

function toProviderError(
  providerId: string,
  registration: PluginRegistration,
  contribution: PluginCapabilityContribution,
  error: unknown
): CapabilityProviderError {
  const record =
    error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message =
    typeof record.message === 'string' && record.message.trim()
      ? record.message
      : String(error);
  const reasonCode =
    typeof record.reasonCode === 'string' && record.reasonCode.trim()
      ? record.reasonCode
      : undefined;
  return {
    providerId,
    pluginId: registration.id,
    capabilityName: contribution.name,
    message,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

export function createPluginCapabilityProvider(
  pluginRegistry: PluginRegistry
): CapabilityProvider {
  const providerId = 'trusted-plugin';
  let errors: CapabilityProviderError[] = [];
  return {
    id: providerId,
    listCapabilities(): CapabilityCatalog {
      const catalog: CapabilityCatalog = {};
      const nextErrors: CapabilityProviderError[] = [];
      for (const registration of pluginRegistry.listRegistrations()) {
        if (registration.manifest.trustModel !== 'first_party') {
          continue;
        }
        const contributions = registration.manifest.capabilities || [];
        for (const contribution of contributions) {
          try {
            const capability = createCapabilityFromContribution(registration, contribution);
            catalog[
              toPluginCapabilityKey(registration.id, capability.definition.name)
            ] = capability;
          } catch (error) {
            nextErrors.push(toProviderError(providerId, registration, contribution, error));
          }
        }
      }
      errors = nextErrors;
      return catalog;
    },
    listErrors(): readonly CapabilityProviderError[] {
      return [...errors];
    },
    subscribe(listener: () => void): () => void {
      const events: Array<Parameters<PluginRegistry['on']>[0]> = [
        'plugin:registered',
        'plugin:unregistered',
        'api:registered',
        'command:registered',
      ];
      for (const event of events) {
        pluginRegistry.on(event, listener);
      }
      return () => {
        for (const event of events) {
          pluginRegistry.off(event, listener);
        }
      };
    },
  };
}
