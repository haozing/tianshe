import type { RestApiDependencies } from '../types/http-api';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationCapabilityRequirement,
} from '../core/ai-dev/orchestration';
import {
  SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_ACTION,
  SESSION_PREPARE_RESOLVED_BINDING_ACTION,
  SESSION_PREPARE_RESOLVED_BINDING_PRECONDITION,
} from '../core/ai-dev/orchestration';
import type { BrowserCapabilityName } from '../types/browser-interface';
import type { McpSessionSnapshot } from './mcp-http-session-snapshot';
import { buildMcpSessionSnapshot } from './mcp-http-session-snapshot';
import type { McpSessionInfo } from './mcp-http-types';
import { browserRuntimeSupports } from '../core/browser-pool/engine-capability-registry';

export type McpToolRuntimeAvailabilityStatus =
  | 'available'
  | 'available_with_notice'
  | 'unavailable';

export type McpToolRuntimeSessionContext = McpSessionSnapshot;

export interface McpToolRuntimeAvailability {
  status: McpToolRuntimeAvailabilityStatus;
  availableNow: boolean;
  reasonCode?: string;
  reason?: string;
  missingRequirements: OrchestrationCapabilityRequirement[];
  unsupportedRequirements: OrchestrationCapabilityRequirement[];
  preconditionsNow: string[];
  recommendedActions: string[];
  session: McpToolRuntimeSessionContext;
}

export const buildMcpRuntimeSessionContext = (
  mcpSession: McpSessionInfo
): McpToolRuntimeSessionContext => buildMcpSessionSnapshot(mcpSession);

const collectMissingCapabilityRequirements = (
  capability: OrchestrationCapabilityDefinition,
  dependencies: RestApiDependencies | undefined
): OrchestrationCapabilityRequirement[] => {
  const requirements = capability.requires ?? [];
  return requirements.filter((requirement) => {
    switch (requirement) {
      case 'datasetGateway':
        return !dependencies?.datasetGateway;
      case 'crossPluginGateway':
        return !dependencies?.crossPluginGateway;
      case 'pluginGateway':
        return !dependencies?.pluginGateway;
      case 'profileGateway':
        return !dependencies?.profileGateway;
      case 'systemGateway':
        return !dependencies?.systemGateway;
      case 'observationGateway':
        return !dependencies?.observationGateway;
      case 'mcpSessionGateway':
        return false;
      default:
        return false;
    }
  });
};

const collectUnsupportedBrowserRequirements = (
  capability: OrchestrationCapabilityDefinition,
  session: McpSessionSnapshot
): OrchestrationCapabilityRequirement[] => {
  const runtimeDescriptor = session.resolvedRuntimeDescriptor;
  if (!runtimeDescriptor) {
    return [];
  }

  const requirements = capability.requires ?? [];
  return requirements.filter((requirement) => {
    if (typeof requirement === 'string' && requirement.startsWith('browserCapability:')) {
      const capabilityName = requirement.slice('browserCapability:'.length) as BrowserCapabilityName;
      return !browserRuntimeSupports(runtimeDescriptor, capabilityName);
    }
    return false;
  });
};

const collectIndeterminateBrowserRequirements = (
  capability: OrchestrationCapabilityDefinition,
  session: McpSessionSnapshot
): OrchestrationCapabilityRequirement[] => {
  if (session.resolvedRuntimeDescriptor) {
    return [];
  }

  const requirements = capability.requires ?? [];
  return requirements.filter(
    (requirement) =>
      typeof requirement === 'string' && requirement.startsWith('browserCapability:')
  );
};

const requirementDisplayName = (
  requirement: OrchestrationCapabilityRequirement
): string => {
  switch (requirement) {
    case 'datasetGateway':
      return 'dataset gateway';
    case 'crossPluginGateway':
      return 'cross-plugin gateway';
    case 'pluginGateway':
      return 'plugin gateway';
    case 'profileGateway':
      return 'profile gateway';
    case 'systemGateway':
      return 'system gateway';
    case 'observationGateway':
      return 'observation gateway';
    case 'mcpSessionGateway':
      return 'MCP session gateway';
    case 'browser':
      return 'browser runtime';
    case 'sessionBrowser':
      return 'session browser binding';
    default:
      if (typeof requirement === 'string' && requirement.startsWith('browserCapability:')) {
        return requirement.slice('browserCapability:'.length).replace(/\./g, ' ');
      }
      return requirement;
  }
};

const buildUnavailableAvailability = (
  session: McpToolRuntimeSessionContext,
  reasonCode: string,
  reason: string,
  missingRequirements: OrchestrationCapabilityRequirement[] = [],
  unsupportedRequirements: OrchestrationCapabilityRequirement[] = [],
  recommendedActions: string[] = []
): McpToolRuntimeAvailability => ({
  status: 'unavailable',
  availableNow: false,
  reasonCode,
  reason,
  missingRequirements,
  unsupportedRequirements,
  preconditionsNow: [reason],
  recommendedActions,
  session,
});

