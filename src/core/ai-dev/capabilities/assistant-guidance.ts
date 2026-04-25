import type {
  OrchestrationAssistantGuidance,
  OrchestrationAssistantSurface,
  OrchestrationCapabilityDefinition,
  OrchestrationCapabilityDeprecation,
} from '../orchestration/types';

export interface CapabilityModelHintFailureCode {
  code: string;
  when: string;
  remediation: string;
}

export interface CapabilityModelHintCommonMistake {
  mistake: string;
  correction: string;
}

export interface CapabilityModelHintsManifest {
  authoritativeResultFields?: string[];
  authoritativeSignals?: string[];
  targetPriority?: string[];
  failureCodes?: CapabilityModelHintFailureCode[];
  commonMistakes?: CapabilityModelHintCommonMistake[];
}

export interface CapabilityAssistantManifest {
  guidance?: OrchestrationAssistantGuidance;
  surface?: OrchestrationAssistantSurface;
  deprecation?: OrchestrationCapabilityDeprecation;
  resultContract?: string[];
  failureContract?: string[];
  modelHints?: CapabilityModelHintsManifest;
}

export const SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS = [
  'structuredContent.data.effectiveProfile',
  'structuredContent.data.effectiveEngine',
  'structuredContent.data.effectiveEngineSource',
] as const;

export const SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_HINT: CapabilityModelHintFailureCode = {
  code: 'profile_engine_mismatch',
  when: 'The requested or sticky engine conflicts with the resolved profile engine before browser acquisition.',
  remediation:
    'Switch to a compatible profile or engine pairing, then retry session_prepare before any browser_* call.',
};

export const SESSION_PREPARE_RESOLVED_BINDING_PRECONDITION =
  'Successful calls return structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource as the resolved session binding.';

export const SESSION_PREPARE_RESOLVED_BINDING_ACTION =
  'Read structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource before deciding whether to call browser_* or retry.';

export const SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_ACTION =
  'If session_prepare fails with reasonCode=profile_engine_mismatch, switch to a compatible profile or engine before retrying.';

const BROWSER_SNAPSHOT_AUTHORITATIVE_SIGNALS = [
  'structuredContent.data.snapshot.elements[*].elementRef',
  'structuredContent.data.interactionReady',
  'structuredContent.data.viewportHealth',
  'structuredContent.data.offscreenDetected',
] as const;

const BROWSER_ACT_AUTHORITATIVE_SIGNALS = [
  'structuredContent.data.verified',
  'structuredContent.data.primaryEffect',
  'structuredContent.data.waitTarget',
  'structuredContent.data.afterUrl',
] as const;

const BROWSER_ACT_TARGET_PRIORITY = ['target.ref', 'target.selector', 'target.text'] as const;

const SESSION_PREPARE_RESULT_CONTRACT = [
  'Result contract: use structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource as the authoritative resolved session binding.',
] as const;

const SESSION_PREPARE_FAILURE_CONTRACT = [
  'Failure contract: incompatible profile/engine pairings fail before browser acquisition with reasonCode=profile_engine_mismatch.',
] as const;

const BROWSER_OBSERVE_RESULT_CONTRACT = [
  'Result contract: prefer structuredContent.data.snapshot.elements[*].elementRef for follow-up actions.',
  'Read structuredContent.data.interactionReady, viewportHealth, and offscreenDetected before acting in hidden or degraded sessions.',
] as const;

const BROWSER_SNAPSHOT_RESULT_CONTRACT = [
  'Result contract: prefer structuredContent.data.snapshot.elements[*].elementRef for follow-up actions.',
  'Read structuredContent.data.interactionReady, viewportHealth, and offscreenDetected before acting in hidden or degraded sessions.',
] as const;

