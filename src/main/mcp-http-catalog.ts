import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Prompt,
  type PromptMessage,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { RestApiDependencies } from '../types/http-api';
import type {
  OrchestrationAssistantGuidance,
  OrchestrationCapabilityDefinition,
} from '../core/ai-dev/orchestration';
import {
  getCapabilityContractManifest,
  getCapabilityModelHintsManifest,
  listCanonicalPublicCapabilities,
  SESSION_PREPARE_RESOLVED_BINDING_ACTION,
} from '../core/ai-dev/orchestration';
import { asTrimmedText } from './mcp-http-transport-utils';
import type { McpServerInfo, McpSessionInfo } from './mcp-http-types';
import {
  buildMcpRuntimeSessionContext,
  evaluateCapabilityRuntimeAvailability,
  type McpToolRuntimeAvailability,
  type McpToolRuntimeSessionContext,
} from './mcp-http-runtime-availability';
import { getRuntimeFingerprint } from './runtime-fingerprint';
import {
  buildGuideContent,
  buildPromptMessageText,
  type McpGuideContentName,
} from './mcp-guidance-content';
import {
  MCP_PROMPT_DEFINITIONS,
  MCP_PROMPT_NAMES,
  MCP_PROMPT_PAGE_DEBUG_NAME,
  MCP_PROMPT_SESSION_REUSE_NAME,
} from './mcp-catalog-metadata';

export const MCP_RESOURCE_CATALOG_URI = 'airpa://mcp/tools/catalog';
export const MCP_RESOURCE_TOOL_URI_PREFIX = 'airpa://mcp/tools/';
export const MCP_RESOURCE_TOOL_TEMPLATE_URI = 'airpa://mcp/tools/{toolName}';
export const MCP_RESOURCE_GUIDE_GETTING_STARTED_URI = 'airpa://mcp/guides/getting-started';
export const MCP_RESOURCE_GUIDE_LOGIN_URI = 'airpa://mcp/guides/login-pages';
export const MCP_RESOURCE_GUIDE_FORMS_URI = 'airpa://mcp/guides/forms';
export const MCP_RESOURCE_GUIDE_LISTS_URI = 'airpa://mcp/guides/lists';
export const MCP_RESOURCE_GUIDE_SEARCH_RESULTS_URI = 'airpa://mcp/guides/search-results';
export const MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI = 'airpa://mcp/guides/hidden-session-debug';
export const MCP_RESOURCE_SERVER_POLICY_URI = 'airpa://mcp/server/policy';
export const MCP_RESOURCE_SERVER_RUNTIME_HEALTH_URI = 'airpa://mcp/server/runtime-health';
export const MCP_TOOL_RUNTIME_META_KEY = 'airpa/runtimeAvailability';
export const MCP_TOOL_GUIDANCE_META_KEY = 'airpa/assistantGuidance';
export const MCP_TOOL_MODEL_HINTS_META_KEY = 'airpa/modelHints';
export const MCP_TOOL_EXAMPLES_META_KEY = 'airpa/examples';
export {
  MCP_PROMPT_GETTING_STARTED_NAME,
  MCP_PROMPT_PAGE_DEBUG_NAME,
  MCP_PROMPT_SESSION_REUSE_NAME,
} from './mcp-catalog-metadata';

interface RegisterMcpCatalogHandlersOptions {
  server: Server;
  serverInfo: McpServerInfo;
  listCapabilities: () => OrchestrationCapabilityDefinition[];
  dependencies?: RestApiDependencies;
  mcpSession: McpSessionInfo;
}

const MCP_RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: MCP_RESOURCE_TOOL_TEMPLATE_URI,
    name: 'airpa.tool.detail',
    title: 'Airpa Tool Detail',
    description: 'Read details for one MCP tool capability by tool name',
    mimeType: 'application/json',
  },
];

