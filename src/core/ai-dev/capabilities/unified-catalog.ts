import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import { createBrowserCapabilityCatalog, type RegisteredCapability } from './browser-catalog';
import { createDatasetCapabilityCatalog } from './dataset-catalog';
import { createCrossPluginCapabilityCatalog } from './cross-plugin-catalog';
import { createPluginCapabilityCatalog } from './plugin-catalog';
import { createProfileCapabilityCatalog } from './profile-catalog';
import { createObservationCapabilityCatalog } from './observation-catalog';
import { createSystemCapabilityCatalog } from './system-catalog';
import { createSessionCapabilityCatalog } from './session-catalog';
import { withAssistantGuidance } from './assistant-guidance';

export type CapabilityCatalog = Record<string, RegisteredCapability>;

export type CapabilityCatalogFactory = () => CapabilityCatalog;

const CAPABILITY_CATALOG_FACTORIES: readonly CapabilityCatalogFactory[] = [
  createBrowserCapabilityCatalog,
  createDatasetCapabilityCatalog,
  createCrossPluginCapabilityCatalog,
  createPluginCapabilityCatalog,
  createProfileCapabilityCatalog,
  createObservationCapabilityCatalog,
  createSystemCapabilityCatalog,
  createSessionCapabilityCatalog,
];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function validateCapabilityMetadata(key: string, capability: RegisteredCapability): void {
  const definition = capability.definition;
  const fail = (reason: string, context?: Record<string, unknown>): never => {
    throw createStructuredError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid capability metadata for ${key}: ${reason}`,
      {
        ...(context ? { context } : {}),
      }
    );
  };

  if (!SEMVER_PATTERN.test(definition.version)) {
    fail('version must be semver', { version: definition.version });
  }

  if (!definition.outputSchema || typeof definition.outputSchema !== 'object') {
    fail('outputSchema must be defined');
  }

  if (typeof definition.idempotent !== 'boolean') {
    fail('idempotent must be boolean');
  }

  const retryPolicy = definition.retryPolicy;
  if (!retryPolicy || typeof retryPolicy.retryable !== 'boolean') {
    fail('retryPolicy.retryable must be boolean');
  }
  if (!retryPolicy || !Number.isFinite(retryPolicy.maxAttempts) || retryPolicy.maxAttempts < 1) {
    fail('retryPolicy.maxAttempts must be >= 1');
  }

  if (
    !Array.isArray(definition.requiredScopes) ||
    definition.requiredScopes.length === 0 ||
    definition.requiredScopes.some((scope) => typeof scope !== 'string' || scope.trim().length === 0)
  ) {
    fail('requiredScopes must contain at least one non-empty scope');
  }

  if (
    definition.requires !== undefined &&
    (!Array.isArray(definition.requires) ||
      definition.requires.some((item) => typeof item !== 'string' || item.trim().length === 0))
  ) {
    fail('requires must contain non-empty strings when provided');
  }

  const guidance = definition.assistantGuidance;
  if (guidance) {
    if (typeof guidance.whenToUse !== 'string' || guidance.whenToUse.trim().length === 0) {
      fail('assistantGuidance.whenToUse must be a non-empty string');
    }
    if (
      guidance.preferredTargetKind !== undefined &&
      (typeof guidance.preferredTargetKind !== 'string' ||
        guidance.preferredTargetKind.trim().length === 0)
    ) {
      fail('assistantGuidance.preferredTargetKind must be a non-empty string when provided');
    }
    if (
      guidance.requiresBoundProfile !== undefined &&
      typeof guidance.requiresBoundProfile !== 'boolean'
    ) {
      fail('assistantGuidance.requiresBoundProfile must be boolean when provided');
    }
    if (
      guidance.transportEffect !== undefined &&
      (typeof guidance.transportEffect !== 'string' || guidance.transportEffect.trim().length === 0)
    ) {
      fail('assistantGuidance.transportEffect must be a non-empty string when provided');
    }
    if (
      guidance.recommendedToolProfile !== undefined &&
      guidance.recommendedToolProfile !== 'full' &&
      guidance.recommendedToolProfile !== 'compact'
    ) {
      fail('assistantGuidance.recommendedToolProfile must be "full" or "compact" when provided');
    }
    if (
      guidance.preferredNextTools !== undefined &&
      (!Array.isArray(guidance.preferredNextTools) ||
        guidance.preferredNextTools.some((item) => typeof item !== 'string' || item.trim().length === 0))
    ) {
      fail('assistantGuidance.preferredNextTools must contain non-empty strings when provided');
    }
    if (
      guidance.examples !== undefined &&
      (!Array.isArray(guidance.examples) ||
        guidance.examples.some(
          (example) =>
            !example ||
            typeof example !== 'object' ||
            typeof example.title !== 'string' ||
            example.title.trim().length === 0 ||
            !('arguments' in example) ||
            typeof example.arguments !== 'object' ||
            example.arguments === null ||
            Array.isArray(example.arguments)
        ))
    ) {
      fail('assistantGuidance.examples must contain { title, arguments } objects when provided');
    }
  }

  const assistantSurface = definition.assistantSurface;
  if (assistantSurface) {
    if (
      assistantSurface.publicMcp !== undefined &&
      typeof assistantSurface.publicMcp !== 'boolean'
    ) {
      fail('assistantSurface.publicMcp must be boolean when provided');
    }

    if (
      assistantSurface.surfaceTier !== undefined &&
      assistantSurface.surfaceTier !== 'canonical' &&
      assistantSurface.surfaceTier !== 'advanced' &&
      assistantSurface.surfaceTier !== 'legacy'
    ) {
      fail('assistantSurface.surfaceTier must be "canonical", "advanced", or "legacy" when provided');
    }

    for (const key of ['gettingStartedOrder', 'sessionReuseOrder', 'pageDebugOrder'] as const) {
      const value = assistantSurface[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
        fail(`assistantSurface.${key} must be a positive number when provided`);
      }
    }
  }
}

export function mergeCapabilityCatalogs(catalogs: CapabilityCatalog[]): CapabilityCatalog {
  const merged: CapabilityCatalog = {};
  const nameToSourceKey = new Map<string, string>();

  for (const catalog of catalogs) {
    for (const [key, capability] of Object.entries(catalog)) {
      const normalizedCapability: RegisteredCapability = {
        ...capability,
        definition: withAssistantGuidance(capability.definition),
      };
      validateCapabilityMetadata(key, normalizedCapability);

      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        throw createStructuredError(
          ErrorCode.VALIDATION_ERROR,
          `Duplicate capability key detected: ${key}`,
          {
            context: { capabilityKey: key },
          }
        );
      }

      const capabilityName = normalizedCapability.definition.name;
      const existingNameKey = nameToSourceKey.get(capabilityName);
      if (existingNameKey) {
        throw createStructuredError(
          ErrorCode.VALIDATION_ERROR,
          `Duplicate capability name detected: ${capabilityName}`,
          {
            context: {
              capabilityName,
              firstKey: existingNameKey,
              secondKey: key,
            },
          }
        );
      }

      merged[key] = normalizedCapability;
      nameToSourceKey.set(capabilityName, key);
    }
  }

  return merged;
}

export function createUnifiedCapabilityCatalog(
  factories: readonly CapabilityCatalogFactory[] = CAPABILITY_CATALOG_FACTORIES
): CapabilityCatalog {
  return mergeCapabilityCatalogs(factories.map((factory) => factory()));
}