const buildAvailableAvailability = (
  session: McpToolRuntimeSessionContext,
  options: {
    status?: McpToolRuntimeAvailabilityStatus;
    reasonCode?: string;
    reason?: string;
    preconditionsNow?: string[];
    recommendedActions?: string[];
  } = {}
): McpToolRuntimeAvailability => ({
  status: options.status || 'available',
  availableNow: true,
  ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
  ...(options.reason ? { reason: options.reason } : {}),
  missingRequirements: [],
  unsupportedRequirements: [],
  preconditionsNow: options.preconditionsNow || [],
  recommendedActions: options.recommendedActions || [],
  session,
});

const buildSessionPrepareQueryDependencyNotice = (
  dependencies: RestApiDependencies | undefined
): {
  status?: McpToolRuntimeAvailabilityStatus;
  reasonCode?: string;
  reason?: string;
  preconditionsNow: string[];
  recommendedActions: string[];
} => {
  const preconditionsNow = [SESSION_PREPARE_RESOLVED_BINDING_PRECONDITION];
  const recommendedActions = [
    SESSION_PREPARE_RESOLVED_BINDING_ACTION,
    SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_ACTION,
  ];

  if (dependencies?.profileGateway) {
    return {
      preconditionsNow,
      recommendedActions,
    };
  }

  return {
    status: 'available_with_notice',
    reasonCode: 'profile_query_requires_profile_gateway',
    reason:
      'session_prepare remains available for engine, visibility, and scope updates, but query-based profile resolution requires a configured profile gateway.',
    preconditionsNow: [
      'Calling session_prepare with query requires a configured profile gateway.',
      'When profileGateway is unavailable, omit query and only set engine, visible, or scopes on the current session.',
      ...preconditionsNow,
    ],
    recommendedActions: [
      'Call session_prepare without query when you only need to adjust engine, visibility, or sticky scopes.',
      ...recommendedActions,
    ],
  };
};