const BROWSER_ACT_RESULT_CONTRACT = [
  'Target priority: prefer target.ref, then target.selector, and fall back to target.text only when direct DOM targeting is not available.',
  'When the expected result is explicit, prefer verify.kind="all" so verification is deterministic.',
  'Result contract: treat structuredContent.data.verified, primaryEffect, waitTarget, and afterUrl as the authoritative action outcome.',
  'Failure contract: when browser_act is unverified, read structuredContent.error.context.target/resolvedTarget/primaryEffect/afterUrl first, then use browser_debug_state for deeper diagnostics.',
] as const;

const SESSION_END_CURRENT_RESULT_CONTRACT = [
  'Result contract: session_end_current invalidates the active transport after the response is flushed; no further requests should be sent on the same transport.',
] as const;

const canonicalSurface = (
  orders: {
    gettingStartedOrder?: number;
    sessionReuseOrder?: number;
    pageDebugOrder?: number;
  } = {}
): OrchestrationAssistantSurface => ({
  publicMcp: true,
  surfaceTier: 'canonical',
  ...orders,
});

const advancedSurface = (
  orders: {
    gettingStartedOrder?: number;
    sessionReuseOrder?: number;
    pageDebugOrder?: number;
  } = {}
): OrchestrationAssistantSurface => ({
  publicMcp: false,
  surfaceTier: 'advanced',
  ...orders,
});

const legacySurface = (): OrchestrationAssistantSurface => ({
  publicMcp: false,
  surfaceTier: 'legacy',
});

const CAPABILITY_MANIFESTS: Record<string, CapabilityAssistantManifest> = {};

