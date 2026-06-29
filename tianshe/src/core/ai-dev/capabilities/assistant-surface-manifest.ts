import type {
  OrchestrationAssistantSurface,
  OrchestrationAssistantSurfaceTier,
  OrchestrationCapabilityDefinition,
} from '../orchestration/types';

export type AssistantSurfaceFlow = 'getting_started' | 'session_reuse' | 'page_debug';

const FLOW_TO_FIELD: Record<
  AssistantSurfaceFlow,
  keyof Pick<
    OrchestrationAssistantSurface,
    'gettingStartedOrder' | 'sessionReuseOrder' | 'pageDebugOrder'
  >
> = {
  getting_started: 'gettingStartedOrder',
  session_reuse: 'sessionReuseOrder',
  page_debug: 'pageDebugOrder',
};

export const isCapabilityPublicMcp = (
  capability: OrchestrationCapabilityDefinition
): boolean => capability.assistantSurface?.publicMcp === true;

export const resolveCapabilitySurfaceTier = (
  capability: OrchestrationCapabilityDefinition
): OrchestrationAssistantSurfaceTier => {
  const explicitTier = capability.assistantSurface?.surfaceTier;
  if (explicitTier) {
    return explicitTier;
  }

  const hasFlowOrder =
    Number.isFinite(capability.assistantSurface?.gettingStartedOrder) ||
    Number.isFinite(capability.assistantSurface?.sessionReuseOrder) ||
    Number.isFinite(capability.assistantSurface?.pageDebugOrder);

  if (capability.assistantSurface?.publicMcp === true || hasFlowOrder) {
    return 'canonical';
  }

  return 'advanced';
};

export const listCanonicalPublicCapabilities = (
  capabilities: OrchestrationCapabilityDefinition[]
): OrchestrationCapabilityDefinition[] =>
  capabilities.filter((capability) => isCapabilityPublicMcp(capability));

export const listCanonicalPublicCapabilityNames = (
  capabilities: OrchestrationCapabilityDefinition[]
): string[] => listCanonicalPublicCapabilities(capabilities).map((capability) => capability.name);

const compareAssistantSurfaceOrder =
  (
    field: keyof Pick<
      OrchestrationAssistantSurface,
      'gettingStartedOrder' | 'sessionReuseOrder' | 'pageDebugOrder'
    >
  ) =>
  (
    left: OrchestrationCapabilityDefinition,
    right: OrchestrationCapabilityDefinition
  ): number => {
    const leftOrder = left.assistantSurface?.[field] ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.assistantSurface?.[field] ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.name.localeCompare(right.name);
  };

export const selectAssistantFlowCapabilities = (
  capabilities: OrchestrationCapabilityDefinition[],
  flow: AssistantSurfaceFlow
): OrchestrationCapabilityDefinition[] => {
  const field = FLOW_TO_FIELD[flow];
  return capabilities
    .filter(
      (capability) =>
        isCapabilityPublicMcp(capability) && Number.isFinite(capability.assistantSurface?.[field])
    )
    .sort(compareAssistantSurfaceOrder(field));
};

export const listCanonicalAssistantFlowCapabilities = (
  flow: AssistantSurfaceFlow,
  capabilities: OrchestrationCapabilityDefinition[]
): OrchestrationCapabilityDefinition[] =>
  selectAssistantFlowCapabilities(listCanonicalPublicCapabilities(capabilities), flow);

export const listCanonicalAssistantFlowCapabilityNames = (
  flow: AssistantSurfaceFlow,
  capabilities: OrchestrationCapabilityDefinition[]
): string[] =>
  listCanonicalAssistantFlowCapabilities(flow, capabilities).map((capability) => capability.name);
