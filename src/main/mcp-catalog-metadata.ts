import {
  listCanonicalAssistantFlowCapabilityNames,
  listCanonicalPublicCapabilities,
  listCanonicalPublicCapabilityNames,
  listOrchestrationCapabilities,
} from '../core/ai-dev/orchestration';

export const MCP_PROMPT_GETTING_STARTED_NAME = 'airpa.getting_started';
export const MCP_PROMPT_SESSION_REUSE_NAME = 'airpa.session_reuse';
export const MCP_PROMPT_PAGE_DEBUG_NAME = 'airpa.page_debug';

export const MCP_PROMPT_DEFINITIONS: Array<{
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}> = [
  {
    name: MCP_PROMPT_GETTING_STARTED_NAME,
    title: 'Airpa Getting Started',
    description: 'Prompt template for first-time Airpa MCP browser work.',
    arguments: [{ name: 'task', description: 'Optional task goal or target site', required: false }],
  },
  {
    name: MCP_PROMPT_SESSION_REUSE_NAME,
    title: 'Airpa Session Reuse',
    description: 'Prompt template for binding the current session to a reusable profile.',
    arguments: [
      { name: 'profile', description: 'Optional profile id or exact name', required: false },
      { name: 'task', description: 'Optional task goal after profile reuse', required: false },
    ],
  },
  {
    name: MCP_PROMPT_PAGE_DEBUG_NAME,
    title: 'Airpa Page Debug',
    description: 'Prompt template for debugging broken page state, selectors, console, or network behavior.',
    arguments: [{ name: 'issue', description: 'Optional description of the issue being debugged', required: false }],
  },
];

export const MCP_PROMPT_NAMES = MCP_PROMPT_DEFINITIONS.map((prompt) => prompt.name);

const CANONICAL_MCP_PUBLIC_CAPABILITIES = listCanonicalPublicCapabilities(listOrchestrationCapabilities());

export const MCP_PUBLIC_TOOL_NAMES = listCanonicalPublicCapabilityNames(
  CANONICAL_MCP_PUBLIC_CAPABILITIES
);

export const MCP_FLOW_TOOL_NAMES = {
  getting_started: listCanonicalAssistantFlowCapabilityNames(
    'getting_started',
    CANONICAL_MCP_PUBLIC_CAPABILITIES
  ),
  session_reuse: listCanonicalAssistantFlowCapabilityNames(
    'session_reuse',
    CANONICAL_MCP_PUBLIC_CAPABILITIES
  ),
  page_debug: listCanonicalAssistantFlowCapabilityNames('page_debug', CANONICAL_MCP_PUBLIC_CAPABILITIES),
} as const;