Object.assign(CAPABILITY_MANIFESTS, {
  profile_list: {
    guidance: {
      workflowStage: 'session',
      whenToUse: 'List reusable browser profiles before selecting one for the current task.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['profile_resolve', 'session_prepare', 'session_get_current'],
      examples: [{ title: 'Filter by profile name', arguments: { query: 'marketing' } }],
    },
    surface: canonicalSurface({ gettingStartedOrder: 10, sessionReuseOrder: 10 }),
  },
  profile_resolve: {
    guidance: {
      workflowStage: 'session',
      whenToUse:
        'Resolve a profile query (id or exact name) to a canonical reusable profileId for session reuse.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['session_prepare', 'session_get_current'],
      examples: [{ title: 'Resolve one profile', arguments: { query: 'profile-1' } }],
    },
    surface: canonicalSurface({ gettingStartedOrder: 20, sessionReuseOrder: 20 }),
  },
  profile_get: {
    guidance: {
      workflowStage: 'session',
      whenToUse: 'Inspect one known profile when debugging profile metadata or compatibility issues.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'full',
      preferredNextTools: ['profile_resolve', 'session_prepare'],
    },
    surface: advancedSurface(),
  },
  profile_start_session: {
    guidance: {
      workflowStage: 'session',
      whenToUse: 'Prepare explicit MCP headers and orchestration session parameters for external clients.',
      avoidWhen:
        'Avoid this when you are already inside the current MCP session and can call session_prepare directly.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'transport_headers',
      recommendedToolProfile: 'full',
      preferredNextTools: ['session_prepare', 'session_get_current'],
      examples: [{ title: 'Prepare an external session plan', arguments: { query: 'profile-1', visible: false } }],
    },
    surface: advancedSurface(),
  },
  session_list: {
    guidance: {
      workflowStage: 'session',
      whenToUse: 'List active MCP sessions when debugging queueing, leaks, or profile reuse collisions.',
      preferredTargetKind: 'session',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'full',
      preferredNextTools: ['session_get_current', 'session_close', 'session_close_profile'],
    },
    surface: advancedSurface({ pageDebugOrder: 40 }),
  },
  session_get_current: {
    guidance: {
      workflowStage: 'session',
      whenToUse: 'Inspect the current MCP session before reuse, teardown, or debugging.',
      preferredTargetKind: 'session',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['session_prepare', 'browser_snapshot', 'session_end_current'],
      examples: [{ title: 'Inspect the active session', arguments: {} }],
    },
    surface: canonicalSurface({ sessionReuseOrder: 35, pageDebugOrder: 10 }),
  },
  session_prepare: {
    guidance: {
      workflowStage: 'session',
      whenToUse:
        'Prepare the current MCP session before the first browser_* call by resolving a reusable profile, choosing engine/visibility, and updating sticky scopes.',
      avoidWhen:
        'Avoid conflicting profile, engine, or visibility values after the session already acquired a browser; only identical replays and scope updates remain safe then.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'session_state',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_observe', 'session_get_current', 'browser_snapshot'],
      examples: [
        {
          title: 'Prepare a hidden session with sticky scopes',
          arguments: {
            query: 'profile-1',
            visible: false,
            scopes: ['browser.read', 'browser.write'],
          },
        },
      ],
    },
    surface: canonicalSurface({ gettingStartedOrder: 30, sessionReuseOrder: 30 }),
    resultContract: [...SESSION_PREPARE_RESULT_CONTRACT],
    failureContract: [...SESSION_PREPARE_FAILURE_CONTRACT],
    modelHints: {
      authoritativeResultFields: [...SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS],
      failureCodes: [SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_HINT],
      commonMistakes: [
        {
          mistake:
            'Infer the resolved profile or engine from old transport headers or sticky state.',
          correction:
            'Read structuredContent.data.effectiveProfile, effectiveEngine, and effectiveEngineSource from the latest session_prepare result.',
        },
      ],
    },
  },
  session_close: {
    guidance: {
      workflowStage: 'teardown',
      whenToUse: 'Close an MCP session by sessionId, including non-current sessions during cleanup or recovery.',
      avoidWhen:
        'Avoid mid-task unless you intentionally want to invalidate the current transport or close another session.',
      preferredTargetKind: 'session',
      requiresBoundProfile: false,
      transportEffect: 'session_terminate',
      recommendedToolProfile: 'full',
      preferredNextTools: [],
      examples: [{ title: 'Close the current session safely', arguments: { sessionId: 'currentSessionId', allowCurrent: true } }],
    },
    surface: advancedSurface(),
  },
  session_close_profile: {
    guidance: {
      workflowStage: 'teardown',
      whenToUse: 'Close all MCP sessions currently bound to one profile during cleanup or operator recovery.',
      preferredTargetKind: 'profile_query',
      requiresBoundProfile: false,
      transportEffect: 'session_terminate',
      recommendedToolProfile: 'full',
      preferredNextTools: [],
    },
    surface: advancedSurface(),
  },
  session_end_current: {
    guidance: {
      workflowStage: 'teardown',
      whenToUse:
        'Close the current MCP session as the final step. The current transport will be invalidated after the response is flushed.',
      avoidWhen:
        'Avoid before you are done, because the current transport becomes unusable after the response.',
      preferredTargetKind: 'session',
      requiresBoundProfile: false,
      transportEffect: 'session_terminate',
      recommendedToolProfile: 'compact',
      preferredNextTools: [],
      examples: [{ title: 'Close the current session', arguments: {} }],
    },
    surface: canonicalSurface({ gettingStartedOrder: 90, sessionReuseOrder: 90 }),
    resultContract: [...SESSION_END_CURRENT_RESULT_CONTRACT],
  },
});