export const evaluateCapabilityRuntimeAvailability = (
  capability: OrchestrationCapabilityDefinition,
  dependencies: RestApiDependencies | undefined,
  mcpSession: McpSessionInfo
): McpToolRuntimeAvailability => {
  const session = buildMcpRuntimeSessionContext(mcpSession);
  const missingRequirements = collectMissingCapabilityRequirements(
    capability,
    dependencies
  );
  if (missingRequirements.length > 0) {
    return buildUnavailableAvailability(
      session,
      'missing_runtime_dependency',
      `Missing runtime dependencies: ${missingRequirements
        .map(requirementDisplayName)
        .join(', ')}.`,
      missingRequirements,
      [],
      ['Configure the required server dependencies before calling this tool.']
    );
  }

  const unsupportedRequirements = collectUnsupportedBrowserRequirements(
    capability,
    session
  );
  if (unsupportedRequirements.length > 0) {
    return buildUnavailableAvailability(
      session,
      'unsupported_browser_features',
      `The active browser session does not support: ${unsupportedRequirements
        .map(requirementDisplayName)
        .join(', ')}.`,
      [],
      unsupportedRequirements,
      [
        'Use a browser implementation that supports the required feature set, or start a new compatible session.',
      ]
    );
  }

  const indeterminateRequirements = collectIndeterminateBrowserRequirements(capability, session);
  if (indeterminateRequirements.length > 0) {
    return buildAvailableAvailability(session, {
      status: 'available_with_notice',
      reasonCode: 'browser_capability_pending_engine_resolution',
      reason: `Browser feature availability depends on the engine that will be acquired for this session: ${indeterminateRequirements
        .map(requirementDisplayName)
        .join(', ')}.`,
      preconditionsNow: [
        'The session does not have a resolved engine or acquired browser yet.',
        'Call session_prepare with an explicit engine if you need deterministic browser capability selection before the first browser_* tool runs.',
      ],
      recommendedActions: [
        'Bind an explicit engine with session_prepare before relying on engine-specific browser features.',
      ],
    });
  }

  if (session.phase === 'closing' || session.phase === 'closed') {
    return buildUnavailableAvailability(
      session,
      session.phase === 'closing' ? 'session_closing' : 'session_closed',
      session.phase === 'closing'
        ? 'Current MCP session is closing and cannot accept more work.'
        : 'Current MCP session is no longer active.',
      [],
      [],
      [
        'Create a new MCP session before retrying this request.',
        'Do not send more requests on a transport after session_end_current completes.',
      ]
    );
  }

  if (capability.name === 'session_prepare') {
    const queryDependencyNotice = buildSessionPrepareQueryDependencyNotice(dependencies);

    if (session.bindingLocked) {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'binding_locked',
        reason:
          'The session already acquired a browser, so profile, engine, and visibility changes must be idempotent replays. Sticky scope updates are still allowed.',
        preconditionsNow: [
          ...queryDependencyNotice.preconditionsNow,
          'Use the same profile, engine, and visibility values for an idempotent replay after browser acquisition.',
          'Only scope updates remain mutable once the browser binding is locked.',
        ],
        recommendedActions: [
          'Create a new MCP session before switching profile, engine, or visibility after browser acquisition.',
          'Use a dedicated session_prepare call if you only need to update scopes.',
          ...queryDependencyNotice.recommendedActions,
        ],
      });
    }

    if (session.profileId) {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'session_profile_already_bound',
        reason: `${queryDependencyNotice.reason ? `${queryDependencyNotice.reason} ` : ''}Current session is already prepared with profile ${session.profileId}; replaying the same profile is idempotent, and you can still update scopes before the first browser_* call.`,
        preconditionsNow: [
          ...queryDependencyNotice.preconditionsNow,
          `Session is currently bound to profile ${session.profileId}.`,
        ],
        recommendedActions: [
          'Reuse the current bound profile, or call session_prepare again with a different profile before the first browser_* tool runs.',
          ...queryDependencyNotice.recommendedActions,
        ],
      });
    }

    return buildAvailableAvailability(session, {
      status: queryDependencyNotice.status,
      reasonCode: queryDependencyNotice.reasonCode,
      reason: queryDependencyNotice.reason,
      preconditionsNow: queryDependencyNotice.preconditionsNow,
      recommendedActions: queryDependencyNotice.recommendedActions,
    });
  }

  if (capability.name === 'session_close') {
    return buildAvailableAvailability(session, {
      status: 'available_with_notice',
      reasonCode: 'current_session_close_requires_allow_current',
      reason:
        'Closing the current MCP session is supported, but you must pass allowCurrent=true when sessionId matches currentSessionId.',
      preconditionsNow: [
        'Closing another session works with the default arguments.',
        'Closing the current session requires allowCurrent=true.',
      ],
      recommendedActions: [
        'Use session_get_current to read currentSessionId before closing the active session.',
        'Pass allowCurrent=true when closing the current session as the final step.',
      ],
    });
  }

  if (capability.name === 'session_end_current') {
    return buildAvailableAvailability(session, {
      status: 'available_with_notice',
      reasonCode: 'current_session_end_current',
      reason:
        'session_end_current always targets the active MCP session and invalidates the current transport after the response is flushed.',
      preconditionsNow: [
        'Use this only as the final step on the current transport.',
      ],
      recommendedActions: [
        'Do not send another request on the same transport after session_end_current succeeds.',
      ],
    });
  }

  if (capability.name.startsWith('browser_')) {
    if (session.phase === 'acquiring_browser') {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'browser_acquire_in_progress',
        reason: 'Browser acquisition is already in progress for this session.',
        preconditionsNow: [
          'Wait for the current browser acquisition to complete before assuming a fresh browser context.',
        ],
      });
    }

    if (session.phase === 'prepared_unacquired' && session.profileId) {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'browser_will_acquire_bound_profile',
        reason: `The first browser_* call will acquire a browser bound to profile ${session.profileId}.`,
        preconditionsNow: [
          `Profile ${session.profileId} is already bound to this session.`,
        ],
        recommendedActions: [
          'If you re-run session_prepare before the first browser_* call, trust effectiveProfile/effectiveEngine/effectiveEngineSource from the result as the resolved binding.',
        ],
      });
    }

    if (session.phase === 'prepared_unacquired') {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'browser_will_acquire_prepared_session',
        reason:
          'The first browser_* call will acquire a browser using the sticky session settings prepared so far.',
        preconditionsNow: [
          'Profile is not bound yet, but sticky engine, visibility, or scopes may already be prepared on this session.',
        ],
        recommendedActions: [
          'Trust effectiveProfile/effectiveEngine/effectiveEngineSource from session_prepare before assuming how the first browser_* call will bind.',
        ],
      });
    }

    if (session.phase === 'fresh_unbound') {
      return buildAvailableAvailability(session, {
        status: 'available_with_notice',
        reasonCode: 'fresh_browser_without_bound_profile',
        reason:
          'The first browser_* call will acquire a fresh browser with no reusable profile attached.',
        preconditionsNow: [
          'Call session_prepare before the first browser_* call if you need a logged-in or reusable profile.',
        ],
        recommendedActions: [
          'Use session_prepare first when the task depends on an existing logged-in browser state or sticky session scopes.',
          'Read effectiveProfile/effectiveEngine/effectiveEngineSource from the session_prepare result before assuming which profile or engine the first browser_* call will acquire.',
        ],
      });
    }

    if (
      session.browserAcquired &&
      [
        'browser_act',
        'browser_click_at',
        'browser_drag_to',
        'browser_hover_at',
        'browser_native_key',
        'browser_native_type',
        'browser_scroll_at',
      ].includes(capability.name) &&
      (session.interactionReady !== true || session.viewportHealth !== 'ready')
    ) {
      return buildUnavailableAvailability(
        session,
        'interaction_not_ready',
        `Current session host is not ready for interaction (viewportHealth=${session.viewportHealth || 'unknown'}).`,
        [],
        [],
        [
          'Use browser_snapshot or session_get_current to inspect interactionReady, viewportHealth, hostWindowId, and offscreenDetected.',
          'Retry the interaction after the session repairs or reacquires its browser host.',
        ]
      );
    }
  }

  return buildAvailableAvailability(session);
};
