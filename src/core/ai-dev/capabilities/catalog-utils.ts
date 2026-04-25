import type {
  OrchestrationCapabilityDefinition,
  OrchestrationCapabilityRequirement,
  OrchestrationToolAnnotations,
} from '../orchestration/types';
import {
  BROWSER_CAPABILITY_NAMES,
  type BrowserCapabilityName,
  type BrowserCapabilityRequirement,
} from '../../../types/browser-interface';

export type CapabilityMetadata = Pick<
  OrchestrationCapabilityDefinition,
  | 'idempotent'
  | 'sideEffectLevel'
  | 'estimatedLatencyMs'
  | 'retryPolicy'
  | 'requiredScopes'
  | 'requires'
>;

const toWords = (name: string): string[] =>
  String(name || '')
    .trim()
    .split(/[_\s]+/)
    .filter(Boolean);

export const toCapabilityTitle = (name: string): string =>
  toWords(name)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const buildCapabilityAnnotations = (
  metadata: CapabilityMetadata,
  options: {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  } = {}
): OrchestrationToolAnnotations => ({
  readOnlyHint: metadata.sideEffectLevel === 'none',
  destructiveHint: options.destructiveHint === true,
  idempotentHint: metadata.idempotent === true,
  ...(typeof options.openWorldHint === 'boolean'
    ? { openWorldHint: options.openWorldHint }
    : {}),
});

const structuredErrorProperties = {
  code: { type: 'string' },
  message: { type: 'string' },
  details: { type: 'string' },
  suggestion: { type: 'string' },
  reasonCode: { type: 'string' },
  retryable: { type: 'boolean' },
  recommendedNextTools: {
    type: 'array',
    items: { type: 'string' },
  },
  authoritativeFields: {
    type: 'array',
    items: { type: 'string' },
  },
  candidates: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: true,
    },
  },
  nextActionHints: {
    type: 'array',
    items: { type: 'string' },
  },
  context: {
    type: 'object',
    additionalProperties: true,
  },
};

export const createStructuredErrorSchema = () => ({
  type: 'object',
  additionalProperties: false,
  properties: structuredErrorProperties,
  required: ['code', 'message'],
});

export const createStructuredSuccessSchema = (dataSchema: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    data: dataSchema,
    truncated: { type: 'boolean' },
    error: createStructuredErrorSchema(),
    nextActionHints: {
      type: 'array',
      items: { type: 'string' },
    },
    recommendedNextTools: {
      type: 'array',
      items: { type: 'string' },
    },
    authoritativeFields: {
      type: 'array',
      items: { type: 'string' },
    },
    reasonCode: {
      type: ['string', 'null'],
    },
    retryable: { type: 'boolean' },
  },
  required: ['ok', 'summary', 'nextActionHints', 'recommendedNextTools', 'authoritativeFields', 'retryable'],
  oneOf: [
    {
      required: [
        'ok',
        'summary',
        'data',
        'truncated',
        'nextActionHints',
        'recommendedNextTools',
        'authoritativeFields',
        'reasonCode',
        'retryable',
      ],
      properties: {
        ok: { type: 'boolean', enum: [true] },
      },
    },
    {
      required: [
        'ok',
        'summary',
        'error',
        'nextActionHints',
        'recommendedNextTools',
        'authoritativeFields',
        'retryable',
      ],
      properties: {
        ok: { type: 'boolean', enum: [false] },
      },
    },
  ],
});

export const createStructuredEnvelopeSchema = (dataSchema: Record<string, unknown>) =>
  createStructuredSuccessSchema(dataSchema);

export const createOpaqueOutputSchema = (description?: string) => ({
  type: 'object',
  additionalProperties: true,
  ...(description ? { description } : {}),
});

export const createArrayItemsSchema = (itemSchema?: Record<string, unknown>) => ({
  type: 'array',
  items: itemSchema || {
    type: 'object',
    additionalProperties: true,
  },
});

export const createBrowserCapabilityDescriptorSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['supported', 'stability', 'source'],
  properties: {
    supported: { type: 'boolean' },
    stability: { type: 'string', enum: ['stable', 'experimental', 'planned'] },
    source: { type: 'string', enum: ['static-engine', 'runtime'] },
    notes: { type: 'string' },
  },
});

export const createBrowserRuntimeDescriptorSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['engine', 'profileMode', 'visibilityMode', 'capabilities'],
  properties: {
    engine: { type: 'string', enum: ['electron', 'extension', 'ruyi'] },
    profileMode: { type: 'string', enum: ['ephemeral', 'persistent'] },
    visibilityMode: {
      type: 'string',
      enum: ['embedded-view', 'external-window', 'direct-window'],
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: [...BROWSER_CAPABILITY_NAMES],
      properties: Object.fromEntries(
        BROWSER_CAPABILITY_NAMES.map((capabilityName) => [
          capabilityName,
          createBrowserCapabilityDescriptorSchema(),
        ])
      ),
    },
  },
});

export const createBrowserToolResourceLinks = (toolName: string) => [
  {
    uri: `airpa://mcp/tools/${encodeURIComponent(toolName)}`,
    name: `airpa.tool.${toolName}`,
    title: toCapabilityTitle(toolName),
    description: `Tool detail and usage guidance for ${toolName}.`,
    mimeType: 'application/json',
  },
  {
    uri: 'airpa://mcp/guides/getting-started',
    name: 'airpa.guide.getting-started',
    title: 'Airpa MCP Getting Started',
    description: 'Recommended browser automation flow for MCP clients.',
    mimeType: 'text/markdown',
  },
];

export const createBrowserCapabilityRequires = (
  extras: Array<
    OrchestrationCapabilityRequirement | BrowserCapabilityName | BrowserCapabilityRequirement
  > = []
): OrchestrationCapabilityRequirement[] => {
  const browserCapabilitySet = new Set<string>(BROWSER_CAPABILITY_NAMES);
  const normalizedExtras = extras.map((item) => {
    if (typeof item === 'string' && browserCapabilitySet.has(item)) {
      return `browserCapability:${item}` as BrowserCapabilityRequirement;
    }
    return item as OrchestrationCapabilityRequirement;
  });
  const merged = ['browser', 'sessionBrowser', ...normalizedExtras] as OrchestrationCapabilityRequirement[];
  return Array.from(new Set(merged));
};