Object.assign(CAPABILITY_MANIFESTS, {
  browser_evaluate: {
    guidance: {
      workflowStage: 'interaction',
      whenToUse: 'Run page JavaScript only when the task requires direct script execution that higher-level tools cannot express.',
      avoidWhen: 'Avoid for ordinary clicks, typing, waiting, or inspection; prefer stable structured browser tools first.',
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'interaction',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_snapshot', 'browser_wait_for'],
    },
    surface: advancedSurface(),
  },
  browser_search: {
    guidance: {
      workflowStage: 'inspection',
      whenToUse:
        'Search semantic elements by keyword when snapshot/observe gave too much context and you need a short list of likely targets before acting.',
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_act', 'browser_snapshot', 'browser_wait_for'],
      examples: [
        {
          title: 'Find the primary submit control',
          arguments: {
            query: 'submit',
            roleFilter: 'button',
            limit: 5,
          },
        },
      ],
    },
    surface: canonicalSurface({ gettingStartedOrder: 55, sessionReuseOrder: 55 }),
  },
  browser_screenshot: {
    guidance: {
      workflowStage: 'observation',
      whenToUse: 'Capture an explicit screenshot for human review after the page state is stable.',
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_snapshot', 'browser_debug_state'],
      examples: [{ title: 'Capture a robust screenshot', arguments: { captureMode: 'full_page', format: 'jpeg', quality: 70 } }],
    },
    surface: advancedSurface(),
    deprecation: {
      since: '2.0.0',
      replacement: 'browser_debug_state',
      message: 'Prefer browser_debug_state first, or browser_screenshot with captureMode when explicit image capture is required.',
    },
  },
  browser_console_get: {
    guidance: {
      workflowStage: 'observation',
      whenToUse: 'Inspect browser console output while debugging broken pages or script failures.',
      preferredTargetKind: 'console',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_snapshot', 'browser_network_entries'],
    },
    surface: advancedSurface({ pageDebugOrder: 40 }),
    deprecation: {
      since: '2.0.0',
      replacement: 'browser_debug_state',
      message: 'Prefer browser_debug_state first; use console tools only for deeper full-profile debugging.',
    },
  },
  browser_network_entries: {
    guidance: {
      workflowStage: 'observation',
      whenToUse: 'Inspect captured network traffic while debugging API or page load behavior.',
      preferredTargetKind: 'network',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_network_summary', 'browser_snapshot'],
    },
    surface: advancedSurface({ pageDebugOrder: 50 }),
    deprecation: {
      since: '2.0.0',
      replacement: 'browser_debug_state',
      message: 'Prefer browser_debug_state first; use network tools only for deeper full-profile debugging.',
    },
  },
  browser_network_summary: {
    guidance: {
      workflowStage: 'observation',
      whenToUse: 'Summarize captured network behavior before drilling into individual entries.',
      preferredTargetKind: 'network',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_network_entries'],
    },
    surface: advancedSurface(),
    deprecation: {
      since: '2.0.0',
      replacement: 'browser_debug_state',
      message: 'Prefer browser_debug_state first; use network tools only for deeper full-profile debugging.',
    },
  },
  browser_validate_selector: {
    guidance: {
      workflowStage: 'inspection',
      whenToUse: 'Validate a selector or elementRef before an interaction when target stability is uncertain.',
      preferredTargetKind: 'selector_or_element_ref',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'full',
      preferredNextTools: ['browser_snapshot', 'browser_act'],
    },
    surface: advancedSurface(),
  },
});