const MCP_GUIDE_DEFINITIONS: Array<{
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: 'text/markdown';
  guideName: McpGuideContentName;
  priority: number;
}> = [
  {
    uri: MCP_RESOURCE_GUIDE_GETTING_STARTED_URI,
    name: 'airpa.guide.getting-started',
    title: 'Airpa MCP Getting Started',
    description: 'Recommended tool flow for browser automation from LLM clients.',
    mimeType: 'text/markdown',
    guideName: 'getting_started',
    priority: 0.95,
  },
  {
    uri: MCP_RESOURCE_GUIDE_LOGIN_URI,
    name: 'airpa.guide.login-pages',
    title: 'Airpa Login Pages',
    description: 'Playbook for authentication, consent, and MFA browser flows.',
    mimeType: 'text/markdown',
    guideName: 'login_pages',
    priority: 0.82,
  },
  {
    uri: MCP_RESOURCE_GUIDE_FORMS_URI,
    name: 'airpa.guide.forms',
    title: 'Airpa Forms',
    description: 'Playbook for data-entry, modal forms, and submit verification.',
    mimeType: 'text/markdown',
    guideName: 'forms',
    priority: 0.8,
  },
  {
    uri: MCP_RESOURCE_GUIDE_LISTS_URI,
    name: 'airpa.guide.lists',
    title: 'Airpa Lists And Detail Views',
    description: 'Playbook for row actions, pagination, and list-to-detail transitions.',
    mimeType: 'text/markdown',
    guideName: 'lists',
    priority: 0.78,
  },
  {
    uri: MCP_RESOURCE_GUIDE_SEARCH_RESULTS_URI,
    name: 'airpa.guide.search-results',
    title: 'Airpa Search Results',
    description: 'Playbook for search bars, filters, result refresh, and result selection.',
    mimeType: 'text/markdown',
    guideName: 'search_results',
    priority: 0.78,
  },
  {
    uri: MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI,
    name: 'airpa.guide.hidden-session-debug',
    title: 'Airpa Hidden Session Debug',
    description: 'Playbook for hidden host, viewport, and interaction-readiness issues.',
    mimeType: 'text/markdown',
    guideName: 'hidden_session_debug',
    priority: 0.84,
  },
];

const MCP_GUIDE_RESOURCES: Resource[] = [
  ...MCP_GUIDE_DEFINITIONS.map((guide) => ({
    uri: guide.uri,
    name: guide.name,
    title: guide.title,
    description: guide.description,
    mimeType: guide.mimeType,
    annotations: {
      audience: ['assistant'] as ('user' | 'assistant')[],
      priority: guide.priority,
    },
  })),
  {
    uri: MCP_RESOURCE_SERVER_POLICY_URI,
    name: 'airpa.server.policy',
    title: 'Airpa MCP Server Policy',
    description: 'Machine-readable contract for the canonical Airpa MCP surface.',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_SERVER_RUNTIME_HEALTH_URI,
    name: 'airpa.server.runtime-health',
    title: 'Airpa MCP Runtime Health',
    description: 'Machine-readable runtime and current-session health snapshot.',
    mimeType: 'application/json',
  },
];

const toCapabilityResource = (capability: OrchestrationCapabilityDefinition): Resource => ({
  uri: `${MCP_RESOURCE_TOOL_URI_PREFIX}${encodeURIComponent(capability.name)}`,
  name: `airpa.tool.${capability.name}`,
  title: capability.title || capability.name,
  description: capability.description,
  mimeType: 'application/json',
  ...(capability.annotations
    ? {
        annotations: {
          audience: ['assistant'],
          priority: capability.annotations.readOnlyHint ? 0.7 : 0.6,
        },
      }
    : {}),
});

const buildMcpResourceList = (capabilities: OrchestrationCapabilityDefinition[]): Resource[] => [
  {
    uri: MCP_RESOURCE_CATALOG_URI,
    name: 'airpa.tools.catalog',
    title: 'Airpa Tools Catalog',
    description: 'Catalog of registered MCP tool capabilities',
    mimeType: 'application/json',
  },
  ...MCP_GUIDE_RESOURCES,
  ...capabilities.map((capability) => toCapabilityResource(capability)),
];

const getGuideDefinition = (uri: string) => MCP_GUIDE_DEFINITIONS.find((guide) => guide.uri === uri);

