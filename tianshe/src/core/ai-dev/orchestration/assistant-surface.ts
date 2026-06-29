import type { OrchestrationCapabilityDefinition } from './types';
import { listOrchestrationCapabilities } from './capability-registry';
import {
  isCapabilityPublicMcp,
  listCanonicalAssistantFlowCapabilities as listCanonicalAssistantFlowCapabilitiesBase,
  listCanonicalAssistantFlowCapabilityNames as listCanonicalAssistantFlowCapabilityNamesBase,
  listCanonicalPublicCapabilities as listCanonicalPublicCapabilitiesBase,
  listCanonicalPublicCapabilityNames as listCanonicalPublicCapabilityNamesBase,
  resolveCapabilitySurfaceTier,
  selectAssistantFlowCapabilities,
  type AssistantSurfaceFlow,
} from '../capabilities/assistant-surface-manifest';

export type { AssistantSurfaceFlow } from '../capabilities/assistant-surface-manifest';
export {
  isCapabilityPublicMcp,
  resolveCapabilitySurfaceTier,
  selectAssistantFlowCapabilities,
} from '../capabilities/assistant-surface-manifest';

export const listCanonicalPublicCapabilities = (
  capabilities: OrchestrationCapabilityDefinition[] = listOrchestrationCapabilities()
): OrchestrationCapabilityDefinition[] => listCanonicalPublicCapabilitiesBase(capabilities);

export const listCanonicalPublicCapabilityNames = (
  capabilities: OrchestrationCapabilityDefinition[] = listOrchestrationCapabilities()
): string[] => listCanonicalPublicCapabilityNamesBase(capabilities);

export const listCanonicalAssistantFlowCapabilities = (
  flow: AssistantSurfaceFlow,
  capabilities: OrchestrationCapabilityDefinition[] = listOrchestrationCapabilities()
): OrchestrationCapabilityDefinition[] => listCanonicalAssistantFlowCapabilitiesBase(flow, capabilities);

export const listCanonicalAssistantFlowCapabilityNames = (
  flow: AssistantSurfaceFlow,
  capabilities: OrchestrationCapabilityDefinition[] = listOrchestrationCapabilities()
): string[] => listCanonicalAssistantFlowCapabilityNamesBase(flow, capabilities);