Object.assign(CAPABILITY_MANIFESTS, {
  browser_observe: {
    guidance: {
      workflowStage: 'observation',
      whenToUse:
        'Navigate if needed, optionally wait for one structured condition, and collect a fresh snapshot plus interaction health in one step.',
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'navigation_or_observation',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_search', 'browser_act', 'browser_wait_for'],
      examples: [{ title: 'Navigate and observe', arguments: { url: 'https://example.com', wait: { kind: 'element', selector: 'main' }, elementsFilter: 'interactive' } }],
    },
    surface: canonicalSurface({ gettingStartedOrder: 40, sessionReuseOrder: 40 }),
    resultContract: [...BROWSER_OBSERVE_RESULT_CONTRACT],
    modelHints: {
      authoritativeSignals: [...BROWSER_SNAPSHOT_AUTHORITATIVE_SIGNALS],
    },
  },
  browser_snapshot: {
    guidance: {
      workflowStage: 'inspection',
      whenToUse:
        'Inspect the current DOM state, collect elementRef targets, and review interaction health before interacting.',
      preferredTargetKind: 'element_ref_or_selector',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_search', 'browser_act', 'browser_wait_for'],
      examples: [{ title: 'Inspect interactive elements', arguments: { elementsFilter: 'all', maxElements: 30 } }],
    },
    surface: canonicalSurface({ gettingStartedOrder: 50, sessionReuseOrder: 50, pageDebugOrder: 30 }),
    resultContract: [...BROWSER_SNAPSHOT_RESULT_CONTRACT],
    modelHints: {
      authoritativeSignals: [...BROWSER_SNAPSHOT_AUTHORITATIVE_SIGNALS],
    },
  },
  browser_wait_for: {
    guidance: {
      workflowStage: 'observation',
      whenToUse: 'Wait for a structured condition before clicking, typing, or reading the next page state.',
      preferredTargetKind: 'selector_or_element_ref',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_act', 'browser_snapshot', 'browser_search'],
      examples: [
        {
          title: 'Wait for a route and heading together',
          arguments: {
            condition: {
              kind: 'all',
              conditions: [{ kind: 'url', urlIncludes: '/dashboard' }, { kind: 'text', text: 'Dashboard' }],
            },
            timeoutMs: 5000,
          },
        },
      ],
    },
    surface: canonicalSurface({ gettingStartedOrder: 60, sessionReuseOrder: 60 }),
  },
  browser_act: {
    guidance: {
      workflowStage: 'interaction',
      whenToUse:
        'Use the default high-level interaction entrypoint to click, type, press keys, or click text targets with one stable schema.',
      preferredTargetKind: 'selector_or_element_ref',
      requiresBoundProfile: false,
      transportEffect: 'interaction',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_snapshot', 'browser_search', 'browser_wait_for'],
      examples: [
        {
          title: 'Click by ref and verify multiple outcomes',
          arguments: {
            action: 'click',
            target: { kind: 'element', ref: 'airpa_el:submit_button' },
            verify: {
              kind: 'all',
              conditions: [{ kind: 'url', urlIncludes: '/dashboard' }, { kind: 'text', text: 'Dashboard' }],
            },
          },
        },
      ],
    },
    surface: canonicalSurface({ gettingStartedOrder: 70, sessionReuseOrder: 70 }),
    resultContract: [...BROWSER_ACT_RESULT_CONTRACT],
    modelHints: {
      authoritativeSignals: [...BROWSER_ACT_AUTHORITATIVE_SIGNALS],
      targetPriority: [...BROWSER_ACT_TARGET_PRIORITY],
      commonMistakes: [
        {
          mistake: 'Send waitFor on canonical browser_act requests.',
          correction: 'Use verify instead of waitFor on browser_act.',
        },
        {
          mistake: 'Prefer target.selector before a fresh elementRef target.',
          correction:
            'Prefer target.ref first, then target.selector, and use target.text only when direct DOM targeting is unavailable.',
        },
        {
          mistake: 'Retry browser_act blindly after an unverified action error.',
          correction:
            'Read target/resolvedTarget/primaryEffect/afterUrl first, then use browser_debug_state or browser_snapshot before retrying.',
        },
      ],
    },
  },
  browser_debug_state: {
    guidance: {
      workflowStage: 'observation',
      whenToUse:
        'Collect one compact debug bundle with snapshot, screenshot, console preview, and network summary before deeper manual debugging.',
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'observation',
      recommendedToolProfile: 'compact',
      preferredNextTools: ['browser_snapshot', 'browser_search'],
      examples: [{ title: 'Collect debug bundle', arguments: { includeConsole: true, includeNetwork: true } }],
    },
    surface: canonicalSurface({ pageDebugOrder: 20 }),
    modelHints: {
      authoritativeSignals: [...BROWSER_SNAPSHOT_AUTHORITATIVE_SIGNALS],
    },
  },
});