const getGuideUrisForCapability = (capabilityName: string): string[] => {
  switch (capabilityName) {
    case 'session_prepare':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_LOGIN_URI];
    case 'session_get_current':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI];
    case 'browser_observe':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_LOGIN_URI, MCP_RESOURCE_GUIDE_LISTS_URI];
    case 'browser_snapshot':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_LISTS_URI];
    case 'browser_search':
      return [
        MCP_RESOURCE_GUIDE_GETTING_STARTED_URI,
        MCP_RESOURCE_GUIDE_SEARCH_RESULTS_URI,
        MCP_RESOURCE_GUIDE_LISTS_URI,
      ];
    case 'browser_act':
      return [
        MCP_RESOURCE_GUIDE_GETTING_STARTED_URI,
        MCP_RESOURCE_GUIDE_FORMS_URI,
        MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI,
      ];
    case 'browser_wait_for':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_SEARCH_RESULTS_URI];
    case 'browser_debug_state':
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI, MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI];
    default:
      return [MCP_RESOURCE_GUIDE_GETTING_STARTED_URI];
  }
};

const toPublicAssistantGuidance = (
  guidance: OrchestrationAssistantGuidance | undefined
):
  | {
      workflowStage: OrchestrationAssistantGuidance['workflowStage'];
      whenToUse: string;
      avoidWhen?: string;
      preferredNextTools?: string[];
    }
  | null => {
  if (!guidance) {
    return null;
  }

  return {
    workflowStage: guidance.workflowStage,
    whenToUse: guidance.whenToUse,
    ...(guidance.avoidWhen ? { avoidWhen: guidance.avoidWhen } : {}),
    ...(guidance.preferredNextTools?.length
      ? { preferredNextTools: [...guidance.preferredNextTools] }
      : {}),
  };
};

type ToolModelRecommendationStrength = 'primary' | 'secondary' | 'fallback';

type ToolModelFlowHint = {
  flow: 'getting_started' | 'session_reuse' | 'page_debug';
  order: number;
  strength: ToolModelRecommendationStrength;
};

const getCapabilityExamples = (
  capability: OrchestrationCapabilityDefinition
): Array<{ title: string; arguments: Record<string, unknown> }> =>
  (capability.assistantGuidance?.examples || []).slice(0, 2).map((example) => ({
    title: example.title,
    arguments: { ...example.arguments },
  }));

const buildToolFlowHints = (capability: OrchestrationCapabilityDefinition): ToolModelFlowHint[] => {
  const assistantSurface = capability.assistantSurface;
  const flowHints: ToolModelFlowHint[] = [];

  if (Number.isFinite(assistantSurface?.gettingStartedOrder)) {
    flowHints.push({
      flow: 'getting_started',
      order: Number(assistantSurface?.gettingStartedOrder),
      strength:
        Number(assistantSurface?.gettingStartedOrder) <= 40
          ? 'primary'
          : Number(assistantSurface?.gettingStartedOrder) <= 70
            ? 'secondary'
            : 'fallback',
    });
  }

  if (Number.isFinite(assistantSurface?.sessionReuseOrder)) {
    flowHints.push({
      flow: 'session_reuse',
      order: Number(assistantSurface?.sessionReuseOrder),
      strength:
        Number(assistantSurface?.sessionReuseOrder) <= 40
          ? 'primary'
          : Number(assistantSurface?.sessionReuseOrder) <= 70
            ? 'secondary'
            : 'fallback',
    });
  }

  if (Number.isFinite(assistantSurface?.pageDebugOrder)) {
    flowHints.push({
      flow: 'page_debug',
      order: Number(assistantSurface?.pageDebugOrder),
      strength:
        Number(assistantSurface?.pageDebugOrder) <= 40
          ? 'primary'
          : Number(assistantSurface?.pageDebugOrder) <= 70
            ? 'secondary'
            : 'fallback',
    });
  }

  return flowHints.sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.flow.localeCompare(right.flow);
  });
};

const toCatalogToolRecord = (
  capability: OrchestrationCapabilityDefinition,
  runtime?: McpToolRuntimeAvailability
) => ({
  name: capability.name,
  title: capability.title || capability.name,
  version: capability.version,
  description: capability.description,
  requires: capability.requires ?? [],
  requiredScopes: capability.requiredScopes ?? [],
  idempotent: capability.idempotent,
  sideEffectLevel: capability.sideEffectLevel,
  retryPolicy: capability.retryPolicy,
  inputSchema: capability.inputSchema ?? {},
  outputSchema: capability.outputSchema,
  annotations: capability.annotations ?? null,
  assistantGuidance: toPublicAssistantGuidance(capability.assistantGuidance),
  examples: getCapabilityExamples(capability),
  runtime: runtime || null,
  modelHints: runtime ? buildToolModelHints(capability, runtime) : null,
});