const buildPrefixGuidance = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationAssistantGuidance | undefined => {
  if (definition.name.startsWith('browser_')) {
    return {
      workflowStage: 'observation',
      whenToUse: definition.description,
      preferredTargetKind: 'page',
      requiresBoundProfile: false,
      transportEffect: 'tool_call',
      recommendedToolProfile: 'full',
    };
  }

  if (definition.name.startsWith('profile_') || definition.name.startsWith('session_')) {
    return {
      workflowStage: 'session',
      whenToUse: definition.description,
      preferredTargetKind: 'session',
      requiresBoundProfile: false,
      transportEffect: 'session_state',
      recommendedToolProfile: 'full',
    };
  }

  if (definition.name.startsWith('dataset_') || definition.name.startsWith('cross_plugin_')) {
    return {
      workflowStage: 'data',
      whenToUse: definition.description,
      preferredTargetKind: definition.name.startsWith('dataset_') ? 'dataset' : 'plugin_api',
      requiresBoundProfile: false,
      transportEffect: 'none',
      recommendedToolProfile: 'full',
    };
  }

  return undefined;
};

const buildDefaultSurface = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationAssistantSurface | undefined => {
  if (
    definition.name.startsWith('browser_') ||
    definition.name.startsWith('profile_') ||
    definition.name.startsWith('session_') ||
    definition.name.startsWith('dataset_') ||
    definition.name.startsWith('cross_plugin_')
  ) {
    return advancedSurface();
  }

  return undefined;
};

export const getCapabilityAssistantManifest = (
  definition: OrchestrationCapabilityDefinition
): CapabilityAssistantManifest | undefined => {
  const specific = CAPABILITY_MANIFESTS[definition.name];
  if (specific) {
    return specific;
  }

  const guidance = buildPrefixGuidance(definition);
  const surface = buildDefaultSurface(definition);
  if (!guidance && !surface) {
    return undefined;
  }

  return {
    ...(guidance ? { guidance } : {}),
    ...(surface ? { surface } : {}),
  };
};

export const getAssistantGuidanceForCapability = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationAssistantGuidance | undefined =>
  getCapabilityAssistantManifest(definition)?.guidance;

export const getAssistantSurfaceForCapability = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationAssistantSurface | undefined =>
  getCapabilityAssistantManifest(definition)?.surface;

export const getCapabilityDeprecationForCapability = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationCapabilityDeprecation | undefined =>
  getCapabilityAssistantManifest(definition)?.deprecation;

export const getCapabilityContractLines = (
  definition: OrchestrationCapabilityDefinition
): string[] => {
  const manifest = getCapabilityAssistantManifest(definition);
  return [...(manifest?.resultContract || []), ...(manifest?.failureContract || [])];
};

export const getCapabilityContractManifest = (
  definition: OrchestrationCapabilityDefinition
):
  | {
      resultContract?: string[];
      failureContract?: string[];
    }
  | undefined => {
  const manifest = getCapabilityAssistantManifest(definition);
  if (!manifest?.resultContract?.length && !manifest?.failureContract?.length) {
    return undefined;
  }

  return {
    ...(manifest?.resultContract?.length ? { resultContract: [...manifest.resultContract] } : {}),
    ...(manifest?.failureContract?.length ? { failureContract: [...manifest.failureContract] } : {}),
  };
};

export const getCapabilityModelHintsManifest = (
  definition: OrchestrationCapabilityDefinition
): CapabilityModelHintsManifest | undefined =>
  getCapabilityAssistantManifest(definition)?.modelHints;

export const withAssistantGuidance = (
  definition: OrchestrationCapabilityDefinition
): OrchestrationCapabilityDefinition => {
  const manifest = getCapabilityAssistantManifest(definition);

  return {
    ...definition,
    ...(definition.assistantGuidance || !manifest?.guidance
      ? {}
      : { assistantGuidance: manifest.guidance }),
    ...(definition.assistantSurface || !manifest?.surface
      ? {}
      : { assistantSurface: manifest.surface }),
    ...(definition.deprecation || !manifest?.deprecation
      ? {}
      : { deprecation: manifest.deprecation }),
  };
};