const buildToolModelHints = (
  capability: OrchestrationCapabilityDefinition,
  runtime: McpToolRuntimeAvailability
) => {
  const modelHints: {
    readBeforeCall?: string[];
    nextActions?: string[];
    authoritativeResultFields?: string[];
    authoritativeSignals?: string[];
    targetPriority?: string[];
    recommendedFlows?: ToolModelFlowHint[];
    failureCodes?: Array<{
      code: string;
      when: string;
      remediation: string;
    }>;
    commonMistakes?: Array<{
      mistake: string;
      correction: string;
    }>;
    resultContract?: string[];
    failureContract?: string[];
  } = {};

  if (runtime.preconditionsNow.length > 0) {
    modelHints.readBeforeCall = [...runtime.preconditionsNow];
  }

  if (runtime.recommendedActions.length > 0) {
    modelHints.nextActions = [...runtime.recommendedActions];
  }

  const recommendedFlows = buildToolFlowHints(capability);
  if (recommendedFlows.length > 0) {
    modelHints.recommendedFlows = recommendedFlows;
  }

  const manifestHints = getCapabilityModelHintsManifest(capability);
  if (manifestHints?.authoritativeResultFields?.length) {
    modelHints.authoritativeResultFields = [...manifestHints.authoritativeResultFields];
  }
  if (manifestHints?.authoritativeSignals?.length) {
    modelHints.authoritativeSignals = [...manifestHints.authoritativeSignals];
  }
  if (manifestHints?.targetPriority?.length) {
    modelHints.targetPriority = [...manifestHints.targetPriority];
  }
  if (manifestHints?.failureCodes?.length) {
    modelHints.failureCodes = manifestHints.failureCodes.map((item) => ({ ...item }));
  }
  if (manifestHints?.commonMistakes?.length) {
    modelHints.commonMistakes = manifestHints.commonMistakes.map((item) => ({ ...item }));
  }

  const contractManifest = getCapabilityContractManifest(capability);
  if (contractManifest?.resultContract?.length) {
    modelHints.resultContract = [...contractManifest.resultContract];
  }
  if (contractManifest?.failureContract?.length) {
    modelHints.failureContract = [...contractManifest.failureContract];
  }

  return modelHints;
};

const buildToolsCatalogPayload = (
  serverInfo: McpServerInfo,
  capabilities: Array<{
    capability: OrchestrationCapabilityDefinition;
    runtime: McpToolRuntimeAvailability;
  }>,
  session: McpToolRuntimeSessionContext
) => ({
  schema: 'airpa.mcp.tools.catalog.v2',
  server: {
    name: serverInfo.name,
    version: serverInfo.version,
  },
  generatedAt: new Date().toISOString(),
  ...getRuntimeFingerprint(),
  currentSession: session,
  totalTools: capabilities.length,
  prompts: MCP_PROMPT_NAMES,
  guides: MCP_GUIDE_DEFINITIONS.map((guide) => guide.uri),
  nextActionHints: [
    'This server is the canonical `airpa-browser-http` MCP surface. Prefer it over generic Playwright/browser MCP servers when the task must reuse an Airpa-managed logged-in profile.',
    'Use session_prepare before the first browser_* call if you need a reusable logged-in profile, an explicit engine choice, visibility control, or session scopes.',
    SESSION_PREPARE_RESOLVED_BINDING_ACTION,
    'Use browser_observe when you want to navigate, optionally wait, and capture a fresh snapshot in one step.',
    'Prefer browser_search or browser_snapshot before browser_act when you need fresh targets with smaller payloads.',
    'Prefer browser_act with target.ref first, then target.selector, when acting on elements returned by browser_observe, browser_search, or browser_snapshot.',
    'When the expected result is explicit, prefer browser_act with verify.kind="all" so action success is verified instead of inferred.',
    'If browser_act is unverified, inspect the compact error first, then use browser_debug_state for deeper diagnostics.',
    'End profile-bound sessions promptly. An active MCP browser binding can keep that profile busy for plugin work.',
    'When work is complete, terminate the MCP session with StreamableHTTPClientTransport.terminateSession() or DELETE /mcp plus the mcp-session-id header.',
    'If you can only act through MCP tools, prefer session_end_current as the final step.',
  ],
  tools: capabilities.map(({ capability, runtime }) => toCatalogToolRecord(capability, runtime)),
});

const buildServerPolicyPayload = (
  capabilities: OrchestrationCapabilityDefinition[]
) => ({
  schema: 'airpa.mcp.server.policy.v3',
  generatedAt: new Date().toISOString(),
  prompts: MCP_PROMPT_NAMES,
  resources: [
    MCP_RESOURCE_CATALOG_URI,
    MCP_RESOURCE_GUIDE_GETTING_STARTED_URI,
    MCP_RESOURCE_GUIDE_LOGIN_URI,
    MCP_RESOURCE_GUIDE_FORMS_URI,
    MCP_RESOURCE_GUIDE_LISTS_URI,
    MCP_RESOURCE_GUIDE_SEARCH_RESULTS_URI,
    MCP_RESOURCE_GUIDE_HIDDEN_SESSION_URI,
    MCP_RESOURCE_SERVER_POLICY_URI,
    MCP_RESOURCE_SERVER_RUNTIME_HEALTH_URI,
  ],
  canonicalTools: capabilities.map((capability) => capability.name),
  responseEnvelope: [
    'ok',
    'summary',
    'data',
    'reasonCode',
    'retryable',
    'nextActionHints',
    'recommendedNextTools',
    'authoritativeFields',
  ],
  canonicalRequestShapes: {
    browser_observe: {
      waitField: 'wait',
      waitKindValues: ['element', 'text', 'text_absent', 'url', 'all', 'any'],
    },
    browser_wait_for: {
      conditionField: 'condition',
      waitKindValues: ['element', 'text', 'text_absent', 'url', 'all', 'any'],
    },
    browser_act: {
      verifyField: 'verify',
      targetField: 'target',
      targetKindValues: ['element', 'text', 'key'],
      actionValues: ['click', 'type', 'press'],
    },
  },
});

const buildRuntimeHealthPayload = (
  serverInfo: McpServerInfo,
  capabilities: Array<{
    capability: OrchestrationCapabilityDefinition;
    runtime: McpToolRuntimeAvailability;
  }>,
  session: McpToolRuntimeSessionContext
) => ({
  schema: 'airpa.mcp.server.runtime-health.v3',
  server: {
    name: serverInfo.name,
    version: serverInfo.version,
  },
  generatedAt: new Date().toISOString(),
  ...getRuntimeFingerprint(),
  currentSession: session,
  toolAvailability: {
    available: capabilities.filter((item) => item.runtime.status === 'available').map((item) => item.capability.name),
    availableWithNotice: capabilities
      .filter((item) => item.runtime.status === 'available_with_notice')
      .map((item) => item.capability.name),
    unavailable: capabilities
      .filter((item) => item.runtime.status === 'unavailable')
      .map((item) => ({
        name: item.capability.name,
        reasonCode: item.runtime.reasonCode || null,
      })),
  },
});

const buildToolDetailPayload = (
  capability: OrchestrationCapabilityDefinition,
  runtime: McpToolRuntimeAvailability
) => ({
  schema: 'airpa.mcp.tool.detail.v2',
  tool: toCatalogToolRecord(capability, runtime),
  preconditions: capability.requires ?? [],
  runtime,
  modelHints: buildToolModelHints(capability, runtime),
  guides: getGuideUrisForCapability(capability.name),
  examples: getCapabilityExamples(capability),
});

const getVisibleCapabilities = (
  listCapabilities: () => OrchestrationCapabilityDefinition[],
  _mcpSession: McpSessionInfo
) => listCanonicalPublicCapabilities(listCapabilities());

const buildPromptResult = (
  promptName: string,
  capabilities: OrchestrationCapabilityDefinition[],
  _mcpSession: McpSessionInfo,
  argumentsMap: Record<string, string> | undefined
): { description?: string; messages: PromptMessage[] } => {
  const prompt = MCP_PROMPT_DEFINITIONS.find((item) => item.name === promptName);
  const text = buildPromptMessageText(promptName, capabilities, argumentsMap);
  return {
    description: prompt?.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text,
        },
      },
    ],
  };
};

const buildPromptList = (): Prompt[] =>
  MCP_PROMPT_DEFINITIONS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
  }));

const resolveToolNameFromResourceUri = (uri: string): string | undefined => {
  if (!uri.startsWith(MCP_RESOURCE_TOOL_URI_PREFIX)) {
    return undefined;
  }
  const encodedToolName = asTrimmedText(uri.slice(MCP_RESOURCE_TOOL_URI_PREFIX.length));
  if (!encodedToolName) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(encodedToolName);
    return asTrimmedText(decoded) || undefined;
  } catch {
    return undefined;
  }
};

export const registerMcpCatalogHandlers = ({
  server,
  serverInfo,
  listCapabilities,
  dependencies,
  mcpSession,
}: RegisterMcpCatalogHandlersOptions): void => {
  const listVisibleCapabilities = () => getVisibleCapabilities(listCapabilities, mcpSession);
  const listCapabilitiesWithRuntime = () =>
    listVisibleCapabilities().map((capability) => ({
      capability,
      runtime: evaluateCapabilityRuntimeAvailability(capability, dependencies, mcpSession),
    }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = listCapabilitiesWithRuntime().map(
      ({ capability, runtime }) =>
        ({
          name: capability.name,
          title: capability.title || capability.name,
          description: toCatalogToolRecord(capability, runtime).description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: capability.inputSchema as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          outputSchema: capability.outputSchema as any,
          ...(capability.annotations ? { annotations: capability.annotations } : {}),
          _meta: {
            [MCP_TOOL_RUNTIME_META_KEY]: runtime,
            [MCP_TOOL_GUIDANCE_META_KEY]: toPublicAssistantGuidance(capability.assistantGuidance),
            [MCP_TOOL_MODEL_HINTS_META_KEY]: buildToolModelHints(capability, runtime),
            [MCP_TOOL_EXAMPLES_META_KEY]: getCapabilityExamples(capability),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
    );

    return { tools };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: buildMcpResourceList(listVisibleCapabilities()) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: MCP_RESOURCE_TEMPLATES };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = asTrimmedText(request.params?.uri);
    if (!uri) {
      throw new Error('Missing resource uri');
    }

    const capabilities = listCapabilitiesWithRuntime();
    if (uri === MCP_RESOURCE_CATALOG_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              buildToolsCatalogPayload(serverInfo, capabilities, buildMcpRuntimeSessionContext(mcpSession)),
              null,
              2
            ),
          },
        ],
      };
    }

    const guide = getGuideDefinition(uri);
    if (guide) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: buildGuideContent(guide.guideName, listVisibleCapabilities()),
          },
        ],
      };
    }

    if (uri === MCP_RESOURCE_SERVER_POLICY_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(buildServerPolicyPayload(listVisibleCapabilities()), null, 2),
          },
        ],
      };
    }

    if (uri === MCP_RESOURCE_SERVER_RUNTIME_HEALTH_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              buildRuntimeHealthPayload(
                serverInfo,
                capabilities,
                buildMcpRuntimeSessionContext(mcpSession)
              ),
              null,
              2
            ),
          },
        ],
      };
    }

    const toolName = resolveToolNameFromResourceUri(uri);
    if (!toolName) {
      throw new Error(`Resource not found: ${uri}`);
    }

    const capability = capabilities.find((item) => item.capability.name === toolName);
    if (!capability) {
      throw new Error(`Resource not found: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(buildToolDetailPayload(capability.capability, capability.runtime), null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: buildPromptList() };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const promptName = asTrimmedText(request.params?.name);
    const prompt = MCP_PROMPT_DEFINITIONS.find((item) => item.name === promptName);
    if (!prompt) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    return buildPromptResult(promptName, listVisibleCapabilities(), mcpSession, request.params?.arguments);
  });
};
